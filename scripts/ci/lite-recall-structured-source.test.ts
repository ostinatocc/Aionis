import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-recall-structured-"));
  return path.join(dir, `${name}.sqlite`);
}

async function insertCommit(store: ReturnType<typeof createLiteWriteStore>, scope: string, suffix: string): Promise<string> {
  return store.insertLegacyV1CommitForMigrationOrTestFixture({
    scope,
    parentCommitId: null,
    inputSha256: `input-${suffix}`,
    diffJson: "{}",
    actor: "structured-recall-test",
    modelVersion: null,
    promptVersion: null,
    commitHash: `commit-hash-${suffix}`,
  });
}

function workflowSlots(args: {
  taskSignature: string;
  workflowSignature: string;
  targetFiles: string[];
  failureMode?: string | null;
  verificationSignature?: string | null;
  acceptanceCheckSignature?: string | null;
  executionOutcomeRole?: string | null;
}): Record<string, unknown> {
  const executionOutcomeRole = args.executionOutcomeRole ?? "passed_solution";
  return {
    summary_kind: "workflow_anchor",
    task_family: "family:structured-runtime",
    repo_signature: "repo:structured-runtime",
    file_cluster: "cluster:runtime-adapter",
    tool_chain_signature: "pnpm-test",
    failure_mode: args.failureMode ?? "legacy-route-regression",
    verification_signature: args.verificationSignature ?? "unit:adapter-boundary",
    acceptance_check_signature: args.acceptanceCheckSignature ?? "accept:adapter-boundary",
    target_files: args.targetFiles,
    execution_native_v1: {
      schema_version: "execution_native_v1",
      execution_kind: "workflow_anchor",
      anchor_kind: "workflow",
      task_signature: args.taskSignature,
      task_family: "family:structured-runtime",
      workflow_signature: args.workflowSignature,
      repo_signature: "repo:structured-runtime",
      file_cluster: "cluster:runtime-adapter",
      target_files: args.targetFiles,
      tool_chain_signature: "pnpm-test",
      failure_mode: args.failureMode ?? "legacy-route-regression",
      verification_signature: args.verificationSignature ?? "unit:adapter-boundary",
      acceptance_check_signature: args.acceptanceCheckSignature ?? "accept:adapter-boundary",
      execution_outcome_role: executionOutcomeRole,
    },
    anchor_v1: {
      schema_version: "anchor_v1",
      anchor_kind: "workflow",
      anchor_level: "L2",
      task_signature: args.taskSignature,
      workflow_signature: args.workflowSignature,
      summary: "Accepted structured workflow anchor",
    },
  };
}

async function insertProcedure(
  store: ReturnType<typeof createLiteWriteStore>,
  args: {
    id: string;
    scope: string;
    title: string;
    textSummary: string;
    slots: Record<string, unknown>;
    embeddingVector?: number[] | null;
    commitId: string;
    salience?: number;
    confidence?: number;
  },
): Promise<void> {
  await store.insertNode({
    id: args.id,
    scope: args.scope,
    clientId: null,
    type: "procedure",
    tier: "hot",
    title: args.title,
    textSummary: args.textSummary,
    slotsJson: JSON.stringify(args.slots),
    rawRef: null,
    evidenceRef: null,
    embeddingVector: args.embeddingVector ? JSON.stringify(args.embeddingVector) : null,
    embeddingModel: args.embeddingVector ? "test" : null,
    memoryLane: "shared",
    producerAgentId: null,
    ownerAgentId: null,
    ownerTeamId: null,
    embeddingStatus: args.embeddingVector ? "ready" : "pending",
    embeddingLastError: null,
    salience: args.salience ?? 0.9,
    importance: 0.5,
    confidence: args.confidence ?? 0.9,
    redactionVersion: 0,
    commitId: args.commitId,
  });
}

test("structured recall finds execution-native signatures without ready embeddings", async () => {
  const dbPath = tmpDbPath("signature");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "structured/default", "signature");
      await insertProcedure(writeStore, {
        id: "structured-target",
        scope: "structured/default",
        title: "Structured runtime accepted workflow",
        textSummary: "Continue the structured runtime adapter route.",
        slots: workflowSlots({
          taskSignature: "task:structured-runtime",
          workflowSignature: "workflow:structured-runtime",
          targetFiles: ["src/runtime/structured-adapter.ts"],
        }),
        commitId,
      });
      await insertProcedure(writeStore, {
        id: "structured-distractor",
        scope: "structured/default",
        title: "Unrelated workflow",
        textSummary: "A different workflow anchor.",
        slots: workflowSlots({
          taskSignature: "task:unrelated",
          workflowSignature: "workflow:unrelated",
          targetFiles: ["src/runtime/unrelated.ts"],
          failureMode: "different-failure",
        }),
        commitId,
      });
    });

    const db = createSqliteDatabase(dbPath);
    try {
      const indexRow = db.prepare(`
        SELECT task_family, repo_signature, file_cluster, target_files_text, tool_chain_signature,
               failure_mode, verification_signature, acceptance_check_signature
        FROM lite_memory_execution_native_index
        WHERE scope = ? AND node_id = ?
      `).get("structured/default", "structured-target") as Record<string, string | null> | undefined;
      assert.equal(indexRow?.task_family, "family:structured-runtime");
      assert.equal(indexRow?.repo_signature, "repo:structured-runtime");
      assert.equal(indexRow?.file_cluster, "cluster:runtime-adapter");
      assert.equal(indexRow?.target_files_text, "src/runtime/structured-adapter.ts");
      assert.equal(indexRow?.tool_chain_signature, "pnpm-test");
      assert.equal(indexRow?.failure_mode, "legacy-route-regression");
      assert.equal(indexRow?.verification_signature, "unit:adapter-boundary");
      assert.equal(indexRow?.acceptance_check_signature, "accept:adapter-boundary");
    } finally {
      db.close();
    }

    const access = recallStore.createRecallAccess();
    const structured = await access.stage1StructuredCandidates({
      scope: "structured/default",
      limit: 5,
      workflowSignature: "workflow:structured-runtime",
      targetFiles: ["src/runtime/structured-adapter.ts"],
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(structured[0]?.id, "structured-target");
    assert.equal(structured[0]?.sources?.[0]?.kind, "structured");
    assert.equal(structured[0]?.sources?.[0]?.index_name, "lite_memory_execution_native_index");
    assert.ok(structured[0]?.sources?.[0]?.matched_fields?.includes("workflow_signature"));
    assert.ok(structured[0]?.sources?.[0]?.matched_fields?.includes("target_files"));

    const executionNative = await access.stage1ExecutionNativeCandidates({
      scope: "structured/default",
      limit: 5,
      failureMode: "legacy-route-regression",
      verificationSignature: "unit:adapter-boundary",
      acceptanceCheckSignature: "accept:adapter-boundary",
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(executionNative[0]?.id, "structured-target");
    assert.equal(executionNative[0]?.sources?.[0]?.kind, "execution_native");
    assert.ok(executionNative[0]?.sources?.[0]?.matched_fields?.includes("failure_mode"));
    assert.ok(executionNative[0]?.sources?.[0]?.matched_fields?.includes("verification_signature"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("execution-native workflow recall keeps accepted route evidence under noisy workflow history", async () => {
  const dbPath = tmpDbPath("workflow-noise");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  const scope = "structured/workflow-noise";
  const workflowSignature = "workflow:buried-route";
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, scope, "workflow-noise");
      await insertProcedure(writeStore, {
        id: "accepted-route-evidence",
        scope,
        title: "Accepted route recovery",
        textSummary: "Verifier accepted the continuation route through vc/raw.rs and backend wiring.",
        slots: workflowSlots({
          taskSignature: "task:buried-route:accepted",
          workflowSignature,
          targetFiles: [
            "turbopack/crates/turbo-tasks/src/vc/raw.rs",
            "turbopack/crates/turbo-tasks/src/vc/mod.rs",
            "turbopack/crates/turbo-tasks/src/backend.rs",
          ],
          verificationSignature: "verifier:accepted-route",
          acceptanceCheckSignature: "accept:turbo-vc-route",
          executionOutcomeRole: "passed_solution",
        }),
        commitId,
      });

      for (let index = 0; index < 180; index += 1) {
        await insertProcedure(writeStore, {
          id: `workflow-noise-${String(index).padStart(3, "0")}`,
          scope,
          title: `Workflow background note ${index}`,
          textSummary: "Background event from the same workflow; not an accepted continuation route.",
          slots: workflowSlots({
            taskSignature: `task:buried-route:noise:${index}`,
            workflowSignature,
            targetFiles: [`internal/e2e-noise/next.js/note-${index}.md`],
            failureMode: null,
            verificationSignature: null,
            acceptanceCheckSignature: null,
            executionOutcomeRole: "unknown",
          }),
          commitId,
          salience: 0.95,
          confidence: 0.95,
        });
      }

      await insertProcedure(writeStore, {
        id: "late-legacy-reference",
        scope,
        title: "Legacy route reference",
        textSummary: "Old raw_vc.rs route may be readable as background but is not the accepted branch.",
        slots: workflowSlots({
          taskSignature: "task:buried-route:legacy-reference",
          workflowSignature,
          targetFiles: ["turbopack/crates/turbo-tasks/src/raw_vc.rs"],
          failureMode: "legacy-route",
          verificationSignature: null,
          acceptanceCheckSignature: null,
          executionOutcomeRole: "unknown",
        }),
        commitId,
        salience: 0.95,
        confidence: 0.95,
      });
    });

    const candidates = await recallStore.createRecallAccess().stage1ExecutionNativeCandidates({
      scope,
      limit: 10,
      workflowSignature,
      consumerAgentId: null,
      consumerTeamId: null,
    });
    const ids = candidates.map((candidate) => candidate.id);
    assert.ok(ids.includes("accepted-route-evidence"), "accepted workflow route evidence should survive workflow noise prefetch");
    assert.ok(ids.includes("late-legacy-reference"), "late legacy references may still be inspected as structured candidates");
    assert.ok(
      ids.indexOf("accepted-route-evidence") < ids.indexOf("late-legacy-reference"),
      "accepted route evidence should outrank same-workflow legacy references",
    );
    assert.equal(candidates[0]?.id, "accepted-route-evidence");
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("hybrid recall merges semantic lexical structured and execution-native source traces", async () => {
  const dbPath = tmpDbPath("hybrid");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "structured/hybrid", "hybrid");
      await insertProcedure(writeStore, {
        id: "hybrid-target",
        scope: "structured/hybrid",
        title: "Hybrid BeaconRoute workflow",
        textSummary: "Continue the BeaconRoute workflow through the accepted structured adapter.",
        slots: workflowSlots({
          taskSignature: "task:hybrid-beacon",
          workflowSignature: "workflow:hybrid-beacon",
          targetFiles: ["src/runtime/beacon-route.ts"],
          failureMode: "beacon-legacy-failure",
          verificationSignature: "unit:beacon-route",
          acceptanceCheckSignature: "accept:beacon-route",
        }),
        embeddingVector: [1, 0, 0],
        commitId,
      });
      await insertProcedure(writeStore, {
        id: "hybrid-semantic-only",
        scope: "structured/hybrid",
        title: "Semantic-only neighbor",
        textSummary: "A nearby but less supported semantic candidate.",
        slots: workflowSlots({
          taskSignature: "task:semantic-only",
          workflowSignature: "workflow:semantic-only",
          targetFiles: ["src/runtime/semantic-only.ts"],
        }),
        embeddingVector: [0.99, 0.01, 0],
        commitId,
      });
    });

    const hybrid = await recallStore.createRecallAccess().stage1HybridCandidates({
      scope: "structured/hybrid",
      limit: 5,
      queryEmbedding: [1, 0, 0],
      queryText: "BeaconRoute accepted adapter",
      structured: {
        taskSignature: "task:hybrid-beacon",
        workflowSignature: "workflow:hybrid-beacon",
        targetFiles: ["src/runtime/beacon-route.ts"],
        failureMode: "beacon-legacy-failure",
        verificationSignature: "unit:beacon-route",
        acceptanceCheckSignature: "accept:beacon-route",
      },
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(hybrid[0]?.id, "hybrid-target");
    assert.deepEqual(
      hybrid[0]?.sources?.map((source) => source.kind).sort(),
      ["execution_native", "lexical", "recent", "semantic", "structured"],
    );
    assert.ok((hybrid[0]?.similarity ?? 0) <= 1);
    assert.ok((hybrid[0]?.similarity ?? 0) > (hybrid[1]?.similarity ?? 0));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});

test("structured recall index follows anchor state updates", async () => {
  const dbPath = tmpDbPath("update");
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      const commitId = await insertCommit(writeStore, "structured/update", "update");
      await insertProcedure(writeStore, {
        id: "updatable-structured-node",
        scope: "structured/update",
        title: "Old workflow route",
        textSummary: "Old route before structured update.",
        slots: workflowSlots({
          taskSignature: "task:old",
          workflowSignature: "workflow:old",
          targetFiles: ["src/runtime/old.ts"],
        }),
        commitId,
      });
      await writeStore.updateNodeAnchorState({
        scope: "structured/update",
        id: "updatable-structured-node",
        slots: workflowSlots({
          taskSignature: "task:new",
          workflowSignature: "workflow:new",
          targetFiles: ["src/runtime/new.ts"],
          failureMode: "new-failure-mode",
        }),
        textSummary: "New structured workflow route.",
        salience: 0.9,
        importance: 0.5,
        confidence: 0.9,
        commitId,
      });
    });

    const access = recallStore.createRecallAccess();
    const oldWorkflow = await access.stage1StructuredCandidates({
      scope: "structured/update",
      limit: 5,
      workflowSignature: "workflow:old",
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.ok(!oldWorkflow.some((candidate) => candidate.id === "updatable-structured-node"));

    const newWorkflow = await access.stage1StructuredCandidates({
      scope: "structured/update",
      limit: 5,
      workflowSignature: "workflow:new",
      targetFiles: ["src/runtime/new.ts"],
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(newWorkflow[0]?.id, "updatable-structured-node");
    assert.ok(newWorkflow[0]?.sources?.[0]?.matched_fields?.includes("workflow_signature"));
    assert.ok(newWorkflow[0]?.sources?.[0]?.matched_fields?.includes("target_files"));
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
});
