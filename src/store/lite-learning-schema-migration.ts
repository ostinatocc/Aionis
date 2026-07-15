import { LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS } from
  "./lite-learning-episode-ledger.js";
import type { SqliteDatabase } from "./sqlite.js";
import { normalizeSqliteSchemaSql } from "./sqlite-schema-sql.js";

const ACTIVE_LEASE_TRIGGER_NAME = "trg_lite_learning_eligible_active_lease";
const V4_SERVING_PREDICATE = String.raw`      AND (NEW.promotion_eligible = 0 AND NEW.served_arm = 'control' OR NEW.promotion_eligible = 1 AND NEW.served_arm = NEW.assignment_arm)
      AND (NEW.promotion_eligible = 0 OR NEW.recorded_at >= lease.activation_starts_at AND NEW.recorded_at <= lease.index_window_ends_at)`;
const V3_WINDOW_PREDICATE = String.raw`      AND NEW.recorded_at >= lease.activation_starts_at
      AND NEW.recorded_at <= lease.index_window_ends_at`;

function replaceExactlyOnce(value: string, before: string, after: string): string {
  const offset = value.indexOf(before);
  if (offset < 0 || value.indexOf(before, offset + before.length) >= 0) {
    throw new Error("active-lease trigger migration predicate is not unique");
  }
  return `${value.slice(0, offset)}${after}${value.slice(offset + before.length)}`;
}

const currentActiveLeaseTrigger =
  LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS[ACTIVE_LEASE_TRIGGER_NAME];
if (!currentActiveLeaseTrigger) {
  throw new Error("current active-lease trigger contract is missing");
}

// Runtime schema v4 changes only this predicate. Deriving the legacy contract
// from the current trigger ensures every unrelated clause must remain exact.
export const LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL = replaceExactlyOnce(
  currentActiveLeaseTrigger.sql,
  V4_SERVING_PREDICATE,
  V3_WINDOW_PREDICATE,
);

export const LITE_LEARNING_LEDGER_V3_REQUIRED_TRIGGERS = Object.freeze({
  ...LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS,
  [ACTIVE_LEASE_TRIGGER_NAME]: Object.freeze({
    table: currentActiveLeaseTrigger.table,
    sql: LITE_LEARNING_V3_ELIGIBLE_ACTIVE_LEASE_TRIGGER_SQL,
  }),
});

export function migrateLiteLearningEpisodeLedgerV3ToV4(db: SqliteDatabase): void {
  const before = db.prepare(
    `SELECT type, tbl_name AS table_name, sql
     FROM sqlite_schema WHERE name = ?`,
  ).get(ACTIVE_LEASE_TRIGGER_NAME) as {
    type: string;
    table_name: string;
    sql: string | null;
  } | undefined;
  const legacy = LITE_LEARNING_LEDGER_V3_REQUIRED_TRIGGERS[ACTIVE_LEASE_TRIGGER_NAME];
  if (before?.type !== "trigger"
    || before.table_name !== legacy.table
    || before.sql === null
    || normalizeSqliteSchemaSql(before.sql) !== normalizeSqliteSchemaSql(legacy.sql)) {
    throw new Error("lite_runtime_v3_to_v4_active_lease_trigger_precondition_failed");
  }

  db.exec(`DROP TRIGGER ${ACTIVE_LEASE_TRIGGER_NAME}`);
  db.exec(currentActiveLeaseTrigger.sql);

  const after = db.prepare(
    `SELECT type, tbl_name AS table_name, sql
     FROM sqlite_schema WHERE name = ?`,
  ).get(ACTIVE_LEASE_TRIGGER_NAME) as {
    type: string;
    table_name: string;
    sql: string | null;
  } | undefined;
  if (after?.type !== "trigger"
    || after.table_name !== currentActiveLeaseTrigger.table
    || after.sql === null
    || normalizeSqliteSchemaSql(after.sql) !== normalizeSqliteSchemaSql(currentActiveLeaseTrigger.sql)) {
    throw new Error("lite_runtime_v3_to_v4_active_lease_trigger_verification_failed");
  }
}
