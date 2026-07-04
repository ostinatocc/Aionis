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
import { stableJson } from "../util/stable-json.js";

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
  get(scope: string, stateId: string): StoredExecutionStateV1 | null;
  put(stateInput: ExecutionStateV1): StoredExecutionStateV1;
  listByScope(scope: string): StoredExecutionStateV1[];
  applyTransition(transitionInput: ExecutionStateTransitionV1): StoredExecutionStateV1;
  has(scope: string, stateId: string): boolean;
};

type LiteExecutionStateRow = {
  state_json: string;
  revision: number;
  last_transition_type: string | null;
  last_transition_at: string | null;
};

type LiteExecutionTransitionRow = {
  transition_json: string;
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

export class LiteExecutionStateStore implements ExecutionStateStore {
  private readonly db: SqliteDatabase;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = createSqliteDatabase(path);
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
  }

  get(scope: string, stateId: string): StoredExecutionStateV1 | null {
    const row = this.db.prepare<LiteExecutionStateRow>(`
      SELECT state_json, revision, last_transition_type, last_transition_at
      FROM lite_execution_states
      WHERE scope = ? AND state_id = ?
    `).get(scope, stateId);
    return row ? rowToStoredExecutionState(row) : null;
  }

  put(stateInput: ExecutionStateV1): StoredExecutionStateV1 {
    const state = ExecutionStateV1Schema.parse(stateInput);
    const existing = this.get(state.scope, state.state_id);
    const next = StoredExecutionStateV1Schema.parse({
      state,
      revision: existing?.revision ?? 1,
      last_transition_type: existing?.last_transition_type ?? null,
      last_transition_at: existing?.last_transition_at ?? null,
    });
    const now = new Date().toISOString();
    this.db.prepare(`
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
      ON CONFLICT(scope, state_id) DO UPDATE SET
        state_json = excluded.state_json,
        revision = excluded.revision,
        last_transition_type = excluded.last_transition_type,
        last_transition_at = excluded.last_transition_at,
        updated_at = excluded.updated_at
    `).run(
      state.scope,
      state.state_id,
      JSON.stringify(next.state),
      next.revision,
      next.last_transition_type,
      next.last_transition_at,
      now,
      now,
    );
    return next;
  }

  listByScope(scope: string): StoredExecutionStateV1[] {
    const rows = this.db.prepare<LiteExecutionStateRow>(`
      SELECT state_json, revision, last_transition_type, last_transition_at
      FROM lite_execution_states
      WHERE scope = ?
      ORDER BY state_id ASC
    `).all(scope);
    return rows.map(rowToStoredExecutionState);
  }

  private getTransition(scope: string, stateId: string, transitionId: string): ExecutionStateTransitionV1 | null {
    const row = this.db.prepare<LiteExecutionTransitionRow>(`
      SELECT transition_json
      FROM lite_execution_state_transitions
      WHERE scope = ? AND state_id = ? AND transition_id = ?
    `).get(scope, stateId, transitionId);
    return row ? ExecutionStateTransitionV1Schema.parse(JSON.parse(row.transition_json)) : null;
  }

  applyTransition(transitionInput: ExecutionStateTransitionV1): StoredExecutionStateV1 {
    const transition = ExecutionStateTransitionV1Schema.parse(transitionInput);
    const existing = this.get(transition.scope, transition.state_id);
    if (!existing) {
      throw new Error(`execution state not found for transition: ${transition.scope}/${transition.state_id}`);
    }
    const previousTransition = this.getTransition(transition.scope, transition.state_id, transition.transition_id);
    if (previousTransition) {
      if (!sameTransitionIntent(previousTransition, transition)) {
        throw new Error(`execution state transition id conflict: ${transition.scope}/${transition.state_id}/${transition.transition_id}`);
      }
      return existing;
    }
    if (transition.expected_revision != null && transition.expected_revision !== existing.revision) {
      throw new Error(`execution state revision mismatch: expected ${transition.expected_revision}, got ${existing.revision}`);
    }

    const nextState = applyExecutionStateTransition(existing.state, transition);
    const next = StoredExecutionStateV1Schema.parse({
      state: nextState,
      revision: existing.revision + 1,
      last_transition_type: transition.type,
      last_transition_at: transition.at,
    });
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE lite_execution_states
        SET
          state_json = ?,
          revision = ?,
          last_transition_type = ?,
          last_transition_at = ?,
          updated_at = ?
        WHERE scope = ? AND state_id = ? AND revision = ?
      `).run(
        JSON.stringify(next.state),
        next.revision,
        next.last_transition_type,
        next.last_transition_at,
        now,
        transition.scope,
        transition.state_id,
        existing.revision,
      );
      const updated = this.get(transition.scope, transition.state_id);
      if (!updated || updated.revision !== next.revision) {
        throw new Error(`execution state concurrent revision update failed for ${transition.scope}/${transition.state_id}`);
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
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  has(scope: string, stateId: string): boolean {
    const row = this.db.prepare<{ present: number }>(`
      SELECT 1 AS present
      FROM lite_execution_states
      WHERE scope = ? AND state_id = ?
      LIMIT 1
    `).get(scope, stateId);
    return !!row;
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM lite_execution_state_transitions;
      DELETE FROM lite_execution_states;
    `);
  }

  async close(): Promise<void> {
    this.db.close();
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
