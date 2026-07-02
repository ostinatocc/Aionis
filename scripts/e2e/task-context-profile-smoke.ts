#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type ExternalSdkInstall = {
  appDir: string;
  tmpRoot: string;
  sdkSpec: string;
  installedVersion: string;
};

const DEFAULT_SDK_SPEC = "@aionis/sdk@latest";

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
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
    throw new Error(`${options.label} failed with exit code ${result.status ?? "unknown"}\n${output.slice(-(options.maxOutputChars ?? 6_000))}`);
  }
  return output;
}

function prepareExternalSdkInstall(): ExternalSdkInstall {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-task-context-profile-smoke-"));
  const appDir = path.join(tmpRoot, "external-sdk-host");
  fs.mkdirSync(appDir, { recursive: true });
  const sdkSpec = process.env.AIONIS_TASK_CONTEXT_PROFILE_SMOKE_SDK_SPEC?.trim() || DEFAULT_SDK_SPEC;

  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "aionis-task-context-profile-smoke",
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
  ], {
    cwd: appDir,
    label: "external SDK install",
    maxOutputChars: 10_000,
  });

  const packageJsonPath = path.join(appDir, "node_modules", "@aionis", "sdk", "package.json");
  const installed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  assertCondition(typeof installed.version === "string" && installed.version.length > 0, "installed @aionis/sdk version missing");

  return {
    appDir,
    tmpRoot,
    sdkSpec,
    installedVersion: installed.version,
  };
}

function writeExternalSmokeScript(appDir: string): string {
  const scriptPath = path.join(appDir, "task-context-profile-smoke.mjs");
  fs.writeFileSync(scriptPath, `
import {
  agentContextFromGuide,
  createAionisClient,
} from "@aionis/sdk";

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function promptFromContext(context) {
  const prompt = context?.prompt_text;
  assertCondition(typeof prompt === "string" && prompt.length > 0, "agent_context.prompt_text missing");
  return prompt;
}

function assertProfileContext(label, guide, profile, expectedPromptFragment) {
  const context = agentContextFromGuide(guide);
  const prompt = promptFromContext(context);
  assertCondition(context.contract_version === "aionis_agent_context_v1", label + " missing agent_context contract");
  assertCondition(context.task_context_profile === profile, label + " did not return task_context_profile=" + profile);
  assertCondition(prompt.includes(expectedPromptFragment), label + " prompt missing fragment: " + expectedPromptFragment);
  return {
    label,
    profile,
    guide_trace_id: guide.guide_trace_id,
    prompt_fragment: expectedPromptFragment,
    prompt_preview: prompt.split("\\n").slice(0, 4).join("\\n"),
  };
}

const baseUrl = process.env.AIONIS_TASK_CONTEXT_PROFILE_SMOKE_BASE_URL;
assertCondition(baseUrl, "AIONIS_TASK_CONTEXT_PROFILE_SMOKE_BASE_URL is required");
const runId = process.env.AIONIS_TASK_CONTEXT_PROFILE_SMOKE_RUN_ID || "task-context-profile-smoke";
const client = createAionisClient({
  baseUrl,
  tenant_id: "default",
  scope: "task-context-profile-smoke:" + runId,
});

await client.health();

const codingGuide = await client.guide({
  query_text: "Continue the implementation and run the required checks.",
  mode: "full_power",
  context_mode: "compact_agent",
  task_context_profile: "coding_verifier",
  consumer_agent_id: "coding-worker",
  run_id: runId + ":coding",
  context: {
    task_signature: "task-context-profile-coding",
  },
});

const longQaGuide = await client.guide({
  query_text: "Answer from the retained source evidence.",
  mode: "full_power",
  context_mode: "compact_agent",
  task_context_profile: "long_qa",
  consumer_agent_id: "qa-agent",
  run_id: runId + ":long-qa",
  context: {
    task_signature: "task-context-profile-long-qa",
  },
});

const handoffGuide = await client.execution.guideForRole({
  agent_id: "reviewer-1",
  team_id: "checkout-team",
  role: "reviewer",
  run_id: runId + ":handoff",
  task_signature: "task-context-profile-handoff",
  query_text: "Review the worker handoff and continue from current state.",
  context_mode: "compact_agent",
  task_context_profile: "multi_agent_handoff",
});

const agentContextResult = await client.execution.guideAgentContextForRole({
  agent_id: "loop-worker-1",
  role: "worker",
  run_id: runId + ":loop",
  task_signature: "task-context-profile-loop",
  query_text: "Continue the loop from the latest validator result.",
  context_mode: "compact_agent",
  task_context_profile: "loop_engineering",
});
const loopGuide = asRecord(agentContextResult.guide);
assertCondition(loopGuide, "guideAgentContextForRole did not return guide object");

const results = [
  assertProfileContext("guide:coding_verifier", codingGuide, "coding_verifier", "task coding_verifier:"),
  assertProfileContext("guide:long_qa", longQaGuide, "long_qa", "task long_qa:"),
  assertProfileContext("execution.guideForRole:multi_agent_handoff", handoffGuide, "multi_agent_handoff", "task multi_agent_handoff:"),
  assertProfileContext("execution.guideAgentContextForRole:loop_engineering", loopGuide, "loop_engineering", "task loop_engineering:"),
];

assertCondition(
  typeof agentContextResult.agent_prompt === "string" && agentContextResult.agent_prompt.includes("task loop_engineering:"),
  "guideAgentContextForRole agent_prompt missing loop_engineering posture",
);

process.stdout.write(JSON.stringify({
  ok: true,
  result_count: results.length,
  results,
}, null, 2) + "\\n");
`);
  return scriptPath;
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  const runtime = await openRuntime();
  const install = prepareExternalSdkInstall();
  try {
    const script = writeExternalSmokeScript(install.appDir);
    const output = run(process.execPath, [script], {
      cwd: install.appDir,
      env: {
        ...process.env,
        AIONIS_TASK_CONTEXT_PROFILE_SMOKE_BASE_URL: runtime.baseUrl,
        AIONIS_TASK_CONTEXT_PROFILE_SMOKE_RUN_ID: runId,
      },
      label: "task context profile external SDK smoke",
      maxOutputChars: 12_000,
    });
    const result = JSON.parse(output.trim()) as Record<string, unknown>;
    assertCondition(result.ok === true, "external SDK smoke returned non-ok result");
    process.stdout.write(JSON.stringify({
      ok: true,
      runtime_mode: runtime.mode,
      sdk_spec: install.sdkSpec,
      sdk_version: install.installedVersion,
      smoke: result,
    }, null, 2) + "\n");
  } finally {
    closeRuntime(runtime);
    if (process.env.AIONIS_KEEP_TASK_CONTEXT_PROFILE_SMOKE_TMP !== "true") {
      fs.rmSync(install.tmpRoot, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(formatE2eError("task-context-profile-smoke failed", err));
  process.exit(1);
});
