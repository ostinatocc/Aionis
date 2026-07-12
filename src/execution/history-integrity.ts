import type { SqliteDatabase } from "../store/sqlite.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { stableJson } from "../util/stable-json.js";
import {
  ExecutionStateTransitionV1Schema,
  applyExecutionStateTransition,
  type ExecutionStateTransitionV1,
} from "./transitions.js";
import {
  ExecutionTreeOperationV1Schema,
  ExecutionTreeV1Schema,
  applyExecutionTreeOperationV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "./tree.js";
import {
  ExecutionStateV1Schema,
  type ExecutionStateV1,
} from "./types.js";

export type ExecutionHistoryResourceKind = "execution_state" | "execution_tree";

type ExecutionHistoryAuditConfig = {
  resourceKind: ExecutionHistoryResourceKind;
  projectionTable: string;
  eventTable: string;
  resourceIdColumn: "state_id" | "tree_id";
  projectionJsonColumn: "state_json" | "tree_json";
  projectionLastTypeColumn: "last_transition_type" | "last_operation_type";
  projectionLastAtColumn: "last_transition_at" | "last_operation_at";
  eventIdColumn: "transition_id" | "operation_id";
  eventTypeColumn: "transition_type" | "operation_type";
  eventAtColumn: "transition_at" | "operation_at";
  eventJsonColumn: "transition_json" | "operation_json";
  eventAfterJsonColumn: "state_after_json" | "tree_after_json";
  uniqueRevisionIndex: string;
};

type DuplicateRevisionRow = {
  scope: string;
  resource_id: string;
  revision: number;
  event_count: number;
};

type ProjectionRow = {
  scope: string;
  resource_id: string;
  projection_json: string;
  projection_revision: number;
  projection_last_type: string | null;
  projection_last_at: string | null;
};

type EventRow = {
  scope: string;
  resource_id: string;
  event_id: string;
  revision: number;
  event_type: string;
  event_at: string;
  actor_role: string | null;
  expected_revision: number | null;
  event_json: string;
  event_after_json: string;
};

type ParsedProjection = {
  canonical: string;
  sha256: string;
  scope: string;
  resourceId: string;
  value: ExecutionStateV1 | ExecutionTreeV1;
};

type ParsedEvent = {
  row: EventRow;
  eventCanonical: string;
  eventAfterCanonical: string;
  eventAfterSha256: string;
  scope: string;
  resourceId: string;
  eventId: string;
  type: string;
  at: string;
  actorRole: string | null;
  expectedRevision: number | null;
  afterScope: string;
  afterResourceId: string;
  afterUpdatedAt: string;
  event: ExecutionStateTransitionV1 | ExecutionTreeOperationV1;
  after: ExecutionStateV1 | ExecutionTreeV1;
};

type ParsedHistory = {
  latest: ParsedEvent;
  nextRevision: number;
};

export type ExecutionHistoryViolation = {
  kind: string;
  scope?: string;
  resource_id?: string;
  revision?: number;
  [key: string]: unknown;
};

const MAX_REPORTED_VIOLATIONS = 20;

function resourceLabel(kind: ExecutionHistoryResourceKind): string {
  return kind === "execution_state" ? "execution state" : "execution tree";
}

function resourceKey(scope: string, resourceId: string): string {
  return `${scope}\u0000${resourceId}`;
}

function pushViolation(
  violations: ExecutionHistoryViolation[],
  violation: ExecutionHistoryViolation,
): void {
  if (violations.length < MAX_REPORTED_VIOLATIONS) violations.push(violation);
}

export function executionHistoryCorruptError(args: {
  resourceKind: ExecutionHistoryResourceKind;
  databasePath: string;
  violations: ExecutionHistoryViolation[];
}): HttpError {
  return new HttpError(
    500,
    "execution_history_corrupt",
    `${resourceLabel(args.resourceKind)} history is inconsistent`,
    {
      contract: "execution_history_integrity_v1",
      resource_kind: args.resourceKind,
      database_path: args.databasePath,
      violation_count: args.violations.length,
      violations: args.violations.slice(0, MAX_REPORTED_VIOLATIONS),
    },
  );
}

function parseCanonicalJson(value: string): { raw: unknown; canonical: string; sha256: string } {
  const raw = JSON.parse(value) as unknown;
  const canonical = stableJson(raw);
  return { raw, canonical, sha256: sha256Hex(canonical) };
}

function auditDuplicateRevisions(
  db: SqliteDatabase,
  config: ExecutionHistoryAuditConfig,
): ExecutionHistoryViolation[] {
  const rows = db.prepare<DuplicateRevisionRow>(`
    SELECT
      scope,
      ${config.resourceIdColumn} AS resource_id,
      revision,
      COUNT(*) AS event_count
    FROM ${config.eventTable}
    GROUP BY scope, ${config.resourceIdColumn}, revision
    HAVING COUNT(*) > 1
    ORDER BY scope ASC, ${config.resourceIdColumn} ASC, revision ASC
    LIMIT ${MAX_REPORTED_VIOLATIONS}
  `).all() as DuplicateRevisionRow[];
  return rows.map((row) => ({
    kind: "duplicate_revision",
    scope: row.scope,
    resource_id: row.resource_id,
    revision: Number(row.revision),
    event_count: Number(row.event_count),
  }));
}

function loadProjectionRows(db: SqliteDatabase, config: ExecutionHistoryAuditConfig): ProjectionRow[] {
  return db.prepare<ProjectionRow>(`
    SELECT
      scope,
      ${config.resourceIdColumn} AS resource_id,
      ${config.projectionJsonColumn} AS projection_json,
      revision AS projection_revision,
      ${config.projectionLastTypeColumn} AS projection_last_type,
      ${config.projectionLastAtColumn} AS projection_last_at
    FROM ${config.projectionTable}
    ORDER BY scope ASC, ${config.resourceIdColumn} ASC
  `).all() as ProjectionRow[];
}

function loadEventRows(db: SqliteDatabase, config: ExecutionHistoryAuditConfig): EventRow[] {
  return db.prepare<EventRow>(`
    SELECT
      scope,
      ${config.resourceIdColumn} AS resource_id,
      ${config.eventIdColumn} AS event_id,
      revision,
      ${config.eventTypeColumn} AS event_type,
      ${config.eventAtColumn} AS event_at,
      actor_role,
      expected_revision,
      ${config.eventJsonColumn} AS event_json,
      ${config.eventAfterJsonColumn} AS event_after_json
    FROM ${config.eventTable}
    ORDER BY scope ASC, ${config.resourceIdColumn} ASC, revision ASC, ${config.eventIdColumn} ASC
  `).all() as EventRow[];
}

function parseProjection(
  row: ProjectionRow,
  config: ExecutionHistoryAuditConfig,
): ParsedProjection {
  const parsed = parseCanonicalJson(row.projection_json);
  if (config.resourceKind === "execution_state") {
    const value = ExecutionStateV1Schema.parse(parsed.raw);
    return {
      canonical: parsed.canonical,
      sha256: parsed.sha256,
      scope: value.scope,
      resourceId: value.state_id,
      value,
    };
  }
  const value = ExecutionTreeV1Schema.parse(parsed.raw);
  return {
    canonical: parsed.canonical,
    sha256: parsed.sha256,
    scope: value.scope,
    resourceId: value.tree_id,
    value,
  };
}

function parseEvent(row: EventRow, config: ExecutionHistoryAuditConfig): ParsedEvent {
  const parsedEvent = parseCanonicalJson(row.event_json);
  const parsedAfter = parseCanonicalJson(row.event_after_json);
  if (config.resourceKind === "execution_state") {
    const event = ExecutionStateTransitionV1Schema.parse(parsedEvent.raw);
    const after = ExecutionStateV1Schema.parse(parsedAfter.raw);
    return {
      row,
      eventCanonical: parsedEvent.canonical,
      eventAfterCanonical: parsedAfter.canonical,
      eventAfterSha256: parsedAfter.sha256,
      scope: event.scope,
      resourceId: event.state_id,
      eventId: event.transition_id,
      type: event.type,
      at: event.at,
      actorRole: event.actor_role,
      expectedRevision: event.expected_revision ?? null,
      afterScope: after.scope,
      afterResourceId: after.state_id,
      afterUpdatedAt: after.updated_at,
      event,
      after,
    };
  }
  const event = ExecutionTreeOperationV1Schema.parse(parsedEvent.raw);
  const after = ExecutionTreeV1Schema.parse(parsedAfter.raw);
  return {
    row,
    eventCanonical: parsedEvent.canonical,
    eventAfterCanonical: parsedAfter.canonical,
    eventAfterSha256: parsedAfter.sha256,
    scope: event.scope,
    resourceId: event.tree_id,
    eventId: event.operation_id,
    type: event.type,
    at: event.at,
    actorRole: event.actor_role,
    expectedRevision: event.expected_revision ?? null,
    afterScope: after.scope,
    afterResourceId: after.tree_id,
    afterUpdatedAt: after.updated_at,
    event,
    after,
  };
}

function applyEventToAfter(
  previous: ParsedEvent,
  current: ParsedEvent,
  config: ExecutionHistoryAuditConfig,
): string {
  if (config.resourceKind === "execution_state") {
    return stableJson(applyExecutionStateTransition(
      previous.after as ExecutionStateV1,
      current.event as ExecutionStateTransitionV1,
    ));
  }
  return stableJson(applyExecutionTreeOperationV1(
    previous.after as ExecutionTreeV1,
    current.event as ExecutionTreeOperationV1,
  ));
}

function auditExecutionHistory(
  db: SqliteDatabase,
  config: ExecutionHistoryAuditConfig,
): ExecutionHistoryViolation[] {
  const violations: ExecutionHistoryViolation[] = [];
  const projectionRows = loadProjectionRows(db, config);
  const eventRows = loadEventRows(db, config);
  const projectionByKey = new Map(projectionRows.map((row) => [
    resourceKey(row.scope, row.resource_id),
    row,
  ]));
  const parsedProjectionByKey = new Map<string, ParsedProjection>();
  const parsedHistoryByKey = new Map<string, ParsedHistory>();

  for (const row of projectionRows) {
    const key = resourceKey(row.scope, row.resource_id);
    try {
      const parsed = parseProjection(row, config);
      parsedProjectionByKey.set(key, parsed);
      if (parsed.scope !== row.scope || parsed.resourceId !== row.resource_id) {
        pushViolation(violations, {
          kind: "projection_identity_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision: Number(row.projection_revision),
          json_scope: parsed.scope,
          json_resource_id: parsed.resourceId,
        });
      }
    } catch {
      pushViolation(violations, {
        kind: "invalid_projection_json",
        scope: row.scope,
        resource_id: row.resource_id,
        revision: Number(row.projection_revision),
      });
    }
  }

  for (const row of eventRows) {
    const key = resourceKey(row.scope, row.resource_id);
    if (!projectionByKey.has(key)) {
      pushViolation(violations, {
        kind: "orphan_event",
        scope: row.scope,
        resource_id: row.resource_id,
        revision: Number(row.revision),
        event_id: row.event_id,
      });
    }

    let parsedEventJson: { raw: unknown; canonical: string; sha256: string };
    try {
      parsedEventJson = parseCanonicalJson(row.event_json);
      if (config.resourceKind === "execution_state") {
        ExecutionStateTransitionV1Schema.parse(parsedEventJson.raw);
      } else {
        ExecutionTreeOperationV1Schema.parse(parsedEventJson.raw);
      }
    } catch {
      pushViolation(violations, {
        kind: "invalid_event_json",
        scope: row.scope,
        resource_id: row.resource_id,
        revision: Number(row.revision),
        event_id: row.event_id,
      });
      continue;
    }

    try {
      const parsed = parseEvent(row, config);

      if (
        parsed.scope !== row.scope
        || parsed.resourceId !== row.resource_id
        || parsed.eventId !== row.event_id
      ) {
        pushViolation(violations, {
          kind: "event_identity_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision: Number(row.revision),
          event_id: row.event_id,
          json_scope: parsed.scope,
          json_resource_id: parsed.resourceId,
          json_event_id: parsed.eventId,
        });
      }

      const rowExpectedRevision = row.expected_revision == null ? null : Number(row.expected_revision);
      if (
        parsed.type !== row.event_type
        || parsed.at !== row.event_at
        || parsed.actorRole !== row.actor_role
        || parsed.expectedRevision !== rowExpectedRevision
      ) {
        pushViolation(violations, {
          kind: "event_metadata_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision: Number(row.revision),
          event_id: row.event_id,
          row_type: row.event_type,
          json_type: parsed.type,
          row_at: row.event_at,
          json_at: parsed.at,
          row_actor_role: row.actor_role,
          json_actor_role: parsed.actorRole,
          row_expected_revision: rowExpectedRevision,
          json_expected_revision: parsed.expectedRevision,
        });
      }
      if (
        parsed.expectedRevision != null
        && parsed.expectedRevision !== Number(row.revision) - 1
      ) {
        pushViolation(violations, {
          kind: "event_revision_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision: Number(row.revision),
          event_id: row.event_id,
          expected_revision: parsed.expectedRevision,
          required_expected_revision: Number(row.revision) - 1,
        });
      }
      if (parsed.afterScope !== row.scope || parsed.afterResourceId !== row.resource_id) {
        pushViolation(violations, {
          kind: "event_after_identity_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision: Number(row.revision),
          event_id: row.event_id,
          after_scope: parsed.afterScope,
          after_resource_id: parsed.afterResourceId,
        });
      }
      if (parsed.afterUpdatedAt !== parsed.at) {
        pushViolation(violations, {
          kind: "event_after_metadata_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision: Number(row.revision),
          event_id: row.event_id,
          event_at: parsed.at,
          after_updated_at: parsed.afterUpdatedAt,
        });
      }

      const history = parsedHistoryByKey.get(key);
      const revision = Number(row.revision);
      const requiredRevision = history?.nextRevision ?? 2;
      if (revision !== requiredRevision) {
        pushViolation(violations, {
          kind: "revision_gap",
          scope: row.scope,
          resource_id: row.resource_id,
          revision,
          required_revision: requiredRevision,
          event_id: row.event_id,
        });
      }
      if (history && revision === Number(history.latest.row.revision) + 1) {
        try {
          const expectedAfter = applyEventToAfter(history.latest, parsed, config);
          if (expectedAfter !== stableJson(parsed.after)) {
            pushViolation(violations, {
              kind: "event_chain_mismatch",
              scope: row.scope,
              resource_id: row.resource_id,
              revision,
              event_id: row.event_id,
              expected_after_sha256: sha256Hex(expectedAfter),
              event_after_sha256: parsed.eventAfterSha256,
            });
          }
        } catch {
          pushViolation(violations, {
            kind: "event_chain_invalid",
            scope: row.scope,
            resource_id: row.resource_id,
            revision,
            event_id: row.event_id,
          });
        }
      }
      parsedHistoryByKey.set(key, {
        latest: parsed,
        nextRevision: revision + 1,
      });
    } catch {
      pushViolation(violations, {
        kind: "invalid_event_after_json",
        scope: row.scope,
        resource_id: row.resource_id,
        revision: Number(row.revision),
        event_id: row.event_id,
      });
    }
  }

  for (const row of projectionRows) {
    const key = resourceKey(row.scope, row.resource_id);
    const revision = Number(row.projection_revision);
    const history = parsedHistoryByKey.get(key) ?? null;
    const latestEvent = history?.latest ?? null;
    const parsedProjection = parsedProjectionByKey.get(key) ?? null;

    if (revision === 1) {
      if (history) {
        pushViolation(violations, {
          kind: "projection_event_revision_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision,
          latest_event_revision: Number(latestEvent?.row.revision ?? 0),
        });
      }
      if (row.projection_last_type != null || row.projection_last_at != null) {
        pushViolation(violations, {
          kind: "projection_metadata_mismatch",
          scope: row.scope,
          resource_id: row.resource_id,
          revision,
          projection_last_type: row.projection_last_type,
          projection_last_at: row.projection_last_at,
          event_type: null,
          event_at: null,
        });
      }
      continue;
    }

    if (!history) {
      pushViolation(violations, {
        kind: "revision_gap",
        scope: row.scope,
        resource_id: row.resource_id,
        revision: 2,
        required_revision: 2,
        projection_revision: revision,
      });
    } else if (history.nextRevision <= revision) {
      pushViolation(violations, {
        kind: "revision_gap",
        scope: row.scope,
        resource_id: row.resource_id,
        revision: history.nextRevision,
        required_revision: history.nextRevision,
        projection_revision: revision,
      });
    }
    if (!latestEvent || Number(latestEvent.row.revision) !== revision) {
      pushViolation(violations, {
        kind: "projection_event_revision_mismatch",
        scope: row.scope,
        resource_id: row.resource_id,
        revision,
        latest_event_revision: latestEvent ? Number(latestEvent.row.revision) : null,
      });
      continue;
    }
    if (parsedProjection && parsedProjection.canonical !== latestEvent.eventAfterCanonical) {
      pushViolation(violations, {
        kind: "projection_after_state_mismatch",
        scope: row.scope,
        resource_id: row.resource_id,
        revision,
        projection_sha256: parsedProjection.sha256,
        event_after_sha256: latestEvent.eventAfterSha256,
      });
    }
    if (
      row.projection_last_type !== latestEvent.row.event_type
      || row.projection_last_at !== latestEvent.row.event_at
    ) {
      pushViolation(violations, {
        kind: "projection_metadata_mismatch",
        scope: row.scope,
        resource_id: row.resource_id,
        revision,
        projection_last_type: row.projection_last_type,
        projection_last_at: row.projection_last_at,
        event_type: latestEvent.row.event_type,
        event_at: latestEvent.row.event_at,
      });
    }
  }

  return violations;
}

/**
 * Audits legacy history before installing the revision uniqueness invariant.
 * The write lock keeps another connection from changing history between the
 * audit and index creation. Corruption is reported and never repaired.
 */
export function installExecutionHistoryRevisionInvariant(
  db: SqliteDatabase,
  databasePath: string,
  config: ExecutionHistoryAuditConfig,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const duplicateViolations = auditDuplicateRevisions(db, config);
    if (duplicateViolations.length > 0) {
      throw executionHistoryCorruptError({
        resourceKind: config.resourceKind,
        databasePath,
        violations: duplicateViolations,
      });
    }

    const historyViolations = auditExecutionHistory(db, config);
    if (historyViolations.length > 0) {
      throw executionHistoryCorruptError({
        resourceKind: config.resourceKind,
        databasePath,
        violations: historyViolations,
      });
    }

    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${config.uniqueRevisionIndex}
          ON ${config.eventTable}(scope, ${config.resourceIdColumn}, revision)
      `);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unique|constraint/i.test(message)) {
        throw executionHistoryCorruptError({
          resourceKind: config.resourceKind,
          databasePath,
          violations: [{
            kind: "revision_uniqueness_install_failed",
            database_error: message,
          }],
        });
      }
      throw error;
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the integrity failure that triggered the rollback.
    }
    throw error;
  }
}
