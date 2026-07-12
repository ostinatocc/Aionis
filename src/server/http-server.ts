import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { IdentityRequestKind, InflightKind, RateLimitKind, TenantQuotaKind } from "../app/request-guards.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import { registerMemoryAccessRoutes } from "../routes/memory-access.js";
import {
  createMemoryPlanningContextService,
  type MemoryPlanningContextService,
} from "../routes/memory-context-runtime.js";
import { registerHandoffRoutes, type HandoffRouteService } from "../routes/handoff.js";
import type { MemoryWriteRouteService } from "../routes/memory-write.js";
import { registerProductFacadeRoutes } from "../routes/product-facade.js";
import { createProductObserveService } from "../product/observe-service.js";
import { createProductGuideService } from "../product/guide-service.js";
import { createProductLifecycleService } from "../product/lifecycle-service.js";
import { createProductMeasureService } from "../product/measure-service.js";
import {
  createProductToolFeedbackLearningKernel,
  createProductToolFeedbackService,
} from "../product/tool-feedback-service.js";
import type { ProductServices } from "../product/product-services.js";
import { registerOperatorSnapshotRoutes } from "../routes/operator-snapshot.js";
import { buildRuntimeBoundaryInventoryResponse } from "../memory/runtime-boundary-inventory.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { ExecutionTreeStore } from "../execution/tree-store.js";
import type { ClaimLedgerAccess, SkillCandidateReviewAccess } from "../store/memory-store.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { buildLiteRouteMatrix, registerLiteServerOnlyRoutes } from "./lite-runtime-boundary.js";
import { createErrorResponse, HttpError } from "../util/http.js";

function resolveRuntimeMemoryStoreBackend(env: Env): string {
  return "lite_sqlite";
}

type HealthSnapshotProvider = {
  healthSnapshot: () => unknown;
};

function toPublicStoreHealthSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const { path, ...rest } = snapshot as Record<string, unknown>;
  return {
    ...rest,
    ...(typeof path === "string" && path.trim().length > 0 ? { path_configured: true } : {}),
  };
}

function storeHealthSnapshot(provider?: HealthSnapshotProvider | null): unknown | null {
  return provider ? toPublicStoreHealthSnapshot(provider.healthSnapshot()) : null;
}

function hostedSafeHealthPayload(env: Env): Record<string, unknown> {
  return {
    ok: true,
    edition: env.AIONIS_EDITION,
    mode: env.AIONIS_MODE,
    storage_backend: resolveRuntimeMemoryStoreBackend(env),
    auth_mode: env.MEMORY_AUTH_MODE,
    ...(env.AIONIS_RUNTIME_PACKAGE_NAME ? { package_name: env.AIONIS_RUNTIME_PACKAGE_NAME } : {}),
    ...(env.AIONIS_RUNTIME_PACKAGE_VERSION ? { package_version: env.AIONIS_RUNTIME_PACKAGE_VERSION } : {}),
    ...(env.AIONIS_RUNTIME_STARTED_AT ? { started_at: env.AIONIS_RUNTIME_STARTED_AT } : {}),
  };
}

function readinessCheck(provider?: HealthSnapshotProvider | null): boolean {
  if (!provider) return false;
  try {
    provider.healthSnapshot();
    return true;
  } catch {
    return false;
  }
}

type CorsPolicyLike = {
  allow_origins: string[];
  allow_methods: string;
  allow_headers: string;
  expose_headers: string;
};

export function registerRuntimeErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.code(400).send({
        ...createErrorResponse({
          status: 400,
          error: "invalid_request",
          message: "invalid request",
          details: { contract: "error_v1", issues },
          issues,
        }),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send(createErrorResponse({
        status: err.statusCode,
        error: err.code,
        message: err.message,
        details: err.details ?? undefined,
      }));
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(createErrorResponse({
      status: 500,
      error: "internal_error",
      message: "internal error",
      details: { contract: "error_v1" },
    }));
  });
}

export function registerRuntimeBoundaryInventoryRoutes(args: { app: FastifyInstance; env: Env }) {
  if (args.env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite runtime boundary inventory routes only support AIONIS_EDITION=lite");
  }
  args.app.get("/v1/runtime/boundary-inventory", async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(200).send(buildRuntimeBoundaryInventoryResponse()));
}

export function logMemoryApiConfig(args: {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  queryEmbedder: EmbeddingProvider | null;
  embeddingSurfacePolicy: EmbeddingSurfacePolicy;
  sandboxRemoteAllowedHosts: Set<string>;
  sandboxTenantBudgetPolicy: Map<string, unknown>;
  recallTextEmbedCache: unknown;
  globalRecallProfileDefaults: unknown;
  recallProfilePolicy: unknown;
  recallTextEmbedBatcher: unknown;
}) {
  const {
    app,
    env,
    embedder,
    queryEmbedder,
    embeddingSurfacePolicy,
    sandboxRemoteAllowedHosts,
    sandboxTenantBudgetPolicy,
    recallTextEmbedCache,
    globalRecallProfileDefaults,
    recallProfilePolicy,
    recallTextEmbedBatcher,
  } = args;

  app.log.info(
    {
      aionis_mode: env.AIONIS_MODE,
      aionis_edition: env.AIONIS_EDITION,
      app_env: env.APP_ENV,
      embedding_provider: embedder?.name ?? queryEmbedder?.name ?? "none",
      embedding_write_provider: embedder?.name ?? "none",
      embedding_query_provider: queryEmbedder?.name ?? "none",
      embedding_dim: embedder?.dim ?? queryEmbedder?.dim ?? null,
      embedding_enabled_surfaces: embeddingSurfacePolicy.enabled_surfaces,
      embedding_provider_configured: embeddingSurfacePolicy.provider_configured,
      runtime_defaults: {
        scope: env.MEMORY_SCOPE,
        tenant_id: env.MEMORY_TENANT_ID,
        local_actor_id: env.LITE_LOCAL_ACTOR_ID,
      },
      storage_backend: resolveRuntimeMemoryStoreBackend(env),
      auth_mode: env.MEMORY_AUTH_MODE,
      sandbox: {
        enabled: env.SANDBOX_ENABLED,
        admin_only: env.SANDBOX_ADMIN_ONLY,
        executor_mode: env.SANDBOX_EXECUTOR_MODE,
        max_concurrency: env.SANDBOX_EXECUTOR_MAX_CONCURRENCY,
        remote_executor_configured: env.SANDBOX_EXECUTOR_MODE === "http_remote" ? !!env.SANDBOX_REMOTE_EXECUTOR_URL.trim() : false,
        remote_executor_allowlist_count: sandboxRemoteAllowedHosts.size,
        tenant_budget_window_hours: env.SANDBOX_TENANT_BUDGET_WINDOW_HOURS,
        tenant_budget_tenant_count: sandboxTenantBudgetPolicy.size,
      },
      recall: {
        profile: env.MEMORY_RECALL_PROFILE,
        profile_defaults: globalRecallProfileDefaults,
        profile_policy: recallProfilePolicy,
        recall_text_embed_cache_enabled: !!recallTextEmbedCache,
        recall_text_embed_batch_enabled: !!recallTextEmbedBatcher,
      },
      concurrency: {
        api_recall_max_inflight: env.API_RECALL_MAX_INFLIGHT,
        api_recall_queue_max: env.API_RECALL_QUEUE_MAX,
        api_write_max_inflight: env.API_WRITE_MAX_INFLIGHT,
        api_write_queue_max: env.API_WRITE_QUEUE_MAX,
      },
    },
    "memory api config",
  );
}

export function registerRuntimeRequestHooks(args: {
  app: FastifyInstance;
  resolveCorsPolicy: (req: FastifyRequest) => CorsPolicyLike | null;
  resolveCorsAllowOrigin: (origin: string | null, allowOrigins: string[]) => string | null;
}) {
  const {
    app,
    resolveCorsPolicy,
    resolveCorsAllowOrigin,
  } = args;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("x-request-id", req.id);

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const corsPolicy = resolveCorsPolicy(req);
    const allowOrigin = corsPolicy ? resolveCorsAllowOrigin(origin, corsPolicy.allow_origins) : null;
    if (allowOrigin && corsPolicy) {
      reply.header("access-control-allow-origin", allowOrigin);
      if (allowOrigin !== "*") reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", corsPolicy.allow_methods);
      reply.header("access-control-allow-headers", corsPolicy.allow_headers);
      reply.header("access-control-expose-headers", corsPolicy.expose_headers);
      reply.header("access-control-max-age", "600");
    }

    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}

export function registerHealthRoute(args: {
  app: FastifyInstance;
  env: Env;
  liteReplayStore?: HealthSnapshotProvider | null;
  liteRecallStore?: { healthSnapshot: () => unknown } | null;
  liteWriteStore?: { healthSnapshot: () => unknown } | null;
  projectionWorker?: HealthSnapshotProvider | null;
  liteClaimLedgerStore?: { healthSnapshot: () => unknown } | null;
  executionStateStore?: { healthSnapshot: () => unknown } | null;
  executionTreeStore?: { healthSnapshot: () => unknown } | null;
  sandboxExecutor: HealthSnapshotProvider;
  sandboxTenantBudgetPolicy: Map<string, unknown>;
  sandboxRemoteAllowedCidrs: Set<string>;
}) {
  const {
    app,
    env,
    liteReplayStore,
    liteRecallStore,
    liteWriteStore,
    projectionWorker,
    liteClaimLedgerStore,
    executionStateStore,
    executionTreeStore,
    sandboxExecutor,
    sandboxTenantBudgetPolicy,
    sandboxRemoteAllowedCidrs,
  } = args;

  app.get("/healthz", async () => hostedSafeHealthPayload(env));

  app.get("/readyz", async (_req: FastifyRequest, reply: FastifyReply) => {
    const checks = {
      recall_store: readinessCheck(liteRecallStore),
      write_store: readinessCheck(liteWriteStore),
      ...(liteClaimLedgerStore ? { claim_ledger_store: readinessCheck(liteClaimLedgerStore) } : {}),
      execution_state_store: readinessCheck(executionStateStore),
      execution_tree_store: readinessCheck(executionTreeStore),
      replay_store: readinessCheck(liteReplayStore),
      sandbox: readinessCheck(sandboxExecutor),
    };
    const ready = Object.values(checks).every((ok) => ok === true);
    return reply.code(ready ? 200 : 503).send({
      ...hostedSafeHealthPayload(env),
      ok: ready,
      ready,
      checks,
    });
  });

  app.get("/health", async () => {
    const sandboxHealth = sandboxExecutor.healthSnapshot();
    const sandboxHealthRecord =
      sandboxHealth && typeof sandboxHealth === "object" && !Array.isArray(sandboxHealth)
        ? (sandboxHealth as Record<string, unknown>)
        : {};
    return {
      ok: true,
      runtime: {
        edition: env.AIONIS_EDITION,
        mode: env.AIONIS_MODE,
        ...(env.AIONIS_RUNTIME_PACKAGE_NAME ? { package_name: env.AIONIS_RUNTIME_PACKAGE_NAME } : {}),
        ...(env.AIONIS_RUNTIME_PACKAGE_VERSION ? { package_version: env.AIONIS_RUNTIME_PACKAGE_VERSION } : {}),
        ...(env.AIONIS_RUNTIME_STARTED_AT ? { started_at: env.AIONIS_RUNTIME_STARTED_AT } : {}),
      },
      storage: {
        backend: resolveRuntimeMemoryStoreBackend(env),
      },
      lite: env.AIONIS_EDITION === "lite"
        ? {
            identity: {
              local_actor_id: env.LITE_LOCAL_ACTOR_ID,
            },
            stores: {
              recall: storeHealthSnapshot(liteRecallStore),
              write: storeHealthSnapshot(liteWriteStore),
              projection_worker: storeHealthSnapshot(projectionWorker),
              claim_ledger: storeHealthSnapshot(liteClaimLedgerStore),
              execution_state: storeHealthSnapshot(executionStateStore),
              execution_tree: storeHealthSnapshot(executionTreeStore),
              replay: storeHealthSnapshot(liteReplayStore),
            },
            route_matrix: buildLiteRouteMatrix(),
          }
        : null,
      sandbox: {
        ...sandboxHealthRecord,
        tenant_budget: {
          window_hours: env.SANDBOX_TENANT_BUDGET_WINDOW_HOURS,
          tenant_count: sandboxTenantBudgetPolicy.size,
        },
        remote_egress: {
          cidr_count: sandboxRemoteAllowedCidrs.size,
          deny_private_ips: env.SANDBOX_REMOTE_EXECUTOR_EGRESS_DENY_PRIVATE_IPS,
        },
        artifact_object_store: {
          base_uri_configured: !!env.SANDBOX_ARTIFACT_OBJECT_STORE_BASE_URI.trim(),
        },
      },
    };
  });
}

type HandoffRouteArgs = Parameters<typeof registerHandoffRoutes>[0];
type MemoryAccessRouteArgs = Parameters<typeof registerMemoryAccessRoutes>[0];
type MemoryContextServiceArgs = Parameters<typeof createMemoryPlanningContextService>[0];

type RuntimeLiteWriteStore =
  & HandoffRouteArgs["liteWriteStore"]
  & MemoryAccessRouteArgs["liteWriteStore"]
  & MemoryContextServiceArgs["liteWriteStore"]
  & Pick<LiteWriteStore,
    | "listOperatorGuideExposures"
    | "resolveCommit"
    | "listRuleFeedbackByRun"
    | "insertProductGuideReceipt"
    | "getProductGuideReceipt"
    | "listProductGuideReceipts"
  >;

type RuntimeLiteRecallAccess = MemoryContextServiceArgs["liteRecallAccess"];

export type RegisterApplicationRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  queryEmbedder: EmbeddingProvider | null;
  embeddingSurfacePolicy: EmbeddingSurfacePolicy;
  liteRecallAccess: RuntimeLiteRecallAccess;
  liteWriteStore: RuntimeLiteWriteStore;
  claimLedgerAccess?: ClaimLedgerAccess | null;
  skillCandidateReviewAccess?: SkillCandidateReviewAccess | null;
  executionStateStore: ExecutionStateStore;
  executionTreeStore: ExecutionTreeStore;
  productServices: ProductServices;
  recallTextEmbedBatcher: unknown;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: IdentityRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: RateLimitKind) => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: TenantQuotaKind, tenantId: string) => Promise<void>;
  enforceRecallTextEmbedQuota: (req: FastifyRequest, reply: FastifyReply, tenantId: string) => Promise<void>;
  buildRecallAuth: MemoryContextServiceArgs["buildRecallAuth"];
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: InflightKind) => Promise<InflightGateToken>;
  hasExplicitRecallKnobs: MemoryContextServiceArgs["hasExplicitRecallKnobs"];
  resolveRecallProfile: MemoryContextServiceArgs["resolveRecallProfile"];
  resolveExplicitRecallMode: MemoryContextServiceArgs["resolveExplicitRecallMode"];
  resolveClassAwareRecallProfile: MemoryContextServiceArgs["resolveClassAwareRecallProfile"];
  withRecallProfileDefaults: MemoryContextServiceArgs["withRecallProfileDefaults"];
  resolveRecallStrategy: MemoryContextServiceArgs["resolveRecallStrategy"];
  resolveAdaptiveRecallProfile: MemoryContextServiceArgs["resolveAdaptiveRecallProfile"];
  resolveAdaptiveRecallHardCap: MemoryContextServiceArgs["resolveAdaptiveRecallHardCap"];
  inferRecallStrategyFromKnobs: MemoryContextServiceArgs["inferRecallStrategyFromKnobs"];
  buildRecallTrajectory: MemoryContextServiceArgs["buildRecallTrajectory"];
  embedRecallTextQuery: MemoryContextServiceArgs["embedRecallTextQuery"];
  mapRecallTextEmbeddingError: MemoryContextServiceArgs["mapRecallTextEmbeddingError"];
  recordContextAssemblyTelemetryBestEffort: MemoryContextServiceArgs["recordContextAssemblyTelemetryBestEffort"];
};

type RuntimeBoundaryRouteRegistrationArgs = Pick<RegisterApplicationRoutesArgs, "app" | "env">;
type RuntimeAdminRouteRegistrationArgs = Pick<RegisterApplicationRoutesArgs, "app">;
type ProductFacadeRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "env"
  | "liteWriteStore"
  | "productServices"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "tenantFromBody"
  | "acquireInflightSlot"
> & {
  planningContextService?: MemoryPlanningContextService | null;
};

type RuntimeWriteRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "env"
  | "embedder"
  | "embeddingSurfacePolicy"
  | "liteWriteStore"
  | "executionStateStore"
  | "executionTreeStore"
  | "liteRecallAccess"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "tenantFromBody"
  | "acquireInflightSlot"
>;

type RuntimePlanningServiceArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "env"
  | "queryEmbedder"
  | "embeddingSurfacePolicy"
  | "liteWriteStore"
  | "liteRecallAccess"
  | "recallTextEmbedBatcher"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "enforceRecallTextEmbedQuota"
  | "buildRecallAuth"
  | "tenantFromBody"
  | "acquireInflightSlot"
  | "hasExplicitRecallKnobs"
  | "resolveRecallProfile"
  | "resolveExplicitRecallMode"
  | "resolveClassAwareRecallProfile"
  | "withRecallProfileDefaults"
  | "resolveRecallStrategy"
  | "resolveAdaptiveRecallProfile"
  | "resolveAdaptiveRecallHardCap"
  | "inferRecallStrategyFromKnobs"
  | "buildRecallTrajectory"
  | "embedRecallTextQuery"
  | "mapRecallTextEmbeddingError"
  | "recordContextAssemblyTelemetryBestEffort"
>;

type RuntimeKernelRouteRegistrationArgs =
  & RuntimeWriteRouteRegistrationArgs
  & RuntimePlanningServiceArgs;

function registerRuntimeBoundaryRoutes(args: RuntimeBoundaryRouteRegistrationArgs) {
  registerRuntimeBoundaryInventoryRoutes({
    app: args.app,
    env: args.env,
  });
}

function registerAdminRoutes(args: RuntimeAdminRouteRegistrationArgs) {
  const {
    app,
  } = args;

  registerLiteServerOnlyRoutes(app);
}

function registerRuntimeWriteRoutes(args: RuntimeWriteRouteRegistrationArgs) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
    liteRecallAccess,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

  registerHandoffRoutes({
    app,
    env,
    embedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    executionStateStore,
    executionTreeStore,
  });

  registerMemoryAccessRoutes({
    app,
    env,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  });
}

function createRuntimePlanningServices(args: RuntimePlanningServiceArgs) {
  const {
    env,
    queryEmbedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    liteRecallAccess,
    recallTextEmbedBatcher,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    enforceRecallTextEmbedQuota,
    buildRecallAuth,
    tenantFromBody,
    acquireInflightSlot,
    hasExplicitRecallKnobs,
    resolveRecallProfile,
    resolveExplicitRecallMode,
    resolveClassAwareRecallProfile,
    withRecallProfileDefaults,
    resolveRecallStrategy,
    resolveAdaptiveRecallProfile,
    resolveAdaptiveRecallHardCap,
    inferRecallStrategyFromKnobs,
    buildRecallTrajectory,
    embedRecallTextQuery,
    mapRecallTextEmbeddingError,
    recordContextAssemblyTelemetryBestEffort,
  } = args;

  const planningContextService = createMemoryPlanningContextService({
    env,
    embedder: queryEmbedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    liteRecallAccess,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    enforceRecallTextEmbedQuota,
    buildRecallAuth,
    tenantFromBody,
    acquireInflightSlot,
    hasExplicitRecallKnobs,
    resolveRecallProfile,
    resolveExplicitRecallMode,
    resolveClassAwareRecallProfile,
    withRecallProfileDefaults,
    resolveRecallStrategy,
    resolveAdaptiveRecallProfile,
    resolveAdaptiveRecallHardCap,
    inferRecallStrategyFromKnobs,
    buildRecallTrajectory,
    embedRecallTextQuery,
    mapRecallTextEmbeddingError,
    recordContextAssemblyTelemetryBestEffort,
  });

  return {
    planningContextService,
  };
}

function registerRuntimeKernelRoutes(args: RuntimeKernelRouteRegistrationArgs) {
  registerRuntimeWriteRoutes(args);
  return createRuntimePlanningServices(args);
}

function registerProductRoutes(args: ProductFacadeRouteRegistrationArgs) {
  registerProductFacadeRoutes({
    app: args.app,
    services: args.productServices,
    planningContextService: args.planningContextService ?? null,
    requireMemoryPrincipal: args.requireMemoryPrincipal,
    withIdentityFromRequest: args.withIdentityFromRequest,
    enforceRateLimit: args.enforceRateLimit,
    enforceTenantQuota: args.enforceTenantQuota,
    tenantFromBody: args.tenantFromBody,
    acquireInflightSlot: args.acquireInflightSlot,
    adminToken: args.env.ADMIN_TOKEN,
  });
  registerOperatorSnapshotRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.requireMemoryPrincipal,
    withIdentityFromRequest: args.withIdentityFromRequest,
    enforceRateLimit: args.enforceRateLimit,
    enforceTenantQuota: args.enforceTenantQuota,
    tenantFromBody: args.tenantFromBody,
    acquireInflightSlot: args.acquireInflightSlot,
  });
}

export function createRuntimeProductServices(args: {
  env: Env;
  liteWriteStore: RuntimeLiteWriteStore;
  liteRecallAccess?: RuntimeLiteRecallAccess | null;
  embedder?: EmbeddingProvider | null;
  queryEmbedder?: EmbeddingProvider | null;
  executionTreeStore?: ExecutionTreeStore | null;
  claimLedgerAccess?: ClaimLedgerAccess | null;
  skillCandidateReviewAccess?: SkillCandidateReviewAccess | null;
  memoryWriteService: MemoryWriteRouteService | null;
  handoffRouteService: HandoffRouteService | null;
}): ProductServices {
  const toolFeedbackLearningKernel = createProductToolFeedbackLearningKernel({
    env: args.env,
    embedder: args.embedder ?? null,
    queryEmbedder: args.queryEmbedder ?? null,
    liteRecallAccess: args.liteRecallAccess ?? null,
    liteWriteStore: args.liteWriteStore,
  });
  return {
    observe: createProductObserveService({
      defaultTenantId: args.env.MEMORY_TENANT_ID,
      defaultScope: args.env.MEMORY_SCOPE,
      memoryWrite: args.memoryWriteService,
      handoffStore: args.handoffRouteService,
      atomicWrite: args.liteWriteStore,
      claimLedgerAccess: args.claimLedgerAccess ?? null,
    }),
    guide: createProductGuideService({
      env: args.env,
      liteWriteStore: args.liteWriteStore,
      executionTreeStore: args.executionTreeStore ?? null,
      claimLedgerAccess: args.claimLedgerAccess ?? null,
      memoryWrite: args.memoryWriteService,
    }),
    toolFeedback: createProductToolFeedbackService({
      env: args.env,
      liteWriteStore: args.liteWriteStore,
      learningKernel: toolFeedbackLearningKernel,
    }),
    lifecycle: createProductLifecycleService({
      env: args.env,
      liteWriteStore: args.liteWriteStore,
    }),
    measure: createProductMeasureService({
      defaultTenantId: args.env.MEMORY_TENANT_ID,
      defaultScope: args.env.MEMORY_SCOPE,
      skillCandidateReviewAccess: args.skillCandidateReviewAccess ?? null,
      runtimeEvidenceStore: args.liteWriteStore,
    }),
  };
}

export function registerApplicationRoutes(args: RegisterApplicationRoutesArgs) {
  assertLocalStoreRuntimeEdition(args.env, "local-store application routes");
  if (args.env.AIONIS_EDITION === "lite") {
    registerRuntimeBoundaryRoutes(args);
    registerAdminRoutes(args);
  }
  const runtimeKernelRoutes = registerRuntimeKernelRoutes(args);
  registerProductRoutes({
    ...args,
    planningContextService: runtimeKernelRoutes.planningContextService,
  });
}
