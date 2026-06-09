import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
  HOST_INTEGRATION_TEMPLATES,
  createCodingAgentHostTemplate,
  createExecutionMemoryAdapter,
  createGenericAgentHostTemplate,
  createMultiAgentHostTemplate,
  type ExecutionMemoryClient,
} from "../../src/adapters/index.ts";

type RecordedCall = {
  method: "observe" | "guide" | "forget" | "measure";
  body: Record<string, unknown>;
  options: unknown;
};

function recordingClient(calls: RecordedCall[]): ExecutionMemoryClient {
  let guideCount = 0;
  return {
    async observe(body, options) {
      calls.push({ method: "observe", body, options });
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
        guide_trace_id: `guide-template-${guideCount}`,
        agent_context: {
          contract_version: "aionis_agent_context_v1",
          prompt_text: `Use memory-template-${guideCount}.`,
          use_now_memory_ids: [`memory-template-${guideCount}`],
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
}

test("host integration templates expose a stable host-facing contract", () => {
  assert.equal(HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION, "aionis_host_integration_template_v1");
  assert.equal(HOST_INTEGRATION_TEMPLATES.contract_version, "aionis_host_integration_template_v1");
  assert.deepEqual(
    HOST_INTEGRATION_TEMPLATES.templates.generic_agent_loop.required_hooks,
    ["startRun", "beforeRun", "afterRun", "measure"],
  );
  assert.ok(
    HOST_INTEGRATION_TEMPLATES.templates.generic_agent_loop.persisted_state.includes("last_use_now_memory_ids"),
  );
  assert.ok(
    HOST_INTEGRATION_TEMPLATES.templates.multi_agent_loop.persisted_state.includes("team_id"),
  );
  assert.ok(
    HOST_INTEGRATION_TEMPLATES.templates.coding_agent_loop.persisted_state.includes("target_files"),
  );
});

test("generic host template persists guide state and wires outcome feedback", async () => {
  const calls: RecordedCall[] = [];
  const adapter = createExecutionMemoryAdapter({
    client: recordingClient(calls),
    tenant_id: "tenant-template",
    scope: "scope-template",
    team_id: "team-template",
    default_agent_id: "agent-template",
  });
  const host = createGenericAgentHostTemplate(adapter);

  const started = await host.startRun({
    run_id: "run-template",
    task_signature: "generic-template",
    title: "Generic template start",
    summary: "Host starts a generic Agent run.",
  });
  assert.equal(started.state.template, "generic_agent_loop");
  assert.equal(started.state.run_id, "run-template");
  assert.deepEqual(started.state.last_use_now_memory_ids, []);

  const guided = await host.beforeRun({
    state: started.state,
    run_id: "run-template",
    task_signature: "generic-template",
    query_text: "Continue from product memory.",
  });
  assert.equal(guided.state.guide_run_id, "run-template");
  assert.equal(guided.state.last_guide_trace_id, "guide-template-1");
  assert.deepEqual(guided.state.last_use_now_memory_ids, ["memory-template-1"]);
  assert.deepEqual(guided.agent_context, {
    contract_version: "aionis_agent_context_v1",
    prompt_text: "Use memory-template-1.",
    use_now_memory_ids: ["memory-template-1"],
  });

  const finished = await host.afterRun({
    state: guided.state,
    run_id: "run-template-outcome",
    task_signature: "generic-template",
    title: "Generic template outcome",
    summary: "Agent used guided memory successfully.",
    outcome: "succeeded",
  });
  assert.equal(finished.state.last_outcome, "succeeded");

  await host.measure({
    state: finished.state,
    run_id: "run-template",
    task_signature: "generic-template",
  });

  const guideCall = calls.find((call) => call.method === "guide");
  assert.ok(guideCall);
  assert.equal(guideCall.body.mode, "full_power");
  assert.equal(guideCall.body.consumer_agent_id, "agent-template");
  assert.equal(guideCall.body.consumer_team_id, "team-template");

  const forgetCall = calls.find((call) => call.method === "forget");
  assert.ok(forgetCall);
  assert.equal(forgetCall.body.guide_trace_id, "guide-template-1");
  assert.deepEqual(forgetCall.body.used_memory_ids, ["memory-template-1"]);
  assert.equal(forgetCall.body.outcome, "positive");
  assert.equal(forgetCall.body.run_id, "run-template-outcome");

  const measureCall = calls.find((call) => call.method === "measure");
  assert.ok(measureCall);
  assert.equal((measureCall.body.task as Record<string, unknown>).task_signature, "generic-template");
});

test("multi-agent host template fixes planner worker verifier reviewer roles", async () => {
  const calls: RecordedCall[] = [];
  const adapter = createExecutionMemoryAdapter({
    client: recordingClient(calls),
    team_id: "team-multi-template",
    default_agent_id: "fallback-agent",
  });
  const host = createMultiAgentHostTemplate(adapter);

  const planned = await host.plannerStart({
    run_id: "run-multi-template",
    task_signature: "multi-template",
    agent_id: "planner-template",
    title: "Planner start",
    summary: "Planner creates the shared execution plan.",
  });
  assert.equal(planned.state.template, "multi_agent_loop");
  assert.equal(planned.state.role, "planner");

  const worker = await host.workerStep({
    state: planned.state,
    run_id: "run-multi-template",
    task_signature: "multi-template",
    agent_id: "worker-template",
    title: "Worker step",
    summary: "Worker records a branch.",
    outcome: "unknown",
  });
  assert.equal(worker.state.role, "worker");

  const verifier = await host.verifierStep({
    state: worker.state,
    run_id: "run-multi-template",
    task_signature: "multi-template",
    agent_id: "verifier-template",
    title: "Verifier step",
    summary: "Verifier marks the branch.",
    outcome: "passed",
  });
  assert.equal(verifier.state.role, "verifier");

  const reviewerGuide = await host.reviewerGuide({
    state: verifier.state,
    run_id: "run-multi-template",
    task_signature: "multi-template",
    agent_id: "reviewer-template",
    query_text: "Review active path.",
  });
  assert.equal(reviewerGuide.state.role, "reviewer");

  await host.reviewerOutcome({
    state: reviewerGuide.state,
    run_id: "run-multi-template-reviewer",
    task_signature: "multi-template",
    agent_id: "reviewer-template",
    title: "Reviewer outcome",
    summary: "Reviewer used the active path.",
    outcome: "succeeded",
  });

  const reviewerGuideCall = calls.find((call) => call.method === "guide");
  assert.ok(reviewerGuideCall);
  assert.equal(reviewerGuideCall.body.agent_role, "reviewer");
  assert.equal(reviewerGuideCall.body.consumer_agent_id, "reviewer-template");

  const forgetCall = calls.find((call) => call.method === "forget");
  assert.ok(forgetCall);
  assert.equal(forgetCall.body.actor, "reviewer-template");
  assert.deepEqual(forgetCall.body.used_memory_ids, ["memory-template-1"]);
});

test("coding host template carries repository context and patch feedback", async () => {
  const calls: RecordedCall[] = [];
  const adapter = createExecutionMemoryAdapter({
    client: recordingClient(calls),
    team_id: "team-coding-template",
    default_agent_id: "coding-agent-template",
  });
  const host = createCodingAgentHostTemplate(adapter);

  const beforePatch = await host.beforePatch({
    run_id: "run-coding-template",
    task_signature: "coding-template",
    query_text: "Patch checkout without repeating failed branches.",
    repo_root: "/work/repo",
    target_files: ["src/checkout.ts"],
    patch_goal: "Keep checkout migration scoped.",
  });
  assert.equal(beforePatch.state.template, "coding_agent_loop");
  assert.equal(beforePatch.state.repo_root, "/work/repo");
  assert.deepEqual(beforePatch.state.target_files, ["src/checkout.ts"]);

  await host.afterPatch({
    state: beforePatch.state,
    run_id: "run-coding-template",
    task_signature: "coding-template",
    title: "Coding patch result",
    summary: "Patch changed only the checkout target and tests passed.",
    outcome: "passed",
    changed_files: ["src/checkout.ts"],
  });

  const guideCall = calls.find((call) => call.method === "guide");
  assert.ok(guideCall);
  assert.equal(guideCall.body.agent_role, "worker");
  const guideContext = guideCall.body.context as Record<string, unknown>;
  assert.equal(guideContext.repo_root, "/work/repo");
  assert.deepEqual(guideContext.target_files, ["src/checkout.ts"]);
  assert.equal(guideContext.patch_goal, "Keep checkout migration scoped.");

  const observeOutcomeCall = calls.filter((call) => call.method === "observe").at(-1);
  assert.ok(observeOutcomeCall);
  const execution = observeOutcomeCall.body.execution as Record<string, unknown>;
  assert.deepEqual(execution.target_files, ["src/checkout.ts"]);
  assert.deepEqual((execution.slots as Record<string, unknown>).changed_files, ["src/checkout.ts"]);
  assert.equal((execution.slots as Record<string, unknown>).repo_root, "/work/repo");

  const forgetCall = calls.find((call) => call.method === "forget");
  assert.ok(forgetCall);
  assert.equal(forgetCall.body.guide_trace_id, "guide-template-1");
  assert.deepEqual(forgetCall.body.used_memory_ids, ["memory-template-1"]);
});
