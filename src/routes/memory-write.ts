import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { ExecutionTreeStore } from "../execution/tree-store.js";
import {
  applyAutoExecutionTreeFromSlots,
  isExecutionTreeDefaultDisabled,
} from "../execution/tree-auto.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import {
  buildLearningControlHttpClientConfig,
  buildLiteLearningControlRuntimeProviders,
  type LiteLearningControlRuntimeProviderBuilderOptions,
} from "../app/learning-control-runtime-providers.js";
import { collectExecutionWriteOverlaySlots } from "../memory/execution-slot-surface.js";
import {
  prepareMemoryWrite,
  type PreparedWrite,
  type WriteResult,
} from "../memory/write.js";
import { commitLitePreparedWriteWithProjection } from "../memory/lite-projected-write-commit.js";
import { createHttpMemoryLifecycleRelationCandidateProducer } from "../memory/memory-lifecycle-relation-model-producer.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import { HttpError } from "../util/http.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type MemoryWriteRequest = FastifyRequest<{ Body: unknown }>;

type WriteWarningLike = { code: string; message: string; details?: Record<string, unknown> };
type LiteInlineEmbeddingResultLike = {
  attempted: number;
  updated: number;
  failed: number;
  error?: string | null;
} | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isExecutionTreeDefaultDisabledRequest(body: unknown): boolean {
  return isExecutionTreeDefaultDisabled(asRecord(body));
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
  executionTreeStore?: ExecutionTreeStore | null;
  learningControlRuntimeProviderBuilderOptions?: LiteLearningControlRuntimeProviderBuilderOptions;
}) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    executionStateStore,
    executionTreeStore,
  } = args;
  assertLocalStoreRuntimeEdition(env, "local-store memory-write route");
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const writeEmbedder = embeddingSurfacePolicy.providerFor("write_auto_embed", embedder);
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(
    env,
    args.learningControlRuntimeProviderBuilderOptions,
  );
  const lifecycleRelationCandidateProducer =
    env.MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED
      ? (() => {
          const httpClientConfig = buildLearningControlHttpClientConfig(env, args.learningControlRuntimeProviderBuilderOptions);
          return httpClientConfig
            ? createHttpMemoryLifecycleRelationCandidateProducer({
                config: httpClientConfig,
                maxPairs: env.MEMORY_LIFECYCLE_RELATION_MODEL_MAX_PAIRS,
              })
            : undefined;
        })()
      : undefined;
  const runCommittedMemoryWrite = async (args: {
    prepared: PreparedWrite;
  }): Promise<{
    out: WriteResult;
    liteInlineEmbedding: LiteInlineEmbeddingResultLike;
  }> => {
    const { prepared } = args;
    const committed = await commitLitePreparedWriteWithProjection({
      prepared,
      liteWriteStore,
      embedder: writeEmbedder,
      learningControlReviewProviders: learningControlProviders.workflowProjection,
      writeOptions: {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
        ...(lifecycleRelationCandidateProducer
          ? { lifecycleRelationCandidateProducer }
          : {}),
      },
    });
    if (committed.liteInlineEmbedding?.updated) {
      committed.out.embedding_backfill = {
        completed_inline: true,
        attempted_nodes: committed.liteInlineEmbedding.attempted,
        updated_nodes: committed.liteInlineEmbedding.updated,
      };
    } else if ((committed.liteInlineEmbedding?.failed ?? 0) > 0) {
      committed.out.embedding_backfill = {
        failed_inline: true,
        attempted_nodes: committed.liteInlineEmbedding?.attempted ?? 0,
        failed_nodes: committed.liteInlineEmbedding?.failed ?? 0,
        ...(committed.liteInlineEmbedding?.error ? { error: committed.liteInlineEmbedding.error } : {}),
      };
    }
    return {
      out: committed.out,
      liteInlineEmbedding: committed.liteInlineEmbedding,
    };
  };
  const collectWriteWarnings = (args: {
    out: WriteResult;
    prepared: PreparedWrite;
    liteInlineEmbedding: LiteInlineEmbeddingResultLike;
  }): WriteWarningLike[] => {
    const { scope, tenantId } = resolveWriteScopeTenant({
      out: args.out,
      prepared: args.prepared,
      env,
    });
    const warnings: WriteWarningLike[] = [];
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
    prepared: PreparedWrite;
    out: WriteResult;
    executionOverlays: ReturnType<typeof collectExecutionWriteOverlaySlots> | null;
    executionTreeDefaultDisabled: boolean;
  }) => {
    if (executionStateStore && args.executionOverlays) {
      for (const state of args.executionOverlays.states) {
        executionStateStore.put(state);
      }
      for (const transition of args.executionOverlays.transitions) {
        executionStateStore.applyTransition(transition);
      }
    }
    if (executionTreeStore && args.executionOverlays) {
      for (const tree of args.executionOverlays.trees) {
        const hasOperationsForTree = args.executionOverlays.treeOperations.some(
          (operation) => operation.scope === tree.scope && operation.tree_id === tree.tree_id,
        );
        if (!hasOperationsForTree || !executionTreeStore.has(tree.scope, tree.tree_id)) {
          executionTreeStore.put(tree);
        }
      }
      for (const operation of args.executionOverlays.treeOperations) {
        executionTreeStore.applyOperation(operation);
      }
      if (!args.executionTreeDefaultDisabled && env.EXECUTION_TREE_DEFAULT_ENABLED !== false) {
        for (const node of args.prepared.nodes) {
          const slots = asRecord(node.slots);
          if (!slots) continue;
          applyAutoExecutionTreeFromSlots({
            executionTreeStore,
            slots,
            title: typeof node.title === "string" ? node.title : null,
            textSummary: typeof node.text_summary === "string" ? node.text_summary : null,
          });
        }
      }
    }
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
    embedding_backfill_completed_inline: args.out.embedding_backfill && "completed_inline" in args.out.embedding_backfill
      ? args.out.embedding_backfill.updated_nodes
      : 0,
    embedding_backfill_failed_inline: args.out.embedding_backfill && "failed_inline" in args.out.embedding_backfill
      ? args.out.embedding_backfill.failed_nodes
      : 0,
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
    const executionOverlays = executionStateStore || executionTreeStore
      ? collectExecutionWriteOverlaySlots(prepared.nodes)
      : null;
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

    return {
      prepared,
      executionOverlays,
    };
  };
  const finalizeWriteRoute = async (args: {
    req: MemoryWriteRequest;
    prepared: PreparedWrite;
    executionOverlays: ReturnType<typeof collectExecutionWriteOverlaySlots> | null;
    out: WriteResult;
    executionTreeDefaultDisabled: boolean;
    liteInlineEmbedding: LiteInlineEmbeddingResultLike;
    ms: number;
  }) => {
    const warnings = collectWriteWarnings({
      out: args.out,
      prepared: args.prepared,
      liteInlineEmbedding: args.liteInlineEmbedding,
    });
    const response = {
      ...args.out,
      recallable_node_count: args.out.nodes.length,
      edge_count: args.out.edges.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    await applyWriteSideEffects({
      prepared: args.prepared,
      out: args.out,
      executionOverlays: args.executionOverlays,
      executionTreeDefaultDisabled: args.executionTreeDefaultDisabled,
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
      const { prepared, executionOverlays } = await prepareWriteRouteState(body);
      const executionTreeDefaultDisabled = isExecutionTreeDefaultDisabledRequest(body);
      const { out, liteInlineEmbedding } = await runCommittedMemoryWrite({ prepared });
      const response = await finalizeWriteRoute({
        req,
        prepared,
        out,
        executionOverlays,
        executionTreeDefaultDisabled,
        liteInlineEmbedding,
        ms: performance.now() - t0,
      });
      return reply.code(200).send(response);
    } finally {
      gate.release();
    }
  });
}
