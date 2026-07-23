import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  CONTINUATION_RUNTIME_V1_WORKER_ENV_FIELDS,
  loadContinuationRuntimeV1WorkerConfig,
  publicContinuationRuntimeV1WorkerConfig,
} from "../../src/runtime-v1/worker-config.js";
import type { ContinuationRuntimeV1WorkerRole } from
  "../../src/runtime-v1/worker-identity.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "aionis-v1-worker-config-"));
let fixtureSequence = 0;
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function apiKeyFile(value = "s".repeat(32)): string {
  const path = join(fixtureRoot, `embedding-key-${fixtureSequence++}`);
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

function requiredEnv(
  workerRole: ContinuationRuntimeV1WorkerRole = "effect",
): Record<string, string> {
  const common = {
    PATH: "/usr/bin",
    AIONIS_DATA_PATH: "/tmp/aionis-v1/runtime.sqlite",
    AIONIS_TENANT_ID: "tenant-a",
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-v1/trust-root.pem",
    AIONIS_TRUST_ROOT_SHA256: "0".repeat(64),
    AIONIS_WORKER_ROLE: workerRole,
  };
  return workerRole === "effect"
    ? {
        ...common,
        AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH: "/tmp/aionis-v1/effect-signer.pem",
        AIONIS_EFFECT_SIGNER_SHA256: "1".repeat(64),
      }
    : common;
}

function embeddingEnv(): Record<string, string> {
  return {
    ...requiredEnv("embedding"),
    AIONIS_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    AIONIS_EMBEDDING_MODEL: "qwen3.7-text-embedding",
    AIONIS_EMBEDDING_API_KEY_FILE: apiKeyFile(),
    AIONIS_EMBEDDING_DIMENSIONS: "1024",
  };
}

test("worker config has exactly sixteen governed fields and ten common role fields", () => {
  assert.equal(CONTINUATION_RUNTIME_V1_WORKER_ENV_FIELDS.length, 16);
  assert.equal(new Set(CONTINUATION_RUNTIME_V1_WORKER_ENV_FIELDS).size, 16);
  const config = loadContinuationRuntimeV1WorkerConfig(requiredEnv());
  assert.deepEqual(config, {
    dataPath: "/tmp/aionis-v1/runtime.sqlite",
    tenantId: "tenant-a",
    trustRootPublicKeyPath: "/tmp/aionis-v1/trust-root.pem",
    trustRootSha256: "0".repeat(64),
    workerRole: "effect",
    jobs: { pollMs: 250, batchSize: 16, leaseMs: 60_000 },
    logLevel: "info",
    shutdownTimeoutMs: 30_000,
    embedding: null,
    effect: {
      signerPrivateKeyPath: "/tmp/aionis-v1/effect-signer.pem",
      signerSha256: "1".repeat(64),
    },
  });
  assert.equal("httpHost" in config, false);
  assert.equal("httpPort" in config, false);
  assert.equal("httpBodyLimitBytes" in config, false);
  assert.equal("hostApiKeySha256" in config, false);
  assert.equal("operatorApiKeySha256" in config, false);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.jobs));
});

test("only the effect role requires and retains its dedicated signing key identity", () => {
  const config = loadContinuationRuntimeV1WorkerConfig(requiredEnv("effect"));
  assert.deepEqual(config.effect, {
    signerPrivateKeyPath: "/tmp/aionis-v1/effect-signer.pem",
    signerSha256: "1".repeat(64),
  });
  for (const field of [
    "AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH",
    "AIONIS_EFFECT_SIGNER_SHA256",
  ] as const) {
    const partial = requiredEnv("effect");
    delete partial[field];
    assert.throws(
      () => loadContinuationRuntimeV1WorkerConfig(partial),
      /effect_signer_configuration_required_for_effect_worker/u,
      field,
    );
    for (const role of ["embedding", "ann", "retention"] as const) {
      assert.throws(
        () => loadContinuationRuntimeV1WorkerConfig({
          ...(role === "embedding" ? embeddingEnv() : requiredEnv(role)),
          [field]: "forbidden",
        }),
        /effect_signer_configuration_forbidden_for_worker_role/u,
        `${role}:${field}`,
      );
    }
  }
  assert.throws(
    () => loadContinuationRuntimeV1WorkerConfig({
      ...requiredEnv("effect"),
      AIONIS_EFFECT_SIGNER_SHA256: "0".repeat(64),
    }),
    /effect_signer_must_not_reuse_authority_root/u,
  );
});

test("only the embedding role requires and retains all four provider fields", () => {
  const environment = embeddingEnv();
  const config = loadContinuationRuntimeV1WorkerConfig(environment);
  assert.deepEqual(config.embedding, {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-text-embedding",
    apiKeyFilePath: environment.AIONIS_EMBEDDING_API_KEY_FILE,
    dimensions: 1024,
  });
  assert.equal(config.embedding?.apiKeyFilePath.startsWith(fixtureRoot), true);
  for (const field of [
    "AIONIS_EMBEDDING_BASE_URL",
    "AIONIS_EMBEDDING_MODEL",
    "AIONIS_EMBEDDING_API_KEY_FILE",
    "AIONIS_EMBEDDING_DIMENSIONS",
  ] as const) {
    const partial = embeddingEnv();
    delete partial[field];
    assert.throws(
      () => loadContinuationRuntimeV1WorkerConfig(partial),
      /embedding_configuration_required_for_embedding_worker/u,
      field,
    );
  }
});

test("ANN, effect, and retention roles reject every embedding provider field", () => {
  for (const role of ["ann", "effect", "retention"] as const) {
    for (const field of [
      "AIONIS_EMBEDDING_BASE_URL",
      "AIONIS_EMBEDDING_MODEL",
      "AIONIS_EMBEDDING_API_KEY_FILE",
      "AIONIS_EMBEDDING_DIMENSIONS",
    ] as const) {
      assert.throws(
        () => loadContinuationRuntimeV1WorkerConfig({
          ...requiredEnv(role),
          [field]: "forbidden",
        }),
        /embedding_configuration_forbidden_for_worker_role/u,
        `${role}:${field}`,
      );
    }
  }
  assert.throws(() => loadContinuationRuntimeV1WorkerConfig({
    ...embeddingEnv(),
    AIONIS_EMBEDDING_API_KEY: "legacy-plaintext-provider-secret",
  }), /unknown_AIONIS_fields:AIONIS_EMBEDDING_API_KEY/u);
});

test("worker rejects daemon authentication and HTTP controls instead of parsing them", () => {
  for (const field of [
    "AIONIS_HOST_API_KEY",
    "AIONIS_HOST_API_KEY_FILE",
    "AIONIS_HOST_PRINCIPAL_ID",
    "AIONIS_OPERATOR_API_KEY",
    "AIONIS_OPERATOR_API_KEY_FILE",
    "AIONIS_OPERATOR_PRINCIPAL_ID",
    "AIONIS_HTTP_HOST",
    "AIONIS_HTTP_PORT",
    "AIONIS_HTTP_BODY_LIMIT_BYTES",
    "AIONIS_API_KEY",
    "AIONIS_PRINCIPAL_ID",
  ] as const) {
    assert.throws(
      () => loadContinuationRuntimeV1WorkerConfig({
        ...requiredEnv(),
        [field]: "forbidden",
      }),
      /unknown_AIONIS_fields/u,
      field,
    );
  }
});

test("worker validates role, queue posture, paths, pin, and provider endpoint", () => {
  for (const [field, value] of [
    ["AIONIS_WORKER_ROLE", "eval"],
    ["AIONIS_DATA_PATH", "relative.sqlite"],
    ["AIONIS_JOB_POLL_MS", "0"],
    ["AIONIS_JOB_BATCH_SIZE", "257"],
    ["AIONIS_JOB_LEASE_MS", "0999"],
    ["AIONIS_SHUTDOWN_TIMEOUT_MS", "999"],
    ["AIONIS_TRUST_ROOT_SHA256", "A".repeat(64)],
  ] as const) {
    assert.throws(
      () => loadContinuationRuntimeV1WorkerConfig({
        ...requiredEnv(),
        [field]: value,
      }),
      /continuation_runtime_v1_worker_config_invalid/u,
      field,
    );
  }
  for (const baseUrl of [
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?x=1",
  ]) {
    assert.throws(
      () => loadContinuationRuntimeV1WorkerConfig({
        ...embeddingEnv(),
        AIONIS_EMBEDDING_BASE_URL: baseUrl,
      }),
      /continuation_runtime_v1_worker_config_invalid/u,
    );
  }
  assert.doesNotThrow(() => loadContinuationRuntimeV1WorkerConfig({
    ...embeddingEnv(),
    AIONIS_EMBEDDING_BASE_URL: "http://127.0.0.1:11434/v1",
  }));
});

test("worker public config never exposes provider credentials, paths, or tenant identity", () => {
  const secret = "secret-value-that-must-never-leak";
  const config = loadContinuationRuntimeV1WorkerConfig({
    ...embeddingEnv(),
    AIONIS_DATA_PATH: `/tmp/${secret}/runtime.sqlite`,
    AIONIS_TENANT_ID: `${secret}-tenant`,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: `/tmp/${secret}/root.pem`,
    AIONIS_EMBEDDING_API_KEY_FILE: `/tmp/${secret}/embedding-key`,
  });
  const publicConfig = publicContinuationRuntimeV1WorkerConfig(config);
  const serialized = JSON.stringify(publicConfig);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(publicConfig.embedding, {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-text-embedding",
    dimensions: 1024,
    apiKeyFileConfigured: true,
  });
  assert.equal(publicConfig.effect, null);
  assert.ok(Object.isFrozen(publicConfig));
  assert.ok(Object.isFrozen(publicConfig.jobs));
  assert.ok(Object.isFrozen(publicConfig.embedding));

  const effectConfig = loadContinuationRuntimeV1WorkerConfig({
    ...requiredEnv("effect"),
    AIONIS_DATA_PATH: `/tmp/${secret}/runtime.sqlite`,
    AIONIS_TENANT_ID: `${secret}-tenant`,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: `/tmp/${secret}/root.pem`,
    AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH: `/tmp/${secret}/effect.pem`,
  });
  const publicEffectConfig = publicContinuationRuntimeV1WorkerConfig(effectConfig);
  assert.equal(JSON.stringify(publicEffectConfig).includes(secret), false);
  assert.deepEqual(publicEffectConfig.effect, {
    signerPrivateKeyPathConfigured: true,
    signerSha256: "1".repeat(64),
  });
  assert.equal(publicEffectConfig.embedding, null);
  assert.ok(Object.isFrozen(publicEffectConfig.effect));
});
