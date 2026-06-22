import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

test("Claude Code plugin marketplace points at the bundled Aionis plugin", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.equal(marketplace.name, "aionis");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "aionis");
  assert.equal(marketplace.plugins[0].source, "./claude-plugins/aionis");
});

test("Claude Code plugin exposes Runtime settings through userConfig", () => {
  const plugin = readJson("claude-plugins/aionis/.claude-plugin/plugin.json");
  assert.equal(plugin.name, "aionis");
  assert.equal(plugin.userConfig.base_url.default, "http://127.0.0.1:3101");
  assert.equal(plugin.userConfig.scope_from.default, "workspace");
  assert.equal(plugin.userConfig.guide_mode.default, "full_power");
  assert.equal(plugin.userConfig.max_prompt_chars.default, 8000);
});

test("Claude Code plugin MCP uses shared user-level workspace identity", () => {
  const mcp = readJson("claude-plugins/aionis/.mcp.json");
  const server = mcp.mcpServers.aionis;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args.slice(0, 3), ["-y", "@aionis/mcp@latest", "--base-url"]);
  assert.equal(server.args.includes("--workspace-id-store"), true);
  assert.equal(server.args[server.args.indexOf("--workspace-id-store") + 1], "user");
  assert.equal(server.args.includes("${AIONIS_BASE_URL:-http://127.0.0.1:3101}"), false);
  assert.equal(server.env.AIONIS_WORKSPACE_ID_STORE, "user");
});

test("Claude Code plugin hooks use plugin config and user workspace store", () => {
  const hooks = readJson("claude-plugins/aionis/hooks/hooks.json").hooks;
  const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "SessionEnd"];
  for (const event of events) {
    assert.ok(Array.isArray(hooks[event]), `${event} hook is missing`);
    const command = hooks[event][0].hooks[0].command;
    assert.match(command, /@aionis\/claude-code@latest hook/);
    assert.match(command, /--base-url "\$\{user_config\.base_url\}"/);
    assert.match(command, /--workspace-id-store user/);
    assert.match(command, /--max-prompt-chars "\$\{user_config\.max_prompt_chars\}"/);
    assert.doesNotMatch(command, /\$\{AIONIS_[^}]+:-/);
  }
});
