import "dotenv/config";
import {
  assertBootstrapStoreContracts,
  createHttpApp,
  listenHttpApp,
  registerBootstrapLifecycle,
} from "./server/bootstrap.js";
import { createRequestGuards } from "./app/request-guards.js";
import { createHttpObservabilityHelpers } from "./app/http-observability.js";
import {
  logMemoryApiConfig,
  createRuntimeProductServices,
  registerApplicationRoutes,
  type RegisterApplicationRoutesArgs,
  registerHealthRoute,
  registerRuntimeErrorHandler,
  registerRuntimeRequestHooks,
} from "./server/http-server.js";
import { createHandoffRouteService } from "./routes/handoff.js";
import { createMemoryWriteRouteService } from "./routes/memory-write.js";
import { createRecallPolicy } from "./app/recall-policy.js";
import { createRecallTextEmbedRuntime } from "./app/recall-text-embed.js";
import { createRuntimeServices } from "./app/runtime-services.js";
import { startLiteAssociativeLinkWorker } from "./jobs/associative-linking-worker.js";
import { startLiteProjectionWorker } from "./jobs/lite-projection-worker.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";

export async function startAionisRuntime(): Promise<void> {
  const { env, config: runtimeConfig } = loadRuntimeConfig({ ...process.env });
  const {
    sandboxRemoteAllowedHosts,
    sandboxRemoteAllowedCidrs,
    store,
    liteRecallStore,
    liteRecallAccess,
    liteReplayStore,
    liteReplayAccess,
    liteWriteStore,
    liteClaimLedgerStore,
    claimLedgerAccess,
    liteSkillCandidateReviewStore,
    skillCandidateReviewAccess,
    executionStateStore,
    executionTreeStore,
    embedder,
    queryEmbedder,
    sandboxExecutor,
    recallStoreCapabilities,
    recallLimiter,
    debugEmbedLimiter,
    writeLimiter,
    recallTextEmbedLimiter,
    sandboxTenantBudgetPolicy,
    recallTextEmbedCache,
    recallTextEmbedInflight,
    recallTextEmbedBatcher,
    embeddingSurfacePolicy,
    recallInflightGate,
    writeInflightGate,
  } = await createRuntimeServices(runtimeConfig);
  const {
    buildRecallAuth,
    acquireInflightSlot,
    enforceRateLimit,
    enforceRecallTextEmbedQuota,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    tenantFromBody,
    enforceTenantQuota,
  } = createRequestGuards({
    config: runtimeConfig,
    embedder: queryEmbedder,
    recallLimiter,
    debugEmbedLimiter,
    writeLimiter,
    recallTextEmbedLimiter,
    recallInflightGate,
    writeInflightGate,
  });
  const {
    globalRecallProfileDefaults,
    recallProfilePolicy,
    withRecallProfileDefaults,
    resolveRecallProfile,
    resolveExplicitRecallMode,
    resolveClassAwareRecallProfile,
    hasExplicitRecallKnobs,
    resolveRecallStrategy,
    resolveAdaptiveRecallProfile,
    resolveAdaptiveRecallHardCap,
    inferRecallStrategyFromKnobs,
    buildRecallTrajectory,
  } = createRecallPolicy(env);
  const {
    embedRecallTextQuery,
    mapRecallTextEmbeddingError,
  } = createRecallTextEmbedRuntime({
    recallTextEmbedCache,
    recallTextEmbedInflight,
    recallTextEmbedBatcher,
  });
  const {
    resolveCorsAllowOrigin,
    resolveCorsPolicy,
    resolveRequestScopeForTelemetry,
    resolveRequestTenantForTelemetry,
    resolveRequestApiKeyPrefixForTelemetry,
    recordContextAssemblyTelemetryBestEffort,
  } = createHttpObservabilityHelpers({
    config: runtimeConfig,
  });
  const coerceRecallProfileName = (profile: string): Parameters<typeof resolveExplicitRecallMode>[1] =>
    profile === "strict_edges" || profile === "quality_first" || profile === "lite"
      ? profile
      : env.MEMORY_RECALL_PROFILE;
  const resolveExplicitRecallModeForRoutes: RegisterApplicationRoutesArgs["resolveExplicitRecallMode"] = (
    body,
    baseProfile,
    explicitRecallKnobs,
  ) => resolveExplicitRecallMode(body, coerceRecallProfileName(baseProfile), explicitRecallKnobs);
  const resolveClassAwareRecallProfileForRoutes: RegisterApplicationRoutesArgs["resolveClassAwareRecallProfile"] = (
    endpoint,
    body,
    baseProfile,
    explicitRecallKnobs,
  ) => resolveClassAwareRecallProfile(
    endpoint as Parameters<typeof resolveClassAwareRecallProfile>[0],
    body,
    coerceRecallProfileName(baseProfile),
    explicitRecallKnobs,
  );
  const withRecallProfileDefaultsForRoutes: RegisterApplicationRoutesArgs["withRecallProfileDefaults"] = (body, defaults) => {
    const merged = {
      limit: typeof defaults.limit === "number" ? defaults.limit : globalRecallProfileDefaults.limit,
      neighborhood_hops: defaults.neighborhood_hops === 2 ? 2 : defaults.neighborhood_hops === 1 ? 1 : globalRecallProfileDefaults.neighborhood_hops,
      max_nodes: typeof defaults.max_nodes === "number" ? defaults.max_nodes : globalRecallProfileDefaults.max_nodes,
      max_edges: typeof defaults.max_edges === "number" ? defaults.max_edges : globalRecallProfileDefaults.max_edges,
      ranked_limit: typeof defaults.ranked_limit === "number" ? defaults.ranked_limit : globalRecallProfileDefaults.ranked_limit,
      min_edge_weight: typeof defaults.min_edge_weight === "number" ? defaults.min_edge_weight : globalRecallProfileDefaults.min_edge_weight,
      min_edge_confidence: typeof defaults.min_edge_confidence === "number" ? defaults.min_edge_confidence : globalRecallProfileDefaults.min_edge_confidence,
    };
    return withRecallProfileDefaults(body, merged);
  };
  const resolveAdaptiveRecallProfileForRoutes: RegisterApplicationRoutesArgs["resolveAdaptiveRecallProfile"] = (
    profile,
    waitMs,
    explicitRecallKnobs,
  ) => resolveAdaptiveRecallProfile(coerceRecallProfileName(profile), waitMs, explicitRecallKnobs);
  const buildRecallTrajectoryForRoutes: RegisterApplicationRoutesArgs["buildRecallTrajectory"] = (args) =>
    buildRecallTrajectory(args as Parameters<typeof buildRecallTrajectory>[0]);

  const app = createHttpApp(env);
  const memoryWriteService = createMemoryWriteRouteService({
    env,
    embedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
  });
  const handoffRouteService = createHandoffRouteService({
    env,
    embedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
  });
  const productServices = createRuntimeProductServices({
    env,
    liteWriteStore,
    liteRecallAccess,
    embedder,
    queryEmbedder,
    executionTreeStore,
    claimLedgerAccess,
    skillCandidateReviewAccess,
    memoryWriteService,
    handoffRouteService,
  });
  const projectionWorker = startLiteProjectionWorker({
    store: liteWriteStore,
    embedder: embeddingSurfacePolicy.providerFor("write_auto_embed", embedder),
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
  const associativeLinkWorker = liteRecallAccess
    ? startLiteAssociativeLinkWorker({
        writeStore: liteWriteStore,
        recallAccess: liteRecallAccess,
        intervalMs: runtimeConfig.storage.OUTBOX_POLL_INTERVAL_MS,
        batchSize: runtimeConfig.storage.OUTBOX_BATCH_SIZE,
        logger: app.log,
      })
    : null;

  registerRuntimeErrorHandler(app);
  logMemoryApiConfig({
    app,
    env,
    embedder,
    queryEmbedder,
    embeddingSurfacePolicy,
    sandboxRemoteAllowedHosts,
    sandboxTenantBudgetPolicy,
    recallTextEmbedCache,
    globalRecallProfileDefaults,
    recallProfilePolicy,
    recallTextEmbedBatcher,
  });
  registerRuntimeRequestHooks({
    app,
    resolveCorsPolicy,
    resolveCorsAllowOrigin,
  });
  registerHealthRoute({
    app,
    env,
    liteReplayStore,
    liteRecallStore,
    liteWriteStore,
    liteClaimLedgerStore,
    executionStateStore,
    executionTreeStore,
    sandboxExecutor,
    projectionWorker,
    sandboxTenantBudgetPolicy,
    sandboxRemoteAllowedCidrs,
  });
  const applicationRouteArgs: RegisterApplicationRoutesArgs = {
    app,
    env,
    embedder,
    queryEmbedder,
    embeddingSurfacePolicy,
    liteRecallAccess,
    liteWriteStore,
    claimLedgerAccess,
    skillCandidateReviewAccess,
    executionStateStore,
    executionTreeStore,
    productServices,
    recallTextEmbedBatcher,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    enforceRecallTextEmbedQuota,
    buildRecallAuth,
    tenantFromBody,
    acquireInflightSlot,
    hasExplicitRecallKnobs,
    resolveRecallProfile,
    resolveExplicitRecallMode: resolveExplicitRecallModeForRoutes,
    resolveClassAwareRecallProfile: resolveClassAwareRecallProfileForRoutes,
    withRecallProfileDefaults: withRecallProfileDefaultsForRoutes,
    resolveRecallStrategy,
    resolveAdaptiveRecallProfile: resolveAdaptiveRecallProfileForRoutes,
    resolveAdaptiveRecallHardCap,
    inferRecallStrategyFromKnobs,
    buildRecallTrajectory: buildRecallTrajectoryForRoutes,
    embedRecallTextQuery,
    mapRecallTextEmbeddingError,
    recordContextAssemblyTelemetryBestEffort,
  };
  registerApplicationRoutes(applicationRouteArgs);

  registerBootstrapLifecycle({
    app,
    store,
    sandboxExecutor,
    liteRecallStore,
    liteReplayStore,
    liteWriteStore,
    projectionWorker,
    associativeLinkWorker,
    liteClaimLedgerStore,
    liteSkillCandidateReviewStore,
    executionStateStore,
    executionTreeStore,
  });

  await assertBootstrapStoreContracts({
    liteRecallAccess,
    liteReplayAccess,
    liteWriteStore,
  });

  await listenHttpApp(app, env);
}
