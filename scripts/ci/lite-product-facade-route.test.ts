import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { buildAionisUri } from "../../src/memory/uri.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryFeedbackToolRoutes } from "../../src/routes/memory-feedback-tools.ts";
import { registerLiteMemoryLifecycleRoutes } from "../../src/routes/memory-lifecycle-lite.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-product-facade-"));
  return path.join(dir, `${name}.sqlite`);
}

function sortedKeys(value: unknown): string[] {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.keys(value as Record<string, unknown>).sort();
}

function assertExactKeys(value: unknown, expected: string[]) {
  assert.deepEqual(sortedKeys(value), [...expected].sort());
}

function assertNoForbiddenProductFields(value: unknown) {
  const forbidden = new Set([
    ["first", "action"].join("_"),
    ["first", "step"].join("_"),
    ["kick", "off"].join(""),
    ["runtime", "context", "packet"].join("_"),
    "learning_packet",
    "cost_signals",
    "raw_memory_rows",
    "raw_slots",
    "internal_route",
    "internal_route_schema",
  ]);
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      assert.equal(forbidden.has(key), false, `forbidden product field leaked: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function assertProductSourceMap(value: unknown, expectedKeys = ["internal_surfaces_used", "routes_used"]) {
  assertExactKeys(value, expectedKeys);
}

function objectValue(value: unknown, label: string): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, any>;
}

function arrayValue(value: unknown, label: string): Array<Record<string, any>> {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value as Array<Record<string, any>>;
}

function countTraceSurface(trace: Record<string, any>, surface: string): number {
  return arrayValue(trace.memory_decisions, "trace.memory_decisions")
    .filter((entry) => entry.agent_surface === surface).length;
}

function assertDecisionTraceMatchesGuide(traceRaw: unknown, guideRaw: unknown) {
  const trace = objectValue(traceRaw, "memory_decision_trace");
  const guide = objectValue(guideRaw, "guide");
  const memoryPacket = objectValue(guide.memory_packet, "guide.memory_packet");
  const agentContext = objectValue(guide.agent_context, "guide.agent_context");
  const memories = arrayValue(memoryPacket.relevant_memories, "memory_packet.relevant_memories");
  const evidenceTrail = arrayValue(memoryPacket.evidence_trail, "memory_packet.evidence_trail");
  const decisions = arrayValue(trace.memory_decisions, "trace.memory_decisions");
  const relationDecisions = arrayValue(trace.relation_decisions, "trace.relation_decisions");
  const summary = objectValue(trace.summary, "trace.summary");
  const contextDecision = objectValue(trace.context_decision, "trace.context_decision");

  assert.equal(trace.contract_version, "aionis_memory_decision_trace_v1");
  assert.equal(trace.agent_prompt_included, false);
  assert.equal(trace.runtime_mutation, false);
  assert.equal(summary.total_memory_count, memories.length);
  assert.equal(summary.direct_use_count, countTraceSurface(trace, "use_now"));
  assert.equal(summary.inspect_before_use_count, countTraceSurface(trace, "inspect_before_use"));
  assert.equal(summary.do_not_use_count, countTraceSurface(trace, "do_not_use"));
  assert.equal(summary.rehydrate_count, countTraceSurface(trace, "rehydrate"));
  assert.equal(summary.relation_count, relationDecisions.length);
  assert.equal(summary.prompt_char_count, String(agentContext.prompt_text ?? "").length);
  assert.equal(summary.history_used, agentContext.history_used);
  assert.equal(summary.recommended_posture, agentContext.recommended_posture);
  assert.equal(summary.authority, agentContext.authority);
  assert.equal(summary.negative_transfer_risk, objectValue(agentContext.risk, "agent_context.risk").negative_transfer_risk);

  assert.equal(contextDecision.prompt_char_count, String(agentContext.prompt_text ?? "").length);
  assert.equal(contextDecision.use_now_count, arrayValue(agentContext.use_now, "agent_context.use_now").length);
  assert.equal(contextDecision.inspect_before_use_count, arrayValue(agentContext.inspect_before_use, "agent_context.inspect_before_use").length);
  assert.equal(contextDecision.do_not_use_count, arrayValue(agentContext.do_not_use, "agent_context.do_not_use").length);
  assert.equal(contextDecision.rehydrate_hint_count, arrayValue(agentContext.rehydrate_hints, "agent_context.rehydrate_hints").length);
  assert.deepEqual(contextDecision.memory_ids, agentContext.memory_ids);

  const promptText = String(agentContext.prompt_text ?? "");
  assert.equal(promptText.includes("memory_decision_trace"), false);
  assert.equal(promptText.includes("memory_decision_audit"), false);
  assert.equal(promptText.includes("decision_reviews"), false);

  const memoriesById = new Map(memories.map((entry) => [entry.memory_id, entry]));
  const relationByTarget = new Map(relationDecisions.map((entry) => [entry.target_memory_id, entry]));
  const lifecycleHintsById = new Map(arrayValue(objectValue(memoryPacket.lifecycle, "memory_packet.lifecycle").rehydration_hints, "memory_packet.lifecycle.rehydration_hints")
    .map((entry) => [entry.memory_id, entry]));
  for (const decision of decisions) {
    const memory = memoriesById.get(decision.memory_id);
    assert.ok(memory, `trace decision points at missing memory: ${decision.memory_id}`);
    assert.equal(decision.title, memory.title);
    assert.equal(decision.lifecycle_state, memory.lifecycle_state);
    assert.equal(decision.authority, memory.authority);
    if (decision.agent_surface === "use_now") {
      const used = objectValue(decision.used_detail, `used_detail:${decision.memory_id}`);
      assert.equal(used.confidence, memory.confidence);
      assert.equal(used.salience, memory.salience);
      assert.equal(used.source_layer, memory.source_layer);
      assert.equal(used.not_superseded, !relationByTarget.has(decision.memory_id));
    }
    if (decision.agent_surface === "inspect_before_use" && relationByTarget.has(decision.memory_id)) {
      const relation = relationByTarget.get(decision.memory_id)!;
      const downgraded = objectValue(decision.downgraded_detail, `downgraded_detail:${decision.memory_id}`);
      assert.equal(downgraded.by_memory_id, relation.source_memory_id);
      assert.equal(downgraded.evidence_id, relation.evidence_id);
      assert.deepEqual(objectValue(downgraded.relation, `downgraded_relation:${decision.memory_id}`).gate, relation.gate);
    }
    if (decision.agent_surface === "do_not_use") {
      const blocked = objectValue(decision.blocked_detail, `blocked_detail:${decision.memory_id}`);
      assert.equal(blocked.lifecycle_state, memory.lifecycle_state);
      assert.equal(blocked.authority, memory.authority);
    }
    if (decision.agent_surface === "rehydrate") {
      const rehydrate = objectValue(decision.rehydrate_detail, `rehydrate_detail:${decision.memory_id}`);
      const hint = lifecycleHintsById.get(decision.memory_id);
      if (hint) {
        assert.equal(rehydrate.mode, hint.mode);
        assert.equal(rehydrate.required, hint.required);
        assert.equal(rehydrate.reason, hint.reason);
      }
    }
  }

  const lifecycleEvidence = evidenceTrail.filter((entry) => entry.source === "edge" && entry.lifecycle_relation);
  assert.equal(relationDecisions.length, lifecycleEvidence.length);
  for (const evidence of lifecycleEvidence) {
    const relation = relationDecisions.find((entry) => entry.evidence_id === evidence.evidence_id);
    assert.ok(relation, `missing relation decision for evidence ${evidence.evidence_id}`);
    const lifecycleRelation = objectValue(evidence.lifecycle_relation, `lifecycle_relation:${evidence.evidence_id}`);
    assert.equal(relation.memory_id, evidence.memory_id);
    assert.equal(relation.source_memory_id, lifecycleRelation.source_memory_id);
    assert.equal(relation.target_memory_id, lifecycleRelation.target_memory_id);
    assert.equal(relation.lifecycle_relation, lifecycleRelation.lifecycle_relation);
    assert.equal(relation.confidence, lifecycleRelation.confidence);
    assert.deepEqual(relation.gate, lifecycleRelation.gate);
    assert.deepEqual(relation.signals, lifecycleRelation.signals);
  }
}

function assertTraceCoreEqual(leftRaw: unknown, rightRaw: unknown) {
  const left = objectValue(leftRaw, "left trace");
  const right = objectValue(rightRaw, "right trace");
  for (const key of [
    "tenant_id",
    "scope",
    "input",
    "summary",
    "memory_decisions",
    "relation_decisions",
    "context_decision",
    "forget_decisions",
  ]) {
    assert.deepEqual(left[key], right[key], `trace core mismatch: ${key}`);
  }
}

function assertAuditReportMatchesTrace(auditRaw: unknown, traceRaw: unknown) {
  const audit = objectValue(auditRaw, "memory_decision_audit");
  const trace = objectValue(traceRaw, "memory_decision_trace");
  const decisions = arrayValue(trace.memory_decisions, "trace.memory_decisions");
  const reviews = objectValue(audit.decision_reviews, "audit.decision_reviews");
  const used = decisions.filter((entry) => entry.decision_kind === "used" && entry.used_detail);
  const downgraded = decisions.filter((entry) => entry.decision_kind === "downgraded" && entry.downgraded_detail);
  const blocked = decisions.filter((entry) => entry.decision_kind === "blocked" && entry.blocked_detail);
  const rehydrate = decisions.filter((entry) => entry.decision_kind === "rehydrate" && entry.rehydrate_detail);

  assert.equal(audit.contract_version, "aionis_memory_decision_audit_report_v1");
  assert.equal(audit.agent_prompt_included, false);
  assert.equal(audit.runtime_mutation, false);
  assert.equal(objectValue(audit.counters, "audit.counters").total_memory_count, objectValue(trace.summary, "trace.summary").total_memory_count);
  assert.deepEqual(arrayValue(reviews.used_memories, "reviews.used_memories").map((entry) => entry.memory_id), used.map((entry) => entry.memory_id));
  assert.deepEqual(arrayValue(reviews.downgraded_memories, "reviews.downgraded_memories").map((entry) => entry.memory_id), downgraded.map((entry) => entry.memory_id));
  assert.deepEqual(arrayValue(reviews.blocked_memories, "reviews.blocked_memories").map((entry) => entry.memory_id), blocked.map((entry) => entry.memory_id));
  assert.deepEqual(arrayValue(reviews.rehydrate_memories, "reviews.rehydrate_memories").map((entry) => entry.memory_id), rehydrate.map((entry) => entry.memory_id));
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
    AUTO_TOPIC_CLUSTER_ON_WRITE: false,
    TOPIC_CLUSTER_ASYNC_ON_WRITE: true,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
  } as any;
}

function requestGuards(env: ReturnType<typeof liteEnv>, embedder: typeof DeterministicEmbeddingProvider | null = null) {
  return createRequestGuards({
    env,
    embedder,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

function registerProductFacade(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
}) {
  registerProductFacadeRoutes({
    app: args.app,
    env: args.env,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

async function seedProductFacadeMemory(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  input_text: string;
  nodes: Record<string, unknown>[];
}) {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: args.input_text,
    nodes: args.nodes,
    edges: [],
  }, "default", "default", {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);

  await args.liteWriteStore.withTx(() => applyMemoryWrite(prepared, {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
    write_access: args.liteWriteStore,
  }));
}

async function seedProductPatternAnchor(liteWriteStore: ReturnType<typeof createLiteWriteStore>) {
  const anchorId = randomUUID();
  await seedProductFacadeMemory({
    liteWriteStore,
    input_text: "seed product facade pattern anchor",
    nodes: [{
      id: anchorId,
      type: "concept",
      tier: "hot",
      memory_lane: "private",
      owner_agent_id: "local-user",
      title: "Product facade suppression pattern",
      text_summary: "Prefer read before edit when a trusted scoped workflow exists.",
      slots: {
        anchor_v1: {
          schema_version: "anchor_v1",
          anchor_kind: "pattern",
          anchor_level: "L3",
          selected_tool: "read",
          task_signature: "product-facade-pattern-suppression",
          task_family: "product_facade",
          summary: "Prefer read before edit when a trusted scoped workflow exists.",
          tool_set: ["read", "edit", "test"],
          pattern_state: "stable",
          credibility_state: "trusted",
          promotion: {
            credibility_state: "trusted",
            distinct_run_count: 3,
            required_distinct_runs: 2,
            counter_evidence_count: 0,
          },
        },
      },
    }],
  });
  return { anchorId };
}

async function seedProductPayloadAnchor(liteWriteStore: ReturnType<typeof createLiteWriteStore>) {
  const payloadNodeId = randomUUID();
  const anchorNodeId = randomUUID();
  const decisionId = randomUUID();
  const runId = "run-product-payload-rehydrate";
  await seedProductFacadeMemory({
    liteWriteStore,
    input_text: "seed product facade payload anchor",
    nodes: [
      {
        id: payloadNodeId,
        type: "procedure",
        tier: "warm",
        memory_lane: "private",
        owner_agent_id: "local-user",
        title: "Payload workflow step",
        text_summary: "Read the prior verified state, apply the scoped edit, and verify the result.",
        slots: {
          replay_kind: "step",
          status: "succeeded",
          tool_name: "edit",
        },
      },
      {
        id: anchorNodeId,
        type: "procedure",
        tier: "warm",
        memory_lane: "private",
        owner_agent_id: "local-user",
        title: "Payload rehydration anchor",
        text_summary: "Anchor for a resumable workflow payload.",
        slots: {
          anchor_v1: {
            schema_version: "anchor_v1",
            anchor_kind: "workflow",
            anchor_level: "L2",
            task_signature: "product-payload-rehydrate",
            summary: "Read the prior verified state, apply the scoped edit, and verify the result.",
            tool_set: ["read", "edit", "test"],
            outcome: { status: "success" },
            source: {
              source_kind: "playbook",
              node_id: payloadNodeId,
              decision_id: decisionId,
              run_id: runId,
              step_id: null,
              playbook_id: "product_payload_anchor",
              commit_id: null,
            },
            payload_refs: {
              node_ids: [payloadNodeId],
              decision_ids: [decisionId],
              run_ids: [runId],
              step_ids: [],
              commit_ids: [],
            },
          },
        },
      },
    ],
  });
  await liteWriteStore.insertExecutionDecision({
    id: decisionId,
    scope: "default",
    decisionKind: "tools_select",
    runId,
    selectedTool: "edit",
    candidatesJson: ["read", "edit", "test"],
    contextSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    sourceRuleIds: [],
    metadataJson: { product_facade_fixture: true },
    commitId: null,
  });
  return { anchorNodeId, payloadNodeId, decisionId };
}

function registerFullProductMemoryApp(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
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
  });
  registerMemoryAccessRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    executionStateStore: null,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
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
  registerLiteMemoryLifecycleRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerMemoryFeedbackToolRoutes({
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
  });
  registerProductFacade(args);
}

test("product measure facade returns a product effect report without external eval runners", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacade({ app, env, guards });

    const response = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        baseline: {
          continuity: {
            repeatedDiscoverySteps: 4,
            continuityGuidanceCorrect: false,
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
            continuityGuidanceCorrect: true,
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
    assertNoForbiddenProductFields(body);
    assertExactKeys(body, [
      "contract_version",
      "tenant_id",
      "scope",
      "measurement_input",
      "effect_report",
      "kernel_report",
      "source_map",
    ]);
    assertExactKeys(body.measurement_input, ["source", "baseline", "aionis"]);
    assertProductSourceMap(body.source_map);
    assertExactKeys(body.effect_report, [
      "contract_version",
      "tenant_id",
      "scope",
      "task",
      "comparison",
      "history_impact",
      "efficiency",
      "quality",
      "history_contributions",
      "learning_effect",
      "forgetting_effect",
      "training_candidates",
      "evidence",
    ]);
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

test("product observe turns plain input_text into recallable general memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-plain-text");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const memoryText = "The workspace owner prefers concise product-facing status reports with direct next steps.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: memoryText,
        auto_embed: true,
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assertNoForbiddenProductFields(observeBody);
    assertExactKeys(observeBody, [
      "contract_version",
      "tenant_id",
      "scope",
      "observed",
      "structured_memory",
      "memory_write",
      "handoff",
      "source_map",
    ]);
    assertExactKeys(observeBody.observed, [
      "memory_written",
      "handoff_stored",
      "general_memory_count",
      "execution_memory_count",
      "auto_text_memory_count",
      "execution_observation_count",
    ]);
    assertExactKeys(observeBody.structured_memory, [
      "schema_version",
      "mode",
      "input_node_count",
      "auto_text_node_count",
      "passthrough_node_count",
      "already_structured_node_count",
      "execution_workflow_count",
      "execution_observation_count",
      "general_memory_count",
      "structured_nodes",
    ]);
    assertProductSourceMap(observeBody.source_map);
    assert.equal(observeBody.observed.memory_written, true);
    assert.equal(observeBody.observed.auto_text_memory_count, 1);
    assert.equal(observeBody.observed.general_memory_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "input_text");
    assert.equal(observeBody.structured_memory.structured_nodes[0].classification, "general_memory");
    assert.equal(observeBody.memory_write.nodes.length, 1);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "How should status reports be written?",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.memory_packet.memory_family, "general_cognitive");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "general"
        && entry.summary === memoryText,
      ),
    );
    const auditReport = await app.inject({
      method: "POST",
      url: "/v1/audit/memory-decision-report",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          after_guide: guideBody,
        },
      },
    });
    assert.equal(auditReport.statusCode, 200);
    const auditBody = auditReport.json();
    assert.equal(auditBody.memory_decision_audit.contract_version, "aionis_memory_decision_audit_report_v1");
    assert.equal(auditBody.memory_decision_audit.agent_prompt_included, false);
    assert.equal(guideBody.agent_context.prompt_text.includes("memory_decision_audit"), false);
    assert.equal(guideBody.agent_context.prompt_text.includes("decision_reviews"), false);
  } finally {
    await app.close();
  }
});

test("product observe persists lifecycle relation graph and guide suppresses superseded memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-lifecycle-relation-graph");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const oldSummary = "AIONIS_RELATION_OLD_MARKER Initial checkout validation investigation. At that time the likely change surface looked like: legacy/payments/old-checkout.ts and obsolete/tests/old-checkout.test.ts. This note was written before later repository evidence was examined.";
    const currentSummary = "AIONIS_RELATION_CURRENT_MARKER Later corrected checkout validation project memory. Subsequent evidence contradicted the earlier initial working note; the earlier change surface should be treated as an unverified prior, not direct action context. Current change surface: src/payments/checkout.ts and tests/checkout.test.ts.";

    const oldObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory: {
          client_id: "lifecycle-relation-old-checkout",
          type: "concept",
          memory_kind: "general_memory",
          title: "Initial checkout validation investigation",
          text_summary: oldSummary,
          confidence: 0.91,
        },
      },
    });
    assert.equal(oldObserve.statusCode, 200);
    const oldNodeId = oldObserve.json().memory_write.nodes[0].id;

    const currentObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory: {
          client_id: "lifecycle-relation-current-checkout",
          type: "concept",
          memory_kind: "general_memory",
          title: "Corrected checkout validation investigation",
          text_summary: currentSummary,
          confidence: 0.94,
        },
      },
    });
    assert.equal(currentObserve.statusCode, 200);
    const currentBody = currentObserve.json();
    const currentNodeId = currentBody.memory_write.nodes[0].id;
    assert.ok(currentBody.memory_write.edges.some((edge: Record<string, unknown>) =>
      edge.type === "contradicts"
      && edge.src_id === currentNodeId
      && edge.dst_id === oldNodeId,
    ));

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_RELATION_OLD_MARKER legacy/payments/old-checkout.ts checkout validation",
        consumer_agent_id: "local-user",
        limit: 1,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    const oldMemory = guideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === oldNodeId,
    );
    assert.ok(oldMemory);
    assert.equal(oldMemory.lifecycle_state, "contested");
    assert.equal(oldMemory.authority, "candidate");
    assert.ok(guideBody.memory_packet.evidence_trail.some((entry: Record<string, unknown>) =>
      entry.source === "edge"
      && entry.relation === "contradicts"
      && entry.memory_id === oldNodeId,
    ));
    assert.ok(guideBody.memory_packet.source_map.internal_surfaces_used.includes("memory_lifecycle_relation_graph"));
    assert.equal(
      guideBody.agent_context.use_now.some((entry: string) => entry.includes("AIONIS_RELATION_OLD_MARKER")),
      false,
    );
    assert.ok(
      guideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.includes(oldNodeId) || entry.includes("Initial checkout validation investigation")
      ),
    );
    assert.equal(guideBody.agent_context.prompt_text.includes("legacy/payments/old-checkout.ts"), false);
    assert.equal(guideBody.agent_context.prompt_text.includes("decision_reviews"), false);

    const debugTrace = await app.inject({
      method: "POST",
      url: "/v1/debug/memory-decision-trace",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          after_guide: guideBody,
        },
      },
    });
    assert.equal(debugTrace.statusCode, 200);
    const debugBody = debugTrace.json();
    assert.deepEqual(debugBody.source_map.routes_used, ["/v1/debug/memory-decision-trace"]);
    assertDecisionTraceMatchesGuide(debugBody.memory_decision_trace, guideBody);
    const oldDecision = debugBody.memory_decision_trace.memory_decisions.find((entry: Record<string, unknown>) =>
      entry.memory_id === oldNodeId,
    );
    assert.equal(oldDecision?.decision_kind, "downgraded");
    assert.equal(objectValue(oldDecision?.downgraded_detail, "old decision downgraded detail").by_memory_id, currentNodeId);

    const auditReport = await app.inject({
      method: "POST",
      url: "/v1/audit/memory-decision-report",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          after_guide: guideBody,
        },
      },
    });
    assert.equal(auditReport.statusCode, 200);
    const auditBody = auditReport.json();
    const downgraded = auditBody.memory_decision_audit.decision_reviews.downgraded_memories[0];
    assert.equal(downgraded.memory_id, oldNodeId);
    assert.equal(downgraded.by_memory_id, currentNodeId);
    assert.equal(downgraded.lifecycle_relation, "contradicts");
    assert.equal(downgraded.producer, "rule_cue");
    assert.equal(downgraded.gate.accepted, true);
    assert.ok(downgraded.signals.source_newer);
    assert.deepEqual(auditBody.source_map.routes_used, ["/v1/audit/memory-decision-report"]);
    assertAuditReportMatchesTrace(auditBody.memory_decision_audit, debugBody.memory_decision_trace);
  } finally {
    await app.close();
  }
});

test("product observe keeps active preference rules recallable in agent context", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-active-preference-rule");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const preferenceText = "ACTIVE_PREF_MARKER: The user prefers concise memory guidance with concrete evidence references.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        nodes: [{
          client_id: "active-preference-rule",
          type: "rule",
          title: "Active response preference",
          text_summary: preferenceText,
          confidence: 0.86,
          slots: {
            memory_kind: "general_memory",
            lifecycle_state: "active",
            state: "active",
            compression_layer: "L2",
          },
        }],
      },
    });

    assert.equal(observe.statusCode, 200);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "What response preference should I follow for memory guidance?",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.agent_context.history_used, true);
    assert.equal(guideBody.agent_context.authority, "advisory");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.memory_type === "preference"
        && entry.summary === preferenceText,
      ),
    );
    assert.ok(
      guideBody.agent_context.use_now.some((entry: string) => entry.includes("ACTIVE_PREF_MARKER")),
    );
  } finally {
    await app.close();
  }
});

test("product observe turns execution input into recallable execution memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-execution-input");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const executionSummary = "Recovered the known target file, applied the scoped change, and verified the focused test before broad search.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        execution: {
          run_id: "run:product-observe-execution",
          task_id: "task:continuity-product-loop",
          task_family: "continuity_recovery",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-before-broad-search",
          title: "Recover target file before broad discovery",
          summary: executionSummary,
          outcome: "succeeded",
          target_files: ["src/current-target.ts"],
          workflow_steps: [
            "Read the known target file",
            "Apply the scoped change",
            "Run the focused verifier",
          ],
          tool_set: ["read", "edit", "test"],
          acceptance_checks: ["focused verifier passed"],
          continuation_hint: "Recover and verify the known target before broad discovery.",
          confidence: 0.88,
          evidence: [{
            ref: "run:product-observe-execution#verifier",
            summary: "Focused verifier passed after the scoped edit.",
          }],
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assert.equal(observeBody.observed.execution_observation_count, 1);
    assert.equal(observeBody.observed.execution_memory_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "execution");
    assert.equal(observeBody.structured_memory.structured_nodes[0].execution_kind, "workflow_anchor");

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assertNoForbiddenProductFields(guideBody);
    assertExactKeys(guideBody, [
      "contract_version",
      "tenant_id",
      "scope",
      "agent_context",
      "memory_packet",
      "guide_packet",
      "source_map",
    ]);
    assertProductSourceMap(guideBody.source_map, [
      "internal_surfaces_used",
      "omitted_internal_surfaces",
      "routes_used",
    ]);
    assertExactKeys(guideBody.guide_packet.guide_brief, [
      "summary",
      "history_used",
      "recommended_posture",
      "authority",
      "use_now",
      "inspect_before_use",
      "do_not_use",
      "rehydrate",
      "expected_product_effects",
    ]);
    assertExactKeys(guideBody.guide_packet.guide_brief.expected_product_effects, [
      "reduces_repeated_discovery",
      "reduces_context_replay",
      "controls_negative_transfer",
      "reason",
    ]);
    assertExactKeys(guideBody.agent_context, [
      "contract_version",
      "tenant_id",
      "scope",
      "prompt_text",
      "summary",
      "history_used",
      "recommended_posture",
      "authority",
      "target_files",
      "use_now",
      "inspect_before_use",
      "do_not_use",
      "memory_ids",
      "rehydrate_hints",
      "risk",
      "evidence_refs",
    ]);
    assert.equal(guideBody.agent_context.contract_version, "aionis_agent_context_v1");
    assert.equal(guideBody.agent_context.history_used, true);
    assert.ok(guideBody.agent_context.prompt_text.includes("AIONIS_AGENT_CONTEXT v1"));
    assert.ok(guideBody.agent_context.prompt_text.length < JSON.stringify({
      memory_packet: guideBody.memory_packet,
      guide_packet: guideBody.guide_packet,
    }).length);
    assert.equal(guideBody.memory_packet.memory_family, "execution");
    assert.equal(guideBody.guide_packet.guide_brief.history_used, true);
    assert.ok(
      ["reuse_supported_history", "use_as_context", "inspect_before_use", "rehydrate_before_use"].includes(
        guideBody.guide_packet.guide_brief.recommended_posture,
      ),
    );
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "execution"
        && entry.memory_type === "execution_memory"
        && entry.summary === executionSummary,
      ),
    );

    const compactGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
      },
    });
    assert.equal(compactGuide.statusCode, 200);
    const compactBody = compactGuide.json();
    assertNoForbiddenProductFields(compactBody);
    assertExactKeys(compactBody, [
      "contract_version",
      "tenant_id",
      "scope",
      "agent_context",
      "source_map",
    ]);
    assert.equal("memory_packet" in compactBody, false);
    assert.equal("guide_packet" in compactBody, false);
    assert.equal(compactBody.agent_context.contract_version, "aionis_agent_context_v1");
    assert.equal(compactBody.agent_context.history_used, true);
    assert.deepEqual(compactBody.agent_context.target_files, ["src/current-target.ts"]);
    assert.ok(compactBody.source_map.omitted_internal_surfaces.includes("memory_packet"));
    assert.ok(compactBody.source_map.omitted_internal_surfaces.includes("guide_packet"));
  } finally {
    await app.close();
  }
});

test("product measure derives closed-loop effect from guide packets", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("measure-product-trace");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const query = "Recover target file before broad discovery";
    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200);

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        execution: {
          run_id: "run:product-measure-trace",
          task_id: "task:product-measure-trace",
          task_family: "continuity_recovery",
          task_signature: "measure-product-trace",
          workflow_signature: "recover-target-file-before-broad-search",
          title: "Recover target file before broad discovery",
          summary: "Recovered the known target file, applied the scoped change, and verified before broad search.",
          outcome: "succeeded",
          target_files: ["src/current-target.ts"],
          workflow_steps: [
            "Read the known target file",
            "Apply the scoped change",
            "Run the focused verifier",
          ],
          tool_set: ["read", "edit", "test"],
          acceptance_checks: ["focused verifier passed"],
          continuation_hint: "Reuse the known target-file recovery workflow before broad discovery.",
          confidence: 0.9,
          evidence: [{
            ref: "run:product-measure-trace#verifier",
            summary: "Focused verifier passed after the scoped edit.",
          }],
        },
      },
    });
    assert.equal(observe.statusCode, 200);

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200);
    const afterGuideBody = afterGuide.json();
    assert.equal(afterGuideBody.guide_packet.guide_brief.history_used, true);

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        task: {
          task_id: "task:product-measure-trace",
          run_id: "run:product-measure-trace",
          task_signature: "measure-product-trace",
          task_family: "continuity_recovery",
        },
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:observe-guide-measure"],
        },
      },
    });

    assert.equal(measure.statusCode, 200);
    const body = measure.json();
    assert.equal(body.contract_version, "aionis_measure_result_v1");
    assert.equal(body.measurement_input.source, "product_trace");
    assert.equal(body.measurement_input.baseline.continuity.continuityGuidanceCorrect, false);
    assert.equal(body.measurement_input.aionis.continuity.continuityGuidanceCorrect, true);
    assert.ok(
      body.measurement_input.baseline.continuity.repeatedDiscoverySteps
      > body.measurement_input.aionis.continuity.repeatedDiscoverySteps,
    );
    assert.ok(body.kernel_report.proof_summary.repeated_discovery_delta > 0);
    assert.equal(body.effect_report.history_impact.impact_direction, "positive");
    assert.equal(body.effect_report.history_impact.changed_future_behavior, true);
    assert.ok(body.source_map.internal_surfaces_used.includes("product_trace_projection"));
    assert.ok(body.source_map.internal_surfaces_used.includes("memory_decision_trace"));
    assert.ok(body.source_map.internal_surfaces_used.includes("memory_decision_audit_report"));
    assert.equal(body.memory_decision_trace.contract_version, "aionis_memory_decision_trace_v1");
    assert.equal(body.memory_decision_trace.agent_prompt_included, false);
    assert.equal(body.memory_decision_trace.runtime_mutation, false);
    assert.equal(body.memory_decision_trace.input.agent_context_present, true);
    assert.equal(body.memory_decision_audit.contract_version, "aionis_memory_decision_audit_report_v1");
    assert.equal(body.memory_decision_audit.agent_prompt_included, false);
    assert.equal(body.memory_decision_audit.runtime_mutation, false);
    assertDecisionTraceMatchesGuide(body.memory_decision_trace, afterGuideBody);
    assertAuditReportMatchesTrace(body.memory_decision_audit, body.memory_decision_trace);

    const debugTrace = await app.inject({
      method: "POST",
      url: "/v1/debug/memory-decision-trace",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
        },
      },
    });
    assert.equal(debugTrace.statusCode, 200);
    const debugBody = debugTrace.json();
    assert.equal(debugBody.contract_version, "aionis_memory_decision_trace_result_v1");
    assert.equal(debugBody.memory_decision_trace.contract_version, "aionis_memory_decision_trace_v1");
    assert.equal(debugBody.memory_decision_trace.agent_prompt_included, false);
    assert.deepEqual(debugBody.source_map.routes_used, ["/v1/debug/memory-decision-trace"]);
    assertDecisionTraceMatchesGuide(debugBody.memory_decision_trace, afterGuideBody);
    assertTraceCoreEqual(debugBody.memory_decision_trace, body.memory_decision_trace);

    const auditReport = await app.inject({
      method: "POST",
      url: "/v1/audit/memory-decision-report",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
        },
      },
    });
    assert.equal(auditReport.statusCode, 200);
    const auditBody = auditReport.json();
    assert.equal(auditBody.contract_version, "aionis_memory_decision_audit_result_v1");
    assert.equal(auditBody.memory_decision_audit.contract_version, "aionis_memory_decision_audit_report_v1");
    assert.equal(auditBody.memory_decision_audit.agent_prompt_included, false);
    assert.equal(afterGuideBody.agent_context.prompt_text.includes("memory_decision_audit"), false);
    assert.equal(afterGuideBody.agent_context.prompt_text.includes("decision_reviews"), false);
    assert.deepEqual(auditBody.source_map.routes_used, ["/v1/audit/memory-decision-report"]);
    assertAuditReportMatchesTrace(auditBody.memory_decision_audit, debugBody.memory_decision_trace);
    assert.deepEqual(
      auditBody.memory_decision_audit.decision_reviews,
      body.memory_decision_audit.decision_reviews,
    );
  } finally {
    await app.close();
  }
});

test("product observe stores explicit handoff through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-handoff");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        handoff: {
          handoff_kind: "task_handoff",
          anchor: "product-observe-handoff",
          title: "Resume focused product check",
          summary: "Resume the focused product check without replaying the full prior conversation.",
          handoff_text: "Continue from the product observe facade validation point.",
          target_files: ["src/routes/product-facade.ts"],
          next_action: "Inspect product observe facade behavior and run the product facade test.",
          acceptance_checks: ["product facade test passes"],
          tags: ["product", "continuity"],
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const body = observe.json();
    assert.equal(body.observed.memory_written, false);
    assert.equal(body.observed.handoff_stored, true);
    assert.deepEqual(body.source_map.routes_used, ["/v1/handoff/store"]);
    assert.deepEqual(body.source_map.internal_surfaces_used, ["handoff_store"]);
    assert.equal(body.handoff.handoff.anchor, "product-observe-handoff");
    assert.equal(body.handoff.handoff.handoff_kind, "task_handoff");
  } finally {
    await app.close();
  }
});

test("product observe auto-structures user-level workflow input into execution memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-workflow");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        memory: {
          client_id: "workflow:continuity",
          type: "procedure",
          memory_kind: "execution_workflow",
          title: "Recover target file before broad discovery",
          text_summary: "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-first",
          target_files: ["src/current-target.ts"],
          next_action: "Read src/current-target.ts before broad discovery.",
          tool_set: ["read", "edit", "test"],
          confidence: 0.9,
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assert.equal(observeBody.structured_memory.execution_workflow_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "memory");
    assert.equal(observeBody.structured_memory.structured_nodes[0].execution_kind, "workflow_anchor");
    assert.ok(observeBody.memory_write.nodes[0].id);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.memory_packet.memory_family, "execution");
    assert.equal(guideBody.guide_packet.guide_brief.history_used, true);
    assert.equal(["first", "action"].join("_") in guideBody.guide_packet.guide_brief, false);
    assert.equal("learning_packet" in guideBody, false);
    assert.equal(["runtime", "context", "packet"].join("_") in guideBody, false);
    assert.equal(["continuity guidance", "recommendation"].join("_") in guideBody, false);
    assert.equal("cost_signals" in guideBody, false);
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "execution"
        && entry.memory_type === "execution_memory"
        && entry.summary === "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
      ),
    );
    assert.ok(Array.isArray(guideBody.guide_packet.guidance.workflow_candidates));
  } finally {
    await app.close();
  }
});

test("product observe does not auto-promote general memory into execution workflow", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-general");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "The workspace owner prefers short product-facing reports.",
        auto_embed: true,
        nodes: [{
          client_id: "general:report-style",
          type: "concept",
          memory_kind: "general_memory",
          title: "Report style preference",
          text_summary: "The workspace owner prefers short product-facing reports.",
          confidence: 0.9,
        }],
      },
    });

    assert.equal(observe.statusCode, 200);
    const body = observe.json();
    assert.equal(body.structured_memory.execution_workflow_count, 0);
    assert.equal(body.structured_memory.general_memory_count, 1);
    assert.equal(body.structured_memory.structured_nodes[0].execution_kind, null);
  } finally {
    await app.close();
  }
});

test("product forget rehydrates archived memory through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-rehydrate-archive");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "Archive this proven workflow until a related task needs it again.",
        memory: {
          client_id: "archive:product-forget-rehydrate",
          type: "procedure",
          tier: "archive",
          memory_kind: "execution_workflow",
          title: "Archived workflow for product forget",
          text_summary: "Rehydrate this archived workflow only when the same continuation need returns.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const nodeId = observe.json().memory_write.nodes[0].id;
    const query = "Rehydrate this archived workflow only when the same continuation need returns.";
    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200);

    const forget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "rehydrate",
        target: "archive",
        memory_ids: [nodeId],
        target_tier: "hot",
        reason: "The related task returned and needs this archived workflow.",
      },
    });

    assert.equal(forget.statusCode, 200);
    const body = forget.json();
    assertNoForbiddenProductFields(body);
    assertExactKeys(body, [
      "contract_version",
      "tenant_id",
      "scope",
      "operation",
      "target",
      "forget_effect",
      "result",
      "source_map",
    ]);
    assertExactKeys(body.forget_effect, [
      "action",
      "target",
      "reason",
      "changed_count",
      "reversible",
      "affected_memory_ids",
      "affected_client_ids",
      "anchor_id",
      "anchor_uri",
    ]);
    assertProductSourceMap(body.source_map, [
      "internal_surfaces_used",
      "omitted_internal_surfaces",
      "routes_used",
    ]);
    assert.equal(body.contract_version, "aionis_forget_result_v1");
    assert.equal(body.operation, "rehydrate");
    assert.equal(body.target, "archive");
    assert.equal(body.forget_effect.changed_count, 1);
    assert.equal(body.forget_effect.reversible, true);
    assert.deepEqual(body.forget_effect.affected_memory_ids, [nodeId]);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/archive/rehydrate"]);
    assert.equal(body.result.rehydrated.moved_nodes, 1);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.tier, "hot");
    assert.equal(rows[0]?.slots.last_rehydrated_job, "archive_rehydrate");

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200);

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuide.json(),
          forget_result: body,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:forget-rehydrate-guide"],
        },
      },
    });
    assert.equal(measure.statusCode, 200);
    const measureBody = measure.json();
    assert.equal(measureBody.measurement_input.source, "product_trace");
    assert.equal(measureBody.measurement_input.aionis.forgetting.archivedMemoryRehydratedOnDemand, 1);
    assert.ok(measureBody.effect_report.evidence.evidence_ids.includes(`forget:${nodeId}`));
  } finally {
    await app.close();
  }
});

test("product forget rehydrates anchor payload through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-rehydrate-payload");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const fixture = await seedProductPayloadAnchor(liteWriteStore);
    const anchorUri = buildAionisUri({
      tenant_id: "default",
      scope: "default",
      type: "procedure",
      id: fixture.anchorNodeId,
    });

    const forget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "rehydrate",
        target: "payload",
        anchor_uri: anchorUri,
        mode: "partial",
        include_linked_decisions: true,
        reason: "Need the compact payload behind this workflow anchor.",
      },
    });

    assert.equal(forget.statusCode, 200);
    const body = forget.json();
    assert.equal(body.contract_version, "aionis_forget_result_v1");
    assert.equal(body.operation, "rehydrate");
    assert.equal(body.target, "payload");
    assert.equal(body.forget_effect.anchor_uri, anchorUri);
    assert.equal(body.forget_effect.changed_count, 2);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/anchors/rehydrate_payload"]);
    assert.equal(body.result.anchor.id, fixture.anchorNodeId);
    assert.equal(body.result.rehydrated.summary.resolved_nodes, 1);
    assert.equal(body.result.rehydrated.summary.resolved_decisions, 1);
    assert.equal(body.result.rehydrated.nodes[0]?.id, fixture.payloadNodeId);
    assert.equal(body.result.rehydrated.decisions[0]?.decision_id, fixture.decisionId);
  } finally {
    await app.close();
  }
});

test("product forget suppresses and unsuppresses pattern anchors through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-pattern-suppress");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const fixture = await seedProductPatternAnchor(liteWriteStore);
    const until = new Date(Date.now() + 60_000).toISOString();

    const suppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "suppress",
        target: "pattern",
        anchor_id: fixture.anchorId,
        mode: "shadow_learn",
        until,
        reason: "The pattern should be inspected before reuse.",
      },
    });

    assert.equal(suppress.statusCode, 200, suppress.payload);
    const suppressBody = suppress.json();
    assert.equal(suppressBody.contract_version, "aionis_forget_result_v1");
    assert.equal(suppressBody.operation, "suppress");
    assert.equal(suppressBody.target, "pattern");
    assert.equal(suppressBody.forget_effect.changed_count, 1);
    assert.equal(suppressBody.forget_effect.anchor_kind, "pattern");
    assert.equal(suppressBody.forget_effect.anchor_id, fixture.anchorId);
    assert.deepEqual(suppressBody.source_map.routes_used, ["/v1/memory/anchors/suppress"]);
    assert.equal(suppressBody.result.anchor_kind, "pattern");
    assert.equal(suppressBody.result.node_type, "concept");
    assert.equal(suppressBody.result.operator_override.suppressed, true);
    assert.equal(suppressBody.result.operator_override.mode, "shadow_learn");

    const suppressedRows = await liteWriteStore.findNodes({
      scope: "default",
      id: fixture.anchorId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(suppressedRows.rows[0]?.slots.operator_override_v1.suppressed, true);

    const unsuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "unsuppress",
        target: "pattern",
        anchor_id: fixture.anchorId,
        reason: "The pattern was reviewed and can return to normal guidance.",
      },
    });

    assert.equal(unsuppress.statusCode, 200);
    const unsuppressBody = unsuppress.json();
    assert.equal(unsuppressBody.contract_version, "aionis_forget_result_v1");
    assert.equal(unsuppressBody.operation, "unsuppress");
    assert.equal(unsuppressBody.target, "pattern");
    assert.equal(unsuppressBody.forget_effect.changed_count, 1);
    assert.equal(unsuppressBody.forget_effect.anchor_kind, "pattern");
    assert.deepEqual(unsuppressBody.source_map.routes_used, ["/v1/memory/anchors/unsuppress"]);
    assert.equal(unsuppressBody.result.anchor_kind, "pattern");
    assert.equal(unsuppressBody.result.node_type, "concept");
    assert.equal(unsuppressBody.result.operator_override.suppressed, false);
    assert.equal(unsuppressBody.result.operator_override.last_action, "unsuppress");

    const unsuppressedRows = await liteWriteStore.findNodes({
      scope: "default",
      id: fixture.anchorId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(unsuppressedRows.rows[0]?.slots.operator_override_v1.suppressed, false);
  } finally {
    await app.close();
  }
});

test("product forget suppresses workflow anchors from product guidance", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-workflow-suppress");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        memory: {
          client_id: "workflow:forget-suppression",
          type: "procedure",
          memory_kind: "execution_workflow",
          title: "Recover target file before broad discovery",
          text_summary: "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-first",
          target_files: ["src/current-target.ts"],
          next_action: "Read src/current-target.ts before broad discovery.",
          tool_set: ["read", "edit", "test"],
          confidence: 0.9,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    const workflowId = observeBody.memory_write.nodes[0].id;
    assert.ok(workflowId);

    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200);
    assert.ok(
      beforeGuide.json().guide_packet.guidance.workflow_candidates.some(
        (entry: Record<string, unknown>) => entry.workflow_id === workflowId,
      ),
    );

    const suppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "suppress",
        anchor_id: workflowId,
        mode: "shadow_learn",
        reason: "This workflow is contested and must not be reused until reviewed.",
      },
    });
    assert.equal(suppress.statusCode, 200, suppress.payload);
    const suppressBody = suppress.json();
    assert.equal(suppressBody.result.anchor_kind, "workflow");
    assert.equal(suppressBody.result.node_type, "procedure");
    assert.equal(suppressBody.result.operator_override.suppressed, true);
    assert.equal(suppressBody.forget_effect.anchor_kind, "workflow");
    assert.deepEqual(suppressBody.source_map.routes_used, ["/v1/memory/anchors/suppress"]);

    const suppressedGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(suppressedGuide.statusCode, 200);
    const suppressedGuideBody = suppressedGuide.json();
    assert.equal(
      suppressedGuideBody.guide_packet.guidance.workflow_candidates.some(
        (entry: Record<string, unknown>) => entry.workflow_id === workflowId,
      ),
      false,
      JSON.stringify(suppressedGuideBody.guide_packet.guidance.workflow_candidates),
    );
    assert.equal(
      suppressedGuideBody.agent_context.evidence_refs.workflow_ids.includes(workflowId),
      false,
    );

    const unsuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "unsuppress",
        anchor_id: workflowId,
        reason: "The contested workflow was reviewed and can be considered again.",
      },
    });
    assert.equal(unsuppress.statusCode, 200);
    const unsuppressBody = unsuppress.json();
    assert.equal(unsuppressBody.result.anchor_kind, "workflow");
    assert.equal(unsuppressBody.result.operator_override.suppressed, false);
    assert.deepEqual(unsuppressBody.source_map.routes_used, ["/v1/memory/anchors/unsuppress"]);

    const restoredGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(restoredGuide.statusCode, 200);
    assert.ok(
      restoredGuide.json().guide_packet.guidance.workflow_candidates.some(
        (entry: Record<string, unknown>) => entry.workflow_id === workflowId,
      ),
    );
  } finally {
    await app.close();
  }
});

test("product forget records activation feedback through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-activate-memory");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "Use compact product status reports when the user asks for progress.",
        memory: {
          client_id: "memory:product-forget-activate",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Product status style",
          text_summary: "Use compact product status reports when the user asks for progress.",
          confidence: 0.8,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const forget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:product-forget-activate",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        activate: true,
        reason: "The recalled style memory was reused correctly in the current run.",
      },
    });

    assert.equal(forget.statusCode, 200);
    const body = forget.json();
    assert.equal(body.contract_version, "aionis_forget_result_v1");
    assert.equal(body.operation, "activate");
    assert.equal(body.target, "memory");
    assert.equal(body.forget_effect.changed_count, 1);
    assert.equal(body.forget_effect.reversible, false);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/nodes/activate"]);
    assert.equal(body.result.activated.updated_nodes, 1);
    assert.equal(body.result.activated.outcome, "positive");
    assert.equal(body.result.activated.activate, true);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(typeof rows[0]?.slots.last_activated_at, "string");
  } finally {
    await app.close();
  }
});

test("product guide feedback loop requires repeated weak negative attribution before downgrade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-feedback-repeated-negative-attribution");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_SPARSE_FEEDBACK_MARKER Prefer concise release notes for status updates.",
        memory: {
          client_id: "memory:guide-feedback-negative-attribution",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Sparse feedback status style",
          text_summary: "AIONIS_SPARSE_FEEDBACK_MARKER Prefer concise release notes for status updates.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_SPARSE_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200, beforeGuide.body);
    const beforeGuideBody = beforeGuide.json();
    const beforeMemory = beforeGuideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(beforeMemory);
    assert.equal(beforeMemory.lifecycle_state, "active");
    assert.equal(beforeMemory.authority, "advisory");
    assert.ok(
      beforeGuideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_SPARSE_FEEDBACK_MARKER")
      ),
    );
    assert.equal(beforeGuideBody.agent_context.memory_ids.includes(nodeId), true);

    const feedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:guide-feedback-negative-attribution-1",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "not_run",
        tool_status: "unknown",
        activate: true,
        reason: "The Agent used this recalled memory, but the resulting status update was rejected.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    const feedbackBody = feedback.json();
    assert.equal(feedbackBody.result.activated.outcome, "negative");
    assert.equal(feedbackBody.forget_effect.changed_count, 1);
    assert.deepEqual(feedbackBody.forget_effect.affected_memory_ids, [nodeId]);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_negative, 1);
    assert.equal(rows[0]?.slots.weak_counter_signal_count, 1);
    assert.equal(rows[0]?.slots.strong_counter_signal_count, 0);
    assert.equal(rows[0]?.slots.last_feedback_outcome, "negative");
    assert.equal(rows[0]?.slots.last_feedback_run_id, "run:guide-feedback-negative-attribution-1");
    assert.equal(rows[0]?.slots.last_feedback_used_surface, "use_now");

    const afterFirstWeakGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_SPARSE_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterFirstWeakGuide.statusCode, 200, afterFirstWeakGuide.body);
    const afterFirstWeakGuideBody = afterFirstWeakGuide.json();
    const afterFirstWeakMemory = afterFirstWeakGuideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(afterFirstWeakMemory);
    assert.equal(afterFirstWeakMemory.lifecycle_state, "active");
    assert.equal(afterFirstWeakMemory.authority, "advisory");
    assert.ok(
      afterFirstWeakGuideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_SPARSE_FEEDBACK_MARKER")
      ),
    );

    const secondFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:guide-feedback-negative-attribution-2",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "not_run",
        tool_status: "unknown",
        activate: true,
        reason: "The Agent used the same memory again and the run failed again.",
      },
    });
    assert.equal(secondFeedback.statusCode, 200, secondFeedback.body);

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_SPARSE_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200, afterGuide.body);
    const afterGuideBody = afterGuide.json();
    const afterMemory = afterGuideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(afterMemory);
    assert.equal(afterMemory.lifecycle_state, "contested");
    assert.equal(afterMemory.authority, "candidate");
    assert.equal(
      afterGuideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_SPARSE_FEEDBACK_MARKER")
      ),
      false,
    );
    assert.ok(
      afterGuideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.includes("Sparse feedback status style") || entry.includes(nodeId)
      ),
    );
    assert.equal(afterGuideBody.agent_context.recommended_posture, "inspect_before_use");
    assert.equal(afterGuideBody.agent_context.authority, "candidate");
    assert.equal(
      afterGuideBody.agent_context.risk.reasons.includes("candidate_or_contested_memory_kept_out_of_use_now"),
      true,
    );

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuideBody,
          after_guide: afterGuideBody,
          forget_result: secondFeedback.json(),
          sufficient_evidence: true,
          evidence_ids: ["product_trace:guide-feedback-repeated-negative-attribution"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const measureBody = measure.json();
    assert.equal(measureBody.measurement_input.source, "product_trace");
    assert.equal(measureBody.memory_decision_trace.summary.inspect_before_use_count > 0, true);
  } finally {
    await app.close();
  }
});

test("product guide feedback loop downgrades after aligned verifier failure attribution", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-feedback-strong-negative-attribution");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_STRONG_FEEDBACK_MARKER Prefer release-note format for status updates.",
        memory: {
          client_id: "memory:guide-feedback-strong-negative-attribution",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Strong feedback status style",
          text_summary: "AIONIS_STRONG_FEEDBACK_MARKER Prefer release-note format for status updates.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const feedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:guide-feedback-strong-negative-attribution",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        runtime_signal_refs: ["verifier:status-format-failed"],
        activate: true,
        reason: "The Agent used this memory and the verifier failed on the resulting output.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_negative, 1);
    assert.equal(rows[0]?.slots.weak_counter_signal_count, 0);
    assert.equal(rows[0]?.slots.strong_counter_signal_count, 1);
    assert.equal(rows[0]?.slots.last_feedback_verifier_status, "failed");

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_STRONG_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    const memory = guideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(memory);
    assert.equal(memory.lifecycle_state, "contested");
    assert.equal(memory.authority, "candidate");
    assert.equal(
      guideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_STRONG_FEEDBACK_MARKER")
      ),
      false,
    );
    assert.ok(
      guideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.includes("Strong feedback status style") || entry.includes(nodeId)
      ),
    );
  } finally {
    await app.close();
  }
});

test("product forget activate requires run outcome attribution", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-feedback-attribution-required");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [randomUUID()],
        reason: "This activation feedback lacks attribution and outcome.",
      },
    });

    assert.equal(missing.statusCode, 400);
    assert.ok(missing.body.includes("activate requires run_id"));
    assert.ok(missing.body.includes("activate requires outcome"));
    assert.ok(missing.body.includes("activate requires used_surface"));

    const ambiguous = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [randomUUID()],
        run_id: "run:ambiguous-feedback",
        outcome: "negative",
        used_surface: "inspect_before_use",
        reason: "This activation feedback is not directly attributable to used history.",
      },
    });

    assert.equal(ambiguous.statusCode, 400);
    assert.ok(ambiguous.body.includes("non-neutral activation feedback requires use_now or explicit_host_assertion"));
  } finally {
    await app.close();
  }
});
