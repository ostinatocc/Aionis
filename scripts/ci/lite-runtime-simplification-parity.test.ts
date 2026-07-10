import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

import { createRequestGuards } from "../../src/app/request-guards.ts";
import { createHandoffRouteService } from "../../src/routes/handoff.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { createRuntimeProductServices, registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { AionisClientError, createAionisClient } from "../../src/sdk.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";

const EXACT_TASK = "runtime-simplification-exact-task";
const EXACT_WORKFLOW = "runtime-simplification-exact-workflow";
const OTHER_TASK = "runtime-simplification-other-task";
const OTHER_WORKFLOW = "runtime-simplification-other-workflow";
const PASSED_MARKER = "SIMPLIFICATION_PARITY_EXACT_PASSED";
const FAILED_MARKER = "SIMPLIFICATION_PARITY_EXACT_FAILED";
const OTHER_MARKER = "SIMPLIFICATION_PARITY_UNRELATED_PASSED";
const ORDINARY_MARKER = "SIMPLIFICATION_PARITY_ORDINARY_MEMORY";
const ARCHIVED_MARKER = "SIMPLIFICATION_PARITY_ARCHIVED_EVIDENCE_ONLY";
const RAW_SLOT_SENTINEL = "SIMPLIFICATION_PARITY_RAW_SLOT_SENTINEL";

const EXPECTED_TOP_LEVEL_KEYS = {
  observe: [
    "contract_version",
    "handoff",
    "memory_write",
    "observed",
    "scope",
    "source_map",
    "structured_memory",
    "tenant_id",
  ],
  guide: [
    "agent_context",
    "consumer_agent_id",
    "contract_version",
    "guide_packet",
    "guide_trace_id",
    "memory_packet",
    "scope",
    "source_map",
    "tenant_id",
  ],
  feedback: [
    "contract_version",
    "forget_effect",
    "operation",
    "product_action",
    "result",
    "scope",
    "source_map",
    "target",
    "tenant_id",
  ],
  measure: [
    "contract_version",
    "effect_report",
    "kernel_report",
    "measurement_input",
    "memory_decision_audit",
    "memory_decision_trace",
    "scope",
    "source_map",
    "tenant_id",
  ],
  forget: [
    "contract_version",
    "forget_effect",
    "operation",
    "result",
    "scope",
    "source_map",
    "target",
    "tenant_id",
  ],
  rehydrate: [
    "contract_version",
    "forget_effect",
    "operation",
    "product_action",
    "result",
    "scope",
    "source_map",
    "target",
    "tenant_id",
  ],
} as const;

type ParityEndpoint = keyof typeof EXPECTED_TOP_LEVEL_KEYS;
type JsonRecord = Record<string, any>;

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-runtime-simplification-parity-"));
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

function registerParityRuntime(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  const guards = requestGuards(args.env);
  registerRuntimeErrorHandler(args.app);
  const contextRuntimeRoutes = registerMemoryContextRuntimeRoutes({
    app: args.app,
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
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

  registerProductFacadeRoutes({
    app: args.app,
    services: createRuntimeProductServices({
      env: args.env,
      liteWriteStore: args.liteWriteStore,
      executionTreeStore: null,
      memoryWriteService: createMemoryWriteRouteService({
        env: args.env,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore: args.liteWriteStore,
        executionStateStore: null,
      }),
      handoffRouteService: createHandoffRouteService({
        env: args.env,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore: args.liteWriteStore,
        executionStateStore: null,
      }),
    }),
    planningContextService: contextRuntimeRoutes.planningContextService,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

async function listenLocal(app: ReturnType<typeof Fastify>): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function firstNodeId(response: JsonRecord): string {
  const id = response.memory_write?.nodes?.[0]?.id;
  assert.equal(typeof id, "string", JSON.stringify(response));
  return id;
}

function containsMarker(values: unknown, marker: string): boolean {
  return Array.isArray(values) && values.some((entry) => String(entry).includes(marker));
}

function relevantMemoryByMarker(guide: JsonRecord, marker: string): JsonRecord | null {
  const memories = guide.memory_packet?.relevant_memories;
  if (!Array.isArray(memories)) return null;
  return memories.find((entry: JsonRecord) => JSON.stringify(entry).includes(marker)) ?? null;
}

function assertExactTopLevelKeys(endpoint: ParityEndpoint, response: JsonRecord): void {
  assert.deepEqual(Object.keys(response).sort(), [...EXPECTED_TOP_LEVEL_KEYS[endpoint]].sort());
}

function normalizeParityValue(value: unknown, scopes: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeParityValue(entry, scopes));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeParityValue(entry, scopes)]),
    );
  }
  if (typeof value !== "string") return value;
  let normalized = value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>")
    .replace(/\/[^\s\"]*aionis-runtime-simplification-parity-[^\s\"]*/g, "<temp-path>");
  for (const scope of scopes) normalized = normalized.split(scope).join("<scope>");
  return normalized;
}

function publicShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    const shapes = value.map(publicShape);
    const uniqueShapes = [...new Map(shapes.map((shape) => [JSON.stringify(shape), shape])).values()];
    uniqueShapes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { type: "array", item_shapes: uniqueShapes };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, publicShape(entry)]),
    );
  }
  if (value === null) return "null";
  return typeof value;
}

function normalizedPublicShapes(
  responses: Record<ParityEndpoint, JsonRecord>,
  scopes: string[],
): Record<ParityEndpoint, unknown> {
  return Object.fromEntries(
    Object.entries(responses).map(([endpoint, response]) => [
      endpoint,
      publicShape(normalizeParityValue(response, scopes)),
    ]),
  ) as Record<ParityEndpoint, unknown>;
}

async function runProductLoop(baseUrl: string, scope: string) {
  const client = createAionisClient({
    baseUrl,
    tenant_id: "default",
    scope,
  });
  const agentId = "simplification-parity-agent";

  const ordinaryObserve = await client.remember<JsonRecord>({
    text: `${ORDINARY_MARKER} Prefer short continuation summaries with explicit evidence boundaries.`,
    kind: "preference",
    client_id: "simplification-parity-ordinary",
    memory_lane: "private",
    owner_agent_id: agentId,
    auto_embed: true,
  });

  const passedObserve = await client.observe<JsonRecord>({
    auto_embed: true,
    input_text: `${PASSED_MARKER} continue src/parity/current.ts after the verifier passed.`,
    memory_lane: "private",
    owner_agent_id: agentId,
    memory: {
      client_id: "simplification-parity-exact-passed",
      type: "procedure",
      memory_kind: "execution_workflow",
      title: `${PASSED_MARKER} verified exact-task continuation`,
      text_summary: `${PASSED_MARKER} continue src/parity/current.ts after the verifier passed.`,
      task_signature: EXACT_TASK,
      workflow_signature: EXACT_WORKFLOW,
      target_files: ["src/parity/current.ts"],
      next_action: `Continue ${PASSED_MARKER} in src/parity/current.ts.`,
      tool_set: ["read", "edit", "test"],
      confidence: 0.95,
      evidence_ref: "evidence://simplification-parity/exact/passed",
      raw_ref: "trace://simplification-parity/exact/passed",
      slots: {
        contract_trust: "accepted",
        private_runtime_payload: RAW_SLOT_SENTINEL,
        execution_result_summary: {
          status: "passed",
          summary: `${PASSED_MARKER} passed with raw verifier evidence.`,
          evidence_refs: ["evidence://simplification-parity/exact/passed"],
        },
      },
    },
  });
  const persistedPassedWorkflowId = firstNodeId(passedObserve);

  await client.execution.observeStep<JsonRecord>({
    agent_id: agentId,
    role: "worker",
    run_id: "run-simplification-parity-failed",
    task_id: "task-simplification-parity-exact",
    task_signature: EXACT_TASK,
    workflow_signature: `${EXACT_WORKFLOW}-failed`,
    title: `${FAILED_MARKER} rejected exact-task branch`,
    summary: `${FAILED_MARKER} changed the wrong target and failed verifier replay.`,
    outcome: "failed",
    target_files: ["src/parity/wrong.ts"],
    tool_set: ["read", "edit", "test"],
    continuation_hint: `Do not repeat ${FAILED_MARKER}.`,
    evidence_ref: "evidence://simplification-parity/exact/failed",
    raw_ref: "trace://simplification-parity/exact/failed",
    auto_embed: true,
    memory_lane: "private",
    slots: {
      execution_result_summary: {
        status: "failed",
        summary: `${FAILED_MARKER} failed verifier replay.`,
        diagnostic_note: "Wrong target; retain as counter-evidence.",
        evidence_refs: ["evidence://simplification-parity/exact/failed"],
      },
    },
  });

  await client.execution.observeStep<JsonRecord>({
    agent_id: agentId,
    role: "worker",
    run_id: "run-simplification-parity-unrelated",
    task_id: "task-simplification-parity-other",
    task_signature: OTHER_TASK,
    workflow_signature: OTHER_WORKFLOW,
    title: `${OTHER_MARKER} unrelated task continuation`,
    summary: `${OTHER_MARKER} is valid only for src/parity/other.ts.`,
    outcome: "succeeded",
    target_files: ["src/parity/other.ts"],
    tool_set: ["read", "edit", "test"],
    continuation_hint: `Continue ${OTHER_MARKER} only for the unrelated task.`,
    evidence_ref: "evidence://simplification-parity/other/passed",
    raw_ref: "trace://simplification-parity/other/passed",
    auto_embed: true,
    memory_lane: "private",
    slots: { contract_trust: "advisory" },
  });

  const handoffObserve = await client.observe<JsonRecord>({
    handoff: {
      memory_lane: "private",
      owner_agent_id: agentId,
      anchor: EXACT_TASK,
      file_path: "src/parity/current.ts",
      repo_root: "/workspace/parity",
      handoff_kind: "task_handoff",
      task_signature: EXACT_TASK,
      title: "Simplification parity exact-task handoff",
      summary: `Continue ${PASSED_MARKER} and keep ${FAILED_MARKER} as counter-evidence.`,
      handoff_text: "Recover exact-task state before continuing.",
      target_files: ["src/parity/current.ts"],
      next_action: `Continue ${PASSED_MARKER}.`,
      execution_tree_disabled: true,
    },
  });
  assert.equal(handoffObserve.observed.handoff_stored, true);

  const archivedObserve = await client.observe<JsonRecord>({
    auto_embed: true,
    input_text: `${ARCHIVED_MARKER} remains evidence-only after explicit rehydration.`,
    memory_lane: "private",
    owner_agent_id: agentId,
    memory: {
      client_id: "simplification-parity-archived",
      type: "procedure",
      tier: "archive",
      memory_kind: "execution_workflow",
      title: `${ARCHIVED_MARKER} archived procedure`,
      text_summary: `${ARCHIVED_MARKER} remains evidence-only after explicit rehydration.`,
      task_signature: EXACT_TASK,
      workflow_signature: `${EXACT_WORKFLOW}-archived`,
      target_files: ["src/parity/archive.ts"],
      next_action: "Inspect archived evidence before deciding whether it applies.",
      confidence: 0.8,
      slots: {
        contract_trust: "evidence_only",
        lifecycle_state: "archived",
      },
    },
  });
  const archivedMemoryId = firstNodeId(archivedObserve);

  const exactGuideResult = await client.guideAgentContext<JsonRecord>({
    query_text: `${PASSED_MARKER} continue the exact task and avoid ${FAILED_MARKER}.`,
    consumer_agent_id: agentId,
    agent_role: "reviewer",
    context: {
      task_signature: EXACT_TASK,
      task_family: "runtime_simplification_parity",
      workflow_signature: EXACT_WORKFLOW,
    },
    tool_candidates: ["read", "edit", "test"],
    include_packets: true,
    limit: 20,
  }, undefined, {
    evidence_limit: 0,
    max_prompt_chars: 20_000,
  });
  const exactGuide = exactGuideResult.guide;
  const exactAgentContext = exactGuide.agent_context;
  assert.equal(containsMarker(exactAgentContext.use_now, PASSED_MARKER), true);
  assert.equal(containsMarker(exactAgentContext.use_now, FAILED_MARKER), false);
  assert.equal(
    containsMarker(exactAgentContext.do_not_use, FAILED_MARKER)
      || containsMarker(exactAgentContext.inspect_before_use, FAILED_MARKER),
    true,
  );
  assert.equal(containsMarker(exactAgentContext.use_now, OTHER_MARKER), false);
  assert.equal(exactGuideResult.agent_prompt.includes(RAW_SLOT_SENTINEL), false);
  assert.equal(exactGuideResult.agent_prompt.includes("private_runtime_payload"), false);
  assert.equal(exactGuideResult.agent_prompt.includes("raw_slots"), false);

  const passedMemory = relevantMemoryByMarker(exactGuide, PASSED_MARKER);
  assert.ok(passedMemory, JSON.stringify(exactGuide.memory_packet));
  const passedMemoryId = String(passedMemory.memory_id);
  assert.equal(passedMemoryId, persistedPassedWorkflowId);
  assert.equal(exactAgentContext.memory_ids.includes(passedMemoryId), true);
  assert.ok(relevantMemoryByMarker(exactGuide, ORDINARY_MARKER));
  const passedWorkflow = (exactGuide.guide_packet.guidance.workflow_candidates as JsonRecord[])
    .find((entry) => JSON.stringify(entry).includes(PASSED_MARKER));
  assert.ok(passedWorkflow, JSON.stringify(exactGuide.guide_packet.guidance.workflow_candidates));
  const passedWorkflowId = String(passedWorkflow.workflow_id);
  assert.equal(passedWorkflowId, persistedPassedWorkflowId);

  const differentTaskGuide = await client.guide<JsonRecord>({
    query_text: `${OTHER_MARKER} continue only the unrelated task.`,
    consumer_agent_id: agentId,
    context: {
      task_signature: OTHER_TASK,
      task_family: "runtime_simplification_parity_other",
      workflow_signature: OTHER_WORKFLOW,
    },
    include_packets: true,
    limit: 20,
  });
  assert.equal(containsMarker(differentTaskGuide.agent_context.use_now, PASSED_MARKER), false);

  const postGuideObserve = await client.remember<JsonRecord>({
    text: "SIMPLIFICATION_PARITY_POST_GUIDE_UNEXPOSED created after the exact guide.",
    kind: "fact",
    client_id: "simplification-parity-post-guide-unexposed",
    memory_lane: "private",
    owner_agent_id: agentId,
    auto_embed: true,
  });
  const unexposedMemoryId = firstNodeId(postGuideObserve);
  await assert.rejects(
    () => client.feedback({
      guide_trace_id: exactGuide.guide_trace_id,
      used_memory_ids: [unexposedMemoryId],
      run_id: "run-simplification-parity-rejected-feedback",
      outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      reason: "A memory created after guide exposure cannot receive attributed feedback.",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AionisClientError);
      assert.equal(error.status, 400);
      assert.equal((error.response as JsonRecord).error, "guide_trace_used_memory_not_exposed");
      return true;
    },
  );

  const feedback = await client.feedback<JsonRecord>({
    guide_trace_id: exactGuide.guide_trace_id,
    used_memory_ids: [passedMemoryId],
    run_id: "run-simplification-parity-feedback",
    outcome: "positive",
    used_surface: "use_now",
    verifier_status: "passed",
    tool_status: "succeeded",
    runtime_signal_refs: ["verifier:simplification-parity-passed"],
    reason: "The exact-task passed memory supported a verified continuation.",
  });
  assert.deepEqual(feedback.forget_effect.affected_memory_ids, [passedMemoryId]);

  const evidenceId = "product_trace:runtime-simplification-parity";
  const measure = await client.measure<JsonRecord>({
    product_trace: {
      before_guide: exactGuide,
      after_guide: exactGuide,
      forget_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [evidenceId],
    },
  });
  const allowedEvidenceIds = new Set<string>([
    evidenceId,
    ...(exactGuide.memory_packet.lifecycle.used_memory_ids ?? []).map((id: string) => `before:${id}`),
    ...(exactGuide.memory_packet.lifecycle.used_memory_ids ?? []).map((id: string) => `after:${id}`),
    ...(exactGuide.guide_packet.guidance.workflow_candidates ?? []).map((entry: JsonRecord) => `workflow:${entry.workflow_id}`),
    ...(feedback.forget_effect.affected_memory_ids ?? []).map((id: string) => `forget:${id}`),
    ...(measure.kernel_report.kernel_scores ?? []).map((entry: JsonRecord) => `effect_kernel:${entry.capability_id}`),
  ]);
  const measuredEvidenceIds = measure.effect_report.evidence.evidence_ids as string[];
  assert.equal(measuredEvidenceIds.length > 0, true);
  assert.equal(measuredEvidenceIds.every((id) => allowedEvidenceIds.has(id)), true, JSON.stringify(measuredEvidenceIds));
  assert.equal(JSON.stringify(measure).includes("SIMPLIFICATION_PARITY_UNAVAILABLE_EVIDENCE"), false);

  const suppress = await client.forget<JsonRecord>({
    operation: "suppress",
    target: "pattern",
    actor: agentId,
    anchor_id: passedWorkflowId,
    mode: "shadow_learn",
    reason: "Suspend the exact-task workflow while its applicability is reviewed.",
  });
  assert.equal(suppress.result.operator_override.suppressed, true);

  const suppressedGuide = await client.guide<JsonRecord>({
    query_text: `${PASSED_MARKER} continue the exact task.`,
    consumer_agent_id: agentId,
    context: {
      task_signature: EXACT_TASK,
      task_family: "runtime_simplification_parity",
      workflow_signature: EXACT_WORKFLOW,
    },
    include_packets: true,
    limit: 20,
  });
  assert.equal(suppressedGuide.agent_context.use_now_memory_ids.includes(passedWorkflowId), false);
  assert.equal(
    (suppressedGuide.guide_packet.guidance.workflow_candidates as JsonRecord[])
      .some((entry) => entry.workflow_id === passedWorkflowId),
    false,
  );
  assert.equal(containsMarker(suppressedGuide.agent_context.use_now, PASSED_MARKER), false);

  const rehydrate = await client.rehydrate<JsonRecord>({
    target: "archive",
    actor: agentId,
    memory_ids: [archivedMemoryId],
    target_tier: "hot",
    reason: "The exact task returned, so archived evidence may be inspected again.",
  });
  assert.equal(rehydrate.result.rehydrated.moved_nodes, 1);

  const rehydratedGuide = await client.guide<JsonRecord>({
    query_text: `${ARCHIVED_MARKER} inspect the rehydrated evidence for the exact task.`,
    consumer_agent_id: agentId,
    context: {
      task_signature: EXACT_TASK,
      task_family: "runtime_simplification_parity",
      workflow_signature: EXACT_WORKFLOW,
    },
    include_packets: true,
    limit: 20,
  });
  assert.equal(rehydratedGuide.agent_context.use_now_memory_ids.includes(archivedMemoryId), false);
  const rehydratedMemory = relevantMemoryByMarker(rehydratedGuide, ARCHIVED_MARKER);
  if (rehydratedMemory) {
    assert.notEqual(rehydratedMemory.authority, "trusted");
    assert.notEqual(rehydratedMemory.memory_contract?.use_policy, "direct_use");
  }

  const responses = {
    observe: ordinaryObserve,
    guide: exactGuide,
    feedback,
    measure,
    forget: suppress,
    rehydrate,
  } satisfies Record<ParityEndpoint, JsonRecord>;
  for (const [endpoint, response] of Object.entries(responses)) {
    assertExactTopLevelKeys(endpoint as ParityEndpoint, response);
  }
  return { responses, scope };
}

test("Runtime simplification parity preserves the real SQLite HTTP SDK product loop", async () => {
  const app = Fastify();
  const env = liteEnv();
  const dbPath = tmpDbPath("runtime-simplification-parity");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerParityRuntime({ app, env, liteWriteStore, liteRecallStore });
    const baseUrl = await listenLocal(app);
    const first = await runProductLoop(baseUrl, "runtime-simplification-parity-a");
    const second = await runProductLoop(baseUrl, "runtime-simplification-parity-b");
    const scopes = [first.scope, second.scope];
    assert.deepEqual(
      normalizedPublicShapes(first.responses, scopes),
      normalizedPublicShapes(second.responses, scopes),
    );
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
