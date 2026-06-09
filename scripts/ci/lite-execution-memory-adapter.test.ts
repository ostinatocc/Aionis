import assert from "node:assert/strict";
import test from "node:test";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import {
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
  await adapter.measureRun({
    run_id: "run-adapter",
    task_id: "task-adapter",
    task_signature: "adapter-contract",
    task_family: "adapter_family",
    evidence_ids: ["memory:memory-passed"],
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
});
