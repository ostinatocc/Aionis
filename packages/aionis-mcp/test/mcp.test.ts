import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseAionisMcpConfig } from "../src/config.ts";
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

test("@aionis/mcp exposes stable product tools", () => {
  assert.deepEqual(AIONIS_MCP_TOOL_NAMES, [
    "aionis_context",
    "aionis_record_step",
    "aionis_handoff",
    "aionis_remember",
    "aionis_measure",
    "aionis_snapshot",
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
  });

  assert.deepEqual(calls.map((call) => call.method), ["observeStep", "guideForRole"]);
  assert.match(output.content[0]?.text ?? "", /CURRENT_ACTIVE_PATH/);
  assert.equal(output.structuredContent?.drop_in_mode, true);
  assert.equal(output.structuredContent?.feedback_required, false);
  assert.deepEqual(output.structuredContent?.should_continue_memory_ids, ["mem-1"]);
  assert.deepEqual(output.structuredContent?.must_not_memory_ids, ["mem-failed"]);
  assert.deepEqual(output.structuredContent?.command_posture_memory_ids, ["mem-1", "mem-failed"]);
  assert.equal((calls[0]?.input as { outcome?: string }).outcome, "unknown");
  assert.equal((calls[1]?.input as { context_mode?: string }).context_mode, "compact_agent");
  assert.equal((calls[1]?.input as { context_char_budget?: number }).context_char_budget, 3000);
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
    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /CURRENT_ACTIVE_PATH/);
    assert.deepEqual(calls.map((call) => call.method), ["guideForRole"]);
  } finally {
    await client.close();
    await server.close();
  }
});
