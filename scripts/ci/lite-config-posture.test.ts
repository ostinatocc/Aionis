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

test("shipped source tree defaults to lite posture", async () => {
  await withIsolatedEnv({}, () => {
    const env = loadEnv();
    assert.equal(env.AIONIS_EDITION, "lite");
    assert.equal(env.AIONIS_MODE, "local");
    assert.equal(env.AIONIS_INSPECT_BEFORE_USE_MODE, "shadow");
    assert.equal(env.MEMORY_AUTH_MODE, "off");
    assert.equal(env.TENANT_QUOTA_ENABLED, false);
  });
});

test("inspect-before-use active projection is explicit opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_INSPECT_BEFORE_USE_MODE: "active",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_INSPECT_BEFORE_USE_MODE, "active");
    },
  );
});

test("lite plus prod fails with an explicit posture error", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      APP_ENV: "prod",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Lite runtime does not currently support APP_ENV=prod; use APP_ENV=dev\/ci\./i,
      );
    },
  );
});

test("lite unauthenticated remote bind requires explicit operator opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_LISTEN_HOST: "0.0.0.0",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /AIONIS_LISTEN_HOST exposes an unauthenticated Lite Runtime/i,
      );
    },
  );
});

test("lite unauthenticated remote bind can be intentionally enabled", async () => {
  await withIsolatedEnv(
    {
      AIONIS_LISTEN_HOST: "0.0.0.0",
      AIONIS_ALLOW_UNAUTHENTICATED_REMOTE: "true",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_LISTEN_HOST, "0.0.0.0");
      assert.equal(env.AIONIS_ALLOW_UNAUTHENTICATED_REMOTE, true);
      assert.equal(env.MEMORY_AUTH_MODE, "off");
    },
  );
});

test("lite edition rejects service mode posture", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "service",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Aionis Lite requires AIONIS_MODE=local/i,
      );
    },
  );
});
