#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAionisClient } from "../../src/sdk.ts";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const CURRENT_ID = "mem0:current-route";
const FAILED_ID = "zep:failed-route";
const REHYDRATE_ID = "archive:raw-evidence";

function apiKey(): string | null {
  return process.env.AIONIS_FLIGHT_RECORDER_QUICKSTART_API_KEY?.trim()
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

async function main() {
  const runId = `flight-recorder-${randomUUID().slice(0, 8)}`;
  const scope = `flight-recorder:${runId}`;
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const governed = await aionis.governMemory<Record<string, unknown>>({
      run_id: runId,
      query_text: "Replay the Agent decision after governing external memory.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates: [
        {
          external_memory_id: CURRENT_ID,
          source_backend: "mem0",
          text: "Current accepted target is packages/api/src/checkout.ts.",
          metadata: {
            title: "Current checkout route",
            target_files: ["packages/api/src/checkout.ts"],
          },
          authority: {
            source_trust: "trusted",
            scope: "project",
            evidence_requirement: "none",
          },
          lifecycle_hint: "current",
        },
        {
          external_memory_id: FAILED_ID,
          source_backend: "zep",
          text: "The broad legacy route failed verifier checks and must not direct action.",
          metadata: {
            title: "Failed broad route",
            target_files: ["src/legacy/checkout.ts"],
          },
          authority: {
            source_trust: "trusted",
            scope: "project",
            evidence_requirement: "none",
          },
          lifecycle_hint: "failed",
        },
        {
          external_memory_id: REHYDRATE_ID,
          source_backend: "archive",
          text: "Archived raw verifier trace pointer for exact replay.",
          metadata: {
            title: "Archived verifier trace",
          },
          authority: {
            source_trust: "trusted",
            scope: "project",
            evidence_requirement: "rehydrate_before_use",
          },
          lifecycle_hint: "current",
          evidence_refs: [`aionis://archives/${runId}/verifier-trace`],
        },
      ],
    });

    const agentContext = asRecord(governed.agent_context);
    const promptText = String(agentContext?.prompt_text ?? "");
    const feedbackResult = {
      run_id: runId,
      outcome: "positive",
      used_surface: "use_now",
      used_memory_ids: [CURRENT_ID],
      reason: "Agent used the current route and avoided the failed branch.",
    };

    const replay = await aionis.flightRecorder<Record<string, unknown>>({
      run_id: runId,
      decision_time: "2026-06-14T00:00:00.000Z",
      agent_context: agentContext,
      memory_use_receipt: governed.memory_use_receipt,
      memory_admission_record: governed.memory_admission_records,
      feedback_result: feedbackResult,
    });

    const report = asRecord(replay.agent_flight_recorder);
    const agentView = asRecord(report?.agent_view);
    const attribution = asRecord(report?.attribution);
    const replaySources = asRecord(report?.replay_sources);
    const blocked = recordArray(report?.blocked_or_suppressed);
    const useNowIds = textArray(agentView?.use_now_memory_ids);
    const doNotUseIds = textArray(agentView?.do_not_use_memory_ids);
    const rehydrateIds = textArray(agentView?.rehydrate_memory_ids);
    const usedIds = textArray(attribution?.used_memory_ids);

    assertCondition(replay.contract_version === "aionis_agent_flight_recorder_result_v1", "Flight Recorder quickstart missing result contract");
    assertCondition(report?.contract_version === "aionis_agent_flight_recorder_report_v1", "Flight Recorder report missing contract");
    assertCondition(report?.agent_prompt_included === false, "Flight Recorder report included Agent prompt");
    assertCondition(report?.runtime_mutation === false, "Flight Recorder mutated Runtime state");
    assertCondition(agentView?.prompt_text_included === false, "Flight Recorder agent_view included prompt text");
    assertCondition(useNowIds.includes(CURRENT_ID), "Flight Recorder did not replay direct-use memory");
    assertCondition(doNotUseIds.includes(FAILED_ID), "Flight Recorder did not replay blocked memory");
    assertCondition(rehydrateIds.includes(REHYDRATE_ID), "Flight Recorder did not replay rehydrate pointer");
    assertCondition(blocked.some((entry) => entry.memory_id === FAILED_ID), "Flight Recorder blocked/suppressed list missed failed memory");
    assertCondition(attribution?.present === true, "Flight Recorder did not mark feedback attribution present");
    assertCondition(attribution?.outcome === "positive", "Flight Recorder did not replay positive outcome");
    assertCondition(usedIds.includes(CURRENT_ID), "Flight Recorder did not replay used memory ID");
    assertCondition(replaySources?.has_agent_context === true, "Flight Recorder did not record agent_context source");
    assertCondition(replaySources?.has_memory_use_receipt === true, "Flight Recorder did not record receipt source");
    assertCondition(replaySources?.has_memory_admission_record === true, "Flight Recorder did not record admission record source");
    assertCondition(replaySources?.has_feedback_result === true, "Flight Recorder did not record feedback source");
    assertCondition(!String(JSON.stringify(report)).includes(promptText), "Flight Recorder leaked prompt text");

    const result = {
      contract_version: "aionis_flight_recorder_quickstart_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      integration_path: {
        sdk_client: "createAionisClient",
        product_loop: "governMemory -> agent action -> flightRecorder",
        route: "POST /v1/audit/flight-recorder",
      },
      agent_view: {
        prompt_text_included: agentView?.prompt_text_included,
        use_now_memory_ids: useNowIds,
        do_not_use_memory_ids: doNotUseIds,
        rehydrate_memory_ids: rehydrateIds,
      },
      incident_replay: {
        blocked_or_suppressed_count: blocked.length,
        attribution_present: attribution?.present,
        outcome: attribution?.outcome,
        used_memory_ids: usedIds,
        runtime_mutation: report?.runtime_mutation,
        agent_prompt_included: report?.agent_prompt_included,
      },
      replay_sources: {
        has_agent_context: replaySources?.has_agent_context,
        has_memory_use_receipt: replaySources?.has_memory_use_receipt,
        has_memory_admission_record: replaySources?.has_memory_admission_record,
        has_feedback_result: replaySources?.has_feedback_result,
      },
      checks: {
        direct_use_replayed: useNowIds.includes(CURRENT_ID),
        blocked_memory_replayed: blocked.some((entry) => entry.memory_id === FAILED_ID),
        rehydrate_pointer_replayed: rehydrateIds.includes(REHYDRATE_ID),
        feedback_attribution_replayed: attribution?.present === true && usedIds.includes(CURRENT_ID),
        prompt_payload_excluded: report?.agent_prompt_included === false && agentView?.prompt_text_included === false,
        no_runtime_mutation: report?.runtime_mutation === false,
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
