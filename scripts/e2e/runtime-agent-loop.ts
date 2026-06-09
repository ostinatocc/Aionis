#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";

type RuntimeHandle = {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  tmpDir: string;
  logs: string[];
};

type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: "deepseek" | "openrouter" | "custom";
  maxTokens: number;
};

type EmbeddingConfig = {
  provider: "minimax" | "openai";
};

type AgentDecision = {
  choice: "formula_a" | "formula_b" | "unknown";
  used_aionis: boolean;
  avoided_failed_branch?: boolean;
  rationale?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireLlmConfig(): LlmConfig {
  const customKey = process.env.AIONIS_AGENT_E2E_API_KEY?.trim();
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const apiKey = customKey || deepseekKey || openrouterKey || "";
  if (!apiKey) {
    throw new Error(
      "runtime-agent-loop requires a real LLM API key. Set AIONIS_AGENT_E2E_API_KEY, DEEPSEEK_API_KEY, or OPENROUTER_API_KEY.",
    );
  }

  const provider: LlmConfig["provider"] = customKey
    ? "custom"
    : deepseekKey
      ? "deepseek"
      : openrouterKey
        ? "openrouter"
        : "custom";
  const baseUrl =
    process.env.AIONIS_AGENT_E2E_BASE_URL?.trim()
    || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.deepseek.com");
  const model =
    process.env.AIONIS_AGENT_E2E_MODEL?.trim()
    || (provider === "openrouter" ? "deepseek/deepseek-chat" : "deepseek-v4-flash");
  const configuredMaxTokens = Number(process.env.AIONIS_AGENT_E2E_MAX_TOKENS ?? "");
  const maxTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
    ? Math.trunc(configuredMaxTokens)
    : 800;
  return { apiKey, baseUrl, model, provider, maxTokens };
}

function requireEmbeddingConfig(): EmbeddingConfig {
  const explicit = process.env.AIONIS_AGENT_E2E_EMBEDDING_PROVIDER?.trim() || process.env.EMBEDDING_PROVIDER?.trim();
  const provider = explicit || (process.env.MINIMAX_API_KEY?.trim() ? "minimax" : process.env.OPENAI_API_KEY?.trim() ? "openai" : "");
  if (provider !== "minimax" && provider !== "openai") {
    throw new Error(
      "runtime-agent-loop requires a real embedding provider for /v1/guide. Set MINIMAX_API_KEY, OPENAI_API_KEY, or EMBEDDING_PROVIDER=minimax|openai with the matching key.",
    );
  }
  if (provider === "minimax" && !process.env.MINIMAX_API_KEY?.trim()) {
    throw new Error("runtime-agent-loop requires MINIMAX_API_KEY when using EMBEDDING_PROVIDER=minimax.");
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("runtime-agent-loop requires OPENAI_API_KEY when using EMBEDDING_PROVIDER=openai.");
  }
  return { provider };
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

async function startRuntime(embedding: EmbeddingConfig): Promise<RuntimeHandle> {
  const port = await findFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-runtime-agent-e2e-"));
  const logs: string[] = [];
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      AIONIS_LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_BYPASS_LOOPBACK: "true",
      LITE_LOCAL_ACTOR_ID: "local-user",
      LITE_WRITE_SQLITE_PATH: path.join(tmpDir, "write.sqlite"),
      LITE_REPLAY_SQLITE_PATH: path.join(tmpDir, "replay.sqlite"),
      EMBEDDING_PROVIDER: embedding.provider,
      SANDBOX_ENABLED: "false",
      SANDBOX_ADMIN_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });
  child.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });
  child.on("exit", (code, signal) => {
    logs.push(`runtime exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, child, tmpDir, logs };
    } catch {
      // wait for startup
    }
    await sleep(250);
  }
  stopRuntime({ baseUrl, child, tmpDir, logs });
  throw new Error(`Aionis Runtime did not become healthy.\n${logs.join("").slice(-4_000)}`);
}

function stopRuntime(handle: RuntimeHandle): void {
  if (handle.child.exitCode === null) handle.child.kill("SIGTERM");
}

async function postJson(baseUrl: string, pathName: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${pathName} failed with ${res.status}: ${JSON.stringify(parsed)}`);
  }
  const record = asRecord(parsed);
  if (!record) throw new Error(`${pathName} returned non-object JSON: ${text}`);
  return record;
}

function runtimeTreeOperation(
  tree: ExecutionTreeV1,
  operation: Record<string, unknown>,
): ExecutionTreeOperationV1 {
  return {
    tree_id: tree.tree_id,
    scope: tree.scope,
    ...operation,
  } as ExecutionTreeOperationV1;
}

function buildRuntimeTreeFixture(runId: string): {
  baseTree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
  expectedTree: ExecutionTreeV1;
} {
  const baseTree = createExecutionTreeV1({
    tree_id: `tree-runtime-agent-e2e-${runId}`,
    scope: `aionis://execution-tree/runtime-agent-e2e/${runId}`,
    task_brief: "Real Agent should continue the verified formula branch and avoid the failed branch.",
    at: "2026-06-09T00:00:00.000Z",
  });
  const operations: ExecutionTreeOperationV1[] = [];
  let expectedTree = baseTree;
  const add = (operation: Record<string, unknown>) => {
    const fullOperation = runtimeTreeOperation(baseTree, operation);
    operations.push(fullOperation);
    expectedTree = applyExecutionTreeOperationV1(expectedTree, fullOperation);
  };

  add({
    type: "grow",
    operation_id: `${runId}:grow-failed-formula-a`,
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: "Try RUNTIME_AGENT_E2E_FAILED formula_a with duplicated tax.",
    observation: "RUNTIME_AGENT_E2E_FAILED formula_a failed verifier row 2 because tax was double-counted.",
    title: "Failed formula A",
    refs: [`trace://runtime-agent-e2e/${runId}/formula-a/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-failed-formula-a`,
    actor_role: "worker",
    at: "2026-06-09T00:02:00.000Z",
    title: "RUNTIME_AGENT_E2E_FAILED formula_a rejected",
    summary: "RUNTIME_AGENT_E2E_FAILED formula_a double-counts tax and must not be reused.",
  });
  const failedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!failedSummaryNodeId) throw new Error("failed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:maintain-failed-formula-a`,
    actor_role: "verifier",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "RUNTIME_AGENT_E2E_FAILED verifier rejected formula_a.",
  });
  add({
    type: "revise",
    operation_id: `${runId}:revise-failed-formula-a`,
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "Abandon formula_a and resume from a clean branch.",
  });
  add({
    type: "grow",
    operation_id: `${runId}:grow-passed-formula-b`,
    actor_role: "worker",
    at: "2026-06-09T00:05:00.000Z",
    action: "Use RUNTIME_AGENT_E2E_PASSED formula_b after removing duplicated tax.",
    observation: "RUNTIME_AGENT_E2E_PASSED formula_b matched all verifier rows.",
    title: "Passed formula B",
    refs: [`trace://runtime-agent-e2e/${runId}/formula-b/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-passed-formula-b`,
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    title: "RUNTIME_AGENT_E2E_PASSED formula_b accepted",
    summary: "RUNTIME_AGENT_E2E_PASSED formula_b computes subtotal + single tax + shipping.",
  });
  const passedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!passedSummaryNodeId) throw new Error("passed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:maintain-passed-formula-b`,
    actor_role: "verifier",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });

  return { baseTree, operations, expectedTree };
}

function extractChatCompletionText(payload: unknown): string | null {
  const root = asRecord(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const fragments = content
      .map((item) => {
        const record = asRecord(item);
        return typeof record?.text === "string" ? record.text : "";
      })
      .filter((text) => text.length > 0);
    if (fragments.length > 0) return fragments.join("\n");
  }
  return null;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    // continue
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return asRecord(JSON.parse(fenced[1].trim()));
    } catch {
      // continue
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return asRecord(JSON.parse(trimmed.slice(first, last + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

function parseAgentDecision(value: unknown): AgentDecision {
  const record = asRecord(value);
  const rawChoice = typeof record?.choice === "string" ? record.choice.trim().toLowerCase() : "";
  const choice =
    rawChoice === "formula_b" || rawChoice === "b"
      ? "formula_b"
      : rawChoice === "formula_a" || rawChoice === "a"
        ? "formula_a"
        : "unknown";
  return {
    choice,
    used_aionis: record?.used_aionis === true,
    avoided_failed_branch: typeof record?.avoided_failed_branch === "boolean" ? record.avoided_failed_branch : undefined,
    rationale: typeof record?.rationale === "string" ? record.rationale.slice(0, 800) : undefined,
  };
}

async function callAgentLlm(args: {
  config: LlmConfig;
  agentContext: Record<string, unknown>;
}): Promise<{ decision: AgentDecision; rawText: string; usage: unknown }> {
  const baseUrl = args.config.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.config.apiKey}`,
      ...(args.config.provider === "openrouter" ? {
        "HTTP-Referer": "https://github.com/ostinatocc/Aionis",
        "X-Title": "Aionis Runtime Agent E2E",
      } : {}),
    },
    body: JSON.stringify({
      model: args.config.model,
      temperature: 0,
      max_tokens: args.config.maxTokens,
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "You are a real agent in an Aionis Runtime e2e validation.",
            "Use AIONIS_AGENT_CONTEXT as execution-state evidence.",
            "Return only compact JSON with keys: choice, used_aionis, avoided_failed_branch, rationale.",
            "Allowed choice values are formula_a, formula_b, or unknown.",
            "Keep rationale under 120 characters.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Choose the next formula to execute for a verifier. formula_a previously failed; formula_b previously passed if Aionis context says so.",
            aionis_agent_context: args.agentContext,
            expected_behavior: "Prefer the passed solution from use_now and avoid failed branches from do_not_use.",
          }, null, 2),
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`LLM call failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  const rawText = extractChatCompletionText(payload);
  if (!rawText) throw new Error(`LLM response did not contain assistant text: ${JSON.stringify(payload)}`);
  const parsed = extractJsonObject(rawText);
  if (!parsed) throw new Error(`LLM response was not parseable JSON: ${rawText}`);
  return {
    decision: parseAgentDecision(parsed),
    rawText,
    usage: asRecord(payload)?.usage ?? null,
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const llm = requireLlmConfig();
  const embedding = requireEmbeddingConfig();
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const runtime = await startRuntime(embedding);
  try {
    const { baseTree, operations, expectedTree } = buildRuntimeTreeFixture(runId);
    const handoffPayload = {
      memory_lane: "private",
      anchor: `runtime-agent-e2e:${runId}`,
      file_path: "scripts/e2e/runtime-agent-loop.ts",
      repo_root: repoRoot,
      handoff_kind: "patch_handoff",
      task_signature: `runtime-agent-e2e:${runId}`,
      title: "Runtime Agent e2e handoff",
      summary: "Continue from formula_b and avoid formula_a.",
      handoff_text: "Recover the latest execution tree before choosing the next formula.",
      target_files: ["scripts/e2e/runtime-agent-loop.ts"],
      next_action: "Choose formula_b; do not repeat formula_a.",
      execution_tree_disabled: true,
      execution_tree_v1: baseTree,
      execution_tree_operations_v1: operations,
    };

    const observed = await postJson(runtime.baseUrl, "/v1/observe", {
      tenant_id: "default",
      scope: "default",
      handoff: handoffPayload,
    });
    const observedTree = asRecord(asRecord(observed.handoff)?.execution_tree_v1);
    assertCondition(observedTree?.current_summary_node_id === expectedTree.current_summary_node_id, "observe response did not expose latest operation-applied tree");

    const recovered = await postJson(runtime.baseUrl, "/v1/handoff/recover", {
      tenant_id: "default",
      scope: "default",
      consumer_agent_id: "local-user",
      handoff_kind: "patch_handoff",
      anchor: handoffPayload.anchor,
      repo_root: handoffPayload.repo_root,
      file_path: handoffPayload.file_path,
    });
    const recoveredTree = asRecord(recovered.execution_tree_v1);
    assertCondition(recoveredTree?.current_summary_node_id === expectedTree.current_summary_node_id, "recover did not return latest execution tree");

    const guide = await postJson(runtime.baseUrl, "/v1/guide", {
      tenant_id: "default",
      scope: "default",
      query_text: "choose the next formula from the verified execution branch",
      context: {
        goal: "choose the formula that should pass the verifier without repeating failed branches",
      },
      consumer_agent_id: "local-user",
      execution_tree_v1: recovered.execution_tree_v1,
      include_packets: true,
      limit: 8,
    });
    const agentContext = asRecord(guide.agent_context);
    assertCondition(agentContext?.history_used === true, "guide did not produce history-aware agent context");
    assertCondition(JSON.stringify(agentContext.use_now).includes("RUNTIME_AGENT_E2E_PASSED"), "agent context missing passed solution in use_now");
    assertCondition(JSON.stringify(agentContext.do_not_use).includes("RUNTIME_AGENT_E2E_FAILED"), "agent context missing failed branch in do_not_use");

    const llmResult = await callAgentLlm({
      config: llm,
      agentContext: agentContext as Record<string, unknown>,
    });
    assertCondition(llmResult.decision.choice === "formula_b", `agent chose ${llmResult.decision.choice}, expected formula_b`);

    const outcomeObserve = await postJson(runtime.baseUrl, "/v1/observe", {
      tenant_id: "default",
      scope: "default",
      input_text: "Real LLM Agent selected formula_b after reading Aionis Agent Context.",
      execution: {
        client_id: `runtime-agent-e2e-outcome:${runId}`,
        run_id: runId,
        task_family: "runtime-agent-e2e",
        task_signature: `runtime-agent-e2e-outcome:${runId}`,
        workflow_signature: "runtime-agent-e2e-formula-selection",
        title: "RUNTIME_AGENT_E2E_LLM_CHOICE formula_b",
        summary: "RUNTIME_AGENT_E2E_LLM_CHOICE formula_b passed because the Agent reused Aionis passed execution evidence.",
        outcome: "succeeded",
        workflow_steps: [
          "Read AIONIS_AGENT_CONTEXT",
          "Use passed formula_b from use_now",
          "Avoid failed formula_a from do_not_use",
        ],
        acceptance_checks: ["verifier accepts formula_b", "verifier rejects formula_a"],
        continuation_hint: "Reuse formula_b and avoid formula_a.",
        confidence: 0.9,
        raw_ref: `trace://runtime-agent-e2e/${runId}/llm-choice`,
        evidence_ref: `evidence://runtime-agent-e2e/${runId}/verifier`,
        verification: {
          choice: llmResult.decision.choice,
          passed: true,
          verifier: "formula_b accepted",
        },
        slots: {
          task_signature: `runtime-agent-e2e-outcome:${runId}`,
          execution_result_summary: {
            status: "passed",
            summary: "RUNTIME_AGENT_E2E_LLM_CHOICE formula_b passed after using Aionis execution evidence.",
            evidence_refs: [`evidence://runtime-agent-e2e/${runId}/verifier`],
          },
        },
      },
    });
    assertCondition(asRecord(outcomeObserve.observed)?.memory_written === true, "outcome observe did not write execution memory");

    const assembled = await postJson(runtime.baseUrl, "/v1/execution/context/assemble", {
      tenant_id: "default",
      scope: "default",
      memory_filters: [
        {
          slots_contains: { task_signature: `runtime-agent-e2e-outcome:${runId}` },
          limit: 10,
        },
      ],
    });
    assertCondition(JSON.stringify(assembled.passed_solutions).includes("RUNTIME_AGENT_E2E_LLM_CHOICE"), "observed LLM outcome was not promoted as evidence-backed passed solution");
    assertCondition(asRecord(assembled.selection_trace)?.evidence_backed_passed_solution_count === 1, "observed outcome was not counted as evidence-backed passed solution");

    const result = {
      contract_version: "aionis_runtime_agent_e2e_result_v1",
      run_id: runId,
      runtime: {
        base_url: runtime.baseUrl,
        temp_db_dir: runtime.tmpDir,
      },
      llm: {
        provider: llm.provider,
        base_url: llm.baseUrl,
        model: llm.model,
        usage: llmResult.usage,
      },
      embedding: {
        provider: embedding.provider,
      },
      guide: {
        history_used: agentContext.history_used,
        authority: agentContext.authority,
        use_now_count: Array.isArray(agentContext.use_now) ? agentContext.use_now.length : 0,
        do_not_use_count: Array.isArray(agentContext.do_not_use) ? agentContext.do_not_use.length : 0,
        prompt_chars: typeof agentContext.prompt_text === "string" ? agentContext.prompt_text.length : 0,
      },
      agent_decision: llmResult.decision,
      checks: {
        observe_latest_tree: true,
        recover_latest_tree: true,
        guide_passed_solution_visible: true,
        guide_failed_branch_visible: true,
        real_llm_chose_passed_branch: true,
        observe_outcome_promoted_with_raw_evidence: true,
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    stopRuntime(runtime);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
