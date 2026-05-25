import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

test("runtime package dry-run excludes removed product surfaces", () => {
  const result = run("npm", ["pack", "--dry-run", "--json", "--cache", path.join(os.tmpdir(), "aionis-npm-cache")], {
    cwd: packageDir,
  });
  assert.equal(result.status, 0, result.stderr);
  const [packInfo] = JSON.parse(result.stdout);

  assert.ok(packInfo.files.some((file) => file.path === "dist/bin/aionis-runtime.mjs"));
  assert.ok(packInfo.files.some((file) => file.path === "dist/runtime/src/index.ts"));
  assert.ok(packInfo.files.some((file) => file.path === "dist/runtime-package-manifest.json"));
  assert.ok(!packInfo.files.some((file) => file.path.includes("apps/inspector")));
});

test("packed runtime package installs and exposes focused CLI", () => {
  const pack = run("npm", ["pack", "--json", "--cache", path.join(os.tmpdir(), "aionis-npm-cache")], {
    cwd: packageDir,
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [packInfo] = JSON.parse(pack.stdout);
  const tarball = path.join(packageDir, packInfo.filename);
  assert.ok(existsSync(tarball));

  const consumer = mkdtempSync(path.join(os.tmpdir(), "aionis-runtime-focused-consumer-"));
  try {
    const init = run("npm", ["init", "-y"], { cwd: consumer });
    assert.equal(init.status, 0, init.stderr);
    const install = run("npm", ["install", tarball, "--cache", path.join(os.tmpdir(), "aionis-npm-cache")], {
      cwd: consumer,
    });
    assert.equal(install.status, 0, install.stderr);

    const bin = path.join(consumer, "node_modules", ".bin", "aionis-runtime");
    const help = run(bin, ["--help"], { cwd: consumer });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Aionis Runtime Focused/);
    const printEnv = run(bin, ["start", "--print-env"], { cwd: consumer });
    assert.equal(printEnv.status, 0, printEnv.stderr);
    const parsed = JSON.parse(printEnv.stdout);
    assert.equal(parsed.LITE_INSPECTOR_ENABLED, "false");
    assert.equal(parsed.SANDBOX_ENABLED, "false");

    const manifest = JSON.parse(readFileSync(path.join(consumer, "node_modules", "@ostinato", "aionis-runtime", "dist", "runtime-package-manifest.json"), "utf8"));
    assert.equal(manifest.inspector_bundled, false);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
});
