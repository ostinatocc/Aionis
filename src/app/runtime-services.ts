import type { RuntimeConfig } from "../config/runtime-config.js";
import { assertLocalStoreRuntimeEdition } from "./edition.js";
import { createEmbeddingProviders } from "../embeddings/index.js";
import { createLiteRecallStore } from "../store/lite-recall-store.js";
import { createLiteWriteStoreFromDatabase } from "../store/lite-write-store.js";
import { createLiteRuntimeDatabase } from "../store/lite-runtime-database.js";
import { createLiteEvidenceArtifactStore } from "../store/lite-evidence-artifact-store.js";
import { createLiteExecutionEpisodeStore } from "../store/lite-execution-episode-store.js";
import {
  createLiteExecutionSessionLeaseStore,
} from "../store/lite-execution-session-lease-store.js";
import {
  LiteTenantScopeAuthorityError,
  ensureLiteTenantScopeEncodingAnchor,
} from "../store/lite-tenant-scope-authority.js";
import { createLocalAnnIndex } from "../store/ann/local-ann-index.js";
import { createZvecAnnIndex } from "../store/ann/zvec-ann-index.js";
import { createSubstrateSidecarCandidateProvider } from "../store/substrate-sidecar-recall.js";
import { createLiteExecutionStateStoreFromDatabase } from "../execution/state-store.js";
import { createLiteExecutionTreeStoreFromDatabase } from "../execution/tree-store.js";
import { createRuntimeEpisodeVerifierRegistry } from "../execution/runtime-episode-verifier-registry.js";
import {
  createSubjectStateAdapterRegistry,
} from "../execution/subject-state-adapter-registry.js";
import {
  createWorkspaceSubjectStateAdapter,
} from "../execution/workspace-subject-state-adapter.js";
import {
  createStructuredArtifactSubjectStateAdapter,
} from "../execution/structured-artifact-subject-state-adapter.js";
import {
  createSqliteDatabaseSubjectStateAdapter,
} from "../execution/sqlite-database-subject-state-adapter.js";
import {
  createRuntimeEpisodeVerifierInvocationAuthorityChannel,
} from "../execution/runtime-episode-verifier-launch-authority.js";
import { createExecutionEpisodeService } from "../product/execution-episode-service.js";
import {
  createExecutionTurnTransactionService,
} from "../product/execution-turn-transaction-service.js";
import { InflightGate } from "../util/inflight_gate.js";
import { TokenBucketLimiter } from "../util/ratelimit.js";

export type RuntimeServiceConfig = Pick<
  RuntimeConfig,
  "runtime" | "storage" | "recall" | "limits" | "execution" | "providers"
>;

export async function createRuntimeServices(config: RuntimeServiceConfig) {
  const { runtime, storage, recall, limits, providers } = config;
  const { execution } = config;
  assertLocalStoreRuntimeEdition(runtime, "local-store runtime services");
  const verifierInvocationAuthorityChannel =
    createRuntimeEpisodeVerifierInvocationAuthorityChannel();
  const verifierRegistry = createRuntimeEpisodeVerifierRegistry(
    execution.episodeVerifierDefinitions,
    verifierInvocationAuthorityChannel.verifier,
  );
  const subjectAdapterRegistry = createSubjectStateAdapterRegistry([
    createWorkspaceSubjectStateAdapter(),
    createStructuredArtifactSubjectStateAdapter(),
    createSqliteDatabaseSubjectStateAdapter(),
  ]);
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
  const evidenceArtifactStore = createLiteEvidenceArtifactStore(runtimeDatabase);
  const executionStateStore = createLiteExecutionStateStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const executionEpisodeStore = createLiteExecutionEpisodeStore(
    runtimeDatabase,
    {
      verifierInvocationAuthorityIssuer:
        verifierInvocationAuthorityChannel.issuer,
      verifierInvocationAuthorityVerifier:
        verifierInvocationAuthorityChannel.verifier,
    },
  );
  const executionSessionLeaseStore =
    createLiteExecutionSessionLeaseStore(runtimeDatabase);
  const executionEpisodeService = createExecutionEpisodeService({
    artifactStore: evidenceArtifactStore,
    episodeStore: executionEpisodeStore,
    stateStore: executionStateStore,
    sessionLeaseStore: executionSessionLeaseStore,
    verifierRegistry,
    subjectAdapterRegistry,
  });
  const executionTurnTransactionService =
    createExecutionTurnTransactionService({
      episodeService: executionEpisodeService,
      episodeStore: executionEpisodeStore,
      stateStore: executionStateStore,
      sessionLeaseStore: executionSessionLeaseStore,
    });
  await executionEpisodeService.recoverInterruptedVerifierLaunches();
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
      await liteWriteStore.close();
      throw error;
    }
    // A legacy database cannot safely infer who owns its unprefixed scopes.
    // Keep the Runtime available, but leave confirmatory provisioning fail-closed
    // until an explicit offline migration establishes the immutable anchor.
  }
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
  const embeddingProviders = createEmbeddingProviders(providers.embedding);
  const embedder = embeddingProviders.write;
  const queryEmbedder = embeddingProviders.query;
  const recallLimiter = limits.RATE_LIMIT_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.RECALL_RATE_LIMIT_RPS,
        burst: limits.RECALL_RATE_LIMIT_BURST,
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
    liteRecallStore,
    liteRecallAccess,
    liteWriteStore,
    evidenceArtifactStore,
    executionEpisodeStore,
    executionEpisodeService,
    executionSessionLeaseStore,
    executionTurnTransactionService,
    verifierRegistry,
    executionStateStore,
    executionTreeStore,
    embedder,
    queryEmbedder,
    recallLimiter,
    writeLimiter,
    recallInflightGate,
    writeInflightGate,
  };
}
