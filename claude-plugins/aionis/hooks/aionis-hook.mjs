#!/usr/bin/env node
import { spawnSync } from "node:child_process";

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

const result = spawnSync("npx", [
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
], {
  stdio: "inherit",
  env: {
    ...process.env,
    AIONIS_BASE_URL: baseUrl,
    AIONIS_TENANT_ID: tenantId,
    AIONIS_SCOPE_FROM: scopeFrom,
    AIONIS_WORKSPACE_ID_STORE: "user",
    AIONIS_GUIDE_MODE: guideMode,
    AIONIS_CLAUDE_CODE_MAX_PROMPT_CHARS: maxPromptChars,
  },
});

process.exit(result.status ?? 1);
