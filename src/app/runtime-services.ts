import type { Env } from "../config.js";
import { assertLocalStoreRuntimeEdition } from "./edition.js";
import { createEmbeddingProvidersFromEnv } from "../embeddings/index.js";
import { createEmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import {
  SandboxExecutor,
  parseAllowedSandboxCommands,
} from "../memory/sandbox.js";
import { type RecallStoreCapabilities } from "../store/recall-access.js";
import { createLiteRecallStore, type LiteRecallStore } from "../store/lite-recall-store.js";
import { createLiteReplayStore } from "../store/lite-replay-store.js";
import { createLiteRuntimeStore } from "../store/lite-runtime-store.js";
import { createSandboxStore } from "../store/sandbox-access.js";
import { createLiteWriteStore } from "../store/lite-write-store.js";
import { createLiteClaimLedgerStore } from "../store/lite-claim-ledger-store.js";
import { createLiteSkillCandidateReviewStore } from "../store/lite-skill-candidate-review-store.js";
import { createLocalAnnIndex } from "../store/ann/local-ann-index.js";
import { createZvecAnnIndex } from "../store/ann/zvec-ann-index.js";
import { createLiteExecutionStateStore } from "../execution/state-store.js";
import { createLiteExecutionTreeStore } from "../execution/tree-store.js";
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

export async function createRuntimeServices(env: Env) {
  assertLocalStoreRuntimeEdition(env, "local-store runtime services");
  const sandboxRemoteAllowedHosts = parseSandboxRemoteAllowedHosts(env.SANDBOX_REMOTE_EXECUTOR_ALLOWED_HOSTS_JSON);
  const sandboxRemoteAllowedCidrs = parseSandboxRemoteAllowedCidrs(env.SANDBOX_REMOTE_EXECUTOR_EGRESS_ALLOWED_CIDRS_JSON);
  const sandboxAllowedCommands = parseAllowedSandboxCommands(env.SANDBOX_ALLOWED_COMMANDS_JSON);
  const store = createLiteRuntimeStore(env.LITE_WRITE_SQLITE_PATH);
  const liteReplayStore = createLiteReplayStore(env.LITE_REPLAY_SQLITE_PATH);
  const liteReplayAccess = liteReplayStore?.createReplayAccess() ?? null;
  const annIndex =
    env.RECALL_ANN_PROVIDER === "local"
      ? createLocalAnnIndex()
      : env.RECALL_ANN_PROVIDER === "zvec"
        ? createZvecAnnIndex({
            path: env.RECALL_ZVEC_PATH.trim() || `${env.LITE_WRITE_SQLITE_PATH}.zvec-ann`,
          })
        : null;
  let annSyncedRecallStore: LiteRecallStore | null = null;
  const liteWriteStore = createLiteWriteStore(env.LITE_WRITE_SQLITE_PATH, {
    annSync: annIndex
      ? {
          syncNode: async (scope, nodeId) => {
            await annSyncedRecallStore?.syncAnnNode(scope, nodeId);
          },
          deleteNode: async (nodeId) => {
            await annSyncedRecallStore?.deleteAnnNode(nodeId);
          },
        }
      : null,
  });
  const liteClaimLedgerStore = createLiteClaimLedgerStore(env.LITE_WRITE_SQLITE_PATH);
  const claimLedgerAccess = liteClaimLedgerStore.createClaimLedgerAccess();
  const liteSkillCandidateReviewStore = createLiteSkillCandidateReviewStore(env.LITE_WRITE_SQLITE_PATH);
  const skillCandidateReviewAccess = liteSkillCandidateReviewStore.createSkillCandidateReviewAccess();
  const executionStateStore = createLiteExecutionStateStore(env.LITE_WRITE_SQLITE_PATH);
  const executionTreeStore = createLiteExecutionTreeStore(env.LITE_WRITE_SQLITE_PATH);
  const liteRecallStore = createLiteRecallStore(env.LITE_WRITE_SQLITE_PATH, {
    ann: annIndex
      ? {
          index: annIndex,
          rebuildOnStart: env.RECALL_ANN_REBUILD_ON_START,
          maxCandidates: env.RECALL_ANN_MAX_CANDIDATES,
          sourceReason: env.RECALL_ANN_PROVIDER === "zvec" ? "zvec_ann_index" : "local_ann_index",
          indexName: env.RECALL_ANN_PROVIDER === "zvec" ? "aionis_zvec_ann" : "aionis_local_ann",
        }
      : null,
  });
  annSyncedRecallStore = liteRecallStore;
  if (annIndex && env.RECALL_ANN_REBUILD_ON_START) {
    await liteRecallStore.rebuildAnnIndex();
  }
  const liteRecallAccess = liteRecallStore?.createRecallAccess() ?? null;
  const sandboxStore = createSandboxStore(store);

  const embeddingProviders = createEmbeddingProvidersFromEnv(process.env);
  const embedder = embeddingProviders.write;
  const queryEmbedder = embeddingProviders.query;
  const embeddingSurfacePolicy = createEmbeddingSurfacePolicy({
    providerConfigured: !!(embedder || queryEmbedder),
    enabledSurfaces: env.EMBEDDING_ENABLED_SURFACES_JSON,
  });
  const sandboxExecutor = new SandboxExecutor(sandboxStore, {
    enabled: env.SANDBOX_ENABLED,
    mode: env.SANDBOX_EXECUTOR_MODE,
    maxConcurrency: env.SANDBOX_EXECUTOR_MAX_CONCURRENCY,
    defaultTimeoutMs: env.SANDBOX_EXECUTOR_TIMEOUT_MS,
    stdioMaxBytes: env.SANDBOX_STDIO_MAX_BYTES,
    workdir: env.SANDBOX_EXECUTOR_WORKDIR,
    allowedCommands: sandboxAllowedCommands,
    remote: {
      url: env.SANDBOX_REMOTE_EXECUTOR_URL.trim() || null,
      authHeader: env.SANDBOX_REMOTE_EXECUTOR_AUTH_HEADER.trim(),
      authToken: env.SANDBOX_REMOTE_EXECUTOR_AUTH_TOKEN,
      timeoutMs: env.SANDBOX_REMOTE_EXECUTOR_TIMEOUT_MS,
      allowedHosts: sandboxRemoteAllowedHosts,
      allowedEgressCidrs: sandboxRemoteAllowedCidrs,
      denyPrivateIps: env.SANDBOX_REMOTE_EXECUTOR_EGRESS_DENY_PRIVATE_IPS,
      mtlsCertPem: env.SANDBOX_REMOTE_EXECUTOR_MTLS_CERT_PEM,
      mtlsKeyPem: env.SANDBOX_REMOTE_EXECUTOR_MTLS_KEY_PEM,
      mtlsCaPem: env.SANDBOX_REMOTE_EXECUTOR_MTLS_CA_PEM,
      mtlsServerName: env.SANDBOX_REMOTE_EXECUTOR_MTLS_SERVER_NAME,
    },
    artifactObjectStoreBaseUri: env.SANDBOX_ARTIFACT_OBJECT_STORE_BASE_URI.trim() || null,
    heartbeatIntervalMs: env.SANDBOX_RUN_HEARTBEAT_INTERVAL_MS,
    staleAfterMs: env.SANDBOX_RUN_STALE_AFTER_MS,
    recoveryPollIntervalMs: env.SANDBOX_RUN_RECOVERY_POLL_INTERVAL_MS,
    recoveryBatchSize: env.SANDBOX_RUN_RECOVERY_BATCH_SIZE,
  });
  const recallStoreCapabilities: RecallStoreCapabilities = {
    debug_embeddings: true,
    audit_insert: true,
  };

  const recallLimiter = env.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: env.RECALL_RATE_LIMIT_RPS,
        burst: env.RECALL_RATE_LIMIT_BURST,
        ttl_ms: env.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const debugEmbedLimiter = env.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: env.DEBUG_EMBED_RATE_LIMIT_RPS,
        burst: env.DEBUG_EMBED_RATE_LIMIT_BURST,
        ttl_ms: env.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const writeLimiter = env.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: env.WRITE_RATE_LIMIT_RPS,
        burst: env.WRITE_RATE_LIMIT_BURST,
        ttl_ms: env.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const recallTextEmbedLimiter = env.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: env.RECALL_TEXT_EMBED_RATE_LIMIT_RPS,
        burst: env.RECALL_TEXT_EMBED_RATE_LIMIT_BURST,
        ttl_ms: env.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;

  const sandboxTenantBudgetPolicy = parseSandboxTenantBudgetPolicy(env.SANDBOX_TENANT_BUDGET_POLICY_JSON);

  const recallTextEmbedCache =
    queryEmbedder && env.RECALL_TEXT_EMBED_CACHE_ENABLED
      ? new LruTtlCache<string, number[]>({
          maxEntries: env.RECALL_TEXT_EMBED_CACHE_MAX_KEYS,
          ttlMs: env.RECALL_TEXT_EMBED_CACHE_TTL_MS,
        })
      : null;
  const recallTextEmbedInflight = new Map<string, Promise<{ vector: number[]; queue_wait_ms: number; batch_size: number }>>();
  const recallTextEmbedBatcher =
    queryEmbedder && env.RECALL_TEXT_EMBED_BATCH_ENABLED
      ? new EmbedQueryBatcher({
          maxBatchSize: env.RECALL_TEXT_EMBED_BATCH_MAX_SIZE,
          maxBatchWaitMs: env.RECALL_TEXT_EMBED_BATCH_MAX_WAIT_MS,
          maxInflightBatches: env.RECALL_TEXT_EMBED_BATCH_MAX_INFLIGHT,
          maxQueue: env.RECALL_TEXT_EMBED_BATCH_QUEUE_MAX,
          queueTimeoutMs: env.RECALL_TEXT_EMBED_BATCH_QUEUE_TIMEOUT_MS,
          runBatch: async (texts) => {
            return await queryEmbedder.embed(texts);
          },
        })
      : null;

  const recallInflightGate = new InflightGate({
    maxInflight: env.API_RECALL_MAX_INFLIGHT,
    maxQueue: env.API_RECALL_QUEUE_MAX,
    queueTimeoutMs: env.API_RECALL_QUEUE_TIMEOUT_MS,
  });
  const writeInflightGate = new InflightGate({
    maxInflight: env.API_WRITE_MAX_INFLIGHT,
    maxQueue: env.API_WRITE_QUEUE_MAX,
    queueTimeoutMs: env.API_WRITE_QUEUE_TIMEOUT_MS,
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
