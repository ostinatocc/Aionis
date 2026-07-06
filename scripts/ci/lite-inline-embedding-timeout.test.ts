import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EmbeddingProvider } from "../../src/embeddings/types.js";
import { commitLitePreparedWriteWithProjection } from "../../src/memory/lite-projected-write-commit.js";
import { prepareMemoryWrite } from "../../src/memory/write.js";
import { createLiteWriteStore } from "../../src/store/lite-write-store.js";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-inline-embedding-timeout-"));
  return path.join(dir, `${name}.sqlite`);
}

const NeverEmbeddingProvider: EmbeddingProvider = {
  name: "test:never-embedding",
  dim: 1536,
  embed(): Promise<number[][]> {
    return new Promise(() => undefined);
  },
};

test("lite projected write commit fails inline embeddings after the configured deadline", async () => {
  const liteWriteStore = createLiteWriteStore(tmpDbPath("deadline"));
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "Inline embedding timeout regression fixture.",
        auto_embed: true,
        nodes: [
          {
            client_id: "inline-embedding-timeout-node",
            type: "event",
            title: "Inline embedding timeout node",
            text_summary: "This node should be committed even when embedding never returns.",
          },
        ],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      NeverEmbeddingProvider,
    );

    const started = Date.now();
    const committed = await commitLitePreparedWriteWithProjection({
      prepared,
      liteWriteStore,
      embedder: NeverEmbeddingProvider,
      inlineEmbeddingTimeoutMs: 25,
      writeOptions: {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
    });
    const elapsedMs = Date.now() - started;

    assert.ok(elapsedMs < 500, `commit should not wait for a hanging embedder, elapsed=${elapsedMs}ms`);
    assert.equal(committed.out.nodes.length, 1);
    assert.equal(committed.liteInlineEmbedding?.attempted, 1);
    assert.equal(committed.liteInlineEmbedding?.updated, 0);
    assert.equal(committed.liteInlineEmbedding?.failed, 1);
    assert.match(committed.liteInlineEmbedding?.error ?? "", /inline embedding timed out after 25ms/);
  } finally {
    await liteWriteStore.close();
  }
});
