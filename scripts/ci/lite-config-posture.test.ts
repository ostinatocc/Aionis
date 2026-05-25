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
    assert.equal(env.MEMORY_AUTH_MODE, "off");
    assert.equal(env.TENANT_QUOTA_ENABLED, false);
  });
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
        /Lite runtime does not currently support APP_ENV=prod; use APP_ENV=dev\/ci or a future server runtime\./i,
      );
    },
  );
});
