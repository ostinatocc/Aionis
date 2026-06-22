#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";

function option(name, envName, fallback) {
  const pluginValue = process.env[`CLAUDE_PLUGIN_OPTION_${name}`];
  const envValue = process.env[envName];
  return (pluginValue && pluginValue.trim()) || (envValue && envValue.trim()) || fallback;
}

const baseUrl = option("base_url", "AIONIS_BASE_URL", "http://127.0.0.1:3101");
const tenantId = option("tenant_id", "AIONIS_TENANT_ID", "default");
const scopeFrom = option("scope_from", "AIONIS_SCOPE_FROM", "workspace");
const guideMode = option("guide_mode", "AIONIS_GUIDE_MODE", "full_power");
const maxPromptChars = option("max_prompt_chars", "AIONIS_CLAUDE_CODE_MAX_PROMPT_CHARS", "8000");

const args = [
  "-y",
  "@aionis/claude-code@latest",
  "hook",
  "--base-url",
  baseUrl,
  "--tenant",
  tenantId,
  "--scope-from",
  scopeFrom,
  "--workspace-id-store",
  "user",
  "--mode",
  guideMode,
  "--max-prompt-chars",
  maxPromptChars,
];

const env = {
  ...process.env,
  AIONIS_BASE_URL: baseUrl,
  AIONIS_TENANT_ID: tenantId,
  AIONIS_SCOPE_FROM: scopeFrom,
  AIONIS_WORKSPACE_ID_STORE: "user",
  AIONIS_GUIDE_MODE: guideMode,
  AIONIS_CLAUDE_CODE_MAX_PROMPT_CHARS: maxPromptChars,
};

const rawInput = await readStdin();
const hookEventName = parseHookEventName(rawInput);

if (hookEventName === "SessionEnd") {
  const child = spawn("npx", args, {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    env,
  });
  child.stdin.end(rawInput);
  child.unref();
  process.exit(0);
}

const result = spawnSync("npx", args, {
  input: rawInput,
  stdio: ["pipe", "inherit", "inherit"],
  env,
});

process.exit(result.status ?? 1);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseHookEventName(raw) {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.hook_event_name === "string") return parsed.hook_event_name;
  } catch {
    return "";
  }
  return "";
}
