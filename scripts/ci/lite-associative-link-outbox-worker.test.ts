import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { buildAionisMemoryPacket } from "../../src/memory/product-output-assembler.ts";
import {
  drainLiteAssociativeLinkOutbox,
  startLiteAssociativeLinkWorker,
} from "../../src/jobs/associative-linking-worker.ts";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-assoc-worker-"));
  return path.join(dir, "write.sqlite");
}

function vectorAt(index: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0));
}

async function writeExecutionEvent(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  clientId: string;
  title: string;
  summary: string;
  embedding: number[];
}) {
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "assoc-worker-test",
      input_text: args.summary,
      auto_embed: false,
      nodes: [{
        client_id: args.clientId,
        type: "event",
        title: args.title,
        text_summary: args.summary,
        embedding: args.embedding,
        embedding_model: "assoc-worker-test",
        memory_lane: "shared",
        slots: {
          execution_state_v1: {
            resume_anchor: {
              anchor: "checkout-renderer",
              repo_root: "repo://checkout",
              file_path: "src/checkout/renderer.ts",
              symbol: "renderCheckout",
            },
            pending_validations: ["npm test -- checkout"],
            completed_validations: ["npm run typecheck"],
          },
        },
      }],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );
  return await args.liteWriteStore.withTx(() =>
    applyPreparedMemoryWrite(args.liteWriteStore, prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    })
  );
}

test("lite associative_link outbox drains into shadow candidates", async () => {
  const dbPath = tmpDbPath();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const firstWrite = await writeExecutionEvent({
      liteWriteStore,
      clientId: "assoc:first",
      title: "Checkout renderer baseline BEACON_ASSOC_SOURCE passed",
      summary: "Renderer path validated checkout contract and typecheck.",
      embedding: vectorAt(0),
    });
    const secondWrite = await writeExecutionEvent({
      liteWriteStore,
      clientId: "assoc:second",
      title: "Related renderer continuation passed",
      summary: "Continuation reused the renderer contract and validations.",
      embedding: vectorAt(1),
    });
    const firstId = firstWrite.nodes[0]?.id;
    const secondId = secondWrite.nodes[0]?.id;
    assert.ok(firstId);
    assert.ok(secondId);

    const before = await liteWriteStore.listOutboxEvents({ eventType: "associative_link", limit: 10 });
    assert.equal(before.length, 2);

    const drained = await drainLiteAssociativeLinkOutbox({
      writeStore: liteWriteStore,
      recallAccess: liteRecallStore.createRecallAccess(),
      limit: 10,
    });
    assert.equal(drained.scanned, 2);
    assert.equal(drained.failed, 0);
    assert.equal(drained.processed, 2);
    assert.ok(drained.results.some((result) => result.shadow_created > 0));

    const after = await liteWriteStore.listOutboxEvents({ eventType: "associative_link", limit: 10 });
    assert.equal(after.length, 0);

    const candidates = await liteWriteStore.listAssociationCandidatesForSource({
      scope: "default",
      src_id: secondId,
      statuses: ["shadow"],
      limit: 10,
    });
    assert.ok(candidates.some((candidate) => candidate.dst_id === firstId));

    const recallAccess = liteRecallStore.createRecallAccess();
    const graphSeeds = await recallAccess.stage1GraphCandidates({
      scope: "default",
      seedIds: [firstId],
      limit: 10,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    const relatedSeed = graphSeeds.find((seed) => seed.id === secondId);
    assert.ok(relatedSeed);
    assert.ok(relatedSeed.sources?.some((source) =>
      source.kind === "associative_shadow"
      && source.reason === "shadow_association_candidate"
      && source.index_name === "lite_memory_association_candidates"
      && source.matched_fields.includes("handoff_anchor_match")
    ));
    const relatedRows = await recallAccess.stage2Nodes({
      scope: "default",
      nodeIds: [secondId],
      consumerAgentId: null,
      consumerTeamId: null,
      includeSlots: true,
    });
    const memoryPacket = buildAionisMemoryPacket({
      tenant_id: "default",
      scope: "default",
      query: {
        source: "text",
        embedding_dims: 1536,
      },
      nodes: relatedRows,
      context_items: [],
      ranked: [{ id: secondId, score: relatedSeed.similarity }],
      recall_sources_by_memory_id: {
        [secondId]: relatedSeed.sources ?? [],
      },
      source_map: {
        routes_used: ["/v1/memory/planning/context"],
      },
    });
    const relatedPacketMemory = memoryPacket.relevant_memories.find((entry) => entry.memory_id === secondId);
    assert.ok(relatedPacketMemory);
    assert.ok(relatedPacketMemory.recall_sources.some((source) => source.kind === "associative_shadow"));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("lite associative_link worker shutdown waits for its active initial drain", async () => {
  const dbPath = tmpDbPath();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  let worker: ReturnType<typeof startLiteAssociativeLinkWorker> | null = null;
  try {
    await writeExecutionEvent({
      liteWriteStore,
      clientId: "assoc:shutdown:first",
      title: "Checkout renderer baseline for shutdown drain",
      summary: "Renderer path validated checkout contract and typecheck.",
      embedding: vectorAt(0),
    });
    const secondWrite = await writeExecutionEvent({
      liteWriteStore,
      clientId: "assoc:shutdown:second",
      title: "Related renderer continuation for shutdown drain",
      summary: "Continuation reused the renderer contract and validations.",
      embedding: vectorAt(1),
    });
    const secondId = secondWrite.nodes[0]?.id;
    assert.ok(secondId);
    assert.equal((await liteWriteStore.listOutboxEvents({
      eventType: "associative_link",
      limit: 10,
    })).length, 2);

    worker = startLiteAssociativeLinkWorker({
      writeStore: liteWriteStore,
      recallAccess: liteRecallStore.createRecallAccess(),
      intervalMs: 60_000,
      batchSize: 10,
    });
    await worker.shutdown();

    assert.equal((await liteWriteStore.listOutboxEvents({
      eventType: "associative_link",
      limit: 10,
    })).length, 0);
    const candidates = await liteWriteStore.listAssociationCandidatesForSource({
      scope: "default",
      src_id: secondId,
      statuses: ["shadow"],
      limit: 10,
    });
    assert.ok(candidates.length > 0);
  } finally {
    if (worker) await worker.shutdown();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
