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
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/hooks/aionis-mcp.mjs"]);
  assert.equal(server.args.includes("${AIONIS_BASE_URL:-http://127.0.0.1:3101}"), false);
});

test("Claude Code plugin hooks use plugin config and user workspace store", () => {
  const hooks = readJson("claude-plugins/aionis/hooks/hooks.json").hooks;
  const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "SessionEnd"];
  for (const event of events) {
    assert.ok(Array.isArray(hooks[event]), `${event} hook is missing`);
    const command = hooks[event][0].hooks[0].command;
    assert.equal(command, "node \"${CLAUDE_PLUGIN_ROOT}/hooks/aionis-hook.mjs\"");
    assert.doesNotMatch(command, /\$\{AIONIS_[^}]+:-/);
  }
});

test("Claude Code plugin wrapper scripts provide defaults without required userConfig", () => {
  const hookScript = fs.readFileSync(path.join(root, "claude-plugins/aionis/hooks/aionis-hook.mjs"), "utf8");
  const mcpScript = fs.readFileSync(path.join(root, "claude-plugins/aionis/hooks/aionis-mcp.mjs"), "utf8");
  for (const script of [hookScript, mcpScript]) {
    assert.match(script, /CLAUDE_PLUGIN_OPTION_\$\{name\}/);
    assert.match(script, /option\("base_url", "AIONIS_BASE_URL"/);
    assert.match(script, /http:\/\/127\.0\.0\.1:3101/);
    assert.match(script, /--workspace-id-store/);
    assert.match(script, /"user"/);
  }
});

test("Claude Code plugin commands use concrete fallback checks", () => {
  const doctor = fs.readFileSync(path.join(root, "claude-plugins/aionis/skills/doctor/SKILL.md"), "utf8");
  const status = fs.readFileSync(path.join(root, "claude-plugins/aionis/skills/status/SKILL.md"), "utf8");
  for (const command of [doctor, status]) {
    assert.doesNotMatch(command, /\$\{user_config\./);
    assert.match(command, /http:\/\/127\.0\.0\.1:3101/);
    assert.match(command, /claude mcp list/);
  }
});
