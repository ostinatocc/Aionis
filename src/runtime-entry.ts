import "dotenv/config";
import {
  assertBootstrapStoreContracts,
  createHttpApp,
  listenHttpApp,
  registerBootstrapLifecycle,
} from "./host/bootstrap.js";
import { createRequestGuards } from "./app/request-guards.js";
import { createHttpObservabilityHelpers } from "./app/http-observability.js";
import {
  logMemoryApiConfig,
  registerApplicationRoutes,
  type RegisterApplicationRoutesArgs,
  registerHealthRoute,
  registerHostErrorHandler,
  registerHostRequestHooks,
} from "./host/http-host.js";
import { createRecallPolicy } from "./app/recall-policy.js";
import { createRecallTextEmbedRuntime } from "./app/recall-text-embed.js";
import { createReplayRepairReviewPolicy } from "./app/replay-repair-review-policy.js";
import { createReplayRuntimeOptionBuilders } from "./app/replay-runtime-options.js";
import { createSandboxBudgetService } from "./app/sandbox-budget.js";
import { createRuntimeServices } from "./app/runtime-services.js";
import { loadEnv } from "./config.js";
import {
  recordMemoryContextAssemblyTelemetry,
} from "./app/runtime-telemetry.js";

export async function startAionisRuntime(): Promise<void> {
  const env = loadEnv();
  const {
    sandboxRemoteAllowedHosts,
    sandboxRemoteAllowedCidrs,
    sandboxAllowedCommands,
    store,
    db,
    embeddedRuntime,
    liteRecallStore,
    liteRecallAccess,
    liteReplayStore,
    liteReplayAccess,
    liteWriteStore,
    executionStateStore,
    embedder,
    sandboxExecutor,
    healthDatabaseTargetHash,
    recallStoreCapabilities,
    writeStoreCapabilities,
    storeFeatureCapabilities,
    recallAccessForClient,
    replayAccessForClient,
    writeAccessForClient,
    requireStoreFeatureCapability,
    recallLimiter,
    debugEmbedLimiter,
    writeLimiter,
    sandboxWriteLimiter,
    sandboxReadLimiter,
    recallTextEmbedLimiter,
    sandboxTenantBudgetPolicy,
    recallTextEmbedCache,
    recallTextEmbedInflight,
    recallTextEmbedBatcher,
    embeddingSurfacePolicy,
    recallInflightGate,
    writeInflightGate,
  } = await createRuntimeServices(env);
  const {
    buildRecallAuth,
    acquireInflightSlot,
    enforceRateLimit,
    enforceRecallTextEmbedQuota,
    requireAdminToken,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    tenantFromBody,
    scopeFromBody,
    projectFromBody,
    enforceTenantQuota,
  } = createRequestGuards({
    env,
    embedder,
    recallLimiter,
    debugEmbedLimiter,
    writeLimiter,
    sandboxWriteLimiter,
    sandboxReadLimiter,
    recallTextEmbedLimiter,
    recallInflightGate,
    writeInflightGate,
  });
  const {
    enforceSandboxTenantBudget,
  } = createSandboxBudgetService({
    env,
    db,
    sandboxTenantBudgetPolicy,
    usageStore: store,
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
    buildReplayRepairReviewOptions,
    buildReplayPlaybookRunOptions,
  } = createReplayRuntimeOptionBuilders({
    env,
    store,
    embedder,
    embeddingSurfacePolicy,
    embeddedRuntime,
    liteWriteStore,
    liteReplayAccess,
    liteReplayStore,
    sandboxAllowedCommands,
    sandboxExecutor,
    writeAccessShadowMirrorV2: writeStoreCapabilities.shadow_mirror_v2,
    enforceSandboxTenantBudget,
  });
  const {
    resolveCorsAllowOrigin,
    resolveCorsPolicy,
    telemetryEndpointFromRequest,
    resolveRequestScopeForTelemetry,
    resolveRequestTenantForTelemetry,
    resolveRequestApiKeyPrefixForTelemetry,
    recordContextAssemblyTelemetryBestEffort,
  } = createHttpObservabilityHelpers({
    env,
    db,
    recordMemoryContextAssemblyTelemetry,
  });
  const {
    withReplayRepairReviewDefaults,
  } = createReplayRepairReviewPolicy({
    env,
    tenantFromBody,
    scopeFromBody,
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

  registerHostErrorHandler(app);
  logMemoryApiConfig({
    app,
    env,
    embedder,
    embeddingSurfacePolicy,
    sandboxRemoteAllowedHosts,
    sandboxTenantBudgetPolicy,
    recallTextEmbedCache,
    globalRecallProfileDefaults,
    recallProfilePolicy,
    recallTextEmbedBatcher,
  });
  registerHostRequestHooks({
    app,
    db,
    resolveCorsPolicy,
    resolveCorsAllowOrigin,
    telemetryEndpointFromRequest,
    resolveRequestTenantForTelemetry,
    resolveRequestScopeForTelemetry,
    resolveRequestApiKeyPrefixForTelemetry,
  });
  registerHealthRoute({
    app,
    env,
    liteReplayStore,
    liteRecallStore,
    liteWriteStore,
    executionStateStore,
    sandboxExecutor,
    sandboxTenantBudgetPolicy,
    sandboxRemoteAllowedCidrs,
  });
  const applicationRouteArgs: RegisterApplicationRoutesArgs = {
    app,
    env,
    store,
    embedder,
    embeddingSurfacePolicy,
    embeddedRuntime,
    liteRecallAccess,
    liteReplayAccess,
    liteReplayStore,
    liteWriteStore,
    executionStateStore,
    recallTextEmbedBatcher,
    writeStoreCapabilities,
    requireAdminToken,
    requireStoreFeatureCapability,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    enforceRecallTextEmbedQuota,
    buildRecallAuth,
    tenantFromBody,
    scopeFromBody,
    projectFromBody,
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
    withReplayRepairReviewDefaults,
    buildReplayRepairReviewOptions,
    buildReplayPlaybookRunOptions,
    sandboxExecutor,
    enforceSandboxTenantBudget,
  };
  registerApplicationRoutes(applicationRouteArgs);

  registerBootstrapLifecycle({
    app,
    store,
    sandboxExecutor,
    liteRecallStore,
    liteReplayStore,
    liteWriteStore,
    executionStateStore,
  });

  await assertBootstrapStoreContracts({
    store,
    recallAccessForClient,
    replayAccessForClient,
    writeAccessForClient,
    liteWriteStore,
  });

  await listenHttpApp(app, env);
}
