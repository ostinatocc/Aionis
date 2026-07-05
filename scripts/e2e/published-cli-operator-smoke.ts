#!/usr/bin/env node
import "dotenv/config";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord, assertCondition, repoRoot } from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type RuntimeSession = {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams | null;
  logs: string[];
};

type RunResult = {
  stdout: string;
  stderr: string;
};

const DEFAULT_CLI_SPEC = "aionis@latest";

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function binPath(appDir: string, binName: string): string {
  return process.platform === "win32"
    ? path.join(appDir, "node_modules", ".bin", `${binName}.cmd`)
    : path.join(appDir, "node_modules", ".bin", binName);
}

function cleanNoKeyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.EMBEDDING_PROVIDER;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_EMBED_BASE_URL;
  delete env.OPENAI_EMBEDDING_MODEL;
  delete env.MINIMAX_API_KEY;
  delete env.MINIMAX_GROUP_ID;
  delete env.MINIMAX_EMBED_MODEL;
  delete env.MINIMAX_EMBED_TYPE;
  delete env.MINIMAX_EMBED_DB_TYPE;
  delete env.MINIMAX_EMBED_QUERY_TYPE;
  return env;
}

function run(command: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  maxOutputChars?: number;
}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${options.label} failed with exit code ${result.status ?? "unknown"}\n${output.slice(-(options.maxOutputChars ?? 8_000))}`);
  }
  return { stdout, stderr };
}

function runCli(cli: string, args: string[], options: {
  cwd: string;
  label: string;
  baseUrl?: string;
  apiKey?: string | null;
}): RunResult {
  const fullArgs = [...args];
  if (options.baseUrl) fullArgs.push("--runtime-url", options.baseUrl);
  if (options.apiKey) fullArgs.push("--api-key", options.apiKey);
  return run(cli, fullArgs, {
    cwd: options.cwd,
    label: options.label,
    maxOutputChars: 12_000,
  });
}

function apiKey(): string | null {
  return process.env.AIONIS_PUBLISHED_CLI_SMOKE_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(session: RuntimeSession): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (session.child && (session.child.exitCode !== null || session.child.signalCode !== null)) {
      throw new Error(`published CLI smoke Runtime exited early.\n${session.logs.join("").slice(-8_000)}`);
    }
    try {
      const res = await fetch(`${session.baseUrl}/health`);
      if (res.ok) return;
      lastError = `${res.status} ${await res.text()}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`published CLI smoke Runtime did not become healthy: ${lastError}\n${session.logs.join("").slice(-8_000)}`);
}

async function openRuntime(runtimeDir: string): Promise<RuntimeSession> {
  const externalBaseUrl = process.env.AIONIS_PUBLISHED_CLI_SMOKE_BASE_URL?.trim();
  if (externalBaseUrl) {
    return {
      baseUrl: externalBaseUrl.replace(/\/+$/, ""),
      child: null,
      logs: [],
    };
  }

  const port = await findFreePort();
  const logs: string[] = [];
  const child = spawn(npxCommand(), ["tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...cleanNoKeyEnv(),
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      AIONIS_LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_BYPASS_LOOPBACK: "true",
      LITE_LOCAL_ACTOR_ID: "published-cli-smoke",
      LITE_WRITE_SQLITE_PATH: path.join(runtimeDir, "write.sqlite"),
      LITE_REPLAY_SQLITE_PATH: path.join(runtimeDir, "replay.sqlite"),
      EMBEDDING_PROVIDER: "none",
      SANDBOX_ENABLED: "false",
      SANDBOX_ADMIN_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 100) logs.splice(0, logs.length - 100);
  });
  child.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 100) logs.splice(0, logs.length - 100);
  });
  child.on("exit", (code, signal) => {
    logs.push(`runtime exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
  });

  const session = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    logs,
  };
  await waitForHealth(session);
  return session;
}

async function closeRuntime(session: RuntimeSession): Promise<void> {
  if (!session.child || session.child.exitCode !== null) return;
  session.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (session.child?.exitCode === null) session.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    session.child?.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function installPublishedCli(appDir: string, cliSpec: string): string {
  run(npmCommand(), ["init", "-y"], {
    cwd: appDir,
    env: cleanNoKeyEnv(),
    label: "published CLI smoke npm init",
  });
  run(npmCommand(), ["install", "--silent", "--no-audit", "--fund=false", cliSpec], {
    cwd: appDir,
    env: cleanNoKeyEnv(),
    label: `published CLI smoke install ${cliSpec}`,
    maxOutputChars: 12_000,
  });
  const cli = binPath(appDir, "aionis");
  assertCondition(fs.existsSync(cli), `published CLI binary missing after install: ${cli}`);
  return cli;
}

function assertContains(text: string, needle: string, label: string): void {
  assertCondition(text.includes(needle), `${label} did not include ${needle}`);
}

function assertPreviewOutput(output: string, label: string): void {
  const parsed = JSON.parse(output) as unknown;
  const record = asRecord(parsed);
  assertCondition(record?.preview === true, `${label} did not return preview=true`);
  assertCondition(record.runtime_mutation === false, `${label} did not keep runtime_mutation=false`);
  const request = asRecord(record.request);
  assertCondition(request?.path === "/v1/forget", `${label} did not describe /v1/forget request`);
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-published-cli-smoke-"));
  const appDir = path.join(tmpRoot, "cli-app");
  const runtimeDir = path.join(tmpRoot, "runtime");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const cliSpec = process.env.AIONIS_PUBLISHED_CLI_SMOKE_SPEC?.trim() || DEFAULT_CLI_SPEC;
  const key = apiKey();
  const checks: Record<string, boolean> = {};
  const cli = installPublishedCli(appDir, cliSpec);

  const help = runCli(cli, ["--help"], {
    cwd: appDir,
    label: "published CLI help",
  });
  for (const command of ["snapshot", "audit", "forget"]) {
    assertContains(help.stdout, command, `published CLI help`);
  }
  checks.operator_commands_exposed = true;

  const localPreview = runCli(cli, [
    "forget",
    "rehydrate",
    "--memory-id",
    "mem_published_cli_smoke",
    "--reason",
    "published CLI local preview smoke",
    "--json",
  ], {
    cwd: appDir,
    label: "published CLI local forget preview",
  });
  assertPreviewOutput(localPreview.stdout, "published CLI local forget preview");
  checks.local_forget_preview_non_mutating = true;

  const runtime = await openRuntime(runtimeDir);
  try {
    const health = runCli(cli, ["health"], {
      cwd: appDir,
      label: "published CLI health",
      baseUrl: runtime.baseUrl,
      apiKey: key,
    });
    assertContains(health.stdout, "Runtime health", "published CLI health");
    checks.health = true;

    const boundary = runCli(cli, ["boundary", "--json"], {
      cwd: appDir,
      label: "published CLI boundary",
      baseUrl: runtime.baseUrl,
      apiKey: key,
    });
    assertCondition(!!asRecord(JSON.parse(boundary.stdout) as unknown), "published CLI boundary did not return JSON object");
    checks.boundary = true;

    const doctor = runCli(cli, ["doctor"], {
      cwd: appDir,
      label: "published CLI doctor",
      baseUrl: runtime.baseUrl,
      apiKey: key,
    });
    assertContains(doctor.stdout, "Runtime doctor", "published CLI doctor");
    checks.doctor = true;

    const snapshot = runCli(cli, [
      "snapshot",
      "--run-id",
      "published-cli-smoke",
      "--include-markdown",
      "--json",
    ], {
      cwd: appDir,
      label: "published CLI snapshot",
      baseUrl: runtime.baseUrl,
      apiKey: key,
    });
    const snapshotRecord = asRecord(JSON.parse(snapshot.stdout) as unknown);
    const operatorSnapshot = asRecord(snapshotRecord?.operator_snapshot);
    assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "published CLI snapshot missing operator snapshot contract");
    checks.snapshot = true;

    const flightInputPath = path.join(appDir, "flight-recorder-input.json");
    fs.writeFileSync(flightInputPath, JSON.stringify({
      tenant_id: "default",
      scope: "published-cli-smoke",
      run_id: "published-cli-smoke",
      operator_snapshot: operatorSnapshot,
    }, null, 2));
    const flight = runCli(cli, [
      "audit",
      "flight-recorder",
      "--input",
      flightInputPath,
    ], {
      cwd: appDir,
      label: "published CLI audit flight-recorder",
      baseUrl: runtime.baseUrl,
      apiKey: key,
    });
    assertContains(flight.stdout, "Agent Flight Recorder", "published CLI audit flight-recorder");
    checks.flight_recorder = true;

    const runtimePreview = runCli(cli, [
      "forget",
      "rehydrate",
      "--memory-id",
      "mem_published_cli_smoke",
      "--reason",
      "published CLI runtime preview smoke",
      "--json",
    ], {
      cwd: appDir,
      label: "published CLI runtime forget preview",
      baseUrl: runtime.baseUrl,
      apiKey: key,
    });
    assertPreviewOutput(runtimePreview.stdout, "published CLI runtime forget preview");
    checks.runtime_forget_preview_non_mutating = true;

    const result = {
      contract_version: "aionis_published_cli_operator_smoke_v1",
      cli_spec: cliSpec,
      runtime: {
        base_url: runtime.baseUrl,
        spawned: !!runtime.child,
        embedding_provider: runtime.child ? "none" : null,
      },
      checks,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closeRuntime(runtime);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
