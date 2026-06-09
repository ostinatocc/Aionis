#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  repoRoot,
  requireEmbeddingConfig,
  startRuntime,
  stopRuntime,
  type EmbeddingConfig,
  type RuntimeHandle,
} from "./runtime-agent-loop.ts";

type RuntimeSession = {
  baseUrl: string;
  mode: "external" | "spawned";
  embedding: EmbeddingConfig | null;
  handle: RuntimeHandle | null;
};

type AgentDecision = {
  target_file: string;
  used_aionis: boolean;
  rationale: string;
};

const CONSUMER_AGENT_ID = "local-user";

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

function buildExecutionTreeFixture(runId: string): {
  baseTree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
  expectedTree: ExecutionTreeV1;
} {
  const baseTree = createExecutionTreeV1({
    tree_id: `tree-product-four-api-${runId}`,
    scope: `aionis://execution-tree/product-four-api/${runId}`,
    task_brief: "Compile compact agent context from passed and failed execution branches.",
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
    operation_id: `${runId}:grow-failed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: "Try PRODUCT_E2E_TREE_FAILED legacy_patch.",
    observation: "PRODUCT_E2E_TREE_FAILED legacy_patch failed verifier replay and must not be reused.",
    title: "Failed legacy patch",
    refs: [`trace://product-four-api/${runId}/legacy-patch/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-failed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:02:00.000Z",
    title: "PRODUCT_E2E_TREE_FAILED legacy_patch rejected",
    summary: "PRODUCT_E2E_TREE_FAILED legacy_patch caused verifier regression.",
  });
  const failedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!failedSummaryNodeId) throw new Error("failed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:maintain-failed-branch`,
    actor_role: "verifier",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "Verifier rejected PRODUCT_E2E_TREE_FAILED legacy_patch.",
  });
  add({
    type: "revise",
    operation_id: `${runId}:revise-failed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "Resume from a clean branch instead of repeating legacy_patch.",
  });
  add({
    type: "grow",
    operation_id: `${runId}:grow-passed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:05:00.000Z",
    action: "Use PRODUCT_E2E_TREE_PASSED scoped_patch.",
    observation: "PRODUCT_E2E_TREE_PASSED scoped_patch matched all verifier checks.",
    title: "Passed scoped patch",
    refs: [`trace://product-four-api/${runId}/scoped-patch/raw`],
  });
  add({
    type: "compress",
    operation_id: `${runId}:compress-passed-branch`,
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    title: "PRODUCT_E2E_TREE_PASSED scoped_patch accepted",
    summary: "PRODUCT_E2E_TREE_PASSED scoped_patch is the verified active continuation.",
  });
  const passedSummaryNodeId = expectedTree.current_summary_node_id;
  if (!passedSummaryNodeId) throw new Error("passed branch did not create summary node");
  add({
    type: "maintain",
    operation_id: `${runId}:maintain-passed-branch`,
    actor_role: "verifier",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });

  return { baseTree, operations, expectedTree };
}

async function openRuntime(): Promise<RuntimeSession> {
  const externalBaseUrl = (
    process.env.AIONIS_PRODUCT_E2E_BASE_URL
    || process.env.AIONIS_BASE_URL
    || process.env.AIONIS_URL
    || ""
  ).trim();
  if (externalBaseUrl) {
    return {
      baseUrl: externalBaseUrl.replace(/\/+$/, ""),
      mode: "external",
      embedding: null,
      handle: null,
    };
  }

  const embedding = requireEmbeddingConfig();
  const handle = await startRuntime(embedding);
  return {
    baseUrl: handle.baseUrl,
    mode: "spawned",
    embedding,
    handle,
  };
}

function closeRuntime(session: RuntimeSession): void {
  if (session.handle) stopRuntime(session.handle);
}

async function postRuntimeJson(args: {
  baseUrl: string;
  pathName: string;
  apiKey: string | null;
  payload: unknown;
}): Promise<Record<string, unknown>> {
  const res = await fetch(`${args.baseUrl}${args.pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(args.apiKey ? { authorization: `Bearer ${args.apiKey}` } : {}),
    },
    body: JSON.stringify(args.payload),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${args.pathName} failed with ${res.status}: ${JSON.stringify(parsed)}`);
  }
  const record = asRecord(parsed);
  assertCondition(record, `${args.pathName} returned non-object JSON`);
  return record;
}

function nodeIdFromObserve(observeBody: Record<string, unknown>, label: string): string {
  const write = asRecord(observeBody.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes : [];
  const first = asRecord(nodes[0]);
  const id = first?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} observe did not return a memory node id`);
  return id;
}

function agentContext(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assertCondition(record?.contract_version === "aionis_agent_context_v1", `${label} did not return agent_context v1`);
  assertCondition(typeof record.prompt_text === "string" && record.prompt_text.length > 0, `${label} agent_context missing prompt_text`);
  return record;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "decision_reviews",
    "raw_memory_rows",
    "raw_slots",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

function simulateAgent(context: Record<string, unknown>): AgentDecision {
  const promptText = String(context.prompt_text ?? "");
  const useNow = textArray(context.use_now).join("\n");
  if (promptText.includes("PRODUCT_E2E_TARGET_FILE") || useNow.includes("PRODUCT_E2E_TARGET_FILE")) {
    return {
      target_file: "src/product-e2e/current-target.ts",
      used_aionis: true,
      rationale: "Aionis surfaced the verified target file in compact agent context.",
    };
  }
  return {
    target_file: "unknown",
    used_aionis: false,
    rationale: "No usable Aionis target file guidance was visible.",
  };
}

async function runProductLoop(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  scope: string;
}) {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.scope,
  });
  await client.health();

  const queryText = "PRODUCT_E2E_TARGET_FILE continue the scoped target-file workflow";
  const beforeGuide = await client.guide<Record<string, unknown>>({
    query_text: queryText,
    consumer_agent_id: CONSUMER_AGENT_ID,
    limit: 8,
    include_packets: true,
  });
  const beforeContext = agentContext(beforeGuide.agent_context, "before guide");
  assertPromptBoundary(String(beforeContext.prompt_text), "before guide");

  const continuityObserve = await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "private",
    execution: {
      run_id: `run:${args.runId}:continuity`,
      task_id: `task:${args.runId}:continuity`,
      task_family: "product_four_api_continuity",
      task_signature: `product-four-api:${args.runId}`,
      workflow_signature: "recover-target-file-before-broad-search",
      title: "PRODUCT_E2E_TARGET_FILE scoped target-file continuation",
      summary: "PRODUCT_E2E_TARGET_FILE current target file is src/product-e2e/current-target.ts. Reuse this scoped workflow before broad discovery.",
      outcome: "succeeded",
      target_files: ["src/product-e2e/current-target.ts"],
      workflow_steps: [
        "Read src/product-e2e/current-target.ts",
        "Apply the scoped change",
        "Run the focused verifier",
      ],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["focused verifier passed"],
      continuation_hint: "Start with src/product-e2e/current-target.ts and avoid broad rediscovery.",
      confidence: 0.92,
      evidence: [{
        ref: `evidence://product-four-api/${args.runId}/continuity-verifier`,
        summary: "Focused verifier passed after the scoped edit.",
      }],
    },
  });
  const continuityMemoryId = nodeIdFromObserve(continuityObserve, "continuity");

  const afterGuide = await client.guide<Record<string, unknown>>({
    query_text: queryText,
    consumer_agent_id: CONSUMER_AGENT_ID,
    tool_candidates: ["read", "edit", "test"],
    limit: 8,
    include_packets: true,
  });
  const afterContext = agentContext(afterGuide.agent_context, "after guide");
  assertPromptBoundary(String(afterContext.prompt_text), "after guide");
  assertCondition(afterContext.history_used === true, "after guide did not use observed history");
  assertCondition(
    textArray(afterContext.use_now).some((entry) => entry.includes("PRODUCT_E2E_TARGET_FILE"))
      || String(afterContext.prompt_text).includes("PRODUCT_E2E_TARGET_FILE"),
    "after guide did not surface the observed continuity memory",
  );

  const decision = simulateAgent(afterContext);
  assertCondition(decision.used_aionis, "simulated agent did not use Aionis context");
  assertCondition(decision.target_file === "src/product-e2e/current-target.ts", "simulated agent selected the wrong target file");

  await client.observe<Record<string, unknown>>({
    auto_embed: true,
    input_text: "Product e2e simulated agent used the compact Aionis agent context.",
    execution: {
      run_id: `run:${args.runId}:agent-outcome`,
      task_family: "product_four_api_continuity",
      task_signature: `product-four-api-outcome:${args.runId}`,
      workflow_signature: "agent-used-aionis-context",
      title: "PRODUCT_E2E_AGENT_OUTCOME used target-file memory",
      summary: `PRODUCT_E2E_AGENT_OUTCOME selected ${decision.target_file} after reading Aionis agent_context.`,
      outcome: "succeeded",
      target_files: [decision.target_file],
      workflow_steps: ["Read agent_context.prompt_text", "Use target-file memory", "Avoid broad rediscovery"],
      acceptance_checks: ["selected current target file"],
      continuation_hint: "Keep passing only compact agent_context to the Agent.",
      confidence: 0.9,
      raw_ref: `trace://product-four-api/${args.runId}/agent-outcome`,
      evidence_ref: `evidence://product-four-api/${args.runId}/agent-outcome-verifier`,
      verification: {
        target_file: decision.target_file,
        passed: true,
      },
      slots: {
        task_signature: `product-four-api-outcome:${args.runId}`,
        execution_result_summary: {
          status: "passed",
          summary: "PRODUCT_E2E_AGENT_OUTCOME passed with raw evidence.",
          evidence_refs: [`evidence://product-four-api/${args.runId}/agent-outcome-verifier`],
        },
      },
    },
  });

  const archiveObserve = await client.observe<Record<string, unknown>>({
    auto_embed: true,
    memory_lane: "private",
    input_text: "Archive PRODUCT_E2E_ARCHIVE_WORKFLOW until this product e2e task needs it again.",
    memory: {
      client_id: `product-four-api-archive:${args.runId}`,
      type: "procedure",
      tier: "archive",
      memory_kind: "execution_workflow",
      title: "PRODUCT_E2E_ARCHIVE_WORKFLOW archived workflow",
      text_summary: "PRODUCT_E2E_ARCHIVE_WORKFLOW can be rehydrated when the same continuation need returns.",
      confidence: 0.83,
    },
  });
  const archiveMemoryId = nodeIdFromObserve(archiveObserve, "archive");

  const forget = await client.forget<Record<string, unknown>>({
    operation: "rehydrate",
    target: "archive",
    memory_ids: [archiveMemoryId],
    target_tier: "hot",
    reason: "The product e2e continuation needs the archived workflow again.",
  });
  const forgetEffect = asRecord(forget.forget_effect);
  assertCondition(forget.operation === "rehydrate", "forget operation was not rehydrate");
  assertCondition(forgetEffect?.changed_count === 1, "forget did not rehydrate exactly one archived memory");

  const measure = await client.measure<Record<string, unknown>>({
    task: {
      task_id: `task:${args.runId}:product-loop`,
      run_id: `run:${args.runId}:product-loop`,
      task_signature: `product-four-api:${args.runId}`,
      task_family: "product_four_api_loop",
    },
    product_trace: {
      before_guide: beforeGuide,
      after_guide: afterGuide,
      forget_result: forget,
      sufficient_evidence: true,
      evidence_ids: [
        `product_trace:product-four-api:${args.runId}`,
        `memory:${continuityMemoryId}`,
      ],
    },
  });
  const effectReport = asRecord(measure.effect_report);
  const historyImpact = asRecord(effectReport?.history_impact);
  assertCondition(measure.contract_version === "aionis_measure_result_v1", "measure did not return measure result v1");
  assertCondition(historyImpact?.impact_direction === "positive", "measure did not report positive history impact");
  assertCondition(historyImpact?.changed_future_behavior === true, "measure did not report changed future behavior");

  return {
    before_history_used: beforeContext.history_used,
    after_history_used: afterContext.history_used,
    after_use_now_count: textArray(afterContext.use_now).length,
    after_prompt_chars: String(afterContext.prompt_text).length,
    continuity_memory_id: continuityMemoryId,
    archive_memory_id: archiveMemoryId,
    agent_decision: decision,
    forget_changed_count: forgetEffect.changed_count,
    measure_history_impact: historyImpact.impact_direction,
  };
}

async function runExecutionContextLoop(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  scope: string;
}) {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.scope,
  });
  const { baseTree, operations, expectedTree } = buildExecutionTreeFixture(args.runId);
  const handoffPayload = {
    memory_lane: "private",
    anchor: `product-four-api:${args.runId}`,
    file_path: "scripts/e2e/product-four-api-loop.ts",
    repo_root: repoRoot,
    handoff_kind: "patch_handoff",
    task_signature: `product-four-api-tree:${args.runId}`,
    title: "Product four API execution-tree handoff",
    summary: "Use the passed scoped patch and avoid the failed legacy patch.",
    handoff_text: "Recover branch-aware execution state before choosing.",
    target_files: ["scripts/e2e/product-four-api-loop.ts"],
    next_action: "Choose scoped_patch; do not repeat legacy_patch.",
    execution_tree_disabled: true,
    execution_tree_v1: baseTree,
    execution_tree_operations_v1: operations,
  };

  const observed = await client.observe<Record<string, unknown>>({
    handoff: handoffPayload,
  });
  const observedTree = asRecord(asRecord(observed.handoff)?.execution_tree_v1);
  assertCondition(
    observedTree?.current_summary_node_id === expectedTree.current_summary_node_id,
    "observe handoff did not expose the latest operation-applied tree",
  );

  const assembled = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/execution/context/assemble",
    apiKey: args.apiKey,
    payload: {
    tenant_id: "default",
    scope: args.scope,
    consumer_agent_id: CONSUMER_AGENT_ID,
    execution_tree_v1: observedTree,
      context_mode: "full_power",
      include_memory_evidence: false,
      include_prompt_text: true,
      include_agent_context: true,
      agent_context_char_budget: 4096,
    },
  });
  const executionContext = agentContext(assembled.agent_context, "execution context assemble");
  const executionPrompt = String(executionContext.prompt_text);
  assertPromptBoundary(executionPrompt, "execution context assemble");
  assertCondition(!executionPrompt.includes("RAW_EVIDENCE"), "execution agent prompt leaked RAW_EVIDENCE");
  assertCondition(!executionPrompt.includes("TRACE"), "execution agent prompt leaked TRACE");
  assertCondition(textArray(executionContext.use_now).some((entry) => entry.includes("PRODUCT_E2E_TREE_PASSED")), "execution agent context missing passed branch");
  assertCondition(textArray(executionContext.do_not_use).some((entry) => entry.includes("PRODUCT_E2E_TREE_FAILED")), "execution agent context missing failed branch");
  assertCondition(String(assembled.prompt_text ?? "").includes("RAW_EVIDENCE"), "audit prompt_text should retain RAW_EVIDENCE in full_power mode");
  assertCondition(asRecord(assembled.full_power_trace) !== null, "full_power_trace was missing from audit surface");

  return {
    tree_id: observedTree.tree_id,
    use_now_count: textArray(executionContext.use_now).length,
    do_not_use_count: textArray(executionContext.do_not_use).length,
    prompt_chars: executionPrompt.length,
    audit_prompt_has_raw_evidence: String(assembled.prompt_text ?? "").includes("RAW_EVIDENCE"),
  };
}

async function main() {
  const runId = `product-${randomUUID().slice(0, 8)}`;
  const scope = `product-four-api-e2e:${runId}`;
  const apiKey = process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
  const session = await openRuntime();
  try {
    const productLoop = await runProductLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const executionContextLoop = await runExecutionContextLoop({
      baseUrl: session.baseUrl,
      apiKey,
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_product_four_api_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_loop: productLoop,
      execution_context_loop: executionContextLoop,
      checks: {
        sdk_observe_guide_forget_measure: true,
        guide_agent_context_prompt_boundary: true,
        measure_positive_history_impact: true,
        execution_context_agent_prompt_boundary: true,
        execution_context_passed_failed_split: true,
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
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
