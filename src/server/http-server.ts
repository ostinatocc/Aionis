import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { IdentityRequestKind, InflightKind, RateLimitKind, TenantQuotaKind } from "../app/request-guards.js";
import type { AuthPrincipal } from "../util/auth.js";
import { resolveTenantScope } from "../memory/tenant.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import { registerMemoryAccessRoutes } from "../routes/memory-access.js";
import type { MemoryWriteRouteService } from "../routes/memory-write.js";
import { registerProductFacadeRoutes } from "../routes/product-facade.js";
import { createProductObserveService } from "../product/observe-service.js";
import { createProductGuideService } from "../product/guide-service.js";
import { createProductLifecycleService } from "../product/lifecycle-service.js";
import {
  createProductExecutionEpisodeTransportService,
} from "../product/execution-episode-transport-service.js";
import {
  createProductExecutionSessionTransportService,
} from "../product/execution-session-transport-service.js";
import type { ExecutionEpisodeService } from "../product/execution-episode-service.js";
import type {
  ExecutionTurnTransactionService,
} from "../product/execution-turn-transaction-service.js";
import {
  objectValue,
  productServiceSuccess,
  type ProductServices,
} from "../product/product-services.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { LiteExecutionEpisodeStore } from
  "../store/lite-execution-episode-store.js";
import type { LiteEvidenceArtifactStore } from
  "../store/lite-evidence-artifact-store.js";
import { buildLiteRouteMatrix } from "./lite-runtime-boundary.js";
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

export function logMemoryApiConfig(args: {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  queryEmbedder: EmbeddingProvider | null;
}) {
  const {
    app,
    env,
    embedder,
    queryEmbedder,
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
      runtime_defaults: {
        scope: env.MEMORY_SCOPE,
        tenant_id: env.MEMORY_TENANT_ID,
        local_actor_id: env.LITE_LOCAL_ACTOR_ID,
      },
      storage_backend: resolveRuntimeMemoryStoreBackend(env),
      auth_mode: env.MEMORY_AUTH_MODE,
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
  liteRecallStore?: { healthSnapshot: () => unknown } | null;
  liteWriteStore?: { healthSnapshot: () => unknown } | null;
  projectionWorker?: HealthSnapshotProvider | null;
  executionStateStore?: { healthSnapshot: () => unknown } | null;
  executionTreeStore?: { healthSnapshot: () => unknown } | null;
}) {
  const {
    app,
    env,
    liteRecallStore,
    liteWriteStore,
    projectionWorker,
    executionStateStore,
    executionTreeStore,
  } = args;

  app.get("/readyz", async (_req: FastifyRequest, reply: FastifyReply) => {
    const checks = {
      recall_store: readinessCheck(liteRecallStore),
      write_store: readinessCheck(liteWriteStore),
      execution_state_store: readinessCheck(executionStateStore),
      execution_tree_store: readinessCheck(executionTreeStore),
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
              execution_state: storeHealthSnapshot(executionStateStore),
              execution_tree: storeHealthSnapshot(executionTreeStore),
            },
            route_matrix: buildLiteRouteMatrix(),
          }
        : null,
    };
  });
}

type MemoryAccessRouteArgs = Parameters<typeof registerMemoryAccessRoutes>[0];

type RuntimeLiteWriteStore =
  & MemoryAccessRouteArgs["liteWriteStore"]
  & Pick<LiteWriteStore,
    | "resolveCommit"
    | "listRuleFeedbackByRun"
    | "insertProductGuideReceipt"
    | "getProductGuideReceipt"
    | "listProductGuideReceipts"
  >;

type RuntimeLiteRecallAccess = RecallStoreAccess;

export type RegisterApplicationRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  liteWriteStore: RuntimeLiteWriteStore;
  productServices: ProductServices;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: IdentityRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: RateLimitKind) => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: TenantQuotaKind, tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: InflightKind) => Promise<InflightGateToken>;
};

type ProductFacadeRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "productServices"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "tenantFromBody"
  | "acquireInflightSlot"
>;

type RuntimeWriteRouteRegistrationArgs = Pick<
  RegisterApplicationRoutesArgs,
  | "app"
  | "env"
  | "liteWriteStore"
  | "requireMemoryPrincipal"
  | "withIdentityFromRequest"
  | "enforceRateLimit"
  | "enforceTenantQuota"
  | "tenantFromBody"
  | "acquireInflightSlot"
>;

function registerRuntimeWriteRoutes(args: RuntimeWriteRouteRegistrationArgs) {
  const {
    app,
    env,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

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

function registerRuntimeKernelRoutes(args: RuntimeWriteRouteRegistrationArgs) {
  registerRuntimeWriteRoutes(args);
}

function registerProductRoutes(args: ProductFacadeRouteRegistrationArgs) {
  registerProductFacadeRoutes({
    app: args.app,
    services: args.productServices,
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
  queryEmbedder?: EmbeddingProvider | null;
  memoryWriteService: MemoryWriteRouteService | null;
  executionEpisodeService: ExecutionEpisodeService;
  executionTurnTransactionService: ExecutionTurnTransactionService;
  executionEpisodeStore?: LiteExecutionEpisodeStore | null;
  evidenceArtifactStore?: LiteEvidenceArtifactStore | null;
  executionStateStore?: ExecutionStateStore | null;
}): ProductServices {
  const guideCore = createProductGuideService({
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallAccess ?? null,
    queryEmbedder: args.queryEmbedder ?? null,
    executionEpisodeStore: args.executionEpisodeStore ?? null,
    evidenceArtifactStore: args.evidenceArtifactStore ?? null,
    executionStateStore: args.executionStateStore ?? null,
  });
  const guide: ProductServices["guide"] = {
    async execute(input) {
      const lease = input.session_lease_v1;
      if (!lease || !input.episode_id) {
        return await guideCore.execute(input);
      }
      const identity = resolveTenantScope(input, {
        defaultTenantId: args.env.MEMORY_TENANT_ID,
        defaultScope: args.env.MEMORY_SCOPE,
      });
      const leased =
        await args.executionTurnTransactionService.runLeased({
          credentials: {
            tenantId: identity.tenant_id,
            storeScope: identity.scope_key,
            sessionKey: lease.session_key,
            holderId: lease.holder_id,
            leaseId: lease.lease_id,
            leaseRevision: lease.lease_revision,
          },
          leaseOperationId: lease.lease_operation_id,
          operationBinding: input,
          expectedEpisodeId: input.episode_id,
          expectedContinuationId: lease.continuation_id,
          ...(lease.lease_ttl_ms === undefined
            ? {}
            : { leaseTtlMs: lease.lease_ttl_ms }),
          execute: async () => await guideCore.execute(input),
        });
      if (!leased.result.ok) return leased.result;
      const body = objectValue(leased.result.body);
      if (!body) return leased.result;
      return productServiceSuccess({
        ...body,
        session: leased.session,
        current_execution_state: leased.current_state,
      }, leased.result.statusCode);
    },
  };
  return {
    executionSession: createProductExecutionSessionTransportService({
      defaultTenantId: args.env.MEMORY_TENANT_ID,
      defaultScope: args.env.MEMORY_SCOPE,
      executionTurnService: args.executionTurnTransactionService,
    }),
    executionEpisode: createProductExecutionEpisodeTransportService({
      defaultTenantId: args.env.MEMORY_TENANT_ID,
      defaultScope: args.env.MEMORY_SCOPE,
      executionEpisodeService: args.executionEpisodeService,
      executionTurnService: args.executionTurnTransactionService,
    }),
    observe: createProductObserveService({
      defaultTenantId: args.env.MEMORY_TENANT_ID,
      defaultScope: args.env.MEMORY_SCOPE,
      memoryWrite: args.memoryWriteService,
      atomicWrite: args.liteWriteStore,
    }),
    guide,
    lifecycle: createProductLifecycleService({
      env: args.env,
      liteWriteStore: args.liteWriteStore,
    }),
  };
}

export function registerApplicationRoutes(args: RegisterApplicationRoutesArgs) {
  assertLocalStoreRuntimeEdition(args.env, "local-store application routes");
  registerRuntimeKernelRoutes(args);
  registerProductRoutes(args);
}
