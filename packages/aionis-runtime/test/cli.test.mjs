import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageDir, "dist", "bin", "aionis-runtime.mjs");

test("runtime cli prints focused help", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /aionis-runtime start/);
  assert.match(result.stdout, /execution continuity/);
});

test("runtime cli prints package version", () => {
  const result = spawnSync(process.execPath, [cliPath, "--version"], {
    encoding: "utf8",
  });
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test("runtime cli prints focused lite defaults", () => {
  const cwd = path.join(packageDir, ".tmp", "consumer-cwd");
  mkdirSync(cwd, { recursive: true });
  const result = spawnSync(process.execPath, [cliPath, "start", "--print-env"], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

  assert.equal(parsed.AIONIS_EDITION, "lite");
  assert.equal(parsed.AIONIS_MODE, "local");
  assert.equal(parsed.AIONIS_RUNTIME_PACKAGE_NAME, "@ostinato/aionis-runtime");
  assert.equal(parsed.AIONIS_RUNTIME_PACKAGE_VERSION, packageJson.version);
  assert.ok(Date.parse(parsed.AIONIS_RUNTIME_STARTED_AT));
  assert.equal(parsed.APP_ENV, "dev");
  assert.equal(parsed.AIONIS_LISTEN_HOST, "127.0.0.1");
  assert.equal(parsed.MEMORY_AUTH_MODE, "off");
  assert.equal(parsed.TENANT_QUOTA_ENABLED, "false");
  assert.equal(parsed.RATE_LIMIT_BYPASS_LOOPBACK, "true");
  assert.equal(parsed.LITE_INSPECTOR_ENABLED, "false");
  assert.equal(parsed.SANDBOX_ENABLED, "false");
  assert.equal(parsed.SANDBOX_ADMIN_ONLY, "true");
  assert.equal(
    parsed.LITE_REPLAY_SQLITE_PATH,
    path.join(cwd, ".tmp", "aionis-lite-replay.sqlite"),
  );
  assert.equal(
    parsed.LITE_WRITE_SQLITE_PATH,
    path.join(cwd, ".tmp", "aionis-lite-write.sqlite"),
  );
});

test("runtime cli resolves tsx through the public package export", () => {
  const source = readFileSync(path.join(packageDir, "src", "cli.mjs"), "utf8");

  assert.match(source, /require\.resolve\("tsx\/cli"\)/);
  assert.doesNotMatch(source, /tsx\/dist\/cli\.mjs/);
});

test("runtime cli starts the executable runtime entrypoint", () => {
  const source = readFileSync(path.join(packageDir, "src", "cli.mjs"), "utf8");

  assert.match(source, /"src", "index\.ts"/);
  assert.doesNotMatch(source, /"src", "runtime-entry\.ts"/);
});
