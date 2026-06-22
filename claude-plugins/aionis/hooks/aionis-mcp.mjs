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

const result = spawnSync("npx", [
  "-y",
  "@aionis/mcp@latest",
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
], {
  stdio: "inherit",
  env: {
    ...process.env,
    AIONIS_BASE_URL: baseUrl,
    AIONIS_TENANT_ID: tenantId,
    AIONIS_SCOPE_FROM: scopeFrom,
    AIONIS_WORKSPACE_ID_STORE: "user",
    AIONIS_GUIDE_MODE: guideMode,
  },
});

process.exit(result.status ?? 1);
