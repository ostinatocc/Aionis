import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  adjudicateMemoryLifecycle,
  type AdjudicableMemoryEntry,
} from "../../src/memory/memory-lifecycle-adjudicator.ts";
import { createHttpMemoryLifecycleRelationCandidateProducer } from
  "../../src/memory/memory-lifecycle-relation-model-producer.ts";
import { prepareLiteProjectedWrite } from "../../src/memory/lite-projected-write-commit.ts";
import {
  applyMemoryWrite,
  MEMORY_LIFECYCLE_WRITE_HISTORY_LIMIT,
  prepareMemoryWrite,
  type PreparedWrite,
} from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";

const SCOPE = "default";
const writeOptions = {
  maxTextLen: 20_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

type LifecycleEdgeRow = {
  type: string;
  src_id: string;
  dst_id: string;
  metadata_json: string;
};

type CapturedModelRequest = {
  path: string;
  authorization: string | null;
  userPayload: Record<string, unknown>;
};

type CandidatePair = {
  source: { memory_id: string };
  target: { memory_id: string };
  hint?: {
    kind: string;
    authority: string;
    relation: string;
  };
};

function stableId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

async function openFixture(name: string): Promise<{
  directory: string;
  dbPath: string;
  database: LiteRuntimeDatabase;
  store: LiteWriteStore;
  close: () => Promise<void>;
}> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-lifecycle-${name}-`));
  const dbPath = path.join(directory, "runtime.sqlite");
  const database = createLiteRuntimeDatabase(dbPath);
  const store = createLiteWriteStoreFromDatabase(database);
  return {
    directory,
    dbPath,
    database,
    store,
    async close() {
      await store.close();
      await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function preparedWrite(args: {
  input: string;
  nodes: Array<{
    id: string;
    title: string;
    summary: string;
    confidence?: number;
  }>;
}): Promise<PreparedWrite> {
  return await prepareMemoryWrite({
    tenant_id: "default",
    scope: SCOPE,
    actor: "local-user",
    input_text: args.input,
    auto_embed: false,
    nodes: args.nodes.map((node) => ({
      id: node.id,
      type: "concept" as const,
      title: node.title,
      text_summary: node.summary,
      confidence: node.confidence ?? 0.92,
      salience: 0.88,
      slots: {
        memory_kind: "general_memory",
        compression_layer: "L2",
      },
    })),
    edges: [],
  }, "default", "default", writeOptions, null);
}

async function persistPrepared(store: LiteWriteStore, prepared: PreparedWrite): Promise<void> {
  await store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: store,
  }));
}

async function seedNodes(
  store: LiteWriteStore,
  nodes: Array<{ id: string; title: string; summary: string }>,
): Promise<void> {
  await persistPrepared(store, await preparedWrite({ input: "seed historical memories", nodes }));
}

function lifecycleEdges(database: LiteRuntimeDatabase): LifecycleEdgeRow[] {
  return database.db.prepare(`
    SELECT type, src_id, dst_id, metadata_json
    FROM lite_memory_edges
    WHERE scope = ? AND type IN ('supersedes', 'contradicts', 'invalidates')
    ORDER BY type, src_id, dst_id
  `).all(SCOPE) as LifecycleEdgeRow[];
}

function adjudicable(args: {
  id: string;
  title: string;
  summary: string;
  observedAt: string;
  sourceIndex: number;
}): AdjudicableMemoryEntry {
  return {
    memory_id: args.id,
    title: args.title,
    summary: args.summary,
    domain: "general",
    authority: "advisory",
    confidence: 0.92,
    salience: 0.88,
    lifecycle_state: "active",
    observed_at: args.observedAt,
    source_index: args.sourceIndex,
  };
}

async function startModelPeer(
  responseFor: (captured: CapturedModelRequest) => Record<string, unknown>,
): Promise<{
  baseUrl: string;
  requests: CapturedModelRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedModelRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const userMessage = body.messages?.find((message) => message.role === "user")?.content;
        const captured: CapturedModelRequest = {
          path: request.url ?? "",
          authorization: typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : null,
          userPayload: JSON.parse(userMessage ?? "{}") as Record<string, unknown>,
        };
        requests.push(captured);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify(responseFor(captured)),
            },
          }],
        }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function httpProducer(baseUrl: string, maxPairs = 60) {
  return createHttpMemoryLifecycleRelationCandidateProducer({
    config: {
      baseUrl,
      apiKey: "local-test-key",
      model: "local-lifecycle-peer",
      timeoutMs: 5_000,
      maxTokens: 1_200,
      temperature: 0,
      transport: "openai_chat_completions_v1",
    },
    maxPairs,
  });
}

test("write keeps broad updated/corrected/failed overlap ephemeral without a producer", async () => {
  const fixture = await openFixture("broad-cues");
  const oldId = stableId(1);
  const newId = stableId(2);
  const oldSummary = "Initial checkout transaction validation route uses ./legacy/checkout.ts for rollback recovery and payment verification.";
  const newSummary = "Later checkout transaction validation memory: the prior checkout route was updated after the corrected path failed around ./legacy/checkout.ts during rollback recovery and payment verification.";
  try {
    await seedNodes(fixture.store, [{ id: oldId, title: "Initial checkout route", summary: oldSummary }]);
    const lexical = adjudicateMemoryLifecycle([
      adjudicable({
        id: newId,
        title: "Updated checkout route",
        summary: newSummary,
        observedAt: "2026-07-18T01:00:00.000Z",
        sourceIndex: 0,
      }),
      adjudicable({
        id: oldId,
        title: "Initial checkout route",
        summary: oldSummary,
        observedAt: "2026-07-18T00:00:00.000Z",
        sourceIndex: 1,
      }),
    ], {
      source_memory_ids: [newId],
      target_memory_ids: [oldId],
    });
    assert.equal(lexical.relations.length, 1, "fixture must exercise a real lexical rule-cue hint");
    assert.equal(lexical.relations[0]?.evidence.producer, "rule_cue");

    const current = await preparedWrite({
      input: "observe broad lifecycle wording",
      nodes: [{ id: newId, title: "Updated checkout route", summary: newSummary }],
    });
    await prepareLiteProjectedWrite({ prepared: current, liteWriteStore: fixture.store });
    assert.equal(current.edges.some((edge) => ["supersedes", "contradicts", "invalidates"].includes(edge.type)), false);
    await persistPrepared(fixture.store, current);
    assert.deepEqual(lifecycleEdges(fixture.database), []);
  } finally {
    await fixture.close();
  }
});

test("explicit lexical correction remains a non-authoritative hint without producer confirmation", async () => {
  const fixture = await openFixture("explicit-cue");
  const oldId = stableId(11);
  const newId = stableId(12);
  const oldSummary = "Earlier invoice retry route uses ./legacy/invoice-retry.ts for ledger recovery and duplicate charge verification.";
  const newSummary = "Later evidence contradicted the earlier invoice retry route around ./legacy/invoice-retry.ts; do not use that prior ledger recovery path for duplicate charge verification.";
  try {
    await seedNodes(fixture.store, [{ id: oldId, title: "Earlier invoice retry route", summary: oldSummary }]);
    const lexical = adjudicateMemoryLifecycle([
      adjudicable({
        id: newId,
        title: "Current invoice retry route",
        summary: newSummary,
        observedAt: "2026-07-18T02:00:00.000Z",
        sourceIndex: 0,
      }),
      adjudicable({
        id: oldId,
        title: "Earlier invoice retry route",
        summary: oldSummary,
        observedAt: "2026-07-18T01:00:00.000Z",
        sourceIndex: 1,
      }),
    ], {
      source_memory_ids: [newId],
      target_memory_ids: [oldId],
    });
    assert.equal(lexical.relations[0]?.relation, "contradicts");
    assert.equal(lexical.relations[0]?.evidence.producer, "rule_cue");

    const current = await preparedWrite({
      input: "observe explicit lifecycle correction",
      nodes: [{ id: newId, title: "Current invoice retry route", summary: newSummary }],
    });
    await prepareLiteProjectedWrite({ prepared: current, liteWriteStore: fixture.store });
    await persistPrepared(fixture.store, current);
    assert.deepEqual(lifecycleEdges(fixture.database), []);
  } finally {
    await fixture.close();
  }
});

test("real HTTP producer confirmation is runtime-gated, persisted, and recallable", async () => {
  const fixture = await openFixture("producer-confirmed");
  const oldId = stableId(21);
  const newId = stableId(22);
  const oldSummary = "Earlier checkout authorization route uses ./legacy/checkout-auth.ts for token refresh and payment recovery verification.";
  const newSummary = "Later evidence contradicted the earlier checkout authorization route around ./legacy/checkout-auth.ts; do not use that prior token refresh path for payment recovery verification.";
  const peer = await startModelPeer((captured) => {
    const pairs = captured.userPayload.candidate_pairs as CandidatePair[];
    assert.equal(pairs[0]?.source.memory_id, newId);
    assert.equal(pairs[0]?.target.memory_id, oldId);
    assert.equal(pairs[0]?.hint?.kind, "ephemeral_rule_cue_hint");
    assert.equal(pairs[0]?.hint?.authority, "none");
    return {
      candidates: [{
        source_memory_id: newId,
        target_memory_id: oldId,
        relation: "contradicts",
        confidence: 0.96,
        reasons: ["later evidence explicitly rejects the earlier checkout authorization route"],
      }],
    };
  });
  try {
    await seedNodes(fixture.store, [{ id: oldId, title: "Earlier checkout authorization", summary: oldSummary }]);
    const current = await preparedWrite({
      input: "observe producer-confirmed correction",
      nodes: [{ id: newId, title: "Current checkout authorization", summary: newSummary }],
    });
    await prepareLiteProjectedWrite({
      prepared: current,
      liteWriteStore: fixture.store,
      lifecycleRelationCandidateProducer: httpProducer(peer.baseUrl),
    });
    await persistPrepared(fixture.store, current);

    assert.equal(peer.requests.length, 1);
    assert.equal(peer.requests[0]?.path, "/chat/completions");
    assert.equal(peer.requests[0]?.authorization, "Bearer local-test-key");
    assert.equal(peer.requests[0]?.userPayload.prompt_version, "memory_lifecycle_relation_candidate_prompt_v2");
    const rows = lifecycleEdges(fixture.database);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { type: rows[0]?.type, src_id: rows[0]?.src_id, dst_id: rows[0]?.dst_id },
      { type: "contradicts", src_id: newId, dst_id: oldId },
    );
    const evidence = JSON.parse(rows[0]!.metadata_json) as {
      memory_lifecycle_relation_evidence?: { producer?: string; gate?: { accepted?: boolean } };
    };
    assert.equal(evidence.memory_lifecycle_relation_evidence?.producer, "llm_semantic_lifecycle");
    assert.equal(evidence.memory_lifecycle_relation_evidence?.gate?.accepted, true);

    const recall = createLiteRecallStore(fixture.dbPath);
    try {
      const recalledEdges = await recall.createRecallAccess().stage2Edges({
        seedIds: [newId],
        scope: SCOPE,
        neighborhoodHops: 1,
        minEdgeWeight: 0,
        minEdgeConfidence: 0,
        hop1Budget: 10,
        hop2Budget: 10,
        edgeFetchBudget: 10,
      });
      const recalled = recalledEdges.find((edge) => (
        edge.type === "contradicts" && edge.src_id === newId && edge.dst_id === oldId
      ));
      assert.ok(recalled, "persisted lifecycle relation remains available to recall");
      const recalledEvidence = recalled.metadata.memory_lifecycle_relation_evidence as
        | { producer?: string }
        | undefined;
      assert.equal(recalledEvidence?.producer, "llm_semantic_lifecycle");
    } finally {
      await recall.close();
    }
  } finally {
    await peer.close();
    await fixture.close();
  }
});

test("large history is bounded to 256 and only new sources can reach model review", async () => {
  const fixture = await openFixture("bounded-history");
  const newId = stableId(2_000);
  const hintedTargetId = stableId(1_100);
  const oldestIncludedId = stableId(1_064);
  const historical = Array.from({ length: 320 }, (_, index) => {
    const numericId = 1_000 + index;
    const marker = numericId === 1_100 ? " bounded_hint_marker ./legacy/bounded-hint.ts" : "";
    return {
      id: stableId(numericId),
      title: `Historical memory ${numericId}`,
      summary: `Historical checkout validation record ${numericId} for bounded candidate review.${marker}`,
    };
  });
  const peer = await startModelPeer(() => ({ candidates: [] }));
  try {
    assert.equal(MEMORY_LIFECYCLE_WRITE_HISTORY_LIMIT, 256);
    await seedNodes(fixture.store, historical);
    const current = await preparedWrite({
      input: "observe bounded lifecycle review",
      nodes: [{
        id: newId,
        title: "Current bounded checkout route",
        summary: "Later evidence contradicted the earlier bounded checkout route at ./legacy/bounded-hint.ts; do not use that prior bounded_hint_marker validation record.",
      }],
    });
    await prepareLiteProjectedWrite({
      prepared: current,
      liteWriteStore: fixture.store,
      lifecycleRelationCandidateProducer: httpProducer(peer.baseUrl, 17),
    });
    await persistPrepared(fixture.store, current);

    assert.equal(peer.requests.length, 1);
    const payload = peer.requests[0]!.userPayload;
    assert.equal(payload.pair_order_policy, "ephemeral_hinted_pairs_first_then_bounded_recency_candidates");
    const pairs = payload.candidate_pairs as CandidatePair[];
    assert.equal(pairs.length, 17);
    assert.equal(pairs[0]?.source.memory_id, newId);
    assert.equal(pairs[0]?.target.memory_id, hintedTargetId);
    assert.equal(pairs[0]?.hint?.authority, "none");
    assert.ok(pairs.every((pair) => pair.source.memory_id === newId));
    assert.ok(pairs.every((pair) => pair.target.memory_id !== newId));
    assert.ok(pairs.every((pair) => pair.target.memory_id >= oldestIncludedId));
    assert.deepEqual(lifecycleEdges(fixture.database), []);
  } finally {
    await peer.close();
    await fixture.close();
  }
});

test("producer output cannot transfer lifecycle authority across unreviewed or unrelated pairs", async () => {
  const fixture = await openFixture("negative-transfer");
  const unrelatedId = stableId(31);
  const newId = stableId(32);
  const unknownId = stableId(33);
  const peer = await startModelPeer(() => ({
    candidates: [
      {
        source_memory_id: unrelatedId,
        target_memory_id: newId,
        relation: "invalidates",
        confidence: 0.99,
        reasons: ["attempted reverse-direction transfer"],
      },
      {
        source_memory_id: newId,
        target_memory_id: unknownId,
        relation: "supersedes",
        confidence: 0.99,
        reasons: ["attempted target outside supplied pairs"],
      },
      {
        source_memory_id: newId,
        target_memory_id: unrelatedId,
        relation: "contradicts",
        confidence: 0.99,
        reasons: ["unrelated supplied pair should fail runtime semantic support"],
      },
    ],
  }));
  try {
    await seedNodes(fixture.store, [{
      id: unrelatedId,
      title: "Independent documentation preference",
      summary: "Keep sidebar documentation examples concise and preserve package metadata ordering.",
    }]);
    const current = await preparedWrite({
      input: "observe unrelated lifecycle candidate",
      nodes: [{
        id: newId,
        title: "Current checkout recovery",
        summary: "Later checkout recovery evidence changes payment authorization handling in ./src/payments/recovery.ts.",
      }],
    });
    await prepareLiteProjectedWrite({
      prepared: current,
      liteWriteStore: fixture.store,
      lifecycleRelationCandidateProducer: httpProducer(peer.baseUrl),
    });
    await persistPrepared(fixture.store, current);

    assert.equal(peer.requests.length, 1);
    assert.deepEqual(lifecycleEdges(fixture.database), []);
  } finally {
    await peer.close();
    await fixture.close();
  }
});
