import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  createLiteExecutionStateStore,
  createLiteExecutionStateStoreFromDatabase,
} from "../../src/execution/state-store.ts";
import {
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
} from "../../src/execution/tree.ts";
import {
  createLiteExecutionTreeStore,
  createLiteExecutionTreeStoreFromDatabase,
} from "../../src/execution/tree-store.ts";
import type { ExecutionStateTransitionV1 } from "../../src/execution/transitions.ts";
import type { ExecutionStateV1 } from "../../src/execution/types.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import {
  createLiteRuntimeDatabase,
  createLiteRuntimeReadDatabase,
} from "../../src/store/lite-runtime-database.ts";
import { HttpError } from "../../src/util/http.ts";

const baseAt = "2026-07-12T00:00:00.000Z";

function tempDbPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "aionis-execution-cas-")), `${name}.sqlite`);
}

function state(stateId = "state-cas"): ExecutionStateV1 {
  return {
    version: 1,
    state_id: stateId,
    scope: "execution-cas-scope",
    task_brief: "Protect execution continuity with compare-and-set revisions",
    current_stage: "patch",
    active_role: "patch",
    owned_files: ["src/execution/state-store.ts"],
    modified_files: [],
    pending_validations: ["npm run -s typecheck"],
    completed_validations: [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: baseAt,
  };
}

function transition(args: {
  state: ExecutionStateV1;
  id: string;
  validation: string;
  expectedRevision?: number;
  at?: string;
}): ExecutionStateTransitionV1 {
  return {
    transition_id: args.id,
    state_id: args.state.state_id,
    scope: args.state.scope,
    actor_role: "patch",
    at: args.at ?? "2026-07-12T00:01:00.000Z",
    ...(args.expectedRevision == null ? {} : { expected_revision: args.expectedRevision }),
    type: "validation_completed",
    validations: [args.validation],
  };
}

function growOperation(args: {
  treeId: string;
  id: string;
  action: string;
  expectedRevision?: number;
  at?: string;
}): ExecutionTreeOperationV1 {
  return {
    operation_id: args.id,
    tree_id: args.treeId,
    scope: "execution-cas-scope",
    actor_role: "patch",
    at: args.at ?? "2026-07-12T00:01:00.000Z",
    ...(args.expectedRevision == null ? {} : { expected_revision: args.expectedRevision }),
    type: "grow",
    action: args.action,
    observation: `${args.action} completed`,
    title: null,
    tool_name: "test-runtime",
    refs: [],
  };
}

async function seedStateHistory(name: string) {
  const dbPath = tempDbPath(name);
  const initial = state(name);
  const store = createLiteExecutionStateStore(dbPath);
  try {
    store.initialize(initial);
    store.applyTransition(transition({
      state: initial,
      id: `${name}-transition-2`,
      validation: `${name}-validation-2`,
      expectedRevision: 1,
    }));
    store.applyTransition(transition({
      state: initial,
      id: `${name}-transition-3`,
      validation: `${name}-validation-3`,
      expectedRevision: 2,
      at: "2026-07-12T00:02:00.000Z",
    }));
  } finally {
    await store.close();
  }
  return { dbPath, initial };
}

async function seedTreeHistory(name: string) {
  const dbPath = tempDbPath(name);
  const initial = createExecutionTreeV1({
    tree_id: name,
    scope: "execution-cas-scope",
    task_brief: `Audit ${name} execution tree history`,
    at: baseAt,
  });
  const store = createLiteExecutionTreeStore(dbPath);
  try {
    store.initialize(initial);
    store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: `${name}-operation-2`,
      action: `${name} action 2`,
      expectedRevision: 1,
    }));
    store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: `${name}-operation-3`,
      action: `${name} action 3`,
      expectedRevision: 2,
      at: "2026-07-12T00:02:00.000Z",
    }));
  } finally {
    await store.close();
  }
  return { dbPath, initial };
}

function assertHttpConflict(error: unknown, code: string): boolean {
  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, code);
  return true;
}

function assertHistoryCorrupt(
  error: unknown,
  resourceKind: "execution_state" | "execution_tree",
  violationKind: string,
): boolean {
  assert.ok(error instanceof HttpError);
  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "execution_history_corrupt");
  assert.doesNotMatch(error.message, /unique constraint/i);
  const details = error.details as {
    contract?: string;
    resource_kind?: string;
    violations?: Array<{ kind?: string }>;
  };
  assert.equal(details.contract, "execution_history_integrity_v1");
  assert.equal(details.resource_kind, resourceKind);
  assert.ok(details.violations?.some((violation) => violation.kind === violationKind));
  return true;
}

type DeferredSignal = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function inspectSuspendedTransaction(args: {
  transaction: Promise<void>;
  entered: DeferredSignal;
  release: DeferredSignal;
  inspect: () => void;
  expectedRejection?: RegExp;
}): Promise<void> {
  await args.entered.promise;
  let inspectionError: unknown;
  try {
    args.inspect();
  } catch (error) {
    inspectionError = error;
  }
  const settled = args.expectedRejection
    ? assert.rejects(args.transaction, args.expectedRejection)
    : args.transaction;
  args.release.resolve();
  await settled;
  if (inspectionError) throw inspectionError;
}

test("Lite Runtime rejects :memory: because committed reads require a shared file-backed database", () => {
  assert.throws(
    () => createLiteRuntimeDatabase(":memory:"),
    /file-backed path.*cannot share committed state/i,
  );
  assert.throws(
    () => createLiteRuntimeReadDatabase(":memory:"),
    /file-backed path.*cannot share committed state/i,
  );
});

test("execution state initialization is create-only and stale snapshots cannot replace a newer revision", async () => {
  const dbPath = tempDbPath("state-stale");
  const store = createLiteExecutionStateStore(dbPath);
  const initial = state();
  try {
    assert.equal(store.initialize(initial).revision, 1);
    assert.equal(store.put(initial).revision, 1);

    assert.throws(
      () => store.applyTransition(transition({
        state: initial,
        id: "missing-revision",
        validation: "npm run -s typecheck",
      })),
      (error) => assertHttpConflict(error, "execution_state_expected_revision_required"),
    );

    const applied = store.applyTransition(transition({
      state: initial,
      id: "complete-typecheck",
      validation: "npm run -s typecheck",
      expectedRevision: 1,
    }));
    assert.equal(applied.revision, 2);
    assert.deepEqual(applied.state.completed_validations, ["npm run -s typecheck"]);

    assert.throws(
      () => store.put(initial),
      (error) => assertHttpConflict(error, "execution_state_snapshot_conflict"),
    );
    assert.equal(store.get(initial.scope, initial.state_id)?.revision, 2);
    assert.deepEqual(store.get(initial.scope, initial.state_id)?.state.completed_validations, ["npm run -s typecheck"]);

    const replayed = store.applyTransition(transition({
      state: initial,
      id: "complete-typecheck",
      validation: "npm run -s typecheck",
      expectedRevision: 1,
      at: "2026-07-12T00:09:00.000Z",
    }));
    assert.equal(replayed.revision, 2);

    assert.throws(
      () => store.applyTransition(transition({
        state: initial,
        id: "complete-typecheck",
        validation: "npm run -s test:focused",
        expectedRevision: 2,
      })),
      (error) => assertHttpConflict(error, "execution_transition_id_conflict"),
    );
    assert.throws(
      () => store.applyTransition(transition({
        state: initial,
        id: "stale-transition",
        validation: "npm run -s test:focused",
        expectedRevision: 1,
      })),
      (error) => assertHttpConflict(error, "execution_state_revision_conflict"),
    );
    assert.equal(store.get(initial.scope, initial.state_id)?.revision, 2);
  } finally {
    await store.close();
  }
});

test("execution tree initialization is create-only and operation ids remain intent-idempotent", async () => {
  const dbPath = tempDbPath("tree-stale");
  const store = createLiteExecutionTreeStore(dbPath);
  const initial = createExecutionTreeV1({
    tree_id: "tree-cas",
    scope: "execution-cas-scope",
    task_brief: "Protect an execution tree from stale replacement",
    at: baseAt,
  });
  try {
    assert.equal(store.initialize(initial).revision, 1);
    assert.equal(store.put(initial).revision, 1);

    assert.throws(
      () => store.applyOperation(growOperation({
        treeId: initial.tree_id,
        id: "missing-revision",
        action: "attempt without a revision",
      })),
      (error) => assertHttpConflict(error, "execution_tree_expected_revision_required"),
    );

    const applied = store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "grow-cas",
      action: "advance the guarded branch",
      expectedRevision: 1,
    }));
    assert.equal(applied.revision, 2);
    assert.equal(applied.tree.current_raw_node_id, "raw:1");

    assert.throws(
      () => store.put(initial),
      (error) => assertHttpConflict(error, "execution_tree_snapshot_conflict"),
    );
    assert.equal(store.get(initial.scope, initial.tree_id)?.tree.current_raw_node_id, "raw:1");

    const replayed = store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "grow-cas",
      action: "advance the guarded branch",
      expectedRevision: 1,
      at: "2026-07-12T00:09:00.000Z",
    }));
    assert.equal(replayed.revision, 2);

    assert.throws(
      () => store.applyOperation(growOperation({
        treeId: initial.tree_id,
        id: "grow-cas",
        action: "reuse the id for another branch",
        expectedRevision: 2,
      })),
      (error) => assertHttpConflict(error, "execution_operation_id_conflict"),
    );
    assert.throws(
      () => store.applyOperation(growOperation({
        treeId: initial.tree_id,
        id: "stale-operation",
        action: "advance from a stale revision",
        expectedRevision: 1,
      })),
      (error) => assertHttpConflict(error, "execution_tree_revision_conflict"),
    );
    assert.equal(store.get(initial.scope, initial.tree_id)?.revision, 2);
  } finally {
    await store.close();
  }
});

test("replaying an old transition id returns its historical after-state without rewinding the current projection", async () => {
  const dbPath = tempDbPath("state-historical-replay");
  const store = createLiteExecutionStateStore(dbPath);
  const initial = state("state-historical-replay");
  try {
    store.initialize(initial);
    const first = store.applyTransition(transition({
      state: initial,
      id: "historical-transition",
      validation: "npm run -s typecheck",
      expectedRevision: 1,
    }));
    assert.equal(first.revision, 2);

    const latest = store.applyTransition(transition({
      state: initial,
      id: "latest-transition",
      validation: "npm run -s test:focused",
      expectedRevision: 2,
      at: "2026-07-12T00:02:00.000Z",
    }));
    assert.equal(latest.revision, 3);

    const replayed = store.applyTransition(transition({
      state: initial,
      id: "historical-transition",
      validation: "npm run -s typecheck",
      expectedRevision: 1,
      at: "2026-07-12T00:09:00.000Z",
    }));
    assert.equal(replayed.revision, 2);
    assert.equal(replayed.last_transition_at, "2026-07-12T00:01:00.000Z");
    assert.deepEqual(replayed.state.completed_validations, ["npm run -s typecheck"]);

    const current = store.get(initial.scope, initial.state_id);
    assert.equal(current?.revision, 3);
    assert.deepEqual(current?.state.completed_validations, [
      "npm run -s typecheck",
      "npm run -s test:focused",
    ]);
  } finally {
    await store.close();
  }
});

test("replaying an old operation id returns its historical after-tree without rewinding the current projection", async () => {
  const dbPath = tempDbPath("tree-historical-replay");
  const store = createLiteExecutionTreeStore(dbPath);
  const initial = createExecutionTreeV1({
    tree_id: "tree-historical-replay",
    scope: "execution-cas-scope",
    task_brief: "Return the event-local tree when an old operation is retried",
    at: baseAt,
  });
  try {
    store.initialize(initial);
    const first = store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "historical-operation",
      action: "grow the historical branch",
      expectedRevision: 1,
    }));
    assert.equal(first.revision, 2);
    assert.equal(first.tree.current_raw_node_id, "raw:1");

    const latest = store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "latest-operation",
      action: "grow the latest branch",
      expectedRevision: 2,
      at: "2026-07-12T00:02:00.000Z",
    }));
    assert.equal(latest.revision, 3);
    assert.equal(latest.tree.current_raw_node_id, "raw:2");

    const replayed = store.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "historical-operation",
      action: "grow the historical branch",
      expectedRevision: 1,
      at: "2026-07-12T00:09:00.000Z",
    }));
    assert.equal(replayed.revision, 2);
    assert.equal(replayed.last_operation_at, "2026-07-12T00:01:00.000Z");
    assert.equal(replayed.tree.current_raw_node_id, "raw:1");

    const current = store.get(initial.scope, initial.tree_id);
    assert.equal(current?.revision, 3);
    assert.equal(current?.tree.current_raw_node_id, "raw:2");
  } finally {
    await store.close();
  }
});

test("state store rejects duplicate legacy revisions with a structured integrity error and leaves the history untouched", async () => {
  const dbPath = tempDbPath("state-duplicate-history");
  const initial = state("state-duplicate-history");
  const seed = createLiteExecutionStateStore(dbPath);
  try {
    seed.initialize(initial);
    seed.applyTransition(transition({
      state: initial,
      id: "original-transition",
      validation: "npm run -s typecheck",
      expectedRevision: 1,
    }));
  } finally {
    await seed.close();
  }

  const corrupt = createSqliteDatabase(dbPath);
  try {
    corrupt.exec("DROP INDEX idx_lite_execution_state_transitions_unique_revision");
    corrupt.prepare(`
      INSERT INTO lite_execution_state_transitions (
        scope,
        state_id,
        transition_id,
        revision,
        transition_type,
        transition_at,
        actor_role,
        expected_revision,
        transition_json,
        state_after_json,
        created_at
      )
      SELECT
        scope,
        state_id,
        ?,
        revision,
        transition_type,
        transition_at,
        actor_role,
        expected_revision,
        transition_json,
        state_after_json,
        created_at
      FROM lite_execution_state_transitions
      WHERE scope = ? AND state_id = ? AND transition_id = ?
    `).run("duplicate-transition", initial.scope, initial.state_id, "original-transition");
  } finally {
    corrupt.close();
  }

  assert.throws(
    () => createLiteExecutionStateStore(dbPath),
    (error) => assertHistoryCorrupt(error, "execution_state", "duplicate_revision"),
  );

  const inspected = createSqliteDatabase(dbPath);
  try {
    const events = inspected.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM lite_execution_state_transitions
      WHERE scope = ? AND state_id = ? AND revision = 2
    `).get(initial.scope, initial.state_id);
    assert.equal(Number(events.count), 2);
    const index = inspected.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_lite_execution_state_transitions_unique_revision'
    `).get();
    assert.equal(Number(index.count), 0);
  } finally {
    inspected.close();
  }
});

test("tree store rejects duplicate legacy revisions with a structured integrity error and leaves the history untouched", async () => {
  const dbPath = tempDbPath("tree-duplicate-history");
  const initial = createExecutionTreeV1({
    tree_id: "tree-duplicate-history",
    scope: "execution-cas-scope",
    task_brief: "Reject ambiguous legacy tree revisions",
    at: baseAt,
  });
  const seed = createLiteExecutionTreeStore(dbPath);
  try {
    seed.initialize(initial);
    seed.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "original-operation",
      action: "seed the original tree event",
      expectedRevision: 1,
    }));
  } finally {
    await seed.close();
  }

  const corrupt = createSqliteDatabase(dbPath);
  try {
    corrupt.exec("DROP INDEX idx_lite_execution_tree_operations_unique_revision");
    corrupt.prepare(`
      INSERT INTO lite_execution_tree_operations (
        scope,
        tree_id,
        operation_id,
        revision,
        operation_type,
        operation_at,
        actor_role,
        expected_revision,
        operation_json,
        tree_after_json,
        created_at
      )
      SELECT
        scope,
        tree_id,
        ?,
        revision,
        operation_type,
        operation_at,
        actor_role,
        expected_revision,
        operation_json,
        tree_after_json,
        created_at
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND operation_id = ?
    `).run("duplicate-operation", initial.scope, initial.tree_id, "original-operation");
  } finally {
    corrupt.close();
  }

  assert.throws(
    () => createLiteExecutionTreeStore(dbPath),
    (error) => assertHistoryCorrupt(error, "execution_tree", "duplicate_revision"),
  );

  const inspected = createSqliteDatabase(dbPath);
  try {
    const events = inspected.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND revision = 2
    `).get(initial.scope, initial.tree_id);
    assert.equal(Number(events.count), 2);
    const index = inspected.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_lite_execution_tree_operations_unique_revision'
    `).get();
    assert.equal(Number(index.count), 0);
  } finally {
    inspected.close();
  }
});

test("state store rejects a current projection that contradicts its latest event after-state without repairing it", async () => {
  const dbPath = tempDbPath("state-projection-mismatch");
  const initial = state("state-projection-mismatch");
  const seed = createLiteExecutionStateStore(dbPath);
  try {
    seed.initialize(initial);
    seed.applyTransition(transition({
      state: initial,
      id: "advance-state",
      validation: "npm run -s typecheck",
      expectedRevision: 1,
    }));
  } finally {
    await seed.close();
  }

  const corrupt = createSqliteDatabase(dbPath);
  try {
    corrupt.prepare(`
      UPDATE lite_execution_states
      SET state_json = ?
      WHERE scope = ? AND state_id = ?
    `).run(JSON.stringify(initial), initial.scope, initial.state_id);
  } finally {
    corrupt.close();
  }

  assert.throws(
    () => createLiteExecutionStateStore(dbPath),
    (error) => assertHistoryCorrupt(error, "execution_state", "projection_after_state_mismatch"),
  );

  const inspected = createSqliteDatabase(dbPath);
  try {
    const projection = inspected.prepare<{ state_json: string; revision: number }>(`
      SELECT state_json, revision
      FROM lite_execution_states
      WHERE scope = ? AND state_id = ?
    `).get(initial.scope, initial.state_id);
    const event = inspected.prepare<{ state_after_json: string }>(`
      SELECT state_after_json
      FROM lite_execution_state_transitions
      WHERE scope = ? AND state_id = ? AND revision = 2
    `).get(initial.scope, initial.state_id);
    assert.equal(Number(projection.revision), 2);
    assert.deepEqual(JSON.parse(projection.state_json).completed_validations, []);
    assert.deepEqual(JSON.parse(event.state_after_json).completed_validations, ["npm run -s typecheck"]);
  } finally {
    inspected.close();
  }
});

test("tree store rejects a current projection that contradicts its latest event after-tree without repairing it", async () => {
  const dbPath = tempDbPath("tree-projection-mismatch");
  const initial = createExecutionTreeV1({
    tree_id: "tree-projection-mismatch",
    scope: "execution-cas-scope",
    task_brief: "Reject a tree projection that rewound behind its event history",
    at: baseAt,
  });
  const seed = createLiteExecutionTreeStore(dbPath);
  try {
    seed.initialize(initial);
    seed.applyOperation(growOperation({
      treeId: initial.tree_id,
      id: "advance-tree",
      action: "advance the tree before corrupting its projection",
      expectedRevision: 1,
    }));
  } finally {
    await seed.close();
  }

  const corrupt = createSqliteDatabase(dbPath);
  try {
    corrupt.prepare(`
      UPDATE lite_execution_trees
      SET tree_json = ?
      WHERE scope = ? AND tree_id = ?
    `).run(JSON.stringify(initial), initial.scope, initial.tree_id);
  } finally {
    corrupt.close();
  }

  assert.throws(
    () => createLiteExecutionTreeStore(dbPath),
    (error) => assertHistoryCorrupt(error, "execution_tree", "projection_after_state_mismatch"),
  );

  const inspected = createSqliteDatabase(dbPath);
  try {
    const projection = inspected.prepare<{ tree_json: string; revision: number }>(`
      SELECT tree_json, revision
      FROM lite_execution_trees
      WHERE scope = ? AND tree_id = ?
    `).get(initial.scope, initial.tree_id);
    const event = inspected.prepare<{ tree_after_json: string }>(`
      SELECT tree_after_json
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND revision = 2
    `).get(initial.scope, initial.tree_id);
    assert.equal(Number(projection.revision), 2);
    assert.equal(JSON.parse(projection.tree_json).current_raw_node_id, "raw:0");
    assert.equal(JSON.parse(event.tree_after_json).current_raw_node_id, "raw:1");
  } finally {
    inspected.close();
  }
});

test("state and tree stores reject revision gaps without filling or renumbering history", async (t) => {
  await t.test("state history gap", async () => {
    const { dbPath, initial } = await seedStateHistory("state-history-gap");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        DELETE FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).run(initial.scope, initial.state_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionStateStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_state", "revision_gap"),
    );

    const inspected = createSqliteDatabase(dbPath);
    try {
      const projection = inspected.prepare<{ revision: number }>(`
        SELECT revision FROM lite_execution_states WHERE scope = ? AND state_id = ?
      `).get(initial.scope, initial.state_id);
      const missing = inspected.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).get(initial.scope, initial.state_id);
      assert.equal(Number(projection.revision), 3);
      assert.equal(Number(missing.count), 0);
    } finally {
      inspected.close();
    }
  });

  await t.test("tree history gap", async () => {
    const { dbPath, initial } = await seedTreeHistory("tree-history-gap");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        DELETE FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).run(initial.scope, initial.tree_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionTreeStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_tree", "revision_gap"),
    );

    const inspected = createSqliteDatabase(dbPath);
    try {
      const projection = inspected.prepare<{ revision: number }>(`
        SELECT revision FROM lite_execution_trees WHERE scope = ? AND tree_id = ?
      `).get(initial.scope, initial.tree_id);
      const missing = inspected.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).get(initial.scope, initial.tree_id);
      assert.equal(Number(projection.revision), 3);
      assert.equal(Number(missing.count), 0);
    } finally {
      inspected.close();
    }
  });
});

test("state and tree stores reject orphan events without deleting them", async (t) => {
  await t.test("state orphan events", async () => {
    const { dbPath, initial } = await seedStateHistory("state-orphan-events");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        DELETE FROM lite_execution_states WHERE scope = ? AND state_id = ?
      `).run(initial.scope, initial.state_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionStateStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_state", "orphan_event"),
    );

    const inspected = createSqliteDatabase(dbPath);
    try {
      const events = inspected.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ?
      `).get(initial.scope, initial.state_id);
      assert.equal(Number(events.count), 2);
    } finally {
      inspected.close();
    }
  });

  await t.test("tree orphan events", async () => {
    const { dbPath, initial } = await seedTreeHistory("tree-orphan-events");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        DELETE FROM lite_execution_trees WHERE scope = ? AND tree_id = ?
      `).run(initial.scope, initial.tree_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionTreeStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_tree", "orphan_event"),
    );

    const inspected = createSqliteDatabase(dbPath);
    try {
      const events = inspected.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ?
      `).get(initial.scope, initial.tree_id);
      assert.equal(Number(events.count), 2);
    } finally {
      inspected.close();
    }
  });
});

test("startup audits every historical event and after-state, not only the latest revision", async (t) => {
  await t.test("invalid historical state transition JSON", async () => {
    const { dbPath, initial } = await seedStateHistory("state-invalid-old-event");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        UPDATE lite_execution_state_transitions
        SET transition_json = ?
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).run("not-json", initial.scope, initial.state_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionStateStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_state", "invalid_event_json"),
    );

    const inspected = createSqliteDatabase(dbPath);
    try {
      const row = inspected.prepare<{ transition_json: string }>(`
        SELECT transition_json
        FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).get(initial.scope, initial.state_id);
      assert.equal(row.transition_json, "not-json");
    } finally {
      inspected.close();
    }
  });

  await t.test("invalid historical tree after-state JSON", async () => {
    const { dbPath, initial } = await seedTreeHistory("tree-invalid-old-after");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        UPDATE lite_execution_tree_operations
        SET tree_after_json = ?
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).run("not-json", initial.scope, initial.tree_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionTreeStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_tree", "invalid_event_after_json"),
    );

    const inspected = createSqliteDatabase(dbPath);
    try {
      const row = inspected.prepare<{ tree_after_json: string }>(`
        SELECT tree_after_json
        FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).get(initial.scope, initial.tree_id);
      assert.equal(row.tree_after_json, "not-json");
    } finally {
      inspected.close();
    }
  });
});

test("state and tree stores reject schema-valid historical branches that do not lead to the next revision", async (t) => {
  await t.test("state event chain", async () => {
    const { dbPath, initial } = await seedStateHistory("state-history-branch");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      const row = corrupt.prepare<{ state_after_json: string }>(`
        SELECT state_after_json
        FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).get(initial.scope, initial.state_id);
      const after = JSON.parse(row.state_after_json) as Record<string, unknown>;
      after.task_brief = "schema-valid state branch that never reaches revision 3";
      corrupt.prepare(`
        UPDATE lite_execution_state_transitions
        SET state_after_json = ?
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).run(JSON.stringify(after), initial.scope, initial.state_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionStateStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_state", "event_chain_mismatch"),
    );
  });

  await t.test("tree event chain", async () => {
    const { dbPath, initial } = await seedTreeHistory("tree-history-branch");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      const row = corrupt.prepare<{ tree_after_json: string }>(`
        SELECT tree_after_json
        FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).get(initial.scope, initial.tree_id);
      const after = JSON.parse(row.tree_after_json) as Record<string, unknown>;
      after.task_brief = "schema-valid tree branch that never reaches revision 3";
      corrupt.prepare(`
        UPDATE lite_execution_tree_operations
        SET tree_after_json = ?
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).run(JSON.stringify(after), initial.scope, initial.tree_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionTreeStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_tree", "event_chain_mismatch"),
    );
  });
});

test("state and tree stores reject event identity and revision metadata contradictions", async (t) => {
  await t.test("state event expected revision contradiction", async () => {
    const { dbPath, initial } = await seedStateHistory("state-event-metadata");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      const row = corrupt.prepare<{ transition_json: string }>(`
        SELECT transition_json
        FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).get(initial.scope, initial.state_id);
      const event = JSON.parse(row.transition_json) as Record<string, unknown>;
      event.expected_revision = 2;
      corrupt.prepare(`
        UPDATE lite_execution_state_transitions
        SET expected_revision = 2, transition_json = ?
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).run(JSON.stringify(event), initial.scope, initial.state_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionStateStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_state", "event_revision_mismatch"),
    );
  });

  await t.test("tree event identity contradiction", async () => {
    const { dbPath, initial } = await seedTreeHistory("tree-event-identity");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      const row = corrupt.prepare<{ operation_json: string }>(`
        SELECT operation_json
        FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).get(initial.scope, initial.tree_id);
      const event = JSON.parse(row.operation_json) as Record<string, unknown>;
      event.operation_id = "different-operation-id";
      corrupt.prepare(`
        UPDATE lite_execution_tree_operations
        SET operation_json = ?
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).run(JSON.stringify(event), initial.scope, initial.tree_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionTreeStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_tree", "event_identity_mismatch"),
    );
  });
});

test("state and tree stores bind projection last-event metadata to the latest event", async (t) => {
  await t.test("state projection metadata", async () => {
    const { dbPath, initial } = await seedStateHistory("state-projection-metadata");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        UPDATE lite_execution_states
        SET last_transition_type = ?, last_transition_at = ?
        WHERE scope = ? AND state_id = ?
      `).run("path_rejected", "2026-07-12T09:00:00.000Z", initial.scope, initial.state_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionStateStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_state", "projection_metadata_mismatch"),
    );
  });

  await t.test("tree projection metadata", async () => {
    const { dbPath, initial } = await seedTreeHistory("tree-projection-metadata");
    const corrupt = createSqliteDatabase(dbPath);
    try {
      corrupt.prepare(`
        UPDATE lite_execution_trees
        SET last_operation_type = ?, last_operation_at = ?
        WHERE scope = ? AND tree_id = ?
      `).run("compress", "2026-07-12T09:00:00.000Z", initial.scope, initial.tree_id);
    } finally {
      corrupt.close();
    }

    assert.throws(
      () => createLiteExecutionTreeStore(dbPath),
      (error) => assertHistoryCorrupt(error, "execution_tree", "projection_metadata_mismatch"),
    );
  });
});

test("shared execution stores reject writes outside their owning SQLite transaction", async () => {
  const dbPath = tempDbPath("shared-owner");
  const runtimeDatabase = createLiteRuntimeDatabase(dbPath);
  const stateStore = createLiteExecutionStateStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const treeStore = createLiteExecutionTreeStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const initialState = state("state-shared-owner");
  const initialTree = createExecutionTreeV1({
    tree_id: "tree-shared-owner",
    scope: "execution-cas-scope",
    task_brief: "Require the shared transaction owner for execution mutations",
    at: baseAt,
  });
  try {
    assert.throws(
      () => stateStore.initialize(initialState),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 500);
        assert.equal(error.code, "execution_transaction_required");
        return true;
      },
    );
    assert.throws(
      () => treeStore.initialize(initialTree),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 500);
        assert.equal(error.code, "execution_transaction_required");
        return true;
      },
    );

    await runtimeDatabase.withTx(async () => {
      stateStore.initialize(initialState);
      stateStore.applyTransition(transition({
        state: initialState,
        id: "shared-state-transition",
        validation: "shared transaction",
        expectedRevision: 1,
      }));
      treeStore.initialize(initialTree);
      treeStore.applyOperation(growOperation({
        treeId: initialTree.tree_id,
        id: "shared-tree-operation",
        action: "mutate inside the owning transaction",
        expectedRevision: 1,
      }));
    });

    assert.equal(stateStore.get(initialState.scope, initialState.state_id)?.revision, 2);
    assert.equal(treeStore.get(initialTree.scope, initialTree.tree_id)?.revision, 2);
    await stateStore.close();
    await treeStore.close();
    assert.equal(stateStore.get(initialState.scope, initialState.state_id)?.revision, 2);
  } finally {
    await runtimeDatabase.close();
  }
});

test("external execution state reads expose only committed revisions across suspended commit and rollback", async () => {
  const dbPath = tempDbPath("state-committed-read-isolation");
  const runtimeDatabase = createLiteRuntimeDatabase(dbPath);
  const store = createLiteExecutionStateStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const initial = state("state-committed-read-isolation");
  const createdDuringCommit = state("state-created-during-commit");
  const createdDuringRollback = state("state-created-during-rollback");
  try {
    const queryOnly = runtimeDatabase.readDb.prepare<{ query_only: number }>("PRAGMA query_only").get();
    assert.equal(Number(queryOnly.query_only), 1);
    await runtimeDatabase.withTx(async () => {
      store.initialize(initial);
    });
    assert.equal(store.get(initial.scope, initial.state_id)?.revision, 1);

    const commitEntered = deferredSignal();
    const commitRelease = deferredSignal();
    let transactionCommitRevision: number | null = null;
    let transactionCommitListRevision: number | null = null;
    let transactionCommitHas = false;
    let transactionCommitHasCreated = false;
    const committing = runtimeDatabase.withTx(async () => {
      try {
        store.applyTransition(transition({
          state: initial,
          id: "commit-transition",
          validation: "committed validation",
          expectedRevision: 1,
        }));
        store.initialize(createdDuringCommit);
        transactionCommitRevision = store.get(initial.scope, initial.state_id)?.revision ?? null;
        transactionCommitListRevision = store.listByScope(initial.scope)
          .find((entry) => entry.state.state_id === initial.state_id)?.revision ?? null;
        transactionCommitHas = store.has(initial.scope, initial.state_id);
        transactionCommitHasCreated = store.has(createdDuringCommit.scope, createdDuringCommit.state_id);
        commitEntered.resolve();
        await commitRelease.promise;
      } catch (error) {
        commitEntered.reject(error);
        throw error;
      }
    });
    await inspectSuspendedTransaction({
      transaction: committing,
      entered: commitEntered,
      release: commitRelease,
      inspect: () => {
        assert.equal(transactionCommitRevision, 2);
        assert.equal(transactionCommitListRevision, 2);
        assert.equal(transactionCommitHas, true);
        assert.equal(transactionCommitHasCreated, true);
        assert.equal(store.get(initial.scope, initial.state_id)?.revision, 1);
        assert.equal(
          store.listByScope(initial.scope).find((entry) => entry.state.state_id === initial.state_id)?.revision,
          1,
        );
        assert.equal(store.has(initial.scope, initial.state_id), true);
        assert.equal(store.get(createdDuringCommit.scope, createdDuringCommit.state_id), null);
        assert.equal(store.has(createdDuringCommit.scope, createdDuringCommit.state_id), false);
        assert.equal(
          store.listByScope(createdDuringCommit.scope)
            .some((entry) => entry.state.state_id === createdDuringCommit.state_id),
          false,
        );
      },
    });
    assert.equal(store.get(initial.scope, initial.state_id)?.revision, 2);
    assert.deepEqual(
      store.get(initial.scope, initial.state_id)?.state.completed_validations,
      ["committed validation"],
    );
    assert.equal(store.has(createdDuringCommit.scope, createdDuringCommit.state_id), true);

    const rollbackEntered = deferredSignal();
    const rollbackRelease = deferredSignal();
    let transactionRollbackRevision: number | null = null;
    let transactionRollbackListRevision: number | null = null;
    let transactionRollbackHasCreated = false;
    const rollingBack = runtimeDatabase.withTx(async () => {
      try {
        store.applyTransition(transition({
          state: initial,
          id: "rollback-transition",
          validation: "rolled-back validation",
          expectedRevision: 2,
          at: "2026-07-12T00:02:00.000Z",
        }));
        store.initialize(createdDuringRollback);
        transactionRollbackRevision = store.get(initial.scope, initial.state_id)?.revision ?? null;
        transactionRollbackListRevision = store.listByScope(initial.scope)
          .find((entry) => entry.state.state_id === initial.state_id)?.revision ?? null;
        transactionRollbackHasCreated = store.has(
          createdDuringRollback.scope,
          createdDuringRollback.state_id,
        );
        rollbackEntered.resolve();
        await rollbackRelease.promise;
        throw new Error("rollback suspended state transaction");
      } catch (error) {
        rollbackEntered.reject(error);
        throw error;
      }
    });
    await inspectSuspendedTransaction({
      transaction: rollingBack,
      entered: rollbackEntered,
      release: rollbackRelease,
      expectedRejection: /rollback suspended state transaction/,
      inspect: () => {
        assert.equal(transactionRollbackRevision, 3);
        assert.equal(transactionRollbackListRevision, 3);
        assert.equal(transactionRollbackHasCreated, true);
        assert.equal(store.get(initial.scope, initial.state_id)?.revision, 2);
        assert.deepEqual(
          store.get(initial.scope, initial.state_id)?.state.completed_validations,
          ["committed validation"],
        );
        assert.equal(store.get(createdDuringRollback.scope, createdDuringRollback.state_id), null);
        assert.equal(store.has(createdDuringRollback.scope, createdDuringRollback.state_id), false);
      },
    });
    assert.equal(store.get(initial.scope, initial.state_id)?.revision, 2);
    assert.deepEqual(
      store.get(initial.scope, initial.state_id)?.state.completed_validations,
      ["committed validation"],
    );
    assert.equal(store.has(createdDuringRollback.scope, createdDuringRollback.state_id), false);
  } finally {
    await store.close();
    await runtimeDatabase.close();
  }
});

test("external execution tree reads expose only committed revisions and operation ids across commit and rollback", async () => {
  const dbPath = tempDbPath("tree-committed-read-isolation");
  const runtimeDatabase = createLiteRuntimeDatabase(dbPath);
  const store = createLiteExecutionTreeStoreFromDatabase(runtimeDatabase.db, {
    path: runtimeDatabase.path,
    readDatabase: runtimeDatabase.readDb,
    transaction: runtimeDatabase.transaction,
  });
  const initial = createExecutionTreeV1({
    tree_id: "tree-committed-read-isolation",
    scope: "execution-cas-scope",
    task_brief: "Keep uncommitted tree revisions private to their transaction owner",
    at: baseAt,
  });
  const createdDuringCommit = createExecutionTreeV1({
    tree_id: "tree-created-during-commit",
    scope: initial.scope,
    task_brief: "Prove a new tree stays private until commit",
    at: baseAt,
  });
  const createdDuringRollback = createExecutionTreeV1({
    tree_id: "tree-created-during-rollback",
    scope: initial.scope,
    task_brief: "Prove a rolled-back tree is never externally visible",
    at: baseAt,
  });
  try {
    await runtimeDatabase.withTx(async () => {
      store.initialize(initial);
    });
    assert.equal(store.get(initial.scope, initial.tree_id)?.revision, 1);

    const commitEntered = deferredSignal();
    const commitRelease = deferredSignal();
    let transactionCommitRevision: number | null = null;
    let transactionCommitListRevision: number | null = null;
    let transactionCommitHasOperation = false;
    let transactionCommitHasCreated = false;
    const committing = runtimeDatabase.withTx(async () => {
      try {
        store.applyOperation(growOperation({
          treeId: initial.tree_id,
          id: "commit-operation",
          action: "commit the first guarded tree step",
          expectedRevision: 1,
        }));
        store.initialize(createdDuringCommit);
        transactionCommitRevision = store.get(initial.scope, initial.tree_id)?.revision ?? null;
        transactionCommitListRevision = store.listByScope(initial.scope)
          .find((entry) => entry.tree.tree_id === initial.tree_id)?.revision ?? null;
        transactionCommitHasOperation = store.hasOperation(initial.scope, initial.tree_id, "commit-operation");
        transactionCommitHasCreated = store.has(createdDuringCommit.scope, createdDuringCommit.tree_id);
        commitEntered.resolve();
        await commitRelease.promise;
      } catch (error) {
        commitEntered.reject(error);
        throw error;
      }
    });
    await inspectSuspendedTransaction({
      transaction: committing,
      entered: commitEntered,
      release: commitRelease,
      inspect: () => {
        assert.equal(transactionCommitRevision, 2);
        assert.equal(transactionCommitListRevision, 2);
        assert.equal(transactionCommitHasOperation, true);
        assert.equal(transactionCommitHasCreated, true);
        assert.equal(store.get(initial.scope, initial.tree_id)?.revision, 1);
        assert.equal(store.get(initial.scope, initial.tree_id)?.tree.current_raw_node_id, "raw:0");
        assert.equal(
          store.listByScope(initial.scope).find((entry) => entry.tree.tree_id === initial.tree_id)?.revision,
          1,
        );
        assert.equal(store.hasOperation(initial.scope, initial.tree_id, "commit-operation"), false);
        assert.equal(store.get(createdDuringCommit.scope, createdDuringCommit.tree_id), null);
        assert.equal(store.has(createdDuringCommit.scope, createdDuringCommit.tree_id), false);
        assert.equal(
          store.listByScope(createdDuringCommit.scope)
            .some((entry) => entry.tree.tree_id === createdDuringCommit.tree_id),
          false,
        );
      },
    });
    assert.equal(store.get(initial.scope, initial.tree_id)?.revision, 2);
    assert.equal(store.get(initial.scope, initial.tree_id)?.tree.current_raw_node_id, "raw:1");
    assert.equal(store.hasOperation(initial.scope, initial.tree_id, "commit-operation"), true);
    assert.equal(store.has(createdDuringCommit.scope, createdDuringCommit.tree_id), true);

    const rollbackEntered = deferredSignal();
    const rollbackRelease = deferredSignal();
    let transactionRollbackRevision: number | null = null;
    let transactionRollbackHasOperation = false;
    let transactionRollbackHasCreated = false;
    const rollingBack = runtimeDatabase.withTx(async () => {
      try {
        store.applyOperation(growOperation({
          treeId: initial.tree_id,
          id: "rollback-operation",
          action: "roll back the second guarded tree step",
          expectedRevision: 2,
          at: "2026-07-12T00:02:00.000Z",
        }));
        store.initialize(createdDuringRollback);
        transactionRollbackRevision = store.get(initial.scope, initial.tree_id)?.revision ?? null;
        transactionRollbackHasOperation = store.hasOperation(initial.scope, initial.tree_id, "rollback-operation");
        transactionRollbackHasCreated = store.has(
          createdDuringRollback.scope,
          createdDuringRollback.tree_id,
        );
        rollbackEntered.resolve();
        await rollbackRelease.promise;
        throw new Error("rollback suspended tree transaction");
      } catch (error) {
        rollbackEntered.reject(error);
        throw error;
      }
    });
    await inspectSuspendedTransaction({
      transaction: rollingBack,
      entered: rollbackEntered,
      release: rollbackRelease,
      expectedRejection: /rollback suspended tree transaction/,
      inspect: () => {
        assert.equal(transactionRollbackRevision, 3);
        assert.equal(transactionRollbackHasOperation, true);
        assert.equal(transactionRollbackHasCreated, true);
        assert.equal(store.get(initial.scope, initial.tree_id)?.revision, 2);
        assert.equal(store.get(initial.scope, initial.tree_id)?.tree.current_raw_node_id, "raw:1");
        assert.equal(store.hasOperation(initial.scope, initial.tree_id, "rollback-operation"), false);
        assert.equal(store.get(createdDuringRollback.scope, createdDuringRollback.tree_id), null);
        assert.equal(store.has(createdDuringRollback.scope, createdDuringRollback.tree_id), false);
      },
    });
    assert.equal(store.get(initial.scope, initial.tree_id)?.revision, 2);
    assert.equal(store.get(initial.scope, initial.tree_id)?.tree.current_raw_node_id, "raw:1");
    assert.equal(store.hasOperation(initial.scope, initial.tree_id, "rollback-operation"), false);
    assert.equal(store.has(createdDuringRollback.scope, createdDuringRollback.tree_id), false);
  } finally {
    await store.close();
    await runtimeDatabase.close();
  }
});

const stateStoreModuleUrl = new URL("../../src/execution/state-store.ts", import.meta.url).href;
const treeStoreModuleUrl = new URL("../../src/execution/tree-store.ts", import.meta.url).href;

const concurrencyWorkerSource = `
  import { existsSync, writeFileSync } from "node:fs";
  import { setTimeout as delay } from "node:timers/promises";
  import { createLiteExecutionStateStore } from ${JSON.stringify(stateStoreModuleUrl)};
  import { createLiteExecutionTreeStore } from ${JSON.stringify(treeStoreModuleUrl)};

  const [kind, dbPath, readyPath, goPath, mutationJson] = process.argv.slice(1);
  const store = kind === "state"
    ? createLiteExecutionStateStore(dbPath)
    : createLiteExecutionTreeStore(dbPath);
  try {
    writeFileSync(readyPath, "ready");
    while (!existsSync(goPath)) await delay(5);
    const mutation = JSON.parse(mutationJson);
    try {
      const result = kind === "state"
        ? store.applyTransition(mutation)
        : store.applyOperation(mutation);
      process.stdout.write(JSON.stringify({ ok: true, revision: result.revision }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        statusCode: error && typeof error === "object" && "statusCode" in error ? error.statusCode : null,
        code: error && typeof error === "object" && "code" in error ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  } finally {
    await store.close();
  }
`;

type WorkerResult = {
  ok: boolean;
  revision?: number;
  statusCode?: number | null;
  code?: string | null;
  message?: string;
};

function startConcurrencyWorker(args: {
  kind: "state" | "tree";
  dbPath: string;
  readyPath: string;
  goPath: string;
  mutation: unknown;
}): Promise<WorkerResult> {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    concurrencyWorkerSource,
    args.kind,
    args.dbPath,
    args.readyPath,
    args.goPath,
    JSON.stringify(args.mutation),
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`execution concurrency worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerResult);
      } catch (error) {
        reject(new Error(`execution concurrency worker returned invalid JSON: ${stdout}; stderr=${stderr}`, { cause: error }));
      }
    });
  });
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for concurrency workers: ${paths.join(", ")}`);
}

async function runConcurrentMutations(args: {
  kind: "state" | "tree";
  dbPath: string;
  mutations: [unknown, unknown];
}): Promise<[WorkerResult, WorkerResult]> {
  const barrierDir = mkdtempSync(join(tmpdir(), "aionis-execution-barrier-"));
  const readyA = join(barrierDir, "a.ready");
  const readyB = join(barrierDir, "b.ready");
  const goPath = join(barrierDir, "go");
  const workerA = startConcurrencyWorker({
    kind: args.kind,
    dbPath: args.dbPath,
    readyPath: readyA,
    goPath,
    mutation: args.mutations[0],
  });
  const workerB = startConcurrencyWorker({
    kind: args.kind,
    dbPath: args.dbPath,
    readyPath: readyB,
    goPath,
    mutation: args.mutations[1],
  });
  await waitForFiles([readyA, readyB]);
  writeFileSync(goPath, "go");
  return await Promise.all([workerA, workerB]);
}

function assertSingleCasWinner(results: [WorkerResult, WorkerResult], conflictCode: string): void {
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(winners[0]?.revision, 2);
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.equal(losers[0]?.statusCode, 409);
  assert.equal(losers[0]?.code, conflictCode);
}

test("two independent SQLite connections cannot commit two state transitions at the same revision", async () => {
  for (let round = 1; round <= 6; round += 1) {
    const dbPath = tempDbPath(`state-concurrent-${round}`);
    const initial = state(`state-concurrent-${round}`);
    const seed = createLiteExecutionStateStore(dbPath);
    seed.initialize(initial);
    await seed.close();

    const results = await runConcurrentMutations({
      kind: "state",
      dbPath,
      mutations: [
        transition({ state: initial, id: `state-worker-a-${round}`, validation: "worker-a", expectedRevision: 1 }),
        transition({ state: initial, id: `state-worker-b-${round}`, validation: "worker-b", expectedRevision: 1 }),
      ],
    });
    assertSingleCasWinner(results, "execution_state_revision_conflict");

    const db = createSqliteDatabase(dbPath);
    try {
      const row = db.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM lite_execution_state_transitions
        WHERE scope = ? AND state_id = ? AND revision = 2
      `).get(initial.scope, initial.state_id);
      assert.equal(Number(row.count), 1, `round ${round}`);
      const current = db.prepare<{ revision: number }>(`
        SELECT revision FROM lite_execution_states WHERE scope = ? AND state_id = ?
      `).get(initial.scope, initial.state_id);
      assert.equal(Number(current.revision), 2, `round ${round}`);
    } finally {
      db.close();
    }
  }
});

test("two independent SQLite connections cannot commit two tree operations at the same revision", async () => {
  for (let round = 1; round <= 6; round += 1) {
    const dbPath = tempDbPath(`tree-concurrent-${round}`);
    const initial = createExecutionTreeV1({
      tree_id: `tree-concurrent-${round}`,
      scope: "execution-cas-scope",
      task_brief: "Serialize concurrent execution tree branches",
      at: baseAt,
    });
    const seed = createLiteExecutionTreeStore(dbPath);
    seed.initialize(initial);
    await seed.close();

    const results = await runConcurrentMutations({
      kind: "tree",
      dbPath,
      mutations: [
        growOperation({ treeId: initial.tree_id, id: `tree-worker-a-${round}`, action: "worker A branch", expectedRevision: 1 }),
        growOperation({ treeId: initial.tree_id, id: `tree-worker-b-${round}`, action: "worker B branch", expectedRevision: 1 }),
      ],
    });
    assertSingleCasWinner(results, "execution_tree_revision_conflict");

    const db = createSqliteDatabase(dbPath);
    try {
      const row = db.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM lite_execution_tree_operations
        WHERE scope = ? AND tree_id = ? AND revision = 2
      `).get(initial.scope, initial.tree_id);
      assert.equal(Number(row.count), 1, `round ${round}`);
      const current = db.prepare<{ revision: number }>(`
        SELECT revision FROM lite_execution_trees WHERE scope = ? AND tree_id = ?
      `).get(initial.scope, initial.tree_id);
      assert.equal(Number(current.revision), 2, `round ${round}`);
    } finally {
      db.close();
    }
  }
});
