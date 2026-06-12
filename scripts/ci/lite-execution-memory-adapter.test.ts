import assert from "node:assert/strict";
import test from "node:test";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import {
  EXECUTION_MEMORY_ADAPTER_CONTRACT,
  createExecutionMemoryAdapter,
  exposedUseNowMemoryIds,
  type ExecutionMemoryClient,
} from "../../src/adapters/execution-memory.ts";

function operation(treeId: string, scope: string, value: Record<string, unknown>): ExecutionTreeOperationV1 {
  return {
    tree_id: treeId,
    scope,
    ...value,
  } as ExecutionTreeOperationV1;
}

function recordingClient(calls: Array<{ method: string; body: Record<string, unknown>; options: unknown }>): ExecutionMemoryClient {
  return {
    async observe(body, options) {
      calls.push({ method: "observe", body, options });
      return { memory_write: { nodes: [{ id: "memory-recorded" }] } };
    },
    async guide(body, options) {
      calls.push({ method: "guide", body, options });
      return { guide_trace_id: "guide-recorded", agent_context: { use_now_memory_ids: [] } };
    },
    async forget(body, options) {
      calls.push({ method: "forget", body, options });
      return { operation: "activate" };
    },
    async measure(body, options) {
      calls.push({ method: "measure", body, options });
      return { contract_version: "aionis_measure_result_v1" };
    },
    async operatorSnapshot(body, options) {
      calls.push({ method: "operatorSnapshot", body, options });
      return { contract_version: "aionis_operator_snapshot_result_v1" };
    },
  };
}

test("execution memory adapter exposes a stable host-facing contract", () => {
  assert.equal(EXECUTION_MEMORY_ADAPTER_CONTRACT.contract_version, "aionis_execution_memory_adapter_v1");
  assert.equal(EXECUTION_MEMORY_ADAPTER_CONTRACT.default_guide_mode, "full_power");
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.host_required.includes("agent_id_or_default_agent_id"));
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.host_required.includes("run_id"));
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.host_required.includes("task_signature"));
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.shared_memory_required.includes("team_id_or_default_team_id"));
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.advanced_optional.includes("execution_tree_v1"));
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.advanced_optional.includes("guide_run_id"));
  assert.ok(EXECUTION_MEMORY_ADAPTER_CONTRACT.advanced_optional.includes("operator_snapshot"));
});

test("execution memory adapter wires multi-agent observe, full-power guide, feedback, and measure", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown>; options: unknown }> = [];
  const tree = createExecutionTreeV1({
    tree_id: "tree-adapter-contract",
    scope: "aionis://execution-tree/adapter-contract",
    task_brief: "Adapter contract tree",
    at: "2026-06-09T00:00:00.000Z",
  });
  const evolvedTree = applyExecutionTreeOperationV1(tree, operation(tree.tree_id, tree.scope, {
    type: "grow",
    operation_id: "adapter-contract:grow",
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: "Use ADAPTER_CONTRACT_PASSED branch.",
    observation: "ADAPTER_CONTRACT_PASSED branch passed.",
    title: "Adapter passed branch",
  }));

  let guideCount = 0;
  const client: ExecutionMemoryClient = {
    async observe(body, options) {
      calls.push({ method: "observe", body, options });
      if (body.handoff) {
        return {
          handoff: {
            execution_tree_v1: evolvedTree,
          },
        };
      }
      return {
        memory_write: {
          nodes: [{ id: `memory-${calls.length}` }],
        },
      };
    },
    async guide(body, options) {
      calls.push({ method: "guide", body, options });
      guideCount += 1;
      return {
        guide_trace_id: `guide-trace-adapter-contract-${guideCount}`,
        source_map: {
          routes_used: ["/v1/execution/context/assemble"],
        },
        agent_context: {
          contract_version: "aionis_agent_context_v1",
          use_now_memory_ids: ["memory-passed"],
        },
      };
    },
    async forget(body, options) {
      calls.push({ method: "forget", body, options });
      return {
        operation: "activate",
        forget_effect: { changed_count: 1 },
      };
    },
    async measure(body, options) {
      calls.push({ method: "measure", body, options });
      return {
        contract_version: "aionis_measure_result_v1",
        effect_report: { history_impact: { impact_direction: "positive" } },
        memory_decision_trace: { contract_version: "aionis_memory_decision_trace_v1" },
        memory_decision_audit: { contract_version: "aionis_memory_decision_audit_report_v1" },
      };
    },
    async operatorSnapshot(body, options) {
      calls.push({ method: "operatorSnapshot", body, options });
      return {
        contract_version: "aionis_operator_snapshot_result_v1",
        operator_snapshot: { contract_version: "aionis_operator_snapshot_v1" },
      };
    },
  };

  const adapter = createExecutionMemoryAdapter({
    client,
    tenant_id: "tenant-a",
    scope: "scope-a",
    team_id: "team-a",
    default_agent_id: "planner-a",
    default_agent_role: "planner",
  });

  await adapter.observeRunStart({
    run_id: "run-adapter",
    task_id: "task-adapter",
    task_signature: "adapter-contract",
    task_family: "adapter_family",
    workflow_signature: "adapter-workflow",
    title: "ADAPTER_CONTRACT_PLAN",
    summary: "Planner created the adapter contract plan.",
  });
  await adapter.observeStep({
    run_id: "run-adapter",
    task_signature: "adapter-contract",
    agent_id: "worker-a",
    role: "worker",
    title: "Adapter handoff",
    summary: "Persist latest tree",
    handoff: {
      anchor: "adapter-contract",
      handoff_kind: "task_handoff",
      execution_tree_v1: tree,
    },
  });
  const beforeGuide = await adapter.guideNext<Record<string, unknown>>({
    run_id: "run-adapter",
    task_signature: "adapter-contract",
    agent_id: "reviewer-a",
    role: "reviewer",
    query_text: "inspect ADAPTER_CONTRACT_PASSED before execution",
  });
  const guide = await adapter.guideNext<Record<string, unknown>>({
    run_id: "run-adapter",
    task_signature: "adapter-contract",
    agent_id: "reviewer-a",
    role: "reviewer",
    query_text: "continue ADAPTER_CONTRACT_PASSED",
  });
  assert.deepEqual(exposedUseNowMemoryIds(guide), ["memory-passed"]);
  assert.equal(beforeGuide.guide_trace_id, "guide-trace-adapter-contract-1");
  assert.equal(guide.guide_trace_id, "guide-trace-adapter-contract-2");
  await adapter.observeOutcome({
    run_id: "run-adapter",
    task_signature: "adapter-contract",
    agent_id: "reviewer-a",
    role: "reviewer",
    title: "Adapter reviewer outcome",
    summary: "Reviewer used adapter context successfully.",
    outcome: "succeeded",
    used_memory_ids: ["memory-passed"],
    runtime_signal_refs: ["evidence://adapter-contract/reviewer"],
  });
  const measure = await adapter.measureRun<Record<string, unknown>>({
    run_id: "run-adapter",
    task_id: "task-adapter",
    task_signature: "adapter-contract",
    task_family: "adapter_family",
    evidence_ids: ["memory:memory-passed"],
  });
  await adapter.operatorSnapshotRun({
    run_id: "run-adapter",
    task_signature: "adapter-contract",
    task_family: "adapter_family",
    workflow_signature: "adapter-workflow",
    measure_result: measure,
  });

  const observeStart = calls[0];
  assert.equal(observeStart?.method, "observe");
  assert.equal(observeStart.body.producer_agent_id, "planner-a");
  assert.equal(observeStart.body.owner_team_id, "team-a");
  assert.equal((observeStart.options as Record<string, unknown>).tenant_id, "tenant-a");
  assert.equal((observeStart.options as Record<string, unknown>).scope, "scope-a");

  const guideCall = calls.find((call) => call.method === "guide");
  assert.ok(guideCall);
  assert.equal(guideCall.body.mode, "full_power");
  assert.equal(guideCall.body.agent_role, "reviewer");
  assert.equal(guideCall.body.consumer_agent_id, "reviewer-a");
  assert.equal(guideCall.body.consumer_team_id, "team-a");
  assert.equal((guideCall.body.context as Record<string, unknown>).task_signature, "adapter-contract");
  assert.deepEqual(guideCall.body.execution_tree_v1, evolvedTree);

  const forgetCall = calls.find((call) => call.method === "forget");
  assert.ok(forgetCall);
  assert.equal(forgetCall.body.guide_trace_id, "guide-trace-adapter-contract-2");
  assert.deepEqual(forgetCall.body.used_memory_ids, ["memory-passed"]);
  assert.equal(forgetCall.body.outcome, "positive");
  assert.equal(forgetCall.body.verifier_status, "passed");
  assert.equal(forgetCall.body.tool_status, "succeeded");

  const measureCall = calls.find((call) => call.method === "measure");
  assert.ok(measureCall);
  const productTrace = measureCall.body.product_trace as Record<string, unknown>;
  assert.equal((productTrace.before_guide as Record<string, unknown>).guide_trace_id, "guide-trace-adapter-contract-1");
  assert.equal((productTrace.after_guide as Record<string, unknown>).guide_trace_id, "guide-trace-adapter-contract-2");
  assert.ok(productTrace.forget_result);
  assert.deepEqual(productTrace.evidence_ids, ["memory:memory-passed"]);

  const snapshotCall = calls.find((call) => call.method === "operatorSnapshot");
  assert.ok(snapshotCall);
  assert.equal(snapshotCall.body.run_id, "run-adapter");
  assert.equal(snapshotCall.body.task_signature, "adapter-contract");
  assert.equal(snapshotCall.body.guide_trace_id, "guide-trace-adapter-contract-2");
  assert.equal((snapshotCall.body.agent_context as Record<string, unknown>).contract_version, "aionis_agent_context_v1");
  assert.deepEqual(snapshotCall.body.effect_report, { history_impact: { impact_direction: "positive" } });
  assert.equal((snapshotCall.body.memory_decision_trace as Record<string, unknown>).contract_version, "aionis_memory_decision_trace_v1");
  assert.equal((snapshotCall.body.memory_decision_audit as Record<string, unknown>).contract_version, "aionis_memory_decision_audit_report_v1");
  assert.equal(snapshotCall.body.include_markdown, true);
});

test("execution memory adapter passes compact agent context as guide rendering mode", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown>; options: unknown }> = [];
  const adapter = createExecutionMemoryAdapter({
    client: recordingClient(calls),
    tenant_id: "tenant-compact",
    scope: "scope-compact",
    team_id: "team-compact",
    default_agent_id: "reviewer-compact",
    default_agent_role: "reviewer",
  });

  await adapter.guideNext({
    run_id: "run-compact",
    task_signature: "compact-adapter",
    query_text: "Continue the active path with a compact prompt.",
    context_mode: "compact_agent",
  });

  const guideCall = calls.find((call) => call.method === "guide");
  assert.ok(guideCall);
  assert.equal(guideCall.body.mode, "full_power");
  assert.equal(guideCall.body.context_mode, "compact_agent");
});

test("execution memory adapter prefers first-class SDK feedback when available", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown>; options: unknown }> = [];
  const client: ExecutionMemoryClient = {
    async observe(body, options) {
      calls.push({ method: "observe", body, options });
      return { memory_write: { nodes: [{ id: "memory-observed" }] } };
    },
    async guide(body, options) {
      calls.push({ method: "guide", body, options });
      return {
        guide_trace_id: "guide-trace-feedback-sdk",
        agent_context: { use_now_memory_ids: ["memory-used"] },
      };
    },
    async forget(body, options) {
      calls.push({ method: "forget", body, options });
      return { operation: "activate", via: "forget" };
    },
    async feedback(body, options) {
      calls.push({ method: "feedback", body, options });
      return { operation: "activate", via: "feedback" };
    },
    async measure(body, options) {
      calls.push({ method: "measure", body, options });
      return { contract_version: "aionis_measure_result_v1" };
    },
    async operatorSnapshot(body, options) {
      calls.push({ method: "operatorSnapshot", body, options });
      return { contract_version: "aionis_operator_snapshot_result_v1" };
    },
  };
  const adapter = createExecutionMemoryAdapter({
    client,
    tenant_id: "tenant-feedback",
    scope: "scope-feedback",
    team_id: "team-feedback",
    default_agent_id: "reviewer-feedback",
    default_agent_role: "reviewer",
  });

  await adapter.guideNext({
    run_id: "run-feedback",
    task_signature: "feedback-sdk",
    query_text: "continue from exposed memory",
  });
  const result = await adapter.observeOutcome<Record<string, unknown>, Record<string, unknown>>({
    run_id: "run-feedback",
    task_signature: "feedback-sdk",
    title: "Feedback SDK outcome",
    summary: "Reviewer used exposed memory successfully.",
    outcome: "succeeded",
    used_memory_ids: ["memory-used"],
  });

  assert.equal(result.feedback?.via, "feedback");
  assert.equal(calls.some((call) => call.method === "forget"), false);
  const feedbackCall = calls.find((call) => call.method === "feedback");
  assert.ok(feedbackCall);
  assert.equal(feedbackCall.body.guide_trace_id, "guide-trace-feedback-sdk");
  assert.deepEqual(feedbackCall.body.used_memory_ids, ["memory-used"]);
  assert.equal(feedbackCall.body.run_id, "run-feedback");
  assert.equal(feedbackCall.body.outcome, "positive");
  assert.equal((feedbackCall.options as Record<string, unknown>).tenant_id, "tenant-feedback");
});

test("execution memory adapter enforces agent identity and shared team boundary", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown>; options: unknown }> = [];
  await assert.rejects(
    () => createExecutionMemoryAdapter({
      client: recordingClient(calls),
      team_id: "team-a",
    }).guideNext({
      run_id: "run-missing-agent",
      task_signature: "missing-agent",
      query_text: "continue",
    }),
    /requires agent_id/,
  );

  await assert.rejects(
    () => createExecutionMemoryAdapter({
      client: recordingClient(calls),
      default_agent_id: "agent-a",
    }).observeStep({
      run_id: "run-missing-team",
      task_signature: "missing-team",
      title: "Missing team",
      summary: "Shared multi-agent memory needs team identity.",
    }),
    /requires team_id/,
  );

  const privateAdapter = createExecutionMemoryAdapter({
    client: recordingClient(calls),
    default_agent_id: "agent-private",
    default_memory_lane: "private",
  });
  await privateAdapter.observeStep({
    run_id: "run-private",
    task_signature: "private-agent",
    title: "Private step",
    summary: "Private single-agent memory can omit team identity.",
  });
  const privateObserve = calls.find((call) => call.method === "observe" && call.body.memory_lane === "private");
  assert.ok(privateObserve);
  assert.equal(privateObserve.body.producer_agent_id, "agent-private");
  assert.equal(privateObserve.body.owner_team_id, undefined);
});
