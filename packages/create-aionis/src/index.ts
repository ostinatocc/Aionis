#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AionisQuickstart = "first-value" | "sdk" | "http" | "multi-agent" | "none";

export type CreateAionisOptions = {
  dir: string;
  repo: string;
  branch: string | null;
  provider: string;
  apiKey: string | null;
  quickstart: AionisQuickstart;
  skipInstall: boolean;
  skipQuickstart: boolean;
};

const DEFAULT_REPO = "https://github.com/ostinatocc/Aionis.git";
const DEFAULT_DIR = "Aionis";
const MIN_NODE_VERSION = "22.5.0";
const require = createRequire(import.meta.url);

function usage(): string {
  return `Usage:
  npx @aionis/create [dir] [options]

Options:
  --dir <path>              Install directory. Defaults to ./Aionis.
  --repo <url>              Runtime git repo. Defaults to ${DEFAULT_REPO}
  --branch <name>           Git branch or tag to clone.
  --provider <name>         Embedding provider. Defaults to EMBEDDING_PROVIDER or openai.
  --api-key <key>           Provider API key. Prefer env vars for shell history safety.
  --quickstart <name>       first-value, sdk, http, multi-agent, or none. Defaults to first-value.
  --skip-install            Clone and write env, but do not run npm install.
  --skip-quickstart         Do not run the selected quickstart after install.
  -h, --help                Show help.

Examples:
  npx @aionis/create
  OPENAI_API_KEY=... npx @aionis/create my-aionis --provider openai --quickstart sdk
`;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

export function providerEnvKey(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "openai") return "OPENAI_API_KEY";
  if (normalized === "minimax") return "MINIMAX_API_KEY";
  return `${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function quickstartScriptName(quickstart: AionisQuickstart): string | null {
  if (quickstart === "none") return null;
  if (quickstart === "first-value") return "runtime:demo:first-value";
  return `runtime:quickstart:${quickstart}`;
}

export function quickstartRequiresEmbeddingKey(quickstart: AionisQuickstart): boolean {
  return quickstart !== "first-value" && quickstart !== "none";
}

function parseQuickstart(value: string): AionisQuickstart {
  if (
    value === "first-value"
    || value === "sdk"
    || value === "http"
    || value === "multi-agent"
    || value === "none"
  ) return value;
  throw new Error(`Unsupported quickstart "${value}". Use first-value, sdk, http, multi-agent, or none.`);
}

export function parseCreateAionisArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CreateAionisOptions {
  let dir = DEFAULT_DIR;
  let repo = DEFAULT_REPO;
  let branch: string | null = null;
  let provider = env.EMBEDDING_PROVIDER?.trim() || "openai";
  let apiKey: string | null = null;
  let quickstart: AionisQuickstart = "first-value";
  let skipInstall = false;
  let skipQuickstart = false;
  let positionalDirSet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--dir") {
      dir = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--repo") {
      repo = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--branch") {
      branch = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--provider") {
      provider = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      apiKey = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--quickstart") {
      quickstart = parseQuickstart(readFlagValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--skip-install") {
      skipInstall = true;
      continue;
    }
    if (arg === "--skip-quickstart") {
      skipQuickstart = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
    if (positionalDirSet) throw new Error(`Unexpected positional argument "${arg}"`);
    dir = arg;
    positionalDirSet = true;
  }

  return {
    dir,
    repo,
    branch,
    provider,
    apiKey,
    quickstart,
    skipInstall,
    skipQuickstart,
  };
}

function run(command: string, args: string[], cwd: string | null, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, {
    cwd: cwd ?? undefined,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function ensureCommand(command: string): void {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) throw new Error(`Required command not found: ${command}`);
}

function compareNodeVersion(actual: string, minimum: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = Number.isFinite(a[i]) ? a[i] : 0;
    const right = Number.isFinite(b[i]) ? b[i] : 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function hasNodeSqliteSupport(): boolean {
  try {
    const mod = require("node:sqlite") as { DatabaseSync?: unknown };
    return typeof mod.DatabaseSync === "function";
  } catch {
    return false;
  }
}

function ensureNodeVersion(): void {
  if (compareNodeVersion(process.versions.node, MIN_NODE_VERSION) < 0) {
    throw new Error(`Aionis Lite requires Node >= ${MIN_NODE_VERSION}. Current Node is ${process.versions.node}.`);
  }
  if (!hasNodeSqliteSupport()) {
    throw new Error("Aionis Lite requires Node's built-in node:sqlite module. Upgrade to a Node 22 build that includes node:sqlite.");
  }
}

function nonEmptyDirectory(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}

function upsertEnvLine(source: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`) || line.startsWith(`export ${key}=`)) {
      replaced = true;
      return `${key}=${JSON.stringify(value)}`;
    }
    return line;
  });
  if (!replaced) next.push(`${key}=${JSON.stringify(value)}`);
  return next.join(os.EOL).replace(/\n{3,}$/g, `${os.EOL}${os.EOL}`);
}

function writeRuntimeEnv(targetDir: string, options: CreateAionisOptions): {
  providerKey: string;
  apiKey: string | null;
} {
  const envPath = path.join(targetDir, ".env");
  const examplePath = path.join(targetDir, ".env.example");
  let source = "";
  if (fs.existsSync(envPath)) {
    source = fs.readFileSync(envPath, "utf8");
  } else if (fs.existsSync(examplePath)) {
    source = fs.readFileSync(examplePath, "utf8");
  }

  const providerKey = providerEnvKey(options.provider);
  const apiKey = options.apiKey ?? process.env[providerKey]?.trim() ?? null;
  source = upsertEnvLine(source, "EMBEDDING_PROVIDER", options.provider);
  if (apiKey) source = upsertEnvLine(source, providerKey, apiKey);
  fs.writeFileSync(envPath, source.endsWith(os.EOL) ? source : `${source}${os.EOL}`);
  return { providerKey, apiKey };
}

export function createInstallPlan(options: CreateAionisOptions): string[] {
  const quickstart = quickstartScriptName(options.quickstart);
  return [
    `clone ${options.repo} -> ${options.dir}`,
    options.skipInstall ? "skip npm install" : "npm install",
    options.skipInstall ? "skip package build" : "npm run -s packages:build",
    options.skipQuickstart || !quickstart ? "skip quickstart" : `npm run -s ${quickstart}`,
  ];
}

export function createCompletionMessage(input: {
  targetDir: string;
  providerKey: string;
  apiKey: string | null;
  quickstartScript: string | null;
  quickstartRequiresEmbeddingKey?: boolean;
}): string {
  if (!input.apiKey) {
    const quickstartNeedsKey = input.quickstartRequiresEmbeddingKey ?? true;
    const lines = [
      "",
      quickstartNeedsKey
        ? "Aionis is installed. Set your embedding key before starting Runtime."
        : "Aionis is installed. The first-value demo can run without an embedding key.",
      `Runtime directory: ${input.targetDir}`,
      `Required key: ${input.providerKey}`,
      `Set it in: ${path.join(input.targetDir, ".env")}`,
      `Example: ${input.providerKey}="your-key"`,
      `Start Runtime after the key is set: cd ${input.targetDir} && npm run -s lite:start`,
      "Run the SDK quickstart after the key is set: npm run -s runtime:quickstart:sdk",
      "SDK package: @aionis/sdk",
      "MCP package: @aionis/mcp",
    ];
    if (input.quickstartScript && quickstartNeedsKey) {
      lines.push(`Run quickstart after the key is set: npm run -s ${input.quickstartScript}`);
    }
    return `${lines.join(os.EOL)}${os.EOL}`;
  }

  return `${[
    "",
    "Aionis is ready.",
    `Runtime directory: ${input.targetDir}`,
    `Start Runtime: cd ${input.targetDir} && npm run -s lite:start`,
    "SDK package: @aionis/sdk",
    "MCP package: @aionis/mcp",
  ].join(os.EOL)}${os.EOL}`;
}

export function isCliEntrypoint(argvEntry: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvEntry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(argvEntry) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argvEntry) === path.resolve(modulePath);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCreateAionisArgs(argv);
  ensureNodeVersion();
  ensureCommand("git");
  ensureCommand("npm");

  const targetDir = path.resolve(options.dir);
  if (nonEmptyDirectory(targetDir)) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }

  process.stdout.write(`Aionis installer\n`);
  for (const step of createInstallPlan({ ...options, dir: targetDir })) {
    process.stdout.write(`- ${step}\n`);
  }

  const cloneArgs = ["clone", "--depth", "1"];
  if (options.branch) cloneArgs.push("--branch", options.branch);
  cloneArgs.push(options.repo, targetDir);
  run("git", cloneArgs, null);

  const { providerKey, apiKey } = writeRuntimeEnv(targetDir, options);

  if (!options.skipInstall) {
    run("npm", ["install"], targetDir);
    run("npm", ["run", "-s", "packages:build"], targetDir);
  }

  const quickstart = quickstartScriptName(options.quickstart);
  if (!options.skipQuickstart && quickstart) {
    const quickstartNeedsKey = quickstartRequiresEmbeddingKey(options.quickstart);
    if (!apiKey && quickstartNeedsKey) {
      process.stdout.write(createCompletionMessage({
        targetDir,
        providerKey,
        apiKey,
        quickstartScript: quickstart,
        quickstartRequiresEmbeddingKey: quickstartNeedsKey,
      }));
      return;
    }
    const quickstartEnv: NodeJS.ProcessEnv = {
      ...process.env,
      EMBEDDING_PROVIDER: options.provider,
    };
    if (apiKey) quickstartEnv[providerKey] = apiKey;
    run("npm", ["run", "-s", quickstart], targetDir, quickstartEnv);
  }

  process.stdout.write(createCompletionMessage({
    targetDir,
    providerKey,
    apiKey,
    quickstartScript: options.skipQuickstart ? null : quickstart,
    quickstartRequiresEmbeddingKey: quickstartRequiresEmbeddingKey(options.quickstart),
  }));
}

if (isCliEntrypoint(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
