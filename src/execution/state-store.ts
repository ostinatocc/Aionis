import { z } from "zod";
import {
  CurrentExecutionEventRefV2Schema,
  CurrentExecutionStateProjectionTransitionV1Schema,
  CurrentExecutionStateV2Schema,
  ExecutionStateV1Schema,
  type CurrentExecutionEventRefV2,
  type CurrentExecutionStateProjectionTransitionV1,
  type CurrentExecutionStateV2,
  type ExecutionStateV1,
} from "./types.js";
import {
  ExecutionStateTransitionV1Schema,
  applyExecutionStateTransition,
  type ExecutionStateTransitionV1,
  type ExecutionTransitionType,
} from "./transitions.js";
import {
  assertPrivateRuntimeSqliteArtifactModes,
  createPrivateRuntimeSqliteDatabase,
  type SqliteDatabase,
} from "../store/sqlite.js";
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

export const StoredCurrentExecutionStateV2Schema = z.object({
  state: CurrentExecutionStateV2Schema,
  revision: z.number().int().positive(),
  last_projection_event_id: z.string().trim().min(1).nullable(),
  last_projected_at: z.string().datetime().nullable(),
}).strict().superRefine((value, context) => {
  if (value.revision !== value.state.revision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revision"],
      message: "Stored current-state revision must match the state",
    });
  }
  if (
    (value.revision === 1)
      !== (
        value.last_projection_event_id === null
        && value.last_projected_at === null
      )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["last_projection_event_id"],
      message:
        "Only the initial current-state revision may omit projection-event identity",
    });
  }
});
export type StoredCurrentExecutionStateV2 = z.infer<
  typeof StoredCurrentExecutionStateV2Schema
>;

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
  getCurrent(
    scope: string,
    continuationId: string,
  ): StoredCurrentExecutionStateV2 | null;
  initializeCurrent(
    state: CurrentExecutionStateV2,
  ): StoredCurrentExecutionStateV2;
  advanceCurrent(args: Readonly<{
    state: CurrentExecutionStateV2;
    sourceEvent: CurrentExecutionEventRefV2;
  }>): StoredCurrentExecutionStateV2;
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
  last_transition_id?: string | null;
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

type StoredCurrentExecutionProjectionEvent = {
  transition: CurrentExecutionStateProjectionTransitionV1;
  after: StoredCurrentExecutionStateV2;
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
      if (this.ownsDatabase) assertPrivateRuntimeSqliteArtifactModes(path);
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
        AND json_extract(state_json, '$.version') = 1
      ORDER BY state_id ASC
    `).all(scope);
    return rows.map(rowToStoredExecutionState);
  }

  getCurrent(
    scope: string,
    continuationId: string,
  ): StoredCurrentExecutionStateV2 | null {
    const row = this.queryDatabase().prepare<LiteExecutionStateRow>(`
      SELECT state.state_json,
             state.revision,
             state.last_transition_type,
             state.last_transition_at,
             (
               SELECT transition.transition_id
               FROM lite_execution_state_transitions AS transition
               WHERE transition.scope = state.scope
                 AND transition.state_id = state.state_id
                 AND transition.revision = state.revision
               LIMIT 1
             ) AS last_transition_id
      FROM lite_execution_states AS state
      WHERE state.scope = ? AND state.state_id = ?
        AND json_extract(
          state.state_json,
          '$.contract_version'
        ) = 'current_execution_state_v2'
    `).get(scope, continuationId);
    return row ? rowToStoredCurrentExecutionState(row) : null;
  }

  initializeCurrent(
    stateInput: CurrentExecutionStateV2,
  ): StoredCurrentExecutionStateV2 {
    const state = CurrentExecutionStateV2Schema.parse(stateInput);
    if (state.revision !== 1 || state.parent_state_sha256 !== null) {
      throw new HttpError(
        409,
        "current_execution_state_initial_revision_invalid",
        "Current execution state must initialize from revision one.",
      );
    }
    const next = StoredCurrentExecutionStateV2Schema.parse({
      state,
      revision: state.revision,
      last_projection_event_id: null,
      last_projected_at: null,
    });
    return this.mutate(() => {
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
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
        ON CONFLICT(scope, state_id) DO NOTHING
        RETURNING revision
      `).get(
        state.scope_id,
        state.continuation_id,
        JSON.stringify(state),
        state.revision,
        state.updated_at,
        state.updated_at,
      );
      if (inserted) return next;
      const existing = this.getCurrent(
        state.scope_id,
        state.continuation_id,
      );
      if (
        existing
        && existing.state.state_sha256 === state.state_sha256
      ) {
        return existing;
      }
      throw new HttpError(
        409,
        "current_execution_state_initialization_conflict",
        "Current execution state already has a different initial head.",
        {
          contract: "execution_conflict_v1",
          resource_kind: "current_execution_state",
          scope: state.scope_id,
          continuation_id: state.continuation_id,
          current_revision: existing?.revision ?? null,
          current_snapshot_sha256:
            existing?.state.state_sha256 ?? null,
          incoming_snapshot_sha256: state.state_sha256,
          retry_after_reload: true,
        },
      );
    });
  }

  private getCurrentProjection(
    scope: string,
    continuationId: string,
    eventId: string,
  ): StoredCurrentExecutionProjectionEvent | null {
    const row = this.db.prepare<LiteExecutionTransitionRow>(`
      SELECT transition_json, revision, transition_type, transition_at,
             state_after_json
      FROM lite_execution_state_transitions
      WHERE scope = ? AND state_id = ? AND transition_id = ?
    `).get(scope, continuationId, eventId);
    if (!row) return null;
    if (row.transition_type !== "current_state_projected") {
      throw executionHistoryCorruptError({
        resourceKind: "execution_state",
        databasePath: this.path,
        violations: [{
          kind: "invalid_transition_event",
          scope,
          resource_id: continuationId,
          transition_id: eventId,
          revision: Number(row.revision),
        }],
      });
    }
    try {
      const transition =
        CurrentExecutionStateProjectionTransitionV1Schema.parse(
          JSON.parse(row.transition_json),
        );
      return {
        transition,
        after: StoredCurrentExecutionStateV2Schema.parse({
          state: JSON.parse(row.state_after_json),
          revision: Number(row.revision),
          last_projection_event_id: transition.source_event.event_id,
          last_projected_at: row.transition_at,
        }),
      };
    } catch {
      throw executionHistoryCorruptError({
        resourceKind: "execution_state",
        databasePath: this.path,
        violations: [{
          kind: "invalid_transition_event",
          scope,
          resource_id: continuationId,
          transition_id: eventId,
          revision: Number(row.revision),
        }],
      });
    }
  }

  advanceCurrent(args: Readonly<{
    state: CurrentExecutionStateV2;
    sourceEvent: CurrentExecutionEventRefV2;
  }>): StoredCurrentExecutionStateV2 {
    const state = CurrentExecutionStateV2Schema.parse(args.state);
    const sourceEvent = CurrentExecutionEventRefV2Schema.parse(
      args.sourceEvent,
    );
    return this.mutate(() => {
      const existing = this.getCurrent(
        state.scope_id,
        state.continuation_id,
      );
      if (!existing) {
        throw new HttpError(
          409,
          "current_execution_state_missing",
          "Current execution state must be initialized before projection.",
        );
      }
      const prior = this.getCurrentProjection(
        state.scope_id,
        state.continuation_id,
        sourceEvent.event_id,
      );
      if (prior) {
        if (
          prior.transition.source_event.event_sha256
            !== sourceEvent.event_sha256
          || prior.transition.source_event.sequence !== sourceEvent.sequence
          || prior.transition.projected_state_sha256
            !== state.state_sha256
          || prior.after.state.state_sha256 !== state.state_sha256
        ) {
          throw new HttpError(
            409,
            "current_execution_state_projection_id_conflict",
            "Projection event is already bound to different state.",
          );
        }
        return prior.after;
      }
      if (
        state.revision !== existing.revision + 1
        || state.parent_state_sha256 !== existing.state.state_sha256
        || sourceEvent.sequence + 1 !== state.revision
      ) {
        throw new HttpError(
          409,
          "current_execution_state_revision_conflict",
          "Current execution state projection does not extend the exact head.",
          {
            contract: "execution_conflict_v1",
            resource_kind: "current_execution_state",
            scope: state.scope_id,
            continuation_id: state.continuation_id,
            expected_revision: existing.revision + 1,
            current_revision: existing.revision,
            current_snapshot_sha256: existing.state.state_sha256,
            incoming_parent_sha256: state.parent_state_sha256,
            retry_after_reload: true,
          },
        );
      }
      const transition =
        CurrentExecutionStateProjectionTransitionV1Schema.parse({
          contract_version:
            "current_execution_state_projection_transition_v1",
          continuation_id: state.continuation_id,
          source_event: sourceEvent,
          expected_revision: existing.revision,
          expected_state_sha256: existing.state.state_sha256,
          projected_revision: state.revision,
          projected_state_sha256: state.state_sha256,
          projected_at: state.updated_at,
        });
      const updated = this.db.prepare<{ revision: number }>(`
        UPDATE lite_execution_states
        SET state_json = ?,
            revision = ?,
            last_transition_type = 'current_state_projected',
            last_transition_at = ?,
            updated_at = ?
        WHERE scope = ? AND state_id = ? AND revision = ?
          AND json_extract(state_json, '$.state_sha256') = ?
        RETURNING revision
      `).get(
        JSON.stringify(state),
        state.revision,
        state.updated_at,
        state.updated_at,
        state.scope_id,
        state.continuation_id,
        existing.revision,
        existing.state.state_sha256,
      );
      if (!updated || updated.revision !== state.revision) {
        throw new HttpError(
          409,
          "current_execution_state_revision_conflict",
          "Current execution state changed before projection committed.",
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
        VALUES (?, ?, ?, ?, 'current_state_projected', ?, ?, ?, ?, ?, ?)
      `).run(
        state.scope_id,
        state.continuation_id,
        sourceEvent.event_id,
        state.revision,
        state.updated_at,
        "runtime_projector",
        existing.revision,
        JSON.stringify(transition),
        JSON.stringify(state),
        state.updated_at,
      );
      return StoredCurrentExecutionStateV2Schema.parse({
        state,
        revision: state.revision,
        last_projection_event_id: sourceEvent.event_id,
        last_projected_at: state.updated_at,
      });
    });
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

function rowToStoredCurrentExecutionState(
  row: LiteExecutionStateRow,
): StoredCurrentExecutionStateV2 {
  const state = CurrentExecutionStateV2Schema.parse(
    JSON.parse(row.state_json),
  );
  return StoredCurrentExecutionStateV2Schema.parse({
    state,
    revision: row.revision,
    last_projection_event_id:
      row.last_transition_type === "current_state_projected"
        ? row.last_transition_id ?? null
        : null,
    last_projected_at:
      row.last_transition_type === "current_state_projected"
        ? row.last_transition_at
        : null,
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
