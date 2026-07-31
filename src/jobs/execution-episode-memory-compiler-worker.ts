import type { LiteEvidenceArtifactStore } from
  "../store/lite-evidence-artifact-store.js";
import type {
  LiteExecutionEpisodeMemoryCompilationCandidate,
  LiteExecutionEpisodeStore,
} from "../store/lite-execution-episode-store.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import {
  deriveCanonicalL1EpisodeFromStores,
} from "../learning/canonical-l1-store.js";
import {
  compileExecutionEpisodeMemoryV1,
  executionEpisodeMemoryObserveOperationId,
} from "../memory/execution-episode-memory-compiler.js";
import {
  PRODUCT_OBSERVE_OPERATION_KIND,
} from "../product/observe-service.js";
import type { ProductServices } from "../product/product-services.js";

type CompilerWorkerLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
};

type CompilerEpisodeStore = LiteExecutionEpisodeStore;

type CompilerWriteStore = LiteWriteStore;

const MAX_REPORTED_COMPILER_ERRORS = 32;

export type ExecutionEpisodeMemoryCompilerDrainResult = {
  scanned: number;
  already_compiled: number;
  attempted: number;
  compiled: number;
  abstained: number;
  failed: number;
  source_exhausted: boolean;
  next_offset: number;
  errors: Array<{
    episode_id: string;
    error_code: string;
  }>;
};

export type ExecutionEpisodeMemoryCompilerWorkerHealth = {
  running: boolean;
  closed: boolean;
  last_started_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_error_code: string | null;
};

export type ExecutionEpisodeMemoryCompilerWorker = {
  drainOnce(): Promise<ExecutionEpisodeMemoryCompilerDrainResult>;
  healthSnapshot(): ExecutionEpisodeMemoryCompilerWorkerHealth;
  shutdown(): Promise<void>;
};

function emptyDrainResult(): ExecutionEpisodeMemoryCompilerDrainResult {
  return {
    scanned: 0,
    already_compiled: 0,
    attempted: 0,
    compiled: 0,
    abstained: 0,
    failed: 0,
    source_exhausted: false,
    next_offset: 0,
    errors: [],
  };
}

function controlledErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 512);
  }
  return "execution_episode_memory_compiler_unknown_error";
}

function closeEventMatches(
  candidate: LiteExecutionEpisodeMemoryCompilationCandidate,
  replay: Awaited<ReturnType<CompilerEpisodeStore["replayEpisode"]>>,
): boolean {
  return replay.events.some((event) =>
    event.event_id === candidate.close_event_id
    && event.event_sha256 === candidate.close_event_sha256
    && event.payload.event_kind === "episode_closed"
    && event.payload.reward.reward_id === candidate.reward_id);
}

async function compileCandidate(args: {
  candidate: LiteExecutionEpisodeMemoryCompilationCandidate;
  episodeStore: CompilerEpisodeStore;
  artifactStore: Pick<LiteEvidenceArtifactStore, "readArtifactBytes">;
  writeStore: CompilerWriteStore;
  observe: ProductServices["observe"];
}): Promise<"compiled" | "abstained"> {
  const candidate = args.candidate;
  const replay = await args.episodeStore.replayEpisode({
    tenantId: candidate.tenant_id,
    scope: candidate.store_scope,
    episodeId: candidate.episode_id,
  });
  if (
    replay.reward?.reward_id !== candidate.reward_id
    || !closeEventMatches(candidate, replay)
  ) {
    throw new Error(
      "execution_episode_memory_compiler_source_identity_changed",
    );
  }
  const canonicalL1 = await deriveCanonicalL1EpisodeFromStores({
    episodeStore: args.episodeStore,
    writeStore: args.writeStore,
    tenantId: candidate.tenant_id,
    storeScope: candidate.store_scope,
    episodeId: candidate.episode_id,
  });
  const compiled = await compileExecutionEpisodeMemoryV1({
    replay,
    canonicalL1,
    artifactReader: args.artifactStore,
    tenantId: candidate.tenant_id,
    scope: candidate.store_scope,
  });
  if (compiled.reward_digest !== candidate.reward_sha256) {
    throw new Error(
      "execution_episode_memory_compiler_reward_digest_changed",
    );
  }
  if (!compiled.node) return "abstained";
  const operationId = executionEpisodeMemoryObserveOperationId(
    candidate.reward_sha256,
  );
  const result = await args.observe.execute({
    operation_id: operationId,
    tenant_id: candidate.tenant_id,
    scope: candidate.public_scope,
    actor: "execution_episode_memory_compiler",
    memory_lane: "shared",
    auto_embed: true,
    nodes: [compiled.node],
  }, {
    principal: null,
  });
  if (!result.ok) {
    throw new Error(
      `execution_episode_memory_observe_failed:${result.statusCode}`,
    );
  }
  return "compiled";
}

export async function drainExecutionEpisodeMemoryCompiler(args: {
  episodeStore: CompilerEpisodeStore;
  artifactStore: Pick<LiteEvidenceArtifactStore, "readArtifactBytes">;
  writeStore: CompilerWriteStore;
  observe: ProductServices["observe"];
  limit: number;
  startOffset?: number;
  logger?: CompilerWorkerLogger;
}): Promise<ExecutionEpisodeMemoryCompilerDrainResult> {
  const result = emptyDrainResult();
  const target = Math.max(1, Math.min(200, Math.trunc(args.limit)));
  const pageSize = Math.max(50, Math.min(500, target * 4));
  const scanLimit = Math.max(
    pageSize,
    Math.min(5_000, target * 16),
  );
  let offset = Math.max(0, Math.trunc(args.startOffset ?? 0));

  /*
   * The batch target is the number of durable projections, not the number of
   * source rows attempted. Failed or abstained immutable source rows have no
   * write-operation receipt, so counting them against the target would make
   * every later drain restart at the same oldest rows and permanently starve
   * newer valid episodes. Scan deterministically through the ordered source
   * log until the target is projected, the bounded scan window is consumed,
   * or the source is exhausted. The caller carries next_offset across drains,
   * so a poison prefix cannot starve later rows without making one drain scan
   * the entire historical ledger.
   *
   * Successful projections remain bounded by `target`; retries remain
   * restart-safe because Product Observe's deterministic operation id is the
   * durable completion marker.
   */
  while (result.compiled < target && result.scanned < scanLimit) {
    const requestedPageSize = Math.min(
      pageSize,
      scanLimit - result.scanned,
    );
    const candidates =
      await args.episodeStore.listMemoryCompilationCandidates({
        limit: requestedPageSize,
        offset,
      });
    if (candidates.length === 0) {
      result.source_exhausted = true;
      offset = 0;
      break;
    }
    let processedInPage = 0;
    for (const candidate of candidates) {
      processedInPage += 1;
      offset += 1;
      result.scanned += 1;
      const operationId = executionEpisodeMemoryObserveOperationId(
        candidate.reward_sha256,
      );
      const existing = await args.writeStore.getWriteOperation({
        tenantId: candidate.tenant_id,
        scope: candidate.public_scope,
        operationKind: PRODUCT_OBSERVE_OPERATION_KIND,
        operationId,
      });
      if (existing) {
        result.already_compiled += 1;
        continue;
      }
      result.attempted += 1;
      try {
        const outcome = await compileCandidate({
          candidate,
          episodeStore: args.episodeStore,
          artifactStore: args.artifactStore,
          writeStore: args.writeStore,
          observe: args.observe,
        });
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        if (result.errors.length < MAX_REPORTED_COMPILER_ERRORS) {
          result.errors.push({
            episode_id: candidate.episode_id,
            error_code: controlledErrorCode(error),
          });
        }
      }
      if (
        result.compiled >= target
        || result.scanned >= scanLimit
      ) break;
    }
    if (
      result.compiled >= target
      || result.scanned >= scanLimit
    ) break;
    if (
      processedInPage === candidates.length
      && candidates.length < requestedPageSize
    ) {
      result.source_exhausted = true;
      offset = 0;
      break;
    }
  }
  result.next_offset = result.source_exhausted ? 0 : offset;

  if (result.failed > 0 || result.abstained > 0) {
    args.logger?.warn?.({
      attempted: result.attempted,
      compiled: result.compiled,
      abstained: result.abstained,
      failed: result.failed,
      errors: result.errors,
    }, "execution episode memory compiler deferred sources");
  }
  return result;
}

export function startExecutionEpisodeMemoryCompilerWorker(args: {
  episodeStore: CompilerEpisodeStore;
  artifactStore: Pick<LiteEvidenceArtifactStore, "readArtifactBytes">;
  writeStore: CompilerWriteStore;
  observe: ProductServices["observe"];
  intervalMs: number;
  batchSize: number;
  logger?: CompilerWorkerLogger;
}): ExecutionEpisodeMemoryCompilerWorker {
  let closed = false;
  let running: Promise<ExecutionEpisodeMemoryCompilerDrainResult> | null =
    null;
  let lastStartedAt: string | null = null;
  let lastSucceededAt: string | null = null;
  let lastFailedAt: string | null = null;
  let lastErrorCode: string | null = null;
  let nextOffset = 0;

  const drainOnce = async (): Promise<
    ExecutionEpisodeMemoryCompilerDrainResult
  > => {
    if (closed) return emptyDrainResult();
    if (running) return await running;
    lastStartedAt = new Date().toISOString();
    running = drainExecutionEpisodeMemoryCompiler({
      episodeStore: args.episodeStore,
      artifactStore: args.artifactStore,
      writeStore: args.writeStore,
      observe: args.observe,
      limit: args.batchSize,
      startOffset: nextOffset,
      logger: args.logger,
    });
    try {
      const result = await running;
      nextOffset = result.next_offset;
      lastSucceededAt = new Date().toISOString();
      lastErrorCode = result.failed > 0
        ? result.errors[0]?.error_code
          ?? "execution_episode_memory_compiler_item_failed"
        : null;
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
    if (closed || running) return;
    void drainOnce().then((result) => {
      if (result.attempted > 0) {
        args.logger?.info?.({
          scanned: result.scanned,
          attempted: result.attempted,
          compiled: result.compiled,
          abstained: result.abstained,
          failed: result.failed,
        }, "execution episode memory compiler drain");
      }
    }).catch((error) => {
      args.logger?.error?.({
        error_code: controlledErrorCode(error),
      }, "execution episode memory compiler drain crashed");
    });
  };
  const timer = setInterval(
    runLogged,
    Math.max(250, Math.trunc(args.intervalMs)),
  );
  timer.unref?.();
  runLogged();

  return {
    drainOnce,
    healthSnapshot() {
      return {
        running: running !== null,
        closed,
        last_started_at: lastStartedAt,
        last_succeeded_at: lastSucceededAt,
        last_failed_at: lastFailedAt,
        last_error_code: lastErrorCode,
      };
    },
    async shutdown() {
      closed = true;
      clearInterval(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
