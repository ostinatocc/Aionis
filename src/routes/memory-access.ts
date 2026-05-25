import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { buildLiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";
import { memoryFindLite } from "../memory/find.js";
import {
  buildAgentMemoryHandoffPackLite,
  buildAgentMemoryInspectLite,
  buildAgentMemoryReviewPackLite,
  buildAgentMemoryResumePackLite,
} from "../memory/agent-memory-inspect-core.js";
import {
  buildExperienceIntelligenceLite,
  buildKickoffRecommendationResponseFromExperience,
} from "../memory/experience-intelligence.js";
import { ExperienceIntelligenceRequest } from "../memory/schemas.js";
import { buildActionRetrievalLite } from "../memory/action-retrieval.js";
import { buildExecutionMemoryIntrospectionLite } from "../memory/execution-introspection.js";
import { aggregateDelegationRecordsLite, findDelegationRecordsLite } from "../memory/delegation-records-find.js";
import { buildContinuityReviewPackLite, buildEvolutionReviewPackLite } from "../memory/reviewer-packs.js";
import { exportMemoryPack, importMemoryPack } from "../memory/packs.js";
import { rehydrateAnchorPayloadLite } from "../memory/rehydrate-anchor.js";
import { memoryResolveLite } from "../memory/resolve.js";
import { createSession, listSessions, listSessionEvents, writeSessionEvent } from "../memory/sessions.js";
import { writeDelegationRecords } from "../memory/delegation-records.js";
import { buildTrajectoryCompileLite } from "../memory/trajectory-compile.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type MemoryAccessRequestKind =
  | "write"
  | "find"
  | "resolve"
  | "rehydrate_payload"
  | "continuity_review_pack"
  | "agent_memory_inspect"
  | "agent_memory_review_pack"
  | "agent_memory_resume_pack"
  | "agent_memory_handoff_pack"
  | "execution_introspect"
  | "evolution_review_pack"
  | "action_retrieval"
  | "experience_intelligence"
  | "delegation_records_write"
  | "delegation_records_find"
  | "delegation_records_aggregate"
  | "trajectory_compile"
  | "kickoff_recommendation";
type MemoryAccessInflightKind = "write" | "recall";

type MemoryAccessRequest = FastifyRequest<{ Body: unknown; Querystring: Record<string, unknown>; Params: Record<string, unknown> }>;

type SessionEventsParams = {
  session_id?: string;
};

type MemoryAccessLiteStoreLike =
  NonNullable<Parameters<typeof createSession>[1]["liteWriteStore"]>
  & NonNullable<Parameters<typeof writeSessionEvent>[1]["liteWriteStore"]>
  & NonNullable<Parameters<typeof listSessions>[1]["liteWriteStore"]>
  & NonNullable<Parameters<typeof listSessionEvents>[1]["liteWriteStore"]>;

type RegisterMemoryAccessRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  liteWriteStore: MemoryAccessLiteStoreLike;
  executionStateStore?: ExecutionStateStore | null;
  liteRecallAccess: RecallStoreAccess;
  requireStoreFeatureCapability: (capability: "sessions_graph" | "packs_export" | "packs_import") => void;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: MemoryAccessRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "write" | "recall") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "write" | "recall", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "write" | "recall") => Promise<InflightGateToken>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function registerMemoryAccessRoutes(args: RegisterMemoryAccessRoutesArgs) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    liteWriteStore,
    executionStateStore,
    liteRecallAccess,
    requireStoreFeatureCapability,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;
  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite memory-access routes only support AIONIS_EDITION=lite");
  }
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const writeEmbedder = embeddingSurfacePolicy.providerFor("write_auto_embed", embedder);
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(env);

  const writeDefaults = {
    defaultScope: env.MEMORY_SCOPE,
    defaultTenantId: env.MEMORY_TENANT_ID,
    maxTextLen: env.MAX_TEXT_LEN,
    piiRedaction: env.PII_REDACTION,
    allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
    shadowDualWriteEnabled: env.MEMORY_SHADOW_DUAL_WRITE_ENABLED,
    shadowDualWriteStrict: env.MEMORY_SHADOW_DUAL_WRITE_STRICT,
    embedder: writeEmbedder,
    liteWriteStore,
    learningControlReviewProviders: learningControlProviders.workflowProjection,
  };

  const runMemoryAccessRoute = async <TResult>(args: {
    req: MemoryAccessRequest;
    reply: FastifyReply;
    requestKind: MemoryAccessRequestKind;
    inflightKind: MemoryAccessInflightKind;
    requiredCapability?: "sessions_graph" | "packs_export" | "packs_import";
    bodyFactory?: (req: MemoryAccessRequest) => unknown;
    execute: (body: unknown) => Promise<TResult>;
  }): Promise<TResult> => {
    const { req, reply, requestKind, inflightKind, requiredCapability, bodyFactory, execute } = args;
    if (requiredCapability) requireStoreFeatureCapability(requiredCapability);
    const principal = await requireMemoryPrincipal(req);
    const rawBody = bodyFactory ? bodyFactory(req) : req.body;
    const body = withIdentityFromRequest(req, rawBody, principal, requestKind);
    await enforceRateLimit(req, reply, inflightKind);
    await enforceTenantQuota(req, reply, inflightKind, tenantFromBody(body));
    const gate = await acquireInflightSlot(inflightKind);
    try {
      return await execute(body);
    } finally {
      gate.release();
    }
  };
  const registerMemoryAccessRoute = <TResult>(args: {
    method: "get" | "post";
    path: string;
    requestKind: MemoryAccessRequestKind;
    inflightKind: MemoryAccessInflightKind;
    requiredCapability?: "sessions_graph" | "packs_export" | "packs_import";
    bodyFactory?: (req: MemoryAccessRequest) => unknown;
    execute: (body: unknown) => Promise<TResult>;
  }) => {
    const handler = async (req: MemoryAccessRequest, reply: FastifyReply) => {
      const out = await runMemoryAccessRoute({
        req,
        reply,
        requestKind: args.requestKind,
        inflightKind: args.inflightKind,
        requiredCapability: args.requiredCapability,
        bodyFactory: args.bodyFactory,
        execute: args.execute,
      });
      return reply.code(200).send(out);
    };
    if (args.method === "get") {
      app.get(args.path, handler);
      return;
    }
    app.post(args.path, handler);
  };

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/sessions",
    requestKind: "write",
    inflightKind: "write",
    requiredCapability: "sessions_graph",
    execute: (body) => createSession(body, writeDefaults),
  });

  registerMemoryAccessRoute({
    method: "get",
    path: "/v1/memory/sessions",
    requestKind: "find",
    inflightKind: "recall",
    requiredCapability: "sessions_graph",
    bodyFactory: (request) => asObject(request.query),
    execute: (input) =>
      listSessions(input, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        liteWriteStore,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/events",
    requestKind: "write",
    inflightKind: "write",
    requiredCapability: "sessions_graph",
    execute: (body) => writeSessionEvent(body, writeDefaults),
  });

  app.get("/v1/memory/sessions/:session_id/events", async (req: FastifyRequest<{ Querystring: Record<string, unknown>; Params: SessionEventsParams }>, reply: FastifyReply) => {
    const out = await runMemoryAccessRoute({
      req: req as MemoryAccessRequest,
      reply,
      requestKind: "find",
      inflightKind: "recall",
      requiredCapability: "sessions_graph",
      bodyFactory: (request) => ({
        ...asObject(request.query),
        session_id: String((request.params as SessionEventsParams)?.session_id ?? ""),
      }),
      execute: (input) =>
        listSessionEvents(input, {
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          liteWriteStore,
        }),
    });
    return reply.code(200).send(out);
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/packs/export",
    requestKind: "find",
    inflightKind: "recall",
    requiredCapability: "packs_export",
    bodyFactory: (request) => request.body ?? {},
    execute: (body) => exportMemoryPack(body, writeDefaults),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/packs/import",
    requestKind: "write",
    inflightKind: "write",
    requiredCapability: "packs_import",
    bodyFactory: (request) => request.body ?? {},
    execute: (body) => importMemoryPack(body, writeDefaults),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/trajectory/compile",
    requestKind: "trajectory_compile",
    inflightKind: "recall",
    execute: (body) =>
      Promise.resolve(buildTrajectoryCompileLite(body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
      })),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/delegation/records",
    requestKind: "delegation_records_write",
    inflightKind: "write",
    execute: (body) =>
      writeDelegationRecords(body, writeDefaults),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/delegation/records/find",
    requestKind: "delegation_records_find",
    inflightKind: "recall",
    execute: (body) =>
      findDelegationRecordsLite(
        liteWriteStore,
        body,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
      ),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/delegation/records/aggregate",
    requestKind: "delegation_records_aggregate",
    inflightKind: "recall",
    execute: (body) =>
      aggregateDelegationRecordsLite(
        liteWriteStore,
        body,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
      ),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/find",
    requestKind: "find",
    inflightKind: "recall",
    execute: (body) => memoryFindLite(liteWriteStore, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/continuity/review-pack",
    requestKind: "continuity_review_pack",
    inflightKind: "recall",
    execute: (body) =>
      buildContinuityReviewPackLite({
        liteWriteStore,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        consumerAgentId: env.LITE_LOCAL_ACTOR_ID,
        executionStateStore: executionStateStore ?? null,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/agent/inspect",
    requestKind: "agent_memory_inspect",
    inflightKind: "recall",
    execute: (body) =>
      buildAgentMemoryInspectLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
        executionStateStore: executionStateStore ?? null,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/agent/review-pack",
    requestKind: "agent_memory_review_pack",
    inflightKind: "recall",
    execute: (body) =>
      buildAgentMemoryReviewPackLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
        executionStateStore: executionStateStore ?? null,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/agent/resume-pack",
    requestKind: "agent_memory_resume_pack",
    inflightKind: "recall",
    execute: (body) =>
      buildAgentMemoryResumePackLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
        executionStateStore: executionStateStore ?? null,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/agent/handoff-pack",
    requestKind: "agent_memory_handoff_pack",
    inflightKind: "recall",
    execute: (body) =>
      buildAgentMemoryHandoffPackLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
        executionStateStore: executionStateStore ?? null,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/execution/introspect",
    requestKind: "execution_introspect",
    inflightKind: "recall",
    execute: (body) =>
      buildExecutionMemoryIntrospectionLite(
        liteWriteStore,
        body,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
        env.LITE_LOCAL_ACTOR_ID,
      ),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/evolution/review-pack",
    requestKind: "evolution_review_pack",
    inflightKind: "recall",
    execute: (body) =>
      buildEvolutionReviewPackLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/action/retrieval",
    requestKind: "action_retrieval",
    inflightKind: "recall",
    execute: (body) =>
      buildActionRetrievalLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/experience/intelligence",
    requestKind: "experience_intelligence",
    inflightKind: "recall",
    execute: (body) =>
      buildExperienceIntelligenceLite({
        liteWriteStore,
        liteRecallAccess,
        embedder,
        body,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        defaultActorId: env.LITE_LOCAL_ACTOR_ID,
      }),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/kickoff/recommendation",
    requestKind: "kickoff_recommendation",
    inflightKind: "recall",
    execute: async (body) => {
      const parsed = ExperienceIntelligenceRequest.parse(body);
      return buildKickoffRecommendationResponseFromExperience(
        await buildExperienceIntelligenceLite({
          liteWriteStore,
          liteRecallAccess,
          embedder,
          body,
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          defaultActorId: env.LITE_LOCAL_ACTOR_ID,
        }),
        {
          editBoundaryContext: parsed.edit_boundary_context ?? null,
          executionEvidence: parsed.execution_evidence,
        },
      );
    },
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/resolve",
    requestKind: "resolve",
    inflightKind: "recall",
    execute: (body) => memoryResolveLite(liteWriteStore, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID),
  });

  registerMemoryAccessRoute({
    method: "post",
    path: "/v1/memory/anchors/rehydrate_payload",
    requestKind: "rehydrate_payload",
    inflightKind: "recall",
    execute: (body) => rehydrateAnchorPayloadLite(liteWriteStore, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, env.LITE_LOCAL_ACTOR_ID),
  });
}
