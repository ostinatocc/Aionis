import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import stableStringify from "fast-json-stable-stringify";
import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../../src/config.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { createHandoffRouteService, registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryAccessRoutes } from "./support/register-memory-access-test-routes.ts";
import {
  createMemoryPlanningContextService,
  type MemoryPlanningContextService,
} from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryFeedbackToolRoutes } from "./support/register-memory-feedback-tool-test-routes.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { registerMemoryWriteRoutes } from "./support/register-memory-write-test-route.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { buildAionisMemoryPacket } from "../../src/memory/product-output/memory-packet.ts";
import {
  hostTaskEnvelopeDigest,
  hostUseReceiptDigest,
  learningCollectionPrincipalSha256,
  learningEpisodeEventDigest,
  LearningEpisodeEventWithoutDigestSchema,
  type HostUseReceiptV1Body,
} from "../../src/memory/learning-episode-ledger.ts";
import { ProductGuideRequest, guideExposureServedMemoryIds } from "../../src/product/product-services.ts";
import { createProductGuideService } from "../../src/product/guide-service.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { createRuntimeProductServices, registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import {
  createLiteLearningEpisodeLedgerAccess,
  learningFeedbackAttributionItemDigest,
  learningFeedbackAttributionSetDigest,
  LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS,
  type LiteLearningEpisodeLedgerAccess,
} from "../../src/store/lite-learning-episode-ledger.ts";
import type { LiteLearningAuthorityRow } from "../../src/store/lite-learning-confirmatory-authority.ts";
import { createLiteLearningExperimentProvisioner } from "../../src/store/lite-learning-experiment-provisioning.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.ts";
import { verifyLiteRuntimeDatabase } from "../../src/store/lite-runtime-data-operations.ts";
import {
  createLiteWriteStore,
  createLiteWriteStoreFromDatabase,
} from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import type { AuthPrincipal } from "../../src/util/auth.ts";
import {
  CONFIRMATORY_TASK_FAMILY,
  createConfirmatoryPassedRegistry,
  createConfirmatoryProfile,
  sha256,
} from "./support/learning-experiment-confirmatory-fixture.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-feedback-closed-loop-"));
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

function registerProductFacade(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallAccess?: ReturnType<ReturnType<typeof createLiteRecallStore>["createRecallAccess"]> | null;
  embedder?: typeof DeterministicEmbeddingProvider | null;
  memoryWriteService?: ReturnType<typeof createMemoryWriteRouteService> | null;
  planningContextService?: MemoryPlanningContextService | null;
  handoffRouteService?: ReturnType<typeof createHandoffRouteService> | null;
  learningEpisodeLedgerAccess?: LiteLearningEpisodeLedgerAccess | null;
  admissionCandidatePolicyProfileRules?: readonly AionisAdmissionCandidatePolicyProfileRule[];
}) {
  registerProductFacadeRoutes({
    app: args.app,
    services: createRuntimeProductServices({
      env: args.env,
      liteWriteStore: args.liteWriteStore,
      liteRecallAccess: args.liteRecallAccess ?? null,
      embedder: args.embedder ?? null,
      executionTreeStore: null,
      memoryWriteService: args.memoryWriteService ?? null,
      handoffRouteService: args.handoffRouteService ?? null,
      learningEpisodeLedgerAccess: args.learningEpisodeLedgerAccess ?? null,
      admissionCandidatePolicyProfileRules: args.admissionCandidatePolicyProfileRules,
    }),
    planningContextService: args.planningContextService ?? null,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

function registerProductMemoryApp(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
  learningEpisodeLedgerAccess?: LiteLearningEpisodeLedgerAccess | null;
  planningContextService?: MemoryPlanningContextService | null;
  admissionCandidatePolicyProfileRules?: readonly AionisAdmissionCandidatePolicyProfileRule[];
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
  const contextRuntimeRoutes = createMemoryPlanningContextService({
    env: args.env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
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
  registerProductFacade({
    ...args,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    embedder: DeterministicEmbeddingProvider,
    memoryWriteService: createMemoryWriteRouteService({
      env: args.env,
      embedder: DeterministicEmbeddingProvider,
      liteWriteStore: args.liteWriteStore,
      executionStateStore: null,
    }),
    planningContextService: args.planningContextService ?? contextRuntimeRoutes,
    handoffRouteService: createHandoffRouteService({
      env: args.env,
      embedder: DeterministicEmbeddingProvider,
      liteWriteStore: args.liteWriteStore,
      executionStateStore: null,
    }),
  });
}

function setupProductApp(name: string, overrides: Partial<ReturnType<typeof liteEnv>> = {}) {
  const app = Fastify();
  const env = {
    ...liteEnv(),
    ...overrides,
  };
  const guards = requestGuards(env);
  const dbPath = tmpDbPath(name);
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  registerProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
  return { app, liteWriteStore };
}

function setupLearningProductApp(args: {
  name: string;
  overrides?: Partial<ReturnType<typeof liteEnv>>;
  planningContextService?: MemoryPlanningContextService | null;
  admissionCandidatePolicyProfileRules?: readonly AionisAdmissionCandidatePolicyProfileRule[];
}) {
  const app = Fastify();
  const env = {
    ...liteEnv(),
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: "[]",
    ...(args.overrides ?? {}),
  };
  const guards = requestGuards(env);
  const dbPath = tmpDbPath(args.name);
  const runtimeDatabase = createLiteRuntimeDatabase(dbPath);
  const liteWriteStore = createLiteWriteStoreFromDatabase(runtimeDatabase, {
    annProjectionEnabled: false,
  });
  const learningEpisodeLedgerAccess = createLiteLearningEpisodeLedgerAccess(runtimeDatabase);
  const liteRecallStore = createLiteRecallStore(dbPath);
  registerProductMemoryApp({
    app,
    env,
    guards,
    liteWriteStore,
    liteRecallStore,
    learningEpisodeLedgerAccess,
    planningContextService: args.planningContextService,
    admissionCandidatePolicyProfileRules: args.admissionCandidatePolicyProfileRules,
  });
  return {
    app,
    env,
    dbPath,
    runtimeDatabase,
    liteWriteStore,
    learningEpisodeLedgerAccess,
    async close() {
      try {
        await app.close();
      } finally {
        try {
          await liteRecallStore.close();
        } finally {
          try {
            await liteWriteStore.close();
          } finally {
            await runtimeDatabase.close();
          }
        }
      }
    },
  };
}

function scalarCount(
  database: LiteRuntimeDatabase,
  sql: string,
  ...params: unknown[]
): number {
  const row = database.db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

function mutateFeedbackAppendOnlyTables(
  database: LiteRuntimeDatabase,
  mutate: () => void,
): void {
  const tables = new Set([
    "lite_learning_feedback_attributions",
    "lite_learning_episode_events",
  ]);
  const triggers = Object.entries(LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS)
    .filter(([, requirement]) => tables.has(requirement.table));
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name] of triggers) database.db.exec(`DROP TRIGGER ${name}`);
    mutate();
    for (const [, requirement] of triggers) database.db.exec(requirement.sql);
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function eligibleHostPrincipal(): AuthPrincipal {
  return {
    tenant_id: "default",
    agent_id: "local-user",
    team_id: null,
    role: "verifier",
    default_scope: "default",
    allowed_scopes: ["default"],
    source: "api_key",
  };
}

function eligibleHostDiagnosticProfile(
  principal: AuthPrincipal,
): AionisAdmissionCandidatePolicyProfileRule {
  const base = createConfirmatoryProfile();
  assert.ok(base.experiment);
  const collectionSource = base.experiment.collection_sources[0];
  assert.ok(collectionSource);
  const [profile] = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([{
    ...base,
    profile_id: "feedback-eligible-host-diagnostic-profile",
    experiment: {
      ...base.experiment,
      experiment_id: "feedback-eligible-host-diagnostic-experiment",
      serving_phase: "shadow",
      evidence_intent: "integrity_only",
      assignment_design: "diagnostic_hash_v1",
      required_external_inputs: {},
      collection_sources: [{
        ...collectionSource,
        principal_sha256: learningCollectionPrincipalSha256({
          tenant_id: principal.tenant_id,
          agent_id: principal.agent_id,
          team_id: principal.team_id,
        }),
      }],
    },
  }]));
  assert.ok(profile?.experiment);
  return profile;
}

async function prepareEligibleHostFeedbackScenario(args: {
  name: string;
  confidence: number;
}) {
  const principal = eligibleHostPrincipal();
  const profile = eligibleHostDiagnosticProfile(principal);
  assert.ok(profile.experiment);
  const apiKey = `eligible-host-${args.name}-key`;
  const intruderApiKey = `eligible-host-${args.name}-intruder-key`;
  const headers = { "x-api-key": apiKey };
  const intruderHeaders = { "x-api-key": intruderApiKey };
  const fixture = setupLearningProductApp({
    name: args.name,
    overrides: {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: JSON.stringify({
        [apiKey]: {
          tenant_id: principal.tenant_id,
          agent_id: principal.agent_id,
          role: principal.role,
          default_scope: principal.default_scope,
          allowed_scopes: principal.allowed_scopes,
        },
        [intruderApiKey]: {
          tenant_id: principal.tenant_id,
          agent_id: `${principal.agent_id}-intruder`,
          role: principal.role,
          default_scope: principal.default_scope,
          allowed_scopes: principal.allowed_scopes,
        },
      }),
      AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV: false,
    },
    admissionCandidatePolicyProfileRules: [profile],
  });
  try {
    const provisioned = await createLiteLearningExperimentProvisioner({
      database: fixture.runtimeDatabase,
      writeStore: fixture.liteWriteStore,
      ledger: fixture.learningEpisodeLedgerAccess,
      dependencies: {
        registry: createConfirmatoryPassedRegistry(),
        now: () => "2026-07-15T02:00:00.000Z",
        randomBytes: (size) => Uint8Array.from(
          { length: size },
          (_, index) => (0x51 + index) & 0xff,
        ),
      },
    }).provision({
      tenantId: principal.tenant_id,
      actor: `${args.name}-provisioner`,
      operationId: `${args.name}-provision-operation`,
      profileRule: profile,
      taskFamily: CONFIRMATORY_TASK_FAMILY,
      experimentId: profile.experiment.experiment_id,
      experimentRevision: profile.experiment.revision,
    });
    assert.equal(provisioned.replayed, false);

    const marker = `AIONIS_${args.name.replaceAll("-", "_").toUpperCase()}_MARKER`;
    const memoryId = await observeMemory({
      app: fixture.app,
      headers,
      clientId: `memory:${args.name}`,
      title: `Eligible host ${args.name}`,
      text: `${marker} Preserve strict host feedback authority.`,
      confidence: args.confidence,
    });
    const packet = buildAionisMemoryPacket({
      tenant_id: principal.tenant_id,
      scope: principal.default_scope,
      query: { source: "text", intent: `eligible host ${args.name}` },
      nodes: [{
        id: memoryId,
        type: "concept",
        tier: "warm",
        title: `Eligible host ${args.name}`,
        text_summary: `${marker} Preserve strict host feedback authority.`,
        slots: {},
        confidence: args.confidence,
        salience: 0.85,
        created_at: "2026-07-15T02:01:00.000Z",
      }],
    });
    const collectionSource = profile.experiment.collection_sources[0];
    assert.ok(collectionSource);
    const taskSignature = `${args.name}-task-signature`;
    const repositorySignature = "aionis-runtime-focused";
    const envelope = {
      contract_version: "host_task_envelope_v1" as const,
      host_task_id: `${args.name}-host-task`,
      collector_id: collectionSource.collector_id,
      collector_version: collectionSource.collector_version,
      task_family: CONFIRMATORY_TASK_FAMILY,
      task_signature: taskSignature,
      repository_signature: repositorySignature,
      source_task_sha256: sha256(`${args.name}-source-task`),
      source_event_sha256: sha256(`${args.name}-source-event`),
      created_at: "2026-07-15T02:02:00.000Z",
    };
    const guideService = createProductGuideService({
      env: fixture.env,
      liteWriteStore: fixture.liteWriteStore,
      learningEpisodeLedgerAccess: fixture.learningEpisodeLedgerAccess,
      learningExperimentResolverRegistry: createConfirmatoryPassedRegistry(),
      admissionCandidatePolicyProfileRules: [profile],
      memoryWrite: createMemoryWriteRouteService({
        env: fixture.env,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore: fixture.liteWriteStore,
        executionStateStore: null,
      }),
    });
    const guideResult = await guideService.execute(ProductGuideRequest.parse({
      operation_id: `guide:${args.name}`,
      tenant_id: principal.tenant_id,
      scope: principal.default_scope,
      run_id: `run:${args.name}:guide`,
      consumer_agent_id: principal.agent_id,
      query_text: `${marker} status update memory`,
      context: {
        task_family: CONFIRMATORY_TASK_FAMILY,
        task_signature: taskSignature,
        repository_signature: repositorySignature,
      },
      host_task_envelope_v1: envelope,
      include_packets: true,
      limit: 8,
    }), {
      principal,
      planningContext: async () => ({
        tenant_id: principal.tenant_id,
        scope: principal.default_scope,
        recall: { aionis_memory_packet: packet },
      }),
      applyIdentity: (value) => value,
    });
    assert.equal(guideResult.ok, true, JSON.stringify(guideResult));
    const guide = guideResult.body as Record<string, any>;
    assert.ok(guide.agent_context.memory_ids.includes(memoryId));
    const exposure = fixture.runtimeDatabase.db.prepare(
      `SELECT event.event_id, event.episode_id, event.collection_class,
              event.collection_principal_sha256, event.host_task_envelope_sha256,
              event.collector_id, event.collector_version, item.served_action
       FROM lite_learning_episode_events AS event
       JOIN lite_learning_exposure_items AS item
         ON item.tenant_id = event.tenant_id
        AND item.scope = event.scope
        AND item.event_id = event.event_id
       WHERE event.event_kind = 'exposure_committed'
         AND event.source_id = ? AND item.memory_id = ?`,
    ).get(guide.guide_trace_id, memoryId) as {
      event_id: string;
      episode_id: string;
      collection_class: string;
      collection_principal_sha256: string;
      host_task_envelope_sha256: string;
      collector_id: string;
      collector_version: string;
      served_action: "use_now" | "inspect_before_use" | "do_not_use";
    } | undefined;
    assert.ok(exposure);
    assert.equal(exposure.collection_class, "eligible_host");
    return {
      ...fixture,
      principal,
      profile,
      headers,
      intruderHeaders,
      marker,
      memoryId,
      packet,
      collectionSource,
      taskSignature,
      repositorySignature,
      envelope,
      guideService,
      guide,
      exposure,
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

type EligibleHostFeedbackScenario = Awaited<ReturnType<typeof prepareEligibleHostFeedbackScenario>>;

test("feedback membership includes served surfaces when compact guide memory_ids is empty", () => {
  const served = guideExposureServedMemoryIds({
    memory_ids: [],
    use_now_memory_ids: ["memory-use-now"],
    inspect_before_use_memory_ids: ["memory-inspect"],
    do_not_use_memory_ids: ["memory-do-not-use"],
    rehydrate_memory_ids: ["memory-rehydrate"],
  });
  assert.deepEqual([...served], [
    "memory-use-now",
    "memory-inspect",
    "memory-do-not-use",
    "memory-rehydrate",
  ]);
});

function buildEligibleHostUseReceipt(args: {
  scenario: EligibleHostFeedbackScenario;
  operationId: string;
  runId: string;
  memoryId?: string;
  episodeId?: string;
  usedSurface?: "use_now" | "inspect_before_use" | "do_not_use";
  outcome?: "positive" | "negative" | "neutral";
  actionOutcome?: "accepted_completed" | "accepted_incomplete" | "rejected" | "not_applicable";
  verifierVersion?: string;
  verifierConfigSha256?: string;
}) {
  const verifier = args.scenario.collectionSource.allowed_verifiers[0];
  assert.ok(verifier);
  const body: HostUseReceiptV1Body = {
    contract_version: "host_use_receipt_v1",
    receipt_id: `receipt:${args.operationId}`,
    guide_trace_id: args.scenario.guide.guide_trace_id,
    episode_id: args.episodeId ?? args.scenario.exposure.episode_id,
    operation_id: args.operationId,
    run_id: args.runId,
    host_task_id: args.scenario.envelope.host_task_id,
    host_task_envelope_sha256: hostTaskEnvelopeDigest(args.scenario.envelope),
    collector_id: args.scenario.collectionSource.collector_id,
    collector_version: args.scenario.collectionSource.collector_version,
    host_trace_sha256: sha256(`host-trace:${args.operationId}`),
    observed_at: "2026-07-15T02:03:00.000Z",
    items: [{
      memory_id: args.memoryId ?? args.scenario.memoryId,
      used_surface: args.usedSurface ?? "use_now",
      outcome: args.outcome ?? "positive",
      action_outcome: args.actionOutcome ?? "accepted_completed",
      verifier_kind: verifier.kind,
      verifier_version: args.verifierVersion ?? verifier.version,
      verifier_config_sha256: args.verifierConfigSha256 ?? verifier.config_sha256,
      verifier_status: "passed",
      content_evidence_sha256: sha256(`content-evidence:${args.operationId}`),
      evidence_ref_sha256: sha256(`evidence-ref:${args.operationId}`),
    }],
  };
  return { ...body, receipt_sha256: hostUseReceiptDigest(body) };
}

async function observeMemory(args: {
  app: ReturnType<typeof Fastify>;
  clientId: string;
  title: string;
  text: string;
  confidence?: number;
  headers?: Record<string, string>;
}): Promise<string> {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/observe",
    headers: args.headers,
    payload: {
      tenant_id: "default",
      scope: "default",
      auto_embed: true,
      input_text: args.text,
      memory: {
        client_id: args.clientId,
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: args.title,
        text_summary: args.text,
        confidence: args.confidence ?? 0.84,
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().memory_write.nodes[0].id;
}

async function guideForMarker(args: {
  app: ReturnType<typeof Fastify>;
  marker: string;
  operationId?: string;
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/guide",
    payload: {
      ...(args.operationId ? { operation_id: args.operationId } : {}),
      tenant_id: "default",
      scope: "default",
      query_text: `${args.marker} status update memory`,
      consumer_agent_id: "local-user",
      limit: 8,
      include_packets: true,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

function productGuideTreeOperation(
  input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">,
): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-product-guide-execution-evidence",
    scope: "aionis://execution-tree/product-guide-execution-evidence",
    actor_role: "worker",
    ...input,
  } as ExecutionTreeOperationV1;
}

function buildProductGuideExecutionTree() {
  let tree = createExecutionTreeV1({
    tree_id: "tree-product-guide-execution-evidence",
    scope: "aionis://execution-tree/product-guide-execution-evidence",
    task_brief: "Use execution evidence context in the product guide.",
    at: "2026-06-09T00:00:00.000Z",
  });
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "grow",
    operation_id: "product-guide-grow-wrong",
    at: "2026-06-09T00:01:00.000Z",
    action: "Try formula A with duplicated tax.",
    observation: "Formula A fails validation because tax is double-counted.",
    title: "Wrong formula A",
    refs: ["trace://product-guide/formula-a/raw"],
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "compress",
    operation_id: "product-guide-compress-wrong",
    at: "2026-06-09T00:02:00.000Z",
    title: "Formula A rejected",
    summary: "Formula A double-counted tax and must not be reused.",
  }));
  const wrongSummaryNodeId = tree.current_summary_node_id;
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "maintain",
    operation_id: "product-guide-maintain-wrong",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: wrongSummaryNodeId,
    diagnostic_note: "Formula A is a failed branch.",
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "revise",
    operation_id: "product-guide-revise-wrong",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: wrongSummaryNodeId,
    diagnostic_note: "Return to the root and try a corrected formula.",
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "grow",
    operation_id: "product-guide-grow-passed",
    at: "2026-06-09T00:05:00.000Z",
    action: "Use formula B after removing duplicated tax.",
    observation: "Formula B matches all validation rows.",
    title: "Verified formula B",
    refs: ["trace://product-guide/formula-b/raw"],
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "compress",
    operation_id: "product-guide-compress-passed",
    at: "2026-06-09T00:06:00.000Z",
    title: "Verified formula B",
    summary: "Formula B computes subtotal + single tax + shipping.",
  }));
  tree = applyExecutionTreeOperationV1(tree, productGuideTreeOperation({
    type: "maintain",
    operation_id: "product-guide-maintain-passed",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: tree.current_summary_node_id,
    diagnostic_note: null,
  }));
  return tree;
}

test("memory feedback without a guide stays a legacy domain mutation and is not episode-attributed", async () => {
  const fixture = setupLearningProductApp({ name: "legacy-feedback-without-guide" });
  try {
    const memoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:legacy-feedback-without-guide",
      title: "Legacy feedback without guide",
      text: "AIONIS_LEGACY_NO_GUIDE_MARKER Keep this compatibility memory active.",
    });

    const feedback = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        tenant_id: "default",
        scope: "default",
        memory_ids: [memoryId],
        run_id: "run:legacy-feedback-without-guide",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "unknown",
        tool_status: "unknown",
        reason: "The legacy caller reused this memory but supplied no guide identity.",
      },
    });

    assert.equal(feedback.statusCode, 200, feedback.body);
    assert.equal(feedback.json().learning_attribution_status, "not_attributed");
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed'",
      ),
      0,
    );

    const { rows } = await fixture.liteWriteStore.findNodes({
      scope: "default",
      id: memoryId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_positive, 1);
    assert.equal(rows[0]?.slots.last_feedback_verifier_status, null);
    assert.equal(rows[0]?.slots.last_feedback_guide_trace_id, null);
    assert.equal(rows[0]?.slots.last_feedback_episode_id, null);
  } finally {
    await fixture.close();
  }
});

test("protected memory feedback replays one canonical mutation and rejects a changed retry", async () => {
  const fixture = setupLearningProductApp({ name: "protected-feedback-replay" });
  try {
    const marker = "AIONIS_PROTECTED_FEEDBACK_REPLAY_MARKER";
    const memoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:protected-feedback-replay",
      title: "Protected feedback replay memory",
      text: `${marker} Prefer one canonical feedback mutation.`,
    });
    const guide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:protected-feedback-replay",
    });
    assert.ok(guide.agent_context.memory_ids.includes(memoryId));
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        `SELECT COUNT(*) AS count
         FROM lite_learning_episode_events AS event
         JOIN lite_learning_exposure_items AS item
           ON item.tenant_id = event.tenant_id
          AND item.scope = event.scope
          AND item.event_id = event.event_id
         WHERE event.event_kind = 'exposure_committed'
           AND event.source_id = ? AND item.memory_id = ?`,
        guide.guide_trace_id,
        memoryId,
      ),
      1,
    );

    const operationId = "feedback:protected-replay:1";
    const payload = {
      operation_id: operationId,
      tenant_id: "default",
      scope: "default",
      guide_trace_id: guide.guide_trace_id,
      used_memory_ids: [memoryId],
      run_id: "run:protected-feedback-replay",
      outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      reason: "The protected host reused this memory successfully.",
    };
    const first = await fixture.app.inject({ method: "POST", url: "/v1/feedback", payload });
    assert.equal(first.statusCode, 200, first.body);
    const replay = await fixture.app.inject({ method: "POST", url: "/v1/feedback", payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());

    const { rows } = await fixture.liteWriteStore.findNodes({
      scope: "default",
      id: memoryId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_positive, 1);
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed' AND operation_id = ?",
        operationId,
      ),
      1,
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_id = ?",
        operationId,
      ),
      1,
    );

    const changed = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        ...payload,
        reason: "This changed retry must conflict with the canonical protected request.",
      },
    });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed' AND operation_id = ?",
        operationId,
      ),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("formal feedback requires an exact source exposure item, not only legacy guide-ledger membership", async () => {
  let planningPacket: ReturnType<typeof buildAionisMemoryPacket> | null = null;
  const planningContextService = {
    async assemble() {
      assert.ok(planningPacket);
      return {
        tenant_id: "default",
        scope: "default",
        recall: { aionis_memory_packet: planningPacket },
      };
    },
  } as MemoryPlanningContextService;
  const fixture = setupLearningProductApp({
    name: "formal-feedback-exposure-item-membership",
    planningContextService,
  });
  try {
    const marker = "AIONIS_FORMAL_EXPOSURE_ITEM_MEMBERSHIP_MARKER";
    const memoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:formal-exposure-item-membership",
      title: "Formal exposure item membership",
      text: `${marker} This real memory is duplicated in the planning packet.`,
    });
    const basePacket = buildAionisMemoryPacket({
      tenant_id: "default",
      scope: "default",
      query: { source: "text", intent: "formal feedback exposure item membership" },
      nodes: [{
        id: memoryId,
        type: "concept",
        tier: "warm",
        title: "Formal exposure item membership",
        text_summary: `${marker} This real memory is duplicated in the planning packet.`,
        slots: {},
        confidence: 0.84,
        salience: 0.8,
        created_at: "2026-07-15T00:00:00.000Z",
      }],
    });
    const entry = basePacket.relevant_memories[0];
    assert.ok(entry);
    planningPacket = {
      ...basePacket,
      relevant_memories: [entry, { ...entry }],
    };

    const guide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:formal-exposure-item-membership",
    });
    assert.ok(guide.agent_context.memory_ids.includes(memoryId));
    const exposure = fixture.runtimeDatabase.db.prepare(
      `SELECT event_id, episode_id, projection_complete
       FROM lite_learning_episode_events
       WHERE event_kind = 'exposure_committed' AND source_id = ?`,
    ).get(guide.guide_trace_id) as {
      event_id: string;
      episode_id: string;
      projection_complete: number;
    } | undefined;
    assert.ok(exposure);
    assert.equal(exposure.projection_complete, 0);
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_exposure_items WHERE event_id = ? AND memory_id = ?",
        exposure.event_id,
        memoryId,
      ),
      0,
    );

    const operationId = "feedback:formal-exposure-item-membership";
    const rejected = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        operation_id: operationId,
        tenant_id: "default",
        scope: "default",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [memoryId],
        run_id: "run:formal-exposure-item-membership",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        reason: "A legacy guide ledger alone must not authorize formal feedback attribution.",
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(String(rejected.json().error), /exposure|not_exposed/u);

    const { rows } = await fixture.liteWriteStore.findNodes({
      scope: "default",
      id: memoryId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_negative, undefined);
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE episode_id = ? AND event_kind = 'feedback_attributed'",
        exposure.episode_id,
      ),
      0,
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_id = ?",
        operationId,
      ),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("reported use_now against a served inspect exposure is boundary_ignored and the next exposure is exploit", async () => {
  const fixture = setupLearningProductApp({ name: "feedback-served-inspect-boundary" });
  try {
    const marker = "AIONIS_SERVED_INSPECT_BOUNDARY_MARKER";
    const memoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:served-inspect-boundary",
      title: "Served inspect boundary memory",
      text: `${marker} Low-confidence guidance must be inspected before use.`,
      confidence: 0.55,
    });
    const guide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:served-inspect-boundary:explore",
    });
    assert.ok(guide.agent_context.inspect_before_use_memory_ids.includes(memoryId));
    const originalItem = fixture.runtimeDatabase.db.prepare(
      `SELECT item.served_action, item.learning_track, event.episode_id
       FROM lite_learning_episode_events AS event
       JOIN lite_learning_exposure_items AS item
         ON item.tenant_id = event.tenant_id
        AND item.scope = event.scope
        AND item.event_id = event.event_id
       WHERE event.event_kind = 'exposure_committed'
         AND event.source_id = ? AND item.memory_id = ?`,
    ).get(guide.guide_trace_id, memoryId) as {
      served_action: string;
      learning_track: string;
      episode_id: string;
    } | undefined;
    assert.ok(originalItem);
    assert.equal(originalItem.served_action, "inspect_before_use");
    assert.equal(originalItem.learning_track, "explore");

    const feedbackOperationId = "feedback:served-inspect-boundary";
    const feedback = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        operation_id: feedbackOperationId,
        tenant_id: "default",
        scope: "default",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [memoryId],
        run_id: "run:served-inspect-boundary",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        runtime_signal_refs: ["verifier:served-inspect-boundary"],
        reason: "The host ignored the served inspect boundary and used the memory directly.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);

    const attribution = fixture.runtimeDatabase.db.prepare(
      `SELECT attribution.boundary_outcome, attribution.used_surface,
              attribution.exposure_action, attribution.evidence_class
       FROM lite_learning_feedback_attributions AS attribution
       JOIN lite_learning_episode_events AS event
         ON event.tenant_id = attribution.tenant_id
        AND event.scope = attribution.scope
        AND event.event_id = attribution.event_id
       WHERE event.operation_id = ? AND attribution.subject_id = ?`,
    ).get(feedbackOperationId, memoryId) as {
      boundary_outcome: string;
      used_surface: string;
      exposure_action: string;
      evidence_class: string;
    } | undefined;
    assert.ok(attribution);
    assert.deepEqual({ ...attribution }, {
      boundary_outcome: "boundary_ignored",
      used_surface: "use_now",
      exposure_action: "inspect_before_use",
      evidence_class: "legacy_unverified",
    });

    const { rows } = await fixture.liteWriteStore.findNodes({
      scope: "default",
      id: memoryId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.strong_counter_signal_count, 1);
    assert.equal(rows[0]?.slots.feedback_learning_control_posture, "inspect_before_use");
    assert.equal(rows[0]?.slots.last_feedback_guide_trace_id, guide.guide_trace_id);
    assert.equal(rows[0]?.slots.last_feedback_episode_id, originalItem.episode_id);

    const nextGuide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:served-inspect-boundary:exploit",
    });
    const nextItem = fixture.runtimeDatabase.db.prepare(
      `SELECT item.learning_track, item.track_reason
       FROM lite_learning_episode_events AS event
       JOIN lite_learning_exposure_items AS item
         ON item.tenant_id = event.tenant_id
        AND item.scope = event.scope
        AND item.event_id = event.event_id
       WHERE event.event_kind = 'exposure_committed'
         AND event.source_id = ? AND item.memory_id = ?`,
    ).get(nextGuide.guide_trace_id, memoryId) as {
      learning_track: string;
      track_reason: string;
    } | undefined;
    assert.ok(nextItem);
    assert.equal(nextItem.learning_track, "exploit");
    assert.equal(nextItem.track_reason, "prior_nonuse_control");
  } finally {
    await fixture.close();
  }
});

test("a post-attribution fault rolls back the boundary mutation, episode event, and protected receipt together", async () => {
  const fixture = setupLearningProductApp({ name: "feedback-boundary-atomic-fault" });
  const ledger = fixture.learningEpisodeLedgerAccess;
  const originalAppendEpisodeEvent = ledger.appendEpisodeEvent.bind(ledger);
  try {
    const marker = "AIONIS_FEEDBACK_BOUNDARY_ATOMIC_FAULT_MARKER";
    const memoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:feedback-boundary-atomic-fault",
      title: "Feedback boundary atomic fault",
      text: `${marker} Inspect this low-confidence memory before use.`,
      confidence: 0.55,
    });
    const guide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:feedback-boundary-atomic-fault",
    });
    assert.ok(guide.agent_context.inspect_before_use_memory_ids.includes(memoryId));

    const operationId = "feedback:boundary-atomic-fault";
    const payload = {
      operation_id: operationId,
      tenant_id: "default",
      scope: "default",
      guide_trace_id: guide.guide_trace_id,
      used_memory_ids: [memoryId],
      run_id: "run:feedback-boundary-atomic-fault",
      outcome: "negative",
      used_surface: "use_now",
      verifier_status: "failed",
      tool_status: "failed",
      reason: "The host crossed the served inspect boundary under a fault-injection test.",
    };
    const commitCountBefore = scalarCount(
      fixture.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_memory_commits",
    );
    ledger.appendEpisodeEvent = async (input) => {
      await originalAppendEpisodeEvent(input);
      throw new Error("feedback atomic fault after attribution append");
    };

    const failed = await fixture.app.inject({ method: "POST", url: "/v1/feedback", payload });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed' AND operation_id = ?",
        operationId,
      ),
      0,
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_id = ?",
        operationId,
      ),
      0,
    );
    assert.equal(
      scalarCount(fixture.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
      commitCountBefore,
    );
    const rolledBack = await fixture.liteWriteStore.findNodes({
      scope: "default",
      id: memoryId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rolledBack.rows[0]?.slots.feedback_negative, undefined);
    assert.equal(rolledBack.rows[0]?.slots.strong_counter_signal_count, undefined);
    assert.equal(rolledBack.rows[0]?.slots.feedback_learning_control_posture, undefined);

    ledger.appendEpisodeEvent = originalAppendEpisodeEvent;
    const retry = await fixture.app.inject({ method: "POST", url: "/v1/feedback", payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().learning_attribution_status, "legacy_unverified");
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed' AND operation_id = ?",
        operationId,
      ),
      1,
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_id = ?",
        operationId,
      ),
      1,
    );
    assert.equal(
      scalarCount(fixture.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
      commitCountBefore + 1,
    );
    const committed = await fixture.liteWriteStore.findNodes({
      scope: "default",
      id: memoryId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(committed.rows[0]?.slots.feedback_negative, 1);
    assert.equal(committed.rows[0]?.slots.strong_counter_signal_count, 1);
    assert.equal(committed.rows[0]?.slots.feedback_learning_control_posture, "inspect_before_use");
  } finally {
    ledger.appendEpisodeEvent = originalAppendEpisodeEvent;
    await fixture.close();
  }
});

test("eligible-host feedback without a host-use receipt remains legacy_unverified", async () => {
  const principal = eligibleHostPrincipal();
  const profile = eligibleHostDiagnosticProfile(principal);
  assert.ok(profile.experiment);
  const fixture = setupLearningProductApp({
    name: "eligible-host-feedback-without-receipt",
    admissionCandidatePolicyProfileRules: [profile],
  });
  try {
    const provisioned = await createLiteLearningExperimentProvisioner({
      database: fixture.runtimeDatabase,
      writeStore: fixture.liteWriteStore,
      ledger: fixture.learningEpisodeLedgerAccess,
      dependencies: {
        registry: createConfirmatoryPassedRegistry(),
        now: () => "2026-07-15T01:00:00.000Z",
        randomBytes: (size) => Uint8Array.from(
          { length: size },
          (_, index) => (0x31 + index) & 0xff,
        ),
      },
    }).provision({
      tenantId: "default",
      actor: "feedback-eligible-host-provisioner",
      operationId: "feedback-eligible-host-provision-operation",
      profileRule: profile,
      taskFamily: CONFIRMATORY_TASK_FAMILY,
      experimentId: profile.experiment.experiment_id,
      experimentRevision: profile.experiment.revision,
    });
    assert.equal(provisioned.replayed, false);
    assert.equal(provisioned.applicabilityManifest.evidence_intent, "integrity_only");

    const marker = "AIONIS_ELIGIBLE_HOST_NO_RECEIPT_MARKER";
    const memoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:eligible-host-no-receipt",
      title: "Eligible host feedback without receipt",
      text: `${marker} Preserve receipt authority boundaries.`,
      confidence: 0.9,
    });
    const packet = buildAionisMemoryPacket({
      tenant_id: "default",
      scope: "default",
      query: { source: "text", intent: "eligible host receipt boundary" },
      nodes: [{
        id: memoryId,
        type: "concept",
        tier: "warm",
        title: "Eligible host feedback without receipt",
        text_summary: `${marker} Preserve receipt authority boundaries.`,
        slots: {},
        confidence: 0.9,
        salience: 0.85,
        created_at: "2026-07-15T01:01:00.000Z",
      }],
    });
    const collectionSource = profile.experiment.collection_sources[0];
    assert.ok(collectionSource);
    const taskSignature = "eligible-host-no-receipt-task";
    const repositorySignature = "aionis-runtime-focused";
    const envelope = {
      contract_version: "host_task_envelope_v1" as const,
      host_task_id: "eligible-host-no-receipt-host-task",
      collector_id: collectionSource.collector_id,
      collector_version: collectionSource.collector_version,
      task_family: CONFIRMATORY_TASK_FAMILY,
      task_signature: taskSignature,
      repository_signature: repositorySignature,
      source_task_sha256: sha256("eligible-host-no-receipt-source-task"),
      source_event_sha256: sha256("eligible-host-no-receipt-source-event"),
      created_at: "2026-07-15T01:02:00.000Z",
    };
    const guideService = createProductGuideService({
      env: fixture.env,
      liteWriteStore: fixture.liteWriteStore,
      learningEpisodeLedgerAccess: fixture.learningEpisodeLedgerAccess,
      learningExperimentResolverRegistry: createConfirmatoryPassedRegistry(),
      admissionCandidatePolicyProfileRules: [profile],
      memoryWrite: createMemoryWriteRouteService({
        env: fixture.env,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore: fixture.liteWriteStore,
        executionStateStore: null,
      }),
    });
    const guideResult = await guideService.execute(ProductGuideRequest.parse({
      operation_id: "guide:eligible-host-no-receipt",
      tenant_id: "default",
      scope: "default",
      run_id: "run:eligible-host-no-receipt-guide",
      consumer_agent_id: principal.agent_id,
      query_text: `${marker} status update memory`,
      context: {
        task_family: CONFIRMATORY_TASK_FAMILY,
        task_signature: taskSignature,
        repository_signature: repositorySignature,
      },
      host_task_envelope_v1: envelope,
      include_packets: true,
      limit: 8,
    }), {
      principal,
      planningContext: async () => ({
        tenant_id: "default",
        scope: "default",
        recall: { aionis_memory_packet: packet },
      }),
      applyIdentity: (value) => value,
    });
    assert.equal(guideResult.ok, true, JSON.stringify(guideResult));
    const guide = guideResult.body as Record<string, any>;
    assert.ok(guide.agent_context.memory_ids.includes(memoryId));

    const exposure = fixture.runtimeDatabase.db.prepare(
      `SELECT event.event_id, event.episode_id, event.collection_class,
              event.collection_principal_sha256, item.memory_id
       FROM lite_learning_episode_events AS event
       JOIN lite_learning_exposure_items AS item
         ON item.tenant_id = event.tenant_id
        AND item.scope = event.scope
        AND item.event_id = event.event_id
       WHERE event.event_kind = 'exposure_committed'
         AND event.source_id = ? AND item.memory_id = ?`,
    ).get(guide.guide_trace_id, memoryId) as Record<string, unknown> | undefined;
    assert.ok(exposure);
    assert.equal(exposure.collection_class, "eligible_host");
    assert.equal(
      exposure.collection_principal_sha256,
      learningCollectionPrincipalSha256({
        tenant_id: principal.tenant_id,
        agent_id: principal.agent_id,
        team_id: principal.team_id,
      }),
    );

    const operationId = "feedback:eligible-host-no-receipt";
    const feedback = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        operation_id: operationId,
        tenant_id: "default",
        scope: "default",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [memoryId],
        run_id: "run:eligible-host-no-receipt-feedback",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "An eligible host claim without its strict receipt must remain unverified.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    assert.equal(feedback.json().learning_attribution_status, "legacy_unverified");
    assert.equal(feedback.json().learning_episode_id, exposure.episode_id);

    const attribution = fixture.runtimeDatabase.db.prepare(
      `SELECT event.collection_class, event.collection_principal_sha256,
              attribution.evidence_class,
              attribution.collection_principal_sha256 AS attribution_principal_sha256,
              attribution.host_use_receipt_id, attribution.verifier_status
       FROM lite_learning_episode_events AS event
       JOIN lite_learning_feedback_attributions AS attribution
         ON attribution.tenant_id = event.tenant_id
        AND attribution.scope = event.scope
        AND attribution.event_id = event.event_id
       WHERE event.event_kind = 'feedback_attributed'
         AND event.operation_id = ? AND attribution.subject_id = ?`,
    ).get(operationId, memoryId) as Record<string, unknown> | undefined;
    assert.ok(attribution);
    assert.equal(attribution.collection_class, "eligible_host");
    assert.equal(attribution.collection_principal_sha256, exposure.collection_principal_sha256);
    assert.equal(attribution.evidence_class, "legacy_unverified");
    assert.equal(attribution.attribution_principal_sha256, null);
    assert.equal(attribution.host_use_receipt_id, null);
    assert.equal(attribution.verifier_status, null);
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_host_use_receipts WHERE feedback_event_id IN (SELECT event_id FROM lite_learning_episode_events WHERE operation_id = ?)",
        operationId,
      ),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("strict host-use receipt persists verified evidence while receipt identity and verifier tampering roll back", async () => {
  const scenario = await prepareEligibleHostFeedbackScenario({
    name: "strict-host-receipt",
    confidence: 0.9,
  });
  try {
    assert.equal(scenario.exposure.served_action, "use_now");
    const assertRejectedWithoutMutation = async (args: {
      operationId: string;
      runId: string;
      receipt: Record<string, unknown>;
      usedMemoryIds: string[];
      expectedStatus: number;
      headers?: Record<string, string>;
      outcome?: "positive" | "negative" | "neutral";
      usedSurface?: "use_now" | "inspect_before_use" | "do_not_use";
    }) => {
      const beforeCommits = scalarCount(
        scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_memory_commits",
      );
      const beforeSlots = await slotsForMemory({
        liteWriteStore: scenario.liteWriteStore,
        memoryId: scenario.memoryId,
      });
      const rejected = await scenario.app.inject({
        method: "POST",
        url: "/v1/feedback",
        headers: args.headers ?? scenario.headers,
        payload: {
          operation_id: args.operationId,
          tenant_id: scenario.principal.tenant_id,
          scope: scenario.principal.default_scope,
          guide_trace_id: scenario.guide.guide_trace_id,
          used_memory_ids: args.usedMemoryIds,
          run_id: args.runId,
          outcome: args.outcome ?? "positive",
          used_surface: args.usedSurface ?? "use_now",
          verifier_status: "passed",
          tool_status: "succeeded",
          host_use_receipt_v1: args.receipt,
          reason: `Reject the ${args.operationId} strict receipt tamper before mutation.`,
        },
      });
      assert.equal(rejected.statusCode, args.expectedStatus, rejected.body);
      assert.equal(
        scalarCount(
          scenario.runtimeDatabase,
          "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed' AND operation_id = ?",
          args.operationId,
        ),
        0,
      );
      assert.equal(
        scalarCount(
          scenario.runtimeDatabase,
          "SELECT COUNT(*) AS count FROM lite_learning_host_use_receipts WHERE operation_id = ?",
          args.operationId,
        ),
        0,
      );
      assert.equal(
        scalarCount(
          scenario.runtimeDatabase,
          "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_id = ?",
          args.operationId,
        ),
        0,
      );
      assert.equal(
        scalarCount(scenario.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
        beforeCommits,
      );
      assert.deepEqual(
        { ...(await slotsForMemory({ liteWriteStore: scenario.liteWriteStore, memoryId: scenario.memoryId })) },
        { ...beforeSlots },
      );
    };
    const redigestReceipt = (
      receipt: ReturnType<typeof buildEligibleHostUseReceipt>,
      overrides: Partial<HostUseReceiptV1Body>,
    ) => {
      const { receipt_sha256: _receiptSha256, ...body } = receipt;
      const nextBody = { ...body, ...overrides } as HostUseReceiptV1Body;
      return { ...nextBody, receipt_sha256: hostUseReceiptDigest(nextBody) };
    };

    const receiptDigestOperation = "feedback:strict-receipt:digest-tamper";
    const receiptDigestRun = "run:strict-receipt:digest-tamper";
    const receiptDigestTamper = buildEligibleHostUseReceipt({
      scenario,
      operationId: receiptDigestOperation,
      runId: receiptDigestRun,
    });
    await assertRejectedWithoutMutation({
      operationId: receiptDigestOperation,
      runId: receiptDigestRun,
      receipt: { ...receiptDigestTamper, receipt_sha256: sha256("tampered-receipt-digest") },
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 400,
    });

    const episodeOperation = "feedback:strict-receipt:episode-tamper";
    const episodeRun = "run:strict-receipt:episode-tamper";
    await assertRejectedWithoutMutation({
      operationId: episodeOperation,
      runId: episodeRun,
      receipt: buildEligibleHostUseReceipt({
        scenario,
        operationId: episodeOperation,
        runId: episodeRun,
        episodeId: `lep_${"0".repeat(64)}`,
      }),
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 400,
    });

    const subjectOperation = "feedback:strict-receipt:subject-tamper";
    const subjectRun = "run:strict-receipt:subject-tamper";
    const forgedSubjectId = "memory-not-in-source-exposure";
    await assertRejectedWithoutMutation({
      operationId: subjectOperation,
      runId: subjectRun,
      receipt: buildEligibleHostUseReceipt({
        scenario,
        operationId: subjectOperation,
        runId: subjectRun,
        memoryId: forgedSubjectId,
      }),
      usedMemoryIds: [forgedSubjectId],
      expectedStatus: 400,
    });

    const duplicateSubjectOperation = "feedback:strict-receipt:duplicate-subject";
    const duplicateSubjectRun = "run:strict-receipt:duplicate-subject";
    await assertRejectedWithoutMutation({
      operationId: duplicateSubjectOperation,
      runId: duplicateSubjectRun,
      receipt: buildEligibleHostUseReceipt({
        scenario,
        operationId: duplicateSubjectOperation,
        runId: duplicateSubjectRun,
      }),
      usedMemoryIds: [scenario.memoryId, scenario.memoryId],
      expectedStatus: 400,
    });

    const principalOperation = "feedback:strict-receipt:principal-tamper";
    const principalRun = "run:strict-receipt:principal-tamper";
    await assertRejectedWithoutMutation({
      operationId: principalOperation,
      runId: principalRun,
      receipt: buildEligibleHostUseReceipt({
        scenario,
        operationId: principalOperation,
        runId: principalRun,
      }),
      usedMemoryIds: [scenario.memoryId],
      headers: scenario.intruderHeaders,
      expectedStatus: 400,
    });

    const collectorOperation = "feedback:strict-receipt:collector-tamper";
    const collectorRun = "run:strict-receipt:collector-tamper";
    const collectorReceipt = buildEligibleHostUseReceipt({
      scenario,
      operationId: collectorOperation,
      runId: collectorRun,
    });
    await assertRejectedWithoutMutation({
      operationId: collectorOperation,
      runId: collectorRun,
      receipt: redigestReceipt(collectorReceipt, { collector_id: "forged-host-collector" }),
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 403,
    });

    const taskOperation = "feedback:strict-receipt:task-tamper";
    const taskRun = "run:strict-receipt:task-tamper";
    const taskReceipt = buildEligibleHostUseReceipt({
      scenario,
      operationId: taskOperation,
      runId: taskRun,
    });
    await assertRejectedWithoutMutation({
      operationId: taskOperation,
      runId: taskRun,
      receipt: redigestReceipt(taskReceipt, { host_task_id: "forged-host-task" }),
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 403,
    });

    const surfaceOperation = "feedback:strict-receipt:surface-tamper";
    const surfaceRun = "run:strict-receipt:surface-tamper";
    await assertRejectedWithoutMutation({
      operationId: surfaceOperation,
      runId: surfaceRun,
      receipt: buildEligibleHostUseReceipt({
        scenario,
        operationId: surfaceOperation,
        runId: surfaceRun,
        usedSurface: "inspect_before_use",
      }),
      usedMemoryIds: [scenario.memoryId],
      usedSurface: "inspect_before_use",
      expectedStatus: 400,
    });

    const genericOperation = "feedback:strict-receipt:generic-assertion";
    const genericRun = "run:strict-receipt:generic-assertion";
    const genericReceipt = buildEligibleHostUseReceipt({
      scenario,
      operationId: genericOperation,
      runId: genericRun,
    });
    await assertRejectedWithoutMutation({
      operationId: genericOperation,
      runId: genericRun,
      receipt: {
        ...genericReceipt,
        items: [{ ...genericReceipt.items[0]!, used_surface: "explicit_host_assertion" }],
      },
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 400,
    });

    const evidenceOperation = "feedback:strict-receipt:evidence-tamper";
    const evidenceRun = "run:strict-receipt:evidence-tamper";
    const evidenceReceipt = buildEligibleHostUseReceipt({
      scenario,
      operationId: evidenceOperation,
      runId: evidenceRun,
    });
    await assertRejectedWithoutMutation({
      operationId: evidenceOperation,
      runId: evidenceRun,
      receipt: {
        ...evidenceReceipt,
        items: [{
          ...evidenceReceipt.items[0]!,
          content_evidence_sha256: sha256("tampered-content-evidence"),
        }],
      },
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 400,
    });

    const verifierOperation = "feedback:strict-receipt:verifier-tamper";
    const verifierRun = "run:strict-receipt:verifier-tamper";
    await assertRejectedWithoutMutation({
      operationId: verifierOperation,
      runId: verifierRun,
      receipt: buildEligibleHostUseReceipt({
        scenario,
        operationId: verifierOperation,
        runId: verifierRun,
        verifierVersion: "unregistered-verifier-v1",
        verifierConfigSha256: sha256("unregistered-verifier-config"),
      }),
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 400,
    });

    const operationId = "feedback:strict-receipt:verified";
    const runId = "run:strict-receipt:verified";
    const receipt = buildEligibleHostUseReceipt({ scenario, operationId, runId });
    const payload = {
      operation_id: operationId,
      tenant_id: scenario.principal.tenant_id,
      scope: scenario.principal.default_scope,
      guide_trace_id: scenario.guide.guide_trace_id,
      used_memory_ids: [scenario.memoryId],
      run_id: runId,
      outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: ["运行:完成", "signal:a", "évidence:host"],
      host_use_receipt_v1: receipt,
      reason: "Persist one verified host-use receipt with its exact exposure binding.",
    };
    const accepted = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().learning_attribution_status, "verified_host_receipt");
    assert.equal(accepted.json().learning_episode_id, scenario.exposure.episode_id);
    const replay = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), accepted.json());

    const committedCount = scalarCount(
      scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_memory_commits",
    );
    const committedSlots = await slotsForMemory({
      liteWriteStore: scenario.liteWriteStore,
      memoryId: scenario.memoryId,
    });
    const changedRetry = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload: {
        ...payload,
        reason: "A changed strict receipt retry must conflict with the protected request digest.",
      },
    });
    assert.equal(changedRetry.statusCode, 409, changedRetry.body);
    assert.equal(
      scalarCount(scenario.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
      committedCount,
    );
    assert.deepEqual(
      { ...(await slotsForMemory({ liteWriteStore: scenario.liteWriteStore, memoryId: scenario.memoryId })) },
      { ...committedSlots },
    );

    const reuseOperation = "feedback:strict-receipt:reuse";
    const reuseRun = "run:strict-receipt:reuse";
    const reuseReceipt = buildEligibleHostUseReceipt({
      scenario,
      operationId: reuseOperation,
      runId: reuseRun,
    });
    await assertRejectedWithoutMutation({
      operationId: reuseOperation,
      runId: reuseRun,
      receipt: redigestReceipt(reuseReceipt, { receipt_id: receipt.receipt_id }),
      usedMemoryIds: [scenario.memoryId],
      expectedStatus: 409,
    });

    const persisted = scenario.runtimeDatabase.db.prepare(
      `SELECT attribution.evidence_class, attribution.host_use_receipt_id,
              attribution.host_use_receipt_sha256,
              attribution.collection_principal_sha256,
              attribution.verifier_kind, attribution.verifier_version,
              attribution.verifier_config_sha256, attribution.verifier_status,
              receipt.episode_id, receipt.operation_id, receipt.run_id,
              receipt.receipt_sha256, receipt.receipt_payload_json
       FROM lite_learning_episode_events AS event
       JOIN lite_learning_feedback_attributions AS attribution
         ON attribution.tenant_id = event.tenant_id
        AND attribution.scope = event.scope
        AND attribution.event_id = event.event_id
       JOIN lite_learning_host_use_receipts AS receipt
         ON receipt.tenant_id = event.tenant_id
        AND receipt.scope = event.scope
        AND receipt.feedback_event_id = event.event_id
       WHERE event.event_kind = 'feedback_attributed'
         AND event.operation_id = ? AND attribution.subject_id = ?`,
    ).get(operationId, scenario.memoryId) as Record<string, unknown> | undefined;
    assert.ok(persisted);
    assert.equal(persisted.evidence_class, "verified_host_receipt");
    assert.equal(persisted.host_use_receipt_id, receipt.receipt_id);
    assert.equal(persisted.host_use_receipt_sha256, receipt.receipt_sha256);
    assert.equal(persisted.collection_principal_sha256, scenario.exposure.collection_principal_sha256);
    assert.equal(persisted.verifier_kind, receipt.items[0]!.verifier_kind);
    assert.equal(persisted.verifier_version, receipt.items[0]!.verifier_version);
    assert.equal(persisted.verifier_config_sha256, receipt.items[0]!.verifier_config_sha256);
    assert.equal(persisted.verifier_status, "passed");
    assert.equal(persisted.episode_id, scenario.exposure.episode_id);
    assert.equal(persisted.operation_id, operationId);
    assert.equal(persisted.run_id, runId);
    assert.equal(persisted.receipt_sha256, receipt.receipt_sha256);
    const { receipt_sha256: _receiptSha256, ...receiptBody } = receipt;
    assert.deepEqual(JSON.parse(String(persisted.receipt_payload_json)), receiptBody);
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed' AND operation_id = ?",
        operationId,
      ),
      1,
    );
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_host_use_receipts WHERE operation_id = ?",
        operationId,
      ),
      1,
    );
    assert.equal(
      (await slotsForMemory({ liteWriteStore: scenario.liteWriteStore, memoryId: scenario.memoryId }))
        .feedback_positive,
      1,
    );
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);
    const protectedOperation = scenario.runtimeDatabase.db.prepare(
      `SELECT receipt_json, commit_id FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
    ).get(operationId) as { receipt_json: string; commit_id: string } | undefined;
    assert.ok(protectedOperation);
    const protectedReceipt = JSON.parse(protectedOperation.receipt_json) as Record<string, any>;
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
    ).run(stableStringify({
      ...protectedReceipt,
      body: {
        ...protectedReceipt.body,
        result: { ...protectedReceipt.body.result, commit_id: "forged-feedback-commit" },
      },
    }), operationId);
    const forgedOperationReceipt = await verifyLiteRuntimeDatabase(scenario.dbPath);
    assert.equal(forgedOperationReceipt.ok, false);
    assert.equal(forgedOperationReceipt.integrity_findings.learning_episode_ledger_invalid, 1);
    assert.match(String(forgedOperationReceipt.learning.integrity_error), /feedback_operation_receipt/u);
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
    ).run(protectedOperation.receipt_json, operationId);
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);

    const originalAttribution = scenario.runtimeDatabase.db.prepare(
      `SELECT attribution.*
       FROM lite_learning_feedback_attributions AS attribution
       JOIN lite_learning_episode_events AS event
         ON event.tenant_id = attribution.tenant_id
        AND event.scope = attribution.scope
        AND event.event_id = attribution.event_id
       WHERE event.operation_id = ? AND attribution.subject_id = ?`,
    ).get(operationId, scenario.memoryId) as LiteLearningAuthorityRow | undefined;
    const originalFeedbackEvent = scenario.runtimeDatabase.db.prepare(
      `SELECT * FROM lite_learning_episode_events
       WHERE operation_id = ? AND event_kind = 'feedback_attributed'`,
    ).get(operationId) as LiteLearningAuthorityRow | undefined;
    assert.ok(originalAttribution);
    assert.ok(originalFeedbackEvent);
    const forgedAttribution: LiteLearningAuthorityRow = {
      ...originalAttribution,
      attribution_strength: "observed_feedback",
      item_sha256: "0".repeat(64),
    };
    forgedAttribution.item_sha256 = learningFeedbackAttributionItemDigest(forgedAttribution);
    const forgedItemSetSha256 = learningFeedbackAttributionSetDigest([forgedAttribution]);
    const forgedEvent = LearningEpisodeEventWithoutDigestSchema.parse({
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: originalFeedbackEvent.tenant_id,
      scope: originalFeedbackEvent.scope,
      event_id: originalFeedbackEvent.event_id,
      episode_id: originalFeedbackEvent.episode_id,
      episode_sequence: originalFeedbackEvent.episode_sequence,
      event_kind: originalFeedbackEvent.event_kind,
      source_kind: originalFeedbackEvent.source_kind,
      source_id: originalFeedbackEvent.source_id,
      source_sha256: originalFeedbackEvent.source_sha256,
      previous_event_sha256: originalFeedbackEvent.previous_event_sha256,
      payload_sha256: originalFeedbackEvent.payload_sha256,
      item_set_sha256: forgedItemSetSha256,
      source_commit_id: originalFeedbackEvent.source_commit_id,
      supersedes_event_id: originalFeedbackEvent.supersedes_event_id,
      operation_id: originalFeedbackEvent.operation_id,
      run_id: originalFeedbackEvent.run_id,
      collection_class: originalFeedbackEvent.collection_class,
      recorded_at: originalFeedbackEvent.recorded_at,
    });
    const forgedEventSha256 = learningEpisodeEventDigest(forgedEvent);
    mutateFeedbackAppendOnlyTables(scenario.runtimeDatabase, () => {
      scenario.runtimeDatabase.db.prepare(
        `UPDATE lite_learning_feedback_attributions
         SET attribution_strength = ?, item_sha256 = ?
         WHERE tenant_id = ? AND scope = ? AND event_id = ? AND subject_id = ?`,
      ).run(
        forgedAttribution.attribution_strength,
        forgedAttribution.item_sha256,
        originalAttribution.tenant_id,
        originalAttribution.scope,
        originalAttribution.event_id,
        originalAttribution.subject_id,
      );
      scenario.runtimeDatabase.db.prepare(
        `UPDATE lite_learning_episode_events
         SET item_set_sha256 = ?, event_sha256 = ?
         WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
      ).run(
        forgedItemSetSha256,
        forgedEventSha256,
        originalFeedbackEvent.tenant_id,
        originalFeedbackEvent.scope,
        originalFeedbackEvent.event_id,
      );
    });
    const forgedAttributionStrength = await verifyLiteRuntimeDatabase(scenario.dbPath);
    assert.equal(forgedAttributionStrength.ok, false);
    assert.equal(forgedAttributionStrength.integrity_findings.learning_episode_ledger_invalid, 1);
    assert.match(
      String(forgedAttributionStrength.learning.integrity_error),
      /feedback_attribution_strength_root|feedback_operation_receipt_attribution/u,
    );
    mutateFeedbackAppendOnlyTables(scenario.runtimeDatabase, () => {
      scenario.runtimeDatabase.db.prepare(
        `UPDATE lite_learning_feedback_attributions
         SET attribution_strength = ?, item_sha256 = ?
         WHERE tenant_id = ? AND scope = ? AND event_id = ? AND subject_id = ?`,
      ).run(
        originalAttribution.attribution_strength,
        originalAttribution.item_sha256,
        originalAttribution.tenant_id,
        originalAttribution.scope,
        originalAttribution.event_id,
        originalAttribution.subject_id,
      );
      scenario.runtimeDatabase.db.prepare(
        `UPDATE lite_learning_episode_events
         SET item_set_sha256 = ?, event_sha256 = ?
         WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
      ).run(
        originalFeedbackEvent.item_set_sha256,
        originalFeedbackEvent.event_sha256,
        originalFeedbackEvent.tenant_id,
        originalFeedbackEvent.scope,
        originalFeedbackEvent.event_id,
      );
    });
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);

    const sourceCommit = scenario.runtimeDatabase.db.prepare(
      "SELECT diff_json FROM lite_memory_commits WHERE id = ?",
    ).get(protectedOperation.commit_id) as { diff_json: string } | undefined;
    assert.ok(sourceCommit);
    const sourceDiff = JSON.parse(sourceCommit.diff_json) as Record<string, unknown>;
    scenario.runtimeDatabase.db.prepare(
      "UPDATE lite_memory_commits SET diff_json = ? WHERE id = ?",
    ).run(stableStringify({ ...sourceDiff, guide_trace_id: "forged-guide-trace" }), protectedOperation.commit_id);
    const forgedSourceCommit = await verifyLiteRuntimeDatabase(scenario.dbPath);
    assert.equal(forgedSourceCommit.ok, false);
    assert.equal(forgedSourceCommit.integrity_findings.learning_episode_ledger_invalid, 1);
    assert.match(String(forgedSourceCommit.learning.integrity_error), /feedback_source_commit/u);
    scenario.runtimeDatabase.db.prepare(
      "UPDATE lite_memory_commits SET diff_json = ? WHERE id = ?",
    ).run(sourceCommit.diff_json, protectedOperation.commit_id);
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);
  } finally {
    await scenario.close();
  }
});

test("eligible-host boundary feedback appends safety pause authority and restart verification fails closed on receipt tamper", async () => {
  const scenario = await prepareEligibleHostFeedbackScenario({
    name: "eligible-host-boundary-pause",
    confidence: 0.55,
  });
  const originalInsertWriteOperation = scenario.liteWriteStore.insertWriteOperation.bind(scenario.liteWriteStore);
  try {
    assert.equal(scenario.exposure.served_action, "inspect_before_use");
    const operationId = "feedback:eligible-host-boundary-pause";
    const runId = "run:eligible-host-boundary-pause";
    const payload = {
      operation_id: operationId,
      tenant_id: scenario.principal.tenant_id,
      scope: scenario.principal.default_scope,
      guide_trace_id: scenario.guide.guide_trace_id,
      used_memory_ids: [scenario.memoryId],
      run_id: runId,
      outcome: "negative",
      used_surface: "use_now",
      verifier_status: "failed",
      tool_status: "failed",
      runtime_signal_refs: ["runtime:eligible-host-boundary-pause"],
      reason: "Using a served inspect item directly requires an atomic safety pause.",
    };
    const before = {
      commits: scalarCount(scenario.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
      feedback: scalarCount(scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed'"),
      stops: scalarCount(scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_gate_decisions WHERE decision_kind = 'safety_stop'"),
      authorityReceipts: scalarCount(scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'learning_gate_authority_v1'"),
    };
    let internalAuthorityReceiptInserted = false;
    scenario.liteWriteStore.insertWriteOperation = async (args) => {
      if (args.operationKind === "learning_gate_authority_v1") {
        internalAuthorityReceiptInserted = true;
        return await originalInsertWriteOperation(args);
      }
      if (args.operationKind === "product_feedback_v1") {
        throw new Error("feedback fault after safety authority receipt");
      }
      return await originalInsertWriteOperation(args);
    };
    const failed = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload,
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(internalAuthorityReceiptInserted, true);
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_memory_commits"), before.commits);
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed'"), before.feedback);
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_learning_gate_decisions WHERE decision_kind = 'safety_stop'"), before.stops);
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'learning_gate_authority_v1'"), before.authorityReceipts);
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?",
      operationId), 0);
    const rolledBack = await scenario.liteWriteStore.findNodes({
      scope: scenario.principal.default_scope,
      id: scenario.memoryId,
      consumerAgentId: scenario.principal.agent_id,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rolledBack.rows[0]?.slots.feedback_negative, undefined);
    assert.equal(rolledBack.rows[0]?.slots.feedback_learning_control_posture, undefined);

    scenario.liteWriteStore.insertWriteOperation = originalInsertWriteOperation;
    const feedback = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload,
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    assert.equal(feedback.json().learning_attribution_status, "legacy_unverified");
    const feedbackEventId = feedback.json().learning_feedback_event_id;
    assert.equal(typeof feedbackEventId, "string");
    const attribution = scenario.runtimeDatabase.db.prepare(
      `SELECT boundary_outcome, evidence_class
       FROM lite_learning_feedback_attributions
       WHERE event_id = ? AND subject_id = ?`,
    ).get(feedbackEventId, scenario.memoryId) as Record<string, unknown> | undefined;
    assert.ok(attribution);
    assert.equal(attribution.boundary_outcome, "boundary_ignored");
    assert.equal(attribution.evidence_class, "legacy_unverified");

    const safety = scenario.runtimeDatabase.db.prepare(
      `SELECT decision_id, decision_sha256, decision_kind, evidence_verdict,
              authority_action, authority_operation_id,
              authority_operation_scope, authority_operation_kind,
              trigger_ref_id, trigger_episode_id, source_commit_id
       FROM lite_learning_gate_decisions
       WHERE trigger_ref_kind = 'episode_feedback' AND trigger_ref_id = ?`,
    ).get(feedbackEventId) as Record<string, unknown> | undefined;
    assert.ok(safety);
    assert.equal(safety.decision_kind, "safety_stop");
    assert.equal(safety.evidence_verdict, "pause_required");
    assert.equal(safety.authority_action, "pause");
    assert.equal(safety.authority_operation_kind, "learning_gate_authority_v1");
    assert.equal(safety.trigger_episode_id, scenario.exposure.episode_id);
    assert.notEqual(safety.authority_operation_id, operationId);
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?",
        operationId,
      ),
      1,
    );
    const authorityReceipt = scenario.runtimeDatabase.db.prepare(
      `SELECT scope, operation_kind, operation_id, request_sha256,
              receipt_json, commit_id
       FROM lite_runtime_write_operations
       WHERE operation_kind = 'learning_gate_authority_v1' AND operation_id = ?`,
    ).get(safety.authority_operation_id) as Record<string, unknown> | undefined;
    assert.ok(authorityReceipt);
    assert.equal(authorityReceipt.scope, safety.authority_operation_scope);
    assert.equal(authorityReceipt.operation_id, safety.authority_operation_id);
    assert.equal(authorityReceipt.commit_id, safety.source_commit_id);
    const authorityReceiptBody = JSON.parse(String(authorityReceipt.receipt_json));
    assert.equal(authorityReceiptBody.contract_version, "learning_safety_stop_operation_receipt_v1");
    assert.equal(authorityReceiptBody.operation_kind, "learning_gate_authority_v1");
    assert.equal(authorityReceiptBody.operation_id, safety.authority_operation_id);
    assert.equal(authorityReceiptBody.decision_id, safety.decision_id);
    assert.equal(authorityReceiptBody.decision_sha256, safety.decision_sha256);
    assert.equal(authorityReceiptBody.trigger_ref_id, feedbackEventId);
    assert.equal(authorityReceiptBody.source_commit_id, safety.source_commit_id);
    const replay = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), feedback.json());
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_learning_gate_decisions WHERE decision_kind = 'safety_stop'"), before.stops + 1);
    assert.equal(scalarCount(scenario.runtimeDatabase,
      "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'learning_gate_authority_v1'"),
    before.authorityReceipts + 1);

    const sourceBinding = scenario.runtimeDatabase.db.prepare(
      `SELECT memory_namespace_sha256, assignment_unit_sha256
       FROM lite_learning_episode_events
       WHERE event_id = ?`,
    ).get(scenario.exposure.event_id) as Record<string, unknown> | undefined;
    assert.ok(sourceBinding);
    const foldedAuthority = await scenario.learningEpisodeLedgerAccess.resolveGuideExperimentAuthority({
      tenantId: scenario.principal.tenant_id,
      experimentId: scenario.profile.experiment!.experiment_id,
      experimentRevision: scenario.profile.experiment!.revision,
      taskFamily: CONFIRMATORY_TASK_FAMILY,
      collectionPrincipalSha256: scenario.exposure.collection_principal_sha256,
      memoryNamespaceSha256: String(sourceBinding.memory_namespace_sha256),
      assignmentUnitSha256: String(sourceBinding.assignment_unit_sha256),
    });
    assert.equal(foldedAuthority.safety_pause_required, true);
    assert.ok(foldedAuthority.candidate_authority_actions.includes("pause"));

    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations
       SET receipt_json = ?
       WHERE operation_kind = 'learning_gate_authority_v1' AND operation_id = ?`,
    ).run("{}", safety.authority_operation_id);
    const tampered = await verifyLiteRuntimeDatabase(scenario.dbPath);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.integrity_findings.learning_episode_ledger_invalid, 1);
    assert.match(String(tampered.learning.integrity_error), /safety_stop|receipt/u);
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations
       SET receipt_json = ?
       WHERE operation_kind = 'learning_gate_authority_v1' AND operation_id = ?`,
    ).run(authorityReceipt.receipt_json, safety.authority_operation_id);
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations
       SET receipt_json = ?
       WHERE operation_kind = 'learning_gate_authority_v1' AND operation_id = ?`,
    ).run(
      JSON.stringify({ ...authorityReceiptBody, trigger_ref_kind: "control_job" }),
      safety.authority_operation_id,
    );
    const wrongTriggerKind = await verifyLiteRuntimeDatabase(scenario.dbPath);
    assert.equal(wrongTriggerKind.ok, false);
    assert.equal(wrongTriggerKind.integrity_findings.learning_episode_ledger_invalid, 1);
    assert.match(String(wrongTriggerKind.learning.integrity_error), /safety_stop|receipt/u);
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations
       SET receipt_json = ?
       WHERE operation_kind = 'learning_gate_authority_v1' AND operation_id = ?`,
    ).run(authorityReceipt.receipt_json, safety.authority_operation_id);
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);

    const nextEnvelope = {
      ...scenario.envelope,
      source_event_sha256: sha256("eligible-host-boundary-pause-next-source-event"),
      created_at: "2026-07-15T02:04:00.000Z",
    };
    const nextResult = await scenario.guideService.execute(ProductGuideRequest.parse({
      operation_id: "guide:eligible-host-boundary-pause:after-stop",
      tenant_id: scenario.principal.tenant_id,
      scope: scenario.principal.default_scope,
      run_id: "run:eligible-host-boundary-pause:after-stop",
      consumer_agent_id: scenario.principal.agent_id,
      query_text: `${scenario.marker} next status update memory`,
      context: {
        task_family: CONFIRMATORY_TASK_FAMILY,
        task_signature: scenario.taskSignature,
        repository_signature: scenario.repositorySignature,
      },
      host_task_envelope_v1: nextEnvelope,
      include_packets: true,
      limit: 8,
    }), {
      principal: scenario.principal,
      planningContext: async () => ({
        tenant_id: scenario.principal.tenant_id,
        scope: scenario.principal.default_scope,
        recall: { aionis_memory_packet: scenario.packet },
      }),
      applyIdentity: (value) => value,
    });
    assert.equal(nextResult.ok, true, JSON.stringify(nextResult));
    const nextGuide = nextResult.body as Record<string, any>;
    const policy = nextGuide.source_map.admission_candidate_policy;
    assert.equal(policy.serving_arm, "control");
    assert.equal(policy.promotion_eligible, false);
    assert.deepEqual(policy.reason_codes, ["candidate_implementation_paused"]);
    const nextExposure = scenario.runtimeDatabase.db.prepare(
      `SELECT served_arm, promotion_eligible
       FROM lite_learning_episode_events
       WHERE event_kind = 'exposure_committed' AND source_id = ?`,
    ).get(nextGuide.guide_trace_id) as Record<string, unknown> | undefined;
    assert.ok(nextExposure);
    assert.equal(nextExposure.served_arm, "control");
    assert.equal(nextExposure.promotion_eligible, 0);
  } finally {
    scenario.liteWriteStore.insertWriteOperation = originalInsertWriteOperation;
    await scenario.close();
  }
});

test("product guide projects execution evidence context into agent context by default", async () => {
  const { app } = setupProductApp("execution-evidence-guide-default");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "continue the verified formula branch",
        context: {
          goal: "continue the verified formula branch",
        },
        consumer_agent_id: "local-user",
        execution_tree_v1: buildProductGuideExecutionTree(),
        include_packets: true,
        limit: 8,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.agent_context.history_used, true);
    assert.equal(body.agent_context.authority, "advisory");
    assert.ok(body.agent_context.use_now.some((entry: string) =>
      entry.includes("Passed solution") && entry.includes("Formula B computes subtotal")
    ));
    assert.ok(body.agent_context.do_not_use.some((entry: string) =>
      entry.includes("Failed branch to avoid") && entry.includes("Formula A double-counted tax")
    ));
    assert.match(body.agent_context.prompt_text, /Passed solution/);
    assert.match(body.agent_context.prompt_text, /Formula B computes subtotal/);
    assert.match(body.agent_context.prompt_text, /do_not_use/);
    assert.match(body.agent_context.prompt_text, /Formula A double-counted tax/);
    assert.ok(body.guide_packet.source_map.internal_surfaces_used.includes("execution_evidence_context"));
    assert.ok(body.guide_packet.guide_brief.expected_product_effects.reduces_repeated_discovery);
    assert.ok(body.guide_packet.guide_brief.expected_product_effects.controls_negative_transfer);
  } finally {
    await app.close();
  }
});

async function activateFromGuide(args: {
  app: ReturnType<typeof Fastify>;
  guide: Record<string, any>;
  memoryId: string;
  runId: string;
  outcome: "positive" | "negative";
  usedSurface?: "use_now" | "explicit_host_assertion";
  verifierStatus?: "passed" | "failed" | "not_run" | "unknown";
  toolStatus?: "succeeded" | "failed" | "not_run" | "unknown";
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/forget",
    payload: {
      tenant_id: "default",
      scope: "default",
      operation: "activate",
      target: "memory",
      guide_trace_id: args.guide.guide_trace_id,
      used_memory_ids: [args.memoryId],
      run_id: args.runId,
      outcome: args.outcome,
      used_surface: args.usedSurface ?? "use_now",
      verifier_status: args.verifierStatus ?? (args.outcome === "positive" ? "passed" : "not_run"),
      tool_status: args.toolStatus ?? (args.outcome === "positive" ? "succeeded" : "unknown"),
      activate: true,
      reason: `Host attributed ${args.outcome} outcome to the memory used from this guide.`,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function measureTrace(args: {
  app: ReturnType<typeof Fastify>;
  beforeGuide: Record<string, any>;
  afterGuide: Record<string, any>;
  forgetResult: Record<string, any>;
  evidenceId: string;
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/measure",
    payload: {
      tenant_id: "default",
      scope: "default",
      product_trace: {
        before_guide: args.beforeGuide,
        after_guide: args.afterGuide,
        forget_result: args.forgetResult,
        sufficient_evidence: true,
        evidence_ids: [args.evidenceId],
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function slotsForMemory(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  memoryId: string;
}) {
  const { rows } = await args.liteWriteStore.findNodes({
    scope: "default",
    id: args.memoryId,
    consumerAgentId: "local-user",
    consumerTeamId: null,
    limit: 1,
    offset: 0,
  });
  assert.ok(rows[0], `missing memory ${args.memoryId}`);
  return rows[0].slots;
}

async function guideForToolSelection(args: {
  app: ReturnType<typeof Fastify>;
  runId: string;
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/guide",
    payload: {
      tenant_id: "default",
      scope: "default",
      run_id: args.runId,
      consumer_agent_id: "local-user",
      query_text: "Choose the safe tool for this verified continuation.",
      tool_candidates: ["read", "bash"],
      context: {
        agent_id: "local-user",
        task_kind: "product_tool_feedback",
        task_signature: "product-tool-feedback",
        goal: "Continue the verified operation with the selected tool.",
      },
      include_packets: true,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const guide = response.json();
  assert.ok(guide.tool_selection);
  assert.ok(guide.tool_selection.selected_tool);
  return guide;
}

function toolFeedbackPayload(guide: Record<string, any>) {
  return {
    feedback_kind: "tool_selection",
    tenant_id: guide.tenant_id,
    scope: guide.scope,
    guide_trace_id: guide.guide_trace_id,
    decision_id: guide.tool_selection.decision_id,
    run_id: guide.tool_selection.run_id,
    selected_tool: guide.tool_selection.selected_tool,
    candidates: guide.tool_selection.candidates,
    outcome: "positive",
    context: {
      agent_id: "local-user",
      task_kind: "product_tool_feedback",
      task_signature: "product-tool-feedback",
      goal: "Continue the verified operation with the selected tool.",
    },
    input_text: "The selected tool completed the verified action.",
  };
}

async function seedActiveToolFeedbackRule(liteWriteStore: ReturnType<typeof createLiteWriteStore>) {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: "Prefer read for the product tool feedback validation context.",
    auto_embed: false,
    memory_lane: "shared",
    nodes: [{
      client_id: "rule:product-tool-feedback:prefer-read",
      type: "rule",
      title: "Prefer read for product tool feedback",
      text_summary: "Use read for the product_tool_feedback task kind.",
      slots: {
        if: { task_kind: { $eq: "product_tool_feedback" } },
        then: { tool: { prefer: ["read"] } },
        exceptions: [],
        rule_scope: "global",
      },
    }],
    edges: [],
  }, "default", "default", {
    maxTextLen: 10_000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);
  const written = await liteWriteStore.withTx(() => applyMemoryWrite(prepared, {
    maxTextLen: 10_000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
    associativeLinkOrigin: "memory_write",
    write_access: liteWriteStore,
  }));
  const ruleNodeId = written.nodes[0]?.id;
  assert.ok(ruleNodeId);
  await liteWriteStore.withTx(() => updateRuleState({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    rule_node_id: ruleNodeId,
    state: "active",
    input_text: "Activate the product tool feedback rule.",
  }, "default", "default", { liteWriteStore }));
}

test("product feedback attributes tool learning to the persisted guide decision", async () => {
  const { app, liteWriteStore } = setupProductApp("product-tool-feedback");
  try {
    await seedActiveToolFeedbackRule(liteWriteStore);
    const guide = await guideForToolSelection({ app, runId: "run:product-tool-feedback" });
    const feedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: toolFeedbackPayload(guide),
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    const body = feedback.json();
    assert.equal(body.contract_version, "aionis_feedback_result_v1");
    assert.equal(body.product_action, "feedback");
    assert.equal(body.feedback_kind, "tool_selection");
    assert.deepEqual(body.tool_selection, guide.tool_selection);
    assert.equal(body.feedback_result.decision_id, guide.tool_selection.decision_id);
    assert.equal(body.feedback_result.updated_rules, 1);
    assert.equal(body.run_lifecycle.run_id, guide.tool_selection.run_id);
    assert.equal(body.run_lifecycle.lifecycle.status, "feedback_linked");
    assert.equal(body.run_lifecycle.feedback.total, 1);
    assert.deepEqual(body.source_map.routes_used, ["/v1/feedback"]);
    assert.ok(body.source_map.internal_surfaces_used.includes("guide_exposure_ledger"));
    assert.ok(body.source_map.internal_surfaces_used.includes("tool_feedback_service"));
    assert.ok(body.source_map.internal_surfaces_used.includes("learning_kernel"));
  } finally {
    await app.close();
  }
});

test("product feedback accepts the explicit memory discriminator without breaking legacy attribution", async () => {
  const { app, liteWriteStore } = setupProductApp("product-memory-feedback-discriminator");
  try {
    const marker = "AIONIS_MEMORY_FEEDBACK_DISCRIMINATOR";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:feedback-discriminator",
      title: "Memory feedback discriminator",
      text: `${marker} retain the verified compact status format.`,
    });
    const guide = await guideForMarker({ app, marker });
    const response = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        feedback_kind: "memory",
        tenant_id: "default",
        scope: "default",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [memoryId],
        run_id: "run:memory-feedback-discriminator",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "Host attributed a verified positive outcome to exposed memory.",
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await slotsForMemory({ liteWriteStore, memoryId })).feedback_positive, 1);
  } finally {
    await app.close();
  }
});

test("product tool feedback rejects forged guide and decision attribution without learning", async () => {
  const { app, liteWriteStore } = setupProductApp("product-tool-feedback-forgery");
  try {
    const guide = await guideForToolSelection({ app, runId: "run:product-tool-feedback-forgery" });
    const valid = toolFeedbackPayload(guide);
    const forgedPayloads = [
      { ...valid, guide_trace_id: "guide_trace:forged" },
      { ...valid, tenant_id: "forged-tenant" },
      { ...valid, scope: "forged-scope" },
      { ...valid, run_id: "run:forged" },
      { ...valid, decision_id: "decision:forged" },
      { ...valid, selected_tool: valid.selected_tool === "read" ? "bash" : "read" },
      { ...valid, candidates: [...valid.candidates].reverse() },
    ];

    for (const payload of forgedPayloads) {
      const response = await app.inject({ method: "POST", url: "/v1/feedback", payload });
      assert.ok([400, 404].includes(response.statusCode), response.body);
    }

    const feedbackRows = await liteWriteStore.listRuleFeedbackByRun({
      scope: "default",
      runId: guide.tool_selection.run_id,
      limit: 16,
    });
    assert.equal(feedbackRows.total, 0);
  } finally {
    await app.close();
  }
});

test("product feedback closed loop surfaces positive attribution in effect report", async () => {
  const { app, liteWriteStore } = setupProductApp("positive-feedback");
  try {
    const marker = "AIONIS_CLOSED_LOOP_POSITIVE";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-positive",
      title: "Closed loop positive memory",
      text: `${marker} use concise operator summaries for status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-positive",
      outcome: "positive",
    });
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_positive, 1);
    assert.equal(slots.last_feedback_outcome, "positive");

    const afterGuide = await guideForMarker({ app, marker });
    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-positive",
    });

    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.attributed_memory_ids, [memoryId]);
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.positive_attributed_memory_ids,
      [memoryId],
    );
    assert.deepEqual(measure.effect_report.feedback_signal_summary.positive_attributed_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.source, "memory_decision_audit");
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.ok(measure.effect_report.feedback_signal_summary.read_only_signal_memory_ids.includes(memoryId));
  } finally {
    await app.close();
  }
});

test("product feedback closed loop keeps single weak negative below downgrade threshold", async () => {
  const { app, liteWriteStore } = setupProductApp("single-weak-negative");
  try {
    const marker = "AIONIS_CLOSED_LOOP_SINGLE_WEAK";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-single-weak",
      title: "Closed loop single weak memory",
      text: `${marker} prefer compact release-note style status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-single-weak",
      outcome: "negative",
      verifierStatus: "not_run",
      toolStatus: "unknown",
    });
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_negative, 1);
    assert.equal(slots.weak_counter_signal_count, 1);
    assert.equal(slots.strong_counter_signal_count, 0);

    const afterGuide = await guideForMarker({ app, marker });
    assert.equal(afterGuide.agent_context.use_now_memory_ids.includes(memoryId), true);
    assert.equal(afterGuide.agent_context.inspect_before_use_memory_ids.includes(memoryId), false);

    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-single-weak",
    });
    const decision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === memoryId
    );
    assert.equal(decision.agent_surface, "use_now");
    assert.equal(decision.feedback_detail.threshold_state, "weak_below_threshold");
    assert.equal(decision.feedback_detail.threshold_met, false);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, []);
    assert.deepEqual(measure.effect_report.feedback_signal_summary.weak_counter_signal_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.equal(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary.present,
      false,
    );
  } finally {
    await app.close();
  }
});

test("product feedback closed loop moves single aligned failure to inspect-before-use", async () => {
  const { app, liteWriteStore } = setupProductApp("single-strong-negative");
  try {
    const marker = "AIONIS_CLOSED_LOOP_SINGLE_STRONG";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-single-strong",
      title: "Closed loop single strong memory",
      text: `${marker} prefer compact release-note style status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-single-strong",
      outcome: "negative",
      verifierStatus: "failed",
      toolStatus: "failed",
    });
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_negative, 1);
    assert.equal(slots.weak_counter_signal_count, 0);
    assert.equal(slots.strong_counter_signal_count, 1);
    assert.equal(slots.last_feedback_attribution_strength, "strong_counter_signal");

    const afterGuide = await guideForMarker({ app, marker });
    assert.equal(afterGuide.agent_context.use_now_memory_ids.includes(memoryId), false);
    assert.equal(afterGuide.agent_context.inspect_before_use_memory_ids.includes(memoryId), true);

    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-single-strong",
    });
    const decision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === memoryId
    );
    assert.equal(decision.agent_surface, "inspect_before_use");
    assert.equal(decision.feedback_detail.attribution_strength, "strong_counter_signal");
    assert.equal(decision.feedback_detail.threshold_state, "strong_signal_threshold_met");
    assert.equal(decision.feedback_detail.threshold_met, true);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.strong_counter_signal_memory_ids, [memoryId]);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, [memoryId]);
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_from_threshold_met_memory_ids,
      [memoryId],
    );
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_inspect_before_use_memory_ids,
      [memoryId],
    );
    assert.equal(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .authority_mutation,
      false,
    );
    assert.deepEqual(measure.effect_report.feedback_signal_summary.strong_counter_signal_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
  } finally {
    await app.close();
  }
});

test("product feedback closed loop rejects attribution to memory not exposed by the guide", async () => {
  const { app, liteWriteStore } = setupProductApp("reject-unexposed-attribution");
  try {
    const exposedMarker = "AIONIS_CLOSED_LOOP_EXPOSED";
    const unexposedMarker = "AIONIS_CLOSED_LOOP_UNEXPOSED";
    await observeMemory({
      app,
      clientId: "memory:closed-loop-exposed",
      title: "Closed loop exposed memory",
      text: `${exposedMarker} use concise operator summaries for status updates.`,
    });
    const guide = await guideForMarker({ app, marker: exposedMarker });
    const unexposedMemoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-unexposed",
      title: "Closed loop unexposed memory",
      text: `${unexposedMarker} use obsolete escalation owner names in status updates.`,
    });
    assert.equal(guide.agent_context.memory_ids.includes(unexposedMemoryId), false);

    const response = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [unexposedMemoryId],
        run_id: "run:closed-loop-unexposed-attribution",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "failed",
        activate: true,
        reason: "Host attempted to attribute guide outcome to memory that was not exposed.",
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "guide_trace_used_memory_not_exposed");

    const slots = await slotsForMemory({ liteWriteStore, memoryId: unexposedMemoryId });
    assert.equal(slots.feedback_negative, undefined);
    assert.equal(slots.strong_counter_signal_count, undefined);
  } finally {
    await app.close();
  }
});

test("product feedback closed loop moves repeated weak negative to inspect-before-use", async () => {
  const { app, liteWriteStore } = setupProductApp("repeated-weak-negative");
  try {
    const marker = "AIONIS_CLOSED_LOOP_REPEATED_WEAK";
    const memoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-repeated-weak",
      title: "Closed loop repeated weak memory",
      text: `${marker} prefer compact release-note style status updates.`,
    });
    const beforeGuide = await guideForMarker({ app, marker });
    assert.equal(beforeGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const firstFeedback = await activateFromGuide({
      app,
      guide: beforeGuide,
      memoryId,
      runId: "run:closed-loop-repeated-weak-1",
      outcome: "negative",
      verifierStatus: "not_run",
      toolStatus: "unknown",
    });
    const afterFirstGuide = await guideForMarker({ app, marker });
    assert.equal(afterFirstGuide.agent_context.use_now_memory_ids.includes(memoryId), true);

    const secondFeedback = await activateFromGuide({
      app,
      guide: afterFirstGuide,
      memoryId,
      runId: "run:closed-loop-repeated-weak-2",
      outcome: "negative",
      verifierStatus: "not_run",
      toolStatus: "unknown",
    });
    assert.equal(firstFeedback.forget_effect.affected_memory_ids.includes(memoryId), true);
    const slots = await slotsForMemory({ liteWriteStore, memoryId });
    assert.equal(slots.feedback_negative, 2);
    assert.equal(slots.weak_counter_signal_count, 2);

    const afterSecondGuide = await guideForMarker({ app, marker });
    assert.equal(afterSecondGuide.agent_context.use_now_memory_ids.includes(memoryId), false);
    assert.equal(afterSecondGuide.agent_context.inspect_before_use_memory_ids.includes(memoryId), true);

    const measure = await measureTrace({
      app,
      beforeGuide,
      afterGuide: afterSecondGuide,
      forgetResult: secondFeedback,
      evidenceId: "product_trace:closed-loop-repeated-weak",
    });
    const decision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === memoryId
    );
    assert.equal(decision.agent_surface, "inspect_before_use");
    assert.equal(decision.feedback_detail.threshold_state, "repeated_weak_threshold_met");
    assert.equal(decision.feedback_detail.threshold_met, true);
    assert.deepEqual(measure.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, [memoryId]);
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_from_threshold_met_memory_ids,
      [memoryId],
    );
    assert.deepEqual(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_inspect_before_use_memory_ids,
      [memoryId],
    );
    assert.deepEqual(measure.effect_report.feedback_signal_summary.weak_counter_signal_memory_ids, [memoryId]);
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
  } finally {
    await app.close();
  }
});

test("product feedback records repeated-unused evidence without synchronously mutating learning posture", async () => {
  const { app, liteWriteStore } = setupProductApp("repeated-unused-exposure");
  try {
    const marker = "AIONIS_CLOSED_LOOP_UNUSED";
    const usedMemoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-used",
      title: "Closed loop used memory",
      text: `${marker} use customer-facing severity labels in status updates.`,
      confidence: 0.88,
    });
    const unusedMemoryId = await observeMemory({
      app,
      clientId: "memory:closed-loop-unused",
      title: "Closed loop repeated unused memory",
      text: `${marker} include obsolete escalation owner names in status updates.`,
      confidence: 0.87,
    });

    const firstGuide = await guideForMarker({ app, marker });
    assert.equal(firstGuide.agent_context.memory_ids.includes(usedMemoryId), true);
    assert.equal(firstGuide.agent_context.memory_ids.includes(unusedMemoryId), true);

    const secondGuide = await guideForMarker({ app, marker });
    assert.equal(secondGuide.agent_context.memory_ids.includes(usedMemoryId), true);
    assert.equal(secondGuide.agent_context.memory_ids.includes(unusedMemoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: secondGuide,
      memoryId: usedMemoryId,
      runId: "run:closed-loop-unused-exposure",
      outcome: "positive",
    });
    const unusedObservation = feedback.forget_effect.guide_trace.unused_exposure_observation;
    assert.equal(unusedObservation.mode, "read_only_measure");
    assert.equal(unusedObservation.exposure_threshold, 2);
    assert.equal(unusedObservation.guide_trace_count, 2);
    assert.equal(unusedObservation.tracked_memory_count, 2);
    assert.ok(unusedObservation.repeated_unattributed_memory_ids.includes(unusedMemoryId));
    assert.ok(
      unusedObservation.repeated_unattributed_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(
      feedback.forget_effect.guide_trace.feedback_learning_control,
      undefined,
      "Steps 1-3 must not perform the Step 4 queue consumer's posture mutation inside the feedback transaction",
    );
    const unusedStats = unusedObservation.memory_stats.find((entry: Record<string, any>) =>
      entry.memory_id === unusedMemoryId
    );
    assert.equal(unusedStats.current_unattributed, true);
    assert.equal(unusedStats.exposure_count, 2);
    assert.equal(unusedStats.use_now_exposure_count, 2);
    assert.equal(unusedStats.positive_attributed_use_count, 0);
    assert.equal(unusedStats.repeated_without_positive_attribution, true);

    const unusedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(unusedSlots.feedback_negative, undefined);
    assert.equal(unusedSlots.weak_counter_signal_count, undefined);
    assert.equal(unusedSlots.feedback_learning_control_posture, undefined);
    assert.equal(unusedSlots.feedback_learning_control_source, undefined);
    assert.equal(unusedSlots.repeated_unused_without_positive_observation_count, undefined);

    const afterGuide = await guideForMarker({ app, marker });
    assert.equal(afterGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(afterGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), false);
    const unusedAfterMemory = afterGuide.memory_packet.relevant_memories.find((entry: Record<string, any>) =>
      entry.memory_id === unusedMemoryId
    );
    assert.notEqual(unusedAfterMemory.lifecycle_state, "candidate");
    assert.notEqual(unusedAfterMemory.authority, "candidate");

    const measure = await measureTrace({
      app,
      beforeGuide: firstGuide,
      afterGuide,
      forgetResult: feedback,
      evidenceId: "product_trace:closed-loop-unused-exposure",
    });
    assert.ok(measure.memory_decision_trace.feedback_attribution.unattributed_recalled_memory_ids.includes(unusedMemoryId));
    assert.ok(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.repeated_unattributed_memory_ids.includes(
        unusedMemoryId,
      ),
    );
    assert.ok(measure.effect_report.feedback_signal_summary.repeated_unattributed_memory_ids.includes(unusedMemoryId));
    assert.ok(
      measure.effect_report.feedback_signal_summary.repeated_unattributed_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(measure.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.ok(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_from_repeated_unused_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.ok(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .candidate_inspect_before_use_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(
      measure.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
        .authority_mutation,
      false,
    );
    const unusedDecision = measure.memory_decision_trace.memory_decisions.find((entry: Record<string, any>) =>
      entry.memory_id === unusedMemoryId
    );
    assert.equal(unusedDecision.agent_surface, "use_now");
    assert.equal(unusedDecision.feedback_detail, null);

    await activateFromGuide({
      app,
      guide: afterGuide,
      memoryId: unusedMemoryId,
      runId: "run:closed-loop-unused-exposure-revalidated",
      outcome: "positive",
      usedSurface: "explicit_host_assertion",
    });
    const revalidatedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(revalidatedSlots.positive_attributed_use_count, 1);
    assert.equal(revalidatedSlots.feedback_learning_control_posture, undefined);
    assert.equal(revalidatedSlots.feedback_learning_control_cleared_reason, "positive_attribution");

    const revalidatedGuide = await guideForMarker({ app, marker });
    assert.equal(revalidatedGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(revalidatedGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), false);
  } finally {
    await app.close();
  }
});

test("product guide leaves repeated-unused posture unchanged until the Step 4 queue is consumed", async () => {
  const { app, liteWriteStore } = setupProductApp("persisted-repeated-unused-exposure");
  try {
    const marker = "AIONIS_ACTIVE_REPEATED_UNUSED";
    const usedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-closed-loop-used",
      title: "Active closed loop used memory",
      text: `${marker} use customer-facing severity labels in status updates.`,
      confidence: 0.88,
    });
    const unusedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-closed-loop-unused",
      title: "Active closed loop repeated unused memory",
      text: `${marker} include obsolete escalation owner names in status updates.`,
      confidence: 0.87,
    });

    const firstGuide = await guideForMarker({ app, marker });
    assert.equal(firstGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(firstGuide.source_map.internal_surfaces_used.includes("inspect_before_use_active_projection"), false);

    const secondGuide = await guideForMarker({ app, marker });
    assert.equal(secondGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: secondGuide,
      memoryId: usedMemoryId,
      runId: "run:active-closed-loop-unused-exposure",
      outcome: "positive",
    });

    const thirdGuide = await guideForMarker({ app, marker });
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.ok(
      feedback.forget_effect.guide_trace.unused_exposure_observation
        .repeated_unattributed_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(feedback.forget_effect.guide_trace.feedback_learning_control, undefined);
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(thirdGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), false);
    assert.equal(
      thirdGuide.source_map.internal_surfaces_used.includes("inspect_before_use_active_projection"),
      false,
    );
    assert.equal(thirdGuide.agent_context.prompt_text.includes("inspect_before_use_shadow_delta"), false);
    assert.equal(thirdGuide.agent_context.prompt_text.includes("confidence_decay"), false);

    const unusedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(unusedSlots.feedback_negative, undefined);
    assert.equal(unusedSlots.weak_counter_signal_count, undefined);
    assert.equal(unusedSlots.strong_counter_signal_count, undefined);
    assert.equal(unusedSlots.positive_attributed_use_count, undefined);
    assert.equal(unusedSlots.feedback_learning_control_posture, undefined);
  } finally {
    await app.close();
  }
});

test("negative attributed use does not synchronously turn a different repeated-unused memory into posture", async () => {
  const { app, liteWriteStore } = setupProductApp("persisted-repeated-unused-negative-used-boundary");
  try {
    const marker = "AIONIS_ACTIVE_REPEATED_UNUSED_NEGATIVE_USED";
    const usedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-negative-used-boundary",
      title: "Active negative attributed used memory",
      text: `${marker} use customer-facing severity labels in status updates.`,
      confidence: 0.88,
    });
    const unusedMemoryId = await observeMemory({
      app,
      clientId: "memory:active-negative-unused-boundary",
      title: "Active negative boundary repeated unused memory",
      text: `${marker} include obsolete escalation owner names in status updates.`,
      confidence: 0.87,
    });

    const firstGuide = await guideForMarker({ app, marker });
    assert.equal(firstGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.equal(firstGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);

    const secondGuide = await guideForMarker({ app, marker });
    assert.equal(secondGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.equal(secondGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);

    const feedback = await activateFromGuide({
      app,
      guide: firstGuide,
      memoryId: usedMemoryId,
      runId: "run:active-repeated-unused-negative-used-boundary",
      outcome: "negative",
    });

    const thirdGuide = await guideForMarker({ app, marker });
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(usedMemoryId), true);
    assert.ok(
      feedback.forget_effect.guide_trace.unused_exposure_observation
        .repeated_unattributed_without_positive_memory_ids.includes(unusedMemoryId),
    );
    assert.equal(feedback.forget_effect.guide_trace.feedback_learning_control, undefined);
    assert.equal(thirdGuide.agent_context.use_now_memory_ids.includes(unusedMemoryId), true);
    assert.equal(thirdGuide.agent_context.inspect_before_use_memory_ids.includes(unusedMemoryId), false);
    assert.equal(
      thirdGuide.source_map.internal_surfaces_used.includes("inspect_before_use_active_projection"),
      false,
    );

    const usedSlots = await slotsForMemory({ liteWriteStore, memoryId: usedMemoryId });
    assert.equal(usedSlots.feedback_negative, 1);
    assert.equal(usedSlots.attributed_use_count, 1);
    assert.equal(usedSlots.positive_attributed_use_count, 0);

    const unusedSlots = await slotsForMemory({ liteWriteStore, memoryId: unusedMemoryId });
    assert.equal(unusedSlots.feedback_negative, undefined);
    assert.equal(unusedSlots.attributed_use_count, undefined);
    assert.equal(unusedSlots.feedback_learning_control_posture, undefined);
  } finally {
    await app.close();
  }
});
