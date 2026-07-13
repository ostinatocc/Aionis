#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type ExternalPackageInstall = {
  tmpRoot: string;
  appDir: string;
  sdkSpec: string;
  mcpSpec: string;
  createSpec: string;
};

const SDK_MARKER = "EXTERNAL_PACKAGE_SMOKE_SDK_MEMORY";
const MCP_MARKER = "EXTERNAL_PACKAGE_SMOKE_MCP_MEMORY";
const DEFAULT_SDK_SPEC = "@aionis/sdk@latest";
const DEFAULT_MCP_SPEC = "@aionis/mcp@latest";
const DEFAULT_CREATE_SPEC = "@aionis/create@latest";

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
    throw new Error(`${options.label} failed with exit code ${result.status ?? "unknown"}\n${output.slice(-(options.maxOutputChars ?? 6_000))}`);
  }
  return output;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeModulesBin(appDir: string, binName: string): string {
  return process.platform === "win32"
    ? path.join(appDir, "node_modules", ".bin", `${binName}.cmd`)
    : path.join(appDir, "node_modules", ".bin", binName);
}

function packageSpecFromEnv(envName: string, fallback: string): string {
  return process.env[envName]?.trim() || fallback;
}

function prepareExternalInstall(): ExternalPackageInstall {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-external-package-smoke-"));
  const appDir = path.join(tmpRoot, "external-app");
  fs.mkdirSync(appDir, { recursive: true });
  const sdkSpec = packageSpecFromEnv("AIONIS_EXTERNAL_SMOKE_SDK_SPEC", DEFAULT_SDK_SPEC);
  const mcpSpec = packageSpecFromEnv("AIONIS_EXTERNAL_SMOKE_MCP_SPEC", DEFAULT_MCP_SPEC);
  const createSpec = packageSpecFromEnv("AIONIS_EXTERNAL_SMOKE_CREATE_SPEC", DEFAULT_CREATE_SPEC);

  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "aionis-external-package-smoke",
      private: true,
      type: "module",
    }, null, 2),
  );

  run(npmCommand(), [
    "install",
    "--silent",
    "--no-audit",
    "--fund=false",
    sdkSpec,
    mcpSpec,
    createSpec,
  ], {
    cwd: appDir,
    label: "external npm install",
    maxOutputChars: 10_000,
  });

  return { tmpRoot, appDir, sdkSpec, mcpSpec, createSpec };
}

function writeExternalSdkSmoke(appDir: string): string {
  const scriptPath = path.join(appDir, "sdk-smoke.mjs");
  fs.writeFileSync(scriptPath, `
import {
  agentContextFromGuide,
  createAionisClient,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop
} from "@aionis/sdk";

const marker = ${JSON.stringify(SDK_MARKER)};
const taskFamily = "external_package_entrypoint";
const taskSignature = "external-package-sdk-smoke:" + (process.env.AIONIS_EXTERNAL_SMOKE_RUN_ID || "external-package-sdk-smoke");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function textArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function firstNodeId(observeBody, label) {
  const write = asRecord(observeBody.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes : [];
  const first = asRecord(nodes[0]);
  assertCondition(typeof first?.id === "string" && first.id.length > 0, label + " did not return node id");
  return first.id;
}

const baseUrl = process.env.AIONIS_EXTERNAL_SMOKE_BASE_URL;
assertCondition(baseUrl, "AIONIS_EXTERNAL_SMOKE_BASE_URL is required");
const scope = process.env.AIONIS_EXTERNAL_SMOKE_SCOPE || "external-package-smoke-sdk";
const runId = process.env.AIONIS_EXTERNAL_SMOKE_RUN_ID || "external-package-smoke-sdk";
const client = createAionisClient({
  baseUrl,
  tenant_id: "default",
  scope,
});

await client.health();
const beforeGuide = await client.execution.guideForRole({
  agent_id: "external-sdk-agent",
  role: "reviewer",
  run_id: runId + ":before",
  task_signature: taskSignature,
  task_family: taskFamily,
  query_text: marker + " before memory exists",
  mode: "full_power",
  context_mode: "compact_agent",
  limit: 10,
  include_packets: true,
});
const beforeContext = agentContextFromGuide(beforeGuide);
assertCondition(beforeContext.actionable_history_used === false, "SDK packaged fresh task unexpectedly started with actionable history");

const remembered = await client.remember({
  kind: "project_context",
  title: "External package SDK smoke memory",
  text: marker + ": use the packaged SDK path for the external developer smoke.",
  memory_lane: "private",
  owner_agent_id: "external-sdk-agent",
  confidence: 0.93,
  target_files: ["README.md"],
  slots: { source: "external_package_smoke" },
});
const memoryId = firstNodeId(remembered, "external SDK remember");
const resolvedMemory = await client.resolveMemory({
  uri: "aionis://default/" + encodeURIComponent(scope) + "/topic/" + encodeURIComponent(memoryId),
  consumer_agent_id: "external-sdk-agent",
  include_meta: true,
  include_slots: true,
});
const resolvedNode = asRecord(resolvedMemory.node);
assertCondition(resolvedNode?.id === memoryId, "SDK packaged remember was not synchronously resolvable");
assertCondition(String(resolvedNode?.text_summary ?? "").includes(marker), "SDK packaged resolved memory missing marker");

const handoff = await client.execution.handoff({
  operation_id: "external-package-sdk-handoff:" + runId,
  agent_id: "external-sdk-agent",
  role: "worker",
  run_id: runId + ":handoff",
  task_signature: taskSignature,
  task_family: taskFamily,
  memory_lane: "private",
  title: "External package SDK continuity handoff",
  summary: marker + ": continue the packaged SDK path from the committed handoff.",
  handoff_text: marker + ": recover this structured handoff without semantic embeddings.",
  target_files: ["README.md"],
  continuation_hint: "Continue the packaged SDK entrypoint smoke.",
  acceptance_checks: ["structured handoff is exposed in actionable agent context"],
  evidence_ref: "evidence://external-package-sdk/" + runId + "/handoff",
});
const handoffEnvelope = asRecord(handoff.handoff);
assertCondition(handoffEnvelope, "SDK packaged execution handoff was not stored");
const storedHandoff = asRecord(handoffEnvelope.handoff);
const handoffMemoryId = storedHandoff?.id;
assertCondition(typeof handoffMemoryId === "string" && handoffMemoryId.length > 0, "external SDK handoff did not return node id");

const afterGuide = await client.execution.guideForRole({
  agent_id: "external-sdk-agent",
  role: "reviewer",
  run_id: runId + ":after",
  task_signature: taskSignature,
  task_family: taskFamily,
  query_text: marker + " continue with packaged SDK",
  mode: "full_power",
  context_mode: "compact_agent",
  limit: 10,
  include_packets: true,
});
const context = agentContextFromGuide(afterGuide);
const useNowMemoryIds = textArray(context.use_now_memory_ids);
const promptText = String(context.prompt_text ?? "");
const sourceMap = asRecord(afterGuide.source_map);
const internalSurfaces = textArray(sourceMap?.internal_surfaces_used);
assertCondition(context.contract_version === "aionis_agent_context_v1", "SDK packaged guide missing agent_context");
assertCondition(context.actionable_history_used === true, "SDK packaged guide did not use actionable history");
assertCondition(useNowMemoryIds.includes(handoffMemoryId), "SDK packaged guide did not expose structured handoff memory");
assertCondition(promptText.includes(marker) || textArray(context.use_now).some((entry) => entry.includes(marker)), "SDK packaged guide missing marker");
assertCondition(internalSurfaces.includes("planning_context_embedding_unavailable"), "SDK packaged guide did not prove the no-embedding path");
assertCondition(internalSurfaces.includes("full_power_agent_context_merge"), "SDK packaged guide did not merge structured handoff context");

const feedback = await client.feedback(feedbackFromGuide({
  guide: afterGuide,
  run_id: runId + ":feedback",
  outcome: "positive",
  reason: "External package SDK smoke used the exposed structured handoff successfully.",
  used_memory_ids: [handoffMemoryId],
}));

const measure = await client.measure(measureInputFromGuideLoop({
  task: {
    task_id: "task:" + runId,
    run_id: runId,
    task_signature: taskSignature,
    task_family: taskFamily,
  },
  before_guide: beforeGuide,
  after_guide: afterGuide,
  feedback_result: feedback,
  sufficient_evidence: true,
  evidence_ids: ["memory:" + handoffMemoryId],
}));
assertCondition(measure.contract_version === "aionis_measure_result_v1", "SDK packaged measure missing contract");

const snapshot = await client.snapshot(snapshotInputFromGuideLoop({
  run_id: runId,
  task_signature: taskSignature,
  task_family: taskFamily,
  guide: afterGuide,
  measure_result: measure,
  include_markdown: false,
}));
const operatorSnapshot = asRecord(snapshot.operator_snapshot);
assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "SDK packaged snapshot missing contract");

process.stdout.write(JSON.stringify({
  ok: true,
  package: "@aionis/sdk",
  ordinary_memory_id: memoryId,
  handoff_memory_id: handoffMemoryId,
  use_now_memory_ids: useNowMemoryIds,
  internal_surfaces: internalSurfaces,
  measure_contract: measure.contract_version,
  snapshot_contract: operatorSnapshot.contract_version
}, null, 2) + "\\n");
`);
  return scriptPath;
}

function runExternalSdkSmoke(appDir: string, baseUrl: string, runId: string): Record<string, unknown> {
  const script = writeExternalSdkSmoke(appDir);
  const output = run(process.execPath, [script], {
    cwd: appDir,
    env: {
      ...process.env,
      AIONIS_EXTERNAL_SMOKE_BASE_URL: baseUrl,
      AIONIS_EXTERNAL_SMOKE_SCOPE: `external-package-smoke:sdk:${runId}`,
      AIONIS_EXTERNAL_SMOKE_RUN_ID: `external-package-sdk-${runId}`,
    },
    label: "external SDK package smoke",
    maxOutputChars: 10_000,
  });
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

async function runExternalMcpSmoke(appDir: string, baseUrl: string, runId: string): Promise<Record<string, unknown>> {
  const mcpMain = path.join(appDir, "node_modules", "@aionis", "mcp", "dist", "index.js");
  assertCondition(fs.existsSync(mcpMain), "@aionis/mcp dist entrypoint missing after install");

  const client = new Client({ name: "aionis-external-package-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      mcpMain,
      "--base-url",
      baseUrl,
      "--tenant",
      "default",
      "--scope",
      `external-package-smoke:mcp:${runId}`,
    ],
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assertCondition(toolNames.includes("aionis_health"), "MCP package did not expose aionis_health");
    assertCondition(toolNames.includes("aionis_remember"), "MCP package did not expose aionis_remember");
    assertCondition(toolNames.includes("aionis_context"), "MCP package did not expose aionis_context");

    const health = await client.callTool({
      name: "aionis_health",
      arguments: {},
    });
    const healthPayload = asRecord(health.structuredContent);
    assertCondition(healthPayload?.ok === true, "MCP package health tool failed");

    const beforeContext = await client.callTool({
      name: "aionis_context",
      arguments: {
        run_id: `external-package-mcp-${runId}:before`,
        task_signature: "external-package-mcp-smoke",
        task_family: "external_package_entrypoint",
        agent_id: "external-mcp-agent",
        role: "reviewer",
        query_text: `${MCP_MARKER} before packaged MCP memory exists`,
        context_mode: "compact_agent",
        budget_profile: "compact",
        max_prompt_chars: 4_000,
      },
    });
    const beforeContextPayload = asRecord(beforeContext.structuredContent);
    assertCondition(beforeContextPayload?.ok === true, "MCP package before-context tool failed");

    const remember = await client.callTool({
      name: "aionis_remember",
      arguments: {
        text: `${MCP_MARKER}: use the packaged MCP path for the external developer smoke.`,
        kind: "project_context",
        title: "External package MCP smoke memory",
        memory_lane: "private",
        owner_agent_id: "external-mcp-agent",
        confidence: 0.92,
        target_files: ["docs/AIONIS_MCP.md"],
        slots: { source: "external_package_smoke" },
      },
    });
    const rememberPayload = asRecord(remember.structuredContent);
    assertCondition(rememberPayload?.ok === true, "MCP package remember tool failed");

    const context = await client.callTool({
      name: "aionis_context",
      arguments: {
        run_id: `external-package-mcp-${runId}`,
        task_signature: "external-package-mcp-smoke",
        task_family: "external_package_entrypoint",
        agent_id: "external-mcp-agent",
        role: "reviewer",
        query_text: `${MCP_MARKER} continue with packaged MCP`,
        context_mode: "compact_agent",
        budget_profile: "compact",
        max_prompt_chars: 4_000,
      },
    });
    const contextPayload = asRecord(context.structuredContent);
    assertCondition(contextPayload?.ok === true, "MCP package context tool failed");
    assertCondition(String(contextPayload.agent_prompt ?? "").includes("AIONIS_EXECUTION_AGENT_CONTEXT"), "MCP package context did not compile execution prompt");
    const memoryUseReceipt = asRecord(contextPayload.memory_use_receipt);
    assertCondition(memoryUseReceipt?.contract_version === "aionis_memory_use_receipt_v1", "MCP package context missing memory use receipt");

    const measure = await client.callTool({
      name: "aionis_measure",
      arguments: {
        run_id: `external-package-mcp-${runId}`,
        task_signature: "external-package-mcp-smoke",
        task_family: "external_package_entrypoint",
        before_guide: beforeContextPayload.guide,
        after_guide: contextPayload.guide,
        sufficient_evidence: true,
        evidence_ids: [`mcp:${runId}:context`],
      },
    });
    const measurePayload = asRecord(measure.structuredContent);
    const measureResult = asRecord(measurePayload?.measure);
    assertCondition(measurePayload?.ok === true, `MCP package measure tool failed: ${JSON.stringify(measure, null, 2)}`);
    assertCondition(measureResult?.contract_version === "aionis_measure_result_v1", "MCP package measure missing contract");

    return {
      ok: true,
      package: "@aionis/mcp",
      tools: toolNames,
      context_contract: asRecord(contextPayload.execution_context)?.contract_version,
      receipt_contract: memoryUseReceipt.contract_version,
      measure_contract: measureResult.contract_version,
    };
  } finally {
    await client.close();
  }
}

function runCliEntrypointChecks(appDir: string): Record<string, unknown> {
  const createBin = nodeModulesBin(appDir, "create-aionis");
  const mcpBin = nodeModulesBin(appDir, "aionis-mcp");
  assertCondition(fs.existsSync(createBin), "@aionis/create bin missing after install");
  assertCondition(fs.existsSync(mcpBin), "@aionis/mcp bin missing after install");

  const createHelp = run(createBin, ["--help"], {
    cwd: appDir,
    label: "@aionis/create --help",
  });
  const mcpHelp = run(mcpBin, ["--help"], {
    cwd: appDir,
    label: "@aionis/mcp --help",
  });

  assertCondition(createHelp.includes("npx @aionis/create"), "@aionis/create help missing usage");
  assertCondition(createHelp.includes("--quickstart"), "@aionis/create help missing quickstart option");
  assertCondition(mcpHelp.includes("npx @aionis/mcp"), "@aionis/mcp help missing usage");
  assertCondition(mcpHelp.includes("--base-url"), "@aionis/mcp help missing base-url option");

  return {
    create_help_ok: true,
    mcp_help_ok: true,
  };
}

async function main() {
  const runId = Date.now().toString(36);
  const install = prepareExternalInstall();
  const session = await openRuntime();
  try {
    const cli = runCliEntrypointChecks(install.appDir);
    const sdk = runExternalSdkSmoke(install.appDir, session.baseUrl, runId);
    const mcp = await runExternalMcpSmoke(install.appDir, session.baseUrl, runId);

    const result = {
      contract_version: "aionis_external_package_entrypoint_smoke_v1",
      run_id: `external-package-smoke-${runId}`,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      package_install: {
        app_dir: install.appDir,
        sdk_spec: install.sdkSpec,
        mcp_spec: install.mcpSpec,
        create_spec: install.createSpec,
      },
      cli_entrypoints: cli,
      sdk_entrypoint: sdk,
      mcp_entrypoint: mcp,
      checks: {
        create_cli_available: cli.create_help_ok === true,
        mcp_cli_available: cli.mcp_help_ok === true,
        sdk_product_loop_ok: sdk.ok === true,
        mcp_stdio_tool_loop_ok: mcp.ok === true,
      },
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    closeRuntime(session);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
