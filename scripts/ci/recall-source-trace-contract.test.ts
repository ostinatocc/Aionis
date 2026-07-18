import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RECALL_STORE_ACCESS_CAPABILITY_VERSION,
  assertRecallStoreAccessContract,
} from "../../src/store/recall-access.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import {
  buildAionisMemoryDecisionTrace,
  buildAionisMemoryPacket,
  buildAionisMemoryUseReceiptFromDecisionTrace,
} from "../../src/memory/product-output-assembler.ts";
import { buildAionisAgentFlightRecorderReport } from "../../src/memory/product-output/operator-projections.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-recall-source-trace-"));
  return path.join(dir, `${name}.sqlite`);
}

async function insertReadyConcept(args: {
  writeStore: ReturnType<typeof createLiteWriteStore>;
  scope: string;
  id: string;
  vector: number[];
  tier?: "hot" | "warm" | "cold";
}): Promise<void> {
  const commitId = await args.writeStore.insertLegacyV1CommitForMigrationOrTestFixture({
    scope: args.scope,
    parentCommitId: null,
    inputSha256: `source-trace-${args.id}`,
    diffJson: "{}",
    actor: "recall-source-trace-test",
    modelVersion: null,
    promptVersion: null,
    commitHash: `source-trace-${args.id}`,
  });
  await args.writeStore.insertNode({
    id: args.id,
    scope: args.scope,
    clientId: null,
    type: "concept",
    tier: args.tier ?? "hot",
    title: `source trace ${args.id}`,
    textSummary: `source trace memory ${args.id}`,
    slotsJson: "{}",
    rawRef: null,
    evidenceRef: null,
    embeddingVector: JSON.stringify(args.vector),
    embeddingModel: "test",
    memoryLane: "shared",
    producerAgentId: null,
    ownerAgentId: null,
    ownerTeamId: null,
    embeddingStatus: "ready",
    embeddingLastError: null,
    salience: 0.9,
    importance: 0.5,
    confidence: 0.9,
    redactionVersion: 0,
    commitId,
  });
}

test("RecallStoreAccess v4 exposes candidate source traces without changing candidate admission", async () => {
  const dbPath = tmpDbPath("v3-source-contract");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      await insertReadyConcept({
        writeStore,
        scope: "source-trace/default",
        id: "semantic-target",
        vector: [1, 0, 0],
      });
    });

    const access = recallStore.createRecallAccess();
    assertRecallStoreAccessContract(access);
    assert.equal(access.capability_version, RECALL_STORE_ACCESS_CAPABILITY_VERSION);
    assert.equal(access.capability_version, 4);

    const semantic = await access.stage1SemanticCandidates({
      queryEmbedding: [1, 0, 0],
      scope: "source-trace/default",
      oversample: 5,
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(semantic[0]?.id, "semantic-target");
    assert.equal(semantic[0]?.sources?.[0]?.kind, "semantic");
    assert.equal(semantic[0]?.sources?.[0]?.reason, "bounded_embedding_scan");
    assert.equal(semantic[0]?.sources?.[0]?.index_name, "lite_embedding_json_scan");
    assert.ok(typeof semantic[0]?.sources?.[0]?.score === "number");
    assert.deepEqual(semantic[0]?.sources?.[0]?.matched_fields, ["embedding_vector_json"]);

    const exact = await access.stage1CandidatesExactRecovery({
      queryEmbedding: [1, 0, 0],
      scope: "source-trace/default",
      oversample: 5,
      limit: 5,
      allowedTiers: ["hot", "warm", "cold"],
      scanLimit: null,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(exact[0]?.id, "semantic-target");
    assert.equal(exact[0]?.sources?.[0]?.kind, "exact_recovery");
    assert.equal(exact[0]?.sources?.[0]?.reason, "unbounded_exact_embedding_recovery");

    const hybrid = await access.stage1HybridCandidates({
      queryEmbedding: [1, 0, 0],
      scope: "source-trace/default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(hybrid[0]?.id, "semantic-target");
    assert.equal(hybrid[0]?.sources?.[0]?.kind, "semantic");

    const recent = await access.stage1RecentCandidates({
      scope: "source-trace/default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(recent[0]?.id, "semantic-target");
    assert.equal(recent[0]?.sources?.[0]?.kind, "recent");

    assert.deepEqual(await access.stage1GraphCandidates({
      scope: "source-trace/default",
      seedIds: ["semantic-target"],
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    }), []);

    const lexical = await access.stage1LexicalCandidates({
      queryText: "semantic-target",
      scope: "source-trace/default",
      limit: 5,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(lexical[0]?.id, "semantic-target");
    assert.equal(lexical[0]?.sources?.[0]?.kind, "lexical");
    assert.equal(lexical[0]?.sources?.[0]?.reason, "keyword_index_match");
    const semanticSources = [
      ...(semantic[0]!.sources ?? []),
      {
        kind: "substrate" as const,
        score: 0.91,
        reason: "substrate_sidecar_search",
        matched_fields: ["query_match"],
        index_name: "aionis_substrate_sidecar",
      },
    ];

    const sourceRows = await access.stage2Nodes({
      scope: "source-trace/default",
      nodeIds: ["semantic-target"],
      consumerAgentId: null,
      consumerTeamId: null,
      includeSlots: true,
    });
    const memoryPacket = buildAionisMemoryPacket({
      tenant_id: "default",
      scope: "source-trace/default",
      query: {
        source: "embedding",
        embedding_dims: 3,
      },
      nodes: sourceRows,
      context_items: [],
      ranked: [{ id: "semantic-target", score: semantic[0]!.similarity }],
      recall_sources_by_memory_id: {
        "semantic-target": semanticSources,
      },
      source_map: {
        routes_used: ["/v1/memory/recall"],
      },
    });
    assert.equal(memoryPacket.relevant_memories[0]?.recall_sources[0]?.kind, "semantic");
    assert.equal(memoryPacket.relevant_memories[0]?.recall_sources[0]?.index_name, "lite_embedding_json_scan");
    assert.ok(memoryPacket.relevant_memories[0]?.recall_sources.some((source) => source.kind === "substrate"));

    const decisionTrace = buildAionisMemoryDecisionTrace({
      tenant_id: "default",
      scope: "source-trace/default",
      after_guide: {
        memory_packet: memoryPacket,
        guide_packet: null,
        agent_context: null,
      },
    });
    assert.equal(decisionTrace.memory_decisions[0]?.recall_sources[0]?.kind, "semantic");
    assert.ok(decisionTrace.memory_decisions[0]?.recall_sources.some((source) => source.kind === "substrate"));
    assert.ok(decisionTrace.source_map.internal_surfaces_used.includes("recall_source_trace"));
    assert.equal(decisionTrace.memory_use_receipt.decision_summaries[0]?.recall_sources[0]?.kind, "semantic");
    assert.ok(decisionTrace.memory_use_receipt.decision_summaries[0]?.recall_sources.some((source) => source.kind === "substrate"));
    assert.equal(decisionTrace.admission_record.entries[0]?.recall_sources[0]?.kind, "semantic");
    assert.ok(decisionTrace.admission_record.entries[0]?.recall_sources.some((source) => source.kind === "substrate"));

    const receipt = buildAionisMemoryUseReceiptFromDecisionTrace(decisionTrace);
    assert.equal(receipt.decision_summaries[0]?.recall_sources[0]?.reason, "bounded_embedding_scan");
    assert.ok(receipt.decision_summaries[0]?.recall_sources.some((source) => source.kind === "substrate"));

    const flightRecorder = buildAionisAgentFlightRecorderReport({
      tenant_id: "default",
      scope: "source-trace/default",
      memory_decision_trace: decisionTrace,
      memory_use_receipt: receipt,
      now: "2026-06-16T00:00:00.000Z",
    });
    assert.equal(
      flightRecorder.agent_view.recall_sources_by_memory_id[0]?.recall_sources[0]?.kind,
      "semantic",
    );
    assert.ok(
      flightRecorder.agent_view.recall_sources_by_memory_id[0]?.recall_sources.some((source) => source.kind === "substrate"),
    );

    assert.deepEqual(await access.stage1StructuredCandidates({
      scope: "source-trace/default",
      limit: 5,
      workflowSignature: "none",
      consumerAgentId: null,
      consumerTeamId: null,
    }), []);
    assert.deepEqual(await access.stage1ExecutionNativeCandidates({
      scope: "source-trace/default",
      limit: 5,
      workflowSignature: "none",
      consumerAgentId: null,
      consumerTeamId: null,
    }), []);
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});
