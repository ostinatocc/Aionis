#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  compileExecutionAgentContext,
  createAionisClient,
  planAssetObserveEvents,
} from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  repoRoot,
} from "./runtime-agent-loop.ts";
import {
  agentContext,
  closeRuntime,
  openRuntime,
  textArray,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const TASK_FAMILY = "plan_as_memory_asset";
const WORKFLOW_SIGNATURE = "planner-worker-plan-asset";
const ACTIVE_TARGET = "packages/api/src/feature-flags.ts";
const FAILED_TARGET = "packages/api/src/random-rollout.ts";
const PLAN_MARKER = "PLAN_AS_MEMORY_ASSET_E2E";
const PASSED_MARKER = "PLAN_AS_MEMORY_ASSET_PASSED_BRANCH";
const FAILED_MARKER = "PLAN_AS_MEMORY_ASSET_FAILED_BRANCH";

function apiKey(): string | null {
  return process.env.AIONIS_PLAN_AS_MEMORY_ASSET_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function firstNodeId(observeBody: unknown, label: string): string {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes.map((entry) => asRecord(entry)) : [];
  const id = nodes[0]?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} did not return a memory node id`);
  return id;
}

function promptContainsAny(prompt: string, values: string[]): boolean {
  return values.some((value) => value.length > 0 && prompt.includes(value));
}

function simulateWorkerDecision(args: {
  prompt: string;
  activeTargets: string[];
  useNowText: string;
  doNotUseText: string;
  inspectText: string;
}): {
  plan_adherence: boolean;
  wrong_branch_reuse: boolean;
  next_action: "follow_plan_target" | "repeat_failed_branch" | "unknown";
} {
  const joinedActionable = [args.prompt, args.useNowText, args.activeTargets.join("\n")].join("\n");
  const guardedText = [args.doNotUseText, args.inspectText, args.prompt].join("\n");
  const planAdherence = joinedActionable.includes(ACTIVE_TARGET)
    && promptContainsAny(joinedActionable, [PLAN_MARKER, PASSED_MARKER, "feature-flags"]);
  const wrongBranchReuse = args.useNowText.includes(FAILED_TARGET)
    || args.activeTargets.includes(FAILED_TARGET)
    || (/continue|use|patch/i.test(args.useNowText) && args.useNowText.includes(FAILED_MARKER));
  return {
    plan_adherence: planAdherence,
    wrong_branch_reuse: wrongBranchReuse,
    next_action: planAdherence
      ? "follow_plan_target"
      : guardedText.includes(FAILED_TARGET)
        ? "repeat_failed_branch"
        : "unknown",
  };
}

async function main() {
  const runId = `plan-asset-${randomUUID().slice(0, 8)}`;
  const scope = `plan-as-memory-asset:${runId}`;
  const taskSignature = `feature-flag-service:${runId}`;
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
      agent_id: "worker-plan-asset",
      run_id: `run:${runId}:before`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: `${PLAN_MARKER}: continue the feature flag implementation from governed plan state.`,
      context_mode: "compact_agent",
      include_packets: true,
      limit: 8,
    });
    const beforeContext = agentContext(beforeGuide.agent_context, "plan asset before guide");
    assertCondition(beforeContext.actionable_history_used === false, "fresh plan asset scope should not start with actionable history");

    const planEvents = planAssetObserveEvents({
      run_id: `run:${runId}:plan`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      planner: {
        agent_id: "planner-strong-model",
        team_id: "plan-asset-team",
        model: "strong-planner",
      },
      plan: {
        plan_id: `plan:${runId}:feature-flags`,
        title: `${PLAN_MARKER} feature flag service plan`,
        summary: "Build sticky rollout evaluation with audit logging and avoid random per-request assignment.",
        artifact_ref: "plan.md",
        decisions: [
          {
            decision_id: "decision:sticky-bucket",
            statement: `Use deterministic bucket hashing in ${ACTIVE_TARGET}.`,
            rationale: "Increasing rollout percentage should preserve users already enabled by a lower percentage.",
            alternatives_rejected: ["random per-request rollout assignment"],
            target_files: [ACTIVE_TARGET],
          },
        ],
        acceptance_checks: [
          "same user gets the same flag result across repeated calls",
          "20% to 40% rollout preserves the original 20% enabled users",
        ],
        execution_boundaries: [
          "do not store per-user rollout state",
          `do not revive ${FAILED_TARGET} as the active implementation route`,
        ],
        failed_branches: [
          {
            branch_id: "failed:random-rollout",
            statement: `${FAILED_MARKER}: random per-request rollout assignment is invalid.`,
            reason: "It violates sticky rollout and failed verifier checks.",
            target_files: [FAILED_TARGET],
          },
        ],
      },
    });

    const observedPlan = await Promise.all(planEvents.map((event) => aionis.execution.observeStep<Record<string, unknown>>(event)));
    const planMemoryId = firstNodeId(observedPlan[0], "plan asset event");
    const rejectedBranchMemoryId = firstNodeId(observedPlan[1], "plan rejected branch event");

    const passedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "worker-cheap-model",
      team_id: "plan-asset-team",
      role: "worker",
      run_id: `run:${runId}:passed`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: `${PASSED_MARKER} deterministic bucket implementation accepted`,
      summary: `${PASSED_MARKER}: worker followed ${PLAN_MARKER} and implemented sticky bucket evaluation in ${ACTIVE_TARGET}.`,
      outcome: "succeeded",
      target_files: [ACTIVE_TARGET],
      workflow_steps: ["read plan asset", "implement deterministic bucket", "run verifier"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: [
        "same user gets the same flag result across repeated calls",
        "20% to 40% rollout preserves the original 20% enabled users",
      ],
      continuation_hint: `Continue ${ACTIVE_TARGET}; preserve ${PLAN_MARKER} decisions and avoid ${FAILED_TARGET}.`,
      confidence: 0.95,
      evidence_ref: `evidence://plan-as-memory-asset/${runId}/verifier-passed`,
      verification: {
        validator_kind: "unit_test",
        validation_result: "passed",
        passed: true,
      },
      slots: {
        plan_as_memory_asset: true,
        plan_id: `plan:${runId}:feature-flags`,
        validation_result: "passed",
        execution_result_summary: {
          status: "passed",
          summary: `${PASSED_MARKER}: ${ACTIVE_TARGET} satisfied plan acceptance checks.`,
        },
      },
    });
    const passedMemoryId = firstNodeId(passedObserve, "passed worker branch");

    const afterGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: "worker-cheap-model",
      team_id: "plan-asset-team",
      role: "worker",
      run_id: `run:${runId}:worker-next`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: `${PLAN_MARKER}: continue feature flag implementation from the accepted plan; do not repeat random rollout.`,
      context: {
        plan_id: `plan:${runId}:feature-flags`,
        expected_active_target: ACTIVE_TARGET,
        rejected_target: FAILED_TARGET,
      },
      context_mode: "compact_agent",
      include_packets: true,
      limit: 10,
    });
    const afterContext = agentContext(afterGuide.agent_context, "plan asset after guide");
    assertCondition(afterContext.actionable_history_used === true, "plan asset guide did not expose actionable history");

    const compiled = compileExecutionAgentContext({
      guide: afterGuide,
      task: {
        run_id: runId,
        task_signature: taskSignature,
        query_text: `${PLAN_MARKER}: continue from the accepted plan asset.`,
      },
      repo_state: {
        existing_files: [ACTIVE_TARGET],
        missing_files: [FAILED_TARGET],
      },
      budget_profile: "compact",
      max_prompt_chars: 6_000,
      additional_instructions: [
        "Treat planner decisions as governed evidence, not model-routing policy.",
        "Follow accepted plan targets and keep rejected branches as counter-evidence.",
      ],
    });
    const useNowText = textArray(afterContext.use_now).join("\n");
    const doNotUseText = textArray(afterContext.do_not_use).join("\n");
    const inspectText = textArray(afterContext.inspect_before_use).join("\n");
    const promptText = compiled.agent_prompt;
    const planTargetVisible = compiled.active_targets.includes(ACTIVE_TARGET)
      || promptText.includes(ACTIVE_TARGET)
      || useNowText.includes(ACTIVE_TARGET);
    const failedBranchDirectUse = compiled.active_targets.includes(FAILED_TARGET)
      || useNowText.includes(FAILED_TARGET)
      || compiled.use_now_memory_ids.includes(rejectedBranchMemoryId);
    assertCondition(planTargetVisible, "plan asset context did not preserve accepted target");
    assertCondition(!failedBranchDirectUse, "plan asset context direct-used the rejected branch");
    assertCondition(compiled.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1", "compiled context missing memory use receipt");
    assertCondition(compiled.memory_admission_record.contract_version === "aionis_memory_admission_record_v1", "compiled context missing memory admission record");

    const decision = simulateWorkerDecision({
      prompt: promptText,
      activeTargets: compiled.active_targets,
      useNowText,
      doNotUseText,
      inspectText,
    });
    assertCondition(decision.plan_adherence === true, "simulated worker did not adhere to the plan asset");
    assertCondition(decision.wrong_branch_reuse === false, "simulated worker reused rejected plan branch");

    const usedMemoryIds = compiled.use_now_memory_ids.includes(passedMemoryId)
      ? [passedMemoryId]
      : compiled.use_now_memory_ids.includes(planMemoryId)
        ? [planMemoryId]
        : compiled.use_now_memory_ids.slice(0, 1);
    assertCondition(usedMemoryIds.length > 0, "plan asset guide did not expose a use_now memory id for attribution");

    const feedback = await aionis.execution.feedbackFromOutcome<Record<string, unknown>>({
      agent_id: "worker-cheap-model",
      team_id: "plan-asset-team",
      role: "worker",
      run_id: `run:${runId}:feedback`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: "Worker followed plan asset context",
      summary: "The worker followed the accepted plan target and avoided the rejected rollout branch.",
      outcome: "succeeded",
      guide: afterGuide,
      used_memory_ids: usedMemoryIds,
      feedback_outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: [`evidence://plan-as-memory-asset/${runId}/worker-followed-plan`],
      feedback_reason: "Plan asset context preserved decisions and prevented rejected branch reuse.",
    });
    assertCondition(feedback !== null, "plan asset feedback was not submitted");

    const measure = await aionis.execution.measureRun<Record<string, unknown>>({
      run_id: runId,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${planMemoryId}`,
        `memory:${rejectedBranchMemoryId}`,
        `memory:${passedMemoryId}`,
        `feedback:${runId}`,
      ],
    });
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "plan asset measure did not return result v1");
    assertCondition(historyImpact?.changed_future_behavior === true, "plan asset measure did not report changed future behavior");

    const snapshot = await aionis.execution.snapshotRun<Record<string, unknown>>({
      run_id: runId,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      guide: afterGuide,
      measure_result: measure,
      include_markdown: true,
    });
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    assertCondition(operatorSnapshot?.runtime_mutation === false, "plan asset snapshot mutated Runtime state");

    const flightRecorder = await aionis.flightRecorder<Record<string, unknown>>({
      run_id: runId,
      decision_time: "2026-06-16T00:00:00.000Z",
      agent_context: compiled,
      memory_decision_trace: measure.memory_decision_trace,
      memory_use_receipt: asRecord(measure.memory_decision_trace)?.memory_use_receipt ?? compiled.memory_use_receipt,
      memory_admission_record: asRecord(measure.memory_decision_trace)?.admission_record ?? compiled.memory_admission_record,
      operator_snapshot: operatorSnapshot,
      feedback_result: feedback,
    });
    const flightReport = asRecord(flightRecorder.agent_flight_recorder);
    const flightAgentView = asRecord(flightReport?.agent_view);
    assertCondition(flightReport?.contract_version === "aionis_agent_flight_recorder_report_v1", "plan asset flight recorder missing report");
    assertCondition(flightReport?.agent_prompt_included === false, "plan asset flight recorder included prompt payload");
    assertCondition(flightAgentView?.prompt_text_included === false, "plan asset flight recorder included prompt text");
    assertCondition(flightReport?.runtime_mutation === false, "plan asset flight recorder mutated Runtime state");
    assertCondition(!JSON.stringify(flightReport).includes(promptText), "plan asset flight recorder leaked prompt text");

    const result = {
      contract_version: "aionis_plan_as_memory_asset_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      positioning: "Strong planners make plans; Aionis keeps those plans reusable as governed execution memory.",
      plan_asset: {
        recorded: true,
        plan_memory_id: planMemoryId,
        rejected_branch_memory_id: rejectedBranchMemoryId,
        passed_memory_id: passedMemoryId,
        decision_count: 1,
        acceptance_check_count: 2,
        rejected_branch_count: 1,
      },
      governed_context: {
        before_actionable_history_used: beforeContext.actionable_history_used,
        after_actionable_history_used: afterContext.actionable_history_used,
        use_now_contains_plan_target: planTargetVisible,
        failed_branch_direct_use: failedBranchDirectUse,
        memory_use_receipt_present: compiled.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
        memory_admission_record_present: compiled.memory_admission_record.contract_version === "aionis_memory_admission_record_v1",
        prompt_char_count: compiled.prompt_char_count,
        active_targets: compiled.active_targets,
        use_now_memory_ids: compiled.use_now_memory_ids,
        inspect_before_use_memory_ids: compiled.inspect_before_use_memory_ids,
        do_not_use_memory_ids: compiled.do_not_use_memory_ids,
      },
      simulated_worker: decision,
      measurement: {
        measure_history_impact: historyImpact?.impact_direction ?? null,
        changed_future_behavior: historyImpact?.changed_future_behavior ?? false,
      },
      flight_recorder: {
        contract_version: flightReport.contract_version,
        prompt_payload_excluded: flightReport.agent_prompt_included === false && flightAgentView?.prompt_text_included === false,
        runtime_mutation: flightReport.runtime_mutation,
      },
      checks: {
        plan_recorded: true,
        plan_decisions_enter_context: planTargetVisible,
        acceptance_checks_preserved: promptText.includes("same user gets the same flag result")
          || promptText.includes("acceptance"),
        failed_branch_not_direct_use: !failedBranchDirectUse,
        worker_plan_adherence: decision.plan_adherence,
        wrong_branch_reuse_prevented: !decision.wrong_branch_reuse,
        feedback_attributed: feedback !== null,
        measure_changed_future_behavior: historyImpact?.changed_future_behavior === true,
        flight_recorder_replayable: flightReport.contract_version === "aionis_agent_flight_recorder_report_v1",
        prompt_payload_excluded_from_audit: flightReport.agent_prompt_included === false && flightAgentView?.prompt_text_included === false,
      },
      boundary:
        "This demo does not route models or execute tools. It proves Aionis can preserve a planner artifact as governed execution memory for a later worker.",
    };

    const outputPath = path.join(repoRoot, "docs/examples/plan-as-memory-asset-result.json");
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
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
