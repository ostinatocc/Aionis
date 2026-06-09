#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";
import {
  asRecord,
  assertCondition,
  extractChatCompletionText,
  extractJsonObject,
  postJson,
  repoRoot,
  requireEmbeddingConfig,
  requireLlmConfig,
  startRuntime,
  stopRuntime,
  type LlmConfig,
} from "./runtime-agent-loop.ts";

type SuiteGroup = "baseline" | "long_context" | "aionis";
type ScenarioKind = "execution_tree" | "summary_only_guard";

type Scenario = {
  id: string;
  title: string;
  kind: ScenarioKind;
  choices: string[];
  expectedChoice: string;
  failedChoice: string;
  task: string;
  longContextPrior?: string;
};

type AgentDecision = {
  choice: string;
  used_aionis: boolean;
  avoided_failed_branch: boolean | null;
  rationale: string | null;
};

type LlmTrialResult = {
  decision: AgentDecision;
  raw_text: string;
  usage: Record<string, unknown> | null;
  request_chars: number;
};

type TrialResult = {
  contract_version: "aionis_runtime_agent_ab_trial_v2";
  suite_run_id: string;
  trial_id: string;
  scenario_id: string;
  scenario_title: string;
  group: SuiteGroup;
  trial_index: number;
  expected_choice: string;
  failed_choice: string;
  decision: AgentDecision;
  success: boolean;
  failed_branch_leakage: boolean;
  used_aionis: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  request_chars: number;
  long_context_chars: number;
  aionis_context_chars: number;
  aionis_use_now_count: number;
  aionis_do_not_use_count: number;
  aionis_supporting_evidence_count: number;
  outcome_observed: boolean;
  outcome_evidence_backed: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    id: "branch_recovery",
    title: "Recover the verified branch and avoid the rejected branch",
    kind: "execution_tree",
    choices: ["formula_a", "formula_b", "unknown"],
    expectedChoice: "formula_b",
    failedChoice: "formula_a",
    task: "Choose which formula to execute next. The verifier accepts only the branch that is backed by prior execution evidence.",
  },
  {
    id: "negative_transfer",
    title: "Block attractive but failed transfer from contaminating the next action",
    kind: "execution_tree",
    choices: ["fast_patch", "safe_patch", "unknown"],
    expectedChoice: "safe_patch",
    failedChoice: "fast_patch",
    task: "Choose the next patch strategy. One candidate looks faster, but prior execution evidence may mark it as failed.",
  },
  {
    id: "summary_only_guard",
    title: "Inspect summary-only memory instead of applying it as a passed solution",
    kind: "summary_only_guard",
    choices: ["direct_use_summary", "inspect_evidence", "unknown"],
    expectedChoice: "inspect_evidence",
    failedChoice: "direct_use_summary",
    task: "A compact memory summary claims direct_use_summary passed, but no raw trace is visible in the task statement. Choose whether to apply it directly or inspect evidence first.",
    longContextPrior: "A compact memory note says direct_use_summary passed, but the note itself does not include raw verifier evidence.",
  },
];

function parsePositiveIntEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.trunc(value));
}

function runtimeTreeOperation(
  tree: ExecutionTreeV1,
  operation: Record<string, unknown>,
): ExecutionTreeOperationV1 {
  return {
    tree_id: tree.tree_id,
    scope: tree.scope,
    ...operation,
  } as ExecutionTreeOperationV1;
}

function buildScenarioTreeFixture(args: {
  suiteRunId: string;
  trialId: string;
  scenario: Scenario;
}): {
  baseTree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
  expectedTree: ExecutionTreeV1;
} {
  const { suiteRunId, trialId, scenario } = args;
  const baseTree = createExecutionTreeV1({
    tree_id: `tree-agent-suite-${scenario.id}-${trialId}`,
    scope: `aionis://execution-tree/agent-suite/${suiteRunId}/${scenario.id}/${trialId}`,
    task_brief: scenario.task,
    at: "2026-06-09T00:00:00.000Z",
  });
  const operations: ExecutionTreeOperationV1[] = [];
  let expectedTree = baseTree;
  const add = (operation: Record<string, unknown>) => {
    const fullOperation = runtimeTreeOperation(baseTree, operation);
    operations.push(fullOperation);
    expectedTree = applyExecutionTreeOperationV1(expectedTree, fullOperation);
  };

  add({
    type: "grow",
    operation_id: `${trialId}:grow-failed-${scenario.failedChoice}`,
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: `Try RUNTIME_AGENT_SUITE_FAILED ${scenario.failedChoice}.`,
    observation: `RUNTIME_AGENT_SUITE_FAILED ${scenario.failedChoice} failed validation and should not be reused.`,
    title: `Failed ${scenario.failedChoice}`,
    refs: [`trace://runtime-agent-suite/${trialId}/${scenario.failedChoice}/raw`],
  });
  add({
    type: "compress",
    operation_id: `${trialId}:compress-failed-${scenario.failedChoice}`,
    actor_role: "worker",
    at: "2026-06-09T00:02:00.000Z",
    title: `RUNTIME_AGENT_SUITE_FAILED ${scenario.failedChoice} rejected`,
    summary: `RUNTIME_AGENT_SUITE_FAILED ${scenario.failedChoice} failed verifier checks and must not be selected.`,
  });
  const failedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!failedSummaryNodeId) throw new Error("failed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${trialId}:maintain-failed-${scenario.failedChoice}`,
    actor_role: "verifier",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: `RUNTIME_AGENT_SUITE_FAILED verifier rejected ${scenario.failedChoice}.`,
  });
  add({
    type: "revise",
    operation_id: `${trialId}:revise-failed-${scenario.failedChoice}`,
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: `Abandon ${scenario.failedChoice} and resume from a clean branch.`,
  });
  add({
    type: "grow",
    operation_id: `${trialId}:grow-passed-${scenario.expectedChoice}`,
    actor_role: "worker",
    at: "2026-06-09T00:05:00.000Z",
    action: `Use RUNTIME_AGENT_SUITE_PASSED ${scenario.expectedChoice}.`,
    observation: `RUNTIME_AGENT_SUITE_PASSED ${scenario.expectedChoice} matched all verifier rows.`,
    title: `Passed ${scenario.expectedChoice}`,
    refs: [`trace://runtime-agent-suite/${trialId}/${scenario.expectedChoice}/raw`],
  });
  add({
    type: "compress",
    operation_id: `${trialId}:compress-passed-${scenario.expectedChoice}`,
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    title: `RUNTIME_AGENT_SUITE_PASSED ${scenario.expectedChoice} accepted`,
    summary: `RUNTIME_AGENT_SUITE_PASSED ${scenario.expectedChoice} is the verified continuation path.`,
  });
  const passedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!passedSummaryNodeId) throw new Error("passed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${trialId}:maintain-passed-${scenario.expectedChoice}`,
    actor_role: "verifier",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });

  return { baseTree, operations, expectedTree };
}

function usageNumber(usage: Record<string, unknown> | null, key: string): number | null {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDecision(value: unknown, choices: string[]): AgentDecision {
  const record = asRecord(value);
  const rawChoice = typeof record?.choice === "string" ? record.choice.trim().toLowerCase() : "unknown";
  const choice = choices.includes(rawChoice) ? rawChoice : "unknown";
  return {
    choice,
    used_aionis: record?.used_aionis === true,
    avoided_failed_branch: typeof record?.avoided_failed_branch === "boolean" ? record.avoided_failed_branch : null,
    rationale: typeof record?.rationale === "string" ? record.rationale.slice(0, 800) : null,
  };
}

function buildLongContext(args: {
  trialId: string;
  scenario: Scenario;
}): string | null {
  const { trialId, scenario } = args;
  if (scenario.kind === "summary_only_guard") {
    return [
      "LONG_CONTEXT_COMPACT_MEMORY",
      `Task: ${scenario.task}`,
      `Prior note: ${scenario.longContextPrior ?? "A compact memory note claims success."}`,
      "Raw trace: NOT PROVIDED.",
      "Verifier evidence: NOT PROVIDED.",
      "Use this only as an unverified lead, not as a passed solution.",
    ].join("\n");
  }

  return [
    "LONG_CONTEXT_RAW_HISTORY",
    `Task: ${scenario.task}`,
    "",
    "[Episode 1: failed branch raw transcript]",
    `Worker thought: ${scenario.failedChoice} looks attractive because it appears faster or simpler.`,
    `Action: Try RUNTIME_AGENT_SUITE_FAILED ${scenario.failedChoice}.`,
    `Tool input: candidate=${scenario.failedChoice}; mode=trial; scenario=${scenario.id}; run=${trialId}.`,
    `Observation: RUNTIME_AGENT_SUITE_FAILED ${scenario.failedChoice} failed validation and should not be reused.`,
    `Verifier check 1: candidate ${scenario.failedChoice} reached a terminal error state.`,
    `Verifier check 2: candidate ${scenario.failedChoice} did not satisfy the acceptance checks.`,
    `Verifier check 3: candidate ${scenario.failedChoice} produced a regression when replayed.`,
    `Verifier verdict: FAILED. Avoid ${scenario.failedChoice}.`,
    `Maintainer note: preserve this failed attempt only as negative evidence for ${scenario.failedChoice}.`,
    `Raw ref: trace://runtime-agent-suite/${trialId}/${scenario.failedChoice}/raw`,
    "",
    "[Episode 2: revise from failure raw transcript]",
    `Action: Abandon ${scenario.failedChoice} and resume from a clean branch.`,
    `Observation: The failed branch remains useful only as a negative example for ${scenario.failedChoice}.`,
    `Revision boundary: downstream steps from ${scenario.failedChoice} are invalid; earlier setup remains reusable.`,
    `Resume point: choose a new branch that can pass the verifier instead of retrying ${scenario.failedChoice}.`,
    "",
    "[Episode 3: passed branch raw transcript]",
    `Worker thought: try ${scenario.expectedChoice} after the failed branch was marked invalid.`,
    `Action: Use RUNTIME_AGENT_SUITE_PASSED ${scenario.expectedChoice}.`,
    `Tool input: candidate=${scenario.expectedChoice}; mode=trial; scenario=${scenario.id}; run=${trialId}.`,
    `Observation: RUNTIME_AGENT_SUITE_PASSED ${scenario.expectedChoice} matched all verifier rows.`,
    `Verifier check 1: candidate ${scenario.expectedChoice} stayed on the valid active path.`,
    `Verifier check 2: candidate ${scenario.expectedChoice} satisfied the acceptance checks.`,
    `Verifier check 3: candidate ${scenario.expectedChoice} replayed without the prior regression.`,
    `Verifier verdict: PASSED. Reuse ${scenario.expectedChoice}.`,
    `Maintainer note: this is the current active continuation path for the next action.`,
    `Raw ref: trace://runtime-agent-suite/${trialId}/${scenario.expectedChoice}/raw`,
  ].join("\n");
}

function routeArrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function compactAionisAgentView(assembled: Record<string, unknown>): {
  context: string;
  contextChars: number;
  useNowCount: number;
  doNotUseCount: number;
  supportingEvidenceCount: number;
} {
  const promptText = typeof assembled.prompt_text === "string"
    ? assembled.prompt_text
    : JSON.stringify(assembled);
  const trace = asRecord(assembled.selection_trace);
  const traceLine = [
    "SELECTION_TRACE",
    `passed_solution_count=${trace?.passed_solution_count ?? "null"}`,
    `failed_branch_count=${trace?.failed_branch_count ?? "null"}`,
    `supporting_evidence_count=${trace?.supporting_evidence_count ?? "null"}`,
    `memory_consolidation_guard_blocked_count=${trace?.memory_consolidation_guard_blocked_count ?? "null"}`,
    `evidence_backed_passed_solution_count=${trace?.evidence_backed_passed_solution_count ?? "null"}`,
    `evidence_backed_failed_branch_count=${trace?.evidence_backed_failed_branch_count ?? "null"}`,
    `raw_trace_count=${trace?.raw_trace_count ?? "null"}`,
  ].join(" ");
  const contextText = [
    "AIONIS_EXECUTION_CONTEXT_AGENT_VIEW_V2",
    promptText,
    traceLine,
  ].join("\n");
  return {
    context: contextText,
    contextChars: contextText.length,
    useNowCount: routeArrayCount(assembled.passed_solutions),
    doNotUseCount: routeArrayCount(assembled.failed_branches),
    supportingEvidenceCount: routeArrayCount(assembled.supporting_evidence),
  };
}

async function callScenarioLlm(args: {
  llm: LlmConfig;
  scenario: Scenario;
  group: SuiteGroup;
  longContext: string | null;
  aionisContext: string | null;
}): Promise<LlmTrialResult> {
  const baseUrl = args.llm.baseUrl.replace(/\/+$/, "");
  const userPayload = {
    scenario_id: args.scenario.id,
    group: args.group,
    task: args.scenario.task,
    prior_context: args.group === "long_context" ? args.longContext : null,
    allowed_choices: args.scenario.choices,
    aionis_context: args.group === "aionis" ? args.aionisContext : null,
    decision_policy: [
      "Return one allowed choice only.",
      "For baseline, no prior memory or runtime context is available; choose unknown unless the task itself proves a choice.",
      "For long_context, use prior_context only. Prefer raw PASSED traces and avoid raw FAILED traces.",
      "For long_context summary-only notes without raw trace or verifier evidence, choose inspect_evidence instead of direct use.",
      "For aionis, if Aionis context includes use_now or PASSED_SOLUTIONS, prefer that verified path.",
      "For aionis, if Aionis context includes do_not_use or FAILED_BRANCHES, avoid that failed path.",
      "For aionis, if Aionis context only shows SUPPORTING_EVIDENCE with promotion_blocked, choose inspect_evidence instead of direct use.",
      "For aionis, if selection_trace.memory_consolidation_guard_blocked_count is positive and there are no passed solutions, choose inspect_evidence.",
      "Set used_aionis true only when group is aionis and aionis_context influenced the choice; otherwise set it false.",
      "If no usable evidence is available, choose unknown.",
    ],
  };
  const requestBody = {
    model: args.llm.model,
    temperature: 0,
    max_tokens: args.llm.maxTokens,
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "You are a real Agent in an Aionis Runtime A/B e2e validation.",
          "Do not invent hidden validation evidence.",
          "Use prior_context only for the long_context group.",
          "Use Aionis context only for the aionis group.",
          "Return only compact JSON with keys: choice, used_aionis, avoided_failed_branch, rationale.",
          `Allowed choices: ${args.scenario.choices.join(", ")}`,
          "Keep rationale under 120 characters.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(userPayload, null, 2),
      },
    ],
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.llm.apiKey}`,
      ...(args.llm.provider === "openrouter" ? {
        "HTTP-Referer": "https://github.com/ostinatocc/Aionis",
        "X-Title": "Aionis Runtime Agent A/B E2E",
      } : {}),
    },
    body: JSON.stringify(requestBody),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`LLM call failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  const rawText = extractChatCompletionText(payload);
  if (!rawText) throw new Error(`LLM response did not contain assistant text: ${JSON.stringify(payload)}`);
  const parsed = extractJsonObject(rawText);
  if (!parsed) throw new Error(`LLM response was not parseable JSON: ${rawText}`);
  return {
    decision: parseDecision(parsed, args.scenario.choices),
    raw_text: rawText,
    usage: asRecord(asRecord(payload)?.usage),
    request_chars: JSON.stringify(requestBody).length,
  };
}

async function buildAionisContext(args: {
  baseUrl: string;
  suiteRunId: string;
  trialId: string;
  scenario: Scenario;
}): Promise<{
  context: string;
  contextChars: number;
  useNowCount: number;
  doNotUseCount: number;
  supportingEvidenceCount: number;
}> {
  if (args.scenario.kind === "summary_only_guard") {
    const taskSignature = `runtime-agent-suite-summary-only:${args.trialId}`;
    await postJson(args.baseUrl, "/v1/observe", {
      tenant_id: "default",
      scope: "default",
      input_text: "Summary-only execution memory without raw or evidence refs.",
      execution: {
        client_id: `runtime-agent-suite-summary-only:${args.trialId}`,
        run_id: args.trialId,
        task_family: "runtime-agent-suite",
        task_signature: taskSignature,
        workflow_signature: "summary-only-guard",
        title: "RUNTIME_AGENT_SUITE_SUMMARY_ONLY direct_use_summary",
        summary: "RUNTIME_AGENT_SUITE_SUMMARY_ONLY direct_use_summary allegedly passed, but no raw evidence is attached.",
        outcome: "succeeded",
        slots: {
          task_signature: taskSignature,
          execution_result_summary: {
            status: "passed",
            summary: "RUNTIME_AGENT_SUITE_SUMMARY_ONLY direct_use_summary allegedly passed without raw backing.",
          },
        },
      },
    });
    const assembled = await postJson(args.baseUrl, "/v1/execution/context/assemble", {
      tenant_id: "default",
      scope: "default",
      memory_filters: [{ slots_contains: { task_signature: taskSignature }, limit: 10 }],
    });
    return compactAionisAgentView(assembled);
  }

  const { baseTree, operations, expectedTree } = buildScenarioTreeFixture(args);
  const handoffPayload = {
    memory_lane: "private",
    anchor: `runtime-agent-suite:${args.trialId}`,
    file_path: "scripts/e2e/runtime-agent-loop-suite.ts",
    repo_root: repoRoot,
    handoff_kind: "patch_handoff",
    task_signature: `runtime-agent-suite:${args.trialId}`,
    title: `Runtime Agent suite handoff ${args.scenario.id}`,
    summary: args.scenario.title,
    handoff_text: "Recover branch-aware execution state before choosing.",
    target_files: ["scripts/e2e/runtime-agent-loop-suite.ts"],
    next_action: `Choose ${args.scenario.expectedChoice}; do not choose ${args.scenario.failedChoice}.`,
    execution_tree_disabled: true,
    execution_tree_v1: baseTree,
    execution_tree_operations_v1: operations,
  };
  const observed = await postJson(args.baseUrl, "/v1/observe", {
    tenant_id: "default",
    scope: "default",
    handoff: handoffPayload,
  });
  const observedTree = asRecord(asRecord(observed.handoff)?.execution_tree_v1);
  assertCondition(observedTree?.current_summary_node_id === expectedTree.current_summary_node_id, "observe response did not expose latest operation-applied tree");

  const recovered = await postJson(args.baseUrl, "/v1/handoff/recover", {
    tenant_id: "default",
    scope: "default",
    consumer_agent_id: "local-user",
    handoff_kind: "patch_handoff",
    anchor: handoffPayload.anchor,
    repo_root: handoffPayload.repo_root,
    file_path: handoffPayload.file_path,
  });
  const recoveredTree = asRecord(recovered.execution_tree_v1);
  assertCondition(recoveredTree?.current_summary_node_id === expectedTree.current_summary_node_id, "recover did not return latest execution tree");

  const assembled = await postJson(args.baseUrl, "/v1/execution/context/assemble", {
    tenant_id: "default",
    scope: "default",
    consumer_agent_id: "local-user",
    execution_tree_v1: recovered.execution_tree_v1,
    include_memory_evidence: false,
    include_prompt_text: true,
    prompt_detail: "compact",
  });
  assertCondition(routeArrayCount(assembled.passed_solutions) > 0, "assemble did not produce passed execution evidence");
  assertCondition(routeArrayCount(assembled.failed_branches) > 0, "assemble did not produce failed execution evidence");
  return compactAionisAgentView(assembled);
}

async function observeOutcome(args: {
  baseUrl: string;
  trialId: string;
  scenario: Scenario;
  decision: AgentDecision;
  success: boolean;
}): Promise<{ observed: boolean; evidenceBacked: boolean }> {
  const taskSignature = `runtime-agent-suite-outcome:${args.trialId}`;
  await postJson(args.baseUrl, "/v1/observe", {
    tenant_id: "default",
    scope: "default",
    input_text: `Agent selected ${args.decision.choice} for ${args.scenario.id}.`,
    execution: {
      client_id: taskSignature,
      run_id: args.trialId,
      task_family: "runtime-agent-suite",
      task_signature: taskSignature,
      workflow_signature: `runtime-agent-suite:${args.scenario.id}`,
      title: `RUNTIME_AGENT_SUITE_OUTCOME ${args.scenario.id} ${args.decision.choice}`,
      summary: `RUNTIME_AGENT_SUITE_OUTCOME ${args.decision.choice} ${args.success ? "passed" : "failed"} for ${args.scenario.id}.`,
      outcome: args.success ? "succeeded" : "failed",
      workflow_steps: [
        "Read available context",
        `Selected ${args.decision.choice}`,
      ],
      acceptance_checks: [`expected ${args.scenario.expectedChoice}`],
      continuation_hint: args.success ? `Reuse ${args.scenario.expectedChoice}.` : `Avoid ${args.decision.choice}.`,
      confidence: args.success ? 0.9 : 0.4,
      raw_ref: `trace://runtime-agent-suite/${args.trialId}/llm-choice`,
      evidence_ref: `evidence://runtime-agent-suite/${args.trialId}/verifier`,
      verification: {
        choice: args.decision.choice,
        expected_choice: args.scenario.expectedChoice,
        passed: args.success,
      },
      slots: {
        task_signature: taskSignature,
        execution_result_summary: {
          status: args.success ? "passed" : "failed",
          summary: `RUNTIME_AGENT_SUITE_OUTCOME ${args.decision.choice} ${args.success ? "passed" : "failed"} with raw evidence.`,
          diagnostic_note: args.success ? null : `Expected ${args.scenario.expectedChoice}, got ${args.decision.choice}.`,
          evidence_refs: [`evidence://runtime-agent-suite/${args.trialId}/verifier`],
        },
      },
    },
  });
  const assembled = await postJson(args.baseUrl, "/v1/execution/context/assemble", {
    tenant_id: "default",
    scope: "default",
    memory_filters: [{ slots_contains: { task_signature: taskSignature }, limit: 10 }],
  });
  const trace = asRecord(assembled.selection_trace);
  const evidenceBacked =
    Number(trace?.evidence_backed_passed_solution_count ?? 0) > 0
    || Number(trace?.evidence_backed_failed_branch_count ?? 0) > 0;
  return { observed: true, evidenceBacked };
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function summarize(results: TrialResult[]) {
  const summarizeGroup = (scenarioId: string | null, group: SuiteGroup) => {
    const rows = results.filter((row) => row.group === group && (scenarioId === null || row.scenario_id === scenarioId));
    const count = rows.length;
    const successCount = rows.filter((row) => row.success).length;
    const leakageCount = rows.filter((row) => row.failed_branch_leakage).length;
    return {
      count,
      success_count: successCount,
      success_rate: count > 0 ? successCount / count : null,
      failed_branch_leakage_count: leakageCount,
      failed_branch_leakage_rate: count > 0 ? leakageCount / count : null,
      used_aionis_count: rows.filter((row) => row.used_aionis).length,
      avg_total_tokens: average(rows.map((row) => row.total_tokens)),
      avg_prompt_tokens: average(rows.map((row) => row.prompt_tokens)),
      avg_completion_tokens: average(rows.map((row) => row.completion_tokens)),
      avg_request_chars: average(rows.map((row) => row.request_chars)),
      avg_long_context_chars: average(rows.map((row) => row.long_context_chars)),
      avg_aionis_context_chars: average(rows.map((row) => row.aionis_context_chars)),
      evidence_backed_outcomes: rows.filter((row) => row.outcome_evidence_backed).length,
    };
  };
  const delta = (left: number | null, right: number | null): number | null => (
    typeof left === "number" && typeof right === "number" ? left - right : null
  );

  const scenarios = SCENARIOS.map((scenario) => {
    const baseline = summarizeGroup(scenario.id, "baseline");
    const longContext = summarizeGroup(scenario.id, "long_context");
    const aionis = summarizeGroup(scenario.id, "aionis");
    const baselineSuccess = typeof baseline.success_rate === "number" ? baseline.success_rate : 0;
    const longContextSuccess = typeof longContext.success_rate === "number" ? longContext.success_rate : 0;
    const aionisSuccess = typeof aionis.success_rate === "number" ? aionis.success_rate : 0;
    return {
      scenario_id: scenario.id,
      title: scenario.title,
      baseline,
      long_context: longContext,
      aionis,
      uplift_success_rate_vs_baseline: aionisSuccess - baselineSuccess,
      uplift_success_rate_vs_long_context: aionisSuccess - longContextSuccess,
      token_delta_total_avg_vs_baseline: delta(aionis.avg_total_tokens, baseline.avg_total_tokens),
      token_delta_total_avg_vs_long_context: delta(aionis.avg_total_tokens, longContext.avg_total_tokens),
      request_chars_delta_avg_vs_long_context: delta(aionis.avg_request_chars, longContext.avg_request_chars),
    };
  });
  const overallBaseline = summarizeGroup(null, "baseline");
  const overallLongContext = summarizeGroup(null, "long_context");
  const overallAionis = summarizeGroup(null, "aionis");
  return {
    contract_version: "aionis_runtime_agent_ab_summary_v2",
    generated_at: new Date().toISOString(),
    scenarios,
    overall: {
      baseline: overallBaseline,
      long_context: overallLongContext,
      aionis: overallAionis,
      uplift_success_rate_vs_baseline:
        (typeof overallAionis.success_rate === "number" ? overallAionis.success_rate : 0)
        - (typeof overallBaseline.success_rate === "number" ? overallBaseline.success_rate : 0),
      uplift_success_rate_vs_long_context:
        (typeof overallAionis.success_rate === "number" ? overallAionis.success_rate : 0)
        - (typeof overallLongContext.success_rate === "number" ? overallLongContext.success_rate : 0),
      token_delta_total_avg_vs_baseline: delta(overallAionis.avg_total_tokens, overallBaseline.avg_total_tokens),
      token_delta_total_avg_vs_long_context: delta(overallAionis.avg_total_tokens, overallLongContext.avg_total_tokens),
      request_chars_delta_avg_vs_long_context: delta(overallAionis.avg_request_chars, overallLongContext.avg_request_chars),
    },
  };
}

async function main() {
  const llm = requireLlmConfig();
  const embedding = requireEmbeddingConfig();
  const trialsPerScenario = parsePositiveIntEnv("AIONIS_AGENT_E2E_TRIALS_PER_SCENARIO", parsePositiveIntEnv("AIONIS_AGENT_E2E_TRIALS", 3, 30), 30);
  const suiteRunId = `suite-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outDir = path.join(repoRoot, ".tmp", "runtime-agent-e2e");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonlPath = path.join(outDir, `${suiteRunId}.jsonl`);
  const summaryPath = path.join(outDir, `${suiteRunId}.summary.json`);
  const runtime = await startRuntime(embedding);
  const results: TrialResult[] = [];
  try {
    for (const scenario of SCENARIOS) {
      for (let trialIndex = 0; trialIndex < trialsPerScenario; trialIndex += 1) {
        for (const group of ["baseline", "long_context", "aionis"] as const) {
          const trialId = `${suiteRunId}-${scenario.id}-${group}-${trialIndex + 1}`;
          const longContext = group === "long_context"
            ? buildLongContext({ trialId, scenario })
            : null;
          const aionisContext = group === "aionis"
            ? await buildAionisContext({
                baseUrl: runtime.baseUrl,
                suiteRunId,
                trialId,
                scenario,
              })
            : {
                context: null,
                contextChars: 0,
                useNowCount: 0,
                doNotUseCount: 0,
                supportingEvidenceCount: 0,
              };
          const llmResult = await callScenarioLlm({
            llm,
            scenario,
            group,
            longContext,
            aionisContext: aionisContext.context,
          });
          const success = llmResult.decision.choice === scenario.expectedChoice;
          const failedBranchLeakage = llmResult.decision.choice === scenario.failedChoice;
          const outcome = group === "aionis"
            ? await observeOutcome({
                baseUrl: runtime.baseUrl,
                trialId,
                scenario,
                decision: llmResult.decision,
                success,
              })
            : { observed: false, evidenceBacked: false };
          const trial: TrialResult = {
            contract_version: "aionis_runtime_agent_ab_trial_v2",
            suite_run_id: suiteRunId,
            trial_id: trialId,
            scenario_id: scenario.id,
            scenario_title: scenario.title,
            group,
            trial_index: trialIndex + 1,
            expected_choice: scenario.expectedChoice,
            failed_choice: scenario.failedChoice,
            decision: llmResult.decision,
            success,
            failed_branch_leakage: failedBranchLeakage,
            used_aionis: llmResult.decision.used_aionis,
            prompt_tokens: usageNumber(llmResult.usage, "prompt_tokens"),
            completion_tokens: usageNumber(llmResult.usage, "completion_tokens"),
            total_tokens: usageNumber(llmResult.usage, "total_tokens"),
            request_chars: llmResult.request_chars,
            long_context_chars: longContext?.length ?? 0,
            aionis_context_chars: aionisContext.contextChars,
            aionis_use_now_count: aionisContext.useNowCount,
            aionis_do_not_use_count: aionisContext.doNotUseCount,
            aionis_supporting_evidence_count: aionisContext.supportingEvidenceCount,
            outcome_observed: outcome.observed,
            outcome_evidence_backed: outcome.evidenceBacked,
          };
          results.push(trial);
          appendJsonl(jsonlPath, trial);
          process.stderr.write(
            `[${scenario.id}] ${group} #${trialIndex + 1}: choice=${trial.decision.choice} success=${trial.success} leakage=${trial.failed_branch_leakage} tokens=${trial.total_tokens ?? "n/a"}\n`,
          );
        }
      }
    }
    const summary = {
      ...summarize(results),
      suite_run_id: suiteRunId,
      llm: {
        provider: llm.provider,
        base_url: llm.baseUrl,
        model: llm.model,
      },
      embedding: {
        provider: embedding.provider,
      },
      trials_per_scenario: trialsPerScenario,
      output: {
        jsonl_path: jsonlPath,
        summary_path: summaryPath,
      },
    };
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    stopRuntime(runtime);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
