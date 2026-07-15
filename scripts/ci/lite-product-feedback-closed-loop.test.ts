import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { LearningMemoryNamespaceManifestV1Schema } from
  "../../src/memory/learning-experiment-provisioning.ts";
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
import {
  createLiteLearningControlJobAccess,
  type LiteLearningControlJobAccess,
} from "../../src/store/lite-learning-control-jobs.ts";
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
import {
  drainUnusedExposureLearningControlJobs,
  startUnusedExposureLearningControlWorker,
} from "../../src/jobs/unused-exposure-learning-control-worker.ts";
import type { AuthPrincipal } from "../../src/util/auth.ts";
import {
  CONFIRMATORY_TENANT_ID,
  CONFIRMATORY_TASK_FAMILY,
  createConfirmatoryNamespaceManifest,
  createConfirmatoryPassedRegistry,
  createConfirmatoryProfile,
  createConfirmatoryProvisionInput,
  provisionConfirmatoryFixture,
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
  learningControlJobAccess?: LiteLearningControlJobAccess | null;
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
      learningControlJobAccess: args.learningControlJobAccess ?? null,
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
  learningControlJobAccess?: LiteLearningControlJobAccess | null;
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
  const learningControlJobAccess = createLiteLearningControlJobAccess(runtimeDatabase);
  const liteRecallStore = createLiteRecallStore(dbPath);
  registerProductMemoryApp({
    app,
    env,
    guards,
    liteWriteStore,
    liteRecallStore,
    learningEpisodeLedgerAccess,
    learningControlJobAccess,
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
    learningControlJobAccess,
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

function eligibleHostConfirmatoryProfile(
  principal: AuthPrincipal,
): AionisAdmissionCandidatePolicyProfileRule {
  const base = createConfirmatoryProfile();
  assert.ok(base.experiment);
  const collectionSource = base.experiment.collection_sources[0];
  assert.ok(collectionSource);
  const [profile] = parseAdmissionCandidatePolicyProfileRules(stableStringify([{
    ...base,
    collection_sources: undefined,
    experiment: {
      ...base.experiment,
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
  includeUnusedMemory?: boolean;
  enrolled?: boolean;
}) {
  const namespaceManifest = args.enrolled
    ? LearningMemoryNamespaceManifestV1Schema.parse((() => {
      const base = createConfirmatoryNamespaceManifest();
      return {
        ...base,
        pairs: base.pairs.map((pair) => {
          const wave = pair.activation.activation_wave_index;
          const times = wave === 1
            ? ["2026-07-14T09:01:00.000Z", "2090-01-01T00:00:00.000Z", "2091-01-01T00:00:00.000Z"]
            : wave === 2
              ? ["2092-01-01T00:00:00.000Z", "2093-01-01T00:00:00.000Z", "2094-01-01T00:00:00.000Z"]
              : ["2095-01-01T00:00:00.000Z", "2096-01-01T00:00:00.000Z", "2097-01-01T00:00:00.000Z"];
          return {
            ...pair,
            activation: {
              ...pair.activation,
              activation_starts_at: times[0],
              index_window_ends_at: times[1],
              wave_analysis_at: times[2],
            },
          };
        }),
      };
    })())
    : null;
  const enrolledScope = namespaceManifest?.pairs[0]?.members[0]?.public_scope;
  if (args.enrolled && !enrolledScope) throw new Error("confirmatory namespace fixture is empty");
  const principal = args.enrolled
    ? {
      tenant_id: CONFIRMATORY_TENANT_ID,
      agent_id: "eligible-host-enrolled-agent",
      team_id: null,
      role: "verifier" as const,
      default_scope: enrolledScope!,
      allowed_scopes: [enrolledScope!],
      source: "api_key" as const,
    }
    : eligibleHostPrincipal();
  const profile = args.enrolled
    ? eligibleHostConfirmatoryProfile(principal)
    : eligibleHostDiagnosticProfile(principal);
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
      MEMORY_SCOPE: principal.default_scope,
      LITE_LOCAL_ACTOR_ID: principal.agent_id,
    },
    admissionCandidatePolicyProfileRules: [profile],
  });
  try {
    if (args.enrolled) {
      assert.ok(namespaceManifest);
      const provisioned = await provisionConfirmatoryFixture({
        database: fixture.runtimeDatabase,
        writeStore: fixture.liteWriteStore,
        close: fixture.close,
      }, {
        input: createConfirmatoryProvisionInput({
          tenantId: principal.tenant_id,
          actor: `${args.name}-provisioner`,
          operationId: `${args.name}-provision-operation`,
          profileRule: profile,
          taskFamily: CONFIRMATORY_TASK_FAMILY,
          experimentId: profile.experiment.experiment_id,
          experimentRevision: profile.experiment.revision,
          memoryNamespaceManifest: namespaceManifest,
        }),
      });
      assert.equal(provisioned.provisionResult.replayed, false);
    } else {
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
    }

    const marker = `AIONIS_${args.name.replaceAll("-", "_").toUpperCase()}_MARKER`;
    const memoryId = await observeMemory({
      app: fixture.app,
      headers,
      tenantId: principal.tenant_id,
      scope: principal.default_scope,
      clientId: `memory:${args.name}`,
      title: `Eligible host ${args.name}`,
      text: `${marker} Preserve strict host feedback authority.`,
      confidence: args.confidence,
    });
    const unusedMemoryId = args.includeUnusedMemory
      ? await observeMemory({
        app: fixture.app,
        headers,
        tenantId: principal.tenant_id,
        scope: principal.default_scope,
        clientId: `memory:${args.name}:unused`,
        title: `Eligible host ${args.name} unused`,
        text: `${marker} This second memory remains unused by the host.`,
        confidence: args.confidence,
      })
      : null;
    const packetNodes = [{
      id: memoryId,
      type: "concept" as const,
      tier: "warm" as const,
      title: `Eligible host ${args.name}`,
      text_summary: `${marker} Preserve strict host feedback authority.`,
      slots: {},
      confidence: args.confidence,
      salience: 0.85,
      created_at: "2026-07-15T02:01:00.000Z",
    }];
    if (unusedMemoryId) {
      packetNodes.push({
        id: unusedMemoryId,
        type: "concept",
        tier: "warm",
        title: `Eligible host ${args.name} unused`,
        text_summary: `${marker} This second memory remains unused by the host.`,
        slots: {},
        confidence: args.confidence,
        salience: 0.84,
        created_at: "2026-07-15T02:01:00.000Z",
      });
    }
    const packet = buildAionisMemoryPacket({
      tenant_id: principal.tenant_id,
      scope: principal.default_scope,
      query: { source: "text", intent: `eligible host ${args.name}` },
      nodes: packetNodes,
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
    if (unusedMemoryId) assert.ok(guide.agent_context.memory_ids.includes(unusedMemoryId));
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
      unusedMemoryId,
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
  tenantId?: string;
  scope?: string;
}): Promise<string> {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/observe",
    headers: args.headers,
    payload: {
      tenant_id: args.tenantId ?? "default",
      scope: args.scope ?? "default",
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
    const feedbackSource = await fixture.liteWriteStore.withTx(() =>
      fixture.learningEpisodeLedgerAccess.resolveFeedbackSource({
        tenantId: "default",
        scope: "default",
        guideTraceId: guide.guide_trace_id,
      })
    );
    assert.ok(feedbackSource);
    assert.deepEqual(guide.feedback_attribution_v1, {
      contract_version: "aionis_guide_feedback_attribution_v1",
      status: "available",
      guide_trace_id: guide.guide_trace_id,
      episode_id: feedbackSource.event.episode_id,
      exposure_event_id: feedbackSource.event.event_id,
      item_set_sha256: feedbackSource.event.item_set_sha256,
      served_surface_sha256: feedbackSource.payload.served_surface_sha256,
      projection_complete: feedbackSource.payload.projection_complete,
      projection_incomplete_reason_codes:
        feedbackSource.payload.projection_incomplete_reason_codes,
      items: feedbackSource.items.map((item) => ({
        memory_id: item.memory_id,
        served_surface: item.served_action,
      })),
    });
    assert.equal(
      guide.feedback_attribution_v1.items.some(
        (item: { memory_id: string }) => item.memory_id === memoryId,
      ),
      true,
    );
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

test("formal feedback atomically enqueues one deterministic unused-exposure control job", async () => {
  const fixture = setupLearningProductApp({ name: "unused-exposure-control-enqueue" });
  try {
    const marker = "AIONIS_UNUSED_CONTROL_ENQUEUE_MARKER";
    const usedMemoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:unused-control:used",
      title: "Unused-control used memory",
      text: `${marker} The host will explicitly use this memory.`,
    });
    const unusedMemoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:unused-control:unused",
      title: "Unused-control unused memory",
      text: `${marker} The host will repeatedly leave this memory unused.`,
    });
    const firstGuide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:unused-control:first",
    });
    const secondGuide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:unused-control:second",
    });
    for (const guide of [firstGuide, secondGuide]) {
      assert.ok(guide.agent_context.memory_ids.includes(usedMemoryId));
      assert.ok(guide.agent_context.memory_ids.includes(unusedMemoryId));
    }

    const payload = {
      operation_id: "feedback:unused-control:enqueue",
      tenant_id: "default",
      scope: "default",
      guide_trace_id: secondGuide.guide_trace_id,
      used_memory_ids: [usedMemoryId],
      run_id: "run:unused-control:enqueue",
      outcome: "positive",
      used_surface: "use_now",
      verifier_status: "unknown",
      tool_status: "unknown",
      reason: "Use one memory and durably schedule maintenance for the other exposure.",
    };
    const beforeFault = {
      commits: scalarCount(fixture.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
      feedback: scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed'",
      ),
      operations: scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'product_feedback_v1'",
      ),
    };
    fixture.runtimeDatabase.db.exec(
      `CREATE TEMP TRIGGER reject_learning_control_enqueue
       BEFORE INSERT ON lite_learning_control_jobs
       BEGIN
         SELECT RAISE(ABORT, 'injected_learning_control_enqueue_failure');
       END`,
    );
    const enqueueFailed = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload,
    });
    assert.equal(enqueueFailed.statusCode, 500, enqueueFailed.body);
    assert.equal(
      scalarCount(fixture.runtimeDatabase, "SELECT COUNT(*) AS count FROM lite_memory_commits"),
      beforeFault.commits,
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'feedback_attributed'",
      ),
      beforeFault.feedback,
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'product_feedback_v1'",
      ),
      beforeFault.operations,
    );
    assert.equal((await fixture.learningControlJobAccess.listLearningControlJobs()).length, 0);
    fixture.runtimeDatabase.db.exec("DROP TRIGGER reject_learning_control_enqueue");

    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(
      accepted.json().forget_effect.guide_trace.feedback_learning_control,
      { learning_control_status: "queued" },
    );

    const jobs = await fixture.learningControlJobAccess.listLearningControlJobs();
    assert.equal(jobs.length, 1);
    const job = jobs[0]!;
    assert.equal(job.status, "pending");
    assert.equal(job.attempt_count, 0);
    assert.equal(job.source_feedback_event_id, accepted.json().learning_feedback_event_id);
    assert.deepEqual(JSON.parse(job.payload_json), {
      contract_version: "unused_exposure_learning_control_v1",
      exposure_ids: [fixture.runtimeDatabase.db.prepare(
        `SELECT event_id FROM lite_learning_episode_events
         WHERE tenant_id = 'default' AND scope = 'default'
           AND source_id = ? AND event_kind = 'exposure_committed'`,
      ).get(secondGuide.guide_trace_id)!.event_id],
      feedback_event_id: accepted.json().learning_feedback_event_id,
    });
    assert.equal(
      (await slotsForMemory({ liteWriteStore: fixture.liteWriteStore, memoryId: unusedMemoryId }))
        .feedback_learning_control_posture,
      undefined,
    );

    const replay = await fixture.app.inject({ method: "POST", url: "/v1/feedback", payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), accepted.json());
    assert.equal((await fixture.learningControlJobAccess.listLearningControlJobs()).length, 1);

    const firstClaimAt = new Date(new Date(job.created_at).getTime() + 1_000);
    const [firstClaim] = await fixture.learningControlJobAccess.claimLearningControlJobs({
      leaseOwner: "learning-control-test-worker-a",
      leaseMs: 1_000,
      limit: 1,
      now: firstClaimAt,
    });
    assert.ok(firstClaim);
    assert.equal(firstClaim.attempt_count, 1);
    assert.equal((await fixture.learningControlJobAccess.claimLearningControlJobs({
      leaseOwner: "learning-control-test-worker-b",
      leaseMs: 1_000,
      limit: 1,
      now: new Date(firstClaimAt.getTime() + 500),
    })).length, 0);
    const reclaimAt = new Date(firstClaimAt.getTime() + 1_001);
    const [reclaimed] = await fixture.learningControlJobAccess.claimLearningControlJobs({
      leaseOwner: "learning-control-test-worker-b",
      leaseMs: 1_000,
      limit: 1,
      now: reclaimAt,
    });
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempt_count, 2);
    const staleMutationAt = new Date(reclaimAt.getTime() + 1);
    const staleCompleted = await fixture.liteWriteStore.withTx(async () =>
      await fixture.learningControlJobAccess.completeLearningControlJobInTx({
        claim: firstClaim,
        resultCommitId: "stale-claim-result-commit",
        completedAt: staleMutationAt.toISOString(),
      })
    );
    assert.equal(staleCompleted, false);
    const staleDeadLetter = await fixture.liteWriteStore.withTx(async () =>
      await fixture.learningControlJobAccess.deadLetterLearningControlJobInTx({
        claim: firstClaim,
        errorCode: "stale_claim_must_not_dead_letter",
        completedAt: staleMutationAt.toISOString(),
      })
    );
    assert.equal(staleDeadLetter, false);
    assert.equal(await fixture.learningControlJobAccess.retryLearningControlJob({
      claim: firstClaim,
      errorCode: "stale_claim_must_not_retry",
      now: staleMutationAt,
      retryAt: new Date(staleMutationAt.getTime() + 1_000),
    }), "stale_claim");
    assert.equal(await fixture.learningControlJobAccess.retryLearningControlJob({
      claim: reclaimed,
      errorCode: "test_requeue_after_lease_reclaim",
      now: staleMutationAt,
      retryAt: new Date(staleMutationAt.getTime() + 1_000),
    }), "retried");

    const drained = await drainUnusedExposureLearningControlJobs({
      access: fixture.learningControlJobAccess,
      ledger: fixture.learningEpisodeLedgerAccess,
      writeStore: fixture.liteWriteStore,
      env: fixture.env,
      limit: 8,
      now: () => new Date(staleMutationAt.getTime() + 2_000),
    });
    assert.deepEqual(drained, {
      claimed: 1,
      completed: 1,
      no_op: 0,
      retried: 0,
      terminalization_deferred: 0,
      last_terminalization_error_code: null,
      dead_lettered: 0,
      safety_paused: 0,
      stale_claims: 0,
    });
    const completedJobs = await fixture.learningControlJobAccess.listLearningControlJobs();
    assert.equal(completedJobs[0]?.status, "completed");
    assert.ok(completedJobs[0]?.result_commit_id);
    assert.equal(
      (await slotsForMemory({ liteWriteStore: fixture.liteWriteStore, memoryId: unusedMemoryId }))
        .feedback_learning_control_posture,
      "inspect_before_use",
    );
    assert.equal(
      scalarCount(
        fixture.runtimeDatabase,
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind = 'unused_exposure_learning_control_v1'`,
      ),
      1,
    );
    const duplicateDrain = await drainUnusedExposureLearningControlJobs({
      access: fixture.learningControlJobAccess,
      ledger: fixture.learningEpisodeLedgerAccess,
      writeStore: fixture.liteWriteStore,
      env: fixture.env,
      limit: 8,
    });
    assert.equal(duplicateDrain.claimed, 0);
    const replayAfterCompletion = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload,
    });
    assert.equal(replayAfterCompletion.statusCode, 200, replayAfterCompletion.body);
    assert.deepEqual(replayAfterCompletion.json(), accepted.json());
    const verified = await verifyLiteRuntimeDatabase(fixture.dbPath);
    assert.equal(verified.ok, true);
  } finally {
    fixture.runtimeDatabase.db.exec("DROP TRIGGER IF EXISTS reject_learning_control_enqueue");
    await fixture.close();
  }
});

test("pre-Step4 protected markerless feedback reopens without a synthetic control job", async () => {
  const fixture = setupLearningProductApp({ name: "protected-markerless-feedback-compatibility" });
  let closed = false;
  try {
    const marker = "AIONIS_PROTECTED_MARKERLESS_COMPATIBILITY";
    const usedMemoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:protected-markerless:used",
      title: "Protected markerless used memory",
      text: `${marker} This memory is used by the historical protected response.`,
    });
    await observeMemory({
      app: fixture.app,
      clientId: "memory:protected-markerless:unused",
      title: "Protected markerless unused memory",
      text: `${marker} This memory remains unused in the historical response.`,
    });
    const guide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:protected-markerless",
    });
    const operationId = "feedback:protected-markerless";
    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        operation_id: operationId,
        tenant_id: "default",
        scope: "default",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [usedMemoryId],
        run_id: "run:protected-markerless",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "unknown",
        tool_status: "unknown",
        reason: "Create the current protected shape before projecting it to the pre-Step4 disk contract.",
      },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await fixture.learningControlJobAccess.listLearningControlJobs()).length, 1);
    const event = fixture.runtimeDatabase.db.prepare(
      `SELECT * FROM lite_learning_episode_events
       WHERE event_kind = 'feedback_attributed' AND operation_id = ?`,
    ).get(operationId) as Record<string, any> | undefined;
    const operation = fixture.runtimeDatabase.db.prepare(
      `SELECT receipt_json FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
    ).get(operationId) as { receipt_json: string } | undefined;
    assert.ok(event);
    assert.ok(operation);
    const currentPayload = JSON.parse(event.payload_json) as Record<string, any>;
    assert.equal(currentPayload.learning_control_queue_contract,
      "unused_exposure_learning_control_v1");
    assert.ok(currentPayload.unused_exposure_ids.length > 0);
    const { learning_control_queue_contract: _queueContract, ...markerlessPayloadBase } = currentPayload;
    const currentReceipt = JSON.parse(operation.receipt_json) as Record<string, any>;
    const currentEffect = currentReceipt.body.forget_effect as Record<string, any>;
    const currentGuideTrace = currentEffect.guide_trace as Record<string, any>;
    const { feedback_learning_control: _learningControl, ...historicalGuideTrace } = currentGuideTrace;
    const historicalReceiptJson = stableStringify({
      ...currentReceipt,
      body: {
        ...currentReceipt.body,
        forget_effect: {
          ...currentEffect,
          guide_trace: historicalGuideTrace,
        },
      },
    });
    const markerlessPayload = {
      ...markerlessPayloadBase,
      operation_receipt_sha256: sha256(historicalReceiptJson),
    };
    const markerlessPayloadJson = stableStringify(markerlessPayload);
    const markerlessPayloadSha256 = sha256(markerlessPayloadJson);
    const markerlessEvent = LearningEpisodeEventWithoutDigestSchema.parse({
      contract_version: "aionis_learning_episode_event_v1",
      tenant_id: event.tenant_id,
      scope: event.scope,
      event_id: event.event_id,
      episode_id: event.episode_id,
      episode_sequence: event.episode_sequence,
      event_kind: event.event_kind,
      source_kind: event.source_kind,
      source_id: event.source_id,
      source_sha256: event.source_sha256,
      previous_event_sha256: event.previous_event_sha256,
      payload_sha256: markerlessPayloadSha256,
      item_set_sha256: event.item_set_sha256,
      source_commit_id: event.source_commit_id,
      supersedes_event_id: event.supersedes_event_id,
      operation_id: event.operation_id,
      run_id: event.run_id,
      collection_class: event.collection_class,
      recorded_at: event.recorded_at,
    });
    fixture.runtimeDatabase.db.exec("BEGIN IMMEDIATE");
    try {
      fixture.runtimeDatabase.db.exec("DROP TRIGGER trg_lite_learning_episode_events_update");
      fixture.runtimeDatabase.db.exec("DROP TRIGGER trg_lite_learning_control_jobs_delete");
      fixture.runtimeDatabase.db.prepare(
        `UPDATE lite_runtime_write_operations SET receipt_json = ?
         WHERE operation_kind = 'product_feedback_v1' AND operation_id = ?`,
      ).run(historicalReceiptJson, operationId);
      fixture.runtimeDatabase.db.prepare(
        `UPDATE lite_learning_episode_events
         SET payload_sha256 = ?, payload_json = ?, event_sha256 = ?
         WHERE event_id = ?`,
      ).run(
        markerlessPayloadSha256,
        markerlessPayloadJson,
        learningEpisodeEventDigest(markerlessEvent),
        event.event_id,
      );
      fixture.runtimeDatabase.db.prepare(
        "DELETE FROM lite_learning_control_jobs WHERE source_feedback_event_id = ?",
      ).run(event.event_id);
      fixture.runtimeDatabase.db.exec(
        LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.trg_lite_learning_episode_events_update!.sql,
      );
      fixture.runtimeDatabase.db.exec(
        LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS.trg_lite_learning_control_jobs_delete!.sql,
      );
      fixture.runtimeDatabase.db.exec("COMMIT");
    } catch (error) {
      fixture.runtimeDatabase.db.exec("ROLLBACK");
      throw error;
    }
    assert.equal((await fixture.learningControlJobAccess.listLearningControlJobs()).length, 0);
    assert.equal((await verifyLiteRuntimeDatabase(fixture.dbPath)).ok, true);

    await fixture.close();
    closed = true;
    const reopened = createLiteRuntimeDatabase(fixture.dbPath);
    try {
      await createLiteLearningEpisodeLedgerAccess(reopened).verifyIntegrity();
      assert.equal((await createLiteLearningControlJobAccess(reopened).listLearningControlJobs()).length, 0);
    } finally {
      await reopened.close();
    }
  } finally {
    if (!closed) await fixture.close();
  }
});

test("learning-control resumes after enqueue restart and stays exact after post-commit process loss", async () => {
  const fixture = setupLearningProductApp({ name: "unused-exposure-control-process-loss" });
  let fixtureClosed = false;
  let reopenedDatabase: LiteRuntimeDatabase | null = null;
  let reopenedWriteStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    const marker = "AIONIS_UNUSED_CONTROL_PROCESS_LOSS_MARKER";
    const usedMemoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:unused-control:process-loss:used",
      title: "Process-loss used memory",
      text: `${marker} This memory is explicitly reused by the host.`,
    });
    const unusedMemoryId = await observeMemory({
      app: fixture.app,
      clientId: "memory:unused-control:process-loss:unused",
      title: "Process-loss unused memory",
      text: `${marker} This memory is repeatedly exposed but left unused.`,
    });
    await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:unused-control:process-loss:first",
    });
    const sourceGuide = await guideForMarker({
      app: fixture.app,
      marker,
      operationId: "guide:unused-control:process-loss:second",
    });
    assert.ok(sourceGuide.agent_context.memory_ids.includes(usedMemoryId));
    assert.ok(sourceGuide.agent_context.memory_ids.includes(unusedMemoryId));

    const feedback = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        operation_id: "feedback:unused-control:process-loss",
        tenant_id: "default",
        scope: "default",
        guide_trace_id: sourceGuide.guide_trace_id,
        used_memory_ids: [usedMemoryId],
        run_id: "run:unused-control:process-loss",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "unknown",
        tool_status: "unknown",
        reason: "Durably queue maintenance for the unused exposure before the process exits.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    assert.deepEqual(
      feedback.json().forget_effect.guide_trace.feedback_learning_control,
      { learning_control_status: "queued" },
    );
    const [queued] = await fixture.learningControlJobAccess.listLearningControlJobs();
    assert.ok(queued);
    assert.equal(queued.status, "pending");

    // Close the request-side Runtime first: the durable job must survive a real reopen
    // before any learning mutation has happened.
    await fixture.close();
    fixtureClosed = true;
    const childPath = fileURLToPath(new URL(
      "./support/learning-control-post-commit-crash-child.ts",
      import.meta.url,
    ));
    const claimCrashed = spawnSync(
      process.execPath,
      ["--import", "tsx", childPath, fixture.dbPath, "after_claim"],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(
      claimCrashed.status,
      74,
      `child status=${claimCrashed.status}\nstdout=${claimCrashed.stdout}\nstderr=${claimCrashed.stderr}`,
    );

    const claimDatabase = createLiteRuntimeDatabase(fixture.dbPath);
    const claimWriteStore = createLiteWriteStoreFromDatabase(claimDatabase, {
      annProjectionEnabled: false,
    });
    try {
      const claimAccess = createLiteLearningControlJobAccess(claimDatabase);
      const [leased] = await claimAccess.listLearningControlJobs();
      assert.ok(leased);
      assert.equal(leased.status, "leased");
      assert.equal(leased.attempt_count, 1);
      assert.ok(leased.lease_expires_at);
      assert.equal(
        scalarCount(
          claimDatabase,
          `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
           WHERE operation_kind = 'unused_exposure_learning_control_v1'`,
        ),
        0,
      );
      assert.equal(
        (await slotsForMemory({ liteWriteStore: claimWriteStore, memoryId: unusedMemoryId }))
          .feedback_learning_control_posture,
        undefined,
      );
      const beforeLeaseExpiry = new Date(new Date(leased.lease_expires_at).getTime() - 1);
      assert.equal((await claimAccess.claimLearningControlJobs({
        leaseOwner: "learning-control-before-expiry-probe",
        leaseMs: 1_000,
        limit: 1,
        now: beforeLeaseExpiry,
      })).length, 0);
    } finally {
      await claimWriteStore.close();
      await claimDatabase.close();
    }

    const completionCrashed = spawnSync(
      process.execPath,
      ["--import", "tsx", childPath, fixture.dbPath, "after_complete"],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(
      completionCrashed.status,
      75,
      `child status=${completionCrashed.status}\nstdout=${completionCrashed.stdout}\nstderr=${completionCrashed.stderr}`,
    );

    // The second child exits on the completion transaction's after-commit hook,
    // before drainOnce can observe success. Reopening must reveal one complete bundle.
    reopenedDatabase = createLiteRuntimeDatabase(fixture.dbPath);
    reopenedWriteStore = createLiteWriteStoreFromDatabase(reopenedDatabase, {
      annProjectionEnabled: false,
    });
    const reopenedAccess = createLiteLearningControlJobAccess(reopenedDatabase);
    const reopenedLedger = createLiteLearningEpisodeLedgerAccess(reopenedDatabase);
    const [completed] = await reopenedAccess.listLearningControlJobs();
    assert.ok(completed);
    assert.equal(completed.job_id, queued.job_id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.result_commit_id);
    assert.equal(
      scalarCount(
        reopenedDatabase,
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind = 'unused_exposure_learning_control_v1'
           AND operation_id = ?`,
        completed.operation_id,
      ),
      1,
    );
    assert.equal(
      (await slotsForMemory({ liteWriteStore: reopenedWriteStore, memoryId: unusedMemoryId }))
        .feedback_learning_control_posture,
      "inspect_before_use",
    );

    const duplicateDrain = await drainUnusedExposureLearningControlJobs({
      access: reopenedAccess,
      ledger: reopenedLedger,
      writeStore: reopenedWriteStore,
      env: fixture.env,
      limit: 8,
    });
    assert.equal(duplicateDrain.claimed, 0);
    assert.equal(
      scalarCount(
        reopenedDatabase,
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind = 'unused_exposure_learning_control_v1'
           AND operation_id = ?`,
        completed.operation_id,
      ),
      1,
    );
    assert.equal((await verifyLiteRuntimeDatabase(fixture.dbPath)).ok, true);

    const auditCommit = reopenedDatabase.db.prepare(
      "SELECT diff_json, commit_hash FROM lite_memory_commits WHERE id = ?",
    ).get(completed.result_commit_id) as { diff_json: string; commit_hash: string } | undefined;
    const auditOperation = reopenedDatabase.db.prepare(
      `SELECT receipt_json FROM lite_runtime_write_operations
       WHERE operation_kind = 'unused_exposure_learning_control_v1'
         AND operation_id = ?`,
    ).get(completed.operation_id) as { receipt_json: string } | undefined;
    assert.ok(auditCommit);
    assert.ok(auditOperation);
    const originalDiff = JSON.parse(auditCommit.diff_json) as Record<string, any>;
    const originalReceipt = JSON.parse(auditOperation.receipt_json) as Record<string, any>;
    reopenedDatabase.db.prepare(
      "UPDATE lite_memory_commits SET diff_json = ? WHERE id = ?",
    ).run(stableStringify({ ...originalDiff, reason: "forged learning-control reason" }), completed.result_commit_id);
    const forgedReason = await verifyLiteRuntimeDatabase(fixture.dbPath);
    assert.equal(forgedReason.ok, false);
    assert.match(String(forgedReason.learning.integrity_error), /learning_control_result_commit_binding/u);
    reopenedDatabase.db.prepare(
      "UPDATE lite_memory_commits SET diff_json = ? WHERE id = ?",
    ).run(auditCommit.diff_json, completed.result_commit_id);

    const outsiderMemoryId = "memory-outside-source-exposure";
    reopenedDatabase.db.prepare(
      "UPDATE lite_memory_commits SET diff_json = ? WHERE id = ?",
    ).run(stableStringify({
      ...originalDiff,
      requested_node_ids: [...originalDiff.requested_node_ids, outsiderMemoryId],
      resolved_node_ids: [...originalDiff.resolved_node_ids, outsiderMemoryId],
      applied_node_ids: [...originalDiff.applied_node_ids, outsiderMemoryId],
    }), completed.result_commit_id);
    reopenedDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE operation_kind = 'unused_exposure_learning_control_v1'
         AND operation_id = ?`,
    ).run(stableStringify({
      ...originalReceipt,
      changed_memory_ids: [...originalReceipt.changed_memory_ids, outsiderMemoryId],
    }), completed.operation_id);
    const forgedPartition = await verifyLiteRuntimeDatabase(fixture.dbPath);
    assert.equal(forgedPartition.ok, false);
    assert.match(String(forgedPartition.learning.integrity_error), /learning_control_result_commit_binding/u);
    reopenedDatabase.db.prepare(
      "UPDATE lite_memory_commits SET diff_json = ?, commit_hash = ? WHERE id = ?",
    ).run(auditCommit.diff_json, auditCommit.commit_hash, completed.result_commit_id);
    reopenedDatabase.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE operation_kind = 'unused_exposure_learning_control_v1'
         AND operation_id = ?`,
    ).run(auditOperation.receipt_json, completed.operation_id);
    assert.equal((await verifyLiteRuntimeDatabase(fixture.dbPath)).ok, true);
  } finally {
    if (reopenedWriteStore) await reopenedWriteStore.close();
    if (reopenedDatabase) await reopenedDatabase.close();
    if (!fixtureClosed) await fixture.close();
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
    const feedbackSource = await fixture.liteWriteStore.withTx(() =>
      fixture.learningEpisodeLedgerAccess.resolveFeedbackSource({
        tenantId: "default",
        scope: "default",
        guideTraceId: guide.guide_trace_id,
      })
    );
    assert.ok(feedbackSource);
    assert.equal(guide.feedback_attribution_v1.status, "available");
    assert.equal(guide.feedback_attribution_v1.exposure_event_id, exposure.event_id);
    assert.equal(guide.feedback_attribution_v1.episode_id, exposure.episode_id);
    assert.equal(guide.feedback_attribution_v1.item_set_sha256, feedbackSource.event.item_set_sha256);
    assert.equal(
      guide.feedback_attribution_v1.served_surface_sha256,
      feedbackSource.payload.served_surface_sha256,
    );
    assert.equal(guide.feedback_attribution_v1.projection_complete, false);
    assert.deepEqual(
      guide.feedback_attribution_v1.projection_incomplete_reason_codes,
      feedbackSource.payload.projection_incomplete_reason_codes,
    );
    assert.deepEqual(guide.feedback_attribution_v1.items, []);
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
    assert.equal(rejected.json().error, "guide_trace_used_memory_not_exposure_item");
    assert.deepEqual(rejected.json().details?.not_exposed_memory_ids, [memoryId]);

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

test("full-power continuity handoff remains context-only when it is absent from the persisted learning exposure", async () => {
  const planningContextService = {
    async assemble() {
      return {
        tenant_id: "default",
        scope: "default",
        recall: {},
      };
    },
  } as MemoryPlanningContextService;
  const fixture = setupLearningProductApp({
    name: "full-power-handoff-context-only-feedback",
    planningContextService,
  });
  try {
    const marker = "AIONIS_FULL_POWER_HANDOFF_CONTEXT_ONLY_MARKER";
    const taskFamily = "full_power_handoff_context_only";
    const taskSignature = "full-power-handoff-context-only-task";
    const observed = await fixture.app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        operation_id: "observe:full-power-handoff-context-only",
        tenant_id: "default",
        scope: "default",
        auto_embed: false,
        handoff: {
          actor: "local-user",
          producer_agent_id: "local-user",
          owner_agent_id: "local-user",
          memory_lane: "private",
          anchor: "full-power-handoff-context-only:run:local-user",
          handoff_kind: "task_handoff",
          task_family: taskFamily,
          task_signature: taskSignature,
          title: `Continuity handoff ${marker}`,
          summary: `${marker} must remain available to the next agent.`,
          handoff_text: `${marker} continue from the committed continuity state.`,
          target_files: ["README.md"],
          next_action: "Continue the continuity-only path.",
          acceptance_checks: ["handoff is visible without becoming a learning exposure item"],
        },
      },
    });
    assert.equal(observed.statusCode, 200, observed.body);
    const handoffMemoryId = observed.json().handoff?.handoff?.id;
    assert.equal(typeof handoffMemoryId, "string");

    const guideResponse = await fixture.app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        operation_id: "guide:full-power-handoff-context-only",
        tenant_id: "default",
        scope: "default",
        run_id: "run:full-power-handoff-context-only:guide",
        consumer_agent_id: "local-user",
        query_text: `${marker} continue`,
        mode: "full_power",
        context_mode: "compact_agent",
        context: {
          task_family: taskFamily,
          task_signature: taskSignature,
        },
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(guideResponse.statusCode, 200, guideResponse.body);
    const guide = guideResponse.json();
    assert.ok(guide.agent_context.use_now_memory_ids.includes(handoffMemoryId));
    assert.equal(guide.feedback_attribution_v1.status, "available");
    assert.equal(guide.feedback_attribution_v1.projection_complete, false);
    assert.ok(
      guide.feedback_attribution_v1.projection_incomplete_reason_codes.includes(
        "recorded_surface_item_omitted",
      ),
    );
    assert.equal(
      guide.feedback_attribution_v1.items.some(
        (item: { memory_id: string }) => item.memory_id === handoffMemoryId,
      ),
      false,
    );

    const operationId = "feedback:full-power-handoff-context-only";
    const rejected = await fixture.app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        operation_id: operationId,
        tenant_id: "default",
        scope: "default",
        guide_trace_id: guide.guide_trace_id,
        used_memory_ids: [handoffMemoryId],
        run_id: "run:full-power-handoff-context-only:feedback",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "Continuity visibility alone must not authorize formal learning feedback.",
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error, "guide_trace_used_memory_not_exposure_item");
    assert.deepEqual(rejected.json().details?.not_exposed_memory_ids, [handoffMemoryId]);
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

test("enrolled learning-control dead letter atomically pauses candidate authority and next guide", async () => {
  const scenario = await prepareEligibleHostFeedbackScenario({
    name: "eligible-host-control-dead-letter",
    confidence: 0.9,
    includeUnusedMemory: true,
    enrolled: true,
  });
  const sourceGuideReceipt = scenario.runtimeDatabase.db.prepare(
    `SELECT ledger_sha256 FROM lite_product_guide_receipts
     WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
  ).get(
    scenario.principal.tenant_id,
    scenario.principal.default_scope,
    scenario.guide.guide_trace_id,
  ) as { ledger_sha256: string } | undefined;
  assert.ok(sourceGuideReceipt);
  try {
    assert.ok(scenario.unusedMemoryId);
    assert.equal(scenario.exposure.served_action, "use_now");
    const enrollment = scenario.runtimeDatabase.db.prepare(
      `SELECT enrollment_state FROM lite_learning_episode_events
       WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
    ).get(
      scenario.principal.tenant_id,
      scenario.principal.default_scope,
      scenario.exposure.event_id,
    ) as { enrollment_state: string } | undefined;
    assert.equal(enrollment?.enrollment_state, "enrolled");

    const operationId = "feedback:eligible-host-control-dead-letter";
    const runId = "run:eligible-host-control-dead-letter";
    const receipt = buildEligibleHostUseReceipt({ scenario, operationId, runId });
    const accepted = await scenario.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: scenario.headers,
      payload: {
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
        host_use_receipt_v1: receipt,
        reason: "Use one enrolled exposure and durably queue control for the unused item.",
      },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().learning_attribution_status, "verified_host_receipt");
    assert.deepEqual(
      accepted.json().forget_effect.guide_trace.feedback_learning_control,
      { learning_control_status: "queued" },
    );
    const [queued] = await scenario.learningControlJobAccess.listLearningControlJobs();
    assert.ok(queued);
    assert.equal(queued.status, "pending");

    // Force a permanent, source-local validation failure. The dead-letter safety
    // bundle intentionally resolves authority from the immutable episode source,
    // so it does not depend on this corrupted operational guide receipt.
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_product_guide_receipts SET ledger_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).run(
      "0".repeat(64),
      scenario.principal.tenant_id,
      scenario.principal.default_scope,
      scenario.guide.guide_trace_id,
    );
    scenario.runtimeDatabase.db.exec(
      `CREATE TEMP TRIGGER reject_control_job_authority_receipt
       BEFORE INSERT ON lite_runtime_write_operations
       WHEN NEW.operation_kind = 'learning_gate_authority_v1'
       BEGIN
         SELECT RAISE(ABORT, 'injected_control_job_authority_receipt_failure');
       END`,
    );
    const firstDrainAt = new Date(new Date(queued.created_at).getTime() + 1_000);
    const rolledBack = await drainUnusedExposureLearningControlJobs({
      access: scenario.learningControlJobAccess,
      ledger: scenario.learningEpisodeLedgerAccess,
      writeStore: scenario.liteWriteStore,
      env: scenario.env,
      limit: 1,
      now: () => firstDrainAt,
    });
    assert.deepEqual(rolledBack, {
      claimed: 1,
      completed: 0,
      no_op: 0,
      retried: 1,
      terminalization_deferred: 0,
      last_terminalization_error_code: null,
      dead_lettered: 0,
      safety_paused: 0,
      stale_claims: 0,
    });
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind = 'unused_exposure_learning_control_v1'`,
      ),
      0,
    );
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        `SELECT COUNT(*) AS count FROM lite_learning_gate_decisions
         WHERE trigger_ref_kind = 'control_job' AND trigger_ref_id = ?`,
        queued.job_id,
      ),
      0,
    );
    const [retryable] = await scenario.learningControlJobAccess.listLearningControlJobs();
    assert.equal(retryable?.status, "pending");
    assert.equal(retryable?.attempt_count, 1);
    assert.equal(retryable?.last_error_code, "learning_control_guide_receipt_invalid");

    for (let attempt = 2; attempt <= 7; attempt += 1) {
      const retryAt = new Date(firstDrainAt.getTime() + attempt * 10 * 60_000);
      const retried = await drainUnusedExposureLearningControlJobs({
        access: scenario.learningControlJobAccess,
        ledger: scenario.learningEpisodeLedgerAccess,
        writeStore: scenario.liteWriteStore,
        env: scenario.env,
        limit: 1,
        now: () => retryAt,
      });
      assert.equal(retried.claimed, 1);
      assert.equal(retried.retried, 1);
      assert.equal(retried.terminalization_deferred, 0);
      const [pending] = await scenario.learningControlJobAccess.listLearningControlJobs();
      assert.equal(pending?.status, "pending");
      assert.equal(pending?.attempt_count, attempt);
      assert.equal(pending?.last_error_code, "learning_control_guide_receipt_invalid");
    }
    const exhaustedAttemptAt = new Date(firstDrainAt.getTime() + 80 * 60_000);
    const exhaustedWorker = startUnusedExposureLearningControlWorker({
      access: scenario.learningControlJobAccess,
      ledger: scenario.learningEpisodeLedgerAccess,
      writeStore: scenario.liteWriteStore,
      env: scenario.env,
      intervalMs: 60_000,
      batchSize: 1,
      now: () => exhaustedAttemptAt,
    });
    const deferred = await exhaustedWorker.drainOnce();
    assert.deepEqual(deferred, {
      claimed: 1,
      completed: 0,
      no_op: 0,
      retried: 0,
      terminalization_deferred: 1,
      last_terminalization_error_code: "learning_control_terminalization_safety_pause_failed",
      dead_lettered: 0,
      safety_paused: 0,
      stale_claims: 0,
    });
    const exhaustedHealth = exhaustedWorker.healthSnapshot();
    assert.equal(exhaustedHealth.closed, false);
    assert.equal(exhaustedHealth.last_error_code, null);
    assert.equal(exhaustedHealth.last_terminalization_error_code,
      "learning_control_terminalization_safety_pause_failed");
    assert.equal(exhaustedHealth.last_drain?.terminalization_deferred, 1);
    assert.equal(exhaustedHealth.backlog?.exhausted, 1);
    await exhaustedWorker.shutdown();
    assert.equal(exhaustedWorker.healthSnapshot().closed, true);
    const [exhausted] = await scenario.learningControlJobAccess.listLearningControlJobs();
    assert.equal(exhausted?.status, "leased");
    assert.equal(exhausted?.attempt_count, 8);
    assert.equal(exhausted?.last_error_code, "learning_control_guide_receipt_invalid");
    assert.ok(exhausted?.lease_expires_at);
    const exhaustedBacklog = await scenario.learningControlJobAccess.learningControlBacklogSnapshot(
      exhaustedAttemptAt,
    );
    assert.equal(exhaustedBacklog.exhausted, 1);
    assert.equal(exhaustedBacklog.dead_letter, 0);
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind IN ('unused_exposure_learning_control_v1', 'learning_gate_authority_v1')`,
      ),
      0,
    );
    assert.equal(
      scalarCount(
        scenario.runtimeDatabase,
        `SELECT COUNT(*) AS count FROM lite_learning_gate_decisions
         WHERE trigger_ref_kind = 'control_job' AND trigger_ref_id = ?`,
        queued.job_id,
      ),
      0,
    );

    scenario.runtimeDatabase.db.exec("DROP TRIGGER reject_control_job_authority_receipt");
    const terminalDrainAt = new Date(new Date(exhausted.lease_expires_at).getTime() + 1);
    const terminalized = await drainUnusedExposureLearningControlJobs({
      access: scenario.learningControlJobAccess,
      ledger: scenario.learningEpisodeLedgerAccess,
      writeStore: scenario.liteWriteStore,
      env: scenario.env,
      limit: 1,
      now: () => terminalDrainAt,
    });
    assert.deepEqual(terminalized, {
      claimed: 1,
      completed: 0,
      no_op: 0,
      retried: 0,
      terminalization_deferred: 0,
      last_terminalization_error_code: null,
      dead_lettered: 1,
      safety_paused: 1,
      stale_claims: 0,
    });

    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_product_guide_receipts SET ledger_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).run(
      sourceGuideReceipt.ledger_sha256,
      scenario.principal.tenant_id,
      scenario.principal.default_scope,
      scenario.guide.guide_trace_id,
    );
    const [deadLetter] = await scenario.learningControlJobAccess.listLearningControlJobs();
    assert.equal(deadLetter?.status, "dead_letter");
    assert.equal(deadLetter?.last_error_code, "learning_control_guide_receipt_invalid");
    const workerOperation = scenario.runtimeDatabase.db.prepare(
      `SELECT operation_id, receipt_json, commit_id
       FROM lite_runtime_write_operations
       WHERE operation_kind = 'unused_exposure_learning_control_v1'`,
    ).get() as { operation_id: string; receipt_json: string; commit_id: string } | undefined;
    assert.ok(workerOperation);
    assert.equal(workerOperation.operation_id, queued.operation_id);
    const workerReceipt = JSON.parse(workerOperation.receipt_json) as Record<string, unknown>;
    assert.equal(workerReceipt.status, "dead_letter");
    assert.equal(workerReceipt.job_id, queued.job_id);
    assert.equal(workerReceipt.result_commit_id, null);
    const safety = scenario.runtimeDatabase.db.prepare(
      `SELECT decision_id, authority_operation_id, authority_operation_kind,
              trigger_ref_id, trigger_episode_id, source_commit_id
       FROM lite_learning_gate_decisions
       WHERE trigger_ref_kind = 'control_job' AND trigger_ref_id = ?`,
    ).get(queued.job_id) as Record<string, unknown> | undefined;
    assert.ok(safety);
    assert.equal(safety.trigger_episode_id, scenario.exposure.episode_id);
    assert.equal(safety.authority_operation_kind, "learning_gate_authority_v1");
    assert.notEqual(safety.authority_operation_id, queued.operation_id);
    const authorityOperation = scenario.runtimeDatabase.db.prepare(
      `SELECT operation_id, receipt_json, commit_id
       FROM lite_runtime_write_operations
       WHERE operation_kind = 'learning_gate_authority_v1'
         AND operation_id = ?`,
    ).get(safety.authority_operation_id) as Record<string, unknown> | undefined;
    assert.ok(authorityOperation);
    assert.equal(authorityOperation.commit_id, safety.source_commit_id);
    const authorityReceipt = JSON.parse(String(authorityOperation.receipt_json));
    assert.equal(authorityReceipt.trigger_ref_kind, "control_job");
    assert.equal(authorityReceipt.trigger_ref_id, queued.job_id);
    assert.equal((await verifyLiteRuntimeDatabase(scenario.dbPath)).ok, true);

    const nextEnvelope = {
      ...scenario.envelope,
      source_event_sha256: sha256("eligible-host-control-dead-letter-next-source-event"),
      created_at: "2026-07-15T02:04:00.000Z",
    };
    const nextResult = await scenario.guideService.execute(ProductGuideRequest.parse({
      operation_id: "guide:eligible-host-control-dead-letter:after-stop",
      tenant_id: scenario.principal.tenant_id,
      scope: scenario.principal.default_scope,
      run_id: "run:eligible-host-control-dead-letter:after-stop",
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
    scenario.runtimeDatabase.db.exec("DROP TRIGGER IF EXISTS reject_control_job_authority_receipt");
    scenario.runtimeDatabase.db.prepare(
      `UPDATE lite_product_guide_receipts SET ledger_sha256 = ?
       WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
    ).run(
      sourceGuideReceipt.ledger_sha256,
      scenario.principal.tenant_id,
      scenario.principal.default_scope,
      scenario.guide.guide_trace_id,
    );
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

test("legacy feedback records repeated-unused evidence without enqueueing formal learning control", async () => {
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
      "The legacy path has no formal episode-ledger source and must not expose a durable enqueue result",
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

test("legacy guide and feedback leave repeated-unused posture unchanged without a formal learning ledger", async () => {
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

test("legacy negative attribution does not enqueue posture control for a different repeated-unused memory", async () => {
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
