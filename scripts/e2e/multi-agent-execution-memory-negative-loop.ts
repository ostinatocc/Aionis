#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  requireEmbeddingConfig,
  startRuntime,
  stopRuntime,
  type EmbeddingConfig,
  type RuntimeHandle,
} from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type RuntimeSession = {
  baseUrl: string;
  mode: "external" | "spawned";
  embedding: EmbeddingConfig | null;
  handle: RuntimeHandle | null;
};

const TEAM_ALPHA = "multi-agent-negative-alpha";
const TEAM_BETA = "multi-agent-negative-beta";
const PLANNER_ID = "negative-planner-agent";
const REVIEWER_ALPHA_ID = "negative-reviewer-alpha";
const REVIEWER_BETA_ID = "negative-reviewer-beta";
const COMMON_MARKER = "MULTI_AGENT_NEG_VIS_COMMON";
const GLOBAL_MARKER = "MULTI_AGENT_NEG_GLOBAL_SHARED";
const ALPHA_SHARED_MARKER = "MULTI_AGENT_NEG_ALPHA_SHARED";
const BETA_SHARED_MARKER = "MULTI_AGENT_NEG_BETA_SHARED";
const PLANNER_PRIVATE_MARKER = "MULTI_AGENT_NEG_PLANNER_PRIVATE";
const PASSED_MARKER = "MULTI_AGENT_NEG_PASSED_BRANCH";
const FAILED_MARKER = "MULTI_AGENT_NEG_FAILED_BRANCH";

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

function buildBranchSplitTree(runId: string): ExecutionTreeV1 {
  const tree = createExecutionTreeV1({
    tree_id: `tree-negative-${runId}`,
    scope: `aionis://execution-tree/multi-agent-negative/${runId}`,
    task_brief: "Negative control tree with one failed branch and one active passed branch.",
    at: "2026-06-09T00:00:00.000Z",
  });
  let current = tree;
  const add = (operation: Record<string, unknown>) => {
    current = applyExecutionTreeOperationV1(current, runtimeTreeOperation(tree, operation));
  };

  add({
    type: "grow",
    operation_id: `${runId}:failed-grow`,
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: `Try ${FAILED_MARKER} broad retry.`,
    observation: `${FAILED_MARKER} broad retry failed verifier checks and must not be reused.`,
    title: `${FAILED_MARKER} rejected branch`,
  });
  add({
    type: "compress",
    operation_id: `${runId}:failed-compress`,
    actor_role: "worker",
    at: "2026-06-09T00:02:00.000Z",
    title: `${FAILED_MARKER} rejected summary`,
    summary: `${FAILED_MARKER} is counter-evidence.`,
  });
  const failedSummaryId = current.current_summary_node_id;
  assertCondition(!!failedSummaryId, "failed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:failed-maintain`,
    actor_role: "verifier",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryId,
    diagnostic_note: `${FAILED_MARKER} failed replay.`,
  });
  add({
    type: "revise",
    operation_id: `${runId}:revise`,
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: failedSummaryId,
    diagnostic_note: "Resume from the previous safe boundary.",
  });
  add({
    type: "grow",
    operation_id: `${runId}:passed-grow`,
    actor_role: "worker",
    at: "2026-06-09T00:05:00.000Z",
    action: `Use ${PASSED_MARKER} scoped fix.`,
    observation: `${PASSED_MARKER} scoped fix passed verifier replay.`,
    title: `${PASSED_MARKER} accepted branch`,
  });
  add({
    type: "compress",
    operation_id: `${runId}:passed-compress`,
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    title: `${PASSED_MARKER} accepted summary`,
    summary: `${PASSED_MARKER} is the only active continuation.`,
  });
  const passedSummaryId = current.current_summary_node_id;
  assertCondition(!!passedSummaryId, "passed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:passed-maintain`,
    actor_role: "verifier",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryId,
    diagnostic_note: null,
  });
  return current;
}

async function openRuntime(): Promise<RuntimeSession> {
  const externalBaseUrl = (
    process.env.AIONIS_MULTI_AGENT_NEGATIVE_E2E_BASE_URL
    || process.env.AIONIS_MULTI_AGENT_E2E_BASE_URL
    || process.env.AIONIS_PRODUCT_E2E_BASE_URL
    || process.env.AIONIS_BASE_URL
    || process.env.AIONIS_URL
    || ""
  ).trim();
  if (externalBaseUrl) {
    return {
      baseUrl: externalBaseUrl.replace(/\/+$/, ""),
      mode: "external",
      embedding: null,
      handle: null,
    };
  }

  const embedding = requireEmbeddingConfig();
  const handle = await startRuntime(embedding);
  return {
    baseUrl: handle.baseUrl,
    mode: "spawned",
    embedding,
    handle,
  };
}

function closeRuntime(session: RuntimeSession): void {
  if (session.handle) stopRuntime(session.handle);
}

async function postRuntimeJson(args: {
  baseUrl: string;
  pathName: string;
  apiKey: string | null;
  payload: unknown;
  expectedStatus?: number;
}): Promise<Record<string, unknown>> {
  const res = await fetch(`${args.baseUrl}${args.pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(args.apiKey ? { authorization: `Bearer ${args.apiKey}` } : {}),
    },
    body: JSON.stringify(args.payload),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  const expected = args.expectedStatus ?? 200;
  if (res.status !== expected) {
    throw new Error(`${args.pathName} expected ${expected} got ${res.status}: ${JSON.stringify(parsed)}`);
  }
  const record = asRecord(parsed);
  assertCondition(record, `${args.pathName} returned non-object JSON`);
  return record;
}

function agentContext(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assertCondition(record?.contract_version === "aionis_agent_context_v1", `${label} did not return agent_context v1`);
  return record;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function bodyText(value: unknown): string {
  return JSON.stringify(value);
}

function firstNodeId(observeBody: Record<string, unknown>, label: string): string {
  const write = asRecord(observeBody.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes : [];
  const first = asRecord(nodes[0]);
  const id = first?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} observe did not return a node id`);
  return id;
}

async function runNegativeLoop(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  scope: string;
}) {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.scope,
  });
  await client.health();

  const globalSharedId = firstNodeId(await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "shared",
    input_text: `${COMMON_MARKER} ${GLOBAL_MARKER} scope-wide shared state.`,
    memory: {
      client_id: `memory:${args.runId}:global-shared`,
      type: "concept",
      tier: "warm",
      memory_kind: "general_memory",
      title: `${GLOBAL_MARKER} global shared`,
      text_summary: `${COMMON_MARKER} ${GLOBAL_MARKER} scope-wide shared state.`,
      confidence: 0.9,
    },
  }), "global shared");

  const alphaSharedId = firstNodeId(await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "shared",
    owner_team_id: TEAM_ALPHA,
    input_text: `${COMMON_MARKER} ${ALPHA_SHARED_MARKER} alpha team handoff state.`,
    memory: {
      client_id: `memory:${args.runId}:alpha-shared`,
      type: "concept",
      tier: "warm",
      memory_kind: "general_memory",
      title: `${ALPHA_SHARED_MARKER} alpha shared`,
      text_summary: `${COMMON_MARKER} ${ALPHA_SHARED_MARKER} alpha team handoff state.`,
      confidence: 0.9,
    },
  }), "alpha shared");

  const betaSharedId = firstNodeId(await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "shared",
    owner_team_id: TEAM_BETA,
    input_text: `${COMMON_MARKER} ${BETA_SHARED_MARKER} beta team handoff state.`,
    memory: {
      client_id: `memory:${args.runId}:beta-shared`,
      type: "concept",
      tier: "warm",
      memory_kind: "general_memory",
      title: `${BETA_SHARED_MARKER} beta shared`,
      text_summary: `${COMMON_MARKER} ${BETA_SHARED_MARKER} beta team handoff state.`,
      confidence: 0.9,
    },
  }), "beta shared");

  const plannerPrivateId = firstNodeId(await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "private",
    owner_agent_id: PLANNER_ID,
    input_text: `${COMMON_MARKER} ${PLANNER_PRIVATE_MARKER} planner-only scratch state.`,
    memory: {
      client_id: `memory:${args.runId}:planner-private`,
      type: "concept",
      tier: "warm",
      memory_kind: "general_memory",
      title: `${PLANNER_PRIVATE_MARKER} planner private`,
      text_summary: `${COMMON_MARKER} ${PLANNER_PRIVATE_MARKER} planner-only scratch state.`,
      confidence: 0.9,
    },
  }), "planner private");

  const alphaGuide = await client.guide<Record<string, unknown>>({
    query_text: `${COMMON_MARKER} handoff visibility`,
    agent_role: "reviewer",
    consumer_agent_id: REVIEWER_ALPHA_ID,
    consumer_team_id: TEAM_ALPHA,
    limit: 20,
    include_packets: true,
  });
  const alphaContext = agentContext(alphaGuide.agent_context, "alpha guide");
  const alphaIds = new Set(textArray(alphaContext.memory_ids));
  assertCondition(alphaIds.has(globalSharedId), "alpha guide did not see global shared memory");
  assertCondition(alphaIds.has(alphaSharedId), "alpha guide did not see alpha shared memory");
  assertCondition(!alphaIds.has(betaSharedId), "alpha guide leaked beta team memory id");
  assertCondition(!alphaIds.has(plannerPrivateId), "alpha guide leaked planner private memory id");
  assertCondition(!bodyText(alphaGuide).includes(BETA_SHARED_MARKER), "alpha guide leaked beta team marker");
  assertCondition(!bodyText(alphaGuide).includes(PLANNER_PRIVATE_MARKER), "alpha guide leaked planner private marker");

  const betaGuide = await client.guide<Record<string, unknown>>({
    query_text: `${COMMON_MARKER} handoff visibility`,
    agent_role: "reviewer",
    consumer_agent_id: REVIEWER_BETA_ID,
    consumer_team_id: TEAM_BETA,
    limit: 20,
    include_packets: true,
  });
  const betaContext = agentContext(betaGuide.agent_context, "beta guide");
  const betaIds = new Set(textArray(betaContext.memory_ids));
  assertCondition(betaIds.has(globalSharedId), "beta guide did not see global shared memory");
  assertCondition(betaIds.has(betaSharedId), "beta guide did not see beta shared memory");
  assertCondition(!betaIds.has(alphaSharedId), "beta guide leaked alpha team memory id");
  assertCondition(!betaIds.has(plannerPrivateId), "beta guide leaked planner private memory id");
  assertCondition(!bodyText(betaGuide).includes(ALPHA_SHARED_MARKER), "beta guide leaked alpha team marker");
  assertCondition(!bodyText(betaGuide).includes(PLANNER_PRIVATE_MARKER), "beta guide leaked planner private marker");

  const plannerGuide = await client.guide<Record<string, unknown>>({
    query_text: `${COMMON_MARKER} handoff visibility`,
    agent_role: "planner",
    consumer_agent_id: PLANNER_ID,
    limit: 20,
    include_packets: true,
  });
  const plannerContext = agentContext(plannerGuide.agent_context, "planner guide");
  const plannerIds = new Set(textArray(plannerContext.memory_ids));
  assertCondition(plannerIds.has(globalSharedId), "planner guide did not see global shared memory");
  assertCondition(plannerIds.has(plannerPrivateId), "planner guide did not see its private memory");
  assertCondition(!plannerIds.has(alphaSharedId), "planner guide without team leaked alpha shared memory id");
  assertCondition(!plannerIds.has(betaSharedId), "planner guide without team leaked beta shared memory id");

  const rejectedFeedback = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/forget",
    apiKey: args.apiKey,
    expectedStatus: 400,
    payload: {
      tenant_id: "default",
      scope: args.scope,
      actor: REVIEWER_ALPHA_ID,
      operation: "activate",
      target: "memory",
      guide_trace_id: String(alphaGuide.guide_trace_id),
      used_memory_ids: [betaSharedId],
      run_id: `run:${args.runId}:cross-team-reject`,
      outcome: "negative",
      used_surface: "use_now",
      verifier_status: "failed",
      tool_status: "unknown",
      activate: true,
      reason: "Negative e2e attempts to attribute a beta-team memory not exposed by the alpha guide.",
    },
  });
  assertCondition(rejectedFeedback.error === "guide_trace_used_memory_not_exposed", "cross-team attribution was not rejected");

  const branchTree = buildBranchSplitTree(args.runId);
  const executionGuide = await client.guide<Record<string, unknown>>({
    query_text: `${PASSED_MARKER} continue the verified branch and avoid ${FAILED_MARKER}`,
    agent_role: "reviewer",
    consumer_agent_id: REVIEWER_ALPHA_ID,
    consumer_team_id: TEAM_ALPHA,
    execution_tree_v1: branchTree,
    mode: "full_power",
    include_packets: true,
    context_char_budget: 4096,
  });
  const executionContext = agentContext(executionGuide.agent_context, "execution context");
  const executionUseNow = textArray(executionContext.use_now).join("\n");
  const executionDoNotUse = textArray(executionContext.do_not_use).join("\n");
  assertCondition(executionUseNow.includes(PASSED_MARKER), "execution context did not surface passed branch in use_now");
  assertCondition(!executionUseNow.includes(FAILED_MARKER), "execution context leaked failed branch into use_now");
  assertCondition(executionDoNotUse.includes(FAILED_MARKER), "execution context did not put failed branch in do_not_use");

  return {
    memory_ids: {
      global_shared: globalSharedId,
      alpha_shared: alphaSharedId,
      beta_shared: betaSharedId,
      planner_private: plannerPrivateId,
    },
    alpha_guide_memory_ids: Array.from(alphaIds),
    beta_guide_memory_ids: Array.from(betaIds),
    planner_guide_memory_ids: Array.from(plannerIds),
    rejected_cross_team_feedback: rejectedFeedback.error,
    execution_use_now_count: textArray(executionContext.use_now).length,
    execution_do_not_use_count: textArray(executionContext.do_not_use).length,
  };
}

async function main() {
  const runId = `multi-agent-negative-${randomUUID().slice(0, 8)}`;
  const scope = `multi-agent-execution-memory-negative-e2e:${runId}`;
  const apiKey = process.env.AIONIS_MULTI_AGENT_NEGATIVE_E2E_API_KEY?.trim()
    || process.env.AIONIS_MULTI_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
  const session = await openRuntime();
  try {
    const negativeLoop = await runNegativeLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_multi_agent_execution_memory_negative_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      teams: {
        alpha: TEAM_ALPHA,
        beta: TEAM_BETA,
      },
      negative_loop: negativeLoop,
      checks: {
        global_shared_visible: true,
        team_owned_shared_isolated: true,
        private_agent_memory_isolated: true,
        guide_trace_rejects_unexposed_cross_team_memory: true,
        failed_branch_not_in_use_now: true,
        failed_branch_in_do_not_use: true,
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
