import {
  canonicalContinuationClone,
  type Sha256,
} from "../continuation/contract.js";
import {
  continuationRuntimeV1AbsolutePath,
  continuationRuntimeV1EmbeddingBaseUrl,
  continuationRuntimeV1EnvPresent,
  continuationRuntimeV1Integer,
  continuationRuntimeV1LogLevel,
  continuationRuntimeV1RequiredSha256,
  continuationRuntimeV1RequiredText,
  continuationRuntimeV1Sha256,
  strictContinuationRuntimeV1Environment,
  type ContinuationRuntimeV1LogLevel,
} from "./config-support.js";
import type { ContinuationRuntimeV1WorkerRole } from "./worker-identity.js";

/**
 * The worker process's complete configuration authority surface. Daemon-only
 * HTTP and caller-authentication fields are intentionally absent.
 */
export const CONTINUATION_RUNTIME_V1_WORKER_ENV_FIELDS = Object.freeze([
  "AIONIS_DATA_PATH",
  "AIONIS_EMBEDDING_API_KEY_FILE",
  "AIONIS_EMBEDDING_BASE_URL",
  "AIONIS_EMBEDDING_DIMENSIONS",
  "AIONIS_EMBEDDING_MODEL",
  "AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH",
  "AIONIS_EFFECT_SIGNER_SHA256",
  "AIONIS_JOB_BATCH_SIZE",
  "AIONIS_JOB_LEASE_MS",
  "AIONIS_JOB_POLL_MS",
  "AIONIS_LOG_LEVEL",
  "AIONIS_SHUTDOWN_TIMEOUT_MS",
  "AIONIS_TENANT_ID",
  "AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH",
  "AIONIS_TRUST_ROOT_SHA256",
  "AIONIS_WORKER_ROLE",
] as const);

const EMBEDDING_FIELDS = Object.freeze([
  "AIONIS_EMBEDDING_API_KEY_FILE",
  "AIONIS_EMBEDDING_BASE_URL",
  "AIONIS_EMBEDDING_DIMENSIONS",
  "AIONIS_EMBEDDING_MODEL",
] as const);

const EFFECT_SIGNER_FIELDS = Object.freeze([
  "AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH",
  "AIONIS_EFFECT_SIGNER_SHA256",
] as const);

export type ContinuationRuntimeV1EmbeddingWorkerConfig = Readonly<{
  baseUrl: string;
  model: string;
  apiKeyFilePath: string;
  dimensions: number;
}>;

export type ContinuationRuntimeV1EffectWorkerConfig = Readonly<{
  signerPrivateKeyPath: string;
  signerSha256: Sha256;
}>;

export type ContinuationRuntimeV1WorkerConfig = Readonly<{
  dataPath: string;
  tenantId: string;
  trustRootPublicKeyPath: string;
  trustRootSha256: Sha256;
  workerRole: ContinuationRuntimeV1WorkerRole;
  jobs: Readonly<{
    pollMs: number;
    batchSize: number;
    leaseMs: number;
  }>;
  logLevel: ContinuationRuntimeV1LogLevel;
  shutdownTimeoutMs: number;
  embedding: ContinuationRuntimeV1EmbeddingWorkerConfig | null;
  effect: ContinuationRuntimeV1EffectWorkerConfig | null;
}>;

export type PublicContinuationRuntimeV1WorkerConfig = Readonly<{
  dataPathConfigured: true;
  tenantIdSha256: Sha256;
  trustRootPublicKeyPathConfigured: true;
  trustRootSha256: Sha256;
  workerRole: ContinuationRuntimeV1WorkerRole;
  jobs: Readonly<{
    pollMs: number;
    batchSize: number;
    leaseMs: number;
  }>;
  logLevel: ContinuationRuntimeV1LogLevel;
  shutdownTimeoutMs: number;
  embedding: null | Readonly<{
    baseUrl: string;
    model: string;
    dimensions: number;
    apiKeyFileConfigured: true;
  }>;
  effect: null | Readonly<{
    signerPrivateKeyPathConfigured: true;
    signerSha256: Sha256;
  }>;
}>;

function fail(message: string): never {
  throw new Error(`continuation_runtime_v1_worker_config_invalid:${message}`);
}

function workerRole(value: string): ContinuationRuntimeV1WorkerRole {
  if (value !== "embedding" && value !== "ann"
    && value !== "effect" && value !== "retention") {
    fail("AIONIS_WORKER_ROLE_is_not_supported");
  }
  return value;
}

function embeddingConfig(
  env: Readonly<Record<string, string | undefined>>,
  role: ContinuationRuntimeV1WorkerRole,
): ContinuationRuntimeV1EmbeddingWorkerConfig | null {
  const count = EMBEDDING_FIELDS.filter((field) => (
    continuationRuntimeV1EnvPresent(env, field)
  )).length;
  if (role !== "embedding") {
    if (count !== 0) fail("embedding_configuration_forbidden_for_worker_role");
    return null;
  }
  if (count !== EMBEDDING_FIELDS.length) {
    fail("embedding_configuration_required_for_embedding_worker");
  }
  return canonicalContinuationClone({
    baseUrl: continuationRuntimeV1EmbeddingBaseUrl(
      continuationRuntimeV1RequiredText(
        env,
        "AIONIS_EMBEDDING_BASE_URL",
        2048,
        fail,
      ),
      fail,
    ),
    model: continuationRuntimeV1RequiredText(
      env,
      "AIONIS_EMBEDDING_MODEL",
      256,
      fail,
    ),
    apiKeyFilePath: continuationRuntimeV1AbsolutePath(
      env,
      "AIONIS_EMBEDDING_API_KEY_FILE",
      fail,
    ),
    dimensions: continuationRuntimeV1Integer(
      env,
      "AIONIS_EMBEDDING_DIMENSIONS",
      0,
      1,
      65_536,
      fail,
    ),
  });
}

function effectConfig(
  env: Readonly<Record<string, string | undefined>>,
  role: ContinuationRuntimeV1WorkerRole,
): ContinuationRuntimeV1EffectWorkerConfig | null {
  const count = EFFECT_SIGNER_FIELDS.filter((field) => (
    continuationRuntimeV1EnvPresent(env, field)
  )).length;
  if (role !== "effect") {
    if (count !== 0) fail("effect_signer_configuration_forbidden_for_worker_role");
    return null;
  }
  if (count !== EFFECT_SIGNER_FIELDS.length) {
    fail("effect_signer_configuration_required_for_effect_worker");
  }
  return canonicalContinuationClone({
    signerPrivateKeyPath: continuationRuntimeV1AbsolutePath(
      env,
      "AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH",
      fail,
    ),
    signerSha256: continuationRuntimeV1RequiredSha256(
      env,
      "AIONIS_EFFECT_SIGNER_SHA256",
      fail,
    ),
  });
}

export function loadContinuationRuntimeV1WorkerConfig(
  value: unknown,
): ContinuationRuntimeV1WorkerConfig {
  const env = strictContinuationRuntimeV1Environment(
    value,
    CONTINUATION_RUNTIME_V1_WORKER_ENV_FIELDS,
    fail,
  );
  const role = workerRole(
    continuationRuntimeV1RequiredText(env, "AIONIS_WORKER_ROLE", 32, fail),
  );
  const trustRootSha256 = continuationRuntimeV1RequiredSha256(
    env,
    "AIONIS_TRUST_ROOT_SHA256",
    fail,
  );
  const effect = effectConfig(env, role);
  if (effect?.signerSha256 === trustRootSha256) {
    fail("effect_signer_must_not_reuse_authority_root");
  }
  return canonicalContinuationClone({
    dataPath: continuationRuntimeV1AbsolutePath(env, "AIONIS_DATA_PATH", fail),
    tenantId: continuationRuntimeV1RequiredText(env, "AIONIS_TENANT_ID", 256, fail),
    trustRootPublicKeyPath: continuationRuntimeV1AbsolutePath(
      env,
      "AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH",
      fail,
    ),
    trustRootSha256,
    workerRole: role,
    jobs: {
      pollMs: continuationRuntimeV1Integer(
        env,
        "AIONIS_JOB_POLL_MS",
        250,
        10,
        60_000,
        fail,
      ),
      batchSize: continuationRuntimeV1Integer(
        env,
        "AIONIS_JOB_BATCH_SIZE",
        16,
        1,
        256,
        fail,
      ),
      leaseMs: continuationRuntimeV1Integer(
        env,
        "AIONIS_JOB_LEASE_MS",
        60_000,
        1_000,
        3_600_000,
        fail,
      ),
    },
    logLevel: continuationRuntimeV1LogLevel(env, fail),
    shutdownTimeoutMs: continuationRuntimeV1Integer(
      env,
      "AIONIS_SHUTDOWN_TIMEOUT_MS",
      30_000,
      1_000,
      300_000,
      fail,
    ),
    embedding: embeddingConfig(env, role),
    effect,
  });
}

export function publicContinuationRuntimeV1WorkerConfig(
  config: ContinuationRuntimeV1WorkerConfig,
): PublicContinuationRuntimeV1WorkerConfig {
  return canonicalContinuationClone({
    dataPathConfigured: true as const,
    tenantIdSha256: continuationRuntimeV1Sha256(config.tenantId),
    trustRootPublicKeyPathConfigured: true as const,
    trustRootSha256: config.trustRootSha256,
    workerRole: config.workerRole,
    jobs: config.jobs,
    logLevel: config.logLevel,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    embedding: config.embedding === null
      ? null
      : {
          baseUrl: config.embedding.baseUrl,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          apiKeyFileConfigured: true as const,
        },
    effect: config.effect === null
      ? null
      : {
          signerPrivateKeyPathConfigured: true as const,
          signerSha256: config.effect.signerSha256,
        },
  });
}
