import { assertContinuationRuntimeV1Host } from "../continuation/host-contract.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../store/continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../store/continuation-runtime-v1-authority-artifact-reader.js";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../store/continuation-runtime-v1-durable-job-enqueuer.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../store/continuation-runtime-v1-memory-store.js";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../store/continuation-runtime-v1-policy-authority.js";
import { createContinuationRuntimeV1AnnIndexSegmentStore } from
  "./ann-index-segment-store.js";
import { createContinuationRuntimeV1AnnWorkerProcessor } from
  "./ann-worker-processor.js";
import {
  createContinuationRuntimeV1EmbeddingProvider,
  loadContinuationRuntimeV1EmbeddingCredential,
} from "./embedding-provider.js";
import { createContinuationRuntimeV1EmbeddingWorkerProcessor } from
  "./embedding-worker-processor.js";
import { loadContinuationRuntimeV1EffectSigner } from "./effect-signer.js";
import { createContinuationRuntimeV1EffectWorkerProcessor } from
  "./effect-worker-processor.js";
import {
  createContinuationRuntimeV1ProcessLifecycle,
  type ContinuationRuntimeV1ProcessLifecycle,
} from "./process-lifecycle.js";
import { loadContinuationRuntimeV1TrustRoot } from "./trust-root.js";
import { createContinuationRuntimeV1RetentionAuthorityResolver } from
  "./retention-authority-resolver.js";
import { createContinuationRuntimeV1RetentionWorkerProcessor } from
  "./retention-worker-processor.js";
import { createContinuationRuntimeV1VectorArtifactStore } from
  "./vector-artifact-store.js";
import {
  loadContinuationRuntimeV1WorkerConfig,
  publicContinuationRuntimeV1WorkerConfig,
  type PublicContinuationRuntimeV1WorkerConfig,
} from "./worker-config.js";
import {
  createContinuationRuntimeV1WorkerService,
  type ContinuationRuntimeV1WorkerProcessor,
  type ContinuationRuntimeV1WorkerService,
} from "./worker-service.js";

export type ContinuationRuntimeV1WorkerComposition = Readonly<{
  publicConfig: PublicContinuationRuntimeV1WorkerConfig;
  database: ContinuationRuntimeV1Database;
  service: ContinuationRuntimeV1WorkerService;
  close(): Promise<void>;
}>;

export type RunningContinuationRuntimeV1Worker =
  ContinuationRuntimeV1WorkerComposition & Readonly<{
    lifecycle: ContinuationRuntimeV1ProcessLifecycle;
    workerLoop: Promise<void>;
  }>;

type CompositionState = {
  closePromise: Promise<void> | null;
  drainInFlight: () => Promise<void>;
  stopNewWork: () => Promise<void>;
};

const COMPOSITION_STATES =
  new WeakMap<ContinuationRuntimeV1WorkerComposition, CompositionState>();

function fail(reason: string, cause?: unknown): never {
  throw new Error(
    `continuation_runtime_v1_worker_composition_${reason}`,
    cause === undefined ? undefined : { cause },
  );
}

export function continuationRuntimeV1VectorArtifactRoot(
  dataPath: string,
): string {
  if (typeof dataPath !== "string" || dataPath.length === 0) {
    fail("data_path_invalid");
  }
  return `${dataPath}.vector-artifacts-v1`;
}

/** ANN segments share the rebuildable sidecar root but occupy an isolated tree. */
export function continuationRuntimeV1AnnIndexSegmentRoot(
  dataPath: string,
): string {
  return `${continuationRuntimeV1VectorArtifactRoot(dataPath)}/index-segments-v1`;
}

async function closeAfterCompositionFailure(
  database: ContinuationRuntimeV1Database,
  cause: unknown,
): Promise<never> {
  try {
    await database.close();
  } catch (cleanupError) {
    fail("startup_cleanup_failed", new AggregateError([cause, cleanupError]));
  }
  throw cause;
}

/** Constructs one role-confined worker with one concrete processor. */
export async function composeContinuationRuntimeV1Worker(
  environment: unknown,
): Promise<ContinuationRuntimeV1WorkerComposition> {
  assertContinuationRuntimeV1Host();
  const config = loadContinuationRuntimeV1WorkerConfig(environment);
  const publicConfig = publicContinuationRuntimeV1WorkerConfig(config);
  if ((config.workerRole !== "embedding" && config.workerRole !== "ann"
      && config.workerRole !== "effect" && config.workerRole !== "retention")
    || (config.workerRole === "embedding" && config.embedding === null)
    || (config.workerRole === "effect" && config.effect === null)) {
    fail("worker_role_unavailable");
  }

  const trustRoot = loadContinuationRuntimeV1TrustRoot(config);
  const effectSigner = config.workerRole === "effect" && config.effect !== null
    ? loadContinuationRuntimeV1EffectSigner(config.effect)
    : null;
  const embeddingCredential =
    config.workerRole === "embedding" && config.embedding !== null
      ? loadContinuationRuntimeV1EmbeddingCredential(config.embedding) : null;
  let database: ContinuationRuntimeV1Database;
  try { database = openContinuationRuntimeV1Database(config.dataPath); }
  catch (error) {
    embeddingCredential?.destroy(); throw error;
  }
  try {
    const serviceFor = <R extends ContinuationRuntimeV1WorkerProcessor["worker_role"]>(
      processor: ContinuationRuntimeV1WorkerProcessor<R>,
    ): ContinuationRuntimeV1WorkerService =>
      createContinuationRuntimeV1WorkerService({ database, config, processor });
    let service: ContinuationRuntimeV1WorkerService;
    if (config.workerRole === "embedding" && config.embedding !== null) {
      const memoryStore = createContinuationRuntimeV1MemoryStore(database);
      const durableJobStore = createContinuationRuntimeV1DurableJobEnqueuer(database);
      const vectorRoot = continuationRuntimeV1VectorArtifactRoot(config.dataPath);
      service = serviceFor(createContinuationRuntimeV1EmbeddingWorkerProcessor({
        memoryStore,
        durableJobStore,
        provider: createContinuationRuntimeV1EmbeddingProvider(
          config.embedding, embeddingCredential!, database.authorityNow,
        ),
        vectorArtifactStore: createContinuationRuntimeV1VectorArtifactStore({
          rootPath: vectorRoot,
        }),
      }));
    } else if (config.workerRole === "ann") {
      const vectorRoot = continuationRuntimeV1VectorArtifactRoot(config.dataPath);
      service = serviceFor(createContinuationRuntimeV1AnnWorkerProcessor({
        vectorArtifactStore: createContinuationRuntimeV1VectorArtifactStore({
          rootPath: vectorRoot,
        }),
        indexSegmentStore: createContinuationRuntimeV1AnnIndexSegmentStore({
          rootPath: continuationRuntimeV1AnnIndexSegmentRoot(config.dataPath),
        }),
      }));
    } else if (config.workerRole === "effect" && effectSigner !== null) {
      const artifactStore = createContinuationRuntimeV1AuthorityArtifactReader(
        database,
        trustRoot,
      );
      const policyAuthority = createContinuationRuntimeV1PolicyAuthority(
        database,
        artifactStore,
      );
      service = serviceFor(createContinuationRuntimeV1EffectWorkerProcessor({
        database,
        artifactStore,
        policyAuthority,
        signer: effectSigner,
      }));
    } else if (config.workerRole === "retention") {
      const vectorRoot = continuationRuntimeV1VectorArtifactRoot(config.dataPath);
      service = serviceFor(createContinuationRuntimeV1RetentionWorkerProcessor({
        authorityResolver:
          createContinuationRuntimeV1RetentionAuthorityResolver(database),
        vectorArtifactStore: createContinuationRuntimeV1VectorArtifactStore({
          rootPath: vectorRoot,
        }),
        indexSegmentStore: createContinuationRuntimeV1AnnIndexSegmentStore({
          rootPath: continuationRuntimeV1AnnIndexSegmentRoot(config.dataPath),
        }),
      }));
    } else {
      fail("worker_role_unavailable");
    }
    let drainPromise: Promise<void> | null = null;
    const drainInFlight = (): Promise<void> => (
      drainPromise ??= service.drainInFlight().then(() => embeddingCredential?.destroy())
    );
    const stopNewWork = (): Promise<void> => {
      const stopping = service.stopNewWork();
      void drainInFlight().catch(() => undefined);
      return stopping;
    };

    let composition!: ContinuationRuntimeV1WorkerComposition;
    composition = Object.freeze({
      publicConfig,
      database,
      service,
      close: async (): Promise<void> => {
        const state = COMPOSITION_STATES.get(composition);
        if (!state) fail("state_missing");
        if (state.closePromise === null) {
          state.closePromise = (async () => {
            await stopNewWork();
            await drainInFlight();
            await database.close();
          })();
        }
        return state.closePromise;
      },
    });
    COMPOSITION_STATES.set(composition, { closePromise: null, drainInFlight, stopNewWork });
    return composition;
  } catch (error) {
    embeddingCredential?.destroy();
    return await closeAfterCompositionFailure(database, error);
  }
}

/** Starts polling and installs the shared ordered shutdown lifecycle. */
export async function startContinuationRuntimeV1Worker(
  environment: unknown,
): Promise<RunningContinuationRuntimeV1Worker> {
  const composition = await composeContinuationRuntimeV1Worker(environment);
  const state = COMPOSITION_STATES.get(composition);
  if (!state) fail("state_missing");
  const lifecycle = createContinuationRuntimeV1ProcessLifecycle({
    shutdownTimeoutMs: composition.publicConfig.shutdownTimeoutMs,
    stopNewWork: state.stopNewWork,
    drainInFlight: state.drainInFlight,
    closeDatabase: composition.close,
  });
  let workerLoop: Promise<void>;
  try {
    workerLoop = composition.service.runUntilStopped();
  } catch (error) {
    lifecycle.dispose();
    await composition.close();
    throw error;
  }
  return Object.freeze({
    ...composition,
    lifecycle,
    workerLoop,
  });
}
