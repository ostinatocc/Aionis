#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAionisClient,
  type AionisExternalMemoryCandidate,
} from "../../src/sdk.ts";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const CURRENT_ID = "mem0:current-checkout-route";
const FAILED_ID = "zep:failed-legacy-route";
const REHYDRATE_ID = "archive:raw-verifier-trace";
const UNKNOWN_ID = "logs:unreviewed-helper-note";

type IncidentScenario = {
  id: string;
  title: string;
  query_text: string;
  feedback_result?: {
    outcome: "positive" | "negative" | "neutral";
    used_memory_ids: string[];
    reason: string;
  };
  expected: {
    attribution_present: boolean;
    blocked_memory_misuse: boolean;
  };
};

type IncidentReplayResult = {
  scenario_id: string;
  verdict: "expected_route_used" | "blocked_memory_used" | "insufficient_feedback";
  prompt_payload_excluded: boolean;
  runtime_mutation: boolean;
  source_coverage: {
    has_agent_context: boolean;
    has_memory_use_receipt: boolean;
    has_memory_admission_record: boolean;
    has_feedback_result: boolean;
  };
  agent_view: {
    use_now_memory_ids: string[];
    inspect_before_use_memory_ids: string[];
    do_not_use_memory_ids: string[];
    rehydrate_memory_ids: string[];
  };
  attribution: {
    present: boolean;
    outcome: string | null;
    used_memory_ids: string[];
  };
  blocked_or_suppressed_ids: string[];
  blocked_memory_misuse_ids: string[];
};

function apiKey(): string | null {
  return process.env.AIONIS_FLIGHT_RECORDER_INCIDENT_API_KEY?.trim()
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function candidate(input: {
  id: string;
  backend: string;
  text: string;
  title: string;
  lifecycle: AionisExternalMemoryCandidate["lifecycle_hint"];
  trust?: "trusted" | "known" | "untrusted" | "unknown";
  evidenceRequirement?: "none" | "inspect_before_use" | "rehydrate_before_use" | "blocked";
  targetFiles?: string[];
  evidenceRefs?: string[];
}): AionisExternalMemoryCandidate {
  return {
    external_memory_id: input.id,
    source_backend: input.backend,
    text: input.text,
    metadata: {
      title: input.title,
      ...(input.targetFiles ? { target_files: input.targetFiles } : {}),
    },
    authority: {
      source_trust: input.trust ?? "trusted",
      scope: "project",
      evidence_requirement: input.evidenceRequirement ?? "none",
    },
    lifecycle_hint: input.lifecycle,
    evidence_refs: input.evidenceRefs ?? [],
  };
}

function candidates(runId: string): AionisExternalMemoryCandidate[] {
  return [
    candidate({
      id: CURRENT_ID,
      backend: "mem0",
      title: "Current checkout route",
      text: "Current accepted route is packages/api/src/checkout.ts. Continue this path.",
      lifecycle: "current",
      targetFiles: ["packages/api/src/checkout.ts"],
    }),
    candidate({
      id: FAILED_ID,
      backend: "zep",
      title: "Failed legacy checkout route",
      text: "The legacy route in src/legacy/checkout.ts failed verifier replay and must not direct action.",
      lifecycle: "failed",
      targetFiles: ["src/legacy/checkout.ts"],
    }),
    candidate({
      id: REHYDRATE_ID,
      backend: "archive",
      title: "Archived raw verifier trace",
      text: "Archived raw verifier trace is available for exact evidence replay.",
      lifecycle: "current",
      evidenceRequirement: "rehydrate_before_use",
      evidenceRefs: [`aionis://flight-recorder/${runId}/raw-verifier-trace`],
    }),
    candidate({
      id: UNKNOWN_ID,
      backend: "logs",
      title: "Unreviewed helper note",
      text: "Unreviewed log note suggests editing checkout helpers, but it has no authority.",
      lifecycle: "unknown",
      trust: "unknown",
      evidenceRequirement: "inspect_before_use",
    }),
  ];
}

function scenarios(): IncidentScenario[] {
  return [
    {
      id: "healthy_current_route_used",
      title: "Healthy replay: Agent used the admitted current route.",
      query_text: "Continue checkout migration from the accepted route.",
      feedback_result: {
        outcome: "positive",
        used_memory_ids: [CURRENT_ID],
        reason: "Agent used the current route and avoided failed or rehydrate-only memories.",
      },
      expected: {
        attribution_present: true,
        blocked_memory_misuse: false,
      },
    },
    {
      id: "incident_blocked_memory_used",
      title: "Incident replay: Agent claims it used a blocked failed route.",
      query_text: "Investigate why the Agent returned to the failed legacy route.",
      feedback_result: {
        outcome: "negative",
        used_memory_ids: [FAILED_ID],
        reason: "Agent action matched the failed legacy route even though Aionis had blocked it.",
      },
      expected: {
        attribution_present: true,
        blocked_memory_misuse: true,
      },
    },
    {
      id: "incident_missing_feedback",
      title: "Incomplete replay: operator did not supply feedback attribution.",
      query_text: "Replay the decision with no post-run attribution attached.",
      expected: {
        attribution_present: false,
        blocked_memory_misuse: false,
      },
    },
  ];
}

function verdictFor(args: {
  attributionPresent: boolean;
  blockedMemoryMisuseIds: string[];
}): IncidentReplayResult["verdict"] {
  if (!args.attributionPresent) return "insufficient_feedback";
  if (args.blockedMemoryMisuseIds.length > 0) return "blocked_memory_used";
  return "expected_route_used";
}

function summarize(results: IncidentReplayResult[]) {
  const incidentRows = results.filter((row) => row.verdict === "blocked_memory_used");
  const missingFeedbackRows = results.filter((row) => row.verdict === "insufficient_feedback");
  return {
    scenario_count: results.length,
    prompt_payload_excluded_count: results.filter((row) => row.prompt_payload_excluded).length,
    runtime_mutation_count: results.filter((row) => row.runtime_mutation).length,
    blocked_memory_misuse_detected_count: incidentRows.length,
    missing_feedback_detected_count: missingFeedbackRows.length,
    replay_source_coverage_count: results.filter((row) =>
      row.source_coverage.has_agent_context
      && row.source_coverage.has_memory_use_receipt
      && row.source_coverage.has_memory_admission_record,
    ).length,
  };
}

async function runScenario(args: {
  aionis: ReturnType<typeof createAionisClient>;
  runId: string;
  scenario: IncidentScenario;
}): Promise<IncidentReplayResult> {
  const scenarioRunId = `${args.runId}:${args.scenario.id}`;
  const governed = await args.aionis.governMemory<Record<string, unknown>>({
    run_id: scenarioRunId,
    query_text: args.scenario.query_text,
    mode: "firewall",
    context_mode: "compact_agent",
    include_records: true,
    candidates: candidates(args.runId),
  });

  const agentContext = asRecord(governed.agent_context);
  const promptText = String(agentContext?.prompt_text ?? "");
  const replay = await args.aionis.flightRecorder<Record<string, unknown>>({
    run_id: scenarioRunId,
    decision_time: "2026-06-14T00:00:00.000Z",
    agent_context: agentContext,
    memory_use_receipt: governed.memory_use_receipt,
    memory_admission_record: governed.memory_admission_records,
    feedback_result: args.scenario.feedback_result
      ? {
          run_id: scenarioRunId,
          used_surface: "explicit_host_assertion",
          ...args.scenario.feedback_result,
        }
      : {},
  });

  const report = asRecord(replay.agent_flight_recorder);
  const agentView = asRecord(report?.agent_view);
  const attribution = asRecord(report?.attribution);
  const replaySources = asRecord(report?.replay_sources);
  const blockedRows = recordArray(report?.blocked_or_suppressed);
  const useNowIds = textArray(agentView?.use_now_memory_ids);
  const inspectIds = textArray(agentView?.inspect_before_use_memory_ids);
  const doNotUseIds = textArray(agentView?.do_not_use_memory_ids);
  const rehydrateIds = textArray(agentView?.rehydrate_memory_ids);
  const usedIds = textArray(attribution?.used_memory_ids);
  const blockedIds = unique([
    ...doNotUseIds,
    ...blockedRows
      .map((row) => row.memory_id)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  ]);
  const blockedMemoryMisuseIds = usedIds.filter((id) => blockedIds.includes(id));
  const attributionPresent = attribution?.present === true;

  assertCondition(replay.contract_version === "aionis_agent_flight_recorder_result_v1", `${args.scenario.id} missing flight recorder result contract`);
  assertCondition(report?.contract_version === "aionis_agent_flight_recorder_report_v1", `${args.scenario.id} missing flight recorder report contract`);
  assertCondition(report?.agent_prompt_included === false, `${args.scenario.id} included prompt payload`);
  assertCondition(report?.runtime_mutation === false, `${args.scenario.id} mutated Runtime state`);
  assertCondition(agentView?.prompt_text_included === false, `${args.scenario.id} included prompt text in agent_view`);
  assertCondition(!String(JSON.stringify(report)).includes(promptText), `${args.scenario.id} leaked prompt text into incident report`);
  assertCondition(useNowIds.includes(CURRENT_ID), `${args.scenario.id} did not replay admitted current memory`);
  assertCondition(doNotUseIds.includes(FAILED_ID), `${args.scenario.id} did not replay blocked failed memory`);
  assertCondition(rehydrateIds.includes(REHYDRATE_ID), `${args.scenario.id} did not replay rehydrate pointer`);
  assertCondition(inspectIds.includes(UNKNOWN_ID), `${args.scenario.id} did not replay inspect-first unknown memory`);
  assertCondition(blockedRows.some((row) => row.memory_id === FAILED_ID), `${args.scenario.id} did not expose blocked failed memory to operator`);
  assertCondition(attributionPresent === args.scenario.expected.attribution_present, `${args.scenario.id} attribution presence mismatch`);
  assertCondition(
    (blockedMemoryMisuseIds.length > 0) === args.scenario.expected.blocked_memory_misuse,
    `${args.scenario.id} blocked-memory misuse detection mismatch`,
  );

  return {
    scenario_id: args.scenario.id,
    verdict: verdictFor({ attributionPresent, blockedMemoryMisuseIds }),
    prompt_payload_excluded: report?.agent_prompt_included === false && agentView?.prompt_text_included === false,
    runtime_mutation: report?.runtime_mutation === true,
    source_coverage: {
      has_agent_context: replaySources?.has_agent_context === true,
      has_memory_use_receipt: replaySources?.has_memory_use_receipt === true,
      has_memory_admission_record: replaySources?.has_memory_admission_record === true,
      has_feedback_result: replaySources?.has_feedback_result === true,
    },
    agent_view: {
      use_now_memory_ids: useNowIds,
      inspect_before_use_memory_ids: inspectIds,
      do_not_use_memory_ids: doNotUseIds,
      rehydrate_memory_ids: rehydrateIds,
    },
    attribution: {
      present: attributionPresent,
      outcome: typeof attribution?.outcome === "string" ? attribution.outcome : null,
      used_memory_ids: usedIds,
    },
    blocked_or_suppressed_ids: blockedIds,
    blocked_memory_misuse_ids: blockedMemoryMisuseIds,
  };
}

async function main() {
  const runId = `flight-recorder-incident-${randomUUID().slice(0, 8)}`;
  const scope = `flight-recorder-incident:${runId}`;
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const scenarioRows = scenarios();
    const incidentResults: IncidentReplayResult[] = [];
    for (const scenario of scenarioRows) {
      incidentResults.push(await runScenario({ aionis, runId, scenario }));
    }
    const summary = summarize(incidentResults);

    assertCondition(summary.prompt_payload_excluded_count === scenarioRows.length, "Flight Recorder incident demo leaked prompt payload");
    assertCondition(summary.runtime_mutation_count === 0, "Flight Recorder incident demo mutated Runtime state");
    assertCondition(summary.blocked_memory_misuse_detected_count === 1, "Flight Recorder incident demo did not detect blocked-memory misuse");
    assertCondition(summary.missing_feedback_detected_count === 1, "Flight Recorder incident demo did not detect missing feedback attribution");
    assertCondition(summary.replay_source_coverage_count === scenarioRows.length, "Flight Recorder incident demo lost replay source coverage");

    const result = {
      contract_version: "aionis_flight_recorder_incident_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_claim:
        "Agent Flight Recorder reconstructs what memory was admitted, blocked, rehydrate-only, and actually attributed after a run.",
      methodology: {
        scenario_count: scenarioRows.length,
        product_loop: "governMemory(mode=firewall) -> simulated agent attribution -> flightRecorder",
        runtime_api: "POST /v1/audit/flight-recorder",
        prompt_payload_policy: "The incident report excludes agent_context.prompt_text and raw memory payloads.",
      },
      summary,
      incidents: incidentResults,
      checks: {
        blocked_memory_misuse_detected: summary.blocked_memory_misuse_detected_count === 1,
        missing_feedback_detected: summary.missing_feedback_detected_count === 1,
        prompt_payload_excluded: summary.prompt_payload_excluded_count === scenarioRows.length,
        replay_sources_present: summary.replay_source_coverage_count === scenarioRows.length,
        no_runtime_mutation: summary.runtime_mutation_count === 0,
      },
      boundary:
        "This demo audits post-run memory attribution. It does not prove the Agent obeyed Aionis during execution; it proves the operator can replay admission state and detect misuse claims after the run.",
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
