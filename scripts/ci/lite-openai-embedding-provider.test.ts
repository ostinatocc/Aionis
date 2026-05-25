import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { createEmbeddingProviderFromEnv } from "../../src/embeddings/index.ts";

const DIM = 1536;

function makeEmbedding(seed: number) {
  return Array.from({ length: DIM }, (_, index) => seed + index / 1000);
}

test("openai embedding provider honors OPENAI_EMBED_BASE_URL for OpenAI-compatible endpoints", async () => {
  const app = Fastify();
  let seenAuthorization = "";
  let seenModel = "";
  let seenInput: unknown = null;

  app.post("/v1/embeddings", async (request) => {
    seenAuthorization = String(request.headers.authorization ?? "");
    const body = request.body as { model?: string; input?: string[] };
    seenModel = String(body.model ?? "");
    seenInput = body.input;
    return {
      data: [
        { index: 0, embedding: makeEmbedding(1) },
        { index: 1, embedding: makeEmbedding(2) },
      ],
    };
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const provider = createEmbeddingProviderFromEnv({
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "test-kimi-key",
      OPENAI_EMBED_BASE_URL: `${address}/v1/`,
      OPENAI_EMBEDDING_MODEL: "kimi-embedding-like",
    });

    assert.ok(provider);
    const embeddings = await provider.embed(["alpha", "beta"]);
    assert.equal(seenAuthorization, "Bearer test-kimi-key");
    assert.equal(seenModel, "kimi-embedding-like");
    assert.deepEqual(seenInput, ["alpha", "beta"]);
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0]?.length, DIM);
    assert.equal(embeddings[1]?.length, DIM);
    assert.equal(embeddings[0]?.[0], 1);
    assert.equal(embeddings[1]?.[0], 2);
  } finally {
    await app.close();
  }
});
