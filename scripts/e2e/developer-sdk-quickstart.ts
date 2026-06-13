#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentContextFromGuide,
  agentPromptFromGuide,
  compileExecutionAgentContext,
  createAionisClient,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
} from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const AGENT_ID = "sdk-quickstart-agent";
const PREF_MARKER = "SDK_QUICKSTART_ACTIVE_PREF";
const PROJECT_MARKER = "SDK_QUICKSTART_PROJECT_FACT";

function apiKey(): string | null {
  return process.env.AIONIS_SDK_QUICKSTART_API_KEY?.trim()
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

function optionalObserveNodeId(observeBody: unknown): string | null {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "memory_use_receipt",
    "decision_reviews",
    "raw_memory_rows",
    "raw_slots",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

async function main() {
  const runId = `sdk-quickstart-${randomUUID().slice(0, 8)}`;
  const scope = `sdk-quickstart:${runId}`;
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const beforeGuide = await aionis.guide<Record<string, unknown>>({
      query_text: `${PREF_MARKER} ${PROJECT_MARKER} before memory exists`,
      consumer_agent_id: AGENT_ID,
      limit: 6,
      include_packets: true,
    });
    const beforeContext = agentContextFromGuide<Record<string, unknown>>(beforeGuide);
    assertPromptBoundary(agentPromptFromGuide(beforeGuide), "before SDK quickstart guide");

    const preference = await aionis.remember<Record<string, unknown>>({
      kind: "preference",
      client_id: `sdk-quickstart-preference:${runId}`,
      title: "SDK quickstart response preference",
      text: `${PREF_MARKER}: prefer concise product updates with concrete next steps and cite the active memory when relevant.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      confidence: 0.92,
      slots: { source: "sdk_quickstart" },
    });
    const preferenceId = firstNodeId(preference, "SDK preference remember");

    const projectFact = await aionis.remember<Record<string, unknown>>({
      kind: "project_context",
      client_id: `sdk-quickstart-project:${runId}`,
      title: "SDK quickstart project fact",
      text: `${PROJECT_MARKER}: the active integration target is docs/AIONIS_SDK_QUICKSTART.md and scripts/e2e/developer-sdk-quickstart.ts.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      target_files: ["docs/AIONIS_SDK_QUICKSTART.md", "scripts/e2e/developer-sdk-quickstart.ts"],
      confidence: 0.94,
      slots: { source: "sdk_quickstart" },
    });
    const projectFactId = firstNodeId(projectFact, "SDK project fact remember");

    const executionHandoff = await aionis.execution.handoff<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: runId,
      task_signature: "sdk-quickstart",
      task_family: "developer_sdk_quickstart",
      workflow_signature: "sdk-quickstart-execution-context",
      title: "SDK quickstart execution handoff",
      summary: `${PROJECT_MARKER}: continue the SDK quickstart docs update without broad rediscovery.`,
      outcome: "succeeded",
      target_files: ["docs/AIONIS_SDK_QUICKSTART.md", "scripts/e2e/developer-sdk-quickstart.ts"],
      continuation_hint: "Use the SDK execution context compiler as the Agent prompt path.",
      acceptance_checks: ["compiled execution context is generated", "feedback remains attributed"],
      evidence_ref: `evidence://sdk-quickstart/${runId}/execution-handoff`,
    });
    const handoffStored = !!asRecord(executionHandoff.handoff);
    assertCondition(handoffStored, "SDK execution handoff was not stored");
    const executionHandoffId = optionalObserveNodeId(executionHandoff);

    const afterGuide = await aionis.guide<Record<string, unknown>>({
      query_text: `${PREF_MARKER} ${PROJECT_MARKER} continue SDK quickstart integration`,
      consumer_agent_id: AGENT_ID,
      limit: 8,
      include_packets: true,
    });
    const afterContext = agentContextFromGuide<Record<string, unknown>>(afterGuide);
    const promptText = agentPromptFromGuide(afterGuide);
    assertPromptBoundary(promptText, "after SDK quickstart guide");
    const useNowIds = textArray(afterContext.use_now_memory_ids);
    const useNow = textArray(afterContext.use_now);
    assertCondition(afterContext.actionable_history_used === true, "SDK quickstart guide did not expose actionable memory");
    assertCondition(useNowIds.includes(preferenceId), "SDK preference was not exposed in use_now memory IDs");
    assertCondition(useNowIds.includes(projectFactId), "SDK project fact was not exposed in use_now memory IDs");
    assertCondition(
      useNow.some((entry) => entry.includes(PREF_MARKER)) || promptText.includes(PREF_MARKER),
      "SDK preference marker missing from Agent-facing context",
    );
    assertCondition(
      useNow.some((entry) => entry.includes(PROJECT_MARKER)) || promptText.includes(PROJECT_MARKER),
      "SDK project marker missing from Agent-facing context",
    );

    const executionGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:execution-context`,
      task_signature: "sdk-quickstart",
      task_family: "developer_sdk_quickstart",
      workflow_signature: "sdk-quickstart-execution-context",
      query_text: `${PROJECT_MARKER} continue the SDK quickstart execution-memory path`,
      context_mode: "compact_agent",
      limit: 10,
      include_packets: true,
    });
    const compiledContext = aionis.execution.compileAgentContext({
      guide: executionGuide,
      task: {
        run_id: runId,
        task_signature: "sdk-quickstart",
        query_text: "Continue the SDK quickstart execution-memory path.",
      },
      repo_state: {
        existing_files: ["scripts/e2e/developer-sdk-quickstart.ts"],
        missing_files: ["docs/AIONIS_SDK_QUICKSTART.md"],
      },
      budget_profile: "balanced",
    });
    assertPromptBoundary(compiledContext.agent_prompt, "compiled SDK execution context");
    assertCondition(
      compiledContext.agent_prompt.includes("AIONIS_EXECUTION_AGENT_CONTEXT v1"),
      "SDK quickstart did not render execution Agent context contract",
    );
    assertCondition(
      compiledContext.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
      "SDK execution context missing memory use receipt",
    );
    assertCondition(
      compiledContext.memory_use_receipt.history_used === true,
      "SDK execution context did not preserve memory-use audit state",
    );
    assertCondition(
      compiledContext.prompt_char_count > 0,
      "SDK execution context produced empty Agent prompt",
    );

    const feedback = await aionis.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide: afterGuide,
      reason: "SDK quickstart Agent used the exposed project fact successfully.",
      run_id: `run:${runId}:feedback`,
      outcome: "positive",
      used_memory_ids: [projectFactId],
    }));

    const measure = await aionis.measure<Record<string, unknown>>(measureInputFromGuideLoop({
      task: {
        task_id: `task:${runId}`,
        run_id: runId,
        task_signature: "sdk-quickstart",
        task_family: "developer_sdk_quickstart",
      },
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${preferenceId}`,
        `memory:${projectFactId}`,
        `feedback:${runId}`,
      ],
    }));
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    const decisionTrace = asRecord(measure.memory_decision_trace);
    const receipt = asRecord(decisionTrace?.memory_use_receipt);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "SDK quickstart measure did not return result v1");
    assertCondition(historyImpact?.impact_direction === "positive", "SDK quickstart measure did not report positive history impact");
    assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", "SDK quickstart measure missing memory use receipt");

    const snapshot = await aionis.snapshot<Record<string, unknown>>(snapshotInputFromGuideLoop({
      run_id: runId,
      task_signature: "sdk-quickstart",
      task_family: "developer_sdk_quickstart",
      guide: afterGuide,
      measure_result: measure,
      include_markdown: false,
    }));
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    const snapshotReceipt = asRecord(operatorSnapshot?.memory_use_receipt);
    assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "SDK quickstart snapshot missing snapshot v1");
    assertCondition(snapshotReceipt?.contract_version === "aionis_memory_use_receipt_v1", "SDK quickstart snapshot missing receipt");

    const feedbackEffect = asRecord(feedback.forget_effect);
    const guideTrace = asRecord(feedbackEffect?.guide_trace);
    const result = {
      contract_version: "aionis_sdk_quickstart_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      integration_path: {
        sdk_client: "createAionisClient",
        product_loop: "remember -> guide -> compileExecutionAgentContext -> agent prompt -> feedback -> measure -> snapshot",
        execution_context_compiler: "aionis.execution.compileAgentContext",
      },
      agent_context: {
        before_actionable_history_used: beforeContext.actionable_history_used,
        after_actionable_history_used: afterContext.actionable_history_used,
        prompt_char_count: promptText.length,
        prompt_preview: promptText.slice(0, 800),
        use_now_memory_ids: useNowIds,
      },
      execution_context_compiler: {
        contract_version: compiledContext.contract_version,
        budget_profile: compiledContext.budget_profile,
        prompt_char_count: compiledContext.prompt_char_count,
        prompt_preview: compiledContext.agent_prompt.slice(0, 800),
        route_contract_present: compiledContext.route_contract !== null,
        active_targets: compiledContext.active_targets,
        missing_active_targets: compiledContext.missing_active_targets,
        blocked_direction_targets: compiledContext.blocked_direction_targets,
        rehydrate_request_count: compiledContext.rehydrate_requests.length,
        warning_codes: compiledContext.execution_warnings.map((entry) => entry.code),
        memory_use_receipt_visible: compiledContext.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
      },
      memory_governance: {
        preference_memory_id: preferenceId,
        project_fact_memory_id: projectFactId,
        execution_handoff_memory_id: executionHandoffId,
        execution_handoff_stored: handoffStored,
        feedback_attributed_memory_count: guideTrace?.attributed_memory_count ?? null,
        measure_history_impact: historyImpact.impact_direction,
      },
      operator_audit: {
        memory_use_receipt_visible: true,
        receipt_decision_summary_count: recordArray(receipt.decision_summaries).length,
        snapshot_receipt_visible: true,
        snapshot_runtime_mutation: operatorSnapshot.runtime_mutation,
      },
      checks: {
        starts_without_actionable_history: beforeContext.actionable_history_used === false,
        guide_exposes_preference: useNowIds.includes(preferenceId),
        guide_exposes_project_fact: useNowIds.includes(projectFactId),
        agent_prompt_boundary_preserved: true,
        execution_context_compiler_used: compiledContext.contract_version === "aionis_execution_agent_context_v1",
        execution_context_receipt_visible: compiledContext.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
        feedback_attributed: guideTrace?.attributed_memory_count === 1,
        positive_history_impact_measured: historyImpact.impact_direction === "positive",
        operator_snapshot_read_only: operatorSnapshot.runtime_mutation === false,
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
