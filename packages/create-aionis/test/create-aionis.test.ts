import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createCompletionMessage,
  createInstallPlan,
  isCliEntrypoint,
  parseCreateAionisArgs,
  providerEnvKey,
  quickstartScriptName,
} from "../src/index.ts";

test("@aionis/create parses defaults for the one-command installer", () => {
  const options = parseCreateAionisArgs([], {});
  assert.equal(options.dir, "Aionis");
  assert.equal(options.repo, "https://github.com/ostinatocc/Aionis.git");
  assert.equal(options.provider, "minimax");
  assert.equal(options.quickstart, "sdk");
  assert.equal(options.skipInstall, false);
  assert.equal(options.skipQuickstart, false);
});

test("@aionis/create parses explicit Runtime, SDK, and quickstart options", () => {
  const options = parseCreateAionisArgs([
    "my-aionis",
    "--repo",
    "https://example.test/Aionis.git",
    "--branch",
    "main",
    "--provider",
    "openai",
    "--api-key",
    "sk-test",
    "--quickstart",
    "http",
    "--skip-install",
  ]);
  assert.equal(options.dir, "my-aionis");
  assert.equal(options.repo, "https://example.test/Aionis.git");
  assert.equal(options.branch, "main");
  assert.equal(options.provider, "openai");
  assert.equal(options.apiKey, "sk-test");
  assert.equal(options.quickstart, "http");
  assert.equal(options.skipInstall, true);
});

test("@aionis/create exposes stable provider and quickstart mappings", () => {
  assert.equal(providerEnvKey("minimax"), "MINIMAX_API_KEY");
  assert.equal(providerEnvKey("openai"), "OPENAI_API_KEY");
  assert.equal(providerEnvKey("custom provider"), "CUSTOM_PROVIDER_API_KEY");
  assert.equal(quickstartScriptName("sdk"), "runtime:quickstart:sdk");
  assert.equal(quickstartScriptName("http"), "runtime:quickstart:http");
  assert.equal(quickstartScriptName("multi-agent"), "runtime:quickstart:multi-agent");
  assert.equal(quickstartScriptName("none"), null);
});

test("@aionis/create install plan includes Runtime install, SDK build, and selected quickstart", () => {
  const plan = createInstallPlan(parseCreateAionisArgs(["--quickstart", "multi-agent"]));
  assert.deepEqual(plan, [
    "clone https://github.com/ostinatocc/Aionis.git -> Aionis",
    "npm install",
    "npm run -s packages:build",
    "npm run -s runtime:quickstart:multi-agent",
  ]);
  assert.throws(() => parseCreateAionisArgs(["--quickstart", "bad"]), /Unsupported quickstart/);
});

test("@aionis/create completion message blocks misleading ready state without an embedding key", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "MINIMAX_API_KEY",
    apiKey: null,
    quickstartScript: "runtime:quickstart:sdk",
  });

  assert.match(message, /Aionis is installed/);
  assert.match(message, /Set your embedding key before starting Runtime/);
  assert.match(message, /Required key: MINIMAX_API_KEY/);
  assert.match(message, /Start Runtime after the key is set/);
  assert.match(message, /Run quickstart after the key is set: npm run -s runtime:quickstart:sdk/);
  assert.doesNotMatch(message, /Aionis is ready/);
});

test("@aionis/create completion message keeps the ready state when a key is configured", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "MINIMAX_API_KEY",
    apiKey: "sk-test",
    quickstartScript: null,
  });

  assert.match(message, /Aionis is ready/);
  assert.match(message, /Start Runtime: cd \/tmp\/Aionis && npm run -s lite:start/);
  assert.doesNotMatch(message, /Set your embedding key/);
});

test("@aionis/create completion message respects skipped quickstart", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "MINIMAX_API_KEY",
    apiKey: null,
    quickstartScript: null,
  });

  assert.match(message, /Start Runtime after the key is set/);
  assert.doesNotMatch(message, /Run quickstart after the key is set/);
});

test("@aionis/create recognizes npm bin symlink as the CLI entrypoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-create-entrypoint-"));
  const target = path.join(dir, "index.js");
  const symlink = path.join(dir, "create-aionis");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, symlink);

  assert.equal(isCliEntrypoint(symlink, pathToFileURL(target).href), true);
  assert.equal(isCliEntrypoint(undefined, pathToFileURL(target).href), false);
});
