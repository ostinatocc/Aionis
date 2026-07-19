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
import {
  createExecutionMemoryAdapter,
  exposedUseNowMemoryIds,
} from "../../src/adapters/execution-memory.ts";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  repoRoot,
  requireEmbeddingConfig,
  startRuntime,
  stopRuntime,
  type EmbeddingConfig,
  type RuntimeHandle,
} from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

export type RuntimeSession = {
  baseUrl: string;
  mode: "external" | "spawned";
  embedding: EmbeddingConfig | null;
  handle: RuntimeHandle | null;
};

export type OpenRuntimeOptions = Readonly<{
  allowEmbeddingUnavailable?: boolean;
}>;

export type ReviewerDecision = {
  next_action: "continue_passed_branch" | "repeat_failed_branch" | "unknown";
  used_aionis: boolean;
  avoided_failed_branch: boolean;
  rationale: string;
};

export const TEAM_ID = "multi-agent-e2e-team";
export const PLANNER_ID = "planner-agent";
export const WORKER_ID = "worker-agent";
export const VERIFIER_ID = "verifier-agent";
export const REVIEWER_ID = "reviewer-agent";
export const PASSED_MARKER = "MULTI_AGENT_E2E_PASSED_BRANCH";
export const FAILED_MARKER = "MULTI_AGENT_E2E_FAILED_BRANCH";
export const PLAN_MARKER = "MULTI_AGENT_E2E_PLAN";

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

export function buildMultiAgentExecutionTree(runId: string): {
  baseTree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
  expectedTree: ExecutionTreeV1;
} {
  const baseTree = createExecutionTreeV1({
    tree_id: `tree-multi-agent-${runId}`,
    scope: `aionis://execution-tree/multi-agent/${runId}`,
    task_brief: "Planner, worker, verifier, and reviewer share branch-aware execution state.",
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
    operation_id: `${runId}:planner-plan`,
    actor_role: "planner",
    at: "2026-06-09T00:01:00.000Z",
    action: `${PLAN_MARKER} assign worker to inspect src/multi-agent-e2e/current-target.ts before broad discovery.`,
    observation: `${PLAN_MARKER} created scoped execution plan for the worker and verifier.`,
    title: "Planner scoped continuation plan",
    refs: [`trace://multi-agent/${runId}/planner-plan/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-planner-plan`,
    actor_role: "planner",
    at: "2026-06-09T00:02:00.000Z",
    title: `${PLAN_MARKER} scoped continuation plan`,
    summary: "Planner established current target file and verifier checks before worker execution.",
  });
  add({
    type: "grow",
    operation_id: `${runId}:worker-failed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:03:00.000Z",
    action: `Try ${FAILED_MARKER} broad_search_patch.`,
    observation: `${FAILED_MARKER} broad_search_patch changed the wrong target and failed verifier replay.`,
    title: "Worker failed broad search patch",
    refs: [`trace://multi-agent/${runId}/worker-failed/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-worker-failed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    title: `${FAILED_MARKER} broad_search_patch rejected`,
    summary: `${FAILED_MARKER} broad_search_patch is counter-evidence and must not be reused by reviewer.`,
  });
  const failedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!failedSummaryNodeId) throw new Error("failed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:verifier-failed-branch`,
    actor_role: "verifier",
    at: "2026-06-09T00:05:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: `Verifier rejected ${FAILED_MARKER} broad_search_patch.`,
  });
  add({
    type: "revise",
    operation_id: `${runId}:worker-revise-after-failure`,
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "Worker resumed from planner boundary instead of repeating broad_search_patch.",
  });
  add({
    type: "grow",
    operation_id: `${runId}:worker-passed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:07:00.000Z",
    action: `Use ${PASSED_MARKER} scoped_target_patch.`,
    observation: `${PASSED_MARKER} scoped_target_patch edited src/multi-agent-e2e/current-target.ts and passed verifier replay.`,
    title: "Worker passed scoped target patch",
    refs: [`trace://multi-agent/${runId}/worker-passed/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-worker-passed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:08:00.000Z",
    title: `${PASSED_MARKER} scoped_target_patch accepted`,
    summary: `${PASSED_MARKER} scoped_target_patch is the active continuation for reviewer handoff.`,
  });
  const passedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!passedSummaryNodeId) throw new Error("passed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:verifier-passed-branch`,
    actor_role: "verifier",
    at: "2026-06-09T00:09:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });

  return { baseTree, operations, expectedTree };
}

export async function openRuntime(options: OpenRuntimeOptions = {}): Promise<RuntimeSession> {
  const externalBaseUrl = (
    process.env.AIONIS_MULTI_AGENT_E2E_BASE_URL
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

  const embeddingProvider = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  const embedding = options.allowEmbeddingUnavailable === true && embeddingProvider === "none"
    ? null
    : requireEmbeddingConfig();
  const handle = await startRuntime(embedding);
  return {
    baseUrl: handle.baseUrl,
    mode: "spawned",
    embedding,
    handle,
  };
}

export function closeRuntime(session: RuntimeSession): void {
  if (session.handle) stopRuntime(session.handle);
}

export async function postRuntimeJson(args: {
  baseUrl: string;
  pathName: string;
  apiKey: string | null;
  payload: unknown;
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
  if (!res.ok) {
    throw new Error(`${args.pathName} failed with ${res.status}: ${JSON.stringify(parsed)}`);
  }
  const record = asRecord(parsed);
  assertCondition(record, `${args.pathName} returned non-object JSON`);
  return record;
}

export function agentContext(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assertCondition(record?.contract_version === "aionis_agent_context_v1", `${label} did not return agent_context v1`);
  assertCondition(typeof record.prompt_text === "string" && record.prompt_text.length > 0, `${label} agent_context missing prompt_text`);
  return record;
}

export function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "decision_reviews",
    "raw_memory_rows",
    "raw_slots",
    "RAW_EVIDENCE",
    "TRACE",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

export function assertReviewerPromptState(promptText: string, label: string): void {
  if (promptText.includes("AIONIS_CTX v2")) {
    assertCondition(/^state r=reviewer\b/m.test(promptText), `${label} prompt did not include reviewer v2 state`);
    assertCondition(
      /^next\b.*\b(?:actor_role|role)=reviewer\b/m.test(promptText),
      `${label} prompt did not include reviewer v2 next-action role`,
    );
    return;
  }
  assertCondition(promptText.includes("state: role=reviewer"), `${label} prompt did not include reviewer v1 state`);
  assertCondition(
    promptText.includes("role_focus: review branch status"),
    `${label} prompt did not include reviewer v1 focus`,
  );
}

export function firstNodeId(observeBody: Record<string, unknown>, label: string): string {
  const write = asRecord(observeBody.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes : [];
  const first = asRecord(nodes[0]);
  const id = first?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} observe did not return a node id`);
  return id;
}

export function simulateReviewer(args: {
  guideContext: Record<string, unknown>;
  executionContext: Record<string, unknown>;
}): ReviewerDecision {
  const guideText = [
    String(args.guideContext.prompt_text ?? ""),
    ...textArray(args.guideContext.use_now),
  ].join("\n");
  const executionUseNow = textArray(args.executionContext.use_now).join("\n");
  const executionDoNotUse = textArray(args.executionContext.do_not_use).join("\n");
  const hasPassed = guideText.includes(PASSED_MARKER) || executionUseNow.includes(PASSED_MARKER);
  const hasFailedAvoidance = executionDoNotUse.includes(FAILED_MARKER) || String(args.executionContext.prompt_text ?? "").includes(FAILED_MARKER);
  if (hasPassed && hasFailedAvoidance) {
    return {
      next_action: "continue_passed_branch",
      used_aionis: true,
      avoided_failed_branch: true,
      rationale: "Reviewer saw the active passed branch and failed branch counter-evidence.",
    };
  }
  if (String(args.executionContext.prompt_text ?? "").includes(FAILED_MARKER)) {
    return {
      next_action: "repeat_failed_branch",
      used_aionis: true,
      avoided_failed_branch: false,
      rationale: "Reviewer saw execution history but failed to separate branch authority.",
    };
  }
  return {
    next_action: "unknown",
    used_aionis: false,
    avoided_failed_branch: false,
    rationale: "Reviewer did not receive usable multi-agent execution memory.",
  };
}

async function runMultiAgentLoop(args: {
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
  await client.health();

  const queryText = `${PASSED_MARKER} reviewer continue active path and avoid ${FAILED_MARKER}`;
  const beforeGuide = await adapter.guideNext<Record<string, unknown>>({
    run_id: `run:${args.runId}:reviewer`,
    task_signature: `multi-agent:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    workflow_signature: "planner-worker-verifier-reviewer-handoff",
    query_text: queryText,
    agent_id: REVIEWER_ID,
    role: "reviewer",
    context: {
      reviewer_goal: "check whether any existing multi-agent branch state exists",
    },
    limit: 8,
  });
  const beforeContext = agentContext(beforeGuide.agent_context, "before reviewer guide");
  assertPromptBoundary(String(beforeContext.prompt_text), "before reviewer guide");

  const plannerObserve = await adapter.observeRunStart<Record<string, unknown>>({
    run_id: `run:${args.runId}:planner`,
    task_id: `task:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    task_signature: `multi-agent:${args.runId}`,
    workflow_signature: "planner-worker-verifier-reviewer-handoff",
    agent_id: PLANNER_ID,
    role: "planner",
    title: `${PLAN_MARKER} planner scoped target file`,
    summary: `${PLAN_MARKER} planner assigned worker to inspect src/multi-agent-e2e/current-target.ts and verifier to reject broad search regressions.`,
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: [
      "Planner identifies current target file",
      "Worker attempts scoped change",
      "Verifier marks failed and passed branches",
      "Reviewer inherits active path",
    ],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["reviewer continues passed branch", "reviewer avoids failed branch"],
    continuation_hint: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    confidence: 0.9,
    evidence: [{
      ref: `evidence://multi-agent/${args.runId}/planner-plan`,
      summary: "Planner produced scoped role handoff.",
    }],
  });
  const plannerMemoryId = firstNodeId(plannerObserve, "planner");

  const failedObserve = await adapter.observeStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:worker-failed`,
    task_family: "multi_agent_execution_memory",
    task_signature: `multi-agent:${args.runId}`,
    workflow_signature: "worker-failed-broad-search",
    agent_id: WORKER_ID,
    role: "worker",
    title: `${FAILED_MARKER} broad_search_patch failed`,
    summary: `${FAILED_MARKER} broad_search_patch modified the wrong target and failed verifier replay.`,
    outcome: "failed",
    target_files: ["src/multi-agent-e2e/wrong-target.ts"],
    workflow_steps: ["Broad search", "Patch wrong target", "Verifier replay failed"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier rejected broad_search_patch"],
    continuation_hint: `Do not repeat ${FAILED_MARKER}; resume from planner boundary.`,
    confidence: 0.4,
    raw_ref: `trace://multi-agent/${args.runId}/worker-failed`,
    evidence_ref: `evidence://multi-agent/${args.runId}/verifier-failed`,
    verification: {
      verifier_agent_id: VERIFIER_ID,
      passed: false,
      reason: `${FAILED_MARKER} changed wrong target.`,
    },
    slots: {
      execution_result_summary: {
        status: "failed",
        summary: `${FAILED_MARKER} broad_search_patch failed verifier replay.`,
        diagnostic_note: "Wrong target file; do not reuse.",
        evidence_refs: [`evidence://multi-agent/${args.runId}/verifier-failed`],
      },
    },
  });
  const failedMemoryId = firstNodeId(failedObserve, "failed worker");

  const passedObserve = await adapter.observeStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:worker-passed`,
    task_family: "multi_agent_execution_memory",
    task_signature: `multi-agent:${args.runId}`,
    workflow_signature: "worker-passed-scoped-target",
    agent_id: WORKER_ID,
    role: "worker",
    title: `${PASSED_MARKER} scoped_target_patch passed`,
    summary: `${PASSED_MARKER} scoped_target_patch edited src/multi-agent-e2e/current-target.ts and passed verifier replay.`,
    outcome: "succeeded",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: ["Read current target file", "Patch scoped target", "Verifier replay passed"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier accepted scoped_target_patch"],
    continuation_hint: `Reviewer should continue ${PASSED_MARKER} from src/multi-agent-e2e/current-target.ts.`,
    confidence: 0.93,
    raw_ref: `trace://multi-agent/${args.runId}/worker-passed`,
    evidence_ref: `evidence://multi-agent/${args.runId}/verifier-passed`,
    verification: {
      verifier_agent_id: VERIFIER_ID,
      passed: true,
      reason: `${PASSED_MARKER} passed verifier replay.`,
    },
    slots: {
      execution_result_summary: {
        status: "passed",
        summary: `${PASSED_MARKER} scoped_target_patch passed verifier replay with raw evidence.`,
        evidence_refs: [`evidence://multi-agent/${args.runId}/verifier-passed`],
      },
    },
  });
  const passedMemoryId = firstNodeId(passedObserve, "passed worker");

  const { baseTree, operations, expectedTree } = buildMultiAgentExecutionTree(args.runId);
  const handoffPayload = {
    memory_lane: "shared",
    producer_agent_id: VERIFIER_ID,
    owner_team_id: TEAM_ID,
    anchor: `multi-agent:${args.runId}`,
    file_path: "scripts/e2e/multi-agent-execution-memory-loop.ts",
    repo_root: repoRoot,
    handoff_kind: "task_handoff",
    task_signature: `multi-agent:${args.runId}`,
    title: "Multi-agent execution memory handoff",
    summary: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    handoff_text: "Recover planner, worker, verifier, and reviewer execution state before continuing.",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    next_action: `Continue ${PASSED_MARKER}; do not repeat ${FAILED_MARKER}.`,
    execution_tree_disabled: true,
    execution_tree_v1: baseTree,
    execution_tree_operations_v1: operations,
  };
  const handoffObserve = await adapter.observeStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:handoff`,
    task_family: "multi_agent_execution_memory",
    task_signature: `multi-agent:${args.runId}`,
    workflow_signature: "planner-worker-verifier-reviewer-handoff",
    agent_id: VERIFIER_ID,
    role: "verifier",
    title: "Multi-agent execution memory handoff",
    summary: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    handoff: handoffPayload,
  });
  const observedTree = asRecord(asRecord(handoffObserve.handoff)?.execution_tree_v1);
  assertCondition(
    observedTree?.current_summary_node_id === expectedTree.current_summary_node_id,
    "handoff observe did not expose latest multi-agent execution tree",
  );
  assertCondition(
    adapter.execution_tree_v1?.current_summary_node_id === expectedTree.current_summary_node_id,
    "adapter did not retain latest multi-agent execution tree",
  );

  const afterGuide = await adapter.guideNext<Record<string, unknown>>({
    run_id: args.runId,
    task_signature: `multi-agent:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    workflow_signature: "planner-worker-verifier-reviewer-handoff",
    query_text: queryText,
    agent_id: REVIEWER_ID,
    role: "reviewer",
    context: {
      reviewer_goal: "inherit active path, avoid failed branch, and record feedback attribution",
    },
    tool_candidates: ["read", "edit", "test"],
    limit: 10,
  });
  const reviewerContext = agentContext(afterGuide.agent_context, "after reviewer guide");
  assertPromptBoundary(String(reviewerContext.prompt_text), "after reviewer guide");
  const afterSourceMap = asRecord(afterGuide.source_map);
  assertCondition(
    Array.isArray(afterSourceMap?.internal_surfaces_used)
      && afterSourceMap.internal_surfaces_used.includes("full_power_execution_context"),
    "adapter reviewer guide did not use the full-power execution context service",
  );
  assertCondition(reviewerContext.agent_role === "reviewer", "reviewer guide did not preserve agent_role");
  assertReviewerPromptState(String(reviewerContext.prompt_text), "reviewer guide");
  assertCondition(reviewerContext.history_used === true, "reviewer guide did not use multi-agent history");
  assertCondition(
    textArray(reviewerContext.use_now).some((entry) => entry.includes(PASSED_MARKER))
      || String(reviewerContext.prompt_text).includes(PASSED_MARKER),
    "reviewer guide did not surface passed branch memory",
  );

  const executionContext = reviewerContext;
  assertPromptBoundary(String(executionContext.prompt_text), "reviewer execution context");
  assertCondition(
    textArray(executionContext.use_now).some((entry) => entry.includes(PASSED_MARKER)),
    "execution context missing passed branch in use_now",
  );
  assertCondition(
    textArray(executionContext.do_not_use).some((entry) => entry.includes(FAILED_MARKER)),
    "execution context missing failed branch in do_not_use",
  );
  const reviewerDecision = simulateReviewer({
    guideContext: reviewerContext,
    executionContext,
  });
  assertCondition(reviewerDecision.next_action === "continue_passed_branch", "reviewer did not continue the passed branch");
  assertCondition(reviewerDecision.avoided_failed_branch, "reviewer did not avoid the failed branch");

  const usedMemoryIds = textArray(reviewerContext.inspect_before_use_memory_ids);
  assertCondition(
    usedMemoryIds.includes(passedMemoryId),
    `reviewer guide did not expose passed memory for inspect-first attribution: expected=${passedMemoryId} inspect=${JSON.stringify(usedMemoryIds)}`,
  );
  const reviewerOutcomeResult = await adapter.observeOutcome<Record<string, unknown>, Record<string, unknown>>({
    run_id: args.runId,
    task_family: "multi_agent_execution_memory",
    task_signature: `multi-agent-reviewer:${args.runId}`,
    workflow_signature: "reviewer-continued-passed-branch",
    agent_id: REVIEWER_ID,
    role: "reviewer",
    title: "MULTI_AGENT_E2E_REVIEWER continued passed branch",
    summary: `Reviewer continued ${PASSED_MARKER}, avoided ${FAILED_MARKER}, and preserved branch status for the next Agent.`,
    outcome: "succeeded",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: ["Read agent_context", "Inspect branch split", "Continue passed branch"],
    acceptance_checks: ["continued passed branch", "did not repeat failed branch"],
    continuation_hint: `Future agents should continue ${PASSED_MARKER} and keep ${FAILED_MARKER} as counter-evidence.`,
    confidence: 0.91,
    raw_ref: `trace://multi-agent/${args.runId}/reviewer`,
    evidence_ref: `evidence://multi-agent/${args.runId}/reviewer-verifier`,
    verification: {
      next_action: reviewerDecision.next_action,
      avoided_failed_branch: reviewerDecision.avoided_failed_branch,
      passed: true,
    },
    slots: {
      execution_result_summary: {
        status: "passed",
        summary: "Reviewer used multi-agent execution memory correctly.",
        evidence_refs: [`evidence://multi-agent/${args.runId}/reviewer-verifier`],
      },
    },
    used_memory_ids: [passedMemoryId],
    used_surface: "explicit_host_assertion",
    guide_run_id: args.runId,
    runtime_signal_refs: [`evidence://multi-agent/${args.runId}/reviewer-verifier`],
    feedback_reason: "Reviewer used the passed worker branch successfully.",
  });
  const reviewerOutcome = reviewerOutcomeResult.observe;
  const reviewerMemoryId = firstNodeId(reviewerOutcome, "reviewer");

  const activateFeedback = reviewerOutcomeResult.feedback;
  assertCondition(activateFeedback, "adapter did not submit guide feedback for reviewer outcome");
  const feedbackEffect = asRecord(activateFeedback.forget_effect);
  assertCondition(feedbackEffect?.changed_count === 1, "activate feedback did not affect exactly one memory");

  const measure = await adapter.measureRun<Record<string, unknown>>({
    run_id: args.runId,
    task_id: `task:${args.runId}`,
    task_signature: `multi-agent:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    task: {
      run_id: `run:${args.runId}:reviewer`,
    },
    before_guide: beforeGuide,
    after_guide: afterGuide,
    forget_result: activateFeedback,
    evidence_ids: [
      `product_trace:multi-agent:${args.runId}`,
      `memory:${plannerMemoryId}`,
      `memory:${failedMemoryId}`,
      `memory:${passedMemoryId}`,
      `memory:${reviewerMemoryId}`,
    ],
  });
  const effectReport = asRecord(measure.effect_report);
  const historyImpact = asRecord(effectReport?.history_impact);
  const feedbackSummary = asRecord(effectReport?.feedback_signal_summary);
  assertCondition(measure.contract_version === "aionis_measure_result_v1", "measure did not return measure result v1");
  assertCondition(
    historyImpact?.impact_direction === "positive",
    `measure did not report positive multi-agent history impact: ${JSON.stringify(effectReport)}`,
  );
  assertCondition(historyImpact?.changed_future_behavior === true, "measure did not report changed future behavior");
  assertCondition(feedbackSummary?.present === true, "measure did not include guide feedback attribution summary");

  const operatorSnapshotResult = await client.operatorSnapshot<Record<string, unknown>>({
    run_id: args.runId,
    task_signature: `multi-agent:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    workflow_signature: "planner-worker-verifier-reviewer-handoff",
    agent_context: afterGuide.agent_context,
    guide_packet: afterGuide.guide_packet,
    memory_decision_trace: measure.memory_decision_trace,
    memory_decision_audit: measure.memory_decision_audit,
    effect_report: measure.effect_report,
    guide_trace_id: String(afterGuide.guide_trace_id ?? ""),
    include_markdown: true,
  });
  const operatorSnapshot = asRecord(operatorSnapshotResult.operator_snapshot);
  const operatorExecutionState = asRecord(operatorSnapshot.execution_state);
  const operatorBranchIsolation = asRecord(operatorExecutionState.branch_isolation);
  const operatorGuideTrace = asRecord(operatorSnapshot.guide_trace);
  const operatorEffect = asRecord(operatorSnapshot.effect);
  assertCondition(
    operatorSnapshotResult.contract_version === "aionis_operator_snapshot_result_v1",
    "operator snapshot did not return result v1",
  );
  assertCondition(
    operatorSnapshot.contract_version === "aionis_operator_snapshot_v1",
    "operator snapshot did not return snapshot v1",
  );
  assertCondition(operatorSnapshot.runtime_mutation === false, "operator snapshot must be read-only");
  assertCondition(operatorBranchIsolation.status === "pass", "operator snapshot did not prove branch isolation");
  assertCondition(
    operatorBranchIsolation.failed_branch_leaked_to_use_now === false,
    "operator snapshot reported failed branch leakage into use_now",
  );
  assertCondition(
    operatorGuideTrace.feedback_attribution_present === true,
    "operator snapshot did not expose guide feedback attribution",
  );
  assertCondition(
    operatorEffect.impact_direction === "positive",
    "operator snapshot did not carry positive effect measurement",
  );
  assertCondition(
    typeof operatorSnapshotResult.markdown === "string"
      && operatorSnapshotResult.markdown.includes("Aionis Operator Snapshot"),
    "operator snapshot markdown report missing",
  );

  return {
    before_history_used: beforeContext.history_used,
    reviewer_history_used: reviewerContext.history_used,
    reviewer_use_now_count: textArray(reviewerContext.use_now).length,
    reviewer_use_now_memory_ids: exposedUseNowMemoryIds(afterGuide),
    reviewer_inspect_before_use_memory_ids: usedMemoryIds,
    planner_memory_id: plannerMemoryId,
    failed_memory_id: failedMemoryId,
    passed_memory_id: passedMemoryId,
    reviewer_memory_id: reviewerMemoryId,
    execution_use_now_count: textArray(executionContext.use_now).length,
    execution_do_not_use_count: textArray(executionContext.do_not_use).length,
    reviewer_decision: reviewerDecision,
    feedback_changed_count: feedbackEffect.changed_count,
    measure_history_impact: historyImpact.impact_direction,
    feedback_summary_present: feedbackSummary.present,
    operator_snapshot_branch_isolation: operatorBranchIsolation.status,
    operator_snapshot_feedback_attribution_present: operatorGuideTrace.feedback_attribution_present,
    operator_snapshot_effect_impact: operatorEffect.impact_direction,
    adapter_flow_used: true,
  };
}

async function main() {
  const runId = `multi-agent-${randomUUID().slice(0, 8)}`;
  const scope = `multi-agent-execution-memory-e2e:${runId}`;
  const apiKey = process.env.AIONIS_MULTI_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
  const session = await openRuntime();
  try {
    const multiAgentLoop = await runMultiAgentLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_multi_agent_execution_memory_e2e_result_v1",
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
      multi_agent_loop: multiAgentLoop,
      checks: {
        planner_worker_verifier_reviewer_observed: true,
        reviewer_inherited_passed_branch: true,
        reviewer_avoided_failed_branch: true,
        guide_trace_feedback_attributed: true,
        measure_positive_history_impact: true,
        operator_snapshot_contract_visible: true,
        agent_prompt_boundary_preserved: true,
        execution_memory_adapter_flow: true,
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
