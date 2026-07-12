import { randomUUID } from "node:crypto";

import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  parseAnnProjectionPayload,
  parseEmbeddingProjectionPayload,
  type LiteAnnProjectionJobClaim,
  type LiteEmbeddingProjectionJobClaim,
  type LiteProjectionJobClaim,
  type LiteProjectionJobKind,
  type LiteProjectionOutboxAccess,
} from "../store/lite-projection-outbox.js";
import { sha256Hex } from "../util/crypto.js";

type ProjectionWorkerLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
};

export type LiteProjectionAnnReconciler = {
  reconcileNode(scope: string, nodeId: string): Promise<unknown>;
};

export type LiteProjectionDrainResult = {
  claimed: number;
  embedding_completed: number;
  ann_completed: number;
  node_missing: number;
  retried: number;
  dead_lettered: number;
  stale_claims: number;
};

export type LiteProjectionWorkerHealth = {
  running: boolean;
  closed: boolean;
  last_started_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_error_code: string | null;
};

type ProjectionWorkerStore = Pick<
  LiteProjectionOutboxAccess,
  | "claimProjectionJobs"
  | "completeEmbeddingProjection"
  | "completeAnnProjection"
  | "requeueAnnProjectionAfterStaleSideEffect"
  | "retryProjectionJob"
  | "deadLetterProjectionJob"
>;

class ProjectionDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`projection_deadline_exceeded:${timeoutMs}`);
    this.name = "ProjectionDeadlineError";
  }
}

function emptyDrainResult(): LiteProjectionDrainResult {
  return {
    claimed: 0,
    embedding_completed: 0,
    ann_completed: 0,
    node_missing: 0,
    retried: 0,
    dead_lettered: 0,
    stale_claims: 0,
  };
}

function mergeDrainResult(target: LiteProjectionDrainResult, source: LiteProjectionDrainResult): void {
  target.claimed += source.claimed;
  target.embedding_completed += source.embedding_completed;
  target.ann_completed += source.ann_completed;
  target.node_missing += source.node_missing;
  target.retried += source.retried;
  target.dead_lettered += source.dead_lettered;
  target.stale_claims += source.stale_claims;
}

function controlledErrorCode(error: unknown): string {
  if (error instanceof ProjectionDeadlineError) return error.message;
  if (error instanceof Error && error.name) return `projection_external_error:${error.name}`;
  return "projection_external_error:unknown";
}

function retryDelayMs(claim: LiteProjectionJobClaim): number {
  const exponent = Math.max(0, Math.min(8, claim.attempt_count - 1));
  const base = Math.min(60_000, 250 * (2 ** exponent));
  const digest = sha256Hex(`${claim.scope}\0${claim.node_id}\0${claim.job_kind}\0${claim.attempt_count}`);
  const jitterBound = Math.max(1, Math.floor(base / 4));
  const jitter = Number.parseInt(digest.slice(0, 8), 16) % jitterBound;
  return base + jitter;
}

async function withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  const bounded = Math.max(1, Math.min(60_000, Math.trunc(timeoutMs)));
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProjectionDeadlineError(bounded)), bounded);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retryClaim(args: {
  store: ProjectionWorkerStore;
  claim: LiteProjectionJobClaim;
  errorCode: string;
}): Promise<"retried" | "stale"> {
  const retryAt = new Date(Date.now() + retryDelayMs(args.claim));
  const updated = await args.store.retryProjectionJob({
    claim: args.claim,
    error: args.errorCode,
    retryAt,
  });
  return updated ? "retried" : "stale";
}

async function processEmbeddingClaim(args: {
  store: ProjectionWorkerStore;
  claim: LiteEmbeddingProjectionJobClaim;
  embedder: EmbeddingProvider | null;
  annEnabled: boolean;
  timeoutMs: number;
}): Promise<LiteProjectionDrainResult> {
  const result = emptyDrainResult();
  result.claimed = 1;
  const payload = parseEmbeddingProjectionPayload(args.claim);
  if (!payload) {
    const updated = await args.store.deadLetterProjectionJob({
      claim: args.claim,
      error: "invalid_embedding_projection_payload",
    });
    if (updated) result.dead_lettered += 1;
    else result.stale_claims += 1;
    return result;
  }
  if (!args.embedder) {
    const outcome = await retryClaim({
      store: args.store,
      claim: args.claim,
      errorCode: "embedding_provider_unavailable",
    });
    result[outcome === "retried" ? "retried" : "stale_claims"] += 1;
    return result;
  }
  if (args.embedder.name !== payload.provider_name || args.embedder.dim !== payload.provider_dim) {
    const outcome = await retryClaim({
      store: args.store,
      claim: args.claim,
      errorCode: `embedding_provider_mismatch:expected=${payload.provider_name}/${payload.provider_dim}`,
    });
    result[outcome === "retried" ? "retried" : "stale_claims"] += 1;
    return result;
  }

  try {
    const vectors = await withDeadline(args.embedder.embed([payload.embed_text]), args.timeoutMs);
    if (vectors.length !== 1 || !Array.isArray(vectors[0]) || vectors[0].length !== payload.provider_dim) {
      throw new Error("EmbeddingProviderContractError");
    }
    const completion = await args.store.completeEmbeddingProjection({
      claim: args.claim,
      embedding: vectors[0],
      embeddingModel: args.embedder.name,
      enqueueAnn: args.annEnabled,
    });
    if (completion === "applied") result.embedding_completed += 1;
    else if (completion === "node_missing") result.node_missing += 1;
    else if (completion === "invalid_payload" || completion === "source_changed") result.dead_lettered += 1;
    else result.stale_claims += 1;
  } catch (error) {
    const outcome = await retryClaim({
      store: args.store,
      claim: args.claim,
      errorCode: controlledErrorCode(error),
    });
    result[outcome === "retried" ? "retried" : "stale_claims"] += 1;
  }
  return result;
}

async function processAnnClaim(args: {
  store: ProjectionWorkerStore;
  claim: LiteAnnProjectionJobClaim;
  ann: LiteProjectionAnnReconciler | null;
  timeoutMs: number;
}): Promise<LiteProjectionDrainResult> {
  const result = emptyDrainResult();
  result.claimed = 1;
  if (!parseAnnProjectionPayload(args.claim)) {
    const updated = await args.store.deadLetterProjectionJob({
      claim: args.claim,
      error: "invalid_ann_projection_payload",
    });
    if (updated) result.dead_lettered += 1;
    else result.stale_claims += 1;
    return result;
  }
  if (!args.ann) {
    const outcome = await retryClaim({
      store: args.store,
      claim: args.claim,
      errorCode: "ann_provider_unavailable",
    });
    result[outcome === "retried" ? "retried" : "stale_claims"] += 1;
    return result;
  }
  try {
    await withDeadline(args.ann.reconcileNode(args.claim.scope, args.claim.node_id), args.timeoutMs);
    const completed = await args.store.completeAnnProjection({ claim: args.claim });
    if (completed) result.ann_completed += 1;
    else {
      // CAS fences the database acknowledgement, but an ANN call may already have
      // completed for an older generation. Bump a fresh reconcile intent so that
      // a stale external side effect can never be the last durable state.
      await args.store.requeueAnnProjectionAfterStaleSideEffect({
        scope: args.claim.scope,
        nodeId: args.claim.node_id,
      });
      result.stale_claims += 1;
    }
  } catch (error) {
    const outcome = await retryClaim({
      store: args.store,
      claim: args.claim,
      errorCode: controlledErrorCode(error),
    });
    result[outcome === "retried" ? "retried" : "stale_claims"] += 1;
  }
  return result;
}

export async function drainLiteProjectionJobs(args: {
  store: ProjectionWorkerStore;
  embedder: EmbeddingProvider | null;
  ann: LiteProjectionAnnReconciler | null;
  annEnabled: boolean;
  limit: number;
  leaseOwner?: string;
  leaseMs?: number;
  timeoutMs?: number;
  jobKinds?: LiteProjectionJobKind[];
  scopes?: string[];
  nodeIds?: string[];
  logger?: ProjectionWorkerLogger;
}): Promise<LiteProjectionDrainResult> {
  const result = emptyDrainResult();
  const limit = Math.max(1, Math.min(200, Math.trunc(args.limit)));
  const timeoutMs = Math.max(1, Math.min(60_000, Math.trunc(args.timeoutMs ?? 12_000)));
  const leaseMs = Math.max(timeoutMs * 2, Math.trunc(args.leaseMs ?? 60_000));
  const leaseOwner = args.leaseOwner?.trim() || `projection:${process.pid}:${randomUUID()}`;

  for (let index = 0; index < limit; index += 1) {
    const claims = await args.store.claimProjectionJobs({
      leaseOwner,
      leaseMs,
      limit: 1,
      ...(args.jobKinds ? { jobKinds: args.jobKinds } : {}),
      ...(args.scopes ? { scopes: args.scopes } : {}),
      ...(args.nodeIds ? { nodeIds: args.nodeIds } : {}),
    });
    const claim = claims[0];
    if (!claim) break;
    const item = claim.job_kind === "embedding_generate"
      ? await processEmbeddingClaim({
          store: args.store,
          claim: claim as LiteEmbeddingProjectionJobClaim,
          embedder: args.embedder,
          annEnabled: args.annEnabled,
          timeoutMs,
        })
      : await processAnnClaim({
          store: args.store,
          claim: claim as LiteAnnProjectionJobClaim,
          ann: args.ann,
          timeoutMs,
        });
    mergeDrainResult(result, item);
  }
  if (result.retried > 0 || result.dead_lettered > 0) {
    args.logger?.warn?.({
      claimed: result.claimed,
      retried: result.retried,
      dead_lettered: result.dead_lettered,
      stale_claims: result.stale_claims,
    }, "durable projection drain completed with deferred jobs");
  }
  return result;
}

export type LiteProjectionWorker = {
  drainOnce(): Promise<LiteProjectionDrainResult>;
  healthSnapshot(): LiteProjectionWorkerHealth;
  shutdown(): Promise<void>;
};

export function startLiteProjectionWorker(args: {
  store: ProjectionWorkerStore;
  embedder: EmbeddingProvider | null;
  ann: LiteProjectionAnnReconciler | null;
  annEnabled: boolean;
  intervalMs: number;
  batchSize: number;
  timeoutMs?: number;
  leaseMs?: number;
  logger?: ProjectionWorkerLogger;
}): LiteProjectionWorker {
  let closed = false;
  let running: Promise<LiteProjectionDrainResult> | null = null;
  let lastStartedAt: string | null = null;
  let lastSucceededAt: string | null = null;
  let lastFailedAt: string | null = null;
  let lastErrorCode: string | null = null;
  const leaseOwner = `projection-worker:${process.pid}:${randomUUID()}`;

  const drainOnce = async (): Promise<LiteProjectionDrainResult> => {
    if (closed) return emptyDrainResult();
    if (running) return await running;
    lastStartedAt = new Date().toISOString();
    running = drainLiteProjectionJobs({
      store: args.store,
      embedder: args.embedder,
      ann: args.ann,
      annEnabled: args.annEnabled,
      limit: args.batchSize,
      leaseOwner,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.leaseMs ? { leaseMs: args.leaseMs } : {}),
      logger: args.logger,
    });
    try {
      const result = await running;
      lastSucceededAt = new Date().toISOString();
      lastErrorCode = null;
      return result;
    } catch (error) {
      lastFailedAt = new Date().toISOString();
      lastErrorCode = controlledErrorCode(error);
      throw error;
    } finally {
      running = null;
    }
  };

  const runLogged = (): void => {
    void drainOnce().then((result) => {
      if (result.claimed > 0) {
        args.logger?.info?.({ ...result }, "durable projection outbox drain");
      }
    }).catch((error) => {
      args.logger?.error?.({ error_code: controlledErrorCode(error) }, "durable projection outbox drain crashed");
    });
  };
  const timer = setInterval(runLogged, Math.max(250, Math.trunc(args.intervalMs)));
  timer.unref?.();
  runLogged();

  return {
    drainOnce,
    healthSnapshot(): LiteProjectionWorkerHealth {
      return {
        running: running !== null,
        closed,
        last_started_at: lastStartedAt,
        last_succeeded_at: lastSucceededAt,
        last_failed_at: lastFailedAt,
        last_error_code: lastErrorCode,
      };
    },
    async shutdown(): Promise<void> {
      closed = true;
      clearInterval(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
