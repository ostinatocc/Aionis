import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { IdentityRequestKind, InflightKind, RateLimitKind, TenantQuotaKind } from "../app/request-guards.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import { registerMemoryAccessRoutes } from "../routes/memory-access.js";
import { registerMemoryContextRuntimeRoutes } from "../routes/memory-context-runtime.js";
import { registerMemoryFeedbackToolRoutes } from "../routes/memory-feedback-tools.js";
import { registerLiteMemoryLifecycleRoutes } from "../routes/memory-lifecycle-lite.js";
import { registerHandoffRoutes } from "../routes/handoff.js";
import { registerMemoryRecallRoutes } from "../routes/memory-recall.js";
import { registerMemoryReplayCoreRoutes } from "../routes/memory-replay-core.js";
import { registerMemoryReplayLearningControlRoutes } from "../routes/memory-replay-learning-control.js";
import { registerMemoryWriteRoutes } from "../routes/memory-write.js";
import { registerRuntimeBoundaryInventoryRoutes } from "../routes/runtime-boundary-inventory.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import { buildLiteRouteMatrix, registerLiteServerOnlyRoutes } from "./lite-runtime-boundary.js";
import { createErrorResponse, HttpError } from "../util/http.js";

function resolveRuntimeMemoryStoreBackend(env: Env): string {
  return "lite_sqlite";
}

type HealthSnapshotProvider = {
  healthSnapshot: () => unknown;
};

function assertLiteOnlySourceTree(env: Env): void {
  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite source tree only supports AIONIS_EDITION=lite");
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

export function logMemoryApiConfig(args: {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
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
      embedding_provider: embedder?.name ?? "none",
      embedding_dim: embedder?.dim ?? null,
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
  executionStateStore?: { healthSnapshot: () => unknown } | null;
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
    executionStateStore,
    sandboxExecutor,
    sandboxTenantBudgetPolicy,
    sandboxRemoteAllowedCidrs,
  } = args;

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
              recall: liteRecallStore ? liteRecallStore.healthSnapshot() : null,
              write: liteWriteStore ? liteWriteStore.healthSnapshot() : null,
              execution_state: executionStateStore ? executionStateStore.healthSnapshot() : null,
              replay: liteReplayStore ? liteReplayStore.healthSnapshot() : null,
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

type MemoryWriteRouteArgs = Parameters<typeof registerMemoryWriteRoutes>[0];
type HandoffRouteArgs = Parameters<typeof registerHandoffRoutes>[0];
type MemoryAccessRouteArgs = Parameters<typeof registerMemoryAccessRoutes>[0];
type MemoryLifecycleRouteArgs = Parameters<typeof registerLiteMemoryLifecycleRoutes>[0];
type MemoryRecallRouteArgs = Parameters<typeof registerMemoryRecallRoutes>[0];
type MemoryContextRouteArgs = Parameters<typeof registerMemoryContextRuntimeRoutes>[0];
type MemoryFeedbackRouteArgs = Parameters<typeof registerMemoryFeedbackToolRoutes>[0];
type MemoryReplayCoreRouteArgs = Parameters<typeof registerMemoryReplayCoreRoutes>[0];
type MemoryReplayLearningControlRouteArgs = Parameters<typeof registerMemoryReplayLearningControlRoutes>[0];

type RuntimeLiteWriteStore =
  & NonNullable<MemoryWriteRouteArgs["liteWriteStore"]>
  & HandoffRouteArgs["liteWriteStore"]
  & MemoryAccessRouteArgs["liteWriteStore"]
  & MemoryLifecycleRouteArgs["liteWriteStore"]
  & MemoryRecallRouteArgs["liteWriteStore"]
  & MemoryContextRouteArgs["liteWriteStore"]
  & MemoryFeedbackRouteArgs["liteWriteStore"]
  & NonNullable<MemoryReplayCoreRouteArgs["liteWriteStore"]>
  & MemoryReplayLearningControlRouteArgs["liteWriteStore"];

type RuntimeLiteRecallAccess =
  & MemoryAccessRouteArgs["liteRecallAccess"]
  & MemoryRecallRouteArgs["liteRecallAccess"]
  & MemoryContextRouteArgs["liteRecallAccess"]
  & MemoryFeedbackRouteArgs["liteRecallAccess"];

type RuntimeLiteReplayAccess = NonNullable<MemoryReplayCoreRouteArgs["liteReplayAccess"]>;
type RuntimeLiteReplayStore = NonNullable<MemoryReplayCoreRouteArgs["liteReplayStore"]>;

type RuntimeReplayRunOptionsBuilder =
  & MemoryReplayLearningControlRouteArgs["buildReplayPlaybookRunOptions"];

export type RegisterApplicationRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy: EmbeddingSurfacePolicy;
  liteRecallAccess: RuntimeLiteRecallAccess;
  liteReplayAccess: RuntimeLiteReplayAccess;
  liteReplayStore: RuntimeLiteReplayStore;
  liteWriteStore: RuntimeLiteWriteStore;
  executionStateStore: ExecutionStateStore;
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
  buildRecallAuth: MemoryRecallRouteArgs["buildRecallAuth"] & MemoryContextRouteArgs["buildRecallAuth"];
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: InflightKind) => Promise<InflightGateToken>;
  hasExplicitRecallKnobs: MemoryRecallRouteArgs["hasExplicitRecallKnobs"];
  resolveRecallProfile: MemoryRecallRouteArgs["resolveRecallProfile"] & MemoryContextRouteArgs["resolveRecallProfile"];
  resolveExplicitRecallMode: MemoryRecallRouteArgs["resolveExplicitRecallMode"] & MemoryContextRouteArgs["resolveExplicitRecallMode"];
  resolveClassAwareRecallProfile: MemoryContextRouteArgs["resolveClassAwareRecallProfile"];
  withRecallProfileDefaults: MemoryRecallRouteArgs["withRecallProfileDefaults"] & MemoryContextRouteArgs["withRecallProfileDefaults"];
  resolveRecallStrategy: MemoryRecallRouteArgs["resolveRecallStrategy"] & MemoryContextRouteArgs["resolveRecallStrategy"];
  resolveAdaptiveRecallProfile: MemoryRecallRouteArgs["resolveAdaptiveRecallProfile"] & MemoryContextRouteArgs["resolveAdaptiveRecallProfile"];
  resolveAdaptiveRecallHardCap: MemoryRecallRouteArgs["resolveAdaptiveRecallHardCap"] & MemoryContextRouteArgs["resolveAdaptiveRecallHardCap"];
  inferRecallStrategyFromKnobs: MemoryRecallRouteArgs["inferRecallStrategyFromKnobs"] & MemoryContextRouteArgs["inferRecallStrategyFromKnobs"];
  buildRecallTrajectory: MemoryRecallRouteArgs["buildRecallTrajectory"] & MemoryContextRouteArgs["buildRecallTrajectory"];
  embedRecallTextQuery: MemoryContextRouteArgs["embedRecallTextQuery"];
  mapRecallTextEmbeddingError: MemoryContextRouteArgs["mapRecallTextEmbeddingError"];
  recordContextAssemblyTelemetryBestEffort: MemoryContextRouteArgs["recordContextAssemblyTelemetryBestEffort"];
  withReplayRepairReviewDefaults: MemoryReplayLearningControlRouteArgs["withReplayRepairReviewDefaults"];
  buildReplayRepairReviewOptions: MemoryReplayLearningControlRouteArgs["buildReplayRepairReviewOptions"];
  buildReplayPlaybookRunOptions: RuntimeReplayRunOptionsBuilder;
};

type RuntimeBoundaryRouteRegistrationArgs = Pick<RegisterApplicationRoutesArgs, "app" | "env">;
type RuntimeAdminRouteRegistrationArgs = Pick<RegisterApplicationRoutesArgs, "app">;

type RuntimeWriteRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "env"
  | "embedder"
  | "embeddingSurfacePolicy"
  | "liteWriteStore"
  | "executionStateStore"
  | "liteRecallAccess"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "tenantFromBody"
  | "acquireInflightSlot"
>;

type RuntimeRecallRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "env"
  | "embedder"
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

type RuntimeReplayRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "env"
  | "embedder"
  | "embeddingSurfacePolicy"
  | "liteReplayAccess"
  | "liteReplayStore"
  | "liteWriteStore"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "tenantFromBody"
  | "acquireInflightSlot"
  | "withReplayRepairReviewDefaults"
  | "buildReplayRepairReviewOptions"
  | "buildReplayPlaybookRunOptions"
>;

type RuntimeKernelRouteRegistrationArgs =
  & RuntimeWriteRouteRegistrationArgs
  & RuntimeRecallRouteRegistrationArgs
  & RuntimeReplayRouteRegistrationArgs;

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
    liteRecallAccess,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

  registerMemoryWriteRoutes({
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
  });

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
  });

  registerMemoryAccessRoutes({
    app,
    env,
    embedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    executionStateStore,
    liteRecallAccess,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  });

  registerLiteMemoryLifecycleRoutes({
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

function registerRuntimeRecallRoutes(args: RuntimeRecallRouteRegistrationArgs) {
  const {
    app,
    env,
    embedder,
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

  registerMemoryRecallRoutes({
    app,
    env,
    liteRecallAccess,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    hasExplicitRecallKnobs,
    resolveRecallProfile,
    resolveExplicitRecallMode,
    withRecallProfileDefaults,
    resolveRecallStrategy,
    resolveAdaptiveRecallProfile,
    resolveAdaptiveRecallHardCap,
    inferRecallStrategyFromKnobs,
    buildRecallTrajectory,
    buildRecallAuth,
  });

  registerMemoryContextRuntimeRoutes({
    app,
    env,
    embedder,
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
  });

  registerMemoryFeedbackToolRoutes({
    app,
    env,
    embedder,
    liteRecallAccess,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  });
}

function registerRuntimeReplayRoutes(args: RuntimeReplayRouteRegistrationArgs) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy,
    liteReplayAccess,
    liteReplayStore,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    withReplayRepairReviewDefaults,
    buildReplayRepairReviewOptions,
    buildReplayPlaybookRunOptions,
  } = args;

  registerMemoryReplayCoreRoutes({
    app,
    env,
    embedder,
    embeddingSurfacePolicy,
    liteReplayAccess,
    liteReplayStore,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  });

  registerMemoryReplayLearningControlRoutes({
    app,
    env,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    withReplayRepairReviewDefaults,
    buildReplayRepairReviewOptions,
    buildReplayPlaybookRunOptions,
  });

}
function registerRuntimeKernelRoutes(args: RuntimeKernelRouteRegistrationArgs) {
  registerRuntimeWriteRoutes(args);
  registerRuntimeRecallRoutes(args);
  registerRuntimeReplayRoutes(args);
}

export function registerApplicationRoutes(args: RegisterApplicationRoutesArgs) {
  assertLiteOnlySourceTree(args.env);
  registerRuntimeBoundaryRoutes(args);
  registerAdminRoutes(args);
  registerRuntimeKernelRoutes(args);
}
