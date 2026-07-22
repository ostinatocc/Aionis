import type { FastifyInstance } from "fastify";

import { assertContinuationRuntimeV1Host } from
  "../continuation/host-contract.js";

import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../store/continuation-runtime-v1-authority-artifact-reader.js";
import { createContinuationRuntimeV1AuthorityStore } from
  "../store/continuation-runtime-v1-authority-store.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../store/continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1EffectCertificateReader } from
  "../store/continuation-runtime-v1-effect-certificate-reader.js";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../store/continuation-runtime-v1-durable-job-enqueuer.js";
import { createContinuationRuntimeV1EpisodeStore } from
  "../store/continuation-runtime-v1-episode-store.js";
import { createContinuationRuntimeV1ExperimentCohortAuthority } from
  "../store/continuation-runtime-v1-experiment-cohort-authority.js";
import { createContinuationRuntimeV1MemoryHistoryStore } from
  "../store/continuation-runtime-v1-memory-history.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../store/continuation-runtime-v1-memory-store.js";
import { createContinuationRuntimeV1ObservationStore } from
  "../store/continuation-runtime-v1-observation-store.js";
import { createContinuationRuntimeV1OperationStore } from
  "../store/continuation-runtime-v1-operation-store.js";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../store/continuation-runtime-v1-policy-authority.js";
import {
  createContinuationRuntimeV1ApplicationService,
} from "./application-service.js";
import type { ContinuationRuntimeV1Application } from "./application.js";
import {
  loadContinuationRuntimeV1DaemonConfig,
  publicContinuationRuntimeV1DaemonConfig,
  type PublicContinuationRuntimeV1DaemonConfig,
} from "./config.js";
import { createContinuationRuntimeV1DecisionAssemblyService } from
  "./decision-assembly.js";
import { createContinuationRuntimeV1DecisionReader } from
  "./decision-reader.js";
import { createContinuationRuntimeV1HttpHandlers } from
  "./http-handlers.js";
import { createContinuationRuntimeV1HttpServer } from
  "./http-server.js";
import {
  createContinuationRuntimeV1ProcessLifecycle,
  type ContinuationRuntimeV1ProcessLifecycle,
} from "./process-lifecycle.js";
import { loadContinuationRuntimeV1TrustRoot } from "./trust-root.js";

export type ContinuationRuntimeV1DaemonComposition = Readonly<{
  publicConfig: PublicContinuationRuntimeV1DaemonConfig;
  database: ContinuationRuntimeV1Database;
  application: ContinuationRuntimeV1Application;
  server: FastifyInstance;
  close(): Promise<void>;
}>;

export type RunningContinuationRuntimeV1Daemon =
  ContinuationRuntimeV1DaemonComposition & Readonly<{
    lifecycle: ContinuationRuntimeV1ProcessLifecycle;
  }>;

type CompositionState = {
  httpClosePromise: Promise<void> | null;
  closePromise: Promise<void> | null;
  listening: boolean;
  closed: boolean;
  httpHost: string;
  httpPort: number;
  shutdownTimeoutMs: number;
};

const COMPOSITION_STATES = new WeakMap<
  ContinuationRuntimeV1DaemonComposition,
  CompositionState
>();

function beginHttpClose(
  composition: ContinuationRuntimeV1DaemonComposition,
  state: CompositionState,
): Promise<void> {
  if (state.httpClosePromise === null) {
    state.httpClosePromise = composition.server.close();
    // The lifecycle awaits this same promise in its drain phase. Attaching a
    // handler immediately prevents a rejection racing the phase transition.
    void state.httpClosePromise.catch(() => undefined);
  }
  return state.httpClosePromise;
}

async function closeCompositionResources(
  composition: ContinuationRuntimeV1DaemonComposition,
  state: CompositionState,
): Promise<void> {
  if (state.closePromise !== null) return state.closePromise;
  state.closePromise = (async () => {
    const failures: unknown[] = [];
    try {
      await beginHttpClose(composition, state);
    } catch (error) {
      failures.push(error);
    }
    try {
      await composition.database.close();
    } catch (error) {
      failures.push(error);
    }
    state.closed = true;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "continuation_runtime_v1_daemon_resource_close_failed",
      );
    }
  })();
  return state.closePromise;
}

async function closeDatabaseAfterCompositionFailure(
  database: ContinuationRuntimeV1Database,
  cause: unknown,
): Promise<never> {
  try {
    await database.close();
  } catch (cleanupError) {
    throw new Error("continuation_runtime_v1_daemon_startup_cleanup_failed", {
      cause: new AggregateError([cause, cleanupError]),
    });
  }
  throw cause;
}

/**
 * Constructs the entire HTTP Runtime from a strict daemon-only environment.
 * This dependency closure contains no worker/provider configuration, effect
 * signing key, provisioning root, or root private key.
 */
export async function composeContinuationRuntimeV1Daemon(
  environment: unknown,
): Promise<ContinuationRuntimeV1DaemonComposition> {
  assertContinuationRuntimeV1Host();
  const config = loadContinuationRuntimeV1DaemonConfig(environment);
  const publicConfig = publicContinuationRuntimeV1DaemonConfig(config);
  const trustRoot = loadContinuationRuntimeV1TrustRoot(config);
  const database = openContinuationRuntimeV1Database(config.dataPath);

  try {
    const operationStore = createContinuationRuntimeV1OperationStore(database);
    const artifactStore = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      trustRoot,
    );
    const policyAuthority = createContinuationRuntimeV1PolicyAuthority(
      database,
      artifactStore,
    );
    const effectCertificateReader = createContinuationRuntimeV1EffectCertificateReader(
      database,
      artifactStore,
      policyAuthority,
    );
    const authorityStore = createContinuationRuntimeV1AuthorityStore(
      database,
      artifactStore,
      policyAuthority,
      effectCertificateReader,
    );
    const experimentCohortAuthority =
      createContinuationRuntimeV1ExperimentCohortAuthority(
        database,
        artifactStore,
        policyAuthority,
      );
    const observationStore = createContinuationRuntimeV1ObservationStore(database);
    const memoryStore = createContinuationRuntimeV1MemoryStore(database);
    const durableJobStore = createContinuationRuntimeV1DurableJobEnqueuer(database);
    const memoryHistory = createContinuationRuntimeV1MemoryHistoryStore(database);
    const episodeStore = createContinuationRuntimeV1EpisodeStore(database);
    const decisionAssembly = createContinuationRuntimeV1DecisionAssemblyService({
      database,
      observationStore,
      memoryStore,
      artifactStore,
      policyAuthority,
      effectCertificateReader,
      authorityStore,
      experimentCohortAuthority,
    });
    const decisionReader = createContinuationRuntimeV1DecisionReader({
      database,
      artifactStore,
      episodeStore,
      observationStore,
      memoryHistory,
      authorityStore,
      policyAuthority,
      effectCertificateReader,
    });
    const application = createContinuationRuntimeV1ApplicationService({
      tenantId: config.tenantId,
      trustRootSha256: config.trustRootSha256,
      database,
      operationStore,
      durableJobStore,
      observationStore,
      memoryStore,
      policyAuthority,
      authorityStore,
      episodeStore,
      decisionAssembly,
      decisionReader,
    });
    const handlers = createContinuationRuntimeV1HttpHandlers({
      application,
      config,
    });
    const server = createContinuationRuntimeV1HttpServer({
      bodyLimitBytes: config.httpBodyLimitBytes,
      handlers,
    });

    let composition!: ContinuationRuntimeV1DaemonComposition;
    composition = Object.freeze({
      publicConfig,
      database,
      application,
      server,
      close: () => {
        const state = COMPOSITION_STATES.get(composition);
        if (!state) {
          return Promise.reject(
            new Error("continuation_runtime_v1_daemon_composition_invalid"),
          );
        }
        return closeCompositionResources(composition, state);
      },
    });
    COMPOSITION_STATES.set(composition, {
      httpClosePromise: null,
      closePromise: null,
      listening: false,
      closed: false,
      httpHost: config.httpHost,
      httpPort: config.httpPort,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    });
    return composition;
  } catch (error) {
    return closeDatabaseAfterCompositionFailure(database, error);
  }
}

function stateFor(
  composition: ContinuationRuntimeV1DaemonComposition,
): CompositionState {
  const state = COMPOSITION_STATES.get(composition);
  if (!state) throw new Error("continuation_runtime_v1_daemon_composition_invalid");
  return state;
}

async function listenOnConfiguredEndpoint(
  composition: ContinuationRuntimeV1DaemonComposition,
  state: CompositionState,
): Promise<void> {
  if (state.listening || state.closed || state.httpClosePromise !== null) {
    throw new Error("continuation_runtime_v1_daemon_listen_state_invalid");
  }
  await composition.server.listen({ host: state.httpHost, port: state.httpPort });
  const address = composition.server.server.address();
  if (address === null || typeof address === "string" || address.port !== state.httpPort) {
    throw new Error("continuation_runtime_v1_daemon_bound_endpoint_mismatch");
  }
  state.listening = true;
}

/** Starts exactly one listener and installs the process signal lifecycle. */
export async function startContinuationRuntimeV1Daemon(
  environment: unknown,
): Promise<RunningContinuationRuntimeV1Daemon> {
  const composition = await composeContinuationRuntimeV1Daemon(environment);
  const state = stateFor(composition);
  try {
    await listenOnConfiguredEndpoint(composition, state);
    const lifecycle = createContinuationRuntimeV1ProcessLifecycle({
      shutdownTimeoutMs: state.shutdownTimeoutMs,
      stopNewWork: () => {
        void beginHttpClose(composition, state);
      },
      drainInFlight: () => beginHttpClose(composition, state),
      closeDatabase: async () => {
        await composition.database.close();
        state.closed = true;
      },
    });
    return Object.freeze({ ...composition, lifecycle });
  } catch (error) {
    try {
      await closeCompositionResources(composition, state);
    } catch (cleanupError) {
      throw new Error("continuation_runtime_v1_daemon_startup_cleanup_failed", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw new Error("continuation_runtime_v1_daemon_listen_failed", { cause: error });
  }
}
