import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import {
  buildLiteLearningControlRuntimeProviders,
  type LiteLearningControlRuntimeProviderBuilderOptions,
} from "../app/learning-control-runtime-providers.js";
import { mirrorPreparedWriteToEmbeddedRuntime, type EmbeddedWriteMirrorRuntime } from "../memory/embedded-write-bridge.js";
import { collectExecutionWriteOverlaySlots } from "../memory/execution-slot-surface.js";
import {
  computeEffectiveWritePolicy,
  prepareMemoryWrite,
  type EffectiveWritePolicy,
  type PreparedWrite,
  type WriteResult,
} from "../memory/write.js";
import { commitLitePreparedWriteWithProjection } from "../memory/lite-projected-write-commit.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import { HttpError } from "../util/http.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type MemoryWriteRequest = FastifyRequest<{ Body: unknown }>;

type PreparedWriteRouteState = PreparedWrite & {
  trigger_topic_cluster?: boolean;
  topic_cluster_async?: boolean;
};

type WriteWarningLike = { code: string; message: string; details?: Record<string, unknown> };
type LiteInlineEmbeddingResultLike = { updated: number; failed: number; error?: string | null } | null;

function isEnqueuedTopicCluster(result: WriteResult["topic_cluster"]): result is { enqueued: true } {
  return !!result && "enqueued" in result && result.enqueued === true;
}

function resolveWriteScopeTenant(args: {
  out: WriteResult;
  prepared: PreparedWrite;
  env: Env;
}) {
  return {
    scope: args.out.scope ?? args.prepared.scope_public ?? args.env.MEMORY_SCOPE,
    tenantId: args.out.tenant_id ?? args.prepared.tenant_id ?? args.env.MEMORY_TENANT_ID,
  };
}

export function registerMemoryWriteRoutes(args: {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  embeddedRuntime: EmbeddedWriteMirrorRuntime | null;
  liteWriteStore: LiteWriteStore;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: "write",
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "write") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "write", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "write") => Promise<InflightGateToken>;
  executionStateStore?: ExecutionStateStore | null;
  learningControlRuntimeProviderBuilderOptions?: LiteLearningControlRuntimeProviderBuilderOptions;
}) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    embeddedRuntime,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    executionStateStore,
  } = args;
  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite memory-write route only supports AIONIS_EDITION=lite");
  }
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const writeEmbedder = embeddingSurfacePolicy.providerFor("write_auto_embed", embedder);
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(
    env,
    args.learningControlRuntimeProviderBuilderOptions,
  );
  const topicClusterSurfaceEnabled = embeddingSurfacePolicy.isEnabled("topic_cluster");
  const resolveWritePolicy = (computedPolicy: EffectiveWritePolicy): EffectiveWritePolicy => ({
    ...computedPolicy,
    trigger_topic_cluster: computedPolicy.trigger_topic_cluster && topicClusterSurfaceEnabled,
  });
  const runCommittedMemoryWrite = async (args: {
    prepared: PreparedWriteRouteState;
    policy: EffectiveWritePolicy;
  }): Promise<{
    out: WriteResult;
    forcedLiteTopicClusterAsync: boolean;
    liteInlineEmbedding: LiteInlineEmbeddingResultLike;
  }> => {
    const { prepared, policy } = args;
    const forcedLiteTopicClusterAsync = policy.trigger_topic_cluster && !policy.topic_cluster_async;
    prepared.trigger_topic_cluster = policy.trigger_topic_cluster;
    // Lite write path cannot safely run sync clustering inside the SQLite write transaction.
    prepared.topic_cluster_async = policy.trigger_topic_cluster ? true : policy.topic_cluster_async;
    const committed = await commitLitePreparedWriteWithProjection({
      prepared,
      liteWriteStore,
      embedder: writeEmbedder,
      learningControlReviewProviders: learningControlProviders.workflowProjection,
      writeOptions: {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
        shadowDualWriteEnabled: env.MEMORY_SHADOW_DUAL_WRITE_ENABLED,
        shadowDualWriteStrict: env.MEMORY_SHADOW_DUAL_WRITE_STRICT,
      },
    });
    return {
      out: committed.out,
      forcedLiteTopicClusterAsync,
      liteInlineEmbedding: committed.liteInlineEmbedding,
    };
  };
  const collectWriteWarnings = (args: {
    out: WriteResult;
    prepared: PreparedWrite;
    computedPolicy: EffectiveWritePolicy;
    policy: EffectiveWritePolicy;
    forcedLiteTopicClusterAsync: boolean;
    liteInlineEmbedding: LiteInlineEmbeddingResultLike;
  }): WriteWarningLike[] => {
    const { scope, tenantId } = resolveWriteScopeTenant({
      out: args.out,
      prepared: args.prepared,
      env,
    });
    const warnings: WriteWarningLike[] = [];
    if (args.forcedLiteTopicClusterAsync) {
      warnings.push({
        code: "lite_topic_cluster_forced_async",
        message: "lite edition forces topic clustering to async mode during memory write",
        details: {
          scope,
          tenant_id: tenantId,
          requested_async: false,
          applied_async: true,
        },
      });
    }
    if (args.computedPolicy.trigger_topic_cluster && !args.policy.trigger_topic_cluster) {
      warnings.push({
        code: "embedding_surface_disabled_topic_cluster",
        message: "topic clustering requested but disabled by embedding surface policy",
        details: {
          scope,
          tenant_id: tenantId,
          surface: "topic_cluster",
        },
      });
    }
    if (args.liteInlineEmbedding?.updated) {
      warnings.push({
        code: "lite_embedding_backfill_completed_inline",
        message: "lite edition completed embedding backfill inline after memory write",
        details: {
          scope,
          tenant_id: tenantId,
          updated_nodes: args.liteInlineEmbedding.updated,
        },
      });
    }
    if ((args.liteInlineEmbedding?.failed ?? 0) > 0) {
      warnings.push({
        code: "lite_embedding_backfill_inline_failed",
        message: "lite edition failed to complete inline embedding backfill; recallability may remain degraded",
        details: {
          scope,
          tenant_id: tenantId,
          failed_nodes: args.liteInlineEmbedding?.failed ?? 0,
          error: args.liteInlineEmbedding?.error ?? null,
        },
      });
    }
    if ((args.out.nodes?.length ?? 0) === 0) {
      warnings.push({
        code: "write_no_nodes",
        message: "write committed with 0 nodes; no new recallable memory was added by this request",
        details: {
          scope,
          tenant_id: tenantId,
          edge_count: args.out.edges?.length ?? 0,
        },
      });
    }
    return warnings;
  };
  const applyWriteSideEffects = async (args: {
    prepared: PreparedWriteRouteState;
    out: WriteResult;
    executionOverlays: ReturnType<typeof collectExecutionWriteOverlaySlots> | null;
  }) => {
    if (executionStateStore && args.executionOverlays) {
      for (const state of args.executionOverlays.states) {
        executionStateStore.put(state);
      }
      for (const transition of args.executionOverlays.transitions) {
        executionStateStore.applyTransition(transition);
      }
    }
    await mirrorPreparedWriteToEmbeddedRuntime({
      embeddedRuntime,
      prepared: args.prepared,
      out: args.out,
    });
  };
  const buildWriteLogPayload = (args: {
    out: WriteResult;
    warnings: WriteWarningLike[];
    scope: string;
    tenantId: string;
    ms: number;
  }) => ({
    scope: args.scope,
    tenant_id: args.tenantId,
    commit_id: args.out.commit_id,
    nodes: args.out.nodes?.length ?? 0,
    edges: args.out.edges?.length ?? 0,
    embedding_backfill_enqueued: !!args.out.embedding_backfill?.enqueued,
    embedding_pending_nodes: args.out.embedding_backfill?.pending_nodes ?? 0,
    topic_cluster_enqueued: isEnqueuedTopicCluster(args.out.topic_cluster),
    distillation_enabled: args.out.distillation?.enabled === true,
    distillation_sources: args.out.distillation?.sources_considered ?? 0,
    distilled_evidence_nodes: args.out.distillation?.generated_evidence_nodes ?? 0,
    distilled_fact_nodes: args.out.distillation?.generated_fact_nodes ?? 0,
    warnings: args.warnings.map((warning) => warning.code),
    ms: args.ms,
  });
  const prepareWriteRouteState = async (body: unknown) => {
    const prepared = await prepareMemoryWrite(
      body,
      env.MEMORY_SCOPE,
      env.MEMORY_TENANT_ID,
      {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      },
      writeEmbedder,
    );
    const preparedForRoute: PreparedWriteRouteState = prepared;
    const executionOverlays = executionStateStore ? collectExecutionWriteOverlaySlots(preparedForRoute.nodes) : null;
    if (env.MEMORY_WRITE_REQUIRE_NODES && prepared.nodes.length === 0) {
      throw new HttpError(
        400,
        "write_nodes_required",
        "write request must include at least one node when MEMORY_WRITE_REQUIRE_NODES=true",
        {
          tenant_id: prepared.tenant_id,
          scope: prepared.scope_public,
          node_count: prepared.nodes.length,
          edge_count: prepared.edges.length,
        },
      );
    }

    const computedPolicy = computeEffectiveWritePolicy(preparedForRoute, {
      autoTopicClusterOnWrite: env.AUTO_TOPIC_CLUSTER_ON_WRITE,
      topicClusterAsyncOnWrite: env.TOPIC_CLUSTER_ASYNC_ON_WRITE,
    });

    return {
      prepared,
      preparedForRoute,
      executionOverlays,
      computedPolicy,
      policy: resolveWritePolicy(computedPolicy),
    };
  };
  const finalizeWriteRoute = async (args: {
    req: MemoryWriteRequest;
    prepared: PreparedWrite;
    preparedForRoute: PreparedWriteRouteState;
    executionOverlays: ReturnType<typeof collectExecutionWriteOverlaySlots> | null;
    out: WriteResult;
    computedPolicy: EffectiveWritePolicy;
    policy: EffectiveWritePolicy;
    forcedLiteTopicClusterAsync: boolean;
    liteInlineEmbedding: LiteInlineEmbeddingResultLike;
    ms: number;
  }) => {
    const warnings = collectWriteWarnings({
      out: args.out,
      prepared: args.prepared,
      computedPolicy: args.computedPolicy,
      policy: args.policy,
      forcedLiteTopicClusterAsync: args.forcedLiteTopicClusterAsync,
      liteInlineEmbedding: args.liteInlineEmbedding,
    });
    const response = warnings.length > 0 ? { ...args.out, warnings } : args.out;

    await applyWriteSideEffects({
      prepared: args.preparedForRoute,
      out: args.out,
      executionOverlays: args.executionOverlays,
    });

    const writeContext = resolveWriteScopeTenant({
      out: args.out,
      prepared: args.prepared,
      env,
    });
    args.req.log.info(
      {
        write: buildWriteLogPayload({
          out: args.out,
          warnings,
          scope: writeContext.scope,
          tenantId: writeContext.tenantId,
          ms: args.ms,
        }),
      },
      "memory write",
    );

    return response;
  };

  app.post("/v1/memory/write", async (req: MemoryWriteRequest, reply: FastifyReply) => {
    const t0 = performance.now();
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "write");
    await enforceRateLimit(req, reply, "write");
    await enforceTenantQuota(req, reply, "write", tenantFromBody(body));
    const gate = await acquireInflightSlot("write");
    try {
      const { prepared, preparedForRoute, executionOverlays, computedPolicy, policy } = await prepareWriteRouteState(body);
      const { out, forcedLiteTopicClusterAsync, liteInlineEmbedding } = await runCommittedMemoryWrite({
        prepared: preparedForRoute,
        policy,
      });
      const response = await finalizeWriteRoute({
        req,
        prepared,
        preparedForRoute,
        out,
        executionOverlays,
        computedPolicy,
        policy,
        forcedLiteTopicClusterAsync,
        liteInlineEmbedding,
        ms: performance.now() - t0,
      });
      return reply.code(200).send(response);
    } finally {
      gate.release();
    }
  });
}
