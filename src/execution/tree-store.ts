import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { createSqliteDatabase, type SqliteDatabase } from "../store/sqlite.js";
import {
  ExecutionTreeOperationV1Schema,
  ExecutionTreeV1Schema,
  applyExecutionTreeOperationV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "./tree.js";
import { stableJson } from "../util/stable-json.js";

export const StoredExecutionTreeV1Schema = z.object({
  tree: ExecutionTreeV1Schema,
  revision: z.number().int().positive(),
  last_operation_type: z.string().trim().min(1).nullable().default(null),
  last_operation_at: z.string().datetime().nullable().default(null),
});
export type StoredExecutionTreeV1 = z.infer<typeof StoredExecutionTreeV1Schema>;

export type ExecutionTreeStoreHealthSnapshot = {
  path: string;
  mode: "sqlite_execution_tree_v1";
};

export type ExecutionTreeStore = {
  get(scope: string, treeId: string): StoredExecutionTreeV1 | null;
  put(treeInput: ExecutionTreeV1): StoredExecutionTreeV1;
  listByScope(scope: string): StoredExecutionTreeV1[];
  applyOperation(operationInput: ExecutionTreeOperationV1): StoredExecutionTreeV1;
  has(scope: string, treeId: string): boolean;
  hasOperation(scope: string, treeId: string, operationId: string): boolean;
};

type LiteExecutionTreeRow = {
  tree_json: string;
  revision: number;
  last_operation_type: string | null;
  last_operation_at: string | null;
};

type LiteExecutionTreeOperationRow = {
  operation_json: string;
};

function operationIntent(value: ExecutionTreeOperationV1): Record<string, unknown> {
  const intent = { ...value } as Record<string, unknown>;
  delete intent.at;
  return intent;
}

function sameOperationIntent(left: ExecutionTreeOperationV1, right: ExecutionTreeOperationV1): boolean {
  return stableJson(operationIntent(left)) === stableJson(operationIntent(right));
}

export class LiteExecutionTreeStore implements ExecutionTreeStore {
  private readonly db: SqliteDatabase;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = createSqliteDatabase(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS lite_execution_trees (
        scope TEXT NOT NULL,
        tree_id TEXT NOT NULL,
        tree_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        last_operation_type TEXT,
        last_operation_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, tree_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lite_execution_trees_scope_updated
        ON lite_execution_trees(scope, updated_at DESC, tree_id);

      CREATE TABLE IF NOT EXISTS lite_execution_tree_operations (
        scope TEXT NOT NULL,
        tree_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        operation_type TEXT NOT NULL,
        operation_at TEXT NOT NULL,
        actor_role TEXT,
        operation_json TEXT NOT NULL,
        tree_after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, tree_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lite_execution_tree_operations_tree_revision
        ON lite_execution_tree_operations(scope, tree_id, revision);
    `);
  }

  get(scope: string, treeId: string): StoredExecutionTreeV1 | null {
    const row = this.db.prepare<LiteExecutionTreeRow>(`
      SELECT tree_json, revision, last_operation_type, last_operation_at
      FROM lite_execution_trees
      WHERE scope = ? AND tree_id = ?
    `).get(scope, treeId);
    return row ? rowToStoredExecutionTree(row) : null;
  }

  put(treeInput: ExecutionTreeV1): StoredExecutionTreeV1 {
    const tree = ExecutionTreeV1Schema.parse(treeInput);
    const existing = this.get(tree.scope, tree.tree_id);
    const next = StoredExecutionTreeV1Schema.parse({
      tree,
      revision: existing?.revision ?? 1,
      last_operation_type: existing?.last_operation_type ?? null,
      last_operation_at: existing?.last_operation_at ?? null,
    });
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO lite_execution_trees (
        scope,
        tree_id,
        tree_json,
        revision,
        last_operation_type,
        last_operation_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, tree_id) DO UPDATE SET
        tree_json = excluded.tree_json,
        revision = excluded.revision,
        last_operation_type = excluded.last_operation_type,
        last_operation_at = excluded.last_operation_at,
        updated_at = excluded.updated_at
    `).run(
      tree.scope,
      tree.tree_id,
      JSON.stringify(next.tree),
      next.revision,
      next.last_operation_type,
      next.last_operation_at,
      now,
      now,
    );
    return next;
  }

  listByScope(scope: string): StoredExecutionTreeV1[] {
    const rows = this.db.prepare<LiteExecutionTreeRow>(`
      SELECT tree_json, revision, last_operation_type, last_operation_at
      FROM lite_execution_trees
      WHERE scope = ?
      ORDER BY tree_id ASC
    `).all(scope);
    return rows.map(rowToStoredExecutionTree);
  }

  private getOperation(scope: string, treeId: string, operationId: string): ExecutionTreeOperationV1 | null {
    const row = this.db.prepare<LiteExecutionTreeOperationRow>(`
      SELECT operation_json
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND operation_id = ?
    `).get(scope, treeId, operationId);
    return row ? ExecutionTreeOperationV1Schema.parse(JSON.parse(row.operation_json)) : null;
  }

  applyOperation(operationInput: ExecutionTreeOperationV1): StoredExecutionTreeV1 {
    const operation = ExecutionTreeOperationV1Schema.parse(operationInput);
    const existing = this.get(operation.scope, operation.tree_id);
    if (!existing) {
      throw new Error(`execution tree not found for operation: ${operation.scope}/${operation.tree_id}`);
    }
    const previousOperation = this.getOperation(operation.scope, operation.tree_id, operation.operation_id);
    if (previousOperation) {
      if (!sameOperationIntent(previousOperation, operation)) {
        throw new Error(`execution tree operation id conflict: ${operation.scope}/${operation.tree_id}/${operation.operation_id}`);
      }
      return existing;
    }

    const nextTree = applyExecutionTreeOperationV1(existing.tree, operation);
    const next = StoredExecutionTreeV1Schema.parse({
      tree: nextTree,
      revision: existing.revision + 1,
      last_operation_type: operation.type,
      last_operation_at: operation.at,
    });
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE lite_execution_trees
        SET
          tree_json = ?,
          revision = ?,
          last_operation_type = ?,
          last_operation_at = ?,
          updated_at = ?
        WHERE scope = ? AND tree_id = ? AND revision = ?
      `).run(
        JSON.stringify(next.tree),
        next.revision,
        next.last_operation_type,
        next.last_operation_at,
        now,
        operation.scope,
        operation.tree_id,
        existing.revision,
      );
      const updated = this.get(operation.scope, operation.tree_id);
      if (!updated || updated.revision !== next.revision) {
        throw new Error(`execution tree concurrent revision update failed for ${operation.scope}/${operation.tree_id}`);
      }
      this.db.prepare(`
        INSERT INTO lite_execution_tree_operations (
          scope,
          tree_id,
          operation_id,
          revision,
          operation_type,
          operation_at,
          actor_role,
          operation_json,
          tree_after_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.scope,
        operation.tree_id,
        operation.operation_id,
        next.revision,
        operation.type,
        operation.at,
        operation.actor_role,
        JSON.stringify(operation),
        JSON.stringify(next.tree),
        now,
      );
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  has(scope: string, treeId: string): boolean {
    const row = this.db.prepare<{ present: number }>(`
      SELECT 1 AS present
      FROM lite_execution_trees
      WHERE scope = ? AND tree_id = ?
      LIMIT 1
    `).get(scope, treeId);
    return !!row;
  }

  hasOperation(scope: string, treeId: string, operationId: string): boolean {
    const row = this.db.prepare<{ present: number }>(`
      SELECT 1 AS present
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND operation_id = ?
      LIMIT 1
    `).get(scope, treeId, operationId);
    return !!row;
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM lite_execution_tree_operations;
      DELETE FROM lite_execution_trees;
    `);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  healthSnapshot(): ExecutionTreeStoreHealthSnapshot {
    return {
      path: this.path,
      mode: "sqlite_execution_tree_v1",
    };
  }
}

function rowToStoredExecutionTree(row: LiteExecutionTreeRow): StoredExecutionTreeV1 {
  return StoredExecutionTreeV1Schema.parse({
    tree: JSON.parse(row.tree_json),
    revision: row.revision,
    last_operation_type: row.last_operation_type,
    last_operation_at: row.last_operation_at,
  });
}

export function createLiteExecutionTreeStore(path: string): LiteExecutionTreeStore {
  return new LiteExecutionTreeStore(path);
}

export function buildStoredExecutionTree(
  treeInput: ExecutionTreeV1,
  options: {
    revision?: number;
    lastOperationType?: ExecutionTreeOperationV1["type"] | null;
    lastOperationAt?: string | null;
  } = {},
): StoredExecutionTreeV1 {
  return StoredExecutionTreeV1Schema.parse({
    tree: treeInput,
    revision: options.revision ?? 1,
    last_operation_type: options.lastOperationType ?? null,
    last_operation_at: options.lastOperationAt ?? null,
  });
}
