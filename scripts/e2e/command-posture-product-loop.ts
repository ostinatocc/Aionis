#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  agentContextFromGuide,
  commandPostureFromGuide,
  createAionisClient,
  feedbackFromGuide,
  inspectFirstMemoryIdsFromGuide,
  measureInputFromGuideLoop,
  mustNotMemoryIdsFromGuide,
  rehydrateFirstMemoryIdsFromGuide,
  shouldContinueMemoryIdsFromGuide,
} from "../../src/sdk.ts";
import {
  createExecutionMemoryAdapter,
} from "../../src/adapters/execution-memory.ts";
import {
  createGenericAgentHostTemplate,
} from "../../src/adapters/host-integration.ts";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import {
  agentContext,
  assertPromptBoundary,
  closeRuntime,
  openRuntime,
  textArray,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const TEAM_ID = "command-posture-team";
const AGENT_ID = "command-posture-reviewer";
const TASK_SIGNATURE = "command-posture-product-e2e";
const WORKFLOW_SIGNATURE = "command-posture-product-e2e:workflow";

function apiKey(): string | null {
  return process.env.AIONIS_COMMAND_POSTURE_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function nodeIdsFromObserve(observeBody: unknown, label: string): string[] {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const ids = nodes
    .map((node) => node.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  assertCondition(ids.length >= 4, `${label} observe returned fewer than 4 memory node ids`);
  return ids;
}

function stringSetIncludes(values: string[], expected: string, label: string): void {
  assertCondition(values.includes(expected), `${label} missing ${expected}`);
}

function commandRows(value: unknown): Array<Record<string, unknown>> {
  return recordArray(value);
}

function assertCommandPosture(
  rows: Array<Record<string, unknown>>,
  memoryId: string,
  posture: string,
  label: string,
): void {
  assertCondition(
    rows.some((row) => row.memory_id === memoryId && row.posture === posture),
    `${label} missing ${posture} for ${memoryId}`,
  );
}

function executionSlots(args: {
  lifecycle_state?: string;
  summary_kind: string;
  compression_layer: string;
  contract_trust: string;
  target_files: string[];
  next_action?: string;
  workflow_steps?: string[];
  rehydration?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    memory_kind: args.summary_kind === "workflow_anchor" ? "execution_workflow" : "execution_memory",
    lifecycle_state: args.lifecycle_state,
    task_signature: TASK_SIGNATURE,
    workflow_signature: WORKFLOW_SIGNATURE,
    target_files: args.target_files,
    summary_kind: args.summary_kind,
    compression_layer: args.compression_layer,
    contract_trust: args.contract_trust,
    execution_native_v1: {
      schema_version: "execution_native_v1",
      execution_kind: args.summary_kind === "workflow_anchor" ? "workflow_anchor" : "execution_native",
      summary_kind: args.summary_kind,
      compression_layer: args.compression_layer,
      contract_trust: args.contract_trust,
      task_signature: TASK_SIGNATURE,
      workflow_signature: WORKFLOW_SIGNATURE,
      anchor_kind: args.summary_kind === "workflow_anchor" ? "workflow" : "execution",
      anchor_level: args.compression_layer,
      target_files: args.target_files,
      next_action: args.next_action,
      workflow_steps: args.workflow_steps,
      rehydration: args.rehydration,
      actor_role: "worker",
      handoff_target: "reviewer",
    },
  };
}

async function main() {
  const runId = `command-posture-${randomUUID().slice(0, 8)}`;
  const scope = `command-posture-product-e2e:${runId}`;
  const session = await openRuntime();

  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const queryText = [
      "Continue command posture product e2e.",
      "Need current state, failed branch avoidance, contested inspection, and exact raw trace evidence.",
      "COMMAND_POSTURE_E2E_CURRENT COMMAND_POSTURE_E2E_FAILED COMMAND_POSTURE_E2E_CONTESTED COMMAND_POSTURE_E2E_REHYDRATE",
    ].join(" ");

    const beforeGuide = await aionis.guide<Record<string, unknown>>({
      query_text: queryText,
      consumer_agent_id: AGENT_ID,
      consumer_team_id: TEAM_ID,
      agent_role: "reviewer",
      context: {
        task_signature: TASK_SIGNATURE,
        workflow_signature: WORKFLOW_SIGNATURE,
      },
      mode: "full_power",
      context_mode: "compact_agent",
      include_packets: true,
      limit: 10,
    });
    assertPromptBoundary(
      String(agentContext(agentContextFromGuide(beforeGuide), "before command posture guide").prompt_text),
      "before command posture guide",
    );

    const observe = await aionis.observe<Record<string, unknown>>({
      auto_embed: true,
      memory_lane: "shared",
      producer_agent_id: "command-posture-worker",
      owner_team_id: TEAM_ID,
      nodes: [
        {
          client_id: `${runId}:current`,
          type: "concept",
          title: "Command posture current active state",
          text_summary:
            "COMMAND_POSTURE_E2E_CURRENT: Continue the accepted adapter boundary in src/runtime/current.ts before widening discovery.",
          tier: "hot",
          slots: executionSlots({
            lifecycle_state: "active",
            summary_kind: "current_state",
            compression_layer: "L2",
            contract_trust: "authoritative",
            target_files: ["src/runtime/current.ts"],
            next_action: "Continue the accepted adapter boundary in src/runtime/current.ts.",
          }),
          confidence: 0.95,
          salience: 0.94,
        },
        {
          client_id: `${runId}:failed`,
          type: "concept",
          title: "Command posture failed branch",
          text_summary:
            "COMMAND_POSTURE_E2E_FAILED: Failed branch touched unrelated modules and must not be reused as direct guidance.",
          tier: "warm",
          slots: executionSlots({
            lifecycle_state: "suppressed",
            summary_kind: "failed_branch",
            compression_layer: "L2",
            contract_trust: "authoritative",
            target_files: ["src/runtime/legacy-search.ts"],
          }),
          confidence: 0.91,
          salience: 0.88,
        },
        {
          client_id: `${runId}:contested`,
          type: "concept",
          title: "Command posture contested branch",
          text_summary:
            "COMMAND_POSTURE_E2E_CONTESTED: Candidate branch may apply but must be inspected against current code first.",
          tier: "warm",
          slots: executionSlots({
            lifecycle_state: "contested",
            summary_kind: "current_state",
            compression_layer: "L2",
            contract_trust: "advisory",
            target_files: ["src/runtime/candidate.ts"],
            next_action: "Inspect current code before using this candidate branch.",
          }),
          confidence: 0.74,
          salience: 0.82,
        },
        {
          client_id: `${runId}:rehydrate`,
          type: "evidence",
          title: "Command posture raw trace pointer",
          text_summary:
            "COMMAND_POSTURE_E2E_REHYDRATE: Raw execution trace pointer exists and must be expanded before exact evidence use.",
          tier: "cold",
          slots: executionSlots({
            lifecycle_state: "rehydration_candidate",
            summary_kind: "raw_trace_pointer",
            compression_layer: "L1",
            contract_trust: "advisory",
            target_files: ["traces/command-posture/raw.jsonl"],
            rehydration: { default_mode: "partial" },
          }),
          confidence: 0.79,
          salience: 0.76,
          raw_ref: `trace://command-posture/${runId}/raw`,
        },
      ],
    });

    const [currentId, failedId, contestedId, rehydrateId] = nodeIdsFromObserve(observe, "command posture");

    const guide = await aionis.guide<Record<string, unknown>>({
      query_text: queryText,
      consumer_agent_id: AGENT_ID,
      consumer_team_id: TEAM_ID,
      agent_role: "reviewer",
      context: {
        task_signature: TASK_SIGNATURE,
        workflow_signature: WORKFLOW_SIGNATURE,
      },
      mode: "full_power",
      context_mode: "compact_agent",
      include_packets: true,
      limit: 10,
    });

    const context = agentContext(agentContextFromGuide(guide), "command posture guide");
    const rows = commandRows(context.command_posture);
    const promptText = String(context.prompt_text);
    assertPromptBoundary(String(context.prompt_text), "command posture guide");
    assertCondition(promptText.includes("priority: go>chk"), "compact command posture prompt missing go-before-inspect priority");
    assertCondition(promptText.includes("go=primary_next_route"), "compact command posture prompt missing primary route instruction");
    assertCondition(promptText.includes("chk=reference_only_not_primary"), "compact command posture prompt missing inspect-only instruction");
    assertCommandPosture(rows, currentId, "should_continue", "SDK guide command posture");
    assertCommandPosture(rows, failedId, "must_not", "SDK guide command posture");
    assertCommandPosture(rows, contestedId, "inspect_first", "SDK guide command posture");
    assertCommandPosture(rows, rehydrateId, "rehydrate_first", "SDK guide command posture");
    const inspectRow = rows.find((row) => row.memory_id === contestedId && row.posture === "inspect_first");
    assertCondition(
      typeof inspectRow?.instruction === "string"
        && inspectRow.instruction.includes("do not use as the primary implementation route"),
      "inspect_first command posture did not preserve inspect-only instruction",
    );
    stringSetIncludes(shouldContinueMemoryIdsFromGuide(guide), currentId, "SDK should_continue ids");
    stringSetIncludes(mustNotMemoryIdsFromGuide(guide), failedId, "SDK must_not ids");
    stringSetIncludes(inspectFirstMemoryIdsFromGuide(guide), contestedId, "SDK inspect_first ids");
    stringSetIncludes(rehydrateFirstMemoryIdsFromGuide(guide), rehydrateId, "SDK rehydrate_first ids");
    assertCondition(
      commandPostureFromGuide(guide).length >= 4,
      "SDK commandPostureFromGuide did not expose all command postures",
    );
    assertCondition(
      !textArray(context.use_now_memory_ids).includes(failedId)
        && !textArray(context.use_now_memory_ids).includes(contestedId)
        && !textArray(context.use_now_memory_ids).includes(rehydrateId),
      "unsafe command posture memories leaked into use_now",
    );

    const standardGuide = await aionis.guide<Record<string, unknown>>({
      query_text: queryText,
      consumer_agent_id: AGENT_ID,
      consumer_team_id: TEAM_ID,
      agent_role: "reviewer",
      context: {
        task_signature: TASK_SIGNATURE,
        workflow_signature: WORKFLOW_SIGNATURE,
      },
      mode: "full_power",
      include_packets: true,
      limit: 10,
    });
    const standardContext = agentContext(agentContextFromGuide(standardGuide), "standard command posture guide");
    const standardPrompt = String(standardContext.prompt_text);
    assertPromptBoundary(standardPrompt, "standard command posture guide");
    assertCondition(
      standardPrompt.includes("execution_contract: SHOULD_CONTINUE is the primary next route when present"),
      "standard command posture prompt missing SHOULD_CONTINUE priority contract",
    );
    assertCondition(
      standardPrompt.includes("INSPECT_FIRST is reference-only evidence and must not replace SHOULD_CONTINUE"),
      "standard command posture prompt missing inspect-only priority contract",
    );

    const adapter = createExecutionMemoryAdapter({
      client: aionis,
      tenant_id: "default",
      scope,
      team_id: TEAM_ID,
      default_agent_id: AGENT_ID,
      default_agent_role: "reviewer",
      default_memory_lane: "shared",
      default_limit: 10,
      default_guide_mode: "full_power",
      include_packets_by_default: true,
    });
    const host = createGenericAgentHostTemplate(adapter, {
      agent_id: AGENT_ID,
      team_id: TEAM_ID,
      role: "reviewer",
      limit: 10,
      include_packets: true,
      mode: "full_power",
      context: {
        task_signature: TASK_SIGNATURE,
        workflow_signature: WORKFLOW_SIGNATURE,
      },
    });

    const hosted = await host.beforeRun<Record<string, unknown>>({
      run_id: `${runId}:host`,
      task_signature: TASK_SIGNATURE,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: queryText,
      context_mode: "compact_agent",
    });
    stringSetIncludes(hosted.should_continue_memory_ids, currentId, "host template should_continue ids");
    stringSetIncludes(hosted.must_not_memory_ids, failedId, "host template must_not ids");
    stringSetIncludes(hosted.inspect_first_memory_ids, contestedId, "host template inspect_first ids");
    stringSetIncludes(hosted.rehydrate_first_memory_ids, rehydrateId, "host template rehydrate_first ids");
    assertCommandPosture(hosted.state.last_command_posture, currentId, "should_continue", "host state command posture");
    assertCommandPosture(hosted.state.last_command_posture, failedId, "must_not", "host state command posture");
    assertCommandPosture(hosted.state.last_command_posture, contestedId, "inspect_first", "host state command posture");
    assertCommandPosture(hosted.state.last_command_posture, rehydrateId, "rehydrate_first", "host state command posture");

    const feedback = await aionis.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide,
      run_id: runId,
      used_memory_ids: [currentId],
      outcome: "positive",
      actor: AGENT_ID,
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: ["command_posture:should_continue"],
      reason: "Command posture e2e host continued the current active state and avoided unsafe histories.",
    }));
    assertCondition(
      asRecord(feedback)?.contract_version === "aionis_feedback_result_v1",
      "command posture feedback returned unexpected contract",
    );

    const measure = await aionis.measure<Record<string, unknown>>(measureInputFromGuideLoop({
      tenant_id: "default",
      scope,
      task: {
        task_id: runId,
        run_id: runId,
        task_signature: TASK_SIGNATURE,
        task_family: "product-e2e",
      },
      before_guide: beforeGuide,
      after_guide: guide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [currentId],
    }));
    assertCondition(
      asRecord(measure)?.contract_version === "aionis_measure_result_v1",
      "command posture measure returned unexpected contract",
    );

    console.log(JSON.stringify({
      ok: true,
      run_id: runId,
      runtime_mode: session.mode,
      memory_ids: {
        should_continue: currentId,
        must_not: failedId,
        inspect_first: contestedId,
        rehydrate_first: rehydrateId,
      },
      guide_trace_id: asRecord(guide)?.guide_trace_id,
      command_posture_count: rows.length,
      host_command_posture_count: hosted.state.last_command_posture.length,
      measure_contract: asRecord(measure)?.contract_version,
    }, null, 2));
  } finally {
    closeRuntime(session);
  }
}

main().catch((error) => {
  process.stderr.write(`${formatE2eError(error)}\n`);
  process.exit(1);
});
