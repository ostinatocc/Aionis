import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { drainLiteAssociativeLinkOutbox } from "../../src/jobs/associative-linking-worker.ts";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-assoc-worker-"));
  return path.join(dir, "write.sqlite");
}

async function writeExecutionEvent(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  clientId: string;
  title: string;
  summary: string;
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
      title: "Checkout renderer baseline passed",
      summary: "Renderer path validated checkout contract and typecheck.",
    });
    const secondWrite = await writeExecutionEvent({
      liteWriteStore,
      clientId: "assoc:second",
      title: "Checkout renderer continuation passed",
      summary: "Continuation reused the checkout renderer contract and validations.",
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
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
