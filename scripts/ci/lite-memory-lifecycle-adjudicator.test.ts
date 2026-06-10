import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adjudicateMemoryLifecycle,
  type AdjudicableMemoryEntry,
  type MemoryLifecycleRelationCandidateProducer,
} from "../../src/memory/memory-lifecycle-adjudicator.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-lifecycle-adjudicator-"));
  return path.join(dir, `${name}.sqlite`);
}

const oldEntry: AdjudicableMemoryEntry = {
  memory_id: "00000000-0000-4000-8000-000000000001",
  title: "old route",
  summary: "AIONIS_PARAPHRASE_OLD: First-pass project memory. The suspected work area was: ./first_pass/entrypoint.ts, ./first_pass/verification.test.ts. This was recorded before deeper inspection.",
  domain: "general",
  authority: "advisory",
  confidence: 0.9,
  salience: 0.8,
  lifecycle_state: "active",
  observed_at: "2026-01-01T00:00:00.000Z",
  source_index: 1,
};

const currentEntry: AdjudicableMemoryEntry = {
  memory_id: "00000000-0000-4000-8000-000000000002",
  title: "current route",
  summary: "AIONIS_PARAPHRASE_CURRENT: Follow-up project memory. That approach around ./first_pass/entrypoint.ts and ./first_pass/verification.test.ts did not pan out in the end. Useful next-session context is: ./src/runtime.ts, ./test/runtime.test.ts.",
  domain: "general",
  authority: "advisory",
  confidence: 0.92,
  salience: 0.9,
  lifecycle_state: "active",
  observed_at: "2026-01-02T00:00:00.000Z",
  source_index: 0,
};

test("lifecycle adjudicator accepts semantic relation candidates only after runtime gating", () => {
  const deterministic = adjudicateMemoryLifecycle([currentEntry, oldEntry]);
  assert.equal(deterministic.relations.length, 0);
  assert.equal(deterministic.entries.find((entry) => entry.memory_id === oldEntry.memory_id)?.lifecycle_state, "active");

  const adjudicated = adjudicateMemoryLifecycle([currentEntry, oldEntry], {
    candidate_relations: [{
      source_memory_id: currentEntry.memory_id,
      target_memory_id: oldEntry.memory_id,
      relation: "supersedes",
      confidence: 0.86,
      producer: "test_llm_semantic",
      reasons: ["follow-up memory says the first-pass route did not pan out"],
    }],
  });

  assert.equal(adjudicated.relations.length, 1);
  assert.equal(adjudicated.relations[0]?.relation, "supersedes");
  assert.ok(adjudicated.relations[0]?.reasons.some((reason) => reason === "candidate_producer=test_llm_semantic"));
  assert.equal(adjudicated.relations[0]?.evidence.producer, "test_llm_semantic");
  assert.equal(adjudicated.relations[0]?.evidence.candidate_confidence, 0.86);
  assert.equal(adjudicated.relations[0]?.evidence.gate.accepted, true);
  assert.equal(adjudicated.relations[0]?.evidence.gate.relation_supported, true);
  assert.ok((adjudicated.relations[0]?.evidence.signals.topic_overlap ?? 0) > 0);
  const old = adjudicated.entries.find((entry) => entry.memory_id === oldEntry.memory_id);
  assert.equal(old?.lifecycle_state, "contested");
  assert.equal(old?.authority, "candidate");
});

test("lifecycle adjudicator rejects unrelated high-confidence semantic candidates", () => {
  const unrelated: AdjudicableMemoryEntry = {
    ...oldEntry,
    memory_id: "00000000-0000-4000-8000-000000000003",
    title: "unrelated",
    summary: "Independent valid note about docs/sidebar.md and package metadata. This remains active for a separate documentation task.",
  };
  const adjudicated = adjudicateMemoryLifecycle([currentEntry, unrelated], {
    candidate_relations: [{
      source_memory_id: currentEntry.memory_id,
      target_memory_id: unrelated.memory_id,
      relation: "supersedes",
      confidence: 0.96,
      producer: "test_llm_semantic",
      reasons: ["model guessed a relation"],
    }],
  });

  assert.equal(adjudicated.relations.length, 0);
  assert.equal(adjudicated.entries.find((entry) => entry.memory_id === unrelated.memory_id)?.lifecycle_state, "active");
});

test("lifecycle adjudicator keeps same target-set execution procedure active despite generic stale-branch safeguards", () => {
  const currentWorkflow: AdjudicableMemoryEntry = {
    memory_id: "00000000-0000-4000-8000-000000000004",
    title: "Current execution state",
    summary: "Current state: resume src/runtime.ts and tests/runtime.test.ts. Avoid restarting from superseded route assumptions.",
    domain: "execution",
    authority: "advisory",
    confidence: 0.82,
    salience: 0.9,
    lifecycle_state: "active",
    observed_at: "2026-01-03T00:00:00.000Z",
    target_files: ["src/runtime.ts", "tests/runtime.test.ts"],
    source_index: 0,
  };
  const reusableProcedure: AdjudicableMemoryEntry = {
    memory_id: "00000000-0000-4000-8000-000000000005",
    title: "Reusable execution procedure",
    summary: "Procedure: inspect src/runtime.ts, keep the edit boundary narrow, and validate tests/runtime.test.ts.",
    domain: "execution",
    authority: "advisory",
    confidence: 0.8,
    salience: 0.88,
    lifecycle_state: "active",
    observed_at: "2026-01-02T00:00:00.000Z",
    target_files: ["src/runtime.ts", "tests/runtime.test.ts"],
    source_index: 1,
  };

  const adjudicated = adjudicateMemoryLifecycle([currentWorkflow, reusableProcedure]);

  assert.equal(adjudicated.relations.length, 0);
  assert.equal(adjudicated.entries.find((entry) => entry.memory_id === reusableProcedure.memory_id)?.lifecycle_state, "active");
  assert.equal(adjudicated.entries.find((entry) => entry.memory_id === reusableProcedure.memory_id)?.authority, "advisory");
});

test("lifecycle adjudicator does not treat recall rank as recency for stale execution notes", () => {
  const staleFirst: AdjudicableMemoryEntry = {
    memory_id: "00000000-0000-4000-8000-000000000006",
    title: "superseded premise from legacy/runtime.ts",
    summary: "Superseded execution note points at legacy/runtime.ts as the continuation point.",
    domain: "execution",
    authority: "advisory",
    confidence: 0.82,
    salience: 0.95,
    lifecycle_state: "active",
    target_files: ["legacy/runtime.ts"],
    source_index: 0,
  };
  const currentSecond: AdjudicableMemoryEntry = {
    memory_id: "00000000-0000-4000-8000-000000000007",
    title: "current execution state",
    summary: "Current state points at src/runtime.ts and tests/runtime.test.ts.",
    domain: "execution",
    authority: "advisory",
    confidence: 0.82,
    salience: 0.9,
    lifecycle_state: "active",
    target_files: ["src/runtime.ts", "tests/runtime.test.ts"],
    source_index: 1,
  };

  const adjudicated = adjudicateMemoryLifecycle([staleFirst, currentSecond]);

  assert.equal(adjudicated.relations.length, 0);
  assert.equal(adjudicated.entries.find((entry) => entry.memory_id === currentSecond.memory_id)?.lifecycle_state, "active");
});

test("memory write persists only runtime-admitted lifecycle relation candidates", async () => {
  const dbPath = tmpDbPath("candidate-relation");
  const store = createLiteWriteStore(dbPath);
  try {
    const oldPrepared = await prepareMemoryWrite({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "old paraphrase memory",
      nodes: [{
        id: oldEntry.memory_id,
        type: "concept",
        title: oldEntry.title,
        text_summary: oldEntry.summary,
        confidence: oldEntry.confidence,
        salience: oldEntry.salience,
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
      }],
    }, "default", "default", {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    }, null);
    await store.withTx(() => applyMemoryWrite(oldPrepared, {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      write_access: store,
    }));

    const producer: MemoryLifecycleRelationCandidateProducer = async ({ source_memory_ids }) => [{
      source_memory_id: source_memory_ids[0] ?? currentEntry.memory_id,
      target_memory_id: oldEntry.memory_id,
      relation: "supersedes",
      confidence: 0.86,
      producer: "test_llm_semantic",
      reasons: ["follow-up memory says the first-pass route did not pan out"],
    }];
    const currentPrepared = await prepareMemoryWrite({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "current paraphrase memory",
      nodes: [{
        id: currentEntry.memory_id,
        type: "concept",
        title: currentEntry.title,
        text_summary: currentEntry.summary,
        confidence: currentEntry.confidence,
        salience: currentEntry.salience,
        slots: {
          memory_kind: "general_memory",
          compression_layer: "L2",
        },
      }],
    }, "default", "default", {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    }, null);
    const result = await store.withTx(() => applyMemoryWrite(currentPrepared, {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      lifecycleRelationCandidateProducer: producer,
      write_access: store,
    }));

    assert.ok(result.edges.some((edge) =>
      edge.type === "supersedes"
      && edge.src_id === currentEntry.memory_id
      && edge.dst_id === oldEntry.memory_id
    ));
    const recallStore = createLiteRecallStore(dbPath);
    try {
      const access = recallStore.createRecallAccess();
      const edges = await access.stage2Edges({
        seedIds: [currentEntry.memory_id],
        scope: "default",
        neighborhoodHops: 1,
        minEdgeWeight: 0,
        minEdgeConfidence: 0,
        hop1Budget: 10,
        hop2Budget: 10,
        edgeFetchBudget: 10,
      });
      const relationEdge = edges.find((edge) =>
        edge.type === "supersedes"
        && edge.src_id === currentEntry.memory_id
        && edge.dst_id === oldEntry.memory_id
      );
      const evidence = relationEdge?.metadata.memory_lifecycle_relation_evidence as Record<string, unknown> | undefined;
      assert.equal(evidence?.producer, "test_llm_semantic");
      assert.equal((evidence?.gate as Record<string, unknown> | undefined)?.accepted, true);
      assert.equal((evidence?.signals as Record<string, unknown> | undefined)?.source_newer, true);
    } finally {
      await recallStore.close();
    }
  } finally {
    store.close();
  }
});
