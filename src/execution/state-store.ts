import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ExecutionStateV1Schema,
  type ExecutionStateV1,
} from "./types.js";
import {
  ExecutionStateTransitionV1Schema,
  applyExecutionStateTransition,
  type ExecutionStateTransitionV1,
  type ExecutionTransitionType,
} from "./transitions.js";
import { createSqliteDatabase, type SqliteDatabase } from "../store/sqlite.js";
import { createLiteRuntimeReadDatabase } from "../store/lite-runtime-database.js";
import type { SqliteTransactionRunner } from "../store/sqlite-transaction-runner.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { stableJson } from "../util/stable-json.js";
import {
  executionHistoryCorruptError,
  installExecutionHistoryRevisionInvariant,
} from "./history-integrity.js";

export const StoredExecutionStateV1Schema = z.object({
  state: ExecutionStateV1Schema,
  revision: z.number().int().positive(),
  last_transition_type: z.string().trim().min(1).nullable().default(null),
  last_transition_at: z.string().datetime().nullable().default(null),
});
export type StoredExecutionStateV1 = z.infer<typeof StoredExecutionStateV1Schema>;

export type ExecutionStateStoreHealthSnapshot = {
  path: string;
  mode: "sqlite_execution_state_v1";
};

export type ExecutionStateStore = {
  readonly transactionRunner: SqliteTransactionRunner | null;
  get(scope: string, stateId: string): StoredExecutionStateV1 | null;
  initialize(stateInput: ExecutionStateV1): StoredExecutionStateV1;
  /** @deprecated Use initialize. This method is create-only and never replaces an existing snapshot. */
  put(stateInput: ExecutionStateV1): StoredExecutionStateV1;
  listByScope(scope: string): StoredExecutionStateV1[];
  applyTransition(transitionInput: ExecutionStateTransitionV1): StoredExecutionStateV1;
  has(scope: string, stateId: string): boolean;
};

export type LiteExecutionStateStoreOptions = {
  database?: SqliteDatabase;
  readDatabase?: SqliteDatabase;
  closeReadDatabaseOnClose?: boolean;
  transactionMode?: "self_managed" | "external";
  transaction?: SqliteTransactionRunner;
};

type LiteExecutionStateRow = {
  state_json: string;
  revision: number;
  last_transition_type: string | null;
  last_transition_at: string | null;
};

type LiteExecutionTransitionRow = {
  transition_json: string;
  revision: number;
  transition_type: string;
  transition_at: string;
  state_after_json: string;
};

type StoredExecutionTransitionEvent = {
  transition: ExecutionStateTransitionV1;
  after: StoredExecutionStateV1;
};

function transitionIntent(value: ExecutionStateTransitionV1): Record<string, unknown> {
  const intent = { ...value } as Record<string, unknown>;
  delete intent.expected_revision;
  delete intent.at;
  return intent;
}

function sameTransitionIntent(left: ExecutionStateTransitionV1, right: ExecutionStateTransitionV1): boolean {
  return stableJson(transitionIntent(left)) === stableJson(transitionIntent(right));
}

function snapshotSha256(value: ExecutionStateV1): string {
  return sha256Hex(stableJson(value));
}

export class LiteExecutionStateStore implements ExecutionStateStore {
  private readonly db: SqliteDatabase;
  private readonly readDb: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly ownsReadDatabase: boolean;
  private readonly transactionMode: "self_managed" | "external";
  readonly transactionRunner: SqliteTransactionRunner | null;

  constructor(private readonly path: string, options: LiteExecutionStateStoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = options.database ?? createSqliteDatabase(path);
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
          "external execution state transactions require independent SQLite write/read connections and a transaction runner",
        );
      }
      this.db.exec(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS lite_execution_states (
          scope TEXT NOT NULL,
          state_id TEXT NOT NULL,
          state_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          last_transition_type TEXT,
          last_transition_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (scope, state_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lite_execution_states_scope_updated
          ON lite_execution_states(scope, updated_at DESC, state_id);

        CREATE TABLE IF NOT EXISTS lite_execution_state_transitions (
          scope TEXT NOT NULL,
          state_id TEXT NOT NULL,
          transition_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          transition_type TEXT NOT NULL,
          transition_at TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          expected_revision INTEGER,
          transition_json TEXT NOT NULL,
          state_after_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (scope, state_id, transition_id)
        );
        CREATE INDEX IF NOT EXISTS idx_lite_execution_state_transitions_state_revision
          ON lite_execution_state_transitions(scope, state_id, revision);
      `);
      installExecutionHistoryRevisionInvariant(this.db, this.path, {
        resourceKind: "execution_state",
        projectionTable: "lite_execution_states",
        eventTable: "lite_execution_state_transitions",
        resourceIdColumn: "state_id",
        projectionJsonColumn: "state_json",
        projectionLastTypeColumn: "last_transition_type",
        projectionLastAtColumn: "last_transition_at",
        eventIdColumn: "transition_id",
        eventTypeColumn: "transition_type",
        eventAtColumn: "transition_at",
        eventJsonColumn: "transition_json",
        eventAfterJsonColumn: "state_after_json",
        uniqueRevisionIndex: "idx_lite_execution_state_transitions_unique_revision",
      });
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
          "execution state mutation requires the owning SQLite transaction",
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

  get(scope: string, stateId: string): StoredExecutionStateV1 | null {
    const row = this.queryDatabase().prepare<LiteExecutionStateRow>(`
      SELECT state_json, revision, last_transition_type, last_transition_at
      FROM lite_execution_states
      WHERE scope = ? AND state_id = ?
    `).get(scope, stateId);
    return row ? rowToStoredExecutionState(row) : null;
  }

  initialize(stateInput: ExecutionStateV1): StoredExecutionStateV1 {
    const state = ExecutionStateV1Schema.parse(stateInput);
    const next = StoredExecutionStateV1Schema.parse({
      state,
      revision: 1,
      last_transition_type: null,
      last_transition_at: null,
    });
    return this.mutate(() => {
      const now = new Date().toISOString();
      const inserted = this.db.prepare<{ revision: number }>(`
        INSERT INTO lite_execution_states (
          scope,
          state_id,
          state_json,
          revision,
          last_transition_type,
          last_transition_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, state_id) DO NOTHING
        RETURNING revision
      `).get(
        state.scope,
        state.state_id,
        JSON.stringify(next.state),
        next.revision,
        next.last_transition_type,
        next.last_transition_at,
        now,
        now,
      );
      if (inserted) return next;

      const existing = this.get(state.scope, state.state_id);
      if (!existing) {
        throw new Error(`execution state initialization lost existing row: ${state.scope}/${state.state_id}`);
      }
      if (stableJson(existing.state) === stableJson(state)) return existing;
      throw new HttpError(
        409,
        "execution_state_snapshot_conflict",
        "execution state already exists with a different snapshot",
        {
          contract: "execution_conflict_v1",
          resource_kind: "execution_state",
          scope: state.scope,
          state_id: state.state_id,
          current_revision: existing.revision,
          current_snapshot_sha256: snapshotSha256(existing.state),
          incoming_snapshot_sha256: snapshotSha256(state),
          retry_after_reload: true,
        },
      );
    });
  }

  put(stateInput: ExecutionStateV1): StoredExecutionStateV1 {
    return this.initialize(stateInput);
  }

  listByScope(scope: string): StoredExecutionStateV1[] {
    const rows = this.queryDatabase().prepare<LiteExecutionStateRow>(`
      SELECT state_json, revision, last_transition_type, last_transition_at
      FROM lite_execution_states
      WHERE scope = ?
      ORDER BY state_id ASC
    `).all(scope);
    return rows.map(rowToStoredExecutionState);
  }

  private getTransition(
    scope: string,
    stateId: string,
    transitionId: string,
  ): StoredExecutionTransitionEvent | null {
    const row = this.db.prepare<LiteExecutionTransitionRow>(`
      SELECT transition_json, revision, transition_type, transition_at, state_after_json
      FROM lite_execution_state_transitions
      WHERE scope = ? AND state_id = ? AND transition_id = ?
    `).get(scope, stateId, transitionId);
    if (!row) return null;
    try {
      return {
        transition: ExecutionStateTransitionV1Schema.parse(JSON.parse(row.transition_json)),
        after: StoredExecutionStateV1Schema.parse({
          state: JSON.parse(row.state_after_json),
          revision: Number(row.revision),
          last_transition_type: row.transition_type,
          last_transition_at: row.transition_at,
        }),
      };
    } catch {
      throw executionHistoryCorruptError({
        resourceKind: "execution_state",
        databasePath: this.path,
        violations: [{
          kind: "invalid_transition_event",
          scope,
          resource_id: stateId,
          transition_id: transitionId,
          revision: Number(row.revision),
        }],
      });
    }
  }

  applyTransition(transitionInput: ExecutionStateTransitionV1): StoredExecutionStateV1 {
    const transition = ExecutionStateTransitionV1Schema.parse(transitionInput);
    return this.mutate(() => {
      const existing = this.get(transition.scope, transition.state_id);
      if (!existing) {
        throw new Error(`execution state not found for transition: ${transition.scope}/${transition.state_id}`);
      }
      const previousTransition = this.getTransition(transition.scope, transition.state_id, transition.transition_id);
      if (previousTransition) {
        if (!sameTransitionIntent(previousTransition.transition, transition)) {
          throw new HttpError(
            409,
            "execution_transition_id_conflict",
            "execution state transition id is already bound to a different intent",
            {
              contract: "execution_conflict_v1",
              resource_kind: "execution_state_transition",
              scope: transition.scope,
              state_id: transition.state_id,
              transition_id: transition.transition_id,
              current_revision: existing.revision,
              retry_after_reload: false,
            },
          );
        }
        return previousTransition.after;
      }
      if (transition.expected_revision == null) {
        throw new HttpError(
          409,
          "execution_state_expected_revision_required",
          "expected_revision is required when mutating an existing execution state",
          {
            contract: "execution_conflict_v1",
            resource_kind: "execution_state",
            scope: transition.scope,
            state_id: transition.state_id,
            transition_id: transition.transition_id,
            current_revision: existing.revision,
            retry_after_reload: true,
          },
        );
      }
      if (transition.expected_revision != null && transition.expected_revision !== existing.revision) {
        throw new HttpError(
          409,
          "execution_state_revision_conflict",
          `execution state revision mismatch: expected ${transition.expected_revision}, got ${existing.revision}`,
          {
            contract: "execution_conflict_v1",
            resource_kind: "execution_state",
            scope: transition.scope,
            state_id: transition.state_id,
            transition_id: transition.transition_id,
            expected_revision: transition.expected_revision,
            current_revision: existing.revision,
            retry_after_reload: true,
          },
        );
      }

      const nextState = applyExecutionStateTransition(existing.state, transition);
      const next = StoredExecutionStateV1Schema.parse({
        state: nextState,
        revision: existing.revision + 1,
        last_transition_type: transition.type,
        last_transition_at: transition.at,
      });
      const now = new Date().toISOString();
      const updated = this.db.prepare<{ revision: number }>(`
        UPDATE lite_execution_states
        SET
          state_json = ?,
          revision = ?,
          last_transition_type = ?,
          last_transition_at = ?,
          updated_at = ?
        WHERE scope = ? AND state_id = ? AND revision = ?
        RETURNING revision
      `).get(
        JSON.stringify(next.state),
        next.revision,
        next.last_transition_type,
        next.last_transition_at,
        now,
        transition.scope,
        transition.state_id,
        existing.revision,
      );
      if (!updated || updated.revision !== next.revision) {
        const current = this.get(transition.scope, transition.state_id);
        throw new HttpError(
          409,
          "execution_state_revision_conflict",
          "execution state changed before the transition could be committed",
          {
            contract: "execution_conflict_v1",
            resource_kind: "execution_state",
            scope: transition.scope,
            state_id: transition.state_id,
            transition_id: transition.transition_id,
            expected_revision: existing.revision,
            current_revision: current?.revision ?? null,
            retry_after_reload: true,
          },
        );
      }
      this.db.prepare(`
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        transition.scope,
        transition.state_id,
        transition.transition_id,
        next.revision,
        transition.type,
        transition.at,
        transition.actor_role,
        transition.expected_revision ?? null,
        JSON.stringify(transition),
        JSON.stringify(next.state),
        now,
      );
      return next;
    });
  }

  has(scope: string, stateId: string): boolean {
    const row = this.queryDatabase().prepare<{ present: number }>(`
      SELECT 1 AS present
      FROM lite_execution_states
      WHERE scope = ? AND state_id = ?
      LIMIT 1
    `).get(scope, stateId);
    return !!row;
  }

  clear(): void {
    this.mutate(() => {
      this.db.exec(`
        DELETE FROM lite_execution_state_transitions;
        DELETE FROM lite_execution_states;
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

  healthSnapshot(): ExecutionStateStoreHealthSnapshot {
    return {
      path: this.path,
      mode: "sqlite_execution_state_v1",
    };
  }
}

function rowToStoredExecutionState(row: LiteExecutionStateRow): StoredExecutionStateV1 {
  return StoredExecutionStateV1Schema.parse({
    state: JSON.parse(row.state_json),
    revision: row.revision,
    last_transition_type: row.last_transition_type,
    last_transition_at: row.last_transition_at,
  });
}

export function createLiteExecutionStateStore(path: string): LiteExecutionStateStore {
  return new LiteExecutionStateStore(path);
}

export function createLiteExecutionStateStoreFromDatabase(
  database: SqliteDatabase,
  options: {
    path: string;
    transaction: SqliteTransactionRunner;
    readDatabase?: SqliteDatabase;
  },
): LiteExecutionStateStore {
  const readDatabase = options.readDatabase ?? createLiteRuntimeReadDatabase(options.path);
  return new LiteExecutionStateStore(options.path, {
    database,
    readDatabase,
    closeReadDatabaseOnClose: options.readDatabase == null,
    transaction: options.transaction,
    transactionMode: "external",
  });
}

export function buildStoredExecutionState(
  stateInput: ExecutionStateV1,
  options: {
    revision?: number;
    lastTransitionType?: ExecutionTransitionType | null;
    lastTransitionAt?: string | null;
  } = {},
): StoredExecutionStateV1 {
  return StoredExecutionStateV1Schema.parse({
    state: stateInput,
    revision: options.revision ?? 1,
    last_transition_type: options.lastTransitionType ?? null,
    last_transition_at: options.lastTransitionAt ?? null,
  });
}
