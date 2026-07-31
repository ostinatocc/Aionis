import type { EmbeddingProvider } from "../embeddings/types.js";
import { drainLiteProjectionJobs } from "../jobs/lite-projection-worker.js";
import { sha256Hex } from "../util/crypto.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import type { LiteProjectionOutboxAccess } from "../store/lite-projection-outbox.js";
import type { AssociativeLinkTriggerOrigin } from "./associative-linking-types.js";
import {
  applyPreparedMemoryWrite,
  prepareMemoryWriteLifecycleRelations,
  type PreparedWrite,
} from "./write.js";
export type LiteInlineEmbeddingStore = Pick<
  LiteProjectionOutboxAccess,
  | "claimProjectionJobs"
  | "completeEmbeddingProjection"
  | "completeAnnProjection"
  | "requeueAnnProjectionAfterStaleSideEffect"
  | "retryProjectionJob"
  | "deadLetterProjectionJob"
> & {
  withTx: <T>(fn: () => Promise<T>) => Promise<T>;
  readyEmbeddingNodeIds: (scope: string, ids: string[]) => Promise<Set<string>>;
  annSyncEnabled: () => boolean;
};

export type LiteProjectedWriteStore = WriteStoreAccess
  & LiteInlineEmbeddingStore
  & Pick<LiteProjectionOutboxAccess, "enqueueEmbeddingProjection">;

export async function completeLiteInlineEmbeddings(args: {
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

  const drained = await drainLiteProjectionJobs({
    store: liteWriteStore,
    embedder,
    ann: null,
    annEnabled: liteWriteStore.annSyncEnabled(),
    limit: pending.length,
    jobKinds: ["embedding_generate"],
    scopes: [prepared.scope],
    nodeIds: pending.map((node) => node.id),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  });
  const readyAfter = await liteWriteStore.readyEmbeddingNodeIds(
    prepared.scope,
    pending.map((node) => node.id),
  );
  const failed = drained.retried + drained.dead_lettered;

  return {
    attempted: pending.length,
    updated: readyAfter.size,
    failed,
    ...(failed > 0 ? { error: "durable embedding projection deferred for retry" } : {}),
  };
}

export async function prepareLiteProjectedWrite(args: {
  prepared: PreparedWrite;
  liteWriteStore: LiteProjectedWriteStore;
}): Promise<void> {
  await prepareMemoryWriteLifecycleRelations(
    args.liteWriteStore,
    args.prepared,
  );
}

export async function persistLitePreparedWrite(args: {
  prepared: PreparedWrite;
  liteWriteStore: LiteProjectedWriteStore;
  writeOptions: {
    maxTextLen: number;
    piiRedaction: boolean;
    allowCrossScopeEdges: boolean;
    associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
  };
}) {
  return await args.liteWriteStore.withTx(async () => {
    const result = await applyPreparedMemoryWrite(args.liteWriteStore, args.prepared, args.writeOptions);
    const planned = args.prepared.nodes.filter((node) => (
      args.prepared.auto_embed_effective
      && !node.embedding
      && typeof node.embed_text === "string"
      && node.embed_text.trim().length > 0
    ));
    if (planned.length === 0) return result;

    const providerName = args.prepared.embedding_provider_name?.trim() ?? "";
    const providerDim = args.prepared.embedding_provider_dim;
    if (!providerName || !Number.isInteger(providerDim) || Number(providerDim) <= 0) {
      throw new Error("durable embedding projection requires a bound provider name and dimension");
    }
    for (const node of planned) {
      const embedText = String(node.embed_text);
      await args.liteWriteStore.enqueueEmbeddingProjection({
        scope: args.prepared.scope,
        nodeId: node.id,
        sourceCommitId: result.commit_id,
        payload: {
          v: 1,
          tenant_id: args.prepared.tenant_id,
          scope: args.prepared.scope_public,
          scope_key: args.prepared.scope,
          commit_id: result.commit_id,
          node_id: node.id,
          embed_text: embedText,
          embed_text_sha256: sha256Hex(embedText),
          provider_name: providerName,
          provider_dim: Number(providerDim),
          force_reembed: args.prepared.force_reembed,
          recovery_origin: "semantic_commit",
        },
      });
    }
    return result;
  });
}

export async function commitLitePreparedWriteWithProjection(args: {
  prepared: PreparedWrite;
  liteWriteStore: LiteProjectedWriteStore;
  embedder: EmbeddingProvider | null;
  inlineEmbeddingTimeoutMs?: number | null;
  writeOptions: {
    maxTextLen: number;
    piiRedaction: boolean;
    allowCrossScopeEdges: boolean;
    associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
  };
}) {
  await prepareLiteProjectedWrite({
    prepared: args.prepared,
    liteWriteStore: args.liteWriteStore,
  });
  const out = await args.liteWriteStore.withTx(() =>
    persistLitePreparedWrite({
      liteWriteStore: args.liteWriteStore,
      prepared: args.prepared,
      writeOptions: {
      maxTextLen: args.writeOptions.maxTextLen,
      piiRedaction: args.writeOptions.piiRedaction,
      allowCrossScopeEdges: args.writeOptions.allowCrossScopeEdges,
      ...(args.writeOptions.associativeLinkOrigin
        ? { associativeLinkOrigin: args.writeOptions.associativeLinkOrigin }
        : {}),
      },
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
