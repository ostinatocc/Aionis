#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAionisClient,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  measureInputFromGuideLoop,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryAdmissionDatasetRow,
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

const AGENT_ID = "admission-dataset-agent";
const ACTIVE_MARKER = "ADMISSION_DATASET_ACTIVE_ROUTE";
const SUPPRESSED_MARKER = "ADMISSION_DATASET_SUPPRESSED_ROUTE";

type AionisClient = ReturnType<typeof createAionisClient>;
type AdmissionOutcome = "positive" | "negative";
type AdmissionOutcomeLabel = "positive_use" | "negative_use";

type AdmissionRoundSpec = {
  round_id: string;
  scope: string;
  active_marker: string;
  suppressed_marker: string;
  active_text: string;
  suppressed_text: string;
  suppressed_payload_marker: string;
  outcome: AdmissionOutcome;
  expected_outcome_label: AdmissionOutcomeLabel;
  reason: string;
};

type AdmissionRoundResult = {
  round_id: string;
  scope: string;
  run_id: string;
  task_id: string;
  task_signature: string;
  active_memory_id: string;
  suppressed_memory_id: string;
  row_count: number;
  jsonl_line_count: number;
  outcome_label_count: number;
  blocked_or_suppressed_count: number;
  prompt_payload_excluded: boolean;
  raw_memory_payload_excluded: boolean;
  raw_slots_excluded: boolean;
  rows: AionisMemoryAdmissionDatasetRow[];
};

function apiKey(): string | null {
  return process.env.AIONIS_ADMISSION_DATASET_E2E_API_KEY?.trim()
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

function agentContext(guide: unknown, label: string): Record<string, unknown> {
  const context = asRecord(asRecord(guide)?.agent_context);
  assertCondition(context?.contract_version === "aionis_agent_context_v1", `${label} missing agent_context v1`);
  assertCondition(typeof context.prompt_text === "string" && context.prompt_text.length > 0, `${label} missing prompt_text`);
  return context;
}

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "memory_use_receipt",
    "decision_summaries",
    "raw_memory_rows",
    "raw_slots",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

async function observeMemory(args: {
  client: AionisClient;
  runId: string;
  clientId: string;
  title: string;
  text: string;
  lifecycleState: "active" | "suppressed";
  confidence: number;
}): Promise<string> {
  const observed = await args.client.observe<Record<string, unknown>>({
    auto_embed: true,
    input_text: args.text,
    memory_kind: "general_memory",
    memory_lane: "private",
    owner_agent_id: AGENT_ID,
    memory: {
      client_id: `${args.clientId}:${args.runId}`,
      type: "concept",
      memory_kind: "general_memory",
      title: args.title,
      text_summary: args.text,
      confidence: args.confidence,
      slots: {
        lifecycle_state: args.lifecycleState,
        state: args.lifecycleState,
        memory_kind: "general_memory",
        source: "admission_dataset_export_e2e",
      },
    },
  });
  return firstNodeId(observed, args.title);
}

async function runAdmissionRound(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  spec: AdmissionRoundSpec;
}): Promise<AdmissionRoundResult> {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.spec.scope,
  });
  await client.health();

  const beforeGuide = await client.guide<Record<string, unknown>>({
    query_text: `${args.spec.active_marker} ${args.spec.suppressed_marker} before admission dataset export evidence`,
    consumer_agent_id: AGENT_ID,
    limit: 8,
    include_packets: true,
  });
  const beforeContext = agentContext(beforeGuide, `${args.spec.round_id} before admission dataset guide`);
  assertPromptBoundary(String(beforeContext.prompt_text), `${args.spec.round_id} before admission dataset guide`);

  const activeMemory = await client.remember<Record<string, unknown>>({
    kind: "project_context",
    client_id: `${args.spec.round_id}:active-procedure:${args.runId}`,
    title: `Admission dataset active route ${args.spec.round_id}`,
    text: args.spec.active_text,
    memory_lane: "private",
    owner_agent_id: AGENT_ID,
    target_files: ["packages/api/src/current-checkout.ts"],
    confidence: 0.94,
    slots: {
      source: "admission_dataset_export_e2e",
      admission_round_id: args.spec.round_id,
    },
  });
  const activeMemoryId = firstNodeId(activeMemory, `Admission dataset active route ${args.spec.round_id}`);
  const suppressedMemoryId = await observeMemory({
    client,
    runId: args.runId,
    clientId: `${args.spec.round_id}:suppressed-procedure`,
    title: `Admission dataset suppressed route ${args.spec.round_id}`,
    text: args.spec.suppressed_text,
    lifecycleState: "suppressed",
    confidence: 0.92,
  });

  const afterGuide = await client.guide<Record<string, unknown>>({
    query_text: `${args.spec.active_marker} ${args.spec.suppressed_marker} continue checkout integration without unsafe route reuse`,
    consumer_agent_id: AGENT_ID,
    limit: 12,
    include_packets: true,
  });
  const afterContext = agentContext(afterGuide, `${args.spec.round_id} after admission dataset guide`);
  const afterPrompt = String(afterContext.prompt_text);
  assertPromptBoundary(afterPrompt, `${args.spec.round_id} after admission dataset guide`);

  const useNowIds = textArray(afterContext.use_now_memory_ids);
  const doNotUseIds = textArray(afterContext.do_not_use_memory_ids);
  assertCondition(useNowIds.includes(activeMemoryId), `${args.spec.round_id} active memory did not reach use_now`);
  assertCondition(doNotUseIds.includes(suppressedMemoryId), `${args.spec.round_id} suppressed memory did not reach do_not_use`);
  assertCondition(!useNowIds.includes(suppressedMemoryId), `${args.spec.round_id} suppressed memory leaked into use_now`);
  assertCondition(!afterPrompt.includes(args.spec.suppressed_payload_marker), `${args.spec.round_id} suppressed raw payload leaked into prompt`);

  const feedback = await client.feedback<Record<string, unknown>>(feedbackFromGuide({
    guide: afterGuide,
    reason: args.spec.reason,
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    outcome: args.spec.outcome,
    used_memory_ids: [activeMemoryId],
  }));
  const taskId = `task:${args.runId}:${args.spec.round_id}`;
  const taskSignature = `admission-dataset-export:${args.spec.round_id}`;
  const measure = await client.measure<Record<string, unknown>>(measureInputFromGuideLoop({
    task: {
      task_id: taskId,
      run_id: `run:${args.runId}:${args.spec.round_id}`,
      task_signature: taskSignature,
      task_family: "memory_admission_dataset",
    },
    before_guide: beforeGuide,
    after_guide: afterGuide,
    feedback_result: feedback,
    sufficient_evidence: true,
    evidence_ids: [
      `memory:${activeMemoryId}`,
      `memory:${suppressedMemoryId}`,
      `feedback:${args.runId}:${args.spec.round_id}`,
    ],
  }));

  const decisionTrace = asRecord(measure.memory_decision_trace);
  const admissionRecord = asRecord(decisionTrace?.admission_record);
  assertCondition(measure.contract_version === "aionis_measure_result_v1", `${args.spec.round_id} measure did not return measure result v1`);
  assertCondition(
    admissionRecord?.contract_version === "aionis_memory_admission_record_v1",
    `${args.spec.round_id} measure missing memory admission record`,
  );

  const rows = memoryAdmissionDatasetRowsFromRecord(admissionRecord as unknown as AionisMemoryAdmissionRecord, {
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    task_id: taskId,
    task_signature: taskSignature,
  });
  const jsonl = memoryAdmissionDatasetJsonlFromRows(rows);
  const activeRow = rows.find((entry) => entry.memory_id === activeMemoryId);
  const suppressedRow = rows.find((entry) => entry.memory_id === suppressedMemoryId);
  const lineCount = jsonl.split("\n").filter(Boolean).length;
  assertCondition(rows.length >= 2, `${args.spec.round_id} admission dataset export produced too few rows`);
  assertCondition(lineCount === rows.length, `${args.spec.round_id} admission dataset JSONL line count mismatch`);
  assertCondition(activeRow?.outcome_label === args.spec.expected_outcome_label, `${args.spec.round_id} active memory row did not join ${args.spec.expected_outcome_label}`);
  assertCondition(suppressedRow?.outcome_label === "blocked_or_suppressed", `${args.spec.round_id} suppressed memory row did not export blocked label`);
  assertCondition(!jsonl.includes("prompt_text"), `${args.spec.round_id} admission dataset JSONL leaked prompt_text`);
  assertCondition(!jsonl.includes(args.spec.suppressed_payload_marker), `${args.spec.round_id} admission dataset JSONL leaked suppressed raw memory payload`);
  assertCondition(!jsonl.includes("\"slots\""), `${args.spec.round_id} admission dataset JSONL leaked raw slots`);

  return {
    round_id: args.spec.round_id,
    scope: args.spec.scope,
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    task_id: taskId,
    task_signature: taskSignature,
    active_memory_id: activeMemoryId,
    suppressed_memory_id: suppressedMemoryId,
    row_count: rows.length,
    jsonl_line_count: lineCount,
    outcome_label_count: rows.filter((entry) => entry.outcome_label === args.spec.expected_outcome_label).length,
    blocked_or_suppressed_count: rows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length,
    prompt_payload_excluded: !jsonl.includes("prompt_text"),
    raw_memory_payload_excluded: !jsonl.includes(args.spec.suppressed_payload_marker),
    raw_slots_excluded: !jsonl.includes("\"slots\""),
    rows,
  };
}

async function main() {
  const runId = `admission-dataset-${randomUUID().slice(0, 8)}`;
  const baseScope = `admission-dataset:${runId}`;
  const session = await openRuntime();
  try {
    const specs: AdmissionRoundSpec[] = [
      {
        round_id: "positive-supported",
        scope: `${baseScope}:positive-supported`,
        active_marker: ACTIVE_MARKER,
        suppressed_marker: SUPPRESSED_MARKER,
        active_text: `${ACTIVE_MARKER}: accepted route is packages/api/src/current-checkout.ts; use this route for the next implementation step.`,
        suppressed_text: `${SUPPRESSED_MARKER}: rejected route says to extend legacy/checkout/full-rewrite.ts; this is suppressed and must not be direct-use.`,
        suppressed_payload_marker: "legacy/checkout/full-rewrite.ts",
        outcome: "positive",
        expected_outcome_label: "positive_use",
        reason: "Agent used the accepted route and avoided the suppressed route.",
      },
      {
        round_id: "negative-attributed",
        scope: `${baseScope}:negative-attributed`,
        active_marker: "ADMISSION_DATASET_NEGATIVE_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_OLD_API",
        active_text: "ADMISSION_DATASET_NEGATIVE_ROUTE: candidate route is packages/api/src/billing-adapter.ts; expose it so negative feedback can be attributed.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_OLD_API: rejected route says to extend legacy/billing/dead-end.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/billing/dead-end.ts",
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed candidate route but verifier outcome was negative.",
      },
    ];

    const rounds: AdmissionRoundResult[] = [];
    for (const spec of specs) {
      rounds.push(await runAdmissionRound({
        baseUrl: session.baseUrl,
        apiKey: apiKey(),
        runId,
        spec,
      }));
    }

    const allRows = rounds.flatMap((round) => round.rows);
    const appendedJsonl = memoryAdmissionDatasetJsonlFromRows(allRows);
    const appendedLineCount = appendedJsonl.split("\n").filter(Boolean).length;
    const positiveUseCount = allRows.filter((entry) => entry.outcome_label === "positive_use").length;
    const negativeUseCount = allRows.filter((entry) => entry.outcome_label === "negative_use").length;
    const blockedOrSuppressedCount = allRows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length;
    assertCondition(appendedLineCount === allRows.length, "appendable admission dataset JSONL line count mismatch");
    assertCondition(positiveUseCount >= 1, "appendable admission dataset missing positive_use row");
    assertCondition(negativeUseCount >= 1, "appendable admission dataset missing negative_use row");
    assertCondition(blockedOrSuppressedCount >= 2, "appendable admission dataset missing blocked_or_suppressed rows");
    assertCondition(!appendedJsonl.includes("prompt_text"), "appendable admission dataset JSONL leaked prompt_text");
    assertCondition(!appendedJsonl.includes("legacy/checkout/full-rewrite.ts"), "appendable admission dataset JSONL leaked checkout suppressed payload");
    assertCondition(!appendedJsonl.includes("legacy/billing/dead-end.ts"), "appendable admission dataset JSONL leaked billing suppressed payload");
    assertCondition(!appendedJsonl.includes("\"slots\""), "appendable admission dataset JSONL leaked raw slots");

    const result = {
      contract_version: "aionis_admission_dataset_export_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_loop: {
        path: "remember/observe -> guide -> feedback -> measure -> admission dataset JSONL export",
        source_record: "memory_decision_trace.admission_record",
        dataset_export_runtime_mutation: false,
      },
      admission_dataset_export: {
        row_contract_version: "aionis_memory_admission_dataset_row_v1",
        policy_id: allRows[0]?.policy_id ?? null,
        policy_version: allRows[0]?.policy_version ?? null,
        policy_mode: allRows[0]?.policy_mode ?? null,
        runtime_version: allRows[0]?.runtime_version ?? null,
        row_count: allRows.length,
        jsonl_line_count: appendedLineCount,
        positive_use_count: positiveUseCount,
        negative_use_count: negativeUseCount,
        blocked_or_suppressed_count: blockedOrSuppressedCount,
        unused_exposed_count: allRows.filter((entry) => entry.outcome_label === "unused_exposed").length,
        prompt_payload_excluded: !appendedJsonl.includes("prompt_text"),
        raw_memory_payload_excluded: !appendedJsonl.includes("legacy/checkout/full-rewrite.ts")
          && !appendedJsonl.includes("legacy/billing/dead-end.ts"),
        raw_slots_excluded: !appendedJsonl.includes("\"slots\""),
        append_mode: "jsonl_append",
        append_chunk_count: rounds.length,
        append_chunks: rounds.map((round, index) => ({
          round_id: round.round_id,
          run_id: round.run_id,
          task_id: round.task_id,
          scope: round.scope,
          row_offset_start: rounds.slice(0, index).reduce((sum, entry) => sum + entry.row_count, 0),
          row_offset_end: rounds.slice(0, index + 1).reduce((sum, entry) => sum + entry.row_count, 0),
          row_count: round.row_count,
          jsonl_line_count: round.jsonl_line_count,
        })),
        example_jsonl_line: appendedJsonl.split("\n").find(Boolean) ?? null,
      },
      rounds: rounds.map(({ rows: _rows, ...round }) => round),
      checks: {
        appendable_jsonl_line_count_matches_rows: appendedLineCount === allRows.length,
        positive_use_exported: positiveUseCount >= 1,
        negative_use_exported: negativeUseCount >= 1,
        blocked_or_suppressed_exported: blockedOrSuppressedCount >= 2,
        prompt_payload_excluded: !appendedJsonl.includes("prompt_text"),
        raw_memory_payload_excluded: !appendedJsonl.includes("legacy/checkout/full-rewrite.ts")
          && !appendedJsonl.includes("legacy/billing/dead-end.ts"),
        raw_slots_excluded: !appendedJsonl.includes("\"slots\""),
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
