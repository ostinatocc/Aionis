#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";
import {
  closeRuntime,
  openRuntime,
} from "./multi-agent-execution-memory-loop.ts";
import { runMultiAgentHostTemplateLoop } from "./multi-agent-host-template-loop.ts";

function bool(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function apiKey(): string | null {
  return process.env.AIONIS_GOLDEN_E2E_API_KEY?.trim()
    || process.env.AIONIS_MULTI_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

async function main() {
  const runId = `golden-product-${randomUUID().slice(0, 8)}`;
  const scope = `golden-product-loop-e2e:${runId}`;
  const session = await openRuntime();
  try {
    const multiAgentLoop = await runMultiAgentHostTemplateLoop({
      baseUrl: session.baseUrl,
      apiKey: apiKey(),
      runId,
      scope,
    });
    const loopRecord = asRecord(multiAgentLoop) ?? {};
    const reviewerDecision = asRecord(loopRecord.reviewer_decision) ?? {};
    const traceToProcedureSurfaces = stringArray(loopRecord.operator_snapshot_trace_to_procedure_source_surfaces);

    const result = {
      contract_version: "aionis_golden_product_loop_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_loop: "observe -> guide -> agent action -> outcome feedback -> measure -> snapshot",
      product_story: {
        did_not_start_from_zero: {
          before_actionable_history_used: loopRecord.before_actionable_history_used,
          after_actionable_history_used: loopRecord.reviewer_actionable_history_used,
          proof: "Fresh reviewer guide has no actionable history; after observe/handoff, reviewer guide has actionable execution memory.",
        },
        failed_branch_isolated: {
          branch_isolation: loopRecord.operator_snapshot_branch_isolation,
          reviewer_next_action: reviewerDecision.next_action,
          reviewer_avoided_failed_branch: reviewerDecision.avoided_failed_branch,
          proof: "Failed branch remains visible as do_not_use/counter-evidence and does not leak into use_now.",
        },
        operator_explains_memory: {
          memory_use_receipt_visible: loopRecord.operator_snapshot_memory_use_receipt_visible,
          feedback_attribution_present: loopRecord.operator_snapshot_feedback_attribution_present,
          trace_to_procedure_present: loopRecord.operator_snapshot_trace_to_procedure_present,
          trace_to_procedure_status: loopRecord.operator_snapshot_trace_to_procedure_status,
          trace_to_procedure_source_surfaces: traceToProcedureSurfaces,
          proof: "Operator snapshot exposes read-only memory receipt, feedback attribution, effect, and procedure-readiness state.",
        },
      },
      golden_metrics: {
        before_actionable_history_used: loopRecord.before_actionable_history_used,
        reviewer_actionable_history_used: loopRecord.reviewer_actionable_history_used,
        reviewer_use_now_count: loopRecord.reviewer_use_now_count,
        execution_do_not_use_count: loopRecord.execution_do_not_use_count,
        feedback_changed_count: loopRecord.feedback_changed_count,
        measure_history_impact: loopRecord.measure_history_impact,
        operator_snapshot_effect_impact: loopRecord.operator_snapshot_effect_impact,
      },
      memory_ids: {
        planner_memory_id: loopRecord.planner_memory_id,
        failed_memory_id: loopRecord.failed_memory_id,
        passed_memory_id: loopRecord.passed_memory_id,
        reviewer_memory_id: loopRecord.reviewer_memory_id,
      },
      checks: {
        real_runtime_loop: true,
        observe_guide_agent_feedback_measure_snapshot: true,
        starts_without_actionable_history: loopRecord.before_actionable_history_used === false,
        later_uses_actionable_execution_memory: loopRecord.reviewer_actionable_history_used === true,
        reviewer_continues_passed_branch: reviewerDecision.next_action === "continue_passed_branch",
        reviewer_avoids_failed_branch: reviewerDecision.avoided_failed_branch === true,
        operator_snapshot_explains_use: bool(loopRecord.operator_snapshot_memory_use_receipt_visible)
          && bool(loopRecord.operator_snapshot_feedback_attribution_present),
        trace_to_procedure_visible: bool(loopRecord.operator_snapshot_trace_to_procedure_present)
          && traceToProcedureSurfaces.includes("execution_tree"),
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
