#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAionisClient,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  memoryAdmissionDatasetRowsWithClosedLoopPrior,
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
import { collectAdmissionDatasetRows } from "../../src/memory/admission-dataset-collector.ts";

const AGENT_ID = "admission-dataset-agent";
const ACTIVE_MARKER = "ADMISSION_DATASET_ACTIVE_ROUTE";
const SUPPRESSED_MARKER = "ADMISSION_DATASET_SUPPRESSED_ROUTE";

type AionisClient = ReturnType<typeof createAionisClient>;
type AdmissionOutcome = "positive" | "negative";
type AdmissionOutcomeLabel = "positive_use" | "negative_use";
type AdmissionDatasetExportProfile =
  | "standard"
  | "targeted-external-current"
  | "closed-loop-prior"
  | "closed-loop-prior-fresh"
  | "closed-loop-prior-fresh-2";

type AdmissionRoundSpec = {
  round_id: string;
  scope: string;
  active_marker: string;
  suppressed_marker: string;
  active_text: string;
  suppressed_text: string;
  suppressed_payload_marker: string;
  query_text: string;
  target_files: string[];
  outcome: AdmissionOutcome;
  expected_outcome_label: AdmissionOutcomeLabel;
  reason: string;
};

type AdmissionExternalRehydrateSpec = {
  round_id: string;
  scope: string;
  current_id: string;
  blocked_id: string;
  rehydrate_id: string;
  current_text: string;
  blocked_text: string;
  rehydrate_text: string;
  blocked_payload_marker: string;
  rehydrate_payload_marker: string;
  query_text: string;
  target_files: string[];
};

type AdmissionClosedLoopPriorSpec = {
  round_id: string;
  scope: string;
  marker: string;
  text: string;
  query_text: string;
  target_files: string[];
  outcomes: AdmissionOutcome[];
  expected_state_on_last_row: AionisMemoryAdmissionDatasetRow["closed_loop_effect_state"];
  expected_repeated_negative_posture_on_last_row: boolean;
};

type AdmissionRoundResult = {
  round_id: string;
  scope: string;
  run_id: string;
  task_id: string;
  task_signature: string;
  active_memory_id: string | null;
  suppressed_memory_id: string | null;
  rehydrate_memory_id: string | null;
  row_count: number;
  jsonl_line_count: number;
  outcome_label_count: number;
  blocked_or_suppressed_count: number;
  rehydrate_requested_count: number;
  prompt_payload_excluded: boolean;
  raw_memory_payload_excluded: boolean;
  raw_slots_excluded: boolean;
  rows: AionisMemoryAdmissionDatasetRow[];
};

type CliArgs = {
  datasetDir: string | null;
  chunkId: string | null;
  outJsonl: string | null;
  profile: AdmissionDatasetExportProfile;
};

function apiKey(): string | null {
  return process.env.AIONIS_ADMISSION_DATASET_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function parseArgs(argv: string[]): CliArgs {
  const envProfile = process.env.AIONIS_ADMISSION_DATASET_PROFILE;
  const out: CliArgs = {
    datasetDir: process.env.AIONIS_ADMISSION_DATASET_DIR?.trim() || null,
    chunkId: process.env.AIONIS_ADMISSION_DATASET_CHUNK_ID?.trim() || null,
    outJsonl: process.env.AIONIS_ADMISSION_DATASET_OUT_JSONL?.trim() || null,
    profile: envProfile === "targeted-external-current"
      || envProfile === "closed-loop-prior"
      || envProfile === "closed-loop-prior-fresh"
      || envProfile === "closed-loop-prior-fresh-2"
      ? envProfile
      : "standard",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--dataset-dir" && next) {
      out.datasetDir = next;
      i += 1;
    } else if (arg === "--chunk-id" && next) {
      out.chunkId = next;
      i += 1;
    } else if (arg === "--out-jsonl" && next) {
      out.outJsonl = next;
      i += 1;
    } else if (arg === "--profile" && next) {
      out.profile = next === "targeted-external-current"
        || next === "closed-loop-prior"
        || next === "closed-loop-prior-fresh"
        || next === "closed-loop-prior-fresh-2"
        ? next
        : "standard";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s runtime:e2e:admission-dataset-export -- [--dataset-dir admission-dataset] [--chunk-id run-001] [--profile standard|targeted-external-current|closed-loop-prior|closed-loop-prior-fresh|closed-loop-prior-fresh-2]",
        "",
        "Runs the real Runtime guide/feedback/measure loop. When --dataset-dir is set,",
        "the exported admission rows are appended through admission:collect semantics.",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

export function admissionDatasetTargetedExternalCurrentSpecs(args: {
  runId: string;
  baseScope: string;
}): AdmissionExternalRehydrateSpec[] {
  return [
    ["recall-engine", "packages/recall/src/hybrid-candidates.ts"],
    ["memory-firewall", "packages/firewall/src/external-admission.ts"],
    ["operator-snapshot", "packages/operator/src/snapshot-export.ts"],
    ["admission-ledger", "packages/admission/src/ledger-export.ts"],
    ["controlled-forgetting", "packages/forgetting/src/retention-policy.ts"],
    ["plan-asset", "packages/plans/src/plan-memory-asset.ts"],
    ["external-backend", "packages/backends/src/external-memory-adapter.ts"],
    ["audit-export", "packages/audit/src/admission-dataset-export.ts"],
    ["rehydrate-pointer", "packages/rehydrate/src/pointer-contract.ts"],
    ["sdk-contract", "packages/sdk/src/admission-contract.ts"],
    ["workflow-projection", "packages/workflow/src/projection.ts"],
    ["project-settings", "packages/settings/src/project-context.ts"],
  ].map(([suffix, targetFile]) => {
    const roundId = `targeted-external-current-${suffix}`;
    return {
      round_id: roundId,
      scope: `${args.baseScope}:${roundId}`,
      current_id: `mem0:targeted-current:${suffix}:${args.runId}`,
      blocked_id: `zep:targeted-suppressed:${suffix}:${args.runId}`,
      rehydrate_id: `archive:targeted-pointer:${suffix}:${args.runId}`,
      current_text: `Current external context for ${suffix} points to ${targetFile}; it is relevant but should be evaluated by admission policy before direct action.`,
      blocked_text: `Suppressed external context for ${suffix} says to revive legacy/${suffix}/unsafe-route.ts; this route is blocked and must not be direct-use.`,
      rehydrate_text: `Pointer-only external evidence for ${suffix}; exact payload requires rehydrate before relying on implementation details.`,
      blocked_payload_marker: `ADMISSION_DATASET_TARGETED_BLOCKED_${suffix.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PAYLOAD_SHOULD_NOT_EXPORT`,
      rehydrate_payload_marker: `ADMISSION_DATASET_TARGETED_REHYDRATE_${suffix.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PAYLOAD_SHOULD_NOT_EXPORT`,
      query_text: `continue ${suffix} work with external current context available but without using blocked legacy evidence`,
      target_files: [targetFile],
    };
  });
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

function excludesAll(text: string, values: string[]): boolean {
  return values.every((value) => !text.includes(value));
}

function rawPayloadMarkers(args: {
  memorySpecs: AdmissionRoundSpec[];
  rehydrateSpecs: AdmissionExternalRehydrateSpec[];
}): string[] {
  return [
    ...args.memorySpecs.map((spec) => spec.suppressed_payload_marker),
    ...args.rehydrateSpecs.flatMap((spec) => [
      spec.blocked_payload_marker,
      spec.rehydrate_payload_marker,
    ]),
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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
    query_text: [
      args.spec.active_marker,
      args.spec.suppressed_marker,
      `before admission dataset export evidence for ${args.spec.query_text}`,
    ].filter(Boolean).join(" "),
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
    target_files: args.spec.target_files,
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
  const taskSignature = `admission-dataset-export:${args.spec.round_id}`;

  const afterGuide = await client.guide<Record<string, unknown>>({
    query_text: [
      args.spec.active_marker,
      args.spec.suppressed_marker,
      args.spec.query_text,
    ].filter(Boolean).join(" "),
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
    rehydrate_memory_id: null,
    row_count: rows.length,
    jsonl_line_count: lineCount,
    outcome_label_count: rows.filter((entry) => entry.outcome_label === args.spec.expected_outcome_label).length,
    blocked_or_suppressed_count: rows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length,
    rehydrate_requested_count: rows.filter((entry) => entry.outcome_label === "rehydrate_requested").length,
    prompt_payload_excluded: !jsonl.includes("prompt_text"),
    raw_memory_payload_excluded: !jsonl.includes(args.spec.suppressed_payload_marker),
    raw_slots_excluded: !jsonl.includes("\"slots\""),
    rows,
  };
}

async function runExternalRehydrateRound(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  spec: AdmissionExternalRehydrateSpec;
}): Promise<AdmissionRoundResult> {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.spec.scope,
  });
  await client.health();

  const taskId = `task:${args.runId}:${args.spec.round_id}`;
  const taskSignature = `admission-dataset-export:${args.spec.round_id}`;
  const governed = await client.governMemory<Record<string, unknown>>({
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    query_text: args.spec.query_text,
    mode: "firewall",
    context_mode: "compact_agent",
    include_records: true,
    candidates: [
      {
        external_memory_id: args.spec.current_id,
        source_backend: "mem0",
        text: args.spec.current_text,
        metadata: {
          title: `Current route ${args.spec.round_id}`,
          target_files: args.spec.target_files,
        },
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "current",
        evidence_refs: [`evidence://admission-dataset/${args.runId}/${args.spec.round_id}/current`],
      },
      {
        external_memory_id: args.spec.blocked_id,
        source_backend: "zep",
        text: args.spec.blocked_text,
        metadata: {
          title: `Suppressed route ${args.spec.round_id}`,
          raw_payload_preview: args.spec.blocked_payload_marker,
        },
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "blocked",
        },
        lifecycle_hint: "suppressed",
        evidence_refs: [`evidence://admission-dataset/${args.runId}/${args.spec.round_id}/blocked`],
      },
      {
        external_memory_id: args.spec.rehydrate_id,
        source_backend: "archive",
        text: args.spec.rehydrate_text,
        metadata: {
          title: `Raw evidence pointer ${args.spec.round_id}`,
          target_files: args.spec.target_files,
          raw_payload_preview: args.spec.rehydrate_payload_marker,
        },
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "rehydrate_before_use",
        },
        lifecycle_hint: "procedure",
        evidence_refs: [`aionis://archives/${args.runId}/${args.spec.round_id}/raw-trace`],
      },
    ],
  });
  const context = agentContext(governed, `${args.spec.round_id} governMemory admission`);
  const promptText = String(context.prompt_text);
  assertPromptBoundary(promptText, `${args.spec.round_id} governMemory admission`);

  const useNowIds = textArray(context.use_now_memory_ids);
  const doNotUseIds = textArray(context.do_not_use_memory_ids);
  const inspectIds = textArray(context.inspect_before_use_memory_ids);
  const rehydrateIds = recordArray(context.rehydrate_hints)
    .map((entry) => entry.memory_id)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  assertCondition(useNowIds.includes(args.spec.current_id), `${args.spec.round_id} current external memory did not reach use_now`);
  assertCondition(doNotUseIds.includes(args.spec.blocked_id), `${args.spec.round_id} blocked external memory did not reach do_not_use`);
  assertCondition(rehydrateIds.includes(args.spec.rehydrate_id), `${args.spec.round_id} external raw pointer did not reach rehydrate_hints`);
  assertCondition(!useNowIds.includes(args.spec.blocked_id), `${args.spec.round_id} blocked external memory leaked into use_now`);
  assertCondition(!useNowIds.includes(args.spec.rehydrate_id), `${args.spec.round_id} rehydrate external memory leaked into use_now`);
  assertCondition(!inspectIds.includes(args.spec.rehydrate_id), `${args.spec.round_id} rehydrate external memory leaked into inspect_before_use`);
  assertCondition(!promptText.includes(args.spec.blocked_payload_marker), `${args.spec.round_id} blocked raw payload leaked into prompt`);
  assertCondition(!promptText.includes(args.spec.rehydrate_payload_marker), `${args.spec.round_id} raw rehydrate payload leaked into prompt`);

  const admissionRecord = asRecord(governed.memory_admission_records);
  assertCondition(
    admissionRecord?.contract_version === "aionis_memory_admission_record_v1",
    `${args.spec.round_id} governMemory missing memory admission record`,
  );
  const rows = memoryAdmissionDatasetRowsFromRecord(admissionRecord as unknown as AionisMemoryAdmissionRecord, {
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    task_id: taskId,
    task_signature: taskSignature,
  });
  const jsonl = memoryAdmissionDatasetJsonlFromRows(rows);
  const currentRow = rows.find((entry) => entry.memory_id === args.spec.current_id);
  const blockedRow = rows.find((entry) => entry.memory_id === args.spec.blocked_id);
  const rehydrateRow = rows.find((entry) => entry.memory_id === args.spec.rehydrate_id);
  const lineCount = jsonl.split("\n").filter(Boolean).length;
  assertCondition(rows.length === 3, `${args.spec.round_id} governMemory admission dataset export expected 3 rows`);
  assertCondition(lineCount === rows.length, `${args.spec.round_id} governMemory admission dataset JSONL line count mismatch`);
  assertCondition(currentRow?.admission_action === "use_now", `${args.spec.round_id} current external row did not export use_now`);
  assertCondition(blockedRow?.outcome_label === "blocked_or_suppressed", `${args.spec.round_id} blocked external row did not export blocked label`);
  assertCondition(rehydrateRow?.outcome_label === "rehydrate_requested", `${args.spec.round_id} rehydrate external row did not export rehydrate_requested`);
  assertCondition(!jsonl.includes("prompt_text"), `${args.spec.round_id} governMemory admission dataset JSONL leaked prompt_text`);
  assertCondition(!jsonl.includes(args.spec.blocked_payload_marker), `${args.spec.round_id} governMemory admission dataset JSONL leaked blocked raw payload`);
  assertCondition(!jsonl.includes(args.spec.rehydrate_payload_marker), `${args.spec.round_id} governMemory admission dataset JSONL leaked rehydrate raw payload`);
  assertCondition(!jsonl.includes("\"slots\""), `${args.spec.round_id} governMemory admission dataset JSONL leaked raw slots`);

  return {
    round_id: args.spec.round_id,
    scope: args.spec.scope,
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    task_id: taskId,
    task_signature: taskSignature,
    active_memory_id: args.spec.current_id,
    suppressed_memory_id: args.spec.blocked_id,
    rehydrate_memory_id: args.spec.rehydrate_id,
    row_count: rows.length,
    jsonl_line_count: lineCount,
    outcome_label_count: rows.filter((entry) => entry.outcome_label === "rehydrate_requested").length,
    blocked_or_suppressed_count: rows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length,
    rehydrate_requested_count: rows.filter((entry) => entry.outcome_label === "rehydrate_requested").length,
    prompt_payload_excluded: !jsonl.includes("prompt_text"),
    raw_memory_payload_excluded: !jsonl.includes(args.spec.blocked_payload_marker)
      && !jsonl.includes(args.spec.rehydrate_payload_marker),
    raw_slots_excluded: !jsonl.includes("\"slots\""),
    rows,
  };
}

async function runClosedLoopPriorRound(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  spec: AdmissionClosedLoopPriorSpec;
}): Promise<AdmissionRoundResult> {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.spec.scope,
  });
  await client.health();

  const activeMemory = await client.remember<Record<string, unknown>>({
    kind: "project_context",
    client_id: `${args.spec.round_id}:closed-loop-memory:${args.runId}`,
    title: `Admission closed-loop prior route ${args.spec.round_id}`,
    text: args.spec.text,
    memory_lane: "private",
    owner_agent_id: AGENT_ID,
    target_files: args.spec.target_files,
    confidence: 0.94,
    slots: {
      source: "admission_dataset_closed_loop_prior_e2e",
      admission_round_id: args.spec.round_id,
    },
  });
  const activeMemoryId = firstNodeId(activeMemory, `Admission closed-loop prior route ${args.spec.round_id}`);
  const rows: AionisMemoryAdmissionDatasetRow[] = [];

  for (const [index, outcome] of args.spec.outcomes.entries()) {
    const step = index + 1;
    const guide = await client.guide<Record<string, unknown>>({
      query_text: `${args.spec.marker} ${args.spec.query_text} closed-loop prior step ${step}`,
      consumer_agent_id: AGENT_ID,
      limit: 8,
      include_packets: true,
    });
    const context = agentContext(guide, `${args.spec.round_id} closed-loop prior step ${step}`);
    const promptText = String(context.prompt_text);
    assertPromptBoundary(promptText, `${args.spec.round_id} closed-loop prior step ${step}`);
    const useNowIds = textArray(context.use_now_memory_ids);
    assertCondition(useNowIds.includes(activeMemoryId), `${args.spec.round_id} step ${step} active memory did not reach use_now`);

    const feedback = await client.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide,
      reason: `Closed-loop prior step ${step} ${outcome} outcome for ${args.spec.round_id}.`,
      run_id: `run:${args.runId}:${args.spec.round_id}:step-${step}`,
      outcome,
      used_memory_ids: [activeMemoryId],
    }));
    const taskId = `task:${args.runId}:${args.spec.round_id}:step-${step}`;
    const taskSignature = `admission-dataset-export:${args.spec.round_id}`;
    const measure = await client.measure<Record<string, unknown>>(measureInputFromGuideLoop({
      task: {
        task_id: taskId,
        run_id: `run:${args.runId}:${args.spec.round_id}:step-${step}`,
        task_signature: taskSignature,
        task_family: "memory_admission_dataset_closed_loop_prior",
      },
      before_guide: guide,
      after_guide: guide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${activeMemoryId}`,
        `feedback:${args.runId}:${args.spec.round_id}:step-${step}`,
      ],
    }));
    const admissionRecord = asRecord(asRecord(measure.memory_decision_trace)?.admission_record);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", `${args.spec.round_id} step ${step} measure did not return measure result v1`);
    assertCondition(
      admissionRecord?.contract_version === "aionis_memory_admission_record_v1",
      `${args.spec.round_id} step ${step} measure missing memory admission record`,
    );
    const stepRows = memoryAdmissionDatasetRowsFromRecord(admissionRecord as unknown as AionisMemoryAdmissionRecord, {
      run_id: `run:${args.runId}:${args.spec.round_id}:step-${step}`,
      task_id: taskId,
      task_signature: taskSignature,
    });
    const activeRow = stepRows.find((entry) => entry.memory_id === activeMemoryId);
    assertCondition(activeRow?.outcome_label === `${outcome}_use`, `${args.spec.round_id} step ${step} active row did not join ${outcome}_use`);
    rows.push(...stepRows);
  }

  const enrichedRows = memoryAdmissionDatasetRowsWithClosedLoopPrior(rows);
  const lastActiveRow = [...enrichedRows].reverse().find((entry) => entry.memory_id === activeMemoryId);
  assertCondition(
    lastActiveRow?.closed_loop_effect_state === args.spec.expected_state_on_last_row,
    `${args.spec.round_id} closed-loop prior state did not reach ${args.spec.expected_state_on_last_row}`,
  );
  assertCondition(
    lastActiveRow?.repeated_negative_posture === args.spec.expected_repeated_negative_posture_on_last_row,
    `${args.spec.round_id} repeated negative posture mismatch`,
  );
  const jsonl = memoryAdmissionDatasetJsonlFromRows(enrichedRows);
  assertCondition(!jsonl.includes("prompt_text"), `${args.spec.round_id} closed-loop prior JSONL leaked prompt_text`);
  assertCondition(!jsonl.includes("\"slots\""), `${args.spec.round_id} closed-loop prior JSONL leaked raw slots`);

  return {
    round_id: args.spec.round_id,
    scope: args.spec.scope,
    run_id: `run:${args.runId}:${args.spec.round_id}`,
    task_id: `task:${args.runId}:${args.spec.round_id}`,
    task_signature: `admission-dataset-export:${args.spec.round_id}`,
    active_memory_id: activeMemoryId,
    suppressed_memory_id: null,
    rehydrate_memory_id: null,
    row_count: enrichedRows.length,
    jsonl_line_count: jsonl.split("\n").filter(Boolean).length,
    outcome_label_count: enrichedRows.filter((entry) => entry.memory_id === activeMemoryId).length,
    blocked_or_suppressed_count: 0,
    rehydrate_requested_count: 0,
    prompt_payload_excluded: !jsonl.includes("prompt_text"),
    raw_memory_payload_excluded: true,
    raw_slots_excluded: !jsonl.includes("\"slots\""),
    rows: enrichedRows,
  };
}

function admissionDatasetClosedLoopPriorSpecs(args: {
  baseScope: string;
}): AdmissionClosedLoopPriorSpec[] {
  return [
    {
      round_id: "closed-loop-prior-supported-cache",
      scope: `${args.baseScope}:closed-loop-prior-supported-cache`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_CACHE_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_CACHE_ROUTE: accepted route is packages/runtime/src/request-cache-boundary.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported cache-boundary route with prior feedback visible",
      target_files: ["packages/runtime/src/request-cache-boundary.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-cache",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-cache`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_CACHE_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_CACHE_ROUTE: candidate route is packages/runtime/src/global-cache-shortcut.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted cache shortcut route with prior negative feedback visible",
      target_files: ["packages/runtime/src/global-cache-shortcut.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-auth",
      scope: `${args.baseScope}:closed-loop-prior-supported-auth`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_AUTH_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_AUTH_ROUTE: accepted route is packages/auth/src/scoped-authorizer.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported scoped-authorizer route with prior feedback visible",
      target_files: ["packages/auth/src/scoped-authorizer.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-auth",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-auth`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_AUTH_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_AUTH_ROUTE: candidate route is packages/auth/src/implicit-admin-bypass.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted auth bypass route with prior negative feedback visible",
      target_files: ["packages/auth/src/implicit-admin-bypass.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-sdk",
      scope: `${args.baseScope}:closed-loop-prior-supported-sdk`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_SDK_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_SDK_ROUTE: accepted route is packages/sdk/src/admission-prior-state.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported SDK admission-prior route with prior feedback visible",
      target_files: ["packages/sdk/src/admission-prior-state.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-sdk",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-sdk`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_SDK_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_SDK_ROUTE: candidate route is packages/sdk/src/raw-memory-replay.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted SDK raw replay route with prior negative feedback visible",
      target_files: ["packages/sdk/src/raw-memory-replay.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-observability",
      scope: `${args.baseScope}:closed-loop-prior-supported-observability`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_OBSERVABILITY_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_OBSERVABILITY_ROUTE: accepted route is packages/observability/src/admission-trace-export.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported observability trace route with prior feedback visible",
      target_files: ["packages/observability/src/admission-trace-export.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-observability",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-observability`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_OBSERVABILITY_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_OBSERVABILITY_ROUTE: candidate route is packages/observability/src/raw-log-dump.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted observability raw-log route with prior negative feedback visible",
      target_files: ["packages/observability/src/raw-log-dump.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
  ];
}

function admissionDatasetFreshClosedLoopPriorSpecs(args: {
  baseScope: string;
}): AdmissionClosedLoopPriorSpec[] {
  return [
    {
      round_id: "closed-loop-prior-supported-data-migration",
      scope: `${args.baseScope}:closed-loop-prior-supported-data-migration`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_DATA_MIGRATION_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_DATA_MIGRATION_ROUTE: accepted route is packages/data/src/idempotent-migration-plan.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported data migration route with prior feedback visible",
      target_files: ["packages/data/src/idempotent-migration-plan.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-data-migration",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-data-migration`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_DATA_MIGRATION_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_DATA_MIGRATION_ROUTE: candidate route is packages/data/src/drop-and-reseed-shortcut.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted data migration shortcut route with prior negative feedback visible",
      target_files: ["packages/data/src/drop-and-reseed-shortcut.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-webhook",
      scope: `${args.baseScope}:closed-loop-prior-supported-webhook`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_WEBHOOK_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_WEBHOOK_ROUTE: accepted route is packages/integrations/src/webhook-signature-verifier.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported webhook verifier route with prior feedback visible",
      target_files: ["packages/integrations/src/webhook-signature-verifier.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-webhook",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-webhook`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_WEBHOOK_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_WEBHOOK_ROUTE: candidate route is packages/integrations/src/trust-forwarded-signature.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted webhook trust-forwarded route with prior negative feedback visible",
      target_files: ["packages/integrations/src/trust-forwarded-signature.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-schema",
      scope: `${args.baseScope}:closed-loop-prior-supported-schema`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_SCHEMA_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_SCHEMA_ROUTE: accepted route is packages/schema/src/versioned-contract-reader.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported versioned schema route with prior feedback visible",
      target_files: ["packages/schema/src/versioned-contract-reader.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-schema",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-schema`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_SCHEMA_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_SCHEMA_ROUTE: candidate route is packages/schema/src/unversioned-any-parser.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted unversioned schema parser route with prior negative feedback visible",
      target_files: ["packages/schema/src/unversioned-any-parser.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-scheduler",
      scope: `${args.baseScope}:closed-loop-prior-supported-scheduler`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_SCHEDULER_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_SCHEDULER_ROUTE: accepted route is packages/jobs/src/deduped-scheduler-window.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported deduped scheduler route with prior feedback visible",
      target_files: ["packages/jobs/src/deduped-scheduler-window.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-scheduler",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-scheduler`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_SCHEDULER_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_SCHEDULER_ROUTE: candidate route is packages/jobs/src/fire-every-worker-loop.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted fire-every-worker scheduler route with prior negative feedback visible",
      target_files: ["packages/jobs/src/fire-every-worker-loop.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
  ];
}

function admissionDatasetFresh2ClosedLoopPriorSpecs(args: {
  baseScope: string;
}): AdmissionClosedLoopPriorSpec[] {
  return [
    {
      round_id: "closed-loop-prior-supported-quota",
      scope: `${args.baseScope}:closed-loop-prior-supported-quota`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_QUOTA_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_QUOTA_ROUTE: accepted route is packages/billing/src/quota-budget-ledger.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported quota budget route with prior feedback visible",
      target_files: ["packages/billing/src/quota-budget-ledger.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-quota",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-quota`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_QUOTA_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_QUOTA_ROUTE: candidate route is packages/billing/src/global-quota-bypass.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted global quota bypass route with prior negative feedback visible",
      target_files: ["packages/billing/src/global-quota-bypass.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-routing",
      scope: `${args.baseScope}:closed-loop-prior-supported-routing`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_ROUTING_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_ROUTING_ROUTE: accepted route is packages/router/src/typed-route-dispatcher.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported typed routing route with prior feedback visible",
      target_files: ["packages/router/src/typed-route-dispatcher.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-routing",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-routing`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_ROUTING_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_ROUTING_ROUTE: candidate route is packages/router/src/wildcard-route-fallback.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted wildcard routing route with prior negative feedback visible",
      target_files: ["packages/router/src/wildcard-route-fallback.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-rollback",
      scope: `${args.baseScope}:closed-loop-prior-supported-rollback`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_ROLLBACK_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_ROLLBACK_ROUTE: accepted route is packages/deploy/src/reversible-rollback-plan.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported reversible rollback route with prior feedback visible",
      target_files: ["packages/deploy/src/reversible-rollback-plan.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-rollback",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-rollback`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_ROLLBACK_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_ROLLBACK_ROUTE: candidate route is packages/deploy/src/force-reset-deploy.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted force-reset deployment route with prior negative feedback visible",
      target_files: ["packages/deploy/src/force-reset-deploy.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-encryption",
      scope: `${args.baseScope}:closed-loop-prior-supported-encryption`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_ENCRYPTION_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_ENCRYPTION_ROUTE: accepted route is packages/security/src/key-version-envelope.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported key-version envelope route with prior feedback visible",
      target_files: ["packages/security/src/key-version-envelope.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-encryption",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-encryption`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_ENCRYPTION_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_ENCRYPTION_ROUTE: candidate route is packages/security/src/plaintext-cache-shortcut.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted plaintext cache shortcut route with prior negative feedback visible",
      target_files: ["packages/security/src/plaintext-cache-shortcut.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-pagination",
      scope: `${args.baseScope}:closed-loop-prior-supported-pagination`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_PAGINATION_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_PAGINATION_ROUTE: accepted route is packages/api/src/cursor-pagination-contract.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported cursor pagination route with prior feedback visible",
      target_files: ["packages/api/src/cursor-pagination-contract.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-pagination",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-pagination`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_PAGINATION_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_PAGINATION_ROUTE: candidate route is packages/api/src/offset-scan-shortcut.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted offset scan pagination route with prior negative feedback visible",
      target_files: ["packages/api/src/offset-scan-shortcut.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
    {
      round_id: "closed-loop-prior-supported-import-export",
      scope: `${args.baseScope}:closed-loop-prior-supported-import-export`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_IMPORT_EXPORT_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_SUPPORTED_IMPORT_EXPORT_ROUTE: accepted route is packages/import-export/src/validated-batch-contract.ts; reuse only when prior feedback supports it.",
      query_text: "continue supported validated import-export route with prior feedback visible",
      target_files: ["packages/import-export/src/validated-batch-contract.ts"],
      outcomes: ["positive", "positive"],
      expected_state_on_last_row: "supported",
      expected_repeated_negative_posture_on_last_row: false,
    },
    {
      round_id: "closed-loop-prior-contradicted-import-export",
      scope: `${args.baseScope}:closed-loop-prior-contradicted-import-export`,
      marker: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_IMPORT_EXPORT_ROUTE",
      text: "ADMISSION_DATASET_CLOSED_LOOP_CONTRADICTED_IMPORT_EXPORT_ROUTE: candidate route is packages/import-export/src/unchecked-bulk-loader.ts; keep prior negative feedback visible before direct reuse.",
      query_text: "continue contradicted unchecked bulk-loader route with prior negative feedback visible",
      target_files: ["packages/import-export/src/unchecked-bulk-loader.ts"],
      outcomes: ["negative", "negative", "negative"],
      expected_state_on_last_row: "contradicted",
      expected_repeated_negative_posture_on_last_row: true,
    },
  ];
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const runId = `admission-dataset-${randomUUID().slice(0, 8)}`;
  const chunkId = cli.chunkId ?? runId;
  const baseScope = `admission-dataset:${runId}`;
  const session = await openRuntime();
  try {
    let memorySpecs: AdmissionRoundSpec[] = [
      {
        round_id: "positive-supported",
        scope: `${baseScope}:positive-supported`,
        active_marker: ACTIVE_MARKER,
        suppressed_marker: SUPPRESSED_MARKER,
        active_text: `${ACTIVE_MARKER}: accepted route is packages/api/src/current-checkout.ts; use this route for the next implementation step.`,
        suppressed_text: `${SUPPRESSED_MARKER}: rejected route says to extend legacy/checkout/full-rewrite.ts; this is suppressed and must not be direct-use.`,
        suppressed_payload_marker: "legacy/checkout/full-rewrite.ts",
        query_text: "continue checkout integration without unsafe route reuse",
        target_files: ["packages/api/src/current-checkout.ts"],
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
        query_text: "resume billing adapter work while preserving failed old-api evidence",
        target_files: ["packages/api/src/billing-adapter.ts"],
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed candidate route but verifier outcome was negative.",
      },
      {
        round_id: "positive-feature-flag",
        scope: `${baseScope}:positive-feature-flag`,
        active_marker: "ADMISSION_DATASET_ACTIVE_FLAG_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_FLAG_ROUTE",
        active_text: "ADMISSION_DATASET_ACTIVE_FLAG_ROUTE: accepted route is packages/web/src/flags/checkout-rollout.ts; update the typed rollout gate there.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_FLAG_ROUTE: rejected route says to patch legacy/flags/runtime-global.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/flags/runtime-global.ts",
        query_text: "continue feature flag rollout using the current typed flag route",
        target_files: ["packages/web/src/flags/checkout-rollout.ts"],
        outcome: "positive",
        expected_outcome_label: "positive_use",
        reason: "Agent used the typed feature flag route and avoided the legacy global flag route.",
      },
      {
        round_id: "negative-migration-candidate",
        scope: `${baseScope}:negative-migration-candidate`,
        active_marker: "ADMISSION_DATASET_NEGATIVE_MIGRATION_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_MIGRATION_ROUTE",
        active_text: "ADMISSION_DATASET_NEGATIVE_MIGRATION_ROUTE: candidate route is packages/db/migrations/20260618_expand_checkout.sql; expose it so rollback feedback can be attributed.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_MIGRATION_ROUTE: rejected route says to reuse legacy/db/manual-patch.sql; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/db/manual-patch.sql",
        query_text: "resume database migration planning with rollback evidence attached",
        target_files: ["packages/db/migrations/20260618_expand_checkout.sql"],
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed migration candidate but rollback verification was negative.",
      },
      {
        round_id: "positive-reviewer-handoff",
        scope: `${baseScope}:positive-reviewer-handoff`,
        active_marker: "ADMISSION_DATASET_ACTIVE_REVIEW_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_REVIEW_ROUTE",
        active_text: "ADMISSION_DATASET_ACTIVE_REVIEW_ROUTE: accepted reviewer handoff is docs/review/checkout-boundary.md; follow that boundary checklist.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_REVIEW_ROUTE: rejected handoff says to approve legacy/review/skip-boundary.md; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/review/skip-boundary.md",
        query_text: "continue reviewer handoff using accepted boundary checklist",
        target_files: ["docs/review/checkout-boundary.md"],
        outcome: "positive",
        expected_outcome_label: "positive_use",
        reason: "Agent followed the accepted reviewer boundary checklist and avoided the suppressed approval shortcut.",
      },
      {
        round_id: "negative-test-stabilization",
        scope: `${baseScope}:negative-test-stabilization`,
        active_marker: "ADMISSION_DATASET_NEGATIVE_TEST_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_TEST_ROUTE",
        active_text: "ADMISSION_DATASET_NEGATIVE_TEST_ROUTE: candidate route is packages/tests/checkout-flake.spec.ts; expose it so flaky-verifier feedback can be attributed.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_TEST_ROUTE: rejected route says to disable legacy/tests/checkout-suite.spec.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/tests/checkout-suite.spec.ts",
        query_text: "resume test stabilization without reusing disabled-suite shortcuts",
        target_files: ["packages/tests/checkout-flake.spec.ts"],
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed test stabilization candidate but verifier outcome was negative.",
      },
      {
        round_id: "positive-cache-boundary",
        scope: `${baseScope}:positive-cache-boundary`,
        active_marker: "ADMISSION_DATASET_ACTIVE_CACHE_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_CACHE_ROUTE",
        active_text: "ADMISSION_DATASET_ACTIVE_CACHE_ROUTE: accepted route is packages/cache/src/request-scope-cache.ts; keep cache invalidation scoped to the request boundary.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_CACHE_ROUTE: rejected route says to mutate legacy/cache/global-singleton.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/cache/global-singleton.ts",
        query_text: "continue cache boundary work without reusing global singleton mutations",
        target_files: ["packages/cache/src/request-scope-cache.ts"],
        outcome: "positive",
        expected_outcome_label: "positive_use",
        reason: "Agent used the accepted request-scope cache route and avoided the global singleton route.",
      },
      {
        round_id: "negative-secret-rotation",
        scope: `${baseScope}:negative-secret-rotation`,
        active_marker: "ADMISSION_DATASET_NEGATIVE_SECRET_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_SECRET_ROUTE",
        active_text: "ADMISSION_DATASET_NEGATIVE_SECRET_ROUTE: candidate route is packages/security/src/secret-rotation.ts; expose it so failed rotation feedback can be attributed.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_SECRET_ROUTE: rejected route says to copy legacy/secrets/plaintext-env.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/secrets/plaintext-env.ts",
        query_text: "resume secret rotation while preserving unsafe plaintext evidence",
        target_files: ["packages/security/src/secret-rotation.ts"],
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed secret rotation candidate but security verification was negative.",
      },
      {
        round_id: "positive-observability-route",
        scope: `${baseScope}:positive-observability-route`,
        active_marker: "ADMISSION_DATASET_ACTIVE_OBSERVABILITY_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_OBSERVABILITY_ROUTE",
        active_text: "ADMISSION_DATASET_ACTIVE_OBSERVABILITY_ROUTE: accepted route is packages/observability/src/decision-trace-exporter.ts; extend the structured trace exporter.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_OBSERVABILITY_ROUTE: rejected route says to append logs in legacy/observability/string-dump.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/observability/string-dump.ts",
        query_text: "continue observability work using the structured decision trace exporter",
        target_files: ["packages/observability/src/decision-trace-exporter.ts"],
        outcome: "positive",
        expected_outcome_label: "positive_use",
        reason: "Agent used the structured trace exporter route and avoided the legacy string dump route.",
      },
      {
        round_id: "negative-permission-shortcut",
        scope: `${baseScope}:negative-permission-shortcut`,
        active_marker: "ADMISSION_DATASET_NEGATIVE_PERMISSION_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_PERMISSION_ROUTE",
        active_text: "ADMISSION_DATASET_NEGATIVE_PERMISSION_ROUTE: candidate route is packages/auth/src/scoped-permission-check.ts; expose it so permission feedback can be attributed.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_PERMISSION_ROUTE: rejected route says to bypass checks in legacy/auth/allow-all.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/auth/allow-all.ts",
        query_text: "resume permission work while avoiding allow-all shortcuts",
        target_files: ["packages/auth/src/scoped-permission-check.ts"],
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed permission candidate but authorization verification was negative.",
      },
      {
        round_id: "positive-sdk-contract",
        scope: `${baseScope}:positive-sdk-contract`,
        active_marker: "ADMISSION_DATASET_ACTIVE_SDK_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_SDK_ROUTE",
        active_text: "ADMISSION_DATASET_ACTIVE_SDK_ROUTE: accepted route is packages/sdk/src/admission-contract.ts; update the typed SDK contract surface.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_SDK_ROUTE: rejected route says to patch legacy/sdk/raw-json-client.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/sdk/raw-json-client.ts",
        query_text: "continue SDK contract work using the typed admission surface",
        target_files: ["packages/sdk/src/admission-contract.ts"],
        outcome: "positive",
        expected_outcome_label: "positive_use",
        reason: "Agent used the typed SDK contract route and avoided the raw JSON client route.",
      },
      {
        round_id: "negative-retry-loop",
        scope: `${baseScope}:negative-retry-loop`,
        active_marker: "ADMISSION_DATASET_NEGATIVE_RETRY_ROUTE",
        suppressed_marker: "ADMISSION_DATASET_SUPPRESSED_RETRY_ROUTE",
        active_text: "ADMISSION_DATASET_NEGATIVE_RETRY_ROUTE: candidate route is packages/runtime/src/bounded-retry-loop.ts; expose it so retry feedback can be attributed.",
        suppressed_text: "ADMISSION_DATASET_SUPPRESSED_RETRY_ROUTE: rejected route says to add unbounded retries in legacy/runtime/retry-forever.ts; this is suppressed and must not be direct-use.",
        suppressed_payload_marker: "legacy/runtime/retry-forever.ts",
        query_text: "resume retry loop work while preserving unbounded retry counter-evidence",
        target_files: ["packages/runtime/src/bounded-retry-loop.ts"],
        outcome: "negative",
        expected_outcome_label: "negative_use",
        reason: "Agent used the exposed bounded retry candidate but resilience verification was negative.",
      },
    ];
    let externalRehydrateSpecs: AdmissionExternalRehydrateSpec[] = [
      {
        round_id: "external-rehydrate-raw-trace",
        scope: `${baseScope}:external-rehydrate-raw-trace`,
        current_id: `mem0:admission-current-trace:${runId}`,
        blocked_id: `zep:admission-suppressed-trace:${runId}`,
        rehydrate_id: `archive:admission-raw-trace:${runId}`,
        current_text: "Current accepted route is packages/ops/src/replay-checkpoint.ts; continue from the compact replay checkpoint.",
        blocked_text: "Rejected route says to reuse legacy/ops/raw-replay-copy.ts; this is suppressed and must not be direct-use.",
        rehydrate_text: "Raw trace pointer exists for exact replay evidence; rehydrate before relying on exact payload fields.",
        blocked_payload_marker: "ADMISSION_DATASET_BLOCKED_TRACE_RAW_PAYLOAD_SHOULD_NOT_EXPORT",
        rehydrate_payload_marker: "ADMISSION_DATASET_REHYDRATE_RAW_TRACE_PAYLOAD_SHOULD_NOT_EXPORT",
        query_text: "continue replay checkpoint work and request raw trace only when exact evidence is needed",
        target_files: ["packages/ops/src/replay-checkpoint.ts"],
      },
    ];
    if (cli.profile === "targeted-external-current") {
      memorySpecs = [];
      externalRehydrateSpecs = admissionDatasetTargetedExternalCurrentSpecs({ runId, baseScope });
    }
    let closedLoopPriorSpecs: AdmissionClosedLoopPriorSpec[] = [];
    if (
      cli.profile === "closed-loop-prior"
      || cli.profile === "closed-loop-prior-fresh"
      || cli.profile === "closed-loop-prior-fresh-2"
    ) {
      memorySpecs = [];
      externalRehydrateSpecs = [];
      if (cli.profile === "closed-loop-prior-fresh-2") {
        closedLoopPriorSpecs = admissionDatasetFresh2ClosedLoopPriorSpecs({ baseScope });
      } else if (cli.profile === "closed-loop-prior-fresh") {
        closedLoopPriorSpecs = admissionDatasetFreshClosedLoopPriorSpecs({ baseScope });
      } else {
        closedLoopPriorSpecs = admissionDatasetClosedLoopPriorSpecs({ baseScope });
      }
    }

    const rounds: AdmissionRoundResult[] = [];
    for (const spec of memorySpecs) {
      rounds.push(await runAdmissionRound({
        baseUrl: session.baseUrl,
        apiKey: apiKey(),
        runId,
        spec,
      }));
    }
    for (const spec of externalRehydrateSpecs) {
      rounds.push(await runExternalRehydrateRound({
        baseUrl: session.baseUrl,
        apiKey: apiKey(),
        runId,
        spec,
      }));
    }
    for (const spec of closedLoopPriorSpecs) {
      rounds.push(await runClosedLoopPriorRound({
        baseUrl: session.baseUrl,
        apiKey: apiKey(),
        runId,
        spec,
      }));
    }

    const allRows = memoryAdmissionDatasetRowsWithClosedLoopPrior(rounds.flatMap((round) => round.rows));
    const appendedJsonl = memoryAdmissionDatasetJsonlFromRows(allRows);
    const appendedLineCount = appendedJsonl.split("\n").filter(Boolean).length;
    const positiveUseCount = allRows.filter((entry) => entry.outcome_label === "positive_use").length;
    const negativeUseCount = allRows.filter((entry) => entry.outcome_label === "negative_use").length;
    const blockedOrSuppressedCount = allRows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length;
    const rehydrateRequestedCount = allRows.filter((entry) => entry.outcome_label === "rehydrate_requested").length;
    const expectedPositiveUseCount = memorySpecs.filter((spec) => spec.expected_outcome_label === "positive_use").length;
    const expectedNegativeUseCount = memorySpecs.filter((spec) => spec.expected_outcome_label === "negative_use").length;
    const expectedBlockedOrSuppressedCount = memorySpecs.length + externalRehydrateSpecs.length;
    const expectedRehydrateRequestedCount = externalRehydrateSpecs.length;
    const expectedPriorStateRows = closedLoopPriorSpecs.reduce(
      (sum, spec) => sum + Math.max(0, spec.outcomes.length - 1),
      0,
    );
    const forbiddenPayloadMarkers = rawPayloadMarkers({ memorySpecs, rehydrateSpecs: externalRehydrateSpecs });
    assertCondition(appendedLineCount === allRows.length, "appendable admission dataset JSONL line count mismatch");
    assertCondition(positiveUseCount >= expectedPositiveUseCount, "appendable admission dataset missing positive_use rows");
    assertCondition(negativeUseCount >= expectedNegativeUseCount, "appendable admission dataset missing negative_use rows");
    assertCondition(blockedOrSuppressedCount >= expectedBlockedOrSuppressedCount, "appendable admission dataset missing blocked_or_suppressed rows");
    assertCondition(rehydrateRequestedCount >= expectedRehydrateRequestedCount, "appendable admission dataset missing rehydrate_requested rows");
    assertCondition(
      allRows.filter((entry) => entry.closed_loop_effect_state !== "no_prior").length >= expectedPriorStateRows,
      "appendable admission dataset missing closed-loop prior-state rows",
    );
    assertCondition(!appendedJsonl.includes("prompt_text"), "appendable admission dataset JSONL leaked prompt_text");
    assertCondition(excludesAll(appendedJsonl, forbiddenPayloadMarkers), "appendable admission dataset JSONL leaked raw payload marker");
    assertCondition(!appendedJsonl.includes("\"slots\""), "appendable admission dataset JSONL leaked raw slots");

    let collectionResult: ReturnType<typeof collectAdmissionDatasetRows> | null = null;
    let chunkPath: string | null = null;
    if (cli.outJsonl) {
      const outJsonlPath = path.resolve(cli.outJsonl);
      fs.mkdirSync(path.dirname(outJsonlPath), { recursive: true });
      fs.writeFileSync(outJsonlPath, appendedJsonl);
      chunkPath = outJsonlPath;
    }
    if (cli.datasetDir) {
      const datasetDir = path.resolve(cli.datasetDir);
      const chunksDir = path.join(datasetDir, "chunks");
      fs.mkdirSync(chunksDir, { recursive: true });
      const collectorChunkPath = path.join(chunksDir, `${chunkId}.jsonl`);
      fs.writeFileSync(collectorChunkPath, appendedJsonl);
      chunkPath = collectorChunkPath;
      collectionResult = collectAdmissionDatasetRows({
        dataset_dir: datasetDir,
        input_files: [collectorChunkPath],
        chunk_id: chunkId,
      });
      assertCondition(collectionResult.appended_row_count === allRows.length, "collector appended row count mismatch");
      assertCondition(collectionResult.total_row_count >= allRows.length, "collector total row count did not include current chunk");
      assertCondition(collectionResult.checks.append_only, "collector append-only check failed");
      assertCondition(collectionResult.checks.prompt_payload_excluded, "collector prompt payload check failed");
      assertCondition(collectionResult.checks.raw_slots_excluded, "collector raw slots check failed");
      assertCondition(collectionResult.checks.embeddings_excluded, "collector embeddings check failed");
    }

    const result = {
      contract_version: "aionis_admission_dataset_export_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_loop: {
        path: "remember/observe -> guide -> feedback -> measure plus governMemory(mode=firewall) -> admission dataset JSONL export",
        source_record: "memory_decision_trace.admission_record + external_candidate_admission.memory_admission_records",
        dataset_export_runtime_mutation: false,
        profile: cli.profile,
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
        rehydrate_requested_count: rehydrateRequestedCount,
        closed_loop_prior_state_count: allRows.filter((entry) => entry.closed_loop_effect_state !== "no_prior").length,
        unused_exposed_count: allRows.filter((entry) => entry.outcome_label === "unused_exposed").length,
        prompt_payload_excluded: !appendedJsonl.includes("prompt_text"),
        raw_memory_payload_excluded: excludesAll(appendedJsonl, forbiddenPayloadMarkers),
        raw_slots_excluded: !appendedJsonl.includes("\"slots\""),
        append_mode: "jsonl_append",
        append_chunk_count: rounds.length,
        scenario_count: memorySpecs.length + externalRehydrateSpecs.length + closedLoopPriorSpecs.length,
        task_signature_count: new Set(rounds.map((round) => round.task_signature)).size,
        collected_to_dataset: !!collectionResult,
        chunk_path: chunkPath,
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
      collector: collectionResult
        ? {
          contract_version: collectionResult.contract_version,
          dataset_dir: collectionResult.dataset_dir,
          chunk_id: collectionResult.chunk_id,
          rows_path: collectionResult.rows_path,
          manifest_path: collectionResult.manifest_path,
          summary_path: collectionResult.summary_path,
          leaderboard_path: collectionResult.leaderboard_path,
          policy_comparison_path: collectionResult.policy_comparison_path,
          policy_comparison_markdown_path: collectionResult.policy_comparison_markdown_path,
          appended_row_count: collectionResult.appended_row_count,
          previous_row_count: collectionResult.previous_row_count,
          total_row_count: collectionResult.total_row_count,
          policy_comparison_leader: collectionResult.policy_comparison?.leaderboard[0]?.policy_id ?? null,
        }
        : null,
      rounds: rounds.map(({ rows: _rows, ...round }) => round),
      checks: {
        appendable_jsonl_line_count_matches_rows: appendedLineCount === allRows.length,
        positive_use_exported: positiveUseCount >= expectedPositiveUseCount,
        negative_use_exported: negativeUseCount >= expectedNegativeUseCount,
        blocked_or_suppressed_exported: blockedOrSuppressedCount >= expectedBlockedOrSuppressedCount,
        rehydrate_requested_exported: rehydrateRequestedCount >= expectedRehydrateRequestedCount,
        closed_loop_prior_state_exported: allRows.filter((entry) => entry.closed_loop_effect_state !== "no_prior").length >= expectedPriorStateRows,
        prompt_payload_excluded: !appendedJsonl.includes("prompt_text"),
        raw_memory_payload_excluded: excludesAll(appendedJsonl, forbiddenPayloadMarkers),
        raw_slots_excluded: !appendedJsonl.includes("\"slots\""),
        collector_appendable: collectionResult ? collectionResult.checks.append_only : null,
        collector_policy_comparison_generated: collectionResult ? !!collectionResult.policy_comparison_path : null,
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
