import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createClaudeCodeInstallCommand,
  createCompletionMessage,
  createInstallPlan,
  defaultEmbeddingProvider,
  isCliEntrypoint,
  parseCreateAionisArgs,
  providerEnvKey,
  quickstartRequiresEmbeddingKey,
  quickstartScriptName,
  writeRuntimeEnv,
} from "../src/index.ts";

test("@aionis/create parses defaults for the one-command installer", () => {
  const options = parseCreateAionisArgs([], {});
  assert.equal(options.dir, "Aionis");
  assert.equal(options.repo, "https://github.com/ostinatocc/Aionis.git");
  assert.equal(options.provider, "none");
  assert.equal(options.quickstart, "first-value");
  assert.equal(options.skipInstall, false);
  assert.equal(options.skipQuickstart, false);
  assert.equal(options.withClaudeCode, false);
  assert.equal(options.claudeCodeDir, null);
  assert.equal(options.claudeCodeBaseUrl, "http://127.0.0.1:3001");
  assert.equal(options.claudeCodeScopeFrom, "workspace");
  assert.equal(options.claudeCodeMcpName, "aionis-local");
  assert.equal(options.claudeCodeSkipMcp, false);
});

test("@aionis/create selects embedding provider from explicit env or available keys", () => {
  assert.equal(defaultEmbeddingProvider({}), "none");
  assert.equal(defaultEmbeddingProvider({ EMBEDDING_PROVIDER: "minimax" }), "minimax");
  assert.equal(defaultEmbeddingProvider({ OPENAI_API_KEY: "sk-test" }), "openai");
  assert.equal(defaultEmbeddingProvider({ MINIMAX_API_KEY: "sk-test" }), "minimax");
  assert.equal(defaultEmbeddingProvider({
    OPENAI_API_KEY: "sk-openai",
    MINIMAX_API_KEY: "sk-minimax",
  }), "openai");
  assert.equal(parseCreateAionisArgs(["--provider", "openai"], {}).provider, "openai");
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

test("@aionis/create parses Claude Code lifecycle integration options", () => {
  const options = parseCreateAionisArgs([
    "my-aionis",
    "--with-claude-code",
    "--claude-code-dir",
    "../checkout-service",
    "--claude-code-base-url",
    "http://127.0.0.1:3101",
    "--claude-code-scope-from",
    "git",
    "--claude-code-mcp-name",
    "aionis-dev",
    "--claude-code-skip-mcp",
  ]);

  assert.equal(options.withClaudeCode, true);
  assert.equal(options.claudeCodeDir, "../checkout-service");
  assert.equal(options.claudeCodeBaseUrl, "http://127.0.0.1:3101");
  assert.equal(options.claudeCodeScopeFrom, "git");
  assert.equal(options.claudeCodeMcpName, "aionis-dev");
  assert.equal(options.claudeCodeSkipMcp, true);
  assert.throws(() => parseCreateAionisArgs(["--claude-code-scope-from", "bad"]), /Unsupported Claude Code scope source/);
});

test("@aionis/create exposes stable provider and quickstart mappings", () => {
  assert.equal(providerEnvKey("minimax"), "MINIMAX_API_KEY");
  assert.equal(providerEnvKey("openai"), "OPENAI_API_KEY");
  assert.equal(providerEnvKey("none"), "");
  assert.equal(providerEnvKey("custom provider"), "CUSTOM_PROVIDER_API_KEY");
  assert.equal(quickstartScriptName("first-value"), "runtime:demo:first-value");
  assert.equal(quickstartScriptName("sdk"), "runtime:quickstart:sdk");
  assert.equal(quickstartScriptName("http"), "runtime:quickstart:http");
  assert.equal(quickstartScriptName("multi-agent"), "runtime:quickstart:multi-agent");
  assert.equal(quickstartScriptName("none"), null);
  assert.equal(quickstartRequiresEmbeddingKey("first-value"), false);
  assert.equal(quickstartRequiresEmbeddingKey("sdk"), true);
  assert.equal(quickstartRequiresEmbeddingKey("none"), false);
});

test("@aionis/create writes no-key Runtime env with embedding provider none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-create-env-none-"));
  fs.writeFileSync(path.join(dir, ".env.example"), [
    "AIONIS_EDITION=lite",
    "# EMBEDDING_PROVIDER=openai",
    "",
  ].join(os.EOL));

  const result = writeRuntimeEnv(dir, parseCreateAionisArgs([], {}));
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");

  assert.equal(result.embeddingProvider, "none");
  assert.equal(result.providerKey, "");
  assert.equal(result.apiKey, null);
  assert.match(env, /EMBEDDING_PROVIDER="none"/);
  assert.doesNotMatch(env, /OPENAI_API_KEY=/);
  assert.doesNotMatch(env, /MINIMAX_API_KEY=/);
});

test("@aionis/create writes OpenAI env when an OpenAI key is available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-create-env-openai-"));
  fs.writeFileSync(path.join(dir, ".env.example"), "EMBEDDING_PROVIDER=none\n");
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-openai";
  try {
    const result = writeRuntimeEnv(dir, parseCreateAionisArgs([], process.env));
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");

    assert.equal(result.embeddingProvider, "openai");
    assert.equal(result.providerKey, "OPENAI_API_KEY");
    assert.equal(result.apiKey, "sk-openai");
    assert.match(env, /EMBEDDING_PROVIDER="openai"/);
    assert.match(env, /OPENAI_API_KEY="sk-openai"/);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
});

test("@aionis/create writes MiniMax env when explicitly selected with a key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-create-env-minimax-"));
  fs.writeFileSync(path.join(dir, ".env.example"), "EMBEDDING_PROVIDER=none\n");

  const result = writeRuntimeEnv(dir, parseCreateAionisArgs([
    "--provider",
    "minimax",
    "--api-key",
    "sk-minimax",
  ], {}));
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");

  assert.equal(result.embeddingProvider, "minimax");
  assert.equal(result.providerKey, "MINIMAX_API_KEY");
  assert.equal(result.apiKey, "sk-minimax");
  assert.match(env, /EMBEDDING_PROVIDER="minimax"/);
  assert.match(env, /MINIMAX_API_KEY="sk-minimax"/);
});

test("@aionis/create install plan includes Runtime install, SDK build, and selected quickstart", () => {
  const plan = createInstallPlan(parseCreateAionisArgs(["--quickstart", "multi-agent"]));
  assert.deepEqual(plan, [
    "clone https://github.com/ostinatocc/Aionis.git -> Aionis",
    "npm install",
    "npm run -s packages:build",
    "npm run -s runtime:quickstart:multi-agent",
    `skip Claude Code hooks`,
  ]);
  assert.throws(() => parseCreateAionisArgs(["--quickstart", "bad"]), /Unsupported quickstart/);
});

test("@aionis/create default install plan runs the no-key first-value demo", () => {
  const plan = createInstallPlan(parseCreateAionisArgs([]));
  assert.deepEqual(plan, [
    "clone https://github.com/ostinatocc/Aionis.git -> Aionis",
    "npm install",
    "npm run -s packages:build",
    "npm run -s runtime:demo:first-value",
    `skip Claude Code hooks`,
  ]);
});

test("@aionis/create plans and builds Claude Code lifecycle hook command", () => {
  const options = parseCreateAionisArgs([
    "runtime",
    "--with-claude-code",
    "--claude-code-dir",
    "agent-project",
    "--claude-code-base-url",
    "http://127.0.0.1:3101",
    "--claude-code-scope-from",
    "workspace",
    "--claude-code-mcp-name",
    "aionis-local",
    "--claude-code-skip-mcp",
  ]);
  const plan = createInstallPlan(options);
  assert.equal(plan.at(-1), `install Claude Code hooks in agent-project -> http://127.0.0.1:3101`);

  const command = createClaudeCodeInstallCommand(options, "/tmp/workspace");
  assert.equal(command.command, "npx");
  assert.deepEqual(command.args, [
    "-y",
    "@aionis/claude-code@latest",
    "install",
    "--base-url",
    "http://127.0.0.1:3101",
    "--scope-from",
    "workspace",
    "--mcp-name",
    "aionis-local",
    "--skip-mcp",
  ]);
  assert.equal(command.cwd, path.join("/tmp/workspace", "agent-project"));
});

test("@aionis/create completion message blocks misleading ready state without an embedding key", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "OPENAI_API_KEY",
    apiKey: null,
    quickstartScript: "runtime:quickstart:sdk",
    quickstartRequiresEmbeddingKey: true,
  });

  assert.match(message, /Aionis is installed/);
  assert.match(message, /Set your embedding key before starting Runtime/);
  assert.match(message, /Required key: OPENAI_API_KEY/);
  assert.match(message, /Start Runtime after the key is set/);
  assert.match(message, /Run quickstart after the key is set: npm run -s runtime:quickstart:sdk/);
  assert.doesNotMatch(message, /Aionis is ready/);
});

test("@aionis/create completion message allows first-value without an embedding key", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "",
    apiKey: null,
    embeddingProvider: "none",
    quickstartScript: "runtime:demo:first-value",
    quickstartRequiresEmbeddingKey: false,
  });

  assert.match(message, /Runtime can start now in no-key mode/);
  assert.match(message, /Start Runtime: cd \/tmp\/Aionis && npm run -s lite:start/);
  assert.match(message, /Enable semantic recall later/);
  assert.doesNotMatch(message, /Run quickstart after the key is set: npm run -s runtime:demo:first-value/);
});

test("@aionis/create completion message keeps selected recall quickstart gated in no-key mode", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "",
    apiKey: null,
    embeddingProvider: "none",
    quickstartScript: "runtime:quickstart:sdk",
    quickstartRequiresEmbeddingKey: true,
  });

  assert.match(message, /Runtime can start now in no-key mode/);
  assert.match(message, /Run selected quickstart after semantic recall is configured: npm run -s runtime:quickstart:sdk/);
});

test("@aionis/create completion message keeps the ready state when a key is configured", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "OPENAI_API_KEY",
    apiKey: "sk-test",
    quickstartScript: null,
  });

  assert.match(message, /Aionis is ready/);
  assert.match(message, /Start Runtime: cd \/tmp\/Aionis && npm run -s lite:start/);
  assert.match(message, /Claude Code hooks package: @aionis\/claude-code/);
  assert.doesNotMatch(message, /Set your embedding key/);
});

test("@aionis/create completion message respects skipped quickstart", () => {
  const message = createCompletionMessage({
    targetDir: "/tmp/Aionis",
    providerKey: "OPENAI_API_KEY",
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
