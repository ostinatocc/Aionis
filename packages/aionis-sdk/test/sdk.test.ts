import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPromptFromGuide,
  commandPostureFromGuide,
  commandPostureMemoryIdsFromGuide,
  createAionisClient,
  feedbackFromGuide,
  inspectFirstMemoryIdsFromGuide,
  memoryIdsFromGuide,
  mustNotMemoryIdsFromGuide,
  shouldContinueMemoryIdsFromGuide,
} from "../src/index.ts";

test("@aionis/sdk wraps product facade routes", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001/",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.guide({ query_text: "continue" });
  await client.feedback({
    reason: "used memory",
    run_id: "run-1",
    outcome: "positive",
    used_surface: "use_now",
    used_memory_ids: ["mem-1"],
  });
  await client.snapshot({ run_id: "run-1" });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);
  assert.equal(calls[0]?.body.tenant_id, "tenant-a");
  assert.equal(calls[0]?.body.scope, "scope-a");
  assert.equal(calls[0]?.body.mode, "full_power");
});

test("@aionis/sdk guide helpers keep Agent prompt and feedback attribution bounded", () => {
  const guide = {
    guide_trace_id: "guide-1",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      memory_ids: ["mem-1"],
      use_now_memory_ids: ["mem-1"],
      inspect_before_use_memory_ids: ["mem-2"],
      command_posture: [
        {
          posture: "should_continue",
          surface: "current",
          memory_id: "mem-1",
          instruction: "Continue the current branch.",
          reason: "The branch is active.",
          target_files: ["src/a.ts"],
        },
        {
          posture: "must_not",
          surface: "do_not_use",
          memory_id: "mem-3",
          instruction: "Do not reuse the failed branch.",
          reason: "The branch failed verification.",
          target_files: ["src/old.ts"],
        },
        {
          posture: "inspect_first",
          surface: "inspect_before_use",
          memory_id: "mem-2",
          instruction: "Inspect before relying on this candidate.",
          reason: "The memory is candidate-only.",
          target_files: [],
        },
      ],
    },
    memory_packet: {
      raw: "operator-only",
    },
  };

  assert.equal(agentPromptFromGuide(guide), "AIONIS_CTX v2\ncurrent: n=Use scoped memory.");
  assert.deepEqual(memoryIdsFromGuide(guide), ["mem-1", "mem-2", "mem-3"]);
  assert.deepEqual(commandPostureMemoryIdsFromGuide(guide), ["mem-1", "mem-3", "mem-2"]);
  assert.deepEqual(shouldContinueMemoryIdsFromGuide(guide), ["mem-1"]);
  assert.deepEqual(mustNotMemoryIdsFromGuide(guide), ["mem-3"]);
  assert.deepEqual(inspectFirstMemoryIdsFromGuide(guide), ["mem-2"]);
  assert.deepEqual(commandPostureFromGuide(guide, "must_not")[0]?.instruction, "Do not reuse the failed branch.");
  assert.deepEqual(feedbackFromGuide({
    guide,
    reason: "Agent used mem-1.",
    run_id: "run-1",
    outcome: "positive",
    used_memory_ids: ["mem-1"],
  }).guide_trace_id, "guide-1");
  assert.throws(
    () => feedbackFromGuide({
      guide,
      reason: "Agent used an unexposed memory.",
      run_id: "run-1",
      outcome: "positive",
      used_memory_ids: ["mem-4"],
    }),
    /not exposed by guide/,
  );
});

test("@aionis/sdk compact agent context keeps default full_power guide mode", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    fetchImpl: fakeFetch,
  });

  await client.execution.guideForRole({
    agent_id: "agent-compact",
    run_id: "run-compact",
    task_signature: "compact-agent",
    query_text: "Continue from current execution state.",
    context_mode: "compact_agent",
  });

  assert.equal(calls[0]?.mode, "full_power");
  assert.equal(calls[0]?.context_mode, "compact_agent");
});

test("@aionis/sdk execution helpers wrap observe, guide, feedback, measure, and snapshot", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({
      ok: true,
      guide_trace_id: "guide-exec-1",
      agent_context: {
        prompt_text: "AIONIS_CTX v2\ncurrent use_now=passed branch",
        memory_ids: ["mem-exec-1"],
        use_now_memory_ids: ["mem-exec-1"],
      },
      effect_report: {
        history_impact: { impact_direction: "positive" },
      },
      memory_decision_trace: {
        memory_use_receipt: { contract_version: "aionis_memory_use_receipt_v1" },
      },
    }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.execution.observeStep({
    agent_id: "worker-1",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Implement adapter",
    summary: "Worker implemented the checkout adapter.",
    outcome: "succeeded",
    target_files: ["src/checkout.ts"],
    acceptance_checks: ["unit tests pass"],
  });

  await client.execution.handoff({
    agent_id: "planner-1",
    team_id: "checkout-team",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Reviewer handoff",
    summary: "Continue the verified branch and avoid broad legacy search.",
    continuation_hint: "review boundary and continue passed branch",
  });

  const guide = await client.execution.guideForRole<Record<string, unknown>>({
    agent_id: "reviewer-1",
    team_id: "checkout-team",
    role: "reviewer",
    run_id: "run-1",
    task_signature: "checkout-migration",
    query_text: "Continue the checkout migration from current state.",
  });

  const feedback = await client.execution.feedbackFromOutcome({
    agent_id: "reviewer-1",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Reviewer continued branch",
    summary: "Reviewer used the current execution memory.",
    outcome: "succeeded",
    guide,
    used_memory_ids: ["mem-exec-1"],
  });

  const measure = await client.execution.measureRun({
    run_id: "run-1",
    task_signature: "checkout-migration",
    after_guide: guide,
    feedback_result: feedback,
    sufficient_evidence: true,
  });

  await client.execution.snapshotRun({
    run_id: "run-1",
    task_signature: "checkout-migration",
    guide,
    measure_result: measure,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/measure",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);

  assert.equal(calls[0]?.body.memory_lane, "private");
  assert.equal((calls[0]?.body.execution as Record<string, unknown>).outcome, "succeeded");
  assert.deepEqual((calls[0]?.body.execution as Record<string, unknown>).target_files, ["src/checkout.ts"]);

  assert.equal(calls[1]?.body.memory_lane, "shared");
  assert.equal(calls[1]?.body.owner_team_id, "checkout-team");
  assert.equal((calls[1]?.body.handoff as Record<string, unknown>).handoff_kind, "task_handoff");
  assert.equal((calls[1]?.body.handoff as Record<string, unknown>).anchor, "checkout-migration:run-1:planner-1");

  assert.equal(calls[2]?.body.mode, "full_power");
  assert.equal(calls[2]?.body.agent_role, "reviewer");
  assert.equal(calls[2]?.body.consumer_agent_id, "reviewer-1");
  assert.equal(calls[2]?.body.consumer_team_id, "checkout-team");

  assert.equal(calls[3]?.body.guide_trace_id, "guide-exec-1");
  assert.deepEqual(calls[3]?.body.used_memory_ids, ["mem-exec-1"]);
  assert.equal(calls[3]?.body.outcome, "positive");
  assert.equal(calls[3]?.body.verifier_status, "passed");
  assert.equal(calls[3]?.body.tool_status, "succeeded");

  assert.equal((calls[4]?.body.task as Record<string, unknown>).task_signature, "checkout-migration");
  assert.equal((calls[5]?.body.agent_context as Record<string, unknown>).prompt_text, "AIONIS_CTX v2\ncurrent use_now=passed branch");
});
