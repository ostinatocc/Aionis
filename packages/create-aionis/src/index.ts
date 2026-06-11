#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AionisQuickstart = "sdk" | "http" | "multi-agent" | "none";

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

function usage(): string {
  return `Usage:
  npx @aionis/create [dir] [options]

Options:
  --dir <path>              Install directory. Defaults to ./Aionis.
  --repo <url>              Runtime git repo. Defaults to ${DEFAULT_REPO}
  --branch <name>           Git branch or tag to clone.
  --provider <name>         Embedding provider. Defaults to EMBEDDING_PROVIDER or minimax.
  --api-key <key>           Provider API key. Prefer env vars for shell history safety.
  --quickstart <name>       sdk, http, multi-agent, or none. Defaults to sdk.
  --skip-install            Clone and write env, but do not run npm install.
  --skip-quickstart         Do not run the selected quickstart after install.
  -h, --help                Show help.

Examples:
  MINIMAX_API_KEY=... npx @aionis/create --provider minimax --quickstart sdk
  OPENAI_API_KEY=... npx @aionis/create my-aionis --provider openai --quickstart http
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
  return `runtime:quickstart:${quickstart}`;
}

function parseQuickstart(value: string): AionisQuickstart {
  if (value === "sdk" || value === "http" || value === "multi-agent" || value === "none") return value;
  throw new Error(`Unsupported quickstart "${value}". Use sdk, http, multi-agent, or none.`);
}

export function parseCreateAionisArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CreateAionisOptions {
  let dir = DEFAULT_DIR;
  let repo = DEFAULT_REPO;
  let branch: string | null = null;
  let provider = env.EMBEDDING_PROVIDER?.trim() || "minimax";
  let apiKey: string | null = null;
  let quickstart: AionisQuickstart = "sdk";
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

function ensureNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`Aionis requires Node >= 22. Current Node is ${process.versions.node}.`);
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
    if (!apiKey) {
      process.stdout.write(
        `\nInstalled Aionis, but ${providerKey} is not set. Set it in ${path.join(targetDir, ".env")} or your shell, then run:\n`
          + `cd ${targetDir}\n`
          + `npm run -s ${quickstart}\n`,
      );
      return;
    }
    run("npm", ["run", "-s", quickstart], targetDir, {
      ...process.env,
      EMBEDDING_PROVIDER: options.provider,
      [providerKey]: apiKey,
    });
  }

  process.stdout.write(
    `\nAionis is ready.\n`
      + `Runtime directory: ${targetDir}\n`
      + `Start Runtime: cd ${targetDir} && npm run -s lite:start\n`
      + `SDK package: @aionis/sdk\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
