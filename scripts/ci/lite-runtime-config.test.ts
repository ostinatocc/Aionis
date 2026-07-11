import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../../src/config/runtime-config.ts";

const apiKeysJson = JSON.stringify({
  "config-test-key": {
    tenant_id: "tenant-config",
    agent_id: "agent-config",
    role: "developer",
  },
});

const productionAuthorityEnv = {
  AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: "config-current",
  AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: JSON.stringify({
    "config-current": "config-current-authority-secret-with-at-least-32-bytes",
  }),
};

function resolve(overrides: NodeJS.ProcessEnv = {}) {
  return loadRuntimeConfig({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    ...overrides,
  });
}

test("typed Runtime config resolves the local core posture", () => {
  const { env, config } = resolve();
  assert.equal(env.AIONIS_EDITION, "lite");
  assert.equal(config.runtime.profile.id, "local_core");
  assert.deepEqual(config.runtime.profile.components, ["sqlite"]);
  assert.equal(config.storage.LITE_WRITE_SQLITE_PATH, ".tmp/aionis-lite-write.sqlite");
  assert.equal(config.recall.RECALL_ANN_PROVIDER, "off");
  assert.equal(config.governance.MEMORY_AUTH_MODE, "off");
  assert.equal(config.providers.embedding.EMBEDDING_PROVIDER, "none");
  assert.equal("SANDBOX_ENABLED" in config.runtime, false);
  assert.equal("MEMORY_AUTH_MODE" in config.storage, false);
  assert.equal("RECALL_RATE_LIMIT_RPS" in config.recall, false);
  assert.equal(config.limits.RECALL_RATE_LIMIT_RPS, 10);
});

test("typed Runtime config resolves local Zvec and preserves explicit advanced overrides", () => {
  const { config } = resolve({
    RECALL_ANN_PROVIDER: "zvec",
    RECALL_ZVEC_PATH: ".tmp/custom-zvec",
    RECALL_ANN_MAX_CANDIDATES: "77",
    RECALL_ANN_REBUILD_ON_START: "true",
  });
  assert.equal(config.runtime.profile.id, "local_zvec");
  assert.deepEqual(config.runtime.profile.components, ["sqlite", "zvec"]);
  assert.equal(config.recall.RECALL_ZVEC_PATH, ".tmp/custom-zvec");
  assert.equal(config.recall.RECALL_ANN_MAX_CANDIDATES, 77);
  assert.equal(config.recall.RECALL_ANN_REBUILD_ON_START, true);
});

test("typed Runtime config resolves the local Substrate candidate posture", () => {
  const { config } = resolve({
    RECALL_SUBSTRATE_SIDECAR_ENABLED: "true",
    RECALL_SUBSTRATE_PATH: ".tmp/substrate.sqlite",
    RECALL_SUBSTRATE_MAX_CANDIDATES: "91",
    RECALL_SUBSTRATE_FAIL_OPEN: "false",
  });
  assert.equal(config.runtime.profile.id, "local_substrate");
  assert.deepEqual(config.runtime.profile.components, ["sqlite", "substrate"]);
  assert.equal(config.recall.RECALL_SUBSTRATE_MAX_CANDIDATES, 91);
  assert.equal(config.recall.RECALL_SUBSTRATE_FAIL_OPEN, false);
});

test("typed Runtime config resolves the full-local Runtime composition", () => {
  const { config } = resolve({
    RECALL_ANN_PROVIDER: "zvec",
    RECALL_ZVEC_PATH: ".tmp/full-zvec",
    RECALL_SUBSTRATE_SIDECAR_ENABLED: "true",
    RECALL_SUBSTRATE_PATH: ".tmp/full-substrate.sqlite",
  });
  assert.equal(config.runtime.profile.id, "full_local");
  assert.deepEqual(config.runtime.profile.components, ["sqlite", "zvec", "substrate"]);
});

test("typed Runtime config preserves authenticated server development overrides", () => {
  const { env, config } = resolve({
    AIONIS_EDITION: "server",
    AIONIS_MODE: "service",
    APP_ENV: "dev",
    MEMORY_AUTH_MODE: "api_key",
    MEMORY_API_KEYS_JSON: apiKeysJson,
    TENANT_QUOTA_ENABLED: "false",
    RATE_LIMIT_BYPASS_LOOPBACK: "true",
  });
  assert.equal(env.APP_ENV, "dev", "explicit APP_ENV must override service profile default");
  assert.equal(config.runtime.profile.id, "server_development");
  assert.equal(config.governance.MEMORY_AUTH_MODE, "api_key");
  assert.equal(config.governance.TENANT_QUOTA_ENABLED, false);
  assert.equal(config.limits.RATE_LIMIT_BYPASS_LOOPBACK, true);
});

test("production server posture fails closed before Runtime sections are constructed", () => {
  const source = {
    AIONIS_EDITION: "server",
    AIONIS_MODE: "service",
    MEMORY_AUTH_MODE: "api_key",
    MEMORY_API_KEYS_JSON: apiKeysJson,
    SANDBOX_ENABLED: "false",
  };
  assert.throws(
    () => resolve(source),
    /AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID.*APP_ENV=prod/i,
  );

  const { config } = resolve({ ...source, ...productionAuthorityEnv });
  assert.equal(config.runtime.profile.id, "server_production");
  assert.equal(config.governance.MEMORY_AUTH_MODE, "api_key");
  assert.equal(config.governance.TENANT_QUOTA_ENABLED, true);
  assert.equal(config.limits.RATE_LIMIT_BYPASS_LOOPBACK, false);
});

test("provider config is parsed once into the provider section", () => {
  const { config } = resolve({
    EMBEDDING_PROVIDER: "openai",
    OPENAI_API_KEY: "config-provider-key",
    OPENAI_EMBED_BASE_URL: "https://example.invalid/v1",
    OPENAI_EMBED_BATCH_SIZE: "7",
  });
  assert.equal(config.providers.embedding.EMBEDDING_PROVIDER, "openai");
  assert.equal(config.providers.embedding.OPENAI_API_KEY, "config-provider-key");
  assert.equal(config.providers.embedding.OPENAI_EMBED_BASE_URL, "https://example.invalid/v1");
  assert.equal(config.providers.embedding.OPENAI_EMBED_BATCH_SIZE, 7);
});

test("HTTP CORS settings are captured once in the runtime section", () => {
  const { config } = resolve({
    CORS_ALLOW_ORIGINS: "https://one.example, https://two.example",
    CORS_ADMIN_ALLOW_ORIGINS: "https://admin.example",
  });
  assert.deepEqual(config.runtime.cors.memoryAllowOrigins, ["https://one.example", "https://two.example"]);
  assert.deepEqual(config.runtime.cors.adminAllowOrigins, ["https://admin.example"]);
});

test("focused Runtime drops removed backend, control-plane, and dormant policy fields", () => {
  const removedFields = [
    "DB_POOL_MAX",
    "CONTROL_TENANT_QUOTA_CACHE_TTL_MS",
    "SANDBOX_RETENTION_DAYS",
    "EPISODE_GC_RULE_STABLE_POSITIVE_MIN",
    "MEMORY_ABSTRACTION_POLICY_PROFILE",
    "MEMORY_TIER_WARM_BELOW",
    "MEMORY_ADAPTIVE_DECAY_ENABLED",
    "MEMORY_COMPRESSION_LOOKBACK_DAYS",
    "MEMORY_CONSOLIDATION_MIN_SCORE",
    "REPLAY_LEARNING_FAULT_INJECTION_ENABLED",
  ] as const;
  const source = Object.fromEntries(removedFields.map((field) => [field, "1"]));
  const { env, config } = resolve(source);

  for (const field of removedFields) {
    assert.equal(Object.hasOwn(env, field), false, `${field} should not remain in Env`);
    for (const section of Object.values(config)) {
      assert.equal(Object.hasOwn(section, field), false, `${field} should not leak into RuntimeConfig`);
    }
  }
});
