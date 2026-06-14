#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAionisMcpClient,
  handleAionisMcpTool,
  type AionisMcpToolName,
} from "../../packages/aionis-mcp/src/tools.ts";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const TASK_SIGNATURE = "claude-code-demo-continuation";
const TASK_FAMILY = "claude_code_mcp_demo";
const WORKFLOW_SIGNATURE = "claude-code-demo-workflow";
const FAILED_TARGET = "src/legacy/checkout.ts";
const PASSED_TARGET = "packages/api/src/checkout.ts";

function apiKey(): string | null {
  return process.env.AIONIS_CLAUDE_CODE_DEMO_API_KEY?.trim()
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

function structured(output: { structuredContent?: Record<string, unknown> }, label: string): Record<string, unknown> {
  const payload = asRecord(output.structuredContent);
  assertCondition(payload, `${label} did not return structuredContent`);
  return payload;
}

async function main() {
  const runId = `claude-code-mcp-${randomUUID().slice(0, 8)}`;
  const scope = `claude-code-demo:${runId}`;
  const session = await openRuntime();
  try {
    const aionis = createAionisMcpClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
      default_guide_mode: "full_power",
    });

    async function callTool(name: AionisMcpToolName, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      return structured(await handleAionisMcpTool(aionis, name, args), name);
    }

    const health = await callTool("aionis_health");
    assertCondition(health.ok === true, "Claude Code MCP demo health check failed");

    const failedStep = await callTool("aionis_record_step", {
      run_id: runId,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      agent_id: "claude-code",
      role: "worker",
      title: "Claude Code broad route failed",
      summary: `CLAUDE_CODE_DEMO_FAILED_ROUTE broad rewrite touched ${FAILED_TARGET} and failed verifier checks.`,
      outcome: "failed",
      target_files: [FAILED_TARGET],
      acceptance_checks: ["verifier rejected broad route"],
      continuation_hint: `Do not continue ${FAILED_TARGET}; it is failed counter-evidence.`,
    });
    assertCondition(failedStep.ok === true, "Claude Code MCP demo failed-step observe failed");

    const passedStep = await callTool("aionis_record_step", {
      run_id: runId,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      agent_id: "claude-code",
      role: "worker",
      title: "Claude Code scoped route accepted",
      summary: `CLAUDE_CODE_DEMO_PASSED_ROUTE scoped continuation belongs in ${PASSED_TARGET} and passed verifier checks.`,
      outcome: "succeeded",
      target_files: [PASSED_TARGET],
      acceptance_checks: ["verifier accepted scoped route"],
      continuation_hint: `Continue ${PASSED_TARGET}; do not revive ${FAILED_TARGET}.`,
    });
    assertCondition(passedStep.ok === true, "Claude Code MCP demo passed-step observe failed");

    const context = await callTool("aionis_context", {
      run_id: runId,
      task_signature: TASK_SIGNATURE,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      agent_id: "claude-code",
      role: "reviewer",
      query_text: "Continue the Claude Code demo from the accepted checkout route without repeating the failed broad route.",
      context_mode: "compact_agent",
      budget_profile: "compact",
      max_prompt_chars: 4_000,
      repo_state: {
        existing_files: [PASSED_TARGET],
        missing_files: [FAILED_TARGET],
      },
      additional_instructions: [
        "Use Aionis as external execution memory.",
        "Do not treat blocked routes as implementation instructions.",
      ],
    });

    const agentPrompt = String(context.agent_prompt ?? "");
    const executionContext = asRecord(context.execution_context);
    const guide = asRecord(context.guide);
    const agentContext = asRecord(guide?.agent_context);
    const memoryUseReceipt = asRecord(context.memory_use_receipt);
    const memoryAdmissionRecord = asRecord(context.memory_admission_record);
    const shouldContinueMemoryIds = textArray(context.should_continue_memory_ids);
    const mustNotMemoryIds = textArray(context.must_not_memory_ids);
    const inspectFirstMemoryIds = textArray(context.inspect_first_memory_ids);

    assertCondition(context.ok === true, "Claude Code MCP demo context did not return ok=true");
    assertCondition(agentPrompt.includes("AIONIS_EXECUTION_AGENT_CONTEXT"), "Claude Code MCP demo missing execution prompt");
    assertCondition(context.feedback_required === false, "Claude Code MCP demo should be drop-in feedback-optional");
    assertCondition(executionContext?.contract_version === "aionis_execution_agent_context_v1", "Claude Code MCP demo missing execution context contract");
    assertCondition(agentContext?.contract_version === "aionis_agent_context_v1", "Claude Code MCP demo missing guide agent_context");
    assertCondition(memoryUseReceipt?.contract_version === "aionis_memory_use_receipt_v1", "Claude Code MCP demo missing memory use receipt");
    assertCondition(memoryAdmissionRecord?.contract_version === "aionis_memory_admission_record_v1", "Claude Code MCP demo missing memory admission record");
    assertCondition(shouldContinueMemoryIds.length > 0, "Claude Code MCP demo did not expose accepted route memory");
    assertCondition(
      mustNotMemoryIds.length > 0 || inspectFirstMemoryIds.length > 0,
      "Claude Code MCP demo did not expose failed-route guard memory",
    );
    assertCondition(agentPrompt.includes(PASSED_TARGET), "Claude Code MCP demo prompt did not mention accepted target");
    assertCondition(agentPrompt.includes(FAILED_TARGET), "Claude Code MCP demo prompt did not mention guarded failed target");

    const feedbackResult = {
      run_id: runId,
      outcome: "positive",
      used_surface: "use_now",
      used_memory_ids: shouldContinueMemoryIds.slice(0, 1),
      reason: "Claude Code demo used the accepted route and avoided the failed branch.",
    };

    const replay = await callTool("aionis_flight_recorder", {
      run_id: runId,
      agent_context: agentContext,
      memory_use_receipt: memoryUseReceipt,
      memory_admission_record: memoryAdmissionRecord,
      feedback_result: feedbackResult,
    });
    const flightRecorder = asRecord(replay.agent_flight_recorder);
    const replaySources = asRecord(flightRecorder?.replay_sources);
    const replayAgentView = asRecord(flightRecorder?.agent_view);
    const replayAttribution = asRecord(flightRecorder?.attribution);
    const useNowIds = textArray(replayAgentView?.use_now_memory_ids);
    const doNotUseIds = textArray(replayAgentView?.do_not_use_memory_ids);
    const blockedOrSuppressed = recordArray(flightRecorder?.blocked_or_suppressed);

    assertCondition(replay.ok === true, "Claude Code MCP demo flight recorder did not return ok=true");
    assertCondition(flightRecorder?.contract_version === "aionis_agent_flight_recorder_report_v1", "Claude Code MCP demo missing flight recorder report");
    assertCondition(flightRecorder?.agent_prompt_included === false, "Claude Code MCP demo flight recorder leaked prompt payload");
    assertCondition(flightRecorder?.runtime_mutation === false, "Claude Code MCP demo flight recorder mutated Runtime");
    assertCondition(replayAgentView?.prompt_text_included === false, "Claude Code MCP demo flight recorder included prompt text");
    assertCondition(replaySources?.has_agent_context === true, "Claude Code MCP demo flight recorder missed agent_context source");
    assertCondition(replaySources?.has_memory_use_receipt === true, "Claude Code MCP demo flight recorder missed receipt source");
    assertCondition(replaySources?.has_memory_admission_record === true, "Claude Code MCP demo flight recorder missed admission source");
    assertCondition(replaySources?.has_feedback_result === true, "Claude Code MCP demo flight recorder missed feedback source");
    assertCondition(textArray(replayAttribution?.used_memory_ids).length > 0, "Claude Code MCP demo flight recorder missed used memory attribution");

    const result = {
      contract_version: "aionis_claude_code_mcp_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      claude_code_mcp: {
        transport: "stdio",
        add_command:
          "claude mcp add --transport stdio --scope project aionis -- npx -y @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope my-project",
        tools_used: [
          "aionis_health",
          "aionis_record_step",
          "aionis_context",
          "aionis_flight_recorder",
        ],
      },
      execution_memory: {
        should_continue_memory_ids: shouldContinueMemoryIds,
        must_not_memory_ids: mustNotMemoryIds,
        inspect_first_memory_ids: inspectFirstMemoryIds,
        feedback_required: context.feedback_required,
        prompt_char_count: agentPrompt.length,
      },
      flight_recorder: {
        contract_version: flightRecorder.contract_version,
        prompt_payload_excluded: flightRecorder.agent_prompt_included === false && replayAgentView?.prompt_text_included === false,
        runtime_mutation: flightRecorder.runtime_mutation,
        use_now_memory_ids: useNowIds,
        do_not_use_memory_ids: doNotUseIds,
        blocked_or_suppressed_count: blockedOrSuppressed.length,
        feedback_attribution_present: replayAttribution?.present === true,
        replay_sources: {
          has_agent_context: replaySources?.has_agent_context,
          has_memory_use_receipt: replaySources?.has_memory_use_receipt,
          has_memory_admission_record: replaySources?.has_memory_admission_record,
          has_feedback_result: replaySources?.has_feedback_result,
        },
      },
      checks: {
        health_ok: health.ok === true,
        record_failed_branch: failedStep.ok === true,
        record_passed_branch: passedStep.ok === true,
        context_compiled: executionContext?.contract_version === "aionis_execution_agent_context_v1",
        should_continue_present: shouldContinueMemoryIds.length > 0,
        failed_branch_guard_present: mustNotMemoryIds.length > 0 || inspectFirstMemoryIds.length > 0,
        memory_use_receipt_visible: memoryUseReceipt?.contract_version === "aionis_memory_use_receipt_v1",
        memory_admission_record_visible: memoryAdmissionRecord?.contract_version === "aionis_memory_admission_record_v1",
        flight_recorder_replayed: flightRecorder?.contract_version === "aionis_agent_flight_recorder_report_v1",
        no_prompt_payload_in_recorder: flightRecorder?.agent_prompt_included === false,
        no_runtime_mutation_in_recorder: flightRecorder?.runtime_mutation === false,
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
