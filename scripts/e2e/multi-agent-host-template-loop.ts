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
  simulateReviewer,
  textArray,
} from "./multi-agent-execution-memory-loop.ts";

export async function runMultiAgentHostTemplateLoop(args: {
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

  const taskSignature = `multi-agent-host-template:${args.runId}`;
  const workflowSignature = "planner-worker-verifier-reviewer-host-template";
  const queryText = `${PASSED_MARKER} reviewer continue active path and avoid ${FAILED_MARKER}`;

  const beforeGuide = await host.reviewerGuide<Record<string, unknown>>({
    run_id: `run:${args.runId}:reviewer-before`,
    task_signature: taskSignature,
    task_family: "multi_agent_execution_memory",
    workflow_signature: workflowSignature,
    query_text: queryText,
    agent_id: REVIEWER_ID,
    context: {
      reviewer_goal: "check whether host template has existing multi-agent branch state",
    },
    limit: 8,
  });
  const beforeContext = agentContext(beforeGuide.agent_context, "before host reviewer guide");
  assertPromptBoundary(String(beforeContext.prompt_text), "before host reviewer guide");
  assertCondition(beforeContext.actionable_history_used === false, "before host reviewer guide should not expose actionable history");

  const plannerObserve = await host.plannerStart<Record<string, unknown>>({
    run_id: `run:${args.runId}:planner`,
    task_id: `task:${args.runId}`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    agent_id: PLANNER_ID,
    title: `${PLAN_MARKER} host template planner scoped target file`,
    summary: `${PLAN_MARKER} planner assigned worker to inspect src/multi-agent-e2e/current-target.ts and verifier to reject broad search regressions.`,
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: [
      "Planner identifies current target file",
      "Worker attempts scoped change",
      "Verifier marks failed and passed branches",
      "Reviewer inherits active path through host template",
    ],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["reviewer continues passed branch", "reviewer avoids failed branch"],
    continuation_hint: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    confidence: 0.9,
    evidence: [{
      ref: `evidence://multi-agent-host-template/${args.runId}/planner-plan`,
      summary: "Planner produced scoped role handoff through host template.",
    }],
  });
  const plannerMemoryId = firstNodeId(plannerObserve.observe, "host planner");

  const failedObserve = await host.workerStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:worker-failed`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: "host-template-worker-failed-broad-search",
    agent_id: WORKER_ID,
    title: `${FAILED_MARKER} host broad_search_patch failed`,
    summary: `${FAILED_MARKER} broad_search_patch modified the wrong target and failed verifier replay.`,
    outcome: "failed",
    target_files: ["src/multi-agent-e2e/wrong-target.ts"],
    workflow_steps: ["Broad search", "Patch wrong target", "Verifier replay failed"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier rejected broad_search_patch"],
    continuation_hint: `Do not repeat ${FAILED_MARKER}; resume from planner boundary.`,
    confidence: 0.4,
    raw_ref: `trace://multi-agent-host-template/${args.runId}/worker-failed`,
    evidence_ref: `evidence://multi-agent-host-template/${args.runId}/verifier-failed`,
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
        evidence_refs: [`evidence://multi-agent-host-template/${args.runId}/verifier-failed`],
      },
    },
  });
  const failedMemoryId = firstNodeId(failedObserve.observe, "host failed worker");

  const passedObserve = await host.workerStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:worker-passed`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: "host-template-worker-passed-scoped-target",
    agent_id: WORKER_ID,
    title: `${PASSED_MARKER} host scoped_target_patch passed`,
    summary: `${PASSED_MARKER} scoped_target_patch edited src/multi-agent-e2e/current-target.ts and passed verifier replay.`,
    outcome: "succeeded",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: ["Read current target file", "Patch scoped target", "Verifier replay passed"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier accepted scoped_target_patch"],
    continuation_hint: `Reviewer should continue ${PASSED_MARKER} from src/multi-agent-e2e/current-target.ts.`,
    confidence: 0.93,
    raw_ref: `trace://multi-agent-host-template/${args.runId}/worker-passed`,
    evidence_ref: `evidence://multi-agent-host-template/${args.runId}/verifier-passed`,
    verification: {
      verifier_agent_id: VERIFIER_ID,
      passed: true,
      reason: `${PASSED_MARKER} passed verifier replay.`,
    },
    slots: {
      execution_result_summary: {
        status: "passed",
        summary: `${PASSED_MARKER} scoped_target_patch passed verifier replay with raw evidence.`,
        evidence_refs: [`evidence://multi-agent-host-template/${args.runId}/verifier-passed`],
      },
    },
  });
  const passedMemoryId = firstNodeId(passedObserve.observe, "host passed worker");

  const { baseTree, operations, expectedTree } = buildMultiAgentExecutionTree(args.runId);
  const handoffPayload = {
    anchor: taskSignature,
    file_path: "scripts/e2e/multi-agent-host-template-loop.ts",
    repo_root: repoRoot,
    handoff_kind: "task_handoff",
    task_signature: taskSignature,
    title: "Host template multi-agent execution memory handoff",
    summary: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    handoff_text: "Recover planner, worker, verifier, and reviewer execution state before continuing.",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    next_action: `Continue ${PASSED_MARKER}; do not repeat ${FAILED_MARKER}.`,
    execution_tree_disabled: true,
    execution_tree_v1: baseTree,
    execution_tree_operations_v1: operations,
  };
  const handoffObserve = await host.verifierStep<Record<string, unknown>>({
    run_id: `run:${args.runId}:handoff`,
    task_family: "multi_agent_execution_memory",
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    agent_id: VERIFIER_ID,
    title: "Host template multi-agent execution memory handoff",
    summary: `Reviewer should continue ${PASSED_MARKER} and avoid ${FAILED_MARKER}.`,
    handoff: handoffPayload,
  });
  const observedTree = asRecord(asRecord(handoffObserve.observe.handoff)?.execution_tree_v1);
  assertCondition(
    observedTree?.current_summary_node_id === expectedTree.current_summary_node_id,
    "host handoff observe did not expose latest multi-agent execution tree",
  );
  assertCondition(
    adapter.execution_tree_v1?.current_summary_node_id === expectedTree.current_summary_node_id,
    "host adapter did not retain latest multi-agent execution tree",
  );

  const afterGuide = await host.reviewerGuide<Record<string, unknown>>({
    run_id: args.runId,
    task_signature: taskSignature,
    task_family: "multi_agent_execution_memory",
    workflow_signature: workflowSignature,
    query_text: queryText,
    agent_id: REVIEWER_ID,
    context: {
      reviewer_goal: "inherit active path, avoid failed branch, and record feedback attribution through host template",
    },
    tool_candidates: ["read", "edit", "test"],
    limit: 10,
  });
  const reviewerContext = agentContext(afterGuide.agent_context, "after host reviewer guide");
  assertPromptBoundary(String(reviewerContext.prompt_text), "after host reviewer guide");
  const afterSourceMap = asRecord(afterGuide.guide.source_map);
  assertCondition(
    Array.isArray(afterSourceMap?.routes_used)
      && afterSourceMap.routes_used.includes("/v1/execution/context/assemble"),
    "host reviewer guide did not use full_power execution context route",
  );
  assertCondition(reviewerContext.agent_role === "reviewer", "host reviewer guide did not preserve agent_role");
  assertCondition(String(reviewerContext.prompt_text).includes("state: role=reviewer"), "host reviewer guide prompt did not include role state");
  assertCondition(String(reviewerContext.prompt_text).includes("role_focus: review branch status"), "host reviewer guide prompt did not include reviewer focus");
  assertCondition(reviewerContext.history_used === true, "host reviewer guide did not use multi-agent history");
  assertCondition(reviewerContext.actionable_history_used === true, "host reviewer guide did not expose actionable multi-agent history");
  assertCondition(
    textArray(reviewerContext.use_now).some((entry) => entry.includes(PASSED_MARKER))
      || String(reviewerContext.prompt_text).includes(PASSED_MARKER),
    "host reviewer guide did not surface passed branch memory",
  );

  const executionAssemble = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/execution/context/assemble",
    apiKey: args.apiKey,
    payload: {
      tenant_id: "default",
      scope: args.scope,
      consumer_agent_id: REVIEWER_ID,
      execution_tree_v1: observedTree,
      context_mode: "full_power",
      include_memory_evidence: false,
      include_prompt_text: true,
      include_agent_context: true,
      agent_context_char_budget: 4096,
    },
  });
  const executionContext = agentContext(executionAssemble.agent_context, "host reviewer execution context");
  assertPromptBoundary(String(executionContext.prompt_text), "host reviewer execution context");
  assertCondition(
    textArray(executionContext.use_now).some((entry) => entry.includes(PASSED_MARKER)),
    "host execution context missing passed branch in use_now",
  );
  assertCondition(
    textArray(executionContext.do_not_use).some((entry) => entry.includes(FAILED_MARKER)),
    "host execution context missing failed branch in do_not_use",
  );
  assertCondition(
    String(executionAssemble.prompt_text ?? "").includes("RAW_EVIDENCE"),
    "host full_power audit prompt should retain RAW_EVIDENCE",
  );

  const reviewerDecision = simulateReviewer({
    guideContext: reviewerContext,
    executionContext,
  });
  assertCondition(reviewerDecision.next_action === "continue_passed_branch", "host reviewer did not continue the passed branch");
  assertCondition(reviewerDecision.avoided_failed_branch, "host reviewer did not avoid the failed branch");

  const usedMemoryIds = afterGuide.state.last_use_now_memory_ids;
  assertCondition(usedMemoryIds.includes(passedMemoryId), "host reviewer guide did not expose passed memory id for attribution");
  const reviewerOutcomeResult = await host.reviewerOutcome<Record<string, unknown>, Record<string, unknown>>({
    state: afterGuide.state,
    run_id: args.runId,
    task_family: "multi_agent_execution_memory",
    task_signature: `multi-agent-host-template-reviewer:${args.runId}`,
    workflow_signature: "host-template-reviewer-continued-passed-branch",
    agent_id: REVIEWER_ID,
    title: "MULTI_AGENT_E2E_REVIEWER host template continued passed branch",
    summary: `Reviewer continued ${PASSED_MARKER}, avoided ${FAILED_MARKER}, and preserved branch status for the next Agent.`,
    outcome: "succeeded",
    target_files: ["src/multi-agent-e2e/current-target.ts"],
    workflow_steps: ["Read agent_context", "Inspect branch split", "Continue passed branch"],
    acceptance_checks: ["continued passed branch", "did not repeat failed branch"],
    continuation_hint: `Future agents should continue ${PASSED_MARKER} and keep ${FAILED_MARKER} as counter-evidence.`,
    confidence: 0.91,
    raw_ref: `trace://multi-agent-host-template/${args.runId}/reviewer`,
    evidence_ref: `evidence://multi-agent-host-template/${args.runId}/reviewer-verifier`,
    verification: {
      next_action: reviewerDecision.next_action,
      avoided_failed_branch: reviewerDecision.avoided_failed_branch,
      passed: true,
    },
    slots: {
      execution_result_summary: {
        status: "passed",
        summary: "Reviewer used host-template multi-agent execution memory correctly.",
        evidence_refs: [`evidence://multi-agent-host-template/${args.runId}/reviewer-verifier`],
      },
    },
    used_memory_ids: [passedMemoryId],
    runtime_signal_refs: [`evidence://multi-agent-host-template/${args.runId}/reviewer-verifier`],
    feedback_reason: "Reviewer used the passed worker branch successfully through the host template.",
  });
  const reviewerMemoryId = firstNodeId(reviewerOutcomeResult.outcome.observe, "host reviewer");

  const activateFeedback = reviewerOutcomeResult.outcome.feedback;
  assertCondition(activateFeedback, "host template did not submit guide feedback for reviewer outcome");
  const feedbackEffect = asRecord(activateFeedback.forget_effect);
  assertCondition(feedbackEffect?.changed_count === 1, "host activate feedback did not affect exactly one memory");

  const measure = await host.measure<Record<string, unknown>>({
    state: afterGuide.state,
    run_id: args.runId,
    task_id: `task:${args.runId}`,
    task_signature: taskSignature,
    task_family: "multi_agent_execution_memory",
    workflow_signature: workflowSignature,
    task: {
      run_id: `run:${args.runId}:reviewer`,
    },
    before_guide: beforeGuide.guide,
    after_guide: afterGuide.guide,
    forget_result: activateFeedback,
    evidence_ids: [
      `product_trace:multi-agent-host-template:${args.runId}`,
      `memory:${plannerMemoryId}`,
      `memory:${failedMemoryId}`,
      `memory:${passedMemoryId}`,
      `memory:${reviewerMemoryId}`,
    ],
  });
  const effectReport = asRecord(measure.effect_report);
  const historyImpact = asRecord(effectReport?.history_impact);
  const feedbackSummary = asRecord(effectReport?.feedback_signal_summary);
  assertCondition(measure.contract_version === "aionis_measure_result_v1", "host measure did not return measure result v1");
  assertCondition(
    historyImpact?.impact_direction === "positive",
    `host measure did not report positive multi-agent history impact: ${JSON.stringify(effectReport)}`,
  );
  assertCondition(historyImpact?.changed_future_behavior === true, "host measure did not report changed future behavior");
  assertCondition(feedbackSummary?.present === true, "host measure did not include guide feedback attribution summary");

  const operatorSnapshotResult = await host.snapshot<Record<string, unknown>>({
    state: afterGuide.state,
    run_id: args.runId,
    task_signature: taskSignature,
    task_family: "multi_agent_execution_memory",
    workflow_signature: workflowSignature,
    execution_context: executionAssemble,
    measure_result: measure,
    include_markdown: true,
  });
  const operatorSnapshot = asRecord(operatorSnapshotResult.operator_snapshot);
  const operatorExecutionState = asRecord(operatorSnapshot.execution_state);
  const operatorBranchIsolation = asRecord(operatorExecutionState.branch_isolation);
  const operatorGuideTrace = asRecord(operatorSnapshot.guide_trace);
  const operatorEffect = asRecord(operatorSnapshot.effect);
  const operatorMemoryUseReceipt = asRecord(operatorSnapshot.memory_use_receipt);
  const operatorTraceToProcedure = asRecord(operatorSnapshot.trace_to_procedure);
  assertCondition(
    operatorSnapshotResult.contract_version === "aionis_operator_snapshot_result_v1",
    "host operator snapshot did not return result v1",
  );
  assertCondition(
    operatorSnapshot.contract_version === "aionis_operator_snapshot_v1",
    "host operator snapshot did not return snapshot v1",
  );
  assertCondition(operatorSnapshot.runtime_mutation === false, "host operator snapshot must be read-only");
  assertCondition(operatorExecutionState.actionable_history_used === true, "host operator snapshot did not expose actionable history state");
  assertCondition(operatorBranchIsolation.status === "pass", "host operator snapshot did not prove branch isolation");
  assertCondition(
    operatorBranchIsolation.failed_branch_leaked_to_use_now === false,
    "host operator snapshot reported failed branch leakage into use_now",
  );
  assertCondition(
    operatorGuideTrace.feedback_attribution_present === true,
    "host operator snapshot did not expose guide feedback attribution",
  );
  assertCondition(
    operatorEffect.impact_direction === "positive",
    "host operator snapshot did not carry positive effect measurement",
  );
  assertCondition(
    operatorMemoryUseReceipt?.contract_version === "aionis_memory_use_receipt_v1",
    "host operator snapshot did not expose memory use receipt",
  );
  assertCondition(
    operatorMemoryUseReceipt.runtime_mutation === false,
    "host memory use receipt must be read-only",
  );
  assertCondition(
    operatorTraceToProcedure?.present === true,
    "host operator snapshot did not expose trace-to-procedure readiness",
  );
  assertCondition(
    operatorTraceToProcedure.runtime_mutation === false,
    "host trace-to-procedure projection must be read-only",
  );
  assertCondition(
    Array.isArray(operatorTraceToProcedure.source_surfaces)
      && operatorTraceToProcedure.source_surfaces.includes("execution_tree"),
    "host trace-to-procedure projection did not include execution_tree",
  );
  assertCondition(
    operatorTraceToProcedure.candidate_visible === true,
    "host trace-to-procedure projection did not expose candidate readiness",
  );
  assertCondition(
    typeof operatorSnapshotResult.markdown === "string"
      && operatorSnapshotResult.markdown.includes("Aionis Operator Snapshot"),
    "host operator snapshot markdown report missing",
  );

  return {
    before_history_used: beforeContext.history_used,
    before_actionable_history_used: beforeContext.actionable_history_used,
    reviewer_history_used: reviewerContext.history_used,
    reviewer_actionable_history_used: reviewerContext.actionable_history_used,
    reviewer_use_now_count: textArray(reviewerContext.use_now).length,
    reviewer_use_now_memory_ids: usedMemoryIds,
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
    operator_snapshot_actionable_history_used: operatorExecutionState.actionable_history_used,
    operator_snapshot_feedback_attribution_present: operatorGuideTrace.feedback_attribution_present,
    operator_snapshot_effect_impact: operatorEffect.impact_direction,
    operator_snapshot_memory_use_receipt_visible: operatorMemoryUseReceipt.contract_version === "aionis_memory_use_receipt_v1",
    operator_snapshot_trace_to_procedure_present: operatorTraceToProcedure.present,
    operator_snapshot_trace_to_procedure_status: operatorTraceToProcedure.promotion_status,
    operator_snapshot_trace_to_procedure_source_surfaces: operatorTraceToProcedure.source_surfaces,
    host_template_flow_used: true,
    host_template_snapshot_used: true,
  };
}

async function main() {
  const runId = `multi-agent-host-template-${randomUUID().slice(0, 8)}`;
  const scope = `multi-agent-host-template-e2e:${runId}`;
  const apiKey = process.env.AIONIS_MULTI_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
  const session = await openRuntime();
  try {
    const multiAgentLoop = await runMultiAgentHostTemplateLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_multi_agent_host_template_e2e_result_v1",
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
        host_template_hooks_observed: true,
        planner_worker_verifier_reviewer_observed: true,
        reviewer_inherited_passed_branch: true,
        reviewer_avoided_failed_branch: true,
        guide_trace_feedback_attributed: true,
        measure_positive_history_impact: true,
        host_snapshot_contract_visible: true,
        operator_snapshot_read_only: true,
        agent_prompt_boundary_preserved: true,
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
