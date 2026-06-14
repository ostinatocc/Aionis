import assert from "node:assert/strict";
import test from "node:test";
import { createEmbedJsonPoster, EmbedHttpError } from "../../src/embeddings/http.ts";

function poster() {
  return createEmbedJsonPoster({
    timeoutMs: 500,
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    maxConcurrency: 1,
  });
}

test("embedding http poster fails fast for non-retryable 4xx", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("bad key", { status: 401, statusText: "Unauthorized" });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => poster().postJson("https://example.invalid/embeddings", {}, { input: "hello" }),
      (err: unknown) => {
        assert.ok(err instanceof EmbedHttpError);
        assert.equal(err.status, 401);
        assert.equal(err.bodyPreview, "bad key");
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedding http poster retries 429 before succeeding", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) return new Response("slow down", { status: 429, statusText: "Too Many Requests" });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const out = await poster().postJson<{ ok: boolean }>("https://example.invalid/embeddings", {}, { input: "hello" });
    assert.deepEqual(out, { ok: true });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
