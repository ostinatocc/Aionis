#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cliDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.basename(path.dirname(cliDir)) === "dist"
  ? path.resolve(cliDir, "..", "..")
  : path.resolve(cliDir, "..");
const packageJsonPath = path.join(packageDir, "package.json");
const distRuntimeRoot = path.resolve(cliDir, "..", "runtime");
const sourceRuntimeRoot = path.resolve(packageDir, "..", "..");
const runtimeRoot = existsSync(path.join(distRuntimeRoot, "src", "index.ts"))
  ? distRuntimeRoot
  : sourceRuntimeRoot;

function packageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function usage() {
  process.stdout.write(`Aionis Runtime Focused

Usage:
  aionis-runtime start [--print-env] [node args...]
  aionis-runtime --help
  aionis-runtime --version

Commands:
  start   Start the focused Lite Runtime kernel.

Focus:
  execution continuity
  learning-controlled self-learning
  controlled forgetting

Flags:
  --print-env   Print the effective runtime env as JSON and exit.
  --help        Show this help.
  --version     Show the package version.
`);
}

function defaultEnv(cwd = process.cwd()) {
  const startedAt = new Date().toISOString();
  return {
    ...process.env,
    AIONIS_EDITION: process.env.AIONIS_EDITION || "lite",
    AIONIS_MODE: process.env.AIONIS_MODE || "local",
    APP_ENV: process.env.APP_ENV || "dev",
    AIONIS_LISTEN_HOST: process.env.AIONIS_LISTEN_HOST || "127.0.0.1",
    MEMORY_AUTH_MODE: process.env.MEMORY_AUTH_MODE || "off",
    TENANT_QUOTA_ENABLED: process.env.TENANT_QUOTA_ENABLED || "false",
    RATE_LIMIT_BYPASS_LOOPBACK: process.env.RATE_LIMIT_BYPASS_LOOPBACK || "true",
    LITE_REPLAY_SQLITE_PATH: process.env.LITE_REPLAY_SQLITE_PATH || path.join(cwd, ".tmp", "aionis-lite-replay.sqlite"),
    LITE_WRITE_SQLITE_PATH: process.env.LITE_WRITE_SQLITE_PATH || path.join(cwd, ".tmp", "aionis-lite-write.sqlite"),
    LITE_LOCAL_ACTOR_ID: process.env.LITE_LOCAL_ACTOR_ID || "local-user",
    LITE_INSPECTOR_ENABLED: process.env.LITE_INSPECTOR_ENABLED || "false",
    LITE_INSPECTOR_DIST_PATH: process.env.LITE_INSPECTOR_DIST_PATH || "",
    SANDBOX_ENABLED: process.env.SANDBOX_ENABLED || "false",
    SANDBOX_ADMIN_ONLY: process.env.SANDBOX_ADMIN_ONLY || "true",
    AIONIS_RUNTIME_PACKAGE_NAME: packageJson().name,
    AIONIS_RUNTIME_PACKAGE_VERSION: packageJson().version,
    AIONIS_RUNTIME_STARTED_AT: process.env.AIONIS_RUNTIME_STARTED_AT || startedAt,
  };
}

function printableEnv(env) {
  const keys = [
    "AIONIS_EDITION",
    "AIONIS_MODE",
    "APP_ENV",
    "AIONIS_LISTEN_HOST",
    "MEMORY_AUTH_MODE",
    "TENANT_QUOTA_ENABLED",
    "RATE_LIMIT_BYPASS_LOOPBACK",
    "LITE_REPLAY_SQLITE_PATH",
    "LITE_WRITE_SQLITE_PATH",
    "LITE_LOCAL_ACTOR_ID",
    "LITE_INSPECTOR_ENABLED",
    "LITE_INSPECTOR_DIST_PATH",
    "SANDBOX_ENABLED",
    "SANDBOX_ADMIN_ONLY",
    "AIONIS_RUNTIME_PACKAGE_NAME",
    "AIONIS_RUNTIME_PACKAGE_VERSION",
    "AIONIS_RUNTIME_STARTED_AT",
  ];
  return Object.fromEntries(keys.map((key) => [key, env[key] ?? ""]));
}

async function start(args) {
  if (!existsSync(path.join(runtimeRoot, "src", "index.ts"))) {
    throw new Error(`Runtime source entrypoint is missing under ${runtimeRoot}`);
  }
  try {
    await import("node:sqlite");
  } catch {
    throw new Error("aionis-runtime start requires Node.js with node:sqlite support. Use Node 22+.");
  }

  const env = defaultEnv(process.cwd());
  const nodeArgs = [];
  let printEnv = false;
  for (const arg of args) {
    if (arg === "--print-env") {
      printEnv = true;
    } else {
      nodeArgs.push(arg);
    }
  }

  if (printEnv) {
    process.stdout.write(`${JSON.stringify(printableEnv(env), null, 2)}\n`);
    return;
  }

  const tsxCli = require.resolve("tsx/cli");
  const child = spawn(process.execPath, [tsxCli, path.join("src", "index.ts"), ...nodeArgs], {
    cwd: runtimeRoot,
    stdio: "inherit",
    env,
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (exit.signal) process.kill(process.pid, exit.signal);
  process.exit(exit.code ?? 0);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageJson().version}\n`);
    return;
  }
  if (command === "start") {
    await start(args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
