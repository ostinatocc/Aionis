#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const AGENT_ID = "judgment-calibration-agent";
const USED_MARKER = "JUDGMENT_CALIBRATION_USED_MEMORY";
const UNUSED_MARKER = "JUDGMENT_CALIBRATION_UNUSED_MEMORY";

function apiKey(): string | null {
  return process.env.AIONIS_JUDGMENT_CALIBRATION_E2E_API_KEY?.trim()
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

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "memory_use_receipt",
    "judgment_calibration",
    "decision_reviews",
    "raw_memory_rows",
    "raw_slots",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

function judgmentCalibration(value: unknown, label: string): Record<string, unknown> {
  const summary = asRecord(value);
  assertCondition(
    summary?.contract_version === "aionis_judgment_calibration_summary_v1",
    `${label} missing judgment calibration summary`,
  );
  assertCondition(summary.agent_prompt_included === false, `${label} calibration leaked into Agent prompt`);
  assertCondition(summary.runtime_mutation === false, `${label} calibration mutated runtime state`);
  assertCondition(summary.authority === "read_only", `${label} calibration was not read-only`);
  return summary;
}

function bucketNames(summary: Record<string, unknown>): string[] {
  return recordArray(summary.buckets).map((entry) => String(entry.bucket ?? "")).filter(Boolean);
}

async function main() {
  const runId = `judgment-calibration-${randomUUID().slice(0, 8)}`;
  const scope = `judgment-calibration-product-loop:${runId}`;
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
      query_text: `${USED_MARKER} ${UNUSED_MARKER} before calibration memories exist`,
      consumer_agent_id: AGENT_ID,
      limit: 8,
      include_packets: true,
    });
    const beforeContext = asRecord(beforeGuide.agent_context);
    assertCondition(beforeContext?.contract_version === "aionis_agent_context_v1", "before guide missing agent_context");
    assertCondition(beforeContext.actionable_history_used === false, "fresh calibration guide unexpectedly had actionable history");
    assertPromptBoundary(String(beforeContext.prompt_text ?? ""), "before calibration guide");

    const usedMemory = await aionis.remember<Record<string, unknown>>({
      kind: "project_context",
      client_id: `judgment-calibration-used:${runId}`,
      title: "Judgment calibration used target memory",
      text: `${USED_MARKER}: active calibration target is src/memory/product-output-assembler.ts and should be used for this run.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      confidence: 0.95,
      slots: { source: "judgment_calibration_e2e" },
    });
    const usedMemoryId = firstNodeId(usedMemory, "used calibration memory");

    const unusedMemory = await aionis.remember<Record<string, unknown>>({
      kind: "preference",
      client_id: `judgment-calibration-unused:${runId}`,
      title: "Judgment calibration unused formatting memory",
      text: `${UNUSED_MARKER}: optional formatting preference says to include a verbose appendix, but this run does not need it.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      confidence: 0.9,
      slots: { source: "judgment_calibration_e2e" },
    });
    const unusedMemoryId = firstNodeId(unusedMemory, "unused calibration memory");

    const afterGuide = await aionis.guide<Record<string, unknown>>({
      query_text: `${USED_MARKER} ${UNUSED_MARKER} continue judgment calibration product loop`,
      consumer_agent_id: AGENT_ID,
      limit: 8,
      include_packets: true,
    });
    const afterContext = asRecord(afterGuide.agent_context);
    assertCondition(afterContext?.contract_version === "aionis_agent_context_v1", "after guide missing agent_context");
    assertPromptBoundary(String(afterContext.prompt_text ?? ""), "after calibration guide");
    assertCondition(afterContext.actionable_history_used === true, "after guide did not expose actionable calibration memory");
    const useNowIds = textArray(afterContext.use_now_memory_ids);
    assertCondition(useNowIds.includes(usedMemoryId), "used memory was not exposed in use_now");
    assertCondition(useNowIds.includes(unusedMemoryId), "unused memory was not exposed in use_now for attribution test");

    const feedback = await aionis.feedback<Record<string, unknown>>({
      reason: "The Agent used the target memory successfully and ignored the optional formatting preference.",
      run_id: `run:${runId}:feedback`,
      outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      guide_trace_id: String(afterGuide.guide_trace_id ?? ""),
      used_memory_ids: [usedMemoryId],
      runtime_signal_refs: [`evidence://judgment-calibration/${runId}/verifier`],
    });

    const measure = await aionis.measure<Record<string, unknown>>({
      task: {
        task_id: `task:${runId}`,
        run_id: runId,
        task_signature: "judgment-calibration-product-loop",
        task_family: "judgment_calibration",
      },
      product_trace: {
        before_guide: beforeGuide,
        after_guide: afterGuide,
        forget_result: feedback,
        sufficient_evidence: true,
        evidence_ids: [
          `memory:${usedMemoryId}`,
          `memory:${unusedMemoryId}`,
          `feedback:${runId}`,
        ],
      },
    });
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    const trace = asRecord(measure.memory_decision_trace);
    const traceCalibration = judgmentCalibration(trace?.judgment_calibration_summary, "measure trace");
    const audit = asRecord(measure.memory_decision_audit);
    const auditCalibration = judgmentCalibration(audit?.judgment_calibration_review, "measure audit");
    assertCondition(historyImpact?.impact_direction === "positive", "measure did not report positive history impact");
    assertCondition(textArray(traceCalibration.supported_memory_ids).includes(usedMemoryId), "used memory was not calibrated as supported");
    assertCondition(textArray(traceCalibration.unused_memory_ids).includes(unusedMemoryId), "unreported memory was not calibrated as unused");
    assertCondition(!textArray(traceCalibration.contradicted_memory_ids).includes(unusedMemoryId), "unused memory was incorrectly contradicted");
    assertCondition(JSON.stringify(auditCalibration) === JSON.stringify(traceCalibration), "audit calibration diverged from trace calibration");

    const snapshot = await aionis.snapshot<Record<string, unknown>>({
      run_id: runId,
      task_signature: "judgment-calibration-product-loop",
      task_family: "judgment_calibration",
      agent_context: afterContext,
      guide_packet: afterGuide.guide_packet,
      memory_decision_trace: measure.memory_decision_trace,
      memory_decision_audit: measure.memory_decision_audit,
      effect_report: measure.effect_report,
      guide_trace_id: afterGuide.guide_trace_id,
      include_markdown: true,
    });
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    const snapshotCalibration = judgmentCalibration(operatorSnapshot?.judgment_calibration, "operator snapshot");
    assertCondition(JSON.stringify(snapshotCalibration) === JSON.stringify(traceCalibration), "snapshot calibration diverged from trace calibration");
    assertCondition(
      typeof snapshot.markdown === "string" && snapshot.markdown.includes("Judgment Calibration"),
      "operator snapshot markdown did not expose judgment calibration",
    );

    const result = {
      contract_version: "aionis_judgment_calibration_product_loop_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      integration_path: {
        sdk_client: "createAionisClient",
        product_loop: "remember -> guide -> feedback -> measure -> snapshot",
      },
      memory_ids: {
        supported_memory_id: usedMemoryId,
        unused_memory_id: unusedMemoryId,
      },
      judgment_calibration: {
        supported_memory_ids: textArray(traceCalibration.supported_memory_ids),
        unused_memory_ids: textArray(traceCalibration.unused_memory_ids),
        weak_memory_ids: textArray(traceCalibration.weak_memory_ids),
        contradicted_memory_ids: textArray(traceCalibration.contradicted_memory_ids),
        record_count: asRecord(traceCalibration.window)?.record_count ?? null,
        anchored_count: asRecord(traceCalibration.window)?.anchored_count ?? null,
        bucket_names: bucketNames(traceCalibration),
      },
      operator_audit: {
        trace_calibration_read_only: traceCalibration.authority === "read_only",
        audit_calibration_visible: auditCalibration.contract_version === "aionis_judgment_calibration_summary_v1",
        snapshot_calibration_visible: snapshotCalibration.contract_version === "aionis_judgment_calibration_summary_v1",
        snapshot_runtime_mutation: operatorSnapshot?.runtime_mutation,
      },
      checks: {
        fresh_guide_has_no_actionable_history: beforeContext.actionable_history_used === false,
        guide_exposes_both_memories: useNowIds.includes(usedMemoryId) && useNowIds.includes(unusedMemoryId),
        feedback_attributes_only_used_memory: textArray(traceCalibration.supported_memory_ids).includes(usedMemoryId),
        unreported_memory_is_unused_not_negative: textArray(traceCalibration.unused_memory_ids).includes(unusedMemoryId)
          && !textArray(traceCalibration.contradicted_memory_ids).includes(unusedMemoryId),
        judgment_calibration_read_only: traceCalibration.runtime_mutation === false && traceCalibration.authority === "read_only",
        operator_snapshot_carries_calibration: snapshotCalibration.contract_version === "aionis_judgment_calibration_summary_v1",
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
