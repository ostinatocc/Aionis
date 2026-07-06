import type { EmbeddingProvider } from "../embeddings/types.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import type { AssociativeLinkTriggerOrigin } from "./associative-linking-types.js";
import type { MemoryLifecycleRelationCandidateProducer } from "./memory-lifecycle-adjudicator.js";
import { applyPreparedMemoryWrite, type PreparedWrite } from "./write.js";
import { projectWorkflowCandidatesFromPreparedWrite } from "./workflow-write-projection.js";

export type LiteWorkflowProjectionStore = {
  findExecutionNativeNodes: (args: {
    scope: string;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    executionKind?: "workflow_candidate" | "workflow_anchor" | null;
    workflowSignature?: string | null;
    limit: number;
    offset: number;
  }) => Promise<{ rows: Array<{ id: string; client_id?: string | null; slots?: Record<string, unknown> }>; has_more: boolean }>;
  findLatestNodeByClientId: (scope: string, type: string, clientId: string) => Promise<{ id: string } | null>;
  findNodes: (args: {
    scope: string;
    type?: string | null;
    clientId?: string | null;
    slotsContains?: Record<string, unknown> | null;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    limit: number;
    offset: number;
  }) => Promise<{ rows: Array<{ id: string; client_id?: string | null; slots?: Record<string, unknown> }>; has_more: boolean }>;
};

export type LiteInlineEmbeddingStore = {
  withTx: <T>(fn: () => Promise<T>) => Promise<T>;
  readyEmbeddingNodeIds: (scope: string, ids: string[]) => Promise<Set<string>>;
  setNodeEmbeddingReady: (args: {
    scope: string;
    id: string;
    embedding: number[];
    embeddingModel: string;
  }) => Promise<void>;
  setNodeEmbeddingFailed: (args: {
    scope: string;
    id: string;
    error: string;
  }) => Promise<void>;
};

export type LiteProjectedWriteStore = WriteStoreAccess & LiteWorkflowProjectionStore & LiteInlineEmbeddingStore;

class LiteInlineEmbeddingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`inline embedding timed out after ${timeoutMs}ms`);
    this.name = "LiteInlineEmbeddingTimeoutError";
  }
}

async function embedWithDeadline(
  embedder: EmbeddingProvider,
  texts: string[],
  timeoutMs: number | null | undefined,
): Promise<number[][]> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return embedder.embed(texts);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      embedder.embed(texts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LiteInlineEmbeddingTimeoutError(Math.trunc(timeoutMs))), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function appendLiteWorkflowProjection(args: {
  prepared: PreparedWrite;
  liteWriteStore: LiteWorkflowProjectionStore;
  learningControlReviewProviders?: Parameters<typeof projectWorkflowCandidatesFromPreparedWrite>[0]["learningControlReviewProviders"];
}): Promise<void> {
  const projection = await projectWorkflowCandidatesFromPreparedWrite({
    scope: args.prepared.scope,
    nodes: args.prepared.nodes,
    liteWriteStore: args.liteWriteStore,
    learningControlReviewProviders: args.learningControlReviewProviders,
  });
  if (projection.nodes.length > 0) {
    args.prepared.nodes.push(...projection.nodes);
  }
  if (projection.edges.length > 0) {
    args.prepared.edges.push(...projection.edges);
  }
}

async function completeLiteInlineEmbeddings(args: {
  prepared: PreparedWrite;
  embedder: EmbeddingProvider | null;
  liteWriteStore: LiteInlineEmbeddingStore;
  timeoutMs?: number | null;
}): Promise<{
  attempted: number;
  updated: number;
  failed: number;
  error?: string;
} | null> {
  const { prepared, embedder, liteWriteStore } = args;
  if (!embedder || !prepared.auto_embed_effective) return null;

  const planned = prepared.nodes
    .filter((node) => !node.embedding && typeof node.embed_text === "string" && node.embed_text.trim().length > 0)
    .map((node) => ({
      id: node.id,
      text: String(node.embed_text),
    }));
  if (planned.length === 0) return null;

  const ready = await liteWriteStore.readyEmbeddingNodeIds(prepared.scope, planned.map((node) => node.id));
  const pending = planned.filter((node) => !ready.has(node.id));
  if (pending.length === 0) {
    return {
      attempted: planned.length,
      updated: 0,
      failed: 0,
    };
  }

  let vectors: number[][];
  try {
    vectors = await embedWithDeadline(embedder, pending.map((node) => node.text), args.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await liteWriteStore.withTx(async () => {
      for (const node of pending) {
        await liteWriteStore.setNodeEmbeddingFailed({
          scope: prepared.scope,
          id: node.id,
          error: message,
        });
      }
    });
    return {
      attempted: pending.length,
      updated: 0,
      failed: pending.length,
      error: message,
    };
  }
  if (vectors.length !== pending.length) {
    const message = `unexpected embedding count: expected ${pending.length}, got ${vectors.length}`;
    await liteWriteStore.withTx(async () => {
      for (const node of pending) {
        await liteWriteStore.setNodeEmbeddingFailed({
          scope: prepared.scope,
          id: node.id,
          error: message,
        });
      }
    });
    return {
      attempted: pending.length,
      updated: 0,
      failed: pending.length,
      error: message,
    };
  }

  await liteWriteStore.withTx(async () => {
    for (let i = 0; i < pending.length; i += 1) {
      await liteWriteStore.setNodeEmbeddingReady({
        scope: prepared.scope,
        id: pending[i].id,
        embedding: vectors[i] ?? [],
        embeddingModel: embedder.name,
      });
    }
  });

  return {
    attempted: pending.length,
    updated: pending.length,
    failed: 0,
  };
}

export async function commitLitePreparedWriteWithProjection(args: {
  prepared: PreparedWrite;
  liteWriteStore: LiteProjectedWriteStore;
  embedder: EmbeddingProvider | null;
  inlineEmbeddingTimeoutMs?: number | null;
  learningControlReviewProviders?: Parameters<typeof projectWorkflowCandidatesFromPreparedWrite>[0]["learningControlReviewProviders"];
  writeOptions: {
    maxTextLen: number;
    piiRedaction: boolean;
    allowCrossScopeEdges: boolean;
    associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
    lifecycleRelationCandidateProducer?: MemoryLifecycleRelationCandidateProducer;
  };
}) {
  await appendLiteWorkflowProjection({
    prepared: args.prepared,
    liteWriteStore: args.liteWriteStore,
    learningControlReviewProviders: args.learningControlReviewProviders,
  });
  const out = await args.liteWriteStore.withTx(() =>
    applyPreparedMemoryWrite(args.liteWriteStore, args.prepared, {
      maxTextLen: args.writeOptions.maxTextLen,
      piiRedaction: args.writeOptions.piiRedaction,
      allowCrossScopeEdges: args.writeOptions.allowCrossScopeEdges,
      ...(args.writeOptions.associativeLinkOrigin
        ? { associativeLinkOrigin: args.writeOptions.associativeLinkOrigin }
        : {}),
      ...(args.writeOptions.lifecycleRelationCandidateProducer
        ? { lifecycleRelationCandidateProducer: args.writeOptions.lifecycleRelationCandidateProducer }
        : {}),
    }),
  );
  const liteInlineEmbedding = await completeLiteInlineEmbeddings({
    prepared: args.prepared,
    embedder: args.embedder,
    liteWriteStore: args.liteWriteStore,
    timeoutMs: args.inlineEmbeddingTimeoutMs,
  });
  return {
    out,
    liteInlineEmbedding,
  };
}
