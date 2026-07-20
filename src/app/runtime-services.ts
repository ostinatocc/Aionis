import type { RuntimeConfig } from "../config/runtime-config.js";
import { assertLocalStoreRuntimeEdition } from "./edition.js";
import { createEmbeddingProviders } from "../embeddings/index.js";
import { createEmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import {
  SandboxExecutor,
  parseAllowedSandboxCommands,
} from "../memory/sandbox.js";
import { type RecallStoreCapabilities } from "../store/recall-access.js";
import { createLiteRecallStore } from "../store/lite-recall-store.js";
import { createLiteReplayStore } from "../store/lite-replay-store.js";
import { createLiteRuntimeStore } from "../store/lite-runtime-store.js";
import { createSandboxStore } from "../store/sandbox-access.js";
import { createLiteWriteStoreFromDatabase } from "../store/lite-write-store.js";
import { createLiteClaimLedgerStoreFromDatabase } from "../store/lite-claim-ledger-store.js";
import { createLiteRuntimeDatabase } from "../store/lite-runtime-database.js";
import { assertPrivateRuntimeSqlitePathNamespacesDisjoint } from "../store/sqlite.js";
import { createLiteLearningEpisodeLedgerAccess } from "../store/lite-learning-episode-ledger.js";
import { createLiteLearningControlJobAccess } from "../store/lite-learning-control-jobs.js";
import {
  LiteTenantScopeAuthorityError,
  ensureLiteTenantScopeEncodingAnchor,
} from "../store/lite-tenant-scope-authority.js";
import { createLiteSkillCandidateReviewStoreFromDatabase } from "../store/lite-skill-candidate-review-store.js";
import { createLocalAnnIndex } from "../store/ann/local-ann-index.js";
import { createZvecAnnIndex } from "../store/ann/zvec-ann-index.js";
import { createSubstrateSidecarCandidateProvider } from "../store/substrate-sidecar-recall.js";
import { createLiteExecutionStateStoreFromDatabase } from "../execution/state-store.js";
import { createLiteExecutionTreeStoreFromDatabase } from "../execution/tree-store.js";
import { EmbedQueryBatcher } from "../util/embed_query_batcher.js";
import { InflightGate } from "../util/inflight_gate.js";
import { LruTtlCache } from "../util/lru_ttl_cache.js";
import { TokenBucketLimiter } from "../util/ratelimit.js";

export type SandboxTenantBudgetPolicy = {
  daily_run_cap: number | null;
  daily_timeout_cap: number | null;
  daily_failure_cap: number | null;
};

export function sanitizeBudgetCap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function parseSandboxTenantBudgetPolicy(raw: string): Map<string, SandboxTenantBudgetPolicy> {
  let parsed: unknown = {};
  try {
    const normalized = raw.trim();
    parsed = normalized.length === 0 ? {} : JSON.parse(normalized);
  } catch {
    throw new Error("SANDBOX_TENANT_BUDGET_POLICY_JSON must be valid JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SANDBOX_TENANT_BUDGET_POLICY_JSON must be a JSON object");
  }
  const out = new Map<string, SandboxTenantBudgetPolicy>();
  for (const [tenantId, limitsRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const key = tenantId.trim();
    if (!key) continue;
    if (!limitsRaw || typeof limitsRaw !== "object" || Array.isArray(limitsRaw)) continue;
    const limits = limitsRaw as Record<string, unknown>;
    const normalized: SandboxTenantBudgetPolicy = {
      daily_run_cap: sanitizeBudgetCap(limits.daily_run_cap),
      daily_timeout_cap: sanitizeBudgetCap(limits.daily_timeout_cap),
      daily_failure_cap: sanitizeBudgetCap(limits.daily_failure_cap),
    };
    if (!normalized.daily_run_cap && !normalized.daily_timeout_cap && !normalized.daily_failure_cap) continue;
    out.set(key, normalized);
  }
  return out;
}

function parseSandboxRemoteAllowedHosts(raw: string): Set<string> {
  let parsed: unknown = [];
  try {
    const normalized = raw.trim();
    parsed = normalized.length === 0 ? [] : JSON.parse(normalized);
  } catch {
    throw new Error("SANDBOX_REMOTE_EXECUTOR_ALLOWED_HOSTS_JSON must be valid JSON array");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SANDBOX_REMOTE_EXECUTOR_ALLOWED_HOSTS_JSON must be a JSON array");
  }
  return new Set(
    parsed
      .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
      .filter((v) => v.length > 0),
  );
}

function parseSandboxRemoteAllowedCidrs(raw: string): Set<string> {
  let parsed: unknown = [];
  try {
    const normalized = raw.trim();
    parsed = normalized.length === 0 ? [] : JSON.parse(normalized);
  } catch {
    throw new Error("SANDBOX_REMOTE_EXECUTOR_EGRESS_ALLOWED_CIDRS_JSON must be valid JSON array");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SANDBOX_REMOTE_EXECUTOR_EGRESS_ALLOWED_CIDRS_JSON must be a JSON array");
  }
  return new Set(
    parsed
      .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
      .filter((v) => v.length > 0),
  );
}

export type RuntimeServiceConfig = Pick<
  RuntimeConfig,
  "runtime" | "storage" | "recall" | "limits" | "sandbox" | "providers"
>;

export async function createRuntimeServices(config: RuntimeServiceConfig) {
  const { runtime, storage, recall, limits, sandbox, providers } = config;
  assertLocalStoreRuntimeEdition(runtime, "local-store runtime services");
  const sandboxRemoteAllowedHosts = parseSandboxRemoteAllowedHosts(sandbox.SANDBOX_REMOTE_EXECUTOR_ALLOWED_HOSTS_JSON);
  const sandboxRemoteAllowedCidrs = parseSandboxRemoteAllowedCidrs(sandbox.SANDBOX_REMOTE_EXECUTOR_EGRESS_ALLOWED_CIDRS_JSON);
  const sandboxAllowedCommands = parseAllowedSandboxCommands(sandbox.SANDBOX_ALLOWED_COMMANDS_JSON);
  assertPrivateRuntimeSqlitePathNamespacesDisjoint(storage.LITE_WRITE_SQLITE_PATH, storage.LITE_REPLAY_SQLITE_PATH);
  const store = createLiteRuntimeStore(storage.LITE_WRITE_SQLITE_PATH);
  const liteReplayStore = createLiteReplayStore(storage.LITE_REPLAY_SQLITE_PATH);
  const liteReplayAccess = liteReplayStore?.createReplayAccess() ?? null;
  const annIndex =
    recall.RECALL_ANN_PROVIDER === "local"
      ? createLocalAnnIndex()
      : recall.RECALL_ANN_PROVIDER === "zvec"
        ? createZvecAnnIndex({
            path: recall.RECALL_ZVEC_PATH.trim() || `${storage.LITE_WRITE_SQLITE_PATH}.zvec-ann`,
          })
        : null;
  const substrateSidecarProvider = recall.RECALL_SUBSTRATE_SIDECAR_ENABLED
    ? createSubstrateSidecarCandidateProvider({
        path: recall.RECALL_SUBSTRATE_PATH.trim(),
      })
    : null;
  const runtimeDatabase = createLiteRuntimeDatabase(storage.LITE_WRITE_SQLITE_PATH);
  const liteWriteStore = createLiteWriteStoreFromDatabase(runtimeDatabase, {
    closeDatabaseOnClose: true,
    annProjectionEnabled: annIndex !== null,
  });
  const learningEpisodeLedgerAccess = createLiteLearningEpisodeLedgerAccess(runtimeDatabase);
  const learningControlJobAccess = createLiteLearningControlJobAccess(runtimeDatabase);
  try {
    await liteWriteStore.withTx(async () => {
      ensureLiteTenantScopeEncodingAnchor(
        runtimeDatabase.db,
        runtimeDatabase.transaction,
        runtime.MEMORY_TENANT_ID,
      );
    });
  } catch (error) {
    if (!(error instanceof LiteTenantScopeAuthorityError)
      || error.code !== "lite_tenant_scope_anchor_missing_for_existing_unprefixed_memory") {
      await Promise.allSettled([
        liteWriteStore.close(),
        liteReplayStore?.close() ?? Promise.resolve(),
        store.close(),
      ]);
      throw error;
    }
    // A legacy database cannot safely infer who owns its unprefixed scopes.
    // Keep the Runtime available, but leave confirmatory provisioning fail-closed
    // until an explicit offline migration establishes the immutable anchor.
  }
  const liteClaimLedgerStore = createLiteClaimLedgerStoreFromDatabase(runtimeDatabase);
  const claimLedgerAccess = liteClaimLedgerStore.createClaimLedgerAccess();
  const liteSkillCandidateReviewStore = createLiteSkillCandidateReviewStoreFromDatabase(runtimeDatabase);
  const skillCandidateReviewAccess = liteSkillCandidateReviewStore.createSkillCandidateReviewAccess();
  const executionStateStore = createLiteExecutionStateStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const executionTreeStore = createLiteExecutionTreeStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const liteRecallStore = createLiteRecallStore(storage.LITE_WRITE_SQLITE_PATH, {
    ann: annIndex
      ? {
          index: annIndex,
          rebuildOnStart: recall.RECALL_ANN_REBUILD_ON_START || recall.RECALL_ANN_PROVIDER === "local",
          maxCandidates: recall.RECALL_ANN_MAX_CANDIDATES,
          sourceReason: recall.RECALL_ANN_PROVIDER === "zvec" ? "zvec_ann_index" : "local_ann_index",
          indexName: recall.RECALL_ANN_PROVIDER === "zvec" ? "aionis_zvec_ann" : "aionis_local_ann",
        }
      : null,
    substrateSidecar: substrateSidecarProvider
      ? {
          provider: substrateSidecarProvider,
          maxCandidates: recall.RECALL_SUBSTRATE_MAX_CANDIDATES,
          sourceReason: "substrate_sidecar_search",
          indexName: "aionis_substrate_sidecar",
          failOpen: recall.RECALL_SUBSTRATE_FAIL_OPEN,
        }
      : null,
  });
  if (annIndex && (recall.RECALL_ANN_REBUILD_ON_START || recall.RECALL_ANN_PROVIDER === "local")) {
    await liteRecallStore.rebuildAnnIndex();
  }
  const liteRecallAccess = liteRecallStore?.createRecallAccess() ?? null;
  const sandboxStore = createSandboxStore(store);

  const embeddingProviders = createEmbeddingProviders(providers.embedding);
  const embedder = embeddingProviders.write;
  const queryEmbedder = embeddingProviders.query;
  const embeddingSurfacePolicy = createEmbeddingSurfacePolicy({
    providerConfigured: !!(embedder || queryEmbedder),
    enabledSurfaces: providers.enabledSurfaces,
  });
  const sandboxExecutor = new SandboxExecutor(sandboxStore, {
    enabled: sandbox.SANDBOX_ENABLED,
    mode: sandbox.SANDBOX_EXECUTOR_MODE,
    maxConcurrency: sandbox.SANDBOX_EXECUTOR_MAX_CONCURRENCY,
    defaultTimeoutMs: sandbox.SANDBOX_EXECUTOR_TIMEOUT_MS,
    stdioMaxBytes: sandbox.SANDBOX_STDIO_MAX_BYTES,
    workdir: sandbox.SANDBOX_EXECUTOR_WORKDIR,
    allowedCommands: sandboxAllowedCommands,
    remote: {
      url: sandbox.SANDBOX_REMOTE_EXECUTOR_URL.trim() || null,
      authHeader: sandbox.SANDBOX_REMOTE_EXECUTOR_AUTH_HEADER.trim(),
      authToken: sandbox.SANDBOX_REMOTE_EXECUTOR_AUTH_TOKEN,
      timeoutMs: sandbox.SANDBOX_REMOTE_EXECUTOR_TIMEOUT_MS,
      allowedHosts: sandboxRemoteAllowedHosts,
      allowedEgressCidrs: sandboxRemoteAllowedCidrs,
      denyPrivateIps: sandbox.SANDBOX_REMOTE_EXECUTOR_EGRESS_DENY_PRIVATE_IPS,
      mtlsCertPem: sandbox.SANDBOX_REMOTE_EXECUTOR_MTLS_CERT_PEM,
      mtlsKeyPem: sandbox.SANDBOX_REMOTE_EXECUTOR_MTLS_KEY_PEM,
      mtlsCaPem: sandbox.SANDBOX_REMOTE_EXECUTOR_MTLS_CA_PEM,
      mtlsServerName: sandbox.SANDBOX_REMOTE_EXECUTOR_MTLS_SERVER_NAME,
    },
    artifactObjectStoreBaseUri: sandbox.SANDBOX_ARTIFACT_OBJECT_STORE_BASE_URI.trim() || null,
    heartbeatIntervalMs: sandbox.SANDBOX_RUN_HEARTBEAT_INTERVAL_MS,
    staleAfterMs: sandbox.SANDBOX_RUN_STALE_AFTER_MS,
    recoveryPollIntervalMs: sandbox.SANDBOX_RUN_RECOVERY_POLL_INTERVAL_MS,
    recoveryBatchSize: sandbox.SANDBOX_RUN_RECOVERY_BATCH_SIZE,
  });
  const recallStoreCapabilities: RecallStoreCapabilities = {
    debug_embeddings: true,
    audit_insert: true,
  };

  const recallLimiter = limits.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.RECALL_RATE_LIMIT_RPS,
        burst: limits.RECALL_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const debugEmbedLimiter = limits.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.DEBUG_EMBED_RATE_LIMIT_RPS,
        burst: limits.DEBUG_EMBED_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const writeLimiter = limits.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.WRITE_RATE_LIMIT_RPS,
        burst: limits.WRITE_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const recallTextEmbedLimiter = limits.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.RECALL_TEXT_EMBED_RATE_LIMIT_RPS,
        burst: limits.RECALL_TEXT_EMBED_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;

  const sandboxTenantBudgetPolicy = parseSandboxTenantBudgetPolicy(sandbox.SANDBOX_TENANT_BUDGET_POLICY_JSON);

  const recallTextEmbedCache =
    queryEmbedder && recall.RECALL_TEXT_EMBED_CACHE_ENABLED
      ? new LruTtlCache<string, number[]>({
          maxEntries: recall.RECALL_TEXT_EMBED_CACHE_MAX_KEYS,
          ttlMs: recall.RECALL_TEXT_EMBED_CACHE_TTL_MS,
        })
      : null;
  const recallTextEmbedInflight = new Map<string, Promise<{ vector: number[]; queue_wait_ms: number; batch_size: number }>>();
  const recallTextEmbedBatcher =
    queryEmbedder && recall.RECALL_TEXT_EMBED_BATCH_ENABLED
      ? new EmbedQueryBatcher({
          maxBatchSize: recall.RECALL_TEXT_EMBED_BATCH_MAX_SIZE,
          maxBatchWaitMs: recall.RECALL_TEXT_EMBED_BATCH_MAX_WAIT_MS,
          maxInflightBatches: recall.RECALL_TEXT_EMBED_BATCH_MAX_INFLIGHT,
          maxQueue: recall.RECALL_TEXT_EMBED_BATCH_QUEUE_MAX,
          queueTimeoutMs: recall.RECALL_TEXT_EMBED_BATCH_QUEUE_TIMEOUT_MS,
          runBatch: async (texts) => {
            return await queryEmbedder.embed(texts);
          },
        })
      : null;

  const recallInflightGate = new InflightGate({
    maxInflight: limits.API_RECALL_MAX_INFLIGHT,
    maxQueue: limits.API_RECALL_QUEUE_MAX,
    queueTimeoutMs: limits.API_RECALL_QUEUE_TIMEOUT_MS,
  });
  const writeInflightGate = new InflightGate({
    maxInflight: limits.API_WRITE_MAX_INFLIGHT,
    maxQueue: limits.API_WRITE_QUEUE_MAX,
    queueTimeoutMs: limits.API_WRITE_QUEUE_TIMEOUT_MS,
  });
  return {
    sandboxRemoteAllowedHosts,
    sandboxRemoteAllowedCidrs,
    sandboxAllowedCommands,
    store,
    sandboxStore,
    liteRecallStore,
    liteRecallAccess,
    liteReplayStore,
    liteReplayAccess,
    liteWriteStore,
    learningEpisodeLedgerAccess,
    learningControlJobAccess,
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
  };
}
