import "dotenv/config";
import {
  assertBootstrapStoreContracts,
  closeBootstrapResources,
  createHttpApp,
  listenHttpApp,
  registerBootstrapLifecycle,
  registerRuntimeSignalShutdown,
} from "./server/bootstrap.js";
import { createRequestGuards } from "./app/request-guards.js";
import { createHttpObservabilityHelpers } from "./app/http-observability.js";
import {
  logMemoryApiConfig,
  createRuntimeProductServices,
  registerApplicationRoutes,
  registerHealthRoute,
  registerRuntimeErrorHandler,
  registerRuntimeRequestHooks,
} from "./server/http-server.js";
import { createMemoryWriteRouteService } from "./routes/memory-write.js";
import { createRuntimeServices } from "./app/runtime-services.js";
import { startLiteAssociativeLinkWorker } from "./jobs/associative-linking-worker.js";
import {
  startExecutionEpisodeMemoryCompilerWorker,
} from "./jobs/execution-episode-memory-compiler-worker.js";
import { startLiteProjectionWorker } from "./jobs/lite-projection-worker.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";

export async function startAionisRuntime(): Promise<void> {
  const { env, config: runtimeConfig } = loadRuntimeConfig({ ...process.env });
  const {
    liteRecallStore,
    liteRecallAccess,
    liteWriteStore,
    evidenceArtifactStore,
    executionEpisodeStore,
    executionEpisodeService,
    executionTurnTransactionService,
    executionStateStore,
    executionTreeStore,
    embedder,
    queryEmbedder,
    recallLimiter,
    writeLimiter,
    recallInflightGate,
    writeInflightGate,
  } = await createRuntimeServices(runtimeConfig);
  const {
    acquireInflightSlot,
    enforceRateLimit,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    tenantFromBody,
    enforceTenantQuota,
  } = createRequestGuards({
    config: runtimeConfig,
    recallLimiter,
    writeLimiter,
    recallInflightGate,
    writeInflightGate,
  });
  const {
    resolveCorsAllowOrigin,
    resolveCorsPolicy,
  } = createHttpObservabilityHelpers({
    config: runtimeConfig,
  });

  const app = createHttpApp(env);
  const memoryWriteService = createMemoryWriteRouteService({
    env,
    embedder,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
  });
  const productServices = createRuntimeProductServices({
    env,
    liteWriteStore,
    liteRecallAccess,
    queryEmbedder,
    memoryWriteService,
    executionEpisodeStore,
    executionEpisodeService,
    executionTurnTransactionService,
    evidenceArtifactStore,
    executionStateStore,
  });
  const executionEpisodeMemoryCompilerWorker =
    startExecutionEpisodeMemoryCompilerWorker({
      episodeStore: executionEpisodeStore,
      artifactStore: evidenceArtifactStore,
      writeStore: liteWriteStore,
      observe: productServices.observe,
      intervalMs: runtimeConfig.storage.OUTBOX_POLL_INTERVAL_MS,
      batchSize: runtimeConfig.storage.OUTBOX_BATCH_SIZE,
      logger: app.log,
    });
  let projectionWorker: ReturnType<typeof startLiteProjectionWorker> | null =
    null;
  let associativeLinkWorker: ReturnType<
    typeof startLiteAssociativeLinkWorker
  > | null = null;
  let lifecycleRegistered = false;
  try {
    await executionEpisodeMemoryCompilerWorker.drainOnce();
    projectionWorker = startLiteProjectionWorker({
      store: liteWriteStore,
      embedder,
      ann: liteWriteStore.annSyncEnabled()
        ? { reconcileNode: (scope, nodeId) => liteRecallStore.syncAnnNode(scope, nodeId) }
        : null,
      annEnabled: liteWriteStore.annSyncEnabled(),
      intervalMs: runtimeConfig.storage.OUTBOX_POLL_INTERVAL_MS,
      batchSize: runtimeConfig.storage.OUTBOX_BATCH_SIZE,
      timeoutMs: env.LITE_INLINE_EMBEDDING_TIMEOUT_MS,
      logger: app.log,
    });
    await projectionWorker.drainOnce();
    associativeLinkWorker = liteRecallAccess
      ? startLiteAssociativeLinkWorker({
          writeStore: liteWriteStore,
          recallAccess: liteRecallAccess,
          intervalMs: runtimeConfig.storage.OUTBOX_POLL_INTERVAL_MS,
          batchSize: runtimeConfig.storage.OUTBOX_BATCH_SIZE,
          logger: app.log,
        })
      : null;

    registerBootstrapLifecycle({
      app,
      liteRecallStore,
      liteWriteStore,
      projectionWorker,
      executionEpisodeMemoryCompilerWorker,
      associativeLinkWorker,
      executionStateStore,
      executionTreeStore,
    });
    lifecycleRegistered = true;

    registerRuntimeErrorHandler(app);
    logMemoryApiConfig({
      app,
      env,
      embedder,
      queryEmbedder,
    });
    registerRuntimeRequestHooks({
      app,
      resolveCorsPolicy,
      resolveCorsAllowOrigin,
    });
    registerHealthRoute({
      app,
      env,
      liteRecallStore,
      liteWriteStore,
      executionStateStore,
      executionTreeStore,
      projectionWorker,
    });
    const applicationRouteArgs = {
      app,
      env,
      liteWriteStore,
      productServices,
      requireMemoryPrincipal,
      withIdentityFromRequest,
      enforceRateLimit,
      enforceTenantQuota,
      tenantFromBody,
      acquireInflightSlot,
    };
    registerApplicationRoutes(applicationRouteArgs);

    const signalShutdown = registerRuntimeSignalShutdown({ app });
    await assertBootstrapStoreContracts({
      liteRecallAccess,
      liteWriteStore,
    });
    if (signalShutdown.shutdownRequested()) await signalShutdown.waitForShutdown();
    else await listenHttpApp(app, env);
  } catch (startupError) {
    const cleanupErrors: unknown[] = [];
    if (lifecycleRegistered) {
      try {
        await app.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else {
      try {
        await closeBootstrapResources({
          liteRecallStore,
          liteWriteStore,
          projectionWorker,
          executionEpisodeMemoryCompilerWorker,
          associativeLinkWorker,
          executionStateStore,
          executionTreeStore,
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await app.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        "Runtime startup and resource cleanup failed",
      );
    }
    throw startupError;
  }
}

await startAionisRuntime();
