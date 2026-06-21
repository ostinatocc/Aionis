#!/usr/bin/env node
import "dotenv/config";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type RuntimeSession = {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  logs: string[];
};

const DEFAULT_CREATE_SPEC = "@aionis/create@latest";
const DEFAULT_MCP_SPEC = "@aionis/mcp@latest";

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
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
}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${options.label} failed with exit code ${result.status ?? "unknown"}\n${output.slice(-(options.maxOutputChars ?? 8_000))}`);
  }
  return output;
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

function installFreshRuntime(input: {
  tmpRoot: string;
  createSpec: string;
  repoOverride: string | null;
}): { targetDir: string; installerOutput: string } {
  const args = [
    "exec",
    "--yes",
    "--package",
    input.createSpec,
    "--",
    "create-aionis",
    "FreshRuntime",
    "--quickstart",
    "none",
  ];
  if (input.repoOverride) {
    args.push("--repo", input.repoOverride);
  }

  const installerOutput = run(npmCommand(), args, {
    cwd: input.tmpRoot,
    env: cleanNoKeyEnv(),
    label: `fresh install ${input.createSpec}`,
    maxOutputChars: 16_000,
  });

  const targetDir = path.join(input.tmpRoot, "FreshRuntime");
  assertCondition(fs.existsSync(targetDir), "fresh installer did not create Runtime directory");
  return { targetDir, installerOutput };
}

function readInstalledEnv(targetDir: string): Record<string, string> {
  const envPath = path.join(targetDir, ".env");
  assertCondition(fs.existsSync(envPath), "fresh installer did not write .env");
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    try {
      out[match[1] ?? ""] = JSON.parse(match[2] ?? "\"\"");
    } catch {
      out[match[1] ?? ""] = match[2] ?? "";
    }
  }
  return out;
}

async function openInstalledRuntime(targetDir: string): Promise<RuntimeSession> {
  const port = await findFreePort();
  const logs: string[] = [];
  const child = spawn(npmCommand(), ["run", "-s", "lite:start"], {
    cwd: targetDir,
    env: {
      ...cleanNoKeyEnv(),
      PORT: String(port),
      AIONIS_LISTEN_HOST: "127.0.0.1",
      EMBEDDING_PROVIDER: "none",
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

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      if (res.ok) {
        const body = await res.json() as unknown;
        assertCondition(asRecord(body)?.ready === true, "fresh Runtime /readyz did not report ready");
        return { baseUrl, child, logs };
      }
    } catch {
      // wait for startup
    }
    await sleep(250);
  }

  closeRuntime({ baseUrl, child, logs });
  throw new Error(`fresh Runtime did not become ready.\n${logs.join("").slice(-6_000)}`);
}

function closeRuntime(session: RuntimeSession): void {
  if (session.child.exitCode === null) session.child.kill("SIGTERM");
}

async function runPublishedMcpContextSmoke(input: {
  tmpRoot: string;
  baseUrl: string;
  mcpSpec: string;
  runId: string;
}): Promise<Record<string, unknown>> {
  const projectDir = path.join(input.tmpRoot, "demo-project");
  fs.mkdirSync(projectDir, { recursive: true });

  const client = new Client({ name: "aionis-fresh-install-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: npxCommand(),
    args: [
      "-y",
      input.mcpSpec,
      "--base-url",
      input.baseUrl,
      "--tenant",
      "default",
      "--scope-from",
      "workspace",
      "--repo-root",
      projectDir,
    ],
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assertCondition(toolNames.includes("aionis_record_step"), "fresh MCP install did not expose aionis_record_step");
    assertCondition(toolNames.includes("aionis_context"), "fresh MCP install did not expose aionis_context");

    const health = await client.callTool({ name: "aionis_health", arguments: {} });
    assertCondition(asRecord(health.structuredContent)?.ok === true, "fresh MCP health failed");

    const record = await client.callTool({
      name: "aionis_record_step",
      arguments: {
        run_id: `fresh-install-${input.runId}`,
        task_signature: "fresh-install-mcp-context",
        task_family: "fresh_install_ci",
        agent_id: "fresh-install-planner",
        role: "planner",
        title: "Fresh install smoke accepted route",
        summary: "The fresh installer produced a no-key Runtime and MCP can record execution state.",
        outcome: "succeeded",
        target_files: ["src/fresh-install-smoke.ts"],
        acceptance_checks: ["aionis_context returns a compiled context"],
        feedback: false,
      },
    });
    assertCondition(asRecord(record.structuredContent)?.ok === true, `fresh MCP record step failed: ${JSON.stringify(record, null, 2)}`);

    const context = await client.callTool({
      name: "aionis_context",
      arguments: {
        run_id: `fresh-install-${input.runId}`,
        task_signature: "fresh-install-mcp-context",
        task_family: "fresh_install_ci",
        agent_id: "fresh-install-worker",
        role: "worker",
        query_text: "Continue from the fresh install smoke planner route.",
        context_mode: "compact_agent",
        budget_profile: "compact",
        max_prompt_chars: 4_000,
      },
    });
    const payload = asRecord(context.structuredContent);
    assertCondition(payload?.ok === true, `fresh MCP context failed: ${JSON.stringify(context, null, 2)}`);
    assertCondition(String(payload.agent_prompt ?? "").includes("AIONIS_EXECUTION_AGENT_CONTEXT"), "fresh MCP context did not compile execution prompt");
    assertCondition(asRecord(payload.memory_use_receipt)?.contract_version === "aionis_memory_use_receipt_v1", "fresh MCP context missing memory use receipt");

    const identityPath = path.join(projectDir, ".aionis", "workspace.json");
    assertCondition(fs.existsSync(identityPath), "fresh MCP workspace scope did not create workspace identity");
    const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as unknown;
    const identityRecord = asRecord(identity);
    assertCondition(typeof identityRecord?.scope === "string" && identityRecord.scope.startsWith("ws:demo-project:"), "fresh MCP workspace scope was not stable ws scope");

    return {
      ok: true,
      mcp_spec: input.mcpSpec,
      tool_count: toolNames.length,
      context_contract: asRecord(payload.execution_context)?.contract_version,
      receipt_contract: asRecord(payload.memory_use_receipt)?.contract_version,
      workspace_scope: identityRecord.scope,
      aliases: Array.isArray(identityRecord.aliases) ? identityRecord.aliases : [],
    };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const runId = Date.now().toString(36);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-fresh-install-smoke-"));
  const createSpec = process.env.AIONIS_FRESH_INSTALL_CREATE_SPEC?.trim() || DEFAULT_CREATE_SPEC;
  const mcpSpec = process.env.AIONIS_FRESH_INSTALL_MCP_SPEC?.trim() || DEFAULT_MCP_SPEC;
  const repoOverride = process.env.AIONIS_FRESH_INSTALL_REPO?.trim() || null;

  const install = installFreshRuntime({ tmpRoot, createSpec, repoOverride });
  const installedEnv = readInstalledEnv(install.targetDir);
  assertCondition(installedEnv.EMBEDDING_PROVIDER === "none", `fresh installer should default to EMBEDDING_PROVIDER=none; got ${installedEnv.EMBEDDING_PROVIDER ?? "missing"}`);

  const runtime = await openInstalledRuntime(install.targetDir);
  try {
    const mcp = await runPublishedMcpContextSmoke({
      tmpRoot,
      baseUrl: runtime.baseUrl,
      mcpSpec,
      runId,
    });

    const result = {
      contract_version: "aionis_fresh_install_smoke_v1",
      run_id: `fresh-install-smoke-${runId}`,
      install: {
        create_spec: createSpec,
        repo_override: repoOverride,
        target_dir: install.targetDir,
        embedding_provider: installedEnv.EMBEDDING_PROVIDER,
        installer_output_tail: install.installerOutput.slice(-2_000),
      },
      runtime: {
        base_url: runtime.baseUrl,
        ready: true,
        embedding_provider: "none",
      },
      mcp,
      checks: {
        installer_completed: true,
        no_key_env_written: installedEnv.EMBEDDING_PROVIDER === "none",
        runtime_started_without_embedding_key: true,
        mcp_context_ok: asRecord(mcp).ok === true,
      },
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    closeRuntime(runtime);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
