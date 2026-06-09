#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionMemoryAdapter } from "../../src/adapters/execution-memory.ts";
import { createMultiAgentHostTemplate } from "../../src/adapters/host-integration.ts";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  repoRoot,
} from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";
import {
  FAILED_MARKER,
  PASSED_MARKER,
  PLAN_MARKER,
  PLANNER_ID,
  REVIEWER_ID,
  TEAM_ID,
  VERIFIER_ID,
  WORKER_ID,
  agentContext,
  assertPromptBoundary,
  buildMultiAgentExecutionTree,
  closeRuntime,
  firstNodeId,
  openRuntime,
  postRuntimeJson,
  textArray,
} from "./multi-agent-execution-memory-loop.ts";

const ORDINARY_MEMORY_MARKER = "MULTI_AGENT_FRESH_GENERAL_MEMORY";

function textBody(value: unknown): string {
  return JSON.stringify(value);
}

function textIncludesAny(value: unknown, markers: string[]): boolean {
  const text = textBody(value);
  return markers.some((marker) => text.includes(marker));
}

async function runFreshScopeNegativeLoop(args: {
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
  const adapter = createExecutionMemoryAdapter({
    client,
    tenant_id: "default",
    scope: args.scope,
    team_id: TEAM_ID,
    default_memory_lane: "shared",
    default_limit: 10,
    include_packets_by_default: true,
  });
  const host = createMultiAgentHostTemplate(adapter, {
    team_id: TEAM_ID,
    limit: 10,
    include_packets: true,
    mode: "full_power",
  });
  await client.health();

  const taskSignature = `multi-agent-host-template-fresh:${args.runId}`;
  const workflowSignature = "planner-worker-verifier-reviewer-fresh-scope";
  const neutralQuery = "recover current multi-agent execution state for this fresh scope";

  const beforeGuide = await host.reviewerGuide<Record<string, unknown>>({
    run_id: `run:${args.runId}:reviewer-before`,
    task_signature: taskSignature,
    task_family: "multi_agent_execution_memory",
    workflow_signature: workflowSignature,
    query_text: neutralQuery,
    agent_id: REVIEWER_ID,
    context: {
      reviewer_goal: "fresh-scope negative control before any execution writes",
    },
    limit: 8,
  });
  const beforeContext = agentContext(beforeGuide.agent_context, "fresh before reviewer guide");
  assertPromptBoundary(String(beforeContext.prompt_text), "fresh before reviewer guide");
  assertCondition(beforeGuide.state.last_use_now_memory_ids.length === 0, "fresh before guide exposed use_now memory ids");
  assertCondition(
    !textIncludesAny(beforeContext.use_now, [PASSED_MARKER, FAILED_MARKER, ORDINARY_MEMORY_MARKER]),
    "fresh before guide leaked execution or ordinary memory markers into use_now",
  );

  const ordinaryObserve = await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "shared",
    owner_team_id: TEAM_ID,
    input_text: `${ORDINARY_MEMORY_MARKER} ordinary team preference, not an execution branch.`,
    memory: {
      client_id: `memory:${args.runId}:ordinary-general`,
      type: "concept",
      tier: "warm",
      memory_kind: "general_memory",
      title: `${ORDINARY_MEMORY_MARKER} ordinary general memory`,
      text_summary: `${ORDINARY_MEMORY_MARKER} should stay outside execution branch context.`,
      confidence: 0.9,
    },
  });
  const ordinaryMemoryId = firstNodeId(ordinaryObserve, "fresh ordinary memory");

  const noTreeExecutionAssemble = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/execution/context/assemble",
    apiKey: args.apiKey,
    payload: {
      tenant_id: "default",
      scope: args.scope,
      consumer_agent_id: REVIEWER_ID,
      consumer_team_id: TEAM_ID,
      context_mode: "full_power",
      include_memory_evidence: false,
      include_prompt_text: true,
      include_agent_context: true,
      agent_context_char_budget: 4096,
    },
  });
  const noTreeExecutionContext = agentContext(noTreeExecutionAssemble.agent_context, "fresh no-tree execution context");
  assertPromptBoundary(String(noTreeExecutionContext.prompt_text), "fresh no-tree execution context");
  assertCondition(
    !textIncludesAny(noTreeExecutionContext.use_now, [ORDINARY_MEMORY_MARKER, PASSED_MARKER, FAILED_MARKER]),
    "ordinary memory polluted execution use_now before an execution tree existed",
  );
  assertCondition(
    !textIncludesAny(noTreeExecutionContext.do_not_use, [ORDINARY_MEMORY_MARKER, PASSED_MARKER, FAILED_MARKER]),
    "ordinary memory polluted execution do_not_use before an execution tree existed",
  );

  await host.plannerStart<Record<string, unknown>>({
    run_id: `run:${args.runId}:planner`,
    task_id: `task:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    agent_id: PLANNER_ID,
    title: `${PLAN_MARKER} fresh planner scoped target file`,
    summary: `${PLAN_MARKER} planner established a scoped target and verifier boundary.`,
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: ["Plan scoped target", "Reject broad failed branch", "Continue active branch"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["reviewer sees active path only after writes"],
    continuation_hint: `Reviewer should eventually continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    confidence: 0.9,
  });

  await host.workerStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:worker-failed`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: "fresh-worker-failed-broad-search",
    agent_id: WORKER_ID,
    title: `${FAILED_MARKER} fresh broad_search_patch failed`,
    summary: `${FAILED_MARKER} broad_search_patch changed the wrong target and failed verifier replay.`,
    outcome: "failed",
    target_files: ["src/multi-agent-e2e/wrong-target.ts"],
    verification: {
      verifier_agent_id: VERIFIER_ID,
      passed: false,
      reason: `${FAILED_MARKER} changed wrong target.`,
    },
  });

  await host.workerStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:worker-passed`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: "fresh-worker-passed-scoped-target",
    agent_id: WORKER_ID,
    title: `${PASSED_MARKER} fresh scoped_target_patch passed`,
    summary: `${PASSED_MARKER} scoped_target_patch edited the current target and passed verifier replay.`,
    outcome: "succeeded",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    verification: {
      verifier_agent_id: VERIFIER_ID,
      passed: true,
      reason: `${PASSED_MARKER} passed verifier replay.`,
    },
  });

  const { baseTree, operations, expectedTree } = buildMultiAgentExecutionTree(args.runId);
  const handoffObserve = await host.verifierStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:handoff`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    agent_id: VERIFIER_ID,
    title: "Fresh-scope multi-agent execution memory handoff",
    summary: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    handoff: {
      anchor: taskSignature,
      file_path: "scripts/e2e/multi-agent-host-template-fresh-scope-loop.ts",
      repo_root: repoRoot,
      handoff_kind: "task_handoff",
      task_signature: taskSignature,
      title: "Fresh-scope execution memory handoff",
      summary: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
      handoff_text: "Fresh-scope negative control: recover execution state only after writes.",
      target_files: ["src/multi-agent-e2e/current-target.ts"],
      next_action: `Continue ${PASSED_MARKER}; do not repeat ${FAILED_MARKER}.`,
      execution_tree_disabled: true,
      execution_tree_v1: baseTree,
      execution_tree_operations_v1: operations,
    },
  });
  const observedTree = asRecord(asRecord(handoffObserve.observe.handoff)?.execution_tree_v1);
  assertCondition(
    observedTree?.current_summary_node_id === expectedTree.current_summary_node_id,
    "fresh handoff did not expose the operation-applied execution tree",
  );

  const afterGuide = await host.reviewerGuide<Record<string, unknown>>({
    run_id: args.runId,
    task_signature: taskSignature,
    task_family: "multi_agent_execution_memory",
    workflow_signature: workflowSignature,
    query_text: neutralQuery,
    agent_id: REVIEWER_ID,
    context: {
      reviewer_goal: "fresh-scope reviewer should inherit active execution path only after writes",
    },
    tool_candidates: ["read", "edit", "test"],
    limit: 10,
  });
  const afterContext = agentContext(afterGuide.agent_context, "fresh after reviewer guide");
  assertPromptBoundary(String(afterContext.prompt_text), "fresh after reviewer guide");
  assertCondition(afterContext.history_used === true, "fresh after guide did not use execution history after writes");
  assertCondition(
    textIncludesAny(afterContext.use_now, [PASSED_MARKER]) || String(afterContext.prompt_text ?? "").includes(PASSED_MARKER),
    "fresh after guide did not surface passed branch after writes",
  );

  const treeExecutionAssemble = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/execution/context/assemble",
    apiKey: args.apiKey,
    payload: {
      tenant_id: "default",
      scope: args.scope,
      consumer_agent_id: REVIEWER_ID,
      consumer_team_id: TEAM_ID,
      execution_tree_v1: observedTree,
      context_mode: "full_power",
      include_memory_evidence: false,
      include_prompt_text: true,
      include_agent_context: true,
      agent_context_char_budget: 4096,
    },
  });
  const treeExecutionContext = agentContext(treeExecutionAssemble.agent_context, "fresh tree execution context");
  assertPromptBoundary(String(treeExecutionContext.prompt_text), "fresh tree execution context");
  const executionUseNow = textArray(treeExecutionContext.use_now).join("\n");
  const executionDoNotUse = textArray(treeExecutionContext.do_not_use).join("\n");
  assertCondition(executionUseNow.includes(PASSED_MARKER), "fresh execution context missing passed branch after writes");
  assertCondition(!executionUseNow.includes(FAILED_MARKER), "fresh execution context leaked failed branch into use_now");
  assertCondition(executionDoNotUse.includes(FAILED_MARKER), "fresh execution context missing failed branch in do_not_use");
  assertCondition(!textBody(treeExecutionContext).includes(ORDINARY_MEMORY_MARKER), "ordinary memory polluted tree execution context");

  return {
    before_history_used: beforeContext.history_used,
    before_use_now_count: textArray(beforeContext.use_now).length,
    before_use_now_memory_ids: beforeGuide.state.last_use_now_memory_ids,
    ordinary_memory_id: ordinaryMemoryId,
    no_tree_execution_use_now_count: textArray(noTreeExecutionContext.use_now).length,
    no_tree_execution_do_not_use_count: textArray(noTreeExecutionContext.do_not_use).length,
    after_history_used: afterContext.history_used,
    after_use_now_count: textArray(afterContext.use_now).length,
    tree_execution_use_now_count: textArray(treeExecutionContext.use_now).length,
    tree_execution_do_not_use_count: textArray(treeExecutionContext.do_not_use).length,
    ordinary_memory_polluted_execution_context: false,
    fresh_scope_negative_flow_used: true,
  };
}

async function main() {
  const runId = `multi-agent-host-fresh-${randomUUID().slice(0, 8)}`;
  const scope = `multi-agent-host-template-fresh-e2e:${runId}`;
  const apiKey = process.env.AIONIS_MULTI_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
  const session = await openRuntime();
  try {
    const freshScopeNegativeLoop = await runFreshScopeNegativeLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_multi_agent_host_template_fresh_scope_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      team: {
        team_id: TEAM_ID,
        roles: {
          planner: PLANNER_ID,
          worker: WORKER_ID,
          verifier: VERIFIER_ID,
          reviewer: REVIEWER_ID,
        },
      },
      fresh_scope_negative_loop: freshScopeNegativeLoop,
      checks: {
        fresh_before_guide_has_no_actionable_use_now: true,
        ordinary_memory_does_not_create_execution_context: true,
        reviewer_sees_execution_branch_only_after_writes: true,
        passed_branch_visible_after_writes: true,
        failed_branch_not_in_use_now: true,
        failed_branch_in_do_not_use: true,
        ordinary_memory_not_in_execution_branch_context: true,
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
