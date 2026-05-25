import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { createEmbeddingProviderFromEnv } from "../../src/embeddings/index.ts";

const DIM = 1536;

function makeEmbedding(seed: number) {
  return Array.from({ length: DIM }, (_, index) => seed + index / 1000);
}

test("minimax embedding provider can call v1 endpoint without GroupId", async () => {
  const app = Fastify();
  let seenUrl = "";
  let seenAuthorization = "";
  let seenBody: unknown = null;

  app.post("/v1/embeddings", async (request) => {
    seenUrl = request.url;
    seenAuthorization = String(request.headers.authorization ?? "");
    seenBody = request.body;
    return {
      vectors: [makeEmbedding(1), makeEmbedding(2)],
      base_resp: {
        status_code: 0,
        status_msg: "success",
      },
    };
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const provider = createEmbeddingProviderFromEnv({
      EMBEDDING_PROVIDER: "minimax",
      MINIMAX_API_KEY: "test-minimax-key",
      MINIMAX_EMBED_ENDPOINT: `${address}/v1/embeddings`,
      MINIMAX_EMBED_MODEL: "embo-01",
      MINIMAX_EMBED_TYPE: "db",
    });

    assert.ok(provider);
    const embeddings = await provider.embed(["alpha", "beta"]);
    assert.equal(seenUrl, "/v1/embeddings");
    assert.equal(seenAuthorization, "Bearer test-minimax-key");
    assert.deepEqual(seenBody, {
      model: "embo-01",
      type: "db",
      texts: ["alpha", "beta"],
    });
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0]?.length, DIM);
    assert.equal(embeddings[1]?.length, DIM);
  } finally {
    await app.close();
  }
});
