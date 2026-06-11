#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatE2eError } from "./e2e-error.ts";
import {
  closeRuntime,
  openRuntime,
} from "./multi-agent-execution-memory-loop.ts";
import { runMultiAgentHostTemplateLoop } from "./multi-agent-host-template-loop.ts";

function apiKey(): string | null {
  return process.env.AIONIS_MULTI_AGENT_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

async function main() {
  const runId = `multi-agent-quickstart-${randomUUID().slice(0, 8)}`;
  const scope = `multi-agent-quickstart:${runId}`;
  const session = await openRuntime();
  try {
    const loop = await runMultiAgentHostTemplateLoop({
      baseUrl: session.baseUrl,
      apiKey: apiKey(),
      runId,
      scope,
    });

    const result = {
      contract_version: "aionis_multi_agent_quickstart_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      integration_path: {
        sdk_client: "createAionisClient",
        adapter: "createExecutionMemoryAdapter",
        host_template: "createMultiAgentHostTemplate",
        product_loop: "observe -> guide -> agent action -> feedback -> measure -> snapshot",
      },
      agent_context: {
        before_actionable_history_used: loop.before_actionable_history_used,
        after_actionable_history_used: loop.reviewer_actionable_history_used,
        prompt_contract_version: loop.reviewer_prompt_contract_version,
        prompt_char_count: loop.reviewer_prompt_char_count,
        prompt_preview: loop.reviewer_prompt_preview,
        use_now_count: loop.reviewer_use_now_count,
        do_not_use_count: loop.execution_do_not_use_count,
        exposed_use_now_memory_ids: loop.reviewer_use_now_memory_ids,
      },
      memory_governance: {
        planner_memory_id: loop.planner_memory_id,
        failed_memory_id: loop.failed_memory_id,
        passed_memory_id: loop.passed_memory_id,
        reviewer_memory_id: loop.reviewer_memory_id,
        branch_isolation: loop.operator_snapshot_branch_isolation,
        feedback_changed_count: loop.feedback_changed_count,
        measure_history_impact: loop.measure_history_impact,
      },
      operator_audit: {
        memory_use_receipt_visible: loop.operator_snapshot_memory_use_receipt_visible,
        feedback_attribution_present: loop.operator_snapshot_feedback_attribution_present,
        effect_impact: loop.operator_snapshot_effect_impact,
        trace_to_procedure_present: loop.operator_snapshot_trace_to_procedure_present,
        trace_to_procedure_status: loop.operator_snapshot_trace_to_procedure_status,
        trace_to_procedure_source_surfaces: loop.operator_snapshot_trace_to_procedure_source_surfaces,
      },
      checks: {
        starts_without_actionable_history: loop.before_actionable_history_used === false,
        reviewer_gets_actionable_execution_memory: loop.reviewer_actionable_history_used === true,
        reviewer_continues_passed_branch: loop.reviewer_decision.next_action === "continue_passed_branch",
        reviewer_avoids_failed_branch: loop.reviewer_decision.avoided_failed_branch === true,
        guide_feedback_attributed: loop.operator_snapshot_feedback_attribution_present === true,
        positive_history_impact_measured: loop.measure_history_impact === "positive",
        operator_snapshot_read_only: true,
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
