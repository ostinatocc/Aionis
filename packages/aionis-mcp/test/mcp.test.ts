import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AIONIS_USER_WORKSPACE_IDENTITY_DIR,
  AIONIS_WORKSPACE_IDENTITY_PATH,
  parseAionisMcpConfig,
  type AionisMcpWorkspaceIdentity,
} from "../src/config.ts";
import { createAionisMcpServer } from "../src/server.ts";
import { AIONIS_MCP_TOOL_NAMES, handleAionisMcpTool, type AionisMcpClient } from "../src/tools.ts";

function fakeClient(calls: Array<{ method: string; input?: unknown; options?: unknown }>): AionisMcpClient {
  return {
    remember: async (input, options) => {
      calls.push({ method: "remember", input, options });
      return { memory_id: "mem-1" };
    },
    measure: async (input, options) => {
      calls.push({ method: "measure", input, options });
      return { measured: true };
    },
    snapshot: async (input, options) => {
      calls.push({ method: "snapshot", input, options });
      return { snapshot: true };
    },
    governMemory: async (input, options) => {
      calls.push({ method: "governMemory", input, options });
      return {
        contract_version: "aionis_memory_admission_gateway_result_v1",
        agent_context: {
          use_now_memory_ids: ["mem0:current"],
          do_not_use_memory_ids: ["zep:failed"],
        },
        memory_use_receipt: {
          contract_version: "aionis_memory_use_receipt_v1",
        },
        memory_firewall: {
          contract_version: "aionis_memory_firewall_summary_v1",
          unsafe_direct_use_count: 0,
        },
        admission_summary: {
          do_not_use_count: 1,
        },
      } as any;
    },
    flightRecorder: async (input, options) => {
      calls.push({ method: "flightRecorder", input, options });
      return {
        contract_version: "aionis_agent_flight_recorder_result_v1",
        agent_flight_recorder: {
          contract_version: "aionis_agent_flight_recorder_report_v1",
          agent_prompt_included: false,
          runtime_mutation: false,
          agent_view: {
            use_now_memory_ids: ["mem-current"],
            do_not_use_memory_ids: ["mem-failed"],
          },
        },
      } as any;
    },
    health: async () => {
      calls.push({ method: "health" });
      return { status: "ok" };
    },
    execution: {
      observeStep: async (input) => {
        calls.push({ method: "observeStep", input });
        return { observed: true };
      },
      handoff: async (input) => {
        calls.push({ method: "handoff", input });
        return { handoff: true };
      },
      guideForRole: async (input) => {
        calls.push({ method: "guideForRole", input });
        return {
          guide_trace_id: "guide-1",
          agent_context: {
            prompt_text: "AIONIS_CTX v2\nCURRENT_ACTIVE_PATH: continue verified branch",
            use_now_memory_ids: ["mem-1"],
            command_posture: [
              {
                posture: "should_continue",
                surface: "current",
                memory_id: "mem-1",
                instruction: "Continue the verified branch.",
                reason: "The branch is current.",
                target_files: ["src/checkout.ts"],
              },
              {
                posture: "must_not",
                surface: "do_not_use",
                memory_id: "mem-failed",
                instruction: "Do not repeat the failed branch.",
                reason: "The branch failed review.",
                target_files: ["src/legacy.ts"],
              },
            ],
            route_contract: {
              active_targets: [
                {
                  target: "src/checkout.ts",
                  source_memory_id: "mem-1",
                  source: "should_continue",
                  artifact_status: "may_be_absent",
                  missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
                },
              ],
              pending_artifacts: [
                {
                  target: "src/checkout.ts",
                  source_memory_id: "mem-1",
                  source: "should_continue",
                  status: "unknown_until_host_observation",
                  when: "if_active_target_is_missing",
                  allowed_actions: ["create", "restore", "rehydrate"],
                },
              ],
              reference_only_targets: [],
              blocked_direction_targets: [
                {
                  target: "src/legacy.ts",
                  source_memory_id: "mem-failed",
                  source: "must_not",
                },
              ],
              fallback_policy: "do_not_promote_reference_or_blocked_targets",
            },
          },
        };
      },
      observeOutcome: async (input) => {
        calls.push({ method: "observeOutcome", input });
        return { observe: { observed: true }, feedback: null };
      },
      measureRun: async (input) => {
        calls.push({ method: "measureRun", input });
        return { measured: true };
      },
      snapshotRun: async (input) => {
        calls.push({ method: "snapshotRun", input });
        return { snapshot: true };
      },
    },
  };
}

test("@aionis/mcp parses env and cli config", () => {
  assert.deepEqual(parseAionisMcpConfig([], {
    AIONIS_BASE_URL: "http://runtime.local",
    AIONIS_API_KEY: "secret",
    AIONIS_TENANT_ID: "tenant-a",
    AIONIS_SCOPE: "scope-a",
    AIONIS_GUIDE_MODE: "standard",
  }), {
    baseUrl: "http://runtime.local",
    apiKey: "secret",
    tenant_id: "tenant-a",
    scope: "scope-a",
    default_guide_mode: "standard",
  });

  assert.deepEqual(parseAionisMcpConfig([
    "--base-url",
    "http://127.0.0.1:3009",
    "--tenant",
    "tenant-b",
    "--scope",
    "scope-b",
    "--mode",
    "none",
  ], {}), {
    baseUrl: "http://127.0.0.1:3009",
    apiKey: undefined,
    tenant_id: "tenant-b",
    scope: "scope-b",
    default_guide_mode: null,
  });
});

test("@aionis/mcp derives stable default scope from git repo metadata", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-mcp-git-scope-"));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/checkout-service.git"], { cwd: repoDir });

  const config = parseAionisMcpConfig([
    "--scope-from",
    "git",
    "--repo-root",
    repoDir,
  ], {}, { cwd: repoDir });

  assert.match(config.scope ?? "", /^git:checkout-service:[a-f0-9]{12}$/);
  assert.equal(config.scope_from, "git");
  assert.equal(config.repo_root, repoDir);

  const explicitScope = parseAionisMcpConfig([
    "--scope",
    "explicit-project",
    "--scope-from",
    "git",
    "--repo-root",
    repoDir,
  ], {}, { cwd: repoDir });
  assert.equal(explicitScope.scope, "explicit-project");
});

test("@aionis/mcp creates stable workspace scope and keeps it after git init", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-mcp-workspace-scope-"));
  const first = parseAionisMcpConfig([
    "--scope-from",
    "workspace",
    "--repo-root",
    workspaceDir,
  ], {}, { cwd: workspaceDir });

  assert.match(first.scope ?? "", /^ws:aionis-mcp-workspace-scope-[A-Za-z0-9._-]+:[a-f0-9]{12}$/);
  assert.equal(first.scope_from, "workspace");

  const identityPath = path.join(workspaceDir, AIONIS_WORKSPACE_IDENTITY_PATH);
  const initialIdentity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as AionisMcpWorkspaceIdentity;
  assert.equal(initialIdentity.scope, first.scope);
  assert.equal(initialIdentity.aliases.some((alias) => alias.startsWith("cwd:")), true);
  assert.equal(initialIdentity.aliases.some((alias) => alias.startsWith("git:")), false);

  execFileSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/workspace-demo.git"], { cwd: workspaceDir });

  const second = parseAionisMcpConfig([
    "--scope-from",
    "workspace",
    "--repo-root",
    workspaceDir,
  ], {}, { cwd: workspaceDir });
  const updatedIdentity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as AionisMcpWorkspaceIdentity;

  assert.equal(second.scope, first.scope);
  assert.equal(updatedIdentity.scope, first.scope);
  assert.equal(updatedIdentity.aliases.some((alias) => alias.startsWith("cwd:")), true);
  assert.equal(updatedIdentity.aliases.some((alias) => /^git:workspace-demo:[a-f0-9]{12}$/.test(alias)), true);
});

test("@aionis/mcp can persist workspace scope in the user identity store", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-mcp-user-workspace-scope-"));
  const realRoot = fs.realpathSync(workspaceDir);
  const expectedIdentityPath = path.join(
    os.homedir(),
    AIONIS_USER_WORKSPACE_IDENTITY_DIR,
    `${crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 12)}.json`,
  );

  try {
    fs.rmSync(expectedIdentityPath, { force: true });
    const first = parseAionisMcpConfig([
      "--scope-from",
      "workspace",
      "--workspace-id-store",
      "user",
      "--repo-root",
      workspaceDir,
    ], {}, { cwd: workspaceDir });
    const second = parseAionisMcpConfig([
      "--scope-from",
      "workspace",
      "--workspace-id-store",
      "user",
      "--repo-root",
      workspaceDir,
    ], {}, { cwd: workspaceDir });

    assert.equal(first.scope, second.scope);
    assert.equal(first.workspace_identity_store, "user");
    assert.equal(fs.existsSync(path.join(workspaceDir, AIONIS_WORKSPACE_IDENTITY_PATH)), false);
    assert.equal(fs.existsSync(expectedIdentityPath), true);
    const identity = JSON.parse(fs.readFileSync(expectedIdentityPath, "utf8")) as AionisMcpWorkspaceIdentity;
    assert.equal(identity.scope, first.scope);
  } finally {
    fs.rmSync(expectedIdentityPath, { force: true });
  }
});

test("@aionis/mcp parses workspace identity store from env and cli", () => {
  assert.equal(parseAionisMcpConfig([], {
    AIONIS_SCOPE: "scope-a",
    AIONIS_SCOPE_FROM: "workspace",
    AIONIS_WORKSPACE_ID_STORE: "user",
  }).workspace_identity_store, "user");

  assert.throws(
    () => parseAionisMcpConfig(["--workspace-id-store", "global"], {}),
    /Unsupported workspace id store/,
  );
});

test("@aionis/mcp rejects invalid workspace identity files", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-mcp-invalid-workspace-"));
  const identityPath = path.join(workspaceDir, AIONIS_WORKSPACE_IDENTITY_PATH);
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify({
    contract_version: "aionis_mcp_workspace_identity_v1",
    workspace_id: "abc123",
    scope: "ws:broken:abc123",
    created_at: new Date().toISOString(),
    aliases: [],
  }));

  assert.throws(
    () => parseAionisMcpConfig([
      "--scope-from",
      "workspace",
      "--repo-root",
      workspaceDir,
    ], {}, { cwd: workspaceDir }),
    /Invalid Aionis workspace identity file/,
  );
});

test("@aionis/mcp derives cwd scope when git metadata is unavailable", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-mcp-cwd-scope-"));
  const config = parseAionisMcpConfig([
    "--scope-from",
    "cwd",
    "--repo-root",
    workspaceDir,
  ], {}, { cwd: workspaceDir });

  assert.match(config.scope ?? "", /^cwd:aionis-mcp-cwd-scope-[A-Za-z0-9._-]+:[a-f0-9]{12}$/);
  assert.equal(config.scope_from, "cwd");
});

test("@aionis/mcp falls back to cwd scope when git scope is requested outside a repo", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-mcp-nongit-scope-"));
  const config = parseAionisMcpConfig([
    "--scope-from",
    "git",
    "--repo-root",
    workspaceDir,
  ], {}, { cwd: workspaceDir });

  assert.match(config.scope ?? "", /^cwd:aionis-mcp-nongit-scope-[A-Za-z0-9._-]+:[a-f0-9]{12}$/);
  assert.equal(config.scope_from, "git");
});

test("@aionis/mcp exposes stable product tools", () => {
  assert.deepEqual(AIONIS_MCP_TOOL_NAMES, [
    "aionis_context",
    "aionis_record_step",
    "aionis_handoff",
    "aionis_remember",
    "aionis_govern_memory",
    "aionis_measure",
    "aionis_snapshot",
    "aionis_flight_recorder",
    "aionis_health",
  ]);
  const server = createAionisMcpServer(fakeClient([]));
  assert.equal(server.isConnected(), false);
});

test("@aionis/mcp context tool records optional observation then compiles prompt", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const output = await handleAionisMcpTool(fakeClient(calls), "aionis_context", {
    run_id: "run-1",
    task_signature: "checkout-migration",
    query_text: "Continue from the verified branch.",
    agent_id: "worker-1",
    role: "worker",
    title: "Resume checkout migration",
    summary: "Worker is continuing after verifier approved the adapter boundary.",
    target_files: ["src/checkout.ts"],
    context_mode: "compact_agent",
    context_char_budget: 3000,
    repo_state: {
      missing_files: ["src/checkout.ts"],
      existing_files: ["src/legacy.ts"],
    },
    budget_profile: "compact",
    max_prompt_chars: 4000,
    additional_instructions: ["Prefer the accepted route."],
  });

  assert.deepEqual(calls.map((call) => call.method), ["observeStep", "guideForRole"]);
  assert.match(output.content[0]?.text ?? "", /AIONIS_EXECUTION_AGENT_CONTEXT v1/);
  assert.equal(output.structuredContent?.drop_in_mode, true);
  assert.equal(output.structuredContent?.feedback_required, false);
  assert.equal(output.structuredContent?.agent_prompt, (output.structuredContent?.execution_context as Record<string, unknown>)?.agent_prompt);
  assert.equal((output.structuredContent?.execution_context as Record<string, unknown>)?.contract_version, "aionis_execution_agent_context_v1");
  assert.deepEqual((output.structuredContent?.execution_context as Record<string, unknown>)?.missing_active_targets, ["src/checkout.ts"]);
  assert.equal((output.structuredContent?.memory_use_receipt as Record<string, unknown>)?.contract_version, "aionis_memory_use_receipt_v1");
  assert.equal((output.structuredContent?.memory_admission_record as Record<string, unknown>)?.contract_version, "aionis_memory_admission_record_v1");
  assert.equal(
    (output.structuredContent?.memory_admission_record as { entries?: Array<Record<string, unknown>> })?.entries
      ?.some((entry) => entry.memory_id === "mem-1" && entry.admission_action === "use_now"),
    true,
  );
  assert.equal(
    ((output.structuredContent?.execution_warnings as Array<Record<string, unknown>>) ?? [])
      .some((warning) => warning.code === "missing_active_target"),
    true,
  );
  assert.deepEqual(output.structuredContent?.should_continue_memory_ids, ["mem-1"]);
  assert.deepEqual(output.structuredContent?.must_not_memory_ids, ["mem-failed"]);
  assert.deepEqual(output.structuredContent?.command_posture_memory_ids, ["mem-1", "mem-failed"]);
  assert.deepEqual((output.structuredContent?.route_contract as Record<string, unknown>)?.active_targets, [
    {
      target: "src/checkout.ts",
      source_memory_id: "mem-1",
      source: "should_continue",
      artifact_status: "may_be_absent",
      missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
    },
  ]);
  assert.equal((calls[0]?.input as { outcome?: string }).outcome, "unknown");
  assert.equal((calls[1]?.input as { context_mode?: string }).context_mode, "compact_agent");
  assert.equal((calls[1]?.input as { context_char_budget?: number }).context_char_budget, 3000);
});

test("@aionis/mcp preserves cross-agent continuity through shared scope", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const client = fakeClient(calls);
  const sharedScope = "git:checkout-service:abc123def456";

  await handleAionisMcpTool(client, "aionis_record_step", {
    run_id: "run-multi-agent",
    task_signature: "checkout-migration",
    scope: sharedScope,
    role: "planner",
    title: "Planner accepted scoped checkout route",
    summary: "Plan asset says continue packages/api/src/checkout.ts and avoid the broad legacy rewrite.",
    outcome: "succeeded",
    target_files: ["packages/api/src/checkout.ts"],
    acceptance_checks: ["unit tests pass", "no unrelated module changes"],
    feedback: false,
  });

  await handleAionisMcpTool(client, "aionis_context", {
    run_id: "run-multi-agent",
    task_signature: "checkout-migration",
    scope: sharedScope,
    role: "worker",
    query_text: "Continue implementation from the accepted plan.",
  });

  await handleAionisMcpTool(client, "aionis_record_step", {
    run_id: "run-multi-agent",
    task_signature: "checkout-migration",
    scope: sharedScope,
    role: "verifier",
    title: "Verifier rejected broad rewrite",
    summary: "The broad rewrite touched unrelated modules and must stay blocked.",
    outcome: "failed",
    target_files: ["packages/api/src/legacy.ts"],
    feedback: false,
  });

  assert.deepEqual(calls.map((call) => call.method), ["observeOutcome", "guideForRole", "observeOutcome"]);
  assert.equal((calls[0]?.input as { role?: string; scope?: string }).role, "planner");
  assert.equal((calls[1]?.input as { role?: string; scope?: string }).role, "worker");
  assert.equal((calls[2]?.input as { role?: string; scope?: string }).role, "verifier");
  assert.equal((calls[0]?.input as { scope?: string }).scope, sharedScope);
  assert.equal((calls[1]?.input as { scope?: string }).scope, sharedScope);
  assert.equal((calls[2]?.input as { scope?: string }).scope, sharedScope);
});

test("@aionis/mcp governs external memory through Memory Firewall mode", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const output = await handleAionisMcpTool(fakeClient(calls), "aionis_govern_memory", {
    tenant_id: "tenant-a",
    scope: "repo-a",
    query_text: "Continue without failed external memory.",
    mode: "firewall",
    include_records: true,
    candidates: [
      {
        external_memory_id: "mem0:current",
        source_backend: "mem0",
        text: "Current state.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "current",
      },
      {
        external_memory_id: "zep:failed",
        source_backend: "zep",
        text: "Failed branch.",
        lifecycle_hint: "failed",
      },
    ],
  });

  assert.deepEqual(calls.map((call) => call.method), ["governMemory"]);
  assert.equal((calls[0]?.input as { query_text?: string }).query_text, "Continue without failed external memory.");
  assert.equal((calls[0]?.input as { mode?: string }).mode, "firewall");
  assert.deepEqual(calls[0]?.options, { tenant_id: "tenant-a", scope: "repo-a" });
  assert.equal((output.structuredContent?.memory_firewall as Record<string, unknown>)?.contract_version, "aionis_memory_firewall_summary_v1");
  assert.equal((output.structuredContent?.agent_context as { do_not_use_memory_ids?: string[] })?.do_not_use_memory_ids?.[0], "zep:failed");
});

test("@aionis/mcp replays Agent decision through Flight Recorder", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const output = await handleAionisMcpTool(fakeClient(calls), "aionis_flight_recorder", {
    tenant_id: "tenant-a",
    scope: "repo-a",
    run_id: "run-1",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      use_now_memory_ids: ["mem-current"],
    },
  });

  assert.deepEqual(calls.map((call) => call.method), ["flightRecorder"]);
  assert.equal((calls[0]?.input as { run_id?: string }).run_id, "run-1");
  assert.deepEqual(calls[0]?.options, { tenant_id: "tenant-a", scope: "repo-a" });
  assert.equal((output.structuredContent?.agent_flight_recorder as Record<string, unknown>)?.contract_version, "aionis_agent_flight_recorder_report_v1");
});

test("@aionis/mcp record step stays useful without feedback attribution", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const output = await handleAionisMcpTool(fakeClient(calls), "aionis_record_step", {
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Verifier rejected broad rewrite",
    summary: "The broad rewrite branch failed review and should not be reused.",
    outcome: "failed",
    target_files: ["src/checkout.ts"],
  });

  assert.deepEqual(calls.map((call) => call.method), ["observeOutcome"]);
  assert.equal((calls[0]?.input as { feedback?: boolean }).feedback, false);
  assert.equal(output.structuredContent?.feedback_required, false);
});

test("@aionis/mcp ordinary remember passes scoped options through SDK", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const output = await handleAionisMcpTool(fakeClient(calls), "aionis_remember", {
    text: "The checkout migration uses the v4 adapter boundary.",
    kind: "project_context",
    tenant_id: "tenant-a",
    scope: "repo-a",
  });

  assert.deepEqual(calls.map((call) => call.method), ["remember"]);
  assert.equal((calls[0]?.input as { text?: string }).text, "The checkout migration uses the v4 adapter boundary.");
  assert.deepEqual(calls[0]?.options, { tenant_id: "tenant-a", scope: "repo-a" });
  assert.equal(output.structuredContent?.ok, true);
});

test("@aionis/mcp speaks MCP listTools and callTool over transport", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const server = createAionisMcpServer(fakeClient(calls));
  const client = new Client({ name: "aionis-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "aionis_context"));

    const response = await client.callTool({
      name: "aionis_context",
      arguments: {
        run_id: "run-transport",
        task_signature: "checkout-migration",
        query_text: "Continue safely.",
      },
    });
    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /AIONIS_EXECUTION_AGENT_CONTEXT v1/);
    assert.deepEqual(calls.map((call) => call.method), ["guideForRole"]);
  } finally {
    await client.close();
    await server.close();
  }
});
