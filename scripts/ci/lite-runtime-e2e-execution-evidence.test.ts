import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  createLiteExecutionTreeStore,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-runtime-e2e-execution-evidence-"));
  return path.join(dir, `${name}.sqlite`);
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
    AUTO_TOPIC_CLUSTER_ON_WRITE: false,
    TOPIC_CLUSTER_ASYNC_ON_WRITE: true,
    MEMORY_WRITE_REQUIRE_NODES: false,
    EXECUTION_TREE_DEFAULT_ENABLED: true,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    LEARNING_CONTROL_MODEL_CLIENT_BASE_URL: "",
    LEARNING_CONTROL_MODEL_CLIENT_API_KEY: "",
    LEARNING_CONTROL_MODEL_CLIENT_MODEL: "",
    LEARNING_CONTROL_MODEL_CLIENT_TRANSPORT: "auto",
    LEARNING_CONTROL_MODEL_CLIENT_OPENAI_EXTRA_BODY_JSON: "",
    REPLAY_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    REPLAY_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    TOOLS_LEARNING_CONTROL_HTTP_MODEL_FORM_PATTERN_PROVIDER_ENABLED: false,
    TOOLS_LEARNING_CONTROL_EVIDENCE_FORM_PATTERN_PROVIDER_ENABLED: false,
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

function registerRuntimeE2EApp(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
  executionTreeStore: ReturnType<typeof createLiteExecutionTreeStore>;
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
    executionTreeStore: args.executionTreeStore,
  });

  registerHandoffRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    executionStateStore: null,
    executionTreeStore: args.executionTreeStore,
  });

  registerMemoryAccessRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    executionStateStore: null,
    executionTreeStore: args.executionTreeStore,
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

  registerProductFacadeRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

function setupRuntimeE2EApp(name: string) {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  const dbPath = tmpDbPath(name);
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  registerRuntimeE2EApp({ app, env, guards, liteWriteStore, liteRecallStore, executionTreeStore });
  return { app, liteWriteStore, liteRecallStore, executionTreeStore };
}

function runtimeTreeOperation(
  tree: ExecutionTreeV1,
  operation: Omit<ExecutionTreeOperationV1, "tree_id" | "scope">,
): ExecutionTreeOperationV1 {
  return {
    tree_id: tree.tree_id,
    scope: tree.scope,
    ...operation,
  } as ExecutionTreeOperationV1;
}

function buildRuntimeTreeFixture(): {
  baseTree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
  expectedTree: ExecutionTreeV1;
} {
  const baseTree = createExecutionTreeV1({
    tree_id: "tree-runtime-e2e-execution-evidence",
    scope: "aionis://execution-tree/runtime-e2e-execution-evidence",
    task_brief: "Runtime e2e should recover passed branch while isolating failed branch.",
    at: "2026-06-09T00:00:00.000Z",
  });
  const operations: ExecutionTreeOperationV1[] = [];
  let expectedTree = baseTree;
  const add = (operation: Omit<ExecutionTreeOperationV1, "tree_id" | "scope">) => {
    const fullOperation = runtimeTreeOperation(baseTree, operation);
    operations.push(fullOperation);
    expectedTree = applyExecutionTreeOperationV1(expectedTree, fullOperation);
  };

  add({
    type: "grow",
    operation_id: "runtime-e2e-grow-failed",
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: "Try RUNTIME_E2E_FAILED formula A with duplicated tax.",
    observation: "RUNTIME_E2E_FAILED formula A fails validation because tax is double-counted.",
    title: "Runtime e2e failed branch",
    refs: ["trace://runtime-e2e/formula-a/raw"],
  });
  add({
    type: "compress",
    operation_id: "runtime-e2e-compress-failed",
    actor_role: "worker",
    at: "2026-06-09T00:02:00.000Z",
    title: "RUNTIME_E2E_FAILED formula A rejected",
    summary: "RUNTIME_E2E_FAILED formula A double-counted tax and must not be reused.",
  });
  const failedSummaryNodeId = expectedTree.current_summary_node_id;
  assert.ok(failedSummaryNodeId);
  add({
    type: "maintain",
    operation_id: "runtime-e2e-maintain-failed",
    actor_role: "verifier",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "RUNTIME_E2E_FAILED validation rejected formula A.",
  });
  add({
    type: "revise",
    operation_id: "runtime-e2e-revise-failed",
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "RUNTIME_E2E_FAILED abandon formula A and resume from a clean branch.",
  });
  add({
    type: "grow",
    operation_id: "runtime-e2e-grow-passed",
    actor_role: "worker",
    at: "2026-06-09T00:05:00.000Z",
    action: "Use RUNTIME_E2E_PASSED formula B after removing duplicated tax.",
    observation: "RUNTIME_E2E_PASSED formula B matches all validation rows.",
    title: "Runtime e2e passed branch",
    refs: ["trace://runtime-e2e/formula-b/raw"],
  });
  add({
    type: "compress",
    operation_id: "runtime-e2e-compress-passed",
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    title: "RUNTIME_E2E_PASSED formula B accepted",
    summary: "RUNTIME_E2E_PASSED formula B computes subtotal + single tax + shipping.",
  });
  const passedSummaryNodeId = expectedTree.current_summary_node_id;
  assert.ok(passedSummaryNodeId);
  add({
    type: "maintain",
    operation_id: "runtime-e2e-maintain-passed",
    actor_role: "verifier",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });

  return { baseTree, operations, expectedTree };
}

async function post(app: ReturnType<typeof Fastify>, url: string, payload: unknown) {
  const response = await app.inject({
    method: "POST",
    url,
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as any;
}

test("runtime e2e observes handoff tree operations, recovers latest tree, and guides with evidence-first context", async () => {
  const { app, liteWriteStore, liteRecallStore, executionTreeStore } = setupRuntimeE2EApp("observe-recover-guide");
  try {
    const { baseTree, operations, expectedTree } = buildRuntimeTreeFixture();
    const handoffPayload = {
      memory_lane: "private",
      anchor: "runtime-e2e:execution-evidence",
      file_path: "src/runtime-e2e-execution-evidence.ts",
      repo_root: "/Volumes/ziel/AionisRuntime-focused",
      handoff_kind: "patch_handoff",
      task_signature: "runtime-e2e-execution-evidence",
      title: "Runtime e2e execution evidence handoff",
      summary: "Continue the verified formula B branch and avoid formula A.",
      handoff_text: "Recover the latest branch-aware execution tree before continuing.",
      target_files: ["src/runtime-e2e-execution-evidence.ts"],
      next_action: "Continue from RUNTIME_E2E_PASSED formula B.",
      execution_tree_disabled: true,
      execution_tree_v1: baseTree,
      execution_tree_operations_v1: operations,
    };

    const observed = await post(app, "/v1/observe", {
      tenant_id: "default",
      scope: "default",
      handoff: handoffPayload,
    });

    assert.equal(observed.observed.handoff_stored, true);
    assert.deepEqual(observed.source_map.routes_used, ["/v1/handoff/store"]);
    const observedTree = observed.handoff.execution_tree_v1;
    assert.equal(observedTree.tree_id, expectedTree.tree_id);
    assert.equal(observedTree.current_summary_node_id, expectedTree.current_summary_node_id);
    assert.match(JSON.stringify(observedTree), /RUNTIME_E2E_PASSED formula B computes subtotal/);
    assert.match(JSON.stringify(observedTree), /RUNTIME_E2E_FAILED formula A double-counted tax/);

    const recovered = await post(app, "/v1/handoff/recover", {
      tenant_id: "default",
      scope: "default",
      consumer_agent_id: "local-user",
      handoff_kind: "patch_handoff",
      anchor: handoffPayload.anchor,
      repo_root: handoffPayload.repo_root,
      file_path: handoffPayload.file_path,
    });

    assert.equal(recovered.execution_tree_v1.tree_id, expectedTree.tree_id);
    assert.equal(recovered.execution_tree_v1.current_summary_node_id, expectedTree.current_summary_node_id);
    assert.equal(
      recovered.execution_tree_v1.nodes[expectedTree.current_summary_node_id].content.summary,
      "RUNTIME_E2E_PASSED formula B computes subtotal + single tax + shipping.",
    );
    assert.match(JSON.stringify(recovered.execution_tree_v1), /RUNTIME_E2E_FAILED validation rejected formula A/);

    const guide = await post(app, "/v1/guide", {
      tenant_id: "default",
      scope: "default",
      query_text: "continue the runtime e2e task from the verified formula branch",
      context: {
        goal: "continue the verified formula branch without repeating rejected branches",
      },
      consumer_agent_id: "local-user",
      execution_tree_v1: recovered.execution_tree_v1,
      include_packets: true,
      limit: 8,
    });

    assert.equal(guide.agent_context.history_used, true);
    assert.ok(["advisory", "candidate"].includes(guide.agent_context.authority));
    assert.ok(guide.agent_context.use_now.some((entry: string) =>
      entry.includes("Passed solution") && entry.includes("RUNTIME_E2E_PASSED formula B computes subtotal")
    ));
    assert.ok(guide.agent_context.do_not_use.some((entry: string) =>
      entry.includes("Failed branch to avoid") && entry.includes("RUNTIME_E2E_FAILED formula A double-counted tax")
    ));
    assert.match(guide.agent_context.prompt_text, /Passed solution/);
    assert.match(guide.agent_context.prompt_text, /RUNTIME_E2E_PASSED formula B computes subtotal/);
    assert.match(guide.agent_context.prompt_text, /do_not_use/);
    assert.match(guide.agent_context.prompt_text, /RUNTIME_E2E_FAILED formula A double-counted tax/);
    assert.ok(guide.guide_packet.source_map.internal_surfaces_used.includes("execution_evidence_context"));
    assert.ok(["advisory", "candidate"].includes(guide.guide_packet.guide_brief.authority));

    await post(app, "/v1/memory/write", {
      tenant_id: "default",
      scope: "default",
      input_text: "Runtime e2e writes summary-only execution memories without raw backing.",
      auto_embed: false,
      memory_lane: "private",
      nodes: [
        {
          client_id: "runtime-e2e-summary-only-passed",
          type: "event",
          title: "Runtime e2e summary-only passed memory",
          text_summary: "RUNTIME_E2E_SUMMARY_ONLY_PASSED claims formula C passed without raw backing.",
          slots: {
            task_signature: "runtime-e2e-summary-only-guard",
            execution_result_summary: {
              status: "passed",
              summary: "RUNTIME_E2E_SUMMARY_ONLY_PASSED formula C allegedly passed.",
            },
          },
        },
        {
          client_id: "runtime-e2e-summary-only-failed",
          type: "event",
          title: "Runtime e2e summary-only failed memory",
          text_summary: "RUNTIME_E2E_SUMMARY_ONLY_FAILED claims formula D failed without raw backing.",
          slots: {
            task_signature: "runtime-e2e-summary-only-guard",
            execution_result_summary: {
              status: "failed",
              summary: "RUNTIME_E2E_SUMMARY_ONLY_FAILED formula D allegedly failed.",
              diagnostic_note: "RUNTIME_E2E_SUMMARY_ONLY_FAILED no raw verifier trace attached.",
            },
          },
        },
      ],
      edges: [],
    });

    const guardedContext = await post(app, "/v1/execution/context/assemble", {
      tenant_id: "default",
      scope: "default",
      memory_filters: [
        {
          slots_contains: { task_signature: "runtime-e2e-summary-only-guard" },
          limit: 20,
        },
      ],
    });

    assert.deepEqual(guardedContext.passed_solutions, []);
    assert.deepEqual(guardedContext.failed_branches, []);
    assert.equal(guardedContext.supporting_evidence.length, 2);
    assert.match(JSON.stringify(guardedContext.supporting_evidence), /RUNTIME_E2E_SUMMARY_ONLY_PASSED/);
    assert.match(JSON.stringify(guardedContext.supporting_evidence), /RUNTIME_E2E_SUMMARY_ONLY_FAILED/);
    assert.ok(guardedContext.supporting_evidence.every((entry: any) => entry.promotion_blocked === true));
    assert.ok(guardedContext.supporting_evidence.every((entry: any) =>
      entry.promotion_blocked_reason === "memory_execution_summary_without_raw_or_evidence_refs"
    ));
    assert.equal(guardedContext.selection_trace.memory_consolidation_guard_blocked_count, 2);
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});
