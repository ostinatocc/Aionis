import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createExecutionTreeV1,
  createLiteExecutionTreeStore,
  deriveExecutionTreeStateV1,
  applyExecutionTreeOperationV1,
  applyAutoExecutionTreeFromSlots,
  type ExecutionTreeOperationV1,
  type ExecutionStateV1,
} from "../../src/execution/index.ts";

const baseAt = "2026-06-08T00:00:00.000Z";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-execution-tree-"));
  return path.join(dir, `${name}.sqlite`);
}

function op(input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-long-task",
    scope: "focused-scope",
    actor_role: "orchestrator",
    ...input,
  } as ExecutionTreeOperationV1;
}

function buildTreeWithFailedBranch() {
  let tree = createExecutionTreeV1({
    tree_id: "tree-long-task",
    scope: "focused-scope",
    task_brief: "Complete a long-horizon workflow with repairable branches",
    at: baseAt,
  });
  const operations: ExecutionTreeOperationV1[] = [
    op({
      operation_id: "grow-1",
      type: "grow",
      at: "2026-06-08T00:01:00.000Z",
      action: "inspect target files",
      observation: "found the narrow implementation surface",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    op({
      operation_id: "compress-1",
      type: "compress",
      at: "2026-06-08T00:02:00.000Z",
      title: "inspection complete",
      summary: "Target surface is identified and unrelated files are out of scope.",
    }),
    op({
      operation_id: "maintain-1",
      type: "maintain",
      at: "2026-06-08T00:03:00.000Z",
      passed: true,
      target_summary_node_id: "summary:2",
      diagnostic_note: null,
    }),
    op({
      operation_id: "grow-bad",
      type: "grow",
      at: "2026-06-08T00:04:00.000Z",
      action: "patch broad subsystem",
      observation: "validation failed because the patch crossed the intended boundary",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    op({
      operation_id: "compress-bad",
      type: "compress",
      at: "2026-06-08T00:05:00.000Z",
      title: "bad patch attempt",
      summary: "Broad patch attempted and failed validation.",
    }),
    op({
      operation_id: "maintain-bad",
      type: "maintain",
      at: "2026-06-08T00:06:00.000Z",
      passed: false,
      target_summary_node_id: "summary:4",
      diagnostic_note: "broad patch crossed the accepted boundary",
    }),
    op({
      operation_id: "revise-bad",
      type: "revise",
      at: "2026-06-08T00:07:00.000Z",
      target_summary_node_id: "summary:4",
      diagnostic_note: "restore to inspection boundary and branch narrowly",
    }),
    op({
      operation_id: "grow-repair",
      type: "grow",
      at: "2026-06-08T00:08:00.000Z",
      action: "patch narrow target",
      observation: "targeted validation passed",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    op({
      operation_id: "compress-repair",
      type: "compress",
      at: "2026-06-08T00:09:00.000Z",
      title: "repair complete",
      summary: "Narrow branch repaired the issue and passed targeted validation.",
    }),
  ];
  for (const operation of operations) {
    tree = applyExecutionTreeOperationV1(tree, operation);
  }
  return { tree, operations };
}

function sampleExecutionState(input: {
  stateId: string;
  updatedAt: string;
  completedValidations?: string[];
  pendingValidations?: string[];
  unresolvedBlockers?: string[];
}): ExecutionStateV1 {
  return {
    version: 1,
    state_id: input.stateId,
    scope: "focused-scope",
    task_brief: "Persist branch-aware execution progress",
    current_stage: "patch",
    active_role: "patch",
    owned_files: ["src/execution/tree-auto.ts"],
    modified_files: ["src/execution/tree-auto.ts"],
    pending_validations: input.pendingValidations ?? [],
    completed_validations: input.completedValidations ?? [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: input.unresolvedBlockers ?? [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: input.updatedAt,
  };
}

test("execution tree derives active state from the repaired branch and isolates failed branch hints", () => {
  const { tree } = buildTreeWithFailedBranch();
  const state = deriveExecutionTreeStateV1(tree);

  assert.deepEqual(
    state.compressed_state.map((entry) => entry.summary),
    [
      "Target surface is identified and unrelated files are out of scope.",
      "Narrow branch repaired the issue and passed targeted validation.",
    ],
  );
  assert.equal(state.raw_state.length, 0);
  assert.ok(state.execution_hints.some((entry) =>
    entry.status === "failed"
    && entry.summary === "Broad patch attempted and failed validation."
    && entry.diagnostic_note === "restore to inspection boundary and branch narrowly"
  ));
  assert.ok(!state.compressed_state.some((entry) => entry.summary === "Broad patch attempted and failed validation."));
});

test("execution tree auto operation helper creates and advances a tree from execution slots idempotently", async () => {
  const dbPath = tmpDbPath("auto-passed");
  const store = createLiteExecutionTreeStore(dbPath);
  const state = sampleExecutionState({
    stateId: "state:auto-passed",
    updatedAt: "2026-06-08T00:10:00.000Z",
    completedValidations: ["npm run -s typecheck"],
  });
  try {
    const first = applyAutoExecutionTreeFromSlots({
      executionTreeStore: store,
      slots: {
        execution_state_v1: state,
        execution_result_summary: {
          status: "passed",
          summary: "Typecheck passed after the focused runtime change.",
        },
      },
      title: "Auto execution tree",
      textSummary: "Advance execution tree automatically",
    });
    assert.equal(first?.operations.length, 3);
    assert.equal(store.get("focused-scope", "execution-tree:state:auto-passed")?.revision, 4);
    assert.ok(
      deriveExecutionTreeStateV1(first!.tree).compressed_state[0]?.summary?.includes("Typecheck passed after the focused runtime change."),
    );
    assert.ok(
      deriveExecutionTreeStateV1(first!.tree).compressed_state[0]?.summary?.includes("Advance execution tree automatically"),
    );

    const duplicate = applyAutoExecutionTreeFromSlots({
      executionTreeStore: store,
      slots: {
        execution_state_v1: state,
        execution_result_summary: {
          status: "passed",
          summary: "Typecheck passed after the focused runtime change.",
        },
      },
      title: "Auto execution tree",
      textSummary: "Advance execution tree automatically",
    });
    assert.equal(duplicate?.operations.length, 3);
    assert.equal(store.get("focused-scope", "execution-tree:state:auto-passed")?.revision, 4);
  } finally {
    await store.close();
  }
});

test("execution tree auto compression preserves actionable solution content before verifier wording", async () => {
  const dbPath = tmpDbPath("auto-actionable-summary");
  const store = createLiteExecutionTreeStore(dbPath);
  const state = sampleExecutionState({
    stateId: "state:auto-actionable-summary",
    updatedAt: "2026-06-08T00:12:00.000Z",
    completedValidations: ["judge accepted answer"],
  });
  try {
    const result = applyAutoExecutionTreeFromSlots({
      executionTreeStore: store,
      slots: {
        execution_state_v1: state,
        next_action: "Fallback action should not replace explicit solution.",
        handoff_text: "Fallback handoff should not replace explicit solution.",
        execution_result_summary: {
          status: "passed",
          summary: "Verifier passed the latest answer.",
          solution_summary: "REUSABLE_SOLUTION_MARKER use theorem B with boundary condition C.",
        },
      },
      title: "Actionable auto execution tree",
      textSummary: "Fallback text summary should not replace explicit solution.",
    });
    assert.equal(result?.operations.length, 3);
    const compressedSummary = deriveExecutionTreeStateV1(result!.tree).compressed_state[0]?.summary ?? "";
    assert.match(compressedSummary, /^REUSABLE_SOLUTION_MARKER use theorem B/);
    assert.match(compressedSummary, /Verifier passed the latest answer/);
    assert.doesNotMatch(compressedSummary, /^Fallback/);
  } finally {
    await store.close();
  }
});

test("execution tree auto operation helper revises failed execution result branches", async () => {
  const dbPath = tmpDbPath("auto-failed");
  const store = createLiteExecutionTreeStore(dbPath);
  const state = sampleExecutionState({
    stateId: "state:auto-failed",
    updatedAt: "2026-06-08T00:11:00.000Z",
    pendingValidations: ["npm run -s lite:test"],
    unresolvedBlockers: ["runtime validation failed"],
  });
  try {
    const result = applyAutoExecutionTreeFromSlots({
      executionTreeStore: store,
      slots: {
        execution_state_v1: state,
        execution_result_summary: {
          status: "failed",
          summary: "Runtime validation failed and needs a new branch.",
        },
      },
      title: "Failed auto execution tree",
      textSummary: "Capture failed branch",
    });
    assert.equal(result?.operations.length, 4);
    const treeState = deriveExecutionTreeStateV1(result!.tree);
    assert.equal(treeState.compressed_state.length, 0);
    assert.ok(treeState.execution_hints.some((entry) =>
      entry.status === "failed"
      && entry.summary?.includes("Runtime validation failed and needs a new branch.")
    ));
    assert.equal(result!.tree.current_summary_node_id, result!.tree.root_summary_node_id);
  } finally {
    await store.close();
  }
});

test("execution tree auto operation helper uses evidence-only outcome classification", async () => {
  const dbPath = tmpDbPath("auto-evidence-only-failed");
  const store = createLiteExecutionTreeStore(dbPath);
  const state = sampleExecutionState({
    stateId: "state:auto-evidence-only-failed",
    updatedAt: "2026-06-08T00:12:30.000Z",
    completedValidations: ["clean shell replay"],
  });
  try {
    const result = applyAutoExecutionTreeFromSlots({
      executionTreeStore: store,
      slots: {
        execution_state_v1: state,
        execution_evidence: [
          {
            ref: "trace://auto-evidence-only-failed/verifier",
            status: "failed",
            summary: "Evidence-only replay failed validation.",
          },
        ],
      },
      title: "Evidence-only failed auto execution tree",
      textSummary: "Capture evidence-only failed branch",
    });
    assert.equal(result?.operations.length, 4);
    assert.equal(result!.operations.some((operation) => operation.type === "maintain" && operation.passed === false), true);
    assert.equal(result!.operations.some((operation) => operation.type === "revise"), true);
    assert.equal(result!.tree.current_summary_node_id, result!.tree.root_summary_node_id);
  } finally {
    await store.close();
  }
});

test("execution tree auto operation helper treats conflict summaries as failed branches", async () => {
  const dbPath = tmpDbPath("auto-conflict");
  const store = createLiteExecutionTreeStore(dbPath);
  const state = sampleExecutionState({
    stateId: "state:auto-conflict",
    updatedAt: "2026-06-08T00:13:00.000Z",
    completedValidations: ["verifier reported conflict"],
  });
  try {
    const result = applyAutoExecutionTreeFromSlots({
      executionTreeStore: store,
      slots: {
        execution_state_v1: state,
        execution_result_summary: {
          status: "passed",
          summary: "Verifier reported a conflict with the canonical branch.",
        },
      },
      title: "Conflict auto execution tree",
      textSummary: "Capture conflict branch",
    });
    assert.equal(result?.operations.length, 4);
    assert.equal(result!.operations.some((operation) => operation.type === "maintain" && operation.passed === false), true);
    assert.equal(result!.operations.some((operation) => operation.type === "revise"), true);
    assert.equal(result!.tree.current_summary_node_id, result!.tree.root_summary_node_id);
  } finally {
    await store.close();
  }
});

test("execution tree auto operation helper does not treat negated failure text as a failed outcome", async () => {
  const dbPath = tmpDbPath("auto-negated-failure");
  const store = createLiteExecutionTreeStore(dbPath);
  const cases = [
    { status: "not failed", expectedPassedMaintain: false },
    { status: "no failure detected", expectedPassedMaintain: false },
    { status: "without errors", expectedPassedMaintain: false },
    { status: "failure not observed", expectedPassedMaintain: false },
    { status: "no failure, completed successfully", expectedPassedMaintain: true },
    { status: "completed with no errors", expectedPassedMaintain: true },
    { status: "success without failure", expectedPassedMaintain: true },
    { status: "not failed; accepted", expectedPassedMaintain: true },
    { status: "no failures found; passed", expectedPassedMaintain: true },
    { status: "not successful", expectedPassedMaintain: false },
  ];
  try {
    for (const [index, item] of cases.entries()) {
      const state = sampleExecutionState({
        stateId: `state:auto-negated-failure-${index}`,
        updatedAt: `2026-06-08T00:${20 + index}:00.000Z`,
        pendingValidations: ["npm run -s lite:test"],
      });
      const result = applyAutoExecutionTreeFromSlots({
        executionTreeStore: store,
        slots: {
          execution_state_v1: state,
          execution_result_summary: {
            status: item.status,
            summary: `Validation status reported as ${item.status}.`,
          },
        },
        title: "Negated failure auto execution tree",
        textSummary: "Capture ambiguous non-failure wording",
      });
      assert.equal(result?.operations.length, item.expectedPassedMaintain ? 3 : 2);
      assert.ok(!result!.operations.some((operation) => operation.type === "revise"));
      assert.equal(result!.operations.some((operation) => operation.type === "maintain" && operation.passed === false), false);
      assert.equal(
        result!.operations.some((operation) => operation.type === "maintain" && operation.passed === true),
        item.expectedPassedMaintain,
      );
      const treeState = deriveExecutionTreeStateV1(result!.tree);
      assert.equal(treeState.execution_hints.filter((entry) => entry.status === "failed").length, 0);
      assert.equal(result!.tree.current_summary_node_id, "summary:2");
    }
  } finally {
    await store.close();
  }
});

test("execution tree store persists operation-applied trees and keeps operation ids idempotent", async () => {
  const dbPath = tmpDbPath("tree");
  const store = createLiteExecutionTreeStore(dbPath);
  const initial = createExecutionTreeV1({
    tree_id: "tree-long-task",
    scope: "focused-scope",
    task_brief: "Persist a branch-aware execution tree",
    at: baseAt,
  });
  try {
    store.put(initial);
    const first = store.applyOperation(op({
      operation_id: "grow-1",
      expected_revision: 1,
      type: "grow",
      at: "2026-06-08T00:01:00.000Z",
      action: "inspect target files",
      observation: "found the narrow implementation surface",
      title: null,
      tool_name: "bash",
      refs: [],
    }));
    assert.equal(first.revision, 2);

    const idempotent = store.applyOperation(op({
      operation_id: "grow-1",
      expected_revision: 1,
      type: "grow",
      at: "2026-06-08T00:02:00.000Z",
      action: "inspect target files",
      observation: "found the narrow implementation surface",
      title: null,
      tool_name: "bash",
      refs: [],
    }));
    assert.equal(idempotent.revision, 2);
  } finally {
    await store.close();
  }

  const reopened = createLiteExecutionTreeStore(dbPath);
  try {
    const recovered = reopened.get("focused-scope", "tree-long-task");
    assert.equal(recovered?.revision, 2);
    assert.equal(recovered?.last_operation_type, "grow");
    assert.equal(deriveExecutionTreeStateV1(recovered!.tree).raw_state[0]?.action, "inspect target files");
  } finally {
    await reopened.close();
  }
});

test("execution tree store rejects operation id reuse with a different intent", async () => {
  const dbPath = tmpDbPath("tree-operation-conflict");
  const store = createLiteExecutionTreeStore(dbPath);
  const initial = createExecutionTreeV1({
    tree_id: "tree-long-task",
    scope: "focused-scope",
    task_brief: "Protect execution tree operation idempotency",
    at: baseAt,
  });
  try {
    store.put(initial);
    store.applyOperation(op({
      operation_id: "grow-conflict",
      expected_revision: 1,
      type: "grow",
      at: "2026-06-08T00:01:00.000Z",
      action: "inspect target files",
      observation: "found the narrow implementation surface",
      title: null,
      tool_name: "bash",
      refs: [],
    }));

    assert.throws(
      () => store.applyOperation(op({
        operation_id: "grow-conflict",
        expected_revision: 2,
        type: "grow",
        at: "2026-06-08T00:02:00.000Z",
        action: "patch a different subsystem",
        observation: "this is not the same operation intent",
        title: null,
        tool_name: "bash",
        refs: [],
      })),
      /execution tree operation id conflict/,
    );
    assert.equal(store.get("focused-scope", "tree-long-task")?.revision, 2);
  } finally {
    await store.close();
  }
});

test("execution tree store keeps identical tree ids isolated by scope", async () => {
  const dbPath = tmpDbPath("tree-scope-isolation");
  const store = createLiteExecutionTreeStore(dbPath);
  const treeId = "tree-shared-id";
  const scopeA = "scope-a";
  const scopeB = "scope-b";
  const treeA = createExecutionTreeV1({
    tree_id: treeId,
    scope: scopeA,
    task_brief: "Scope A execution tree",
    at: baseAt,
  });
  const treeB = createExecutionTreeV1({
    tree_id: treeId,
    scope: scopeB,
    task_brief: "Scope B execution tree",
    at: baseAt,
  });
  try {
    store.put(treeA);
    store.put(treeB);
    store.applyOperation({
      tree_id: treeId,
      scope: scopeA,
      actor_role: "orchestrator",
      operation_id: "shared-grow",
      expected_revision: 1,
      type: "grow",
      at: "2026-06-08T00:01:00.000Z",
      action: "advance only scope A",
      observation: "scope A operation should not touch scope B",
      title: null,
      tool_name: "bash",
      refs: [],
    });

    const storedA = store.get(scopeA, treeId);
    const storedB = store.get(scopeB, treeId);
    assert.equal(storedA?.revision, 2);
    assert.equal(storedB?.revision, 1);
    assert.equal(storedA?.tree.current_raw_node_id, "raw:1");
    assert.equal(storedB?.tree.current_raw_node_id, storedB?.tree.root_raw_node_id);
    assert.equal(store.hasOperation(scopeA, treeId, "shared-grow"), true);
    assert.equal(store.hasOperation(scopeB, treeId, "shared-grow"), false);
    assert.equal(store.listByScope(scopeA).length, 1);
    assert.equal(store.listByScope(scopeB).length, 1);
  } finally {
    await store.close();
  }
});
