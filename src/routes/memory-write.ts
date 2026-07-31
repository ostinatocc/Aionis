import type { Env } from "../config.js";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { ExecutionTreeStore } from "../execution/tree-store.js";
import {
  applyAutoExecutionTreeFromSlots,
  isExecutionTreeDefaultDisabled,
} from "../execution/tree-auto.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { collectExecutionWriteOverlaySlots } from "../memory/execution-slot-surface.js";
import {
  prepareMemoryWrite,
  type PreparedWrite,
  type WriteResult,
} from "../memory/write.js";
import {
  completeLiteInlineEmbeddings,
  persistLitePreparedWrite,
  prepareLiteProjectedWrite,
} from "../memory/lite-projected-write-commit.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { SqliteTransactionRunner } from "../store/sqlite-transaction-runner.js";
import { HttpError } from "../util/http.js";

type WriteWarningLike = { code: string; message: string; details?: Record<string, unknown> };
type LiteInlineEmbeddingResultLike = {
  attempted: number;
  updated: number;
  failed: number;
  error?: string | null;
} | null;

export type MemoryWriteRouteServiceResult = {
  response: WriteResult & {
    recallable_node_count: number;
    edge_count: number;
    warnings?: WriteWarningLike[];
  };
  out: WriteResult;
  prepared: PreparedWrite;
  executionOverlays: ReturnType<typeof collectExecutionWriteOverlaySlots> | null;
  liteInlineEmbedding: LiteInlineEmbeddingResultLike;
};

export type MemoryWriteRouteServiceOptions = {
  log?: { info: (context: unknown, message?: string) => unknown };
  executionTreeDefaultDisabled?: boolean;
  startedAt?: number;
};

export type MemoryWriteRoutePlan = {
  prepared: PreparedWrite;
  executionOverlays: ReturnType<typeof collectExecutionWriteOverlaySlots> | null;
  executionTreeDefaultDisabled: boolean;
  startedAt: number;
  log?: MemoryWriteRouteServiceOptions["log"];
  projectionBase: { id: string; commit_hash: string } | null;
};

export type MemoryWriteRouteService = {
  transactionRunner(): SqliteTransactionRunner;
  prepare(body: unknown, options?: MemoryWriteRouteServiceOptions): Promise<MemoryWriteRoutePlan>;
  persist(plan: MemoryWriteRoutePlan): Promise<WriteResult>;
  receipt(plan: MemoryWriteRoutePlan, out: WriteResult): Promise<MemoryWriteRouteServiceResult["response"]>;
  finalize(plan: MemoryWriteRoutePlan, out: WriteResult): Promise<MemoryWriteRouteServiceResult>;
  commit(body: unknown, options?: MemoryWriteRouteServiceOptions): Promise<MemoryWriteRouteServiceResult>;
};

export type MemoryWriteRouteServiceArgs = {
  env: Env;
  embedder: EmbeddingProvider | null;
  liteWriteStore: LiteWriteStore;
  executionStateStore?: ExecutionStateStore | null;
  executionTreeStore?: ExecutionTreeStore | null;
};

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

function sameProjectionBase(
  left: { id: string; commit_hash: string } | null,
  right: { id: string; commit_hash: string } | null,
): boolean {
  return left?.id === right?.id && left?.commit_hash === right?.commit_hash;
}

export function createMemoryWriteRouteService(args: MemoryWriteRouteServiceArgs): MemoryWriteRouteService {
  const {
    env,
    embedder,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
  } = args;
  const atomicRunner = liteWriteStore.transactionRunner();
  if (executionStateStore && executionStateStore.transactionRunner !== atomicRunner) {
    throw new Error("memory write execution state store must share the Lite write transaction runner");
  }
  if (executionTreeStore && executionTreeStore.transactionRunner !== atomicRunner) {
    throw new Error("memory write execution tree store must share the Lite write transaction runner");
  }
  assertLocalStoreRuntimeEdition(env, "local-store memory-write route");
  const prepareCommittedMemoryWrite = async (prepared: PreparedWrite): Promise<void> => {
    await prepareLiteProjectedWrite({
      prepared,
      liteWriteStore,
    });
  };
  const persistCommittedMemoryWrite = async (prepared: PreparedWrite): Promise<WriteResult> =>
    persistLitePreparedWrite({
      prepared,
      liteWriteStore,
      writeOptions: {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      },
    });
  const completeCommittedMemoryWrite = async (
    prepared: PreparedWrite,
    out: WriteResult,
  ): Promise<LiteInlineEmbeddingResultLike> => {
    let liteInlineEmbedding: LiteInlineEmbeddingResultLike;
    try {
      liteInlineEmbedding = await completeLiteInlineEmbeddings({
        prepared,
        embedder,
        liteWriteStore,
        timeoutMs: typeof env.LITE_INLINE_EMBEDDING_TIMEOUT_MS === "number"
          ? env.LITE_INLINE_EMBEDDING_TIMEOUT_MS
          : 12_000,
      });
    } catch (error) {
      process.emitWarning(
        `Memory write post-commit embedding failed: ${error instanceof Error ? error.message : String(error)}`,
        { code: "AIONIS_POST_COMMIT_EMBEDDING_FAILED" },
      );
      return null;
    }
    if (liteInlineEmbedding?.updated) {
      out.embedding_backfill = {
        completed_inline: true,
        attempted_nodes: liteInlineEmbedding.attempted,
        updated_nodes: liteInlineEmbedding.updated,
      };
    } else if (liteInlineEmbedding && liteInlineEmbedding.failed > 0) {
      out.embedding_backfill = {
        failed_inline: true,
        attempted_nodes: liteInlineEmbedding.attempted,
        failed_nodes: liteInlineEmbedding.failed,
        ...(liteInlineEmbedding.error ? { error: liteInlineEmbedding.error } : {}),
      };
    }
    return liteInlineEmbedding;
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
      const initializedStates = new Set<string>();
      for (const state of args.executionOverlays.states) {
        const key = `${state.scope}\u0000${state.state_id}`;
        const existed = executionStateStore.has(state.scope, state.state_id);
        executionStateStore.initialize(state);
        if (!existed) initializedStates.add(key);
      }
      for (const parsed of args.executionOverlays.transitions) {
        const key = `${parsed.scope}\u0000${parsed.state_id}`;
        const current = executionStateStore.get(parsed.scope, parsed.state_id);
        const transition = parsed.expected_revision == null && current && initializedStates.has(key)
          ? { ...parsed, expected_revision: current.revision }
          : parsed;
        executionStateStore.applyTransition(transition);
      }
    }
    if (executionTreeStore && args.executionOverlays) {
      const initializedTrees = new Set<string>();
      for (const tree of args.executionOverlays.trees) {
        const key = `${tree.scope}\u0000${tree.tree_id}`;
        const existed = executionTreeStore.has(tree.scope, tree.tree_id);
        executionTreeStore.initialize(tree);
        if (!existed) initializedTrees.add(key);
      }
      for (const parsed of args.executionOverlays.treeOperations) {
        const key = `${parsed.scope}\u0000${parsed.tree_id}`;
        const current = executionTreeStore.get(parsed.scope, parsed.tree_id);
        const operation = parsed.expected_revision == null && current && initializedTrees.has(key)
          ? { ...parsed, expected_revision: current.revision }
          : parsed;
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
      embedder,
    );
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
    const projectionBase = await liteWriteStore.latestCommit(prepared.scope);
    await prepareCommittedMemoryWrite(prepared);
    const projectionBaseAfter = await liteWriteStore.latestCommit(prepared.scope);
    if (!sameProjectionBase(projectionBase, projectionBaseAfter)) {
      throw new HttpError(409, "write_projection_stale", "memory changed while write projection was being prepared", {
        scope: prepared.scope_public,
        projection_base_commit_id: projectionBase?.id ?? null,
        current_commit_id: projectionBaseAfter?.id ?? null,
        retryable: true,
      });
    }
    return {
      prepared,
      executionOverlays: executionStateStore || executionTreeStore
        ? collectExecutionWriteOverlaySlots(prepared.nodes)
        : null,
      projectionBase,
    };
  };
  const finalizeWriteRoute = async (args: {
    log?: { info: (context: unknown, message?: string) => unknown };
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

    const writeContext = resolveWriteScopeTenant({
      out: args.out,
      prepared: args.prepared,
      env,
    });
    try {
      args.log?.info(
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
    } catch (error) {
      process.emitWarning(
        `Memory write post-commit logging failed: ${error instanceof Error ? error.message : String(error)}`,
        { code: "AIONIS_MEMORY_WRITE_POST_COMMIT_LOG_FAILED" },
      );
    }

    return response;
  };

  const prepare = async (
    body: unknown,
    options: MemoryWriteRouteServiceOptions = {},
  ): Promise<MemoryWriteRoutePlan> => {
    const { prepared, executionOverlays, projectionBase } = await prepareWriteRouteState(body);
    return {
      prepared,
      executionOverlays,
      executionTreeDefaultDisabled:
        options.executionTreeDefaultDisabled ?? isExecutionTreeDefaultDisabledRequest(body),
      startedAt: options.startedAt ?? performance.now(),
      log: options.log,
      projectionBase,
    };
  };
  const persist = async (plan: MemoryWriteRoutePlan): Promise<WriteResult> => {
    if (!liteWriteStore.transactionRunner().inTransaction()) {
      throw new Error("memory write persist requires the configured atomic write transaction");
    }
    const currentProjectionBase = await liteWriteStore.latestCommit(plan.prepared.scope);
    if (!sameProjectionBase(plan.projectionBase, currentProjectionBase)) {
      throw new HttpError(409, "write_projection_stale", "memory changed after write projection was prepared", {
        scope: plan.prepared.scope_public,
        projection_base_commit_id: plan.projectionBase?.id ?? null,
        current_commit_id: currentProjectionBase?.id ?? null,
        retryable: true,
      });
    }
    const out = await persistCommittedMemoryWrite(plan.prepared);
    await applyWriteSideEffects({
      prepared: plan.prepared,
      out,
      executionOverlays: plan.executionOverlays,
      executionTreeDefaultDisabled: plan.executionTreeDefaultDisabled,
    });
    return out;
  };
  const finalize = async (
    plan: MemoryWriteRoutePlan,
    out: WriteResult,
  ): Promise<MemoryWriteRouteServiceResult> => {
    const liteInlineEmbedding = await completeCommittedMemoryWrite(plan.prepared, out);
    const response = await finalizeWriteRoute({
      log: plan.log,
      prepared: plan.prepared,
      out,
      executionOverlays: plan.executionOverlays,
      executionTreeDefaultDisabled: plan.executionTreeDefaultDisabled,
      liteInlineEmbedding,
      ms: performance.now() - plan.startedAt,
    });
    return {
      response,
      out,
      prepared: plan.prepared,
      executionOverlays: plan.executionOverlays,
      liteInlineEmbedding,
    };
  };
  const receipt = async (
    plan: MemoryWriteRoutePlan,
    out: WriteResult,
  ): Promise<MemoryWriteRouteServiceResult["response"]> => await finalizeWriteRoute({
    prepared: plan.prepared,
    out,
    executionOverlays: plan.executionOverlays,
    executionTreeDefaultDisabled: plan.executionTreeDefaultDisabled,
    liteInlineEmbedding: null,
    ms: performance.now() - plan.startedAt,
  });

  return {
    transactionRunner: () => liteWriteStore.transactionRunner(),
    prepare,
    persist,
    receipt,
    finalize,
    async commit(body: unknown, options: MemoryWriteRouteServiceOptions = {}) {
      const plan = await prepare(body, options);
      const out = await liteWriteStore.withTx(() => persist(plan));
      return await finalize(plan, out);
    },
  };
}
