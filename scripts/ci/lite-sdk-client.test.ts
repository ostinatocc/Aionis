import assert from "node:assert/strict";
import test from "node:test";
import {
  AionisClient,
  AionisClientError,
  createAionisClient,
} from "../../src/sdk.ts";

test("AionisClient wraps the four product facade APIs with scope defaults", async () => {
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
  await client.measure({ baseline: { score: 0.3 }, aionis: { score: 0.7 } });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/forget",
    "http://127.0.0.1:3001/v1/measure",
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
