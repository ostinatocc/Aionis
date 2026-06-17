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

async function main() {
  const runId = `admission-dataset-${randomUUID().slice(0, 8)}`;
  const scope = `admission-dataset:${runId}`;
  const session = await openRuntime();
  try {
    const client = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await client.health();

    const beforeGuide = await client.guide<Record<string, unknown>>({
      query_text: `${ACTIVE_MARKER} ${SUPPRESSED_MARKER} before admission dataset export evidence`,
      consumer_agent_id: AGENT_ID,
      limit: 8,
      include_packets: true,
    });
    const beforeContext = agentContext(beforeGuide, "before admission dataset guide");
    assertPromptBoundary(String(beforeContext.prompt_text), "before admission dataset guide");

    const activeMemory = await client.remember<Record<string, unknown>>({
      kind: "project_context",
      client_id: `active-procedure:${runId}`,
      title: "Admission dataset active route",
      text: `${ACTIVE_MARKER}: accepted route is packages/api/src/current-checkout.ts; use this route for the next implementation step.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      target_files: ["packages/api/src/current-checkout.ts"],
      confidence: 0.94,
      slots: {
        source: "admission_dataset_export_e2e",
      },
    });
    const activeMemoryId = firstNodeId(activeMemory, "Admission dataset active route");
    const suppressedMemoryId = await observeMemory({
      client,
      runId,
      clientId: "suppressed-procedure",
      title: "Admission dataset suppressed route",
      text: `${SUPPRESSED_MARKER}: rejected route says to extend legacy/checkout/full-rewrite.ts; this is suppressed and must not be direct-use.`,
      lifecycleState: "suppressed",
      confidence: 0.92,
    });

    const afterGuide = await client.guide<Record<string, unknown>>({
      query_text: `${ACTIVE_MARKER} ${SUPPRESSED_MARKER} continue checkout integration without unsafe route reuse`,
      consumer_agent_id: AGENT_ID,
      limit: 12,
      include_packets: true,
    });
    const afterContext = agentContext(afterGuide, "after admission dataset guide");
    const afterPrompt = String(afterContext.prompt_text);
    assertPromptBoundary(afterPrompt, "after admission dataset guide");

    const useNowIds = textArray(afterContext.use_now_memory_ids);
    const doNotUseIds = textArray(afterContext.do_not_use_memory_ids);
    assertCondition(useNowIds.includes(activeMemoryId), "active memory did not reach use_now");
    assertCondition(doNotUseIds.includes(suppressedMemoryId), "suppressed memory did not reach do_not_use");
    assertCondition(!useNowIds.includes(suppressedMemoryId), "suppressed memory leaked into use_now");
    assertCondition(!afterPrompt.includes("legacy/checkout/full-rewrite.ts"), "suppressed raw path leaked into prompt");

    const feedback = await client.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide: afterGuide,
      reason: "Agent used the accepted route and avoided the suppressed route.",
      run_id: `run:${runId}`,
      outcome: "positive",
      used_memory_ids: [activeMemoryId],
    }));
    const measure = await client.measure<Record<string, unknown>>(measureInputFromGuideLoop({
      task: {
        task_id: `task:${runId}`,
        run_id: `run:${runId}`,
        task_signature: "admission-dataset-export",
        task_family: "memory_admission_dataset",
      },
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${activeMemoryId}`,
        `memory:${suppressedMemoryId}`,
        `feedback:${runId}`,
      ],
    }));

    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    const decisionTrace = asRecord(measure.memory_decision_trace);
    const admissionRecord = asRecord(decisionTrace?.admission_record);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "measure did not return measure result v1");
    assertCondition(historyImpact?.impact_direction === "positive", "measure did not report positive history impact");
    assertCondition(
      admissionRecord?.contract_version === "aionis_memory_admission_record_v1",
      "measure missing memory admission record",
    );

    const rows = memoryAdmissionDatasetRowsFromRecord(admissionRecord as unknown as AionisMemoryAdmissionRecord, {
      run_id: `run:${runId}`,
      task_id: `task:${runId}`,
      task_signature: "admission-dataset-export",
    });
    const jsonl = memoryAdmissionDatasetJsonlFromRows(rows);
    const activeRow = rows.find((entry) => entry.memory_id === activeMemoryId);
    const suppressedRow = rows.find((entry) => entry.memory_id === suppressedMemoryId);
    const lineCount = jsonl.split("\n").filter(Boolean).length;
    assertCondition(rows.length >= 2, "admission dataset export produced too few rows");
    assertCondition(lineCount === rows.length, "admission dataset JSONL line count mismatch");
    assertCondition(activeRow?.outcome_label === "positive_use", "active memory row did not join positive feedback");
    assertCondition(suppressedRow?.outcome_label === "blocked_or_suppressed", "suppressed memory row did not export blocked label");
    assertCondition(!jsonl.includes("prompt_text"), "admission dataset JSONL leaked prompt_text");
    assertCondition(!jsonl.includes("legacy/checkout/full-rewrite.ts"), "admission dataset JSONL leaked suppressed raw memory payload");
    assertCondition(!jsonl.includes("\"slots\""), "admission dataset JSONL leaked raw slots");

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
        row_count: rows.length,
        jsonl_line_count: lineCount,
        positive_use_count: rows.filter((entry) => entry.outcome_label === "positive_use").length,
        blocked_or_suppressed_count: rows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length,
        unused_exposed_count: rows.filter((entry) => entry.outcome_label === "unused_exposed").length,
        prompt_payload_excluded: !jsonl.includes("prompt_text"),
        raw_memory_payload_excluded: !jsonl.includes("legacy/checkout/full-rewrite.ts"),
        raw_slots_excluded: !jsonl.includes("\"slots\""),
        example_jsonl_line: jsonl.split("\n").find(Boolean) ?? null,
      },
      memory_ids: {
        active_memory_id: activeMemoryId,
        suppressed_memory_id: suppressedMemoryId,
      },
      checks: {
        active_memory_used: activeRow?.agent_used === true,
        active_memory_positive_use: activeRow?.outcome_label === "positive_use",
        suppressed_memory_blocked: suppressedRow?.outcome_label === "blocked_or_suppressed",
        suppressed_memory_not_direct_use: suppressedRow?.admission_action === "do_not_use",
        jsonl_line_count_matches_rows: lineCount === rows.length,
        prompt_payload_excluded: !jsonl.includes("prompt_text"),
        raw_memory_payload_excluded: !jsonl.includes("legacy/checkout/full-rewrite.ts"),
        raw_slots_excluded: !jsonl.includes("\"slots\""),
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
