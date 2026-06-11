import assert from "node:assert/strict";
import test from "node:test";
import {
  AionisClient,
  AionisClientError,
  agentContextFromGuide,
  agentPromptFromGuide,
  createAionisClient,
} from "../../src/sdk.ts";

test("AionisClient wraps the product facade APIs with scope defaults", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, path: String(input) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001/",
    apiKey: "test-key",
    tenant_id: "tenant-a",
    scope: "scope-a",
    headers: { "x-client": "sdk-test" },
    fetchImpl: fakeFetch,
  });

  await client.observe({ input_text: "Observed event." });
  await client.guide({ context: { task: "continue" } }, { scope: "scope-b" });
  await client.forget({ operation: "suppress", target: "memory", memory_id: "mem-1" });
  await client.feedback({
    operation: "suppress",
    reason: "Agent used exposed memory successfully.",
    run_id: "run-feedback",
    outcome: "positive",
    used_surface: "use_now",
    guide_trace_id: "guide-trace-feedback",
    used_memory_ids: ["mem-used"],
  });
  await client.rehydrate({
    operation: "activate",
    reason: "Expand archived payload before exact use.",
    anchor_uri: "aionis://anchor/payload-1",
    mode: "partial",
  });
  await client.measure({ baseline: { score: 0.3 }, aionis: { score: 0.7 } });
  await client.operatorSnapshot({ run_id: "run-operator", include_markdown: true });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/forget",
    "http://127.0.0.1:3001/v1/forget",
    "http://127.0.0.1:3001/v1/forget",
    "http://127.0.0.1:3001/v1/measure",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["x-client"], "sdk-test");

  const observeBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(observeBody.tenant_id, "tenant-a");
  assert.equal(observeBody.scope, "scope-a");
  assert.equal(observeBody.input_text, "Observed event.");

  const guideBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
  assert.equal(guideBody.tenant_id, "tenant-a");
  assert.equal(guideBody.scope, "scope-b");
  assert.equal(guideBody.mode, "full_power");

  const feedbackBody = JSON.parse(String(calls[3]?.init.body)) as Record<string, unknown>;
  assert.equal(feedbackBody.operation, "activate");
  assert.equal(feedbackBody.target, "memory");
  assert.equal(feedbackBody.guide_trace_id, "guide-trace-feedback");
  assert.deepEqual(feedbackBody.used_memory_ids, ["mem-used"]);

  const rehydrateBody = JSON.parse(String(calls[4]?.init.body)) as Record<string, unknown>;
  assert.equal(rehydrateBody.operation, "rehydrate");
  assert.equal(rehydrateBody.anchor_uri, "aionis://anchor/payload-1");
  assert.equal(rehydrateBody.mode, "partial");

  const snapshotBody = JSON.parse(String(calls[6]?.init.body)) as Record<string, unknown>;
  assert.equal(snapshotBody.tenant_id, "tenant-a");
  assert.equal(snapshotBody.scope, "scope-a");
  assert.equal(snapshotBody.run_id, "run-operator");
});

test("AionisClient defaults guide to full_power and allows explicit guide mode control", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const defaultClient = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    fetchImpl: fakeFetch,
  });

  await defaultClient.guide({ query_text: "continue" });
  await defaultClient.guide({ query_text: "legacy", mode: "standard" });
  await defaultClient.guide({ query_text: "context explicit", context_mode: "standard" });
  await defaultClient.guide({ query_text: "request override" }, { guide_mode: "standard" });
  await defaultClient.guide({ query_text: "raw route body" }, { guide_mode: null });

  const standardClient = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    default_guide_mode: "standard",
    fetchImpl: fakeFetch,
  });
  await standardClient.guide({ query_text: "client legacy default" });

  assert.equal(calls[0]?.mode, "full_power");
  assert.equal(calls[1]?.mode, "standard");
  assert.equal(calls[2]?.context_mode, "standard");
  assert.equal(calls[2]?.mode, undefined);
  assert.equal(calls[3]?.mode, "standard");
  assert.equal(calls[4]?.mode, undefined);
  assert.equal(calls[5]?.mode, "standard");
});

test("AionisClient remember writes ordinary memory through observe", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.remember({
    kind: "preference",
    text: "Prefer concise status updates with concrete evidence.",
    title: "Status preference",
    client_id: "pref-status",
    memory_lane: "private",
    owner_agent_id: "agent-1",
    confidence: 0.9,
    slots: { source: "user" },
  });

  assert.equal(calls[0]?.url, "http://127.0.0.1:3001/v1/observe");
  const body = calls[0]?.body ?? {};
  assert.equal(body.tenant_id, "tenant-a");
  assert.equal(body.scope, "scope-a");
  assert.equal(body.auto_embed, true);
  assert.equal(body.input_text, "Prefer concise status updates with concrete evidence.");
  assert.equal(body.memory_kind, "general_memory");
  assert.equal(body.memory_lane, "private");
  assert.equal(body.owner_agent_id, "agent-1");

  const memory = body.memory as Record<string, unknown>;
  assert.equal(memory.client_id, "pref-status");
  assert.equal(memory.type, "rule");
  assert.equal(memory.memory_kind, "general_memory");
  assert.equal(memory.title, "Status preference");
  assert.equal(memory.text_summary, "Prefer concise status updates with concrete evidence.");
  assert.equal(memory.confidence, 0.9);
  const slots = memory.slots as Record<string, unknown>;
  assert.equal(slots.source, "user");
  assert.equal(slots.memory_kind, "general_memory");
  assert.equal(slots.lifecycle_state, "active");
  assert.equal(slots.state, "active");
  assert.equal(slots.compression_layer, "L2");
});

test("agent prompt helpers expose only agent_context from guide responses", () => {
  const guide = {
    guide_trace_id: "guide-1",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      use_now_memory_ids: ["mem-1"],
    },
    memory_packet: {
      raw: "operator-only",
    },
  };

  assert.equal(agentPromptFromGuide(guide), "AIONIS_CTX v2\ncurrent: n=Use scoped memory.");
  assert.deepEqual(agentContextFromGuide<Record<string, unknown>>(guide).use_now_memory_ids, ["mem-1"]);
  assert.throws(() => agentPromptFromGuide({ memory_packet: {} }), /missing agent_context/);
});

test("AionisClient health and structured error handling", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (String(input).endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
  };
  const client = new AionisClient({
    baseUrl: "http://localhost:3001",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(await client.health(), { ok: true });
  await assert.rejects(
    () => client.observe({}),
    (error) => {
      assert.ok(error instanceof AionisClientError);
      assert.equal(error.status, 400);
      assert.equal(error.path, "/v1/observe");
      assert.deepEqual(error.response, { error: "bad_request" });
      return true;
    },
  );
  assert.equal(calls[0]?.init.method, "GET");
});
