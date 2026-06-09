#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionMemoryAdapter } from "../../src/adapters/execution-memory.ts";
import { createGenericAgentHostTemplate } from "../../src/adapters/host-integration.ts";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";
import {
  agentContext,
  assertPromptBoundary,
  closeRuntime,
  firstNodeId,
  openRuntime,
  textArray,
} from "./multi-agent-execution-memory-loop.ts";

const SINGLE_AGENT_ID = "single-agent";
const ACTIVE_PREF_MARKER = "SINGLE_AGENT_E2E_ACTIVE_PREF";
const ORDINARY_FACT_MARKER = "SINGLE_AGENT_E2E_ORDINARY_FACT";
const OUTCOME_MARKER = "SINGLE_AGENT_E2E_SUCCESSFUL_USE";

async function runSingleAgentHostTemplateLoop(args: {
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
    default_agent_id: SINGLE_AGENT_ID,
    default_agent_role: "agent",
    default_memory_lane: "private",
    default_limit: 10,
    include_packets_by_default: true,
  });
  const host = createGenericAgentHostTemplate(adapter, {
    agent_id: SINGLE_AGENT_ID,
    role: "agent",
    limit: 10,
    include_packets: true,
    mode: "full_power",
  });
  await client.health();

  const taskSignature = `single-agent-host-template:${args.runId}`;
  const workflowSignature = "single-agent-generic-host-template";

  const freshGuide = await host.beforeRun<Record<string, unknown>>({
    run_id: `run:${args.runId}:fresh-before`,
    task_signature: taskSignature,
    task_family: "single_agent_memory",
    workflow_signature: workflowSignature,
    query_text: "Start a fresh single-agent task with no prior memory.",
    context: {
      phase: "fresh_negative_control",
    },
    limit: 8,
  });
  const freshContext = agentContext(freshGuide.agent_context, "fresh single-agent guide");
  assertPromptBoundary(String(freshContext.prompt_text), "fresh single-agent guide");
  assertCondition(freshContext.history_used === true, "fresh single-agent guide should expose context-channel state");
  assertCondition(freshContext.actionable_history_used === false, "fresh single-agent guide exposed actionable history before writes");
  assertCondition(freshContext.recommended_posture === "ignore_history", "fresh single-agent guide should ignore history");
  assertCondition(freshContext.authority === "none", "fresh single-agent guide should have no memory authority");
  assertCondition(freshGuide.state.last_use_now_memory_ids.length === 0, "fresh single-agent guide exposed use_now ids");
  assertCondition(String(freshContext.prompt_text).includes("actionable_history=no"), "fresh single-agent prompt missing actionable_history=no");

  const ordinaryObserve = await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "private",
    producer_agent_id: SINGLE_AGENT_ID,
    owner_agent_id: SINGLE_AGENT_ID,
    nodes: [
      {
        client_id: `memory:${args.runId}:single-active-preference`,
        type: "rule",
        title: `${ACTIVE_PREF_MARKER} active response preference`,
        text_summary: `${ACTIVE_PREF_MARKER}: For status updates, use concise bullets and cite the evidence marker ${ORDINARY_FACT_MARKER}.`,
        confidence: 0.91,
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "active",
          state: "active",
          compression_layer: "L2",
        },
      },
      {
        client_id: `memory:${args.runId}:single-ordinary-fact`,
        type: "concept",
        title: `${ORDINARY_FACT_MARKER} current project fact`,
        text_summary: `${ORDINARY_FACT_MARKER}: Current single-agent work should inspect src/single-agent-e2e/current-target.ts before broad search.`,
        confidence: 0.89,
        slots: {
          memory_kind: "general_memory",
          lifecycle_state: "active",
          state: "active",
          compression_layer: "L2",
        },
      },
    ],
  });
  const firstOrdinaryMemoryId = firstNodeId(ordinaryObserve, "single-agent ordinary memory");

  const guided = await host.beforeRun<Record<string, unknown>>({
    state: freshGuide.state,
    run_id: args.runId,
    task_signature: taskSignature,
    task_family: "single_agent_memory",
    workflow_signature: workflowSignature,
    query_text: `${ACTIVE_PREF_MARKER} ${ORDINARY_FACT_MARKER} What should the single agent do next?`,
    context: {
      phase: "memory_reuse",
    },
    limit: 10,
  });
  const guidedContext = agentContext(guided.agent_context, "single-agent memory guide");
  assertPromptBoundary(String(guidedContext.prompt_text), "single-agent memory guide");
  assertCondition(guidedContext.agent_role === "agent", "single-agent guide did not preserve agent role");
  assertCondition(guidedContext.history_used === true, "single-agent guide did not use memory history");
  assertCondition(
    guidedContext.actionable_history_used === true,
    `single-agent guide did not mark actionable memory: ${JSON.stringify({
      history_used: guidedContext.history_used,
      authority: guidedContext.authority,
      posture: guidedContext.recommended_posture,
      use_now: guidedContext.use_now,
      inspect_before_use: guidedContext.inspect_before_use,
      do_not_use: guidedContext.do_not_use,
      memory_ids: guidedContext.memory_ids,
      use_now_memory_ids: guidedContext.use_now_memory_ids,
      prompt: String(guidedContext.prompt_text ?? "").slice(0, 1200),
    })}`,
  );
  assertCondition(guidedContext.authority === "advisory", "single-agent guide should expose advisory general memory");
  assertCondition(String(guidedContext.prompt_text).includes("actionable_history=yes"), "single-agent prompt missing actionable_history=yes");
  assertCondition(
    textArray(guidedContext.use_now).some((entry) => entry.includes(ACTIVE_PREF_MARKER)),
    "single-agent guide missing active preference in use_now",
  );
  assertCondition(
    textArray(guidedContext.use_now).some((entry) => entry.includes(ORDINARY_FACT_MARKER)),
    "single-agent guide missing ordinary fact in use_now",
  );
  const usedMemoryIds = guided.state.last_use_now_memory_ids;
  assertCondition(usedMemoryIds.includes(firstOrdinaryMemoryId), "single-agent guide did not expose ordinary memory id for attribution");

  const finished = await host.afterRun<Record<string, unknown>, Record<string, unknown>>({
    state: guided.state,
    run_id: `run:${args.runId}:successful-use`,
    task_signature: taskSignature,
    task_family: "single_agent_memory",
    workflow_signature: workflowSignature,
    title: `${OUTCOME_MARKER} single agent used active memory`,
    summary: `${OUTCOME_MARKER}: Single agent followed ${ACTIVE_PREF_MARKER} and inspected the target from ${ORDINARY_FACT_MARKER}.`,
    outcome: "succeeded",
    target_files: ["src/single-agent-e2e/current-target.ts"],
    workflow_steps: [
      "Read AIONIS_AGENT_CONTEXT",
      "Reuse active preference",
      "Inspect target file from ordinary fact memory",
    ],
    acceptance_checks: ["active preference followed", "ordinary fact reused"],
    continuation_hint: `Future single-agent runs can reuse ${ACTIVE_PREF_MARKER} when the same status-update preference applies.`,
    confidence: 0.92,
    raw_ref: `trace://single-agent-host-template/${args.runId}/successful-use`,
    evidence_ref: `evidence://single-agent-host-template/${args.runId}/successful-use`,
    verification: {
      passed: true,
      used_markers: [ACTIVE_PREF_MARKER, ORDINARY_FACT_MARKER],
    },
    used_memory_ids: usedMemoryIds,
    runtime_signal_refs: [`evidence://single-agent-host-template/${args.runId}/successful-use`],
    feedback_reason: "Single-agent run successfully used ordinary Aionis memory.",
  });
  const outcomeMemoryId = firstNodeId(finished.outcome.observe, "single-agent outcome");
  const feedback = finished.outcome.feedback;
  assertCondition(feedback, "single-agent host did not submit outcome feedback");
  const feedbackEffect = asRecord(feedback.forget_effect);
  assertCondition(Number(feedbackEffect?.changed_count ?? 0) > 0, "single-agent feedback did not affect used memories");

  const afterGuide = await host.beforeRun<Record<string, unknown>>({
    state: finished.state,
    run_id: `run:${args.runId}:after-feedback`,
    task_signature: taskSignature,
    task_family: "single_agent_memory",
    workflow_signature: workflowSignature,
    query_text: `${ACTIVE_PREF_MARKER} ${OUTCOME_MARKER} Continue the same single-agent workflow.`,
    context: {
      phase: "after_feedback",
    },
    limit: 10,
  });
  const afterContext = agentContext(afterGuide.agent_context, "single-agent after-feedback guide");
  assertPromptBoundary(String(afterContext.prompt_text), "single-agent after-feedback guide");
  assertCondition(afterContext.actionable_history_used === true, "single-agent after-feedback guide lost actionable history");
  assertCondition(
    textArray(afterContext.use_now).some((entry) => entry.includes(ACTIVE_PREF_MARKER))
      || String(afterContext.prompt_text).includes(ACTIVE_PREF_MARKER),
    "single-agent after-feedback guide did not retain active preference",
  );

  const measure = await host.measure<Record<string, unknown>>({
    state: afterGuide.state,
    run_id: args.runId,
    task_signature: taskSignature,
    task_family: "single_agent_memory",
    workflow_signature: workflowSignature,
    before_guide: freshGuide.guide,
    after_guide: afterGuide.guide,
    forget_result: feedback,
    evidence_ids: [
      `memory:${firstOrdinaryMemoryId}`,
      `memory:${outcomeMemoryId}`,
      `product_trace:single-agent-host-template:${args.runId}`,
    ],
  });
  const effectReport = asRecord(measure.effect_report);
  const historyImpact = asRecord(effectReport?.history_impact);
  const feedbackSummary = asRecord(effectReport?.feedback_signal_summary);
  assertCondition(measure.contract_version === "aionis_measure_result_v1", "single-agent measure did not return measure result v1");
  assertCondition(historyImpact?.impact_direction === "positive", "single-agent measure did not report positive history impact");
  assertCondition(historyImpact?.changed_future_behavior === true, "single-agent measure did not report changed future behavior");
  assertCondition(feedbackSummary?.present === true, "single-agent measure missing feedback attribution summary");

  const snapshotResult = await host.snapshot<Record<string, unknown>>({
    state: afterGuide.state,
    run_id: args.runId,
    task_signature: taskSignature,
    task_family: "single_agent_memory",
    workflow_signature: workflowSignature,
    measure_result: measure,
    include_markdown: true,
  });
  const operatorSnapshot = asRecord(snapshotResult.operator_snapshot);
  const operatorExecutionState = asRecord(operatorSnapshot?.execution_state);
  const operatorGuideTrace = asRecord(operatorSnapshot?.guide_trace);
  const operatorEffect = asRecord(operatorSnapshot?.effect);
  assertCondition(snapshotResult.contract_version === "aionis_operator_snapshot_result_v1", "single-agent snapshot did not return result v1");
  assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "single-agent snapshot did not return snapshot v1");
  assertCondition(operatorSnapshot.runtime_mutation === false, "single-agent snapshot must be read-only");
  assertCondition(operatorExecutionState?.actionable_history_used === true, "single-agent snapshot did not expose actionable history");
  assertCondition(operatorGuideTrace?.feedback_attribution_present === true, "single-agent snapshot missing feedback attribution");
  assertCondition(operatorEffect?.impact_direction === "positive", "single-agent snapshot missing positive effect");
  assertCondition(
    typeof snapshotResult.markdown === "string" && snapshotResult.markdown.includes("Aionis Operator Snapshot"),
    "single-agent snapshot markdown missing",
  );

  return {
    fresh_history_used: freshContext.history_used,
    fresh_actionable_history_used: freshContext.actionable_history_used,
    guided_history_used: guidedContext.history_used,
    guided_actionable_history_used: guidedContext.actionable_history_used,
    guided_use_now_count: textArray(guidedContext.use_now).length,
    guided_use_now_memory_ids: usedMemoryIds,
    first_ordinary_memory_id: firstOrdinaryMemoryId,
    outcome_memory_id: outcomeMemoryId,
    feedback_changed_count: feedbackEffect.changed_count,
    after_feedback_actionable_history_used: afterContext.actionable_history_used,
    measure_history_impact: historyImpact.impact_direction,
    feedback_summary_present: feedbackSummary.present,
    operator_snapshot_actionable_history_used: operatorExecutionState.actionable_history_used,
    operator_snapshot_feedback_attribution_present: operatorGuideTrace.feedback_attribution_present,
    operator_snapshot_effect_impact: operatorEffect.impact_direction,
    host_template_flow_used: true,
    host_template_snapshot_used: true,
  };
}

async function main() {
  const runId = `single-agent-host-template-${randomUUID().slice(0, 8)}`;
  const scope = `single-agent-host-template-e2e:${runId}`;
  const apiKey = process.env.AIONIS_SINGLE_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
  const session = await openRuntime();
  try {
    const singleAgentLoop = await runSingleAgentHostTemplateLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_single_agent_host_template_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      agent: {
        agent_id: SINGLE_AGENT_ID,
        role: "agent",
        memory_lane: "private",
      },
      single_agent_loop: singleAgentLoop,
      checks: {
        fresh_scope_has_no_actionable_history: true,
        ordinary_memory_guides_single_agent: true,
        feedback_attribution_recorded: true,
        measure_positive_history_impact: true,
        operator_snapshot_contract_visible: true,
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
