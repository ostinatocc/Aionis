import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { createEmbeddingProviderFromEnv } from "../../src/embeddings/index.ts";

const DIM = 1536;

function makeEmbedding(seed: number) {
  return Array.from({ length: DIM }, (_, index) => seed + index / 1000);
}

test("dashscope embedding provider uses OpenAI-compatible endpoint with explicit 1536 dimensions", async () => {
  const app = Fastify();
  let seenAuthorization = "";
  let seenBody: unknown = null;

  app.post("/compatible-mode/v1/embeddings", async (request) => {
    seenAuthorization = String(request.headers.authorization ?? "");
    seenBody = request.body;
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
      EMBEDDING_PROVIDER: "dashscope",
      DASHSCOPE_API_KEY: "test-dashscope-key",
      DASHSCOPE_EMBED_BASE_URL: `${address}/compatible-mode/v1`,
      DASHSCOPE_EMBEDDING_MODEL: "text-embedding-v4",
    });

    assert.ok(provider);
    assert.equal(provider.name, "dashscope:text-embedding-v4");
    const embeddings = await provider.embed(["alpha", "beta"]);

    assert.equal(seenAuthorization, "Bearer test-dashscope-key");
    assert.deepEqual(seenBody, {
      model: "text-embedding-v4",
      input: ["alpha", "beta"],
      dimensions: DIM,
      encoding_format: "float",
    });
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0]?.length, DIM);
    assert.equal(embeddings[1]?.length, DIM);
  } finally {
    await app.close();
  }
});
