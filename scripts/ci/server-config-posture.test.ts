import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../../src/config.ts";

async function withIsolatedEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    await fn();
  } finally {
    process.env = previous;
  }
}

const apiKeysJson = JSON.stringify({
  "dev-key": {
    tenant_id: "tenant-a",
    agent_id: "agent-a",
    team_id: "team-a",
    role: "developer",
  },
});
const prodAuthorityReceiptEnv = {
  AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: "authority-test-current",
  AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: JSON.stringify({
    "authority-test-current": "authority-test-current-secret-with-at-least-32-bytes",
  }),
};

test("server edition accepts service mode with api key auth", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: apiKeysJson,
      SANDBOX_ENABLED: "false",
      ...prodAuthorityReceiptEnv,
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_EDITION, "server");
      assert.equal(env.AIONIS_MODE, "service");
      assert.equal(env.APP_ENV, "prod");
      assert.equal(env.MEMORY_AUTH_MODE, "api_key");
      assert.equal(env.TENANT_QUOTA_ENABLED, true);
      assert.equal(env.RATE_LIMIT_BYPASS_LOOPBACK, false);
      assert.equal(env.RECALL_ENGINE_MODE, "hybrid");
      assert.equal(env.RUNTIME_VERIFIER_EXECUTION_ENABLED, false);
    },
  );
});

test("server prod rejects runtime verifier command execution", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: apiKeysJson,
      SANDBOX_ENABLED: "false",
      ...prodAuthorityReceiptEnv,
      RUNTIME_VERIFIER_EXECUTION_ENABLED: "true",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /RUNTIME_VERIFIER_EXECUTION_ENABLED=true is not allowed when APP_ENV=prod/i,
      );
    },
  );
});

test("server edition rejects auth off by default", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "off",
      APP_ENV: "dev",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Aionis Server requires MEMORY_AUTH_MODE=api_key, jwt, or api_key_or_jwt/i,
      );
    },
  );
});

test("server edition can explicitly keep semantic scan recall", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: apiKeysJson,
      RECALL_ENGINE_MODE: "semantic_scan",
      SANDBOX_ENABLED: "false",
      ...prodAuthorityReceiptEnv,
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_EDITION, "server");
      assert.equal(env.RECALL_ENGINE_MODE, "semantic_scan");
    },
  );
});

test("server edition rejects invalid recall engine mode", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: apiKeysJson,
      RECALL_ENGINE_MODE: "vector_magic",
      SANDBOX_ENABLED: "false",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /RECALL_ENGINE_MODE/i,
      );
    },
  );
});

test("server prod jwt auth requires exp and a strong HS256 secret", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "jwt",
      MEMORY_JWT_HS256_SECRET: "jwt-secret-with-at-least-32-bytes",
      MEMORY_JWT_REQUIRE_EXP: "false",
      SANDBOX_ENABLED: "false",
      ...prodAuthorityReceiptEnv,
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /MEMORY_JWT_REQUIRE_EXP=false is not allowed/i,
      );
    },
  );

  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "jwt",
      MEMORY_JWT_HS256_SECRET: "short-secret",
      SANDBOX_ENABLED: "false",
      ...prodAuthorityReceiptEnv,
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /MEMORY_JWT_HS256_SECRET must be at least 32 bytes/i,
      );
    },
  );
});

test("server edition allows auth off only for explicit dev posture", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      APP_ENV: "dev",
      MEMORY_AUTH_MODE: "off",
      AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV: "true",
      TENANT_QUOTA_ENABLED: "false",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_EDITION, "server");
      assert.equal(env.AIONIS_MODE, "service");
      assert.equal(env.APP_ENV, "dev");
      assert.equal(env.MEMORY_AUTH_MODE, "off");
      assert.equal(env.AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV, true);
      assert.equal(env.TENANT_QUOTA_ENABLED, false);
    },
  );
});

test("server edition rejects local mode posture", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "local",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: apiKeysJson,
      ...prodAuthorityReceiptEnv,
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Aionis Server requires AIONIS_MODE=service/i,
      );
    },
  );
});

test("server prod requires explicit authority receipt HMAC key material", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "server",
      AIONIS_MODE: "service",
      MEMORY_AUTH_MODE: "api_key",
      MEMORY_API_KEYS_JSON: apiKeysJson,
      SANDBOX_ENABLED: "false",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID.*APP_ENV=prod/i,
      );
    },
  );
});

test("lite edition keeps auth off default", async () => {
  await withIsolatedEnv({}, () => {
    const env = loadEnv();
    assert.equal(env.AIONIS_EDITION, "lite");
    assert.equal(env.AIONIS_MODE, "local");
    assert.equal(env.MEMORY_AUTH_MODE, "off");
    assert.equal(env.TENANT_QUOTA_ENABLED, false);
  });
});
