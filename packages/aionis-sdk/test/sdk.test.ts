import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPromptFromGuide,
  createAionisClient,
  feedbackFromGuide,
  memoryIdsFromGuide,
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
    },
    memory_packet: {
      raw: "operator-only",
    },
  };

  assert.equal(agentPromptFromGuide(guide), "AIONIS_CTX v2\ncurrent: n=Use scoped memory.");
  assert.deepEqual(memoryIdsFromGuide(guide), ["mem-1", "mem-2"]);
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
      used_memory_ids: ["mem-3"],
    }),
    /not exposed by guide/,
  );
});
