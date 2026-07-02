import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AnnIndexDimensionError, type AnnVectorRecord } from "../../src/store/ann/ann-index.ts";
import { createLocalAnnIndex } from "../../src/store/ann/local-ann-index.ts";
import { createNoopAnnIndex } from "../../src/store/ann/noop-ann-index.ts";
import { createZvecAnnIndex } from "../../src/store/ann/zvec-ann-index.ts";
import { loadEnv } from "../../src/config.ts";

function record(id: string, overrides: Partial<AnnVectorRecord> = {}): AnnVectorRecord {
  return {
    node_id: id,
    scope: "project-a",
    tenant_id: "tenant-a",
    embedding_model: "test-embed",
    embedding_dim: 3,
    vector_hash: `hash-${id}`,
    tier: "hot",
    memory_lane: "shared",
    owner_agent_id: null,
    owner_team_id: null,
    lifecycle_state: "active",
    authority_state: "admitted",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

async function* vectorRecords(items: Array<{ record: AnnVectorRecord; vector: number[] }>) {
  for (const item of items) yield item;
}

async function withIsolatedEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    await fn();
  } finally {
    process.env = previous;
  }
}

test("noop ANN index validates inputs and returns no candidates", async () => {
  const index = createNoopAnnIndex();
  await index.upsert(record("mem-a"), [1, 0, 0]);
  const results = await index.search({
    scope: "project-a",
    embeddingModel: "test-embed",
    vector: [1, 0, 0],
    limit: 10,
  });
  assert.deepEqual(results, []);
});

test("local ANN index returns nearest vectors within scope and model", async () => {
  const index = createLocalAnnIndex();
  await index.upsert(record("near"), [1, 0, 0]);
  await index.upsert(record("far"), [0, 1, 0]);
  await index.upsert(record("other-scope", { scope: "project-b" }), [1, 0, 0]);
  await index.upsert(record("other-model", { embedding_model: "other-embed" }), [1, 0, 0]);

  const results = await index.search({
    scope: "project-a",
    embeddingModel: "test-embed",
    vector: [0.99, 0.01, 0],
    limit: 2,
  });

  assert.deepEqual(results.map((item) => item.node_id), ["near", "far"]);
  assert.ok(results[0].score > results[1].score);
});

test("local ANN index supports metadata filters and delete", async () => {
  const index = createLocalAnnIndex();
  await index.upsert(record("hot-shared", { tier: "hot", memory_lane: "shared" }), [1, 0, 0]);
  await index.upsert(record("cold-private", { tier: "cold", memory_lane: "private" }), [0.9, 0.1, 0]);

  const filtered = await index.search({
    scope: "project-a",
    embeddingModel: "test-embed",
    vector: [1, 0, 0],
    limit: 10,
    filters: { tier: ["hot", "warm"], memory_lane: "shared" },
  });
  assert.deepEqual(filtered.map((item) => item.node_id), ["hot-shared"]);

  await index.delete("hot-shared");
  const afterDelete = await index.search({
    scope: "project-a",
    embeddingModel: "test-embed",
    vector: [1, 0, 0],
    limit: 10,
  });
  assert.deepEqual(afterDelete.map((item) => item.node_id), ["cold-private"]);
});

test("local ANN index rejects wrong embedding dimensions", async () => {
  const index = createLocalAnnIndex();
  await assert.rejects(
    () => index.upsert(record("bad"), [1, 0]),
    AnnIndexDimensionError,
  );
  await index.upsert(record("good"), [1, 0, 0]);
  await assert.rejects(
    () => index.search({
      scope: "project-a",
      embeddingModel: "test-embed",
      vector: [1, 0],
      limit: 10,
    }),
    AnnIndexDimensionError,
  );
});

test("local ANN rebuild is atomic on validation failure", async () => {
  const index = createLocalAnnIndex();
  await index.upsert(record("existing"), [1, 0, 0]);

  await assert.rejects(
    () => index.rebuild(vectorRecords([
      { record: record("replacement"), vector: [0, 1, 0] },
      { record: record("bad"), vector: [0, 1] },
    ])),
    AnnIndexDimensionError,
  );

  const results = await index.search({
    scope: "project-a",
    embeddingModel: "test-embed",
    vector: [1, 0, 0],
    limit: 10,
  });
  assert.deepEqual(results.map((item) => item.node_id), ["existing"]);
});

test("zvec ANN index is optional and returns scoped vector candidates when available", async (t) => {
  try {
    await import("@zvec/zvec");
  } catch {
    t.skip("@zvec/zvec optional dependency is not available on this platform");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "aionis-zvec-ann-"));
  const index = createZvecAnnIndex({ path: join(root, "index") });
  try {
    await index.upsert(record("near"), [1, 0, 0]);
    await index.upsert(record("far"), [0, 1, 0]);
    await index.upsert(record("other-scope", { scope: "project-b" }), [1, 0, 0]);
    await index.upsert(record("other-model", { embedding_model: "other-embed" }), [1, 0, 0]);
    await index.upsert(record("cold-private", { tier: "cold", memory_lane: "private" }), [1, 0, 0]);

    const results = await index.search({
      scope: "project-a",
      embeddingModel: "test-embed",
      vector: [0.99, 0.01, 0],
      limit: 10,
      filters: { tier: ["hot", "warm"], memory_lane: "shared" },
    });

    assert.deepEqual(results.map((item) => item.node_id), ["near", "far"]);
    assert.ok(results[0].score > results[1].score);

    await index.delete("near");
    const afterDelete = await index.search({
      scope: "project-a",
      embeddingModel: "test-embed",
      vector: [1, 0, 0],
      limit: 10,
      filters: { tier: ["hot", "warm"], memory_lane: "shared" },
    });
    assert.deepEqual(afterDelete.map((item) => item.node_id), ["far"]);
  } finally {
    await index.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("zvec ANN index serializes concurrent collection access", async (t) => {
  try {
    await import("@zvec/zvec");
  } catch {
    t.skip("@zvec/zvec optional dependency is not available on this platform");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "aionis-zvec-ann-concurrent-"));
  const path = join(root, "index");
  const seed = createZvecAnnIndex({ path });
  try {
    await seed.upsert(record("near"), [1, 0, 0]);
    await seed.upsert(record("far"), [0, 1, 0]);
    await seed.close?.();

    const index = createZvecAnnIndex({ path });
    try {
      const searches = Array.from({ length: 8 }, () => index.search({
        scope: "project-a",
        embeddingModel: "test-embed",
        vector: [0.99, 0.01, 0],
        limit: 2,
      }));
      const results = await Promise.all(searches);
      for (const result of results) {
        assert.deepEqual(result.map((item) => item.node_id), ["near", "far"]);
      }
    } finally {
      await index.close?.();
    }
  } finally {
    await seed.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("zvec ANN rebuild keeps previous index when validation fails", async (t) => {
  try {
    await import("@zvec/zvec");
  } catch {
    t.skip("@zvec/zvec optional dependency is not available on this platform");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "aionis-zvec-ann-rebuild-"));
  const index = createZvecAnnIndex({ path: join(root, "index") });
  try {
    await index.upsert(record("existing"), [1, 0, 0]);
    await assert.rejects(
      () => index.rebuild(vectorRecords([
        { record: record("replacement"), vector: [0, 1, 0] },
        { record: record("bad"), vector: [0, 1] },
      ])),
      AnnIndexDimensionError,
    );
    const results = await index.search({
      scope: "project-a",
      embeddingModel: "test-embed",
      vector: [1, 0, 0],
      limit: 10,
    });
    assert.deepEqual(results.map((item) => item.node_id), ["existing"]);
  } finally {
    await index.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ANN sidecar config defaults off and accepts local and zvec providers", async () => {
  await withIsolatedEnv({}, () => {
    const env = loadEnv();
    assert.equal(env.RECALL_ANN_PROVIDER, "off");
    assert.equal(env.RECALL_ZVEC_PATH, "");
    assert.equal(env.RECALL_ANN_REBUILD_ON_START, false);
    assert.equal(env.RECALL_ANN_MAX_CANDIDATES, 200);
    assert.equal(env.RECALL_SUBSTRATE_SIDECAR_ENABLED, false);
    assert.equal(env.RECALL_SUBSTRATE_PATH, "");
    assert.equal(env.RECALL_SUBSTRATE_MAX_CANDIDATES, 200);
    assert.equal(env.RECALL_SUBSTRATE_FAIL_OPEN, true);
  });
  await withIsolatedEnv(
    {
      RECALL_ANN_PROVIDER: "local",
      RECALL_ANN_REBUILD_ON_START: "true",
      RECALL_ANN_MAX_CANDIDATES: "64",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.RECALL_ANN_PROVIDER, "local");
      assert.equal(env.RECALL_ANN_REBUILD_ON_START, true);
      assert.equal(env.RECALL_ANN_MAX_CANDIDATES, 64);
    },
  );
  await withIsolatedEnv(
    {
      RECALL_ANN_PROVIDER: "zvec",
      RECALL_ZVEC_PATH: "/tmp/aionis-zvec-ann",
      RECALL_SUBSTRATE_SIDECAR_ENABLED: "true",
      RECALL_SUBSTRATE_PATH: "/tmp/aionis-substrate.sqlite",
      RECALL_SUBSTRATE_MAX_CANDIDATES: "96",
      RECALL_SUBSTRATE_FAIL_OPEN: "false",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.RECALL_ANN_PROVIDER, "zvec");
      assert.equal(env.RECALL_ZVEC_PATH, "/tmp/aionis-zvec-ann");
      assert.equal(env.RECALL_SUBSTRATE_SIDECAR_ENABLED, true);
      assert.equal(env.RECALL_SUBSTRATE_PATH, "/tmp/aionis-substrate.sqlite");
      assert.equal(env.RECALL_SUBSTRATE_MAX_CANDIDATES, 96);
      assert.equal(env.RECALL_SUBSTRATE_FAIL_OPEN, false);
    },
  );
});
