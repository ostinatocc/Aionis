import { z } from "zod";
import {
  createPrivateRuntimeSqliteDatabase,
  hardenPrivateRuntimeSqliteArtifacts,
  ignoreSqliteDuplicateColumnError,
  type SqliteDatabase,
} from "../store/sqlite.js";
import { createLiteRuntimeReadDatabase } from "../store/lite-runtime-database.js";
import type { SqliteTransactionRunner } from "../store/sqlite-transaction-runner.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import {
  executionHistoryCorruptError,
  installExecutionHistoryRevisionInvariant,
} from "./history-integrity.js";
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
  readonly transactionRunner: SqliteTransactionRunner | null;
  get(scope: string, treeId: string): StoredExecutionTreeV1 | null;
  initialize(treeInput: ExecutionTreeV1): StoredExecutionTreeV1;
  /** @deprecated Use initialize. This method is create-only and never replaces an existing snapshot. */
  put(treeInput: ExecutionTreeV1): StoredExecutionTreeV1;
  listByScope(scope: string): StoredExecutionTreeV1[];
  applyOperation(operationInput: ExecutionTreeOperationV1): StoredExecutionTreeV1;
  has(scope: string, treeId: string): boolean;
  hasOperation(scope: string, treeId: string, operationId: string): boolean;
};

export type LiteExecutionTreeStoreOptions = {
  database?: SqliteDatabase;
  readDatabase?: SqliteDatabase;
  closeReadDatabaseOnClose?: boolean;
  transactionMode?: "self_managed" | "external";
  transaction?: SqliteTransactionRunner;
};

type LiteExecutionTreeRow = {
  tree_json: string;
  revision: number;
  last_operation_type: string | null;
  last_operation_at: string | null;
};

type LiteExecutionTreeOperationRow = {
  operation_json: string;
  revision: number;
  operation_type: string;
  operation_at: string;
  tree_after_json: string;
};

type StoredExecutionTreeOperationEvent = {
  operation: ExecutionTreeOperationV1;
  after: StoredExecutionTreeV1;
};

function operationIntent(value: ExecutionTreeOperationV1): Record<string, unknown> {
  const intent = { ...value } as Record<string, unknown>;
  delete intent.expected_revision;
  delete intent.at;
  return intent;
}

function sameOperationIntent(left: ExecutionTreeOperationV1, right: ExecutionTreeOperationV1): boolean {
  return stableJson(operationIntent(left)) === stableJson(operationIntent(right));
}

function snapshotSha256(value: ExecutionTreeV1): string {
  return sha256Hex(stableJson(value));
}

export class LiteExecutionTreeStore implements ExecutionTreeStore {
  private readonly db: SqliteDatabase;
  private readonly readDb: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly ownsReadDatabase: boolean;
  private readonly transactionMode: "self_managed" | "external";
  readonly transactionRunner: SqliteTransactionRunner | null;

  constructor(private readonly path: string, options: LiteExecutionTreeStoreOptions = {}) {
    this.db = options.database ?? createPrivateRuntimeSqliteDatabase(path);
    this.ownsDatabase = options.database == null;
    this.transactionMode = options.transactionMode ?? "self_managed";
    this.transactionRunner = options.transaction ?? null;
    this.readDb = this.transactionMode === "external"
      ? options.readDatabase ?? this.db
      : this.db;
    this.ownsReadDatabase = this.transactionMode === "external"
      && options.closeReadDatabaseOnClose === true
      && options.readDatabase != null
      && options.readDatabase !== this.db;
    try {
      if (
        this.transactionMode === "external"
        && (
          !options.database
          || !options.readDatabase
          || options.readDatabase === options.database
          || !this.transactionRunner
        )
      ) {
        throw new Error(
          "external execution tree transactions require independent SQLite write/read connections and a transaction runner",
        );
      }
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
          expected_revision INTEGER,
          operation_json TEXT NOT NULL,
          tree_after_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (scope, tree_id, operation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lite_execution_tree_operations_tree_revision
          ON lite_execution_tree_operations(scope, tree_id, revision);
      `);
      try {
        this.db.exec("ALTER TABLE lite_execution_tree_operations ADD COLUMN expected_revision INTEGER");
      } catch (error) {
        ignoreSqliteDuplicateColumnError(error);
      }
      installExecutionHistoryRevisionInvariant(this.db, this.path, {
        resourceKind: "execution_tree",
        projectionTable: "lite_execution_trees",
        eventTable: "lite_execution_tree_operations",
        resourceIdColumn: "tree_id",
        projectionJsonColumn: "tree_json",
        projectionLastTypeColumn: "last_operation_type",
        projectionLastAtColumn: "last_operation_at",
        eventIdColumn: "operation_id",
        eventTypeColumn: "operation_type",
        eventAtColumn: "operation_at",
        eventJsonColumn: "operation_json",
        eventAfterJsonColumn: "tree_after_json",
        uniqueRevisionIndex: "idx_lite_execution_tree_operations_unique_revision",
      });
      if (this.ownsDatabase) hardenPrivateRuntimeSqliteArtifacts(path);
    } catch (error) {
      if (this.ownsReadDatabase) {
        try {
          this.readDb.close();
        } catch {
          // Preserve the initialization failure.
        }
      }
      if (this.ownsDatabase) this.db.close();
      throw error;
    }
  }

  private queryDatabase(): SqliteDatabase {
    if (this.transactionMode === "external" && !this.transactionRunner?.inTransaction()) {
      return this.readDb;
    }
    return this.db;
  }

  private mutate<T>(fn: () => T): T {
    if (this.transactionMode === "external") {
      if (!this.transactionRunner?.inTransaction()) {
        throw new HttpError(
          500,
          "execution_transaction_required",
          "execution tree mutation requires the owning SQLite transaction",
        );
      }
      return fn();
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(scope: string, treeId: string): StoredExecutionTreeV1 | null {
    const row = this.queryDatabase().prepare<LiteExecutionTreeRow>(`
      SELECT tree_json, revision, last_operation_type, last_operation_at
      FROM lite_execution_trees
      WHERE scope = ? AND tree_id = ?
    `).get(scope, treeId);
    return row ? rowToStoredExecutionTree(row) : null;
  }

  initialize(treeInput: ExecutionTreeV1): StoredExecutionTreeV1 {
    const tree = ExecutionTreeV1Schema.parse(treeInput);
    const next = StoredExecutionTreeV1Schema.parse({
      tree,
      revision: 1,
      last_operation_type: null,
      last_operation_at: null,
    });
    return this.mutate(() => {
      const now = new Date().toISOString();
      const inserted = this.db.prepare<{ revision: number }>(`
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
        ON CONFLICT(scope, tree_id) DO NOTHING
        RETURNING revision
      `).get(
        tree.scope,
        tree.tree_id,
        JSON.stringify(next.tree),
        next.revision,
        next.last_operation_type,
        next.last_operation_at,
        now,
        now,
      );
      if (inserted) return next;

      const existing = this.get(tree.scope, tree.tree_id);
      if (!existing) {
        throw new Error(`execution tree initialization lost existing row: ${tree.scope}/${tree.tree_id}`);
      }
      if (stableJson(existing.tree) === stableJson(tree)) return existing;
      throw new HttpError(
        409,
        "execution_tree_snapshot_conflict",
        "execution tree already exists with a different snapshot",
        {
          contract: "execution_conflict_v1",
          resource_kind: "execution_tree",
          scope: tree.scope,
          tree_id: tree.tree_id,
          current_revision: existing.revision,
          current_snapshot_sha256: snapshotSha256(existing.tree),
          incoming_snapshot_sha256: snapshotSha256(tree),
          retry_after_reload: true,
        },
      );
    });
  }

  put(treeInput: ExecutionTreeV1): StoredExecutionTreeV1 {
    return this.initialize(treeInput);
  }

  listByScope(scope: string): StoredExecutionTreeV1[] {
    const rows = this.queryDatabase().prepare<LiteExecutionTreeRow>(`
      SELECT tree_json, revision, last_operation_type, last_operation_at
      FROM lite_execution_trees
      WHERE scope = ?
      ORDER BY tree_id ASC
    `).all(scope);
    return rows.map(rowToStoredExecutionTree);
  }

  private getOperation(
    scope: string,
    treeId: string,
    operationId: string,
  ): StoredExecutionTreeOperationEvent | null {
    const row = this.db.prepare<LiteExecutionTreeOperationRow>(`
      SELECT operation_json, revision, operation_type, operation_at, tree_after_json
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND operation_id = ?
    `).get(scope, treeId, operationId);
    if (!row) return null;
    try {
      return {
        operation: ExecutionTreeOperationV1Schema.parse(JSON.parse(row.operation_json)),
        after: StoredExecutionTreeV1Schema.parse({
          tree: JSON.parse(row.tree_after_json),
          revision: Number(row.revision),
          last_operation_type: row.operation_type,
          last_operation_at: row.operation_at,
        }),
      };
    } catch {
      throw executionHistoryCorruptError({
        resourceKind: "execution_tree",
        databasePath: this.path,
        violations: [{
          kind: "invalid_operation_event",
          scope,
          resource_id: treeId,
          operation_id: operationId,
          revision: Number(row.revision),
        }],
      });
    }
  }

  applyOperation(operationInput: ExecutionTreeOperationV1): StoredExecutionTreeV1 {
    const operation = ExecutionTreeOperationV1Schema.parse(operationInput);
    return this.mutate(() => {
      const existing = this.get(operation.scope, operation.tree_id);
      if (!existing) {
        throw new Error(`execution tree not found for operation: ${operation.scope}/${operation.tree_id}`);
      }
      const previousOperation = this.getOperation(operation.scope, operation.tree_id, operation.operation_id);
      if (previousOperation) {
        if (!sameOperationIntent(previousOperation.operation, operation)) {
          throw new HttpError(
            409,
            "execution_operation_id_conflict",
            `execution tree operation id conflict: ${operation.scope}/${operation.tree_id}/${operation.operation_id}`,
            {
              contract: "execution_conflict_v1",
              resource_kind: "execution_tree_operation",
              scope: operation.scope,
              tree_id: operation.tree_id,
              operation_id: operation.operation_id,
              current_revision: existing.revision,
              retry_after_reload: false,
            },
          );
        }
        return previousOperation.after;
      }
      if (operation.expected_revision == null) {
        throw new HttpError(
          409,
          "execution_tree_expected_revision_required",
          "expected_revision is required when mutating an existing execution tree",
          {
            contract: "execution_conflict_v1",
            resource_kind: "execution_tree",
            scope: operation.scope,
            tree_id: operation.tree_id,
            operation_id: operation.operation_id,
            current_revision: existing.revision,
            retry_after_reload: true,
          },
        );
      }
      if (operation.expected_revision !== existing.revision) {
        throw new HttpError(
          409,
          "execution_tree_revision_conflict",
          `execution tree revision mismatch: expected ${operation.expected_revision}, got ${existing.revision}`,
          {
            contract: "execution_conflict_v1",
            resource_kind: "execution_tree",
            scope: operation.scope,
            tree_id: operation.tree_id,
            operation_id: operation.operation_id,
            expected_revision: operation.expected_revision,
            current_revision: existing.revision,
            retry_after_reload: true,
          },
        );
      }

      const nextTree = applyExecutionTreeOperationV1(existing.tree, operation);
      const next = StoredExecutionTreeV1Schema.parse({
        tree: nextTree,
        revision: existing.revision + 1,
        last_operation_type: operation.type,
        last_operation_at: operation.at,
      });
      const now = new Date().toISOString();
      const updated = this.db.prepare<{ revision: number }>(`
        UPDATE lite_execution_trees
        SET
          tree_json = ?,
          revision = ?,
          last_operation_type = ?,
          last_operation_at = ?,
          updated_at = ?
        WHERE scope = ? AND tree_id = ? AND revision = ?
        RETURNING revision
      `).get(
        JSON.stringify(next.tree),
        next.revision,
        next.last_operation_type,
        next.last_operation_at,
        now,
        operation.scope,
        operation.tree_id,
        existing.revision,
      );
      if (!updated || updated.revision !== next.revision) {
        const current = this.get(operation.scope, operation.tree_id);
        throw new HttpError(
          409,
          "execution_tree_revision_conflict",
          "execution tree changed before the operation could be committed",
          {
            contract: "execution_conflict_v1",
            resource_kind: "execution_tree",
            scope: operation.scope,
            tree_id: operation.tree_id,
            operation_id: operation.operation_id,
            expected_revision: existing.revision,
            current_revision: current?.revision ?? null,
            retry_after_reload: true,
          },
        );
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
          expected_revision,
          operation_json,
          tree_after_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.scope,
        operation.tree_id,
        operation.operation_id,
        next.revision,
        operation.type,
        operation.at,
        operation.actor_role,
        operation.expected_revision,
        JSON.stringify(operation),
        JSON.stringify(next.tree),
        now,
      );
      return next;
    });
  }

  has(scope: string, treeId: string): boolean {
    const row = this.queryDatabase().prepare<{ present: number }>(`
      SELECT 1 AS present
      FROM lite_execution_trees
      WHERE scope = ? AND tree_id = ?
      LIMIT 1
    `).get(scope, treeId);
    return !!row;
  }

  hasOperation(scope: string, treeId: string, operationId: string): boolean {
    const row = this.queryDatabase().prepare<{ present: number }>(`
      SELECT 1 AS present
      FROM lite_execution_tree_operations
      WHERE scope = ? AND tree_id = ? AND operation_id = ?
      LIMIT 1
    `).get(scope, treeId, operationId);
    return !!row;
  }

  clear(): void {
    this.mutate(() => {
      this.db.exec(`
        DELETE FROM lite_execution_tree_operations;
        DELETE FROM lite_execution_trees;
      `);
    });
  }

  async close(): Promise<void> {
    try {
      if (this.ownsReadDatabase) this.readDb.close();
    } finally {
      if (this.ownsDatabase) this.db.close();
    }
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

export function createLiteExecutionTreeStoreFromDatabase(
  database: SqliteDatabase,
  options: {
    path: string;
    transaction: SqliteTransactionRunner;
    readDatabase?: SqliteDatabase;
  },
): LiteExecutionTreeStore {
  const readDatabase = options.readDatabase ?? createLiteRuntimeReadDatabase(options.path);
  return new LiteExecutionTreeStore(options.path, {
    database,
    readDatabase,
    closeReadDatabaseOnClose: options.readDatabase == null,
    transaction: options.transaction,
    transactionMode: "external",
  });
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
