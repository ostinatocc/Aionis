#!/usr/bin/env node
import "dotenv/config";
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
  createAionisClient,
  type AionisMemoryAdmissionRecord,
} from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  repoRoot,
} from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
  postRuntimeJson,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const AGENT_ID = "loop-engineering-agent";
const LOOP_MARKER = "LOOP_ENGINEERING_PROFILE";
const FAILED_MARKER = "LOOP_PROFILE_FAILED_ITERATION";
const PASSED_MARKER = "LOOP_PROFILE_PASSED_ITERATION";
const TARGET_FILE = "src/loop-profile/current-target.ts";
const FAILED_FILE = "src/loop-profile/legacy-target.ts";

type LoopDecision = {
  next_action: "continue_passed_iteration" | "repeat_failed_iteration" | "unknown";
  avoided_failed_iteration: boolean;
  used_aionis: boolean;
};

function apiKey(): string | null {
  return process.env.AIONIS_LOOP_ENGINEERING_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function firstNodeId(observeBody: unknown, label: string): string {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} did not return a memory node id`);
  return id;
}

function optionalNodeId(observeBody: unknown): string | null {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function agentContext(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assertCondition(record?.contract_version === "aionis_agent_context_v1", `${label} did not return agent_context v1`);
  assertCondition(typeof record.prompt_text === "string" && record.prompt_text.length > 0, `${label} missing prompt_text`);
  return record;
}

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "memory_admission_record",
    "memory_use_receipt",
    "raw_memory_rows",
    "raw_slots",
    "raw_embedding_vectors",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
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

function buildLoopExecutionTree(runId: string): {
  baseTree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
  expectedTree: ExecutionTreeV1;
} {
  const baseTree = createExecutionTreeV1({
    tree_id: `tree-loop-engineering-profile-${runId}`,
    scope: `aionis://execution-tree/loop-engineering-profile/${runId}`,
    task_brief: "Loop-engineered Agent should preserve validator evidence across iterations.",
    at: "2026-06-15T00:00:00.000Z",
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
    operation_id: `${runId}:grow-failed-iteration`,
    actor_role: "worker",
    at: "2026-06-15T00:01:00.000Z",
    action: `${FAILED_MARKER}: patch ${FAILED_FILE}.`,
    observation: `${FAILED_MARKER}: validator failed; this route should stay counter-evidence.`,
    title: "Failed loop iteration",
    refs: [`trace://loop-engineering-profile/${runId}/iteration-1/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-failed-iteration`,
    actor_role: "worker",
    at: "2026-06-15T00:02:00.000Z",
    title: `${FAILED_MARKER} rejected`,
    summary: `${FAILED_MARKER} touched ${FAILED_FILE} and failed validator replay.`,
  });
  const failedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!failedSummaryNodeId) throw new Error("failed iteration did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:maintain-failed-iteration`,
    actor_role: "verifier",
    at: "2026-06-15T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: `${FAILED_MARKER}: do not repeat ${FAILED_FILE}.`,
  });
  add({
    type: "revise",
    operation_id: `${runId}:revise-failed-iteration`,
    actor_role: "worker",
    at: "2026-06-15T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: `Repair by moving to ${TARGET_FILE}.`,
  });
  add({
    type: "grow",
    operation_id: `${runId}:grow-passed-iteration`,
    actor_role: "worker",
    at: "2026-06-15T00:05:00.000Z",
    action: `${PASSED_MARKER}: patch ${TARGET_FILE}.`,
    observation: `${PASSED_MARKER}: validator passed and this is the active continuation.`,
    title: "Passed loop iteration",
    refs: [`trace://loop-engineering-profile/${runId}/iteration-2/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-passed-iteration`,
    actor_role: "worker",
    at: "2026-06-15T00:06:00.000Z",
    title: `${PASSED_MARKER} accepted`,
    summary: `${PASSED_MARKER} repaired the loop by using ${TARGET_FILE}.`,
  });
  const passedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!passedSummaryNodeId) throw new Error("passed iteration did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:maintain-passed-iteration`,
    actor_role: "verifier",
    at: "2026-06-15T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });

  return { baseTree, operations, expectedTree };
}

function simulateLoopDecision(context: Record<string, unknown>): LoopDecision {
  const joined = [
    String(context.prompt_text ?? ""),
    ...textArray(context.use_now),
    ...textArray(context.do_not_use),
  ].join("\n");
  const sawPassed = joined.includes(PASSED_MARKER) || joined.includes(TARGET_FILE);
  const sawFailedAsBlocked = textArray(context.do_not_use).some((entry) => entry.includes(FAILED_MARKER))
    || String(context.prompt_text ?? "").includes(FAILED_MARKER);
  if (sawPassed) {
    return {
      next_action: "continue_passed_iteration",
      avoided_failed_iteration: sawFailedAsBlocked,
      used_aionis: true,
    };
  }
  return {
    next_action: joined.includes(FAILED_FILE) ? "repeat_failed_iteration" : "unknown",
    avoided_failed_iteration: false,
    used_aionis: false,
  };
}

async function main() {
  const runId = `loop-engineering-${randomUUID().slice(0, 8)}`;
  const scope = `loop-engineering-profile:${runId}`;
  const taskSignature = `loop-engineering-profile:${runId}`;
  const workflowSignature = "loop-engineering-memory-governance-profile";
  const queryText = `${LOOP_MARKER}: continue the loop from validator-proven state; avoid repeating failed iterations.`;
  const runtimeApiKey = apiKey();
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: runtimeApiKey ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const beforeGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:before`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: workflowSignature,
      query_text: queryText,
      context_mode: "compact_agent",
      include_packets: true,
      limit: 8,
    });
    const beforeContext = agentContext(beforeGuide.agent_context, "before loop profile guide");
    assertPromptBoundary(String(beforeContext.prompt_text), "before loop profile guide");
    assertCondition(beforeContext.actionable_history_used === false, "fresh loop profile should not start with actionable history");

    const failedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:iteration-1`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: `${workflowSignature}:failed`,
      title: `${FAILED_MARKER} iteration 1 failed validation`,
      summary: `${FAILED_MARKER}: Agent tried ${FAILED_FILE}; validator rejected the route.`,
      outcome: "failed",
      target_files: [FAILED_FILE],
      workflow_steps: ["plan candidate route", "apply legacy patch", "run validator"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["validator rejected legacy route"],
      continuation_hint: `Do not repeat ${FAILED_MARKER}; repair toward ${TARGET_FILE}.`,
      confidence: 0.35,
      raw_ref: `trace://loop-engineering-profile/${runId}/iteration-1/raw`,
      evidence_ref: `evidence://loop-engineering-profile/${runId}/validator-failed`,
      verification: {
        validator_kind: "unit_test",
        validation_result: "failed",
        passed: false,
        reason: `${FAILED_MARKER} modified the wrong target.`,
      },
      slots: {
        loop_engineering_profile: true,
        loop_id: runId,
        iteration_index: 1,
        validator_kind: "unit_test",
        validation_result: "failed",
        repair_attempt: 0,
        stop_reason: "validator_failed",
        execution_result_summary: {
          status: "failed",
          summary: `${FAILED_MARKER}: ${FAILED_FILE} failed validator replay.`,
          diagnostic_note: "Keep this iteration as counter-evidence, not as a reusable route.",
          evidence_refs: [`evidence://loop-engineering-profile/${runId}/validator-failed`],
        },
      },
    });
    const failedMemoryId = firstNodeId(failedObserve, "failed loop iteration");

    const passedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:iteration-2`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: `${workflowSignature}:passed`,
      title: `${PASSED_MARKER} iteration 2 passed validation`,
      summary: `${PASSED_MARKER}: Agent repaired the loop by editing ${TARGET_FILE}; validator passed.`,
      outcome: "succeeded",
      target_files: [TARGET_FILE],
      workflow_steps: ["read validator failure", "patch current target", "rerun validator"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["validator passed on current target"],
      continuation_hint: `Future loop iterations should continue ${PASSED_MARKER} at ${TARGET_FILE}.`,
      confidence: 0.94,
      raw_ref: `trace://loop-engineering-profile/${runId}/iteration-2/raw`,
      evidence_ref: `evidence://loop-engineering-profile/${runId}/validator-passed`,
      verification: {
        validator_kind: "unit_test",
        validation_result: "passed",
        passed: true,
        reason: `${PASSED_MARKER} passed validator replay.`,
      },
      slots: {
        loop_engineering_profile: true,
        loop_id: runId,
        iteration_index: 2,
        validator_kind: "unit_test",
        validation_result: "passed",
        repair_attempt: 1,
        stop_reason: "validator_passed",
        execution_result_summary: {
          status: "passed",
          summary: `${PASSED_MARKER}: ${TARGET_FILE} passed validator replay.`,
          evidence_refs: [`evidence://loop-engineering-profile/${runId}/validator-passed`],
        },
      },
    });
    const passedMemoryId = firstNodeId(passedObserve, "passed loop iteration");

    const { baseTree, operations, expectedTree } = buildLoopExecutionTree(runId);
    const handoff = await aionis.execution.handoff<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:handoff`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: workflowSignature,
      title: "Loop Engineering Profile handoff",
      summary: `${LOOP_MARKER}: continue ${PASSED_MARKER}; keep ${FAILED_MARKER} as counter-evidence.`,
      handoff_text: "Carry validator-proven loop state into the next iteration.",
      target_files: [TARGET_FILE],
      next_action: `Continue ${PASSED_MARKER} at ${TARGET_FILE}.`,
      must_change: [TARGET_FILE],
      must_remove: [FAILED_FILE],
      acceptance_checks: ["next guide reuses passed iteration", "next guide avoids failed iteration"],
      file_path: "scripts/e2e/loop-engineering-profile.ts",
      repo_root: repoRoot,
      execution_tree_disabled: true,
      execution_tree_v1: baseTree,
      execution_tree_operations_v1: operations,
      slots: {
        loop_engineering_profile: true,
        loop_id: runId,
        iteration_index: 2,
        validator_kind: "unit_test",
        validation_result: "passed",
        repair_attempt: 1,
        stop_reason: "handoff_to_next_iteration",
      },
    });
    const observedTree = asRecord(asRecord(handoff.handoff)?.execution_tree_v1);
    assertCondition(
      observedTree?.current_summary_node_id === expectedTree.current_summary_node_id,
      "loop profile handoff did not retain latest execution tree state",
    );
    const handoffMemoryId = optionalNodeId(handoff);

    const afterGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:next-iteration`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: workflowSignature,
      query_text: queryText,
      context: {
        loop_id: runId,
        iteration_index: 3,
        validator_kind: "unit_test",
        expected_posture: "continue from validator-proven state",
      },
      context_mode: "compact_agent",
      include_packets: true,
      limit: 10,
    });
    const afterContext = agentContext(afterGuide.agent_context, "after loop profile guide");
    const afterPrompt = String(afterContext.prompt_text ?? "");
    assertPromptBoundary(afterPrompt, "after loop profile guide");
    assertCondition(afterContext.history_used === true, "loop profile next guide did not use history");
    assertCondition(afterContext.actionable_history_used === true, "loop profile next guide did not expose actionable history");
    assertCondition(
      afterPrompt.includes(PASSED_MARKER) || textArray(afterContext.use_now).some((entry) => entry.includes(PASSED_MARKER)),
      "loop profile next guide did not surface passed iteration",
    );
    assertCondition(
      afterPrompt.includes(FAILED_MARKER) || textArray(afterContext.do_not_use).some((entry) => entry.includes(FAILED_MARKER)),
      "loop profile next guide did not surface failed iteration as counter-evidence",
    );

    const executionAssemble = await postRuntimeJson({
      baseUrl: session.baseUrl,
      pathName: "/v1/execution/context/assemble",
      apiKey: runtimeApiKey,
      payload: {
        tenant_id: "default",
        scope,
        consumer_agent_id: AGENT_ID,
        execution_tree_v1: observedTree,
        context_mode: "full_power",
        include_memory_evidence: false,
        include_prompt_text: true,
        include_agent_context: true,
        agent_context_char_budget: 4096,
      },
    });
    const executionContext = agentContext(executionAssemble.agent_context, "loop profile execution context");
    const executionPrompt = String(executionContext.prompt_text ?? "");
    assertPromptBoundary(executionPrompt, "loop profile execution context");
    assertCondition(executionContext.actionable_history_used === true, "loop profile execution context did not expose actionable history");
    assertCondition(
      textArray(executionContext.use_now).some((entry) => entry.includes(PASSED_MARKER)),
      "loop profile execution context did not put passed iteration in use_now",
    );
    assertCondition(
      textArray(executionContext.do_not_use).some((entry) => entry.includes(FAILED_MARKER)),
      "loop profile execution context did not put failed iteration in do_not_use",
    );

    const decision = simulateLoopDecision(executionContext);
    assertCondition(decision.next_action === "continue_passed_iteration", "loop profile decision did not continue passed iteration");
    assertCondition(decision.avoided_failed_iteration === true, "loop profile decision did not avoid failed iteration");

    const guideUseNowMemoryIds = textArray(afterContext.use_now_memory_ids);
    const executionUseNowMemoryIds = textArray(executionContext.use_now_memory_ids);
    const usedMemoryIds = guideUseNowMemoryIds.includes(passedMemoryId)
      ? [passedMemoryId]
      : executionUseNowMemoryIds.includes(passedMemoryId)
        ? [passedMemoryId]
        : guideUseNowMemoryIds.length > 0
          ? [guideUseNowMemoryIds[0]]
          : [passedMemoryId];
    const feedback = await aionis.execution.feedbackFromOutcome<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:feedback`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: workflowSignature,
      title: "Loop profile next iteration used governed memory",
      summary: "The host loop used the passed iteration and avoided the failed iteration.",
      outcome: "succeeded",
      guide: afterGuide,
      used_memory_ids: usedMemoryIds,
      feedback_outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: [`evidence://loop-engineering-profile/${runId}/next-iteration-validator`],
      feedback_reason: "Loop profile used the governed passed iteration in the next iteration.",
    });
    assertCondition(feedback !== null, "loop profile feedback was not submitted");

    const measure = await aionis.execution.measureRun<Record<string, unknown>>({
      run_id: runId,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${failedMemoryId}`,
        `memory:${passedMemoryId}`,
        ...(handoffMemoryId ? [`memory:${handoffMemoryId}`] : []),
        `feedback:${runId}`,
      ],
    });
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    const feedbackSummary = asRecord(effectReport?.feedback_signal_summary);
    const quality = asRecord(effectReport?.quality);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "loop profile measure did not return result v1");
    assertCondition(
      historyImpact?.changed_future_behavior === true,
      `loop profile measure did not report changed future behavior: ${JSON.stringify(effectReport)}`,
    );
    assertCondition(feedbackSummary?.present === true, "loop profile measure missed feedback signal summary");
    assertCondition(quality?.workflow_reuse_outcome === "success", "loop profile measure missed workflow reuse success");

    const snapshot = await aionis.execution.snapshotRun<Record<string, unknown>>({
      run_id: runId,
      task_signature: taskSignature,
      task_family: "loop_engineering_profile",
      workflow_signature: workflowSignature,
      guide: afterGuide,
      measure_result: measure,
      include_markdown: true,
    });
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    const operatorState = asRecord(operatorSnapshot?.execution_state);
    const operatorGuideTrace = asRecord(operatorSnapshot?.guide_trace);
    const operatorEffect = asRecord(operatorSnapshot?.effect);
    const traceToProcedure = asRecord(operatorSnapshot?.trace_to_procedure);
    assertCondition(snapshot.contract_version === "aionis_operator_snapshot_result_v1", "loop profile snapshot missing result v1");
    assertCondition(operatorSnapshot?.runtime_mutation === false, "loop profile snapshot mutated Runtime state");
    assertCondition(operatorState?.actionable_history_used === true, "loop profile snapshot did not preserve actionable history");
    assertCondition(operatorGuideTrace?.feedback_attribution_present === true, "loop profile snapshot missed feedback attribution");
    assertCondition(
      operatorEffect?.impact_direction === historyImpact?.impact_direction,
      "loop profile snapshot effect diverged from measure result",
    );
    assertCondition(traceToProcedure?.present === true, "loop profile snapshot missed trace-to-procedure projection");
    assertCondition(
      typeof snapshot.markdown === "string" && snapshot.markdown.includes("Aionis Operator Snapshot"),
      "loop profile snapshot markdown missing",
    );

    const flightRecorder = await aionis.flightRecorder<Record<string, unknown>>({
      run_id: runId,
      decision_time: "2026-06-15T00:08:00.000Z",
      agent_context: executionContext,
      memory_decision_trace: measure.memory_decision_trace,
      memory_use_receipt: asRecord(measure.memory_decision_trace)?.memory_use_receipt,
      memory_admission_record: asRecord(measure.memory_decision_trace)?.admission_record,
      operator_snapshot: operatorSnapshot,
      feedback_result: feedback,
    });
    const flightReport = asRecord(flightRecorder.agent_flight_recorder);
    const flightAgentView = asRecord(flightReport?.agent_view);
    const flightAttribution = asRecord(flightReport?.attribution);
    assertCondition(flightReport?.contract_version === "aionis_agent_flight_recorder_report_v1", "loop profile flight recorder missing report");
    assertCondition(flightReport?.agent_prompt_included === false, "loop profile flight recorder included prompt payload");
    assertCondition(flightAgentView?.prompt_text_included === false, "loop profile flight recorder included prompt text");
    assertCondition(flightAttribution?.present === true, "loop profile flight recorder missed attribution");
    assertCondition(!String(JSON.stringify(flightReport)).includes(executionPrompt), "loop profile flight recorder leaked prompt text");

    const admissionRecord = asRecord(asRecord(measure.memory_decision_trace)?.admission_record) as unknown as AionisMemoryAdmissionRecord;
    const admissionRows = Array.isArray((admissionRecord as unknown as Record<string, unknown>)?.entries)
      ? ((admissionRecord as unknown as Record<string, unknown>).entries as unknown[])
      : [];

    const result = {
      contract_version: "aionis_loop_engineering_profile_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      positioning:
        "Aionis is the memory governance layer for loop-engineered Agents; the host owns execution.",
      product_loop: "observe loop iterations -> guide next iteration -> feedback attribution -> measure -> snapshot -> flight recorder",
      loop_profile: {
        loop_id: runId,
        host_executes_loop: true,
        aionis_executes_tools: false,
        iterations_observed: 2,
        validator_kind: "unit_test",
        failed_iteration_memory_id: failedMemoryId,
        passed_iteration_memory_id: passedMemoryId,
        handoff_memory_id: handoffMemoryId,
        loop_slots: [
          "loop_id",
          "iteration_index",
          "validator_kind",
          "validation_result",
          "repair_attempt",
          "stop_reason",
        ],
      },
      loop_state: {
        before_actionable_history_used: beforeContext.actionable_history_used,
        after_actionable_history_used: afterContext.actionable_history_used,
        execution_use_now_memory_ids: executionUseNowMemoryIds,
        execution_do_not_use_count: textArray(executionContext.do_not_use).length,
        feedback_attributed_memory_ids: usedMemoryIds,
        measure_history_impact: historyImpact?.impact_direction,
        measure_changed_future_behavior: historyImpact?.changed_future_behavior,
        measure_workflow_reuse_outcome: quality?.workflow_reuse_outcome,
        measure_negative_transfer_detected: quality?.negative_transfer_detected,
        snapshot_actionable_history_used: operatorState?.actionable_history_used,
        trace_to_procedure_present: traceToProcedure?.present,
        flight_recorder_attribution_present: flightAttribution?.present,
        admission_record_entry_count: admissionRows.length,
      },
      simulated_agent_decision: decision,
      checks: {
        fresh_loop_starts_without_actionable_history: beforeContext.actionable_history_used === false,
        next_iteration_uses_governed_history: afterContext.actionable_history_used === true,
        passed_iteration_reused: decision.next_action === "continue_passed_iteration",
        failed_iteration_avoided: decision.avoided_failed_iteration === true,
        feedback_attributed: operatorGuideTrace?.feedback_attribution_present === true,
        measure_changed_future_behavior: historyImpact?.changed_future_behavior === true,
        measure_feedback_signal_present: feedbackSummary?.present === true,
        measure_workflow_reuse_success: quality?.workflow_reuse_outcome === "success",
        snapshot_read_only: operatorSnapshot?.runtime_mutation === false,
        trace_to_procedure_visible: traceToProcedure?.present === true,
        flight_recorder_replayable: flightAttribution?.present === true,
        prompt_payload_excluded_from_audit: flightReport?.agent_prompt_included === false
          && flightAgentView?.prompt_text_included === false,
      },
      boundary:
        "This profile does not make Aionis a loop executor. The host runs tools and validators; Aionis records loop evidence, governs memory admission, attributes feedback, measures effect, and exposes read-only audit surfaces.",
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
