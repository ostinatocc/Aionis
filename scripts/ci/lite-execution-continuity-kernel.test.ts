import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createExecutionTreeV1,
  applyExecutionTreeOperationV1,
  createLiteExecutionStateStore,
  createLiteExecutionTreeStore,
  type ExecutionStateV1,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import {
  applyExecutionContinuityTransitionsFromSlots,
  applyExecutionTreeOperationsFromSlots,
  buildExecutionContinuityContext,
  executionContinuityKernel,
  executionPacketToStaticBlocks,
  executionTreeToStaticBlocks,
  mergeExecutionPacketStaticBlocks,
  resolveExecutionKernelContext,
} from "../../src/kernel/execution-continuity-kernel.ts";

const now = "2026-05-18T00:00:00.000Z";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-execution-state-"));
  return path.join(dir, `${name}.sqlite`);
}

function sampleState(): ExecutionStateV1 {
  return {
    version: 1,
    state_id: "state-focused-continuity",
    scope: "focused-scope",
    task_brief: "Extract continuity kernel",
    current_stage: "patch",
    active_role: "patch",
    owned_files: ["src/kernel/execution-continuity-kernel.ts"],
    modified_files: ["src/routes/memory-context-runtime.ts"],
    pending_validations: ["npm run -s test:focused"],
    completed_validations: ["npm run -s build"],
    last_accepted_hypothesis: "route-owned continuity can move behind a pure kernel",
    rejected_paths: ["rewrite all context routes at once"],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: {
      standard: "focused kernel boundary",
      required_outputs: ["green focused tests"],
      acceptance_checks: ["continuity context remains stable"],
      rollback_required: false,
    },
    resume_anchor: {
      anchor: "Task 2 compact extraction",
      file_path: "src/kernel/execution-continuity-kernel.ts",
      symbol: "executionContinuityKernel",
      repo_root: "/Volumes/ziel/AionisRuntime-focused",
    },
    updated_at: now,
  };
}

function treeOp(input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-focused-continuity",
    scope: "focused-scope",
    actor_role: "patch",
    ...input,
  } as ExecutionTreeOperationV1;
}

function sampleExecutionTree() {
  let tree = createExecutionTreeV1({
    tree_id: "tree-focused-continuity",
    scope: "focused-scope",
    task_brief: "Keep execution context branch-aware",
    at: now,
  });
  for (const operation of [
    treeOp({
      operation_id: "grow-1",
      type: "grow",
      at: "2026-05-18T00:01:00.000Z",
      action: "inspect focused kernel files",
      observation: "identified the continuity boundary",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    treeOp({
      operation_id: "compress-1",
      type: "compress",
      at: "2026-05-18T00:02:00.000Z",
      title: "inspection boundary",
      summary: "Continuity boundary is identified and preserved.",
    }),
    treeOp({
      operation_id: "grow-bad",
      type: "grow",
      at: "2026-05-18T00:03:00.000Z",
      action: "rewrite unrelated runtime surfaces",
      observation: "review rejected the broad path",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    treeOp({
      operation_id: "compress-bad",
      type: "compress",
      at: "2026-05-18T00:04:00.000Z",
      title: "broad attempt",
      summary: "Broad rewrite attempted and rejected.",
    }),
    treeOp({
      operation_id: "maintain-bad",
      type: "maintain",
      at: "2026-05-18T00:05:00.000Z",
      passed: false,
      target_summary_node_id: "summary:4",
      diagnostic_note: "broad attempt is not part of the accepted execution path",
    }),
    treeOp({
      operation_id: "revise-bad",
      type: "revise",
      at: "2026-05-18T00:06:00.000Z",
      target_summary_node_id: "summary:4",
      diagnostic_note: "restore to focused boundary",
    }),
  ] as ExecutionTreeOperationV1[]) {
    tree = applyExecutionTreeOperationV1(tree, operation);
  }
  return tree;
}

test("execution continuity kernel recovers state-first packet context", () => {
  const state = sampleState();
  const recovered = resolveExecutionKernelContext({ execution_state_v1: state });

  assert.equal(recovered.source_mode, "state_first");
  assert.equal(recovered.state_first_assembly, true);
  assert.equal(recovered.packet?.state_id, state.state_id);
  assert.equal(recovered.packet?.next_action, "Complete pending validations: npm run -s test:focused");
  assert.deepEqual(recovered.packet?.target_files, ["src/kernel/execution-continuity-kernel.ts"]);
});

test("execution continuity kernel builds always-included static context from packet and side outputs", () => {
  const packet = resolveExecutionKernelContext({ execution_state_v1: sampleState() }).packet;
  assert.ok(packet);

  const packetBlocks = executionPacketToStaticBlocks(packet);
  assert.ok(packetBlocks.some((block) => block.title === "Execution Brief" && block.content.includes("current_stage=patch")));
  assert.ok(packetBlocks.every((block) => block.always_include));

  const merged = mergeExecutionPacketStaticBlocks({
    execution_packet_v1: packet,
    execution_result_summary: { status: "passed", command: "npm run -s build" },
    execution_artifacts: [{ ref: "plan", uri: "docs/plans/2026-05-18-kernel-convergence.md" }],
    execution_evidence: [{ claim: "focused tests passed", kind: "test" }],
    static_context_blocks: [{
      id: "caller-context",
      title: "Caller Context",
      content: "preserved",
      tags: [],
      intents: [],
      priority: 1,
      always_include: false,
    }],
  });

  assert.equal(merged[0]?.title, "Execution Brief");
  assert.ok(merged.some((block) => block.id === "execution-side-outputs"));
  assert.equal(merged.at(-1)?.id, "caller-context");
});

test("execution continuity kernel includes branch-aware execution tree context", () => {
  const tree = sampleExecutionTree();
  const treeBlocks = executionTreeToStaticBlocks(tree);

  const compressed = treeBlocks.find((block) => block.title === "Execution Compressed State");
  const hints = treeBlocks.find((block) => block.title === "Execution Branch Hints");
  assert.equal(compressed?.always_include, true);
  assert.ok(compressed?.tags.includes("continuation"));
  assert.ok(compressed?.content.includes("branch_role=current_compressed_path; use_for_next_action=true"));
  assert.ok(compressed?.content.includes("Continuity boundary is identified and preserved."));
  assert.ok(!compressed?.content.includes("Broad rewrite attempted and rejected."));
  assert.equal(hints?.always_include, false);
  assert.ok((hints?.priority ?? 100) < (compressed?.priority ?? 0));
  assert.ok(hints?.tags.includes("failed-branch"));
  assert.ok(hints?.intents.includes("avoid"));
  assert.ok(hints?.content.includes("branch_role=failed_or_alternate_branch; use_for_next_action=false"));
  assert.ok(hints?.content.includes("avoid_branch=true"));
  assert.ok(hints?.content.includes("Broad rewrite attempted and rejected."));
  assert.ok(hints?.content.includes("restore to focused boundary"));

  const merged = mergeExecutionPacketStaticBlocks({
    execution_state_v1: sampleState(),
    execution_tree_v1: tree,
  });
  assert.ok(merged.some((block) => block.title === "Execution Compressed State"));
  assert.ok(merged.some((block) => block.title === "Execution Branch Hints"));
});

test("execution continuity kernel injects side outputs into context without overwriting caller values", () => {
  const context = buildExecutionContinuityContext({
    context: {
      execution_result_summary: { status: "caller-owned" },
    },
    execution_result_summary: { status: "kernel-owned" },
    execution_artifacts: [{ ref: "artifact-a" }],
    execution_evidence: [{ claim: "evidence-a" }],
  });

  assert.deepEqual(context.execution_result_summary, { status: "caller-owned" });
  assert.deepEqual(context.execution_artifacts, [{ ref: "artifact-a" }]);
  assert.deepEqual(context.execution_evidence, [{ claim: "evidence-a" }]);
});

test("execution continuity kernel persists handoff transitions across reopened Lite SQLite stores", async () => {
  const dbPath = tmpDbPath("continuity");
  const store = createLiteExecutionStateStore(dbPath);
  const state = sampleState();
  try {
    const applied = applyExecutionContinuityTransitionsFromSlots({
      executionStateStore: store,
      writeSlots: {
        execution_state_v1: state,
        execution_transitions_v1: [{
          transition_id: "validation-completed-1",
          state_id: state.state_id,
          scope: state.scope,
          actor_role: "patch",
          at: "2026-05-18T00:01:00.000Z",
          type: "validation_completed",
          validations: ["npm run -s test:focused"],
        }],
      },
    });

    assert.equal(applied?.[0]?.expected_revision, 1);
    const stored = store.get(state.scope, state.state_id);
    assert.equal(stored?.revision, 2);
    assert.deepEqual(stored?.state.pending_validations, []);
    assert.ok(stored?.state.completed_validations.includes("npm run -s test:focused"));
  } finally {
    await store.close();
  }

  const reopened = createLiteExecutionStateStore(dbPath);
  try {
    const recovered = reopened.get(state.scope, state.state_id);
    assert.equal(recovered?.revision, 2);
    assert.deepEqual(recovered?.state.pending_validations, []);
    assert.ok(recovered?.state.completed_validations.includes("npm run -s test:focused"));
    assert.equal(recovered?.last_transition_type, "validation_completed");
  } finally {
    await reopened.close();
  }
});

test("execution continuity kernel persists execution tree operations from write slots", async () => {
  const dbPath = tmpDbPath("continuity-tree");
  const store = createLiteExecutionTreeStore(dbPath);
  const tree = createExecutionTreeV1({
    tree_id: "tree-focused-continuity",
    scope: "focused-scope",
    task_brief: "Persist branch-aware continuity through write slots",
    at: now,
  });
  try {
    const applied = applyExecutionTreeOperationsFromSlots({
      executionTreeStore: store,
      writeSlots: {
        execution_tree_v1: tree,
        execution_tree_operations_v1: [
          treeOp({
            operation_id: "grow-slot-1",
            type: "grow",
            at: "2026-05-18T00:01:00.000Z",
            action: "inspect execution tree slot",
            observation: "tree operation persisted through the kernel helper",
            title: null,
            tool_name: "bash",
            refs: [],
          }),
        ],
      },
    });

    assert.equal(applied?.length, 1);
    const stored = store.get(tree.scope, tree.tree_id);
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.last_operation_type, "grow");
    assert.equal(stored?.tree.nodes[stored.tree.current_raw_node_id]?.content.action, "inspect execution tree slot");
  } finally {
    await store.close();
  }
});

test("execution continuity kernel facade exposes the extracted route decisions", () => {
  const state = sampleState();
  assert.equal(executionContinuityKernel.recoverExecutionState({ execution_state_v1: state }).source_mode, "state_first");
  assert.ok(executionContinuityKernel.buildNextActionPacket({ execution_state_v1: state }).length > 0);
  assert.deepEqual(
    executionContinuityKernel.assembleContinuityContext({ execution_result_summary: { ok: true } }).execution_result_summary,
    { ok: true },
  );
});
