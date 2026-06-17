#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { DeterministicEmbeddingProvider } from "../ci/support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { createAionisClient, feedbackFromGuide, snapshotInputFromGuideLoop } from "../../src/sdk.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
import { createLiteExecutionTreeStore } from "../../src/execution/tree-store.ts";
import {
  registerApplicationRoutes,
  registerHealthRoute,
  registerRuntimeErrorHandler,
} from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteReplayStore } from "../../src/store/lite-replay-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import { asRecord, assertCondition, repoRoot } from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type E2eStores = {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
  liteReplayStore: ReturnType<typeof createLiteReplayStore>;
  executionStateStore: ReturnType<typeof createLiteExecutionStateStore>;
  executionTreeStore: ReturnType<typeof createLiteExecutionTreeStore>;
};

type ManagedServerSession = {
  app: FastifyInstance;
  stores: E2eStores;
  baseUrl: string;
  tmpDir: string;
};

const TENANT_ID = "tenant-a";
const SCOPE = "tenant-a/default";
const API_KEY = "tenant-a-key";
const TEAM_ID = "managed-server-team";
const TASK_FAMILY = "managed_server_hybrid_recall";
const WORKFLOW_SIGNATURE = "workflow:managed-server-hybrid-recall";
const TASK_SIGNATURE = "task:managed-server-hybrid-recall";
const TARGET_FILE = "src/checkout/managed-current-route.ts";
const RETIRED_TARGET_FILE = "src/checkout/managed-legacy-route.ts";
const ACCEPTED_MARKER = "MANAGED_SERVER_E2E_ACCEPTED_ROUTE";
const FAILED_MARKER = "MANAGED_SERVER_E2E_FAILED_BRANCH";
const STALE_MARKER = "MANAGED_SERVER_E2E_STALE_MEMORY";
const LEXICAL_MARKER = "MANAGED_SERVER_E2E_BURIED_LEXICAL";
const FAILURE_MODE = "managed-server-legacy-route-regression";
const VERIFICATION_SIGNATURE = "unit:managed-server-checkout-route";
const ACCEPTANCE_CHECK_SIGNATURE = "accept:managed-server-checkout-route";

function tmpDbPath(tmpDir: string, name: string): string {
  return path.join(tmpDir, `${name}.sqlite`);
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
        [API_KEY]: {
          tenant_id: TENANT_ID,
          agent_id: "remote-sdk-agent",
          team_id: TEAM_ID,
          role: "developer",
          default_scope: SCOPE,
          allowed_scopes: [SCOPE],
        },
      }),
      MEMORY_TENANT_ID: TENANT_ID,
      MEMORY_SCOPE: SCOPE,
      LITE_LOCAL_ACTOR_ID: "managed-server-e2e",
      LITE_WRITE_SQLITE_PATH: writePath,
      LITE_REPLAY_SQLITE_PATH: replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      TENANT_QUOTA_ENABLED: "false",
      AUTO_TOPIC_CLUSTER_ON_WRITE: "false",
      MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: "true",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

function registerManagedServerApp(args: {
  app: FastifyInstance;
  env: Env;
  writePath: string;
  replayPath: string;
}): E2eStores {
  const liteWriteStore = createLiteWriteStore(args.writePath);
  const liteRecallStore = createLiteRecallStore(args.writePath);
  const liteReplayStore = createLiteReplayStore(args.replayPath);
  const executionStateStore = createLiteExecutionStateStore(args.writePath);
  const executionTreeStore = createLiteExecutionTreeStore(args.writePath);
  const sandboxHealth = {
    healthSnapshot: () => ({ enabled: false, mode: "disabled" }),
  };
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
  registerHealthRoute({
    app: args.app,
    env: args.env,
    liteReplayStore,
    liteRecallStore,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
    sandboxExecutor: sandboxHealth,
    sandboxTenantBudgetPolicy: new Map(),
    sandboxRemoteAllowedCidrs: new Set(),
  });
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
    resolveRecallProfile: () => ({ profile: "balanced", source: "managed-server-e2e" }),
    resolveExplicitRecallMode: () => ({
      mode: null,
      profile: "balanced",
      defaults: {},
      applied: false,
      reason: "managed_server_e2e_default",
      source: "managed-server-e2e",
    }),
    resolveClassAwareRecallProfile: (_endpoint, _body, baseProfile) => ({
      profile: baseProfile,
      defaults: {},
      enabled: false,
      applied: false,
      reason: "managed_server_e2e_default",
      source: "managed-server-e2e",
      workload_class: null,
      signals: [],
    }),
    withRecallProfileDefaults: (body) => ({ ...(body as Record<string, unknown>) }),
    resolveRecallStrategy: () => ({ strategy: "local", defaults: {}, applied: false }),
    resolveAdaptiveRecallProfile: (profile) => ({ profile, defaults: {}, applied: false, reason: "managed_server_e2e_default" }),
    resolveAdaptiveRecallHardCap: () => ({ defaults: {}, applied: false, reason: "managed_server_e2e_default" }),
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

async function startManagedServer(): Promise<ManagedServerSession> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-managed-server-hybrid-recall-"));
  const writePath = tmpDbPath(tmpDir, "write");
  const replayPath = tmpDbPath(tmpDir, "replay");
  const env = await serverEnv(writePath, replayPath);
  assertCondition(env.RECALL_ENGINE_MODE === "hybrid", "managed server e2e must run route-level hybrid recall");
  const app = Fastify();
  const stores = registerManagedServerApp({ app, env, writePath, replayPath });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") {
    throw new Error("managed server e2e failed to resolve listener address");
  }
  return {
    app,
    stores,
    baseUrl: `http://127.0.0.1:${address.port}`,
    tmpDir,
  };
}

async function closeManagedServer(session: ManagedServerSession): Promise<void> {
  await session.app.close();
  await session.stores.executionTreeStore.close();
  await session.stores.executionStateStore.close();
  await session.stores.liteRecallStore.close();
  await session.stores.liteReplayStore.close();
  await session.stores.liteWriteStore.close();
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function firstNodeId(observeBody: unknown, label: string): string {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} did not return a memory node id`);
  return id;
}

function collectRecallSourceKinds(value: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    const recallSources = record.recall_sources;
    if (Array.isArray(recallSources)) {
      for (const source of recallSources) {
        const sourceRecord = asRecord(source);
        if (typeof sourceRecord?.kind === "string") out.add(sourceRecord.kind);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return out;
}

function collectRecallSourceKindsForMemory(value: unknown, memoryId: string): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.memory_id === memoryId && Array.isArray(record.recall_sources)) {
      for (const source of record.recall_sources) {
        const sourceRecord = asRecord(source);
        if (typeof sourceRecord?.kind === "string") out.add(sourceRecord.kind);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return out;
}

function executionSlots(args: {
  status: "passed" | "failed" | "blocked";
  lifecycleState: "active" | "suppressed" | "contested";
  summaryKind: "current_state" | "failed_branch" | "stale_memory";
  targetFiles: string[];
}): Record<string, unknown> {
  const outcomeRole = args.status === "passed" ? "passed_solution" : args.status === "failed" ? "failed_branch" : "blocked";
  return {
    lifecycle_state: args.lifecycleState,
    summary_kind: args.summaryKind,
    task_family: TASK_FAMILY,
    repo_signature: "repo:aionis-managed-server-e2e",
    file_cluster: "cluster:checkout-runtime",
    target_files: args.targetFiles,
    tool_chain_signature: "read-edit-test",
    failure_mode: FAILURE_MODE,
    verification_signature: VERIFICATION_SIGNATURE,
    acceptance_check_signature: ACCEPTANCE_CHECK_SIGNATURE,
    execution_native_v1: {
      schema_version: "execution_native_v1",
      execution_kind: "workflow_anchor",
      anchor_kind: "workflow",
      summary_kind: args.summaryKind,
      compression_layer: "L2",
      contract_trust: args.status === "passed" ? "authoritative" : "advisory",
      execution_outcome_role: outcomeRole,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      repo_signature: "repo:aionis-managed-server-e2e",
      file_cluster: "cluster:checkout-runtime",
      target_files: args.targetFiles,
      tool_chain_signature: "read-edit-test",
      failure_mode: FAILURE_MODE,
      verification_signature: VERIFICATION_SIGNATURE,
      acceptance_check_signature: ACCEPTANCE_CHECK_SIGNATURE,
      outcome: {
        status: args.status,
      },
    },
    execution_result_summary: {
      status: args.status,
      summary: `${args.summaryKind} recorded by managed server hybrid recall e2e.`,
    },
  };
}

function outputPath(): string {
  const explicit = process.env.AIONIS_MANAGED_SERVER_HYBRID_RECALL_OUTPUT?.trim();
  return explicit || path.join(repoRoot, "docs/examples/managed-server-hybrid-recall-result.json");
}

async function main() {
  const runId = process.env.AIONIS_MANAGED_SERVER_HYBRID_RECALL_RUN_ID?.trim()
    || "managed-server-hybrid-recall-example";
  const session = await startManagedServer();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: API_KEY,
      tenant_id: TENANT_ID,
      scope: SCOPE,
    });
    const health = await aionis.health<Record<string, unknown>>();
    assertCondition(asRecord(health)?.ok === true, "managed server health did not pass");

    const beforeGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: "worker-managed-server",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:before`,
      task_id: `task:${runId}`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: `${ACCEPTED_MARKER}: continue ${TARGET_FILE} using ${WORKFLOW_SIGNATURE}.`,
      context_mode: "compact_agent",
      include_packets: true,
      limit: 8,
      mode: "full_power",
    });
    const beforeContext = asRecord(beforeGuide.agent_context);
    assertCondition(beforeContext?.actionable_history_used === false, "fresh managed server scope should not have actionable history");

    const failedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "worker-managed-server",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:failed`,
      task_id: `task:${runId}`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: `${FAILED_MARKER} legacy route failed`,
      summary: `${FAILED_MARKER}: do not direct-use the retired checkout route even though it mentions ${TARGET_FILE}.`,
      outcome: "failed",
      target_files: [TARGET_FILE, RETIRED_TARGET_FILE],
      workflow_steps: ["patch retired route", "run checkout verifier", "observe verifier failure"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["checkout route verifier passed"],
      continuation_hint: `Do not repeat ${FAILED_MARKER}; it is counter-evidence only.`,
      confidence: 0.93,
      evidence_ref: `evidence://managed-server-hybrid-recall/${runId}/failed`,
      slots: executionSlots({
        status: "failed",
        lifecycleState: "suppressed",
        summaryKind: "failed_branch",
        targetFiles: [TARGET_FILE, RETIRED_TARGET_FILE],
      }),
    });
    const failedMemoryId = firstNodeId(failedObserve, "failed branch observe");

    const staleObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "reviewer-managed-server",
      team_id: TEAM_ID,
      role: "reviewer",
      run_id: `run:${runId}:stale`,
      task_id: `task:${runId}`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: `${STALE_MARKER} stale checkout implementation`,
      summary: `${STALE_MARKER}: older advice says to keep ${RETIRED_TARGET_FILE}, but the accepted route moved to ${TARGET_FILE}.`,
      outcome: "blocked",
      target_files: [RETIRED_TARGET_FILE, TARGET_FILE],
      workflow_steps: ["review old route", "detect stale premise"],
      tool_set: ["read", "review"],
      acceptance_checks: ["stale route blocked"],
      continuation_hint: `${STALE_MARKER} is stale and must not be a direct implementation route.`,
      confidence: 0.9,
      evidence_ref: `evidence://managed-server-hybrid-recall/${runId}/stale`,
      slots: executionSlots({
        status: "blocked",
        lifecycleState: "contested",
        summaryKind: "stale_memory",
        targetFiles: [RETIRED_TARGET_FILE, TARGET_FILE],
      }),
    });
    const staleMemoryId = firstNodeId(staleObserve, "stale memory observe");

    const lexicalText = `${LEXICAL_MARKER}: buried support note for ${TARGET_FILE}; workflow ${WORKFLOW_SIGNATURE}; verifier ${VERIFICATION_SIGNATURE}; acceptance ${ACCEPTANCE_CHECK_SIGNATURE}.`;
    const lexicalObserve = await aionis.observe<Record<string, unknown>>({
      auto_embed: false,
      input_text: lexicalText,
      memory_lane: "shared",
      owner_team_id: TEAM_ID,
      memory: {
        client_id: `managed-server-lexical:${runId}`,
        type: "concept",
        memory_kind: "project_context",
        title: `${LEXICAL_MARKER} checkout target note`,
        text_summary: lexicalText,
        confidence: 0.86,
        slots: {
          lifecycle_state: "active",
          task_family: TASK_FAMILY,
          task_signature: TASK_SIGNATURE,
          workflow_signature: WORKFLOW_SIGNATURE,
          target_files: [TARGET_FILE],
          support_kind: "lexical_only_buried_clue",
        },
      },
    });
    const lexicalMemoryId = firstNodeId(lexicalObserve, "lexical clue observe");

    const acceptedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "worker-managed-server",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:accepted`,
      task_id: `task:${runId}`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: `${ACCEPTED_MARKER} current managed server route accepted`,
      summary: `${ACCEPTED_MARKER}: continue ${TARGET_FILE}; it passed ${VERIFICATION_SIGNATURE} and replaces ${RETIRED_TARGET_FILE}.`,
      outcome: "succeeded",
      target_files: [TARGET_FILE],
      workflow_steps: ["read current checkout route", "apply scoped patch", "run checkout verifier"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["checkout route verifier passed", ACCEPTANCE_CHECK_SIGNATURE],
      continuation_hint: `Continue ${TARGET_FILE}; keep ${FAILED_MARKER} and ${STALE_MARKER} as blocked counter-evidence.`,
      confidence: 0.97,
      evidence_ref: `evidence://managed-server-hybrid-recall/${runId}/accepted`,
      slots: executionSlots({
        status: "passed",
        lifecycleState: "active",
        summaryKind: "current_state",
        targetFiles: [TARGET_FILE],
      }),
    });
    const acceptedMemoryId = firstNodeId(acceptedObserve, "accepted route observe");

    const afterGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: "worker-managed-server",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:after`,
      task_id: `task:${runId}`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: [
        `${ACCEPTED_MARKER}: continue ${TARGET_FILE}.`,
        `${LEXICAL_MARKER}: recover the buried checkout route clue.`,
        `Use workflow ${WORKFLOW_SIGNATURE}, failure mode ${FAILURE_MODE}, verifier ${VERIFICATION_SIGNATURE}.`,
        `Do not repeat ${FAILED_MARKER} or ${STALE_MARKER}.`,
      ].join(" "),
      context: {
        target_files: [TARGET_FILE],
        failure_mode: FAILURE_MODE,
        verification_signature: VERIFICATION_SIGNATURE,
        acceptance_check_signature: ACCEPTANCE_CHECK_SIGNATURE,
      },
      context_mode: "compact_agent",
      include_packets: true,
      limit: 12,
      mode: "full_power",
      tool_candidates: ["read", "edit", "test"],
    });
    const afterContext = asRecord(afterGuide.agent_context);
    assertCondition(afterContext?.contract_version === "aionis_agent_context_v1", "managed server guide missing agent_context");
    const useNowMemoryIds = textArray(afterContext?.use_now_memory_ids);
    const useNowText = textArray(afterContext?.use_now).join("\n");
    assertCondition(useNowMemoryIds.includes(acceptedMemoryId), "accepted route was not admitted to use_now");
    assertCondition(!useNowMemoryIds.includes(failedMemoryId), "failed branch leaked into direct use IDs");
    assertCondition(!useNowMemoryIds.includes(staleMemoryId), "stale memory leaked into direct use IDs");
    assertCondition(!useNowText.includes(FAILED_MARKER), "failed branch leaked into direct use text");
    assertCondition(!useNowText.includes(STALE_MARKER), "stale memory leaked into direct use text");

    const sourceKinds = collectRecallSourceKinds(afterGuide);
    assertCondition(sourceKinds.has("lexical"), "route-level hybrid recall did not surface lexical source traces");
    if (sourceKinds.size < 2) {
      const relevant = recordArray(asRecord(afterGuide.memory_packet)?.relevant_memories).map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        recall_sources: entry.recall_sources,
      }));
      throw new Error(`expected at least two recall source families, got ${Array.from(sourceKinds).join(", ")}; guide_debug=${
        JSON.stringify({
          source_map: afterGuide.source_map,
          relevant,
        })
      }`);
    }

    const feedback = await aionis.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide: afterGuide,
      reason: "Managed Server hybrid recall e2e used the accepted current route and avoided failed/stale branches.",
      run_id: `run:${runId}:feedback`,
      outcome: "positive",
      used_memory_ids: [acceptedMemoryId],
      used_surface: "use_now",
      actor: "worker-managed-server",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: [`memory:${acceptedMemoryId}`, `memory:${lexicalMemoryId}`],
    }));

    const measure = await aionis.execution.measureRun<Record<string, unknown>>({
      run_id: `run:${runId}:measure`,
      task_id: `task:${runId}`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${acceptedMemoryId}`,
        `memory:${failedMemoryId}`,
        `memory:${staleMemoryId}`,
        `memory:${lexicalMemoryId}`,
      ],
    });
    const decisionTrace = asRecord(measure.memory_decision_trace);
    const receipt = asRecord(decisionTrace?.memory_use_receipt);
    const admissionRecord = asRecord(decisionTrace?.admission_record);
    assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", "measure missing memory use receipt");
    assertCondition(admissionRecord?.contract_version === "aionis_memory_admission_record_v1", "measure missing admission record");
    const decisionSummaries = recordArray(receipt.decision_summaries);
    assertCondition(
      decisionSummaries.some((entry) => entry.memory_id === acceptedMemoryId && textArray(entry.reason_codes).length > 0),
      "memory use receipt did not include admission reason codes for accepted route",
    );

    const snapshot = await aionis.snapshot<Record<string, unknown>>(snapshotInputFromGuideLoop({
      run_id: `run:${runId}:snapshot`,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      guide: afterGuide,
      measure_result: measure,
      include_markdown: false,
    }));
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    const operatorGuideTrace = asRecord(operatorSnapshot?.guide_trace);
    const operatorReceipt = asRecord(operatorSnapshot?.memory_use_receipt);
    assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "operator snapshot missing v1 contract");
    assertCondition(operatorGuideTrace !== null, "operator snapshot missing guide trace");
    assertCondition(operatorReceipt?.contract_version === "aionis_memory_use_receipt_v1", "operator snapshot missing memory use receipt");

    const flightRecorder = await aionis.flightRecorder<Record<string, unknown>>({
      run_id: `run:${runId}:flight-recorder`,
      ...(typeof decisionTrace?.trace_id === "string" ? { guide_trace_id: decisionTrace.trace_id } : {}),
      decision_time: "2026-06-17T00:00:00.000Z",
      agent_context: afterContext,
      memory_decision_trace: decisionTrace,
      memory_use_receipt: receipt,
      memory_admission_record: admissionRecord,
      operator_snapshot: operatorSnapshot,
      feedback_result: feedback,
    });
    const flightReport = asRecord(flightRecorder.agent_flight_recorder);
    const flightAgentView = asRecord(flightReport?.agent_view);
    const flightReplaySources = asRecord(flightReport?.replay_sources);
    const flightBlockedRows = recordArray(flightReport?.blocked_or_suppressed);
    const flightUseNowMemoryIds = textArray(flightAgentView?.use_now_memory_ids);
    const flightDoNotUseMemoryIds = textArray(flightAgentView?.do_not_use_memory_ids);
    const flightAcceptedSourceKinds = collectRecallSourceKindsForMemory(flightReport, acceptedMemoryId);
    const flightFailedSourceKinds = collectRecallSourceKindsForMemory(flightReport, failedMemoryId);
    const flightStaleSourceKinds = collectRecallSourceKindsForMemory(flightReport, staleMemoryId);

    assertCondition(
      flightRecorder.contract_version === "aionis_agent_flight_recorder_result_v1",
      "flight recorder missing result contract",
    );
    assertCondition(
      flightReport?.contract_version === "aionis_agent_flight_recorder_report_v1",
      "flight recorder missing report contract",
    );
    assertCondition(flightReport?.agent_prompt_included === false, "flight recorder included Agent prompt payload");
    assertCondition(flightReport?.runtime_mutation === false, "flight recorder mutated Runtime state");
    assertCondition(flightAgentView?.prompt_text_included === false, "flight recorder agent_view included prompt text");
    assertCondition(flightReplaySources?.has_agent_context === true, "flight recorder missed agent_context source");
    assertCondition(flightReplaySources?.has_memory_decision_trace === true, "flight recorder missed decision trace source");
    assertCondition(flightReplaySources?.has_memory_use_receipt === true, "flight recorder missed memory receipt source");
    assertCondition(flightReplaySources?.has_memory_admission_record === true, "flight recorder missed admission record source");
    assertCondition(flightReplaySources?.has_operator_snapshot === true, "flight recorder missed operator snapshot source");
    assertCondition(flightReplaySources?.has_feedback_result === true, "flight recorder missed feedback source");
    assertCondition(flightUseNowMemoryIds.includes(acceptedMemoryId), "flight recorder did not replay accepted direct-use memory");
    assertCondition(!flightUseNowMemoryIds.includes(failedMemoryId), "flight recorder replayed failed memory as direct-use");
    assertCondition(!flightUseNowMemoryIds.includes(staleMemoryId), "flight recorder replayed stale memory as direct-use");
    assertCondition(
      flightDoNotUseMemoryIds.includes(failedMemoryId)
      || flightBlockedRows.some((entry) => entry.memory_id === failedMemoryId),
      "flight recorder did not expose failed memory as blocked/suppressed",
    );
    assertCondition(
      flightDoNotUseMemoryIds.includes(staleMemoryId)
      || flightBlockedRows.some((entry) => entry.memory_id === staleMemoryId),
      "flight recorder did not expose stale memory as blocked/suppressed",
    );
    assertCondition(flightAcceptedSourceKinds.size > 0, "flight recorder missed accepted recall sources");
    assertCondition(flightFailedSourceKinds.size > 0, "flight recorder missed failed recall sources");
    assertCondition(flightStaleSourceKinds.size > 0, "flight recorder missed stale recall sources");

    const output = {
      contract_version: "aionis_managed_server_hybrid_recall_e2e_result_v1",
      run_id: runId,
      server: {
        started_over_real_http: true,
        auth_mode: "api_key",
        recall_engine_mode: "hybrid",
        sdk_client: "createAionisClient",
        tenant_id: TENANT_ID,
        scope: SCOPE,
      },
      scenario: {
        accepted_memory_id: acceptedMemoryId,
        failed_memory_id: failedMemoryId,
        stale_memory_id: staleMemoryId,
        lexical_memory_id: lexicalMemoryId,
        target_file: TARGET_FILE,
        workflow_signature: WORKFLOW_SIGNATURE,
      },
      assertions: {
        accepted_route_use_now: useNowMemoryIds.includes(acceptedMemoryId),
        failed_direct_use_blocked: !useNowMemoryIds.includes(failedMemoryId) && !useNowText.includes(FAILED_MARKER),
        stale_direct_use_blocked: !useNowMemoryIds.includes(staleMemoryId) && !useNowText.includes(STALE_MARKER),
        recall_source_family_count: sourceKinds.size,
        recall_source_families: Array.from(sourceKinds).sort(),
        lexical_source_visible: sourceKinds.has("lexical"),
        memory_use_receipt_visible: receipt.contract_version === "aionis_memory_use_receipt_v1",
        admission_record_visible: admissionRecord.contract_version === "aionis_memory_admission_record_v1",
        operator_snapshot_trace_visible: operatorGuideTrace !== null,
        operator_snapshot_receipt_visible: operatorReceipt.contract_version === "aionis_memory_use_receipt_v1",
        flight_recorder_replay_visible: flightReport?.contract_version === "aionis_agent_flight_recorder_report_v1",
        flight_recorder_prompt_payload_excluded:
          flightReport?.agent_prompt_included === false && flightAgentView?.prompt_text_included === false,
        flight_recorder_accepted_recall_sources: Array.from(flightAcceptedSourceKinds).sort(),
        flight_recorder_failed_recall_sources: Array.from(flightFailedSourceKinds).sort(),
        flight_recorder_stale_recall_sources: Array.from(flightStaleSourceKinds).sort(),
        flight_recorder_failed_stale_not_direct_use:
          !flightUseNowMemoryIds.includes(failedMemoryId) && !flightUseNowMemoryIds.includes(staleMemoryId),
      },
      note: "This e2e starts Server Edition with API key auth, writes governed execution history, calls guide and Agent Flight Recorder through the remote SDK, and verifies recall source traces remain below memory admission governance.",
    };

    const outPath = outputPath();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await closeManagedServer(session);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
