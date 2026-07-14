import type { SqliteDatabase } from "./sqlite.js";

export const LITE_RUNTIME_WRITE_SCHEMA_COMPONENT = "write_projection";
export const LITE_RUNTIME_WRITE_SCHEMA_VERSION = 2;

export type LiteRuntimeSchemaClassification =
  | "uninitialized"
  | "legacy_v0_3_4"
  | "supported_previous_v2"
  | "current"
  | "incompatible";

export type LiteRuntimeSchemaReport = {
  contract_version: "aionis_lite_runtime_schema_report_v1";
  classification: LiteRuntimeSchemaClassification;
  component: typeof LITE_RUNTIME_WRITE_SCHEMA_COMPONENT;
  detected_version: number | null;
  current_version: number;
  upgrade_required: boolean;
  user_table_count: number;
  missing_tables: string[];
  missing_columns: Record<string, string[]>;
  constraint_problems: string[];
  index_problems: string[];
  problems: string[];
};

const LEGACY_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  lite_memory_commits: [
    "id",
    "scope",
    "parent_commit_id",
    "input_sha256",
    "diff_json",
    "actor",
    "model_version",
    "prompt_version",
    "commit_hash",
    "created_at",
  ],
  lite_memory_nodes: [
    "id",
    "scope",
    "client_id",
    "type",
    "tier",
    "title",
    "text_summary",
    "slots_json",
    "raw_ref",
    "evidence_ref",
    "embedding_vector_json",
    "embedding_model",
    "memory_lane",
    "producer_agent_id",
    "owner_agent_id",
    "owner_team_id",
    "embedding_status",
    "embedding_last_error",
    "salience",
    "importance",
    "confidence",
    "redaction_version",
    "commit_id",
    "created_at",
  ],
  lite_memory_edges: [
    "id",
    "scope",
    "type",
    "src_id",
    "dst_id",
    "weight",
    "confidence",
    "decay_rate",
    "metadata_json",
    "commit_id",
    "created_at",
  ],
};

const CURRENT_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  ...LEGACY_REQUIRED_COLUMNS,
  lite_memory_execution_native_index: [
    "scope",
    "node_id",
    "execution_kind",
    "anchor_kind",
    "pattern_state",
    "task_signature",
    "task_family",
    "error_signature",
    "workflow_signature",
    "pattern_signature",
    "repo_signature",
    "file_cluster",
    "target_files_text",
    "tool_chain_signature",
    "failure_mode",
    "verification_signature",
    "acceptance_check_signature",
    "compression_layer",
    "created_at",
    "updated_at",
  ],
  lite_memory_keyword_index: [
    "scope",
    "node_id",
    "title",
    "text_summary",
    "slots_text",
    "searchable_text",
    "updated_at",
  ],
  lite_memory_rule_defs: [
    "rule_node_id",
    "scope",
    "state",
    "if_json",
    "then_json",
    "exceptions_json",
    "rule_scope",
    "target_agent_id",
    "target_team_id",
    "positive_count",
    "negative_count",
    "commit_id",
    "created_at",
    "updated_at",
  ],
  lite_memory_association_candidates: [
    "id",
    "scope",
    "src_id",
    "dst_id",
    "relation_kind",
    "status",
    "score",
    "confidence",
    "feature_summary_json",
    "evidence_json",
    "source_commit_id",
    "worker_run_id",
    "promoted_edge_id",
    "created_at",
    "updated_at",
  ],
  lite_memory_outbox: [
    "row_id",
    "scope",
    "commit_id",
    "event_type",
    "job_key",
    "payload_sha256",
    "payload_json",
    "created_at",
  ],
  lite_runtime_write_operations: [
    "tenant_id",
    "scope",
    "operation_kind",
    "operation_id",
    "request_sha256",
    "receipt_json",
    "commit_id",
    "created_at",
  ],
  lite_product_guide_receipts: [
    "tenant_id",
    "scope",
    "guide_trace_id",
    "run_id",
    "consumer_agent_id",
    "consumer_team_id",
    "query_sha256",
    "context_sha256",
    "ledger_sha256",
    "ledger_json",
    "commit_id",
    "created_at",
  ],
  lite_memory_execution_decisions: [
    "id",
    "scope",
    "decision_kind",
    "run_id",
    "selected_tool",
    "candidates_json",
    "context_sha256",
    "policy_sha256",
    "source_rule_ids_json",
    "metadata_json",
    "commit_id",
    "created_at",
  ],
  lite_memory_rule_feedback: [
    "id",
    "scope",
    "rule_node_id",
    "run_id",
    "outcome",
    "note",
    "source",
    "decision_id",
    "commit_id",
    "created_at",
  ],
  lite_memory_projection_jobs: [
    "scope",
    "node_id",
    "job_kind",
    "generation",
    "source_commit_id",
    "payload_sha256",
    "payload_json",
    "status",
    "attempt_count",
    "available_at",
    "lease_owner",
    "lease_token",
    "lease_expires_at",
    "last_error",
    "created_at",
    "updated_at",
  ],
};

export type RequiredTableConstraint = {
  primaryKey: readonly string[];
  uniqueKeys?: ReadonlyArray<readonly string[]>;
};

const LEGACY_REQUIRED_CONSTRAINTS: Record<string, RequiredTableConstraint> = {
  lite_memory_commits: {
    primaryKey: ["id"],
    uniqueKeys: [["commit_hash"]],
  },
  lite_memory_nodes: { primaryKey: ["id"] },
  lite_memory_edges: {
    primaryKey: ["id"],
    uniqueKeys: [["scope", "type", "src_id", "dst_id"]],
  },
};

const CURRENT_REQUIRED_CONSTRAINTS: Record<string, RequiredTableConstraint> = {
  ...LEGACY_REQUIRED_CONSTRAINTS,
  lite_runtime_schema_metadata: { primaryKey: ["component"] },
  lite_memory_execution_native_index: { primaryKey: ["scope", "node_id"] },
  lite_memory_keyword_index: { primaryKey: ["scope", "node_id"] },
  lite_memory_rule_defs: { primaryKey: ["rule_node_id"] },
  lite_memory_association_candidates: {
    primaryKey: ["id"],
    uniqueKeys: [["scope", "src_id", "dst_id", "relation_kind"]],
  },
  lite_memory_outbox: {
    primaryKey: ["row_id"],
    uniqueKeys: [["scope", "event_type", "job_key"]],
  },
  lite_runtime_write_operations: {
    primaryKey: ["tenant_id", "scope", "operation_kind", "operation_id"],
  },
  lite_product_guide_receipts: {
    primaryKey: ["tenant_id", "scope", "guide_trace_id"],
  },
  lite_memory_execution_decisions: { primaryKey: ["id"] },
  lite_memory_rule_feedback: { primaryKey: ["id"] },
  lite_memory_projection_jobs: {
    primaryKey: ["scope", "node_id", "job_kind"],
  },
};

export type RequiredIndexColumn = {
  name: string;
  descending?: boolean;
};

export type RequiredIndex = {
  table: string;
  columns: readonly RequiredIndexColumn[];
  unique?: boolean;
  partial?: boolean;
  predicate?: string;
};

const CURRENT_REQUIRED_INDEXES: Record<string, RequiredIndex> = {
  idx_lite_memory_outbox_event_created: {
    table: "lite_memory_outbox",
    columns: [
      { name: "event_type" },
      { name: "created_at" },
      { name: "row_id" },
    ],
  },
  idx_lite_runtime_write_operations_created: {
    table: "lite_runtime_write_operations",
    columns: [{ name: "created_at", descending: true }],
  },
  idx_lite_product_guide_receipts_scope_created: {
    table: "lite_product_guide_receipts",
    columns: [
      { name: "tenant_id" },
      { name: "scope" },
      { name: "created_at", descending: true },
      { name: "guide_trace_id", descending: true },
    ],
  },
  idx_lite_product_guide_receipts_run_created: {
    table: "lite_product_guide_receipts",
    columns: [
      { name: "tenant_id" },
      { name: "scope" },
      { name: "run_id" },
      { name: "created_at", descending: true },
      { name: "guide_trace_id", descending: true },
    ],
  },
  idx_lite_memory_projection_jobs_available: {
    table: "lite_memory_projection_jobs",
    columns: [
      { name: "status" },
      { name: "available_at" },
      { name: "job_kind" },
      { name: "updated_at" },
    ],
  },
  idx_lite_memory_projection_jobs_lease: {
    table: "lite_memory_projection_jobs",
    columns: [{ name: "lease_expires_at" }],
    partial: true,
    predicate: "status = 'running'",
  },
  idx_lite_memory_projection_jobs_scope_node: {
    table: "lite_memory_projection_jobs",
    columns: [{ name: "scope" }, { name: "node_id" }],
  },
};

export type RequiredTrigger = {
  table: string;
  sql: string;
};

export type LiteRuntimeWriteSchemaContract = {
  columns: Readonly<Record<string, readonly string[]>>;
  constraints: Readonly<Record<string, RequiredTableConstraint>>;
  indexes: Readonly<Record<string, RequiredIndex>>;
  triggers: Readonly<Record<string, RequiredTrigger>>;
};

export type LiteRuntimeSchemaInspectionTarget = {
  currentVersion: number;
  contracts: Readonly<Record<number, LiteRuntimeWriteSchemaContract>>;
  supportedPreviousVersions: readonly number[];
};

export const WRITE_SCHEMA_V2: LiteRuntimeWriteSchemaContract = {
  columns: CURRENT_REQUIRED_COLUMNS,
  constraints: CURRENT_REQUIRED_CONSTRAINTS,
  indexes: CURRENT_REQUIRED_INDEXES,
  triggers: {},
};

const ACTIVE_WRITE_SCHEMA_TARGET: LiteRuntimeSchemaInspectionTarget = {
  currentVersion: LITE_RUNTIME_WRITE_SCHEMA_VERSION,
  contracts: { [LITE_RUNTIME_WRITE_SCHEMA_VERSION]: WRITE_SCHEMA_V2 },
  supportedPreviousVersions: [],
};

function userTables(db: SqliteDatabase): Set<string> {
  const rows = db.prepare(
    `SELECT name
     FROM sqlite_schema
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

type TableInfoRow = {
  name: string;
  pk: number;
};

type IndexListRow = {
  name: string;
  unique: number;
  partial: number;
};

type IndexColumnRow = {
  seqno: number;
  name: string | null;
  desc: number;
  key: number;
};

function pragmaRows<T>(db: SqliteDatabase, pragma: string, objectName: string): T[] {
  const escaped = objectName.replaceAll("'", "''");
  return db.prepare(`PRAGMA ${pragma}('${escaped}')`).all() as T[];
}

function tableInfo(db: SqliteDatabase, table: string): TableInfoRow[] {
  return pragmaRows<TableInfoRow>(db, "table_info", table);
}

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  return new Set(tableInfo(db, table).map((row) => row.name));
}

function indexList(db: SqliteDatabase, table: string): IndexListRow[] {
  return pragmaRows<IndexListRow>(db, "index_list", table);
}

function indexColumns(db: SqliteDatabase, index: string): IndexColumnRow[] {
  return pragmaRows<IndexColumnRow>(db, "index_xinfo", index)
    .filter((row) => row.key === 1)
    .sort((left, right) => left.seqno - right.seqno);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatColumns(columns: readonly string[]): string {
  return `(${columns.join(", ")})`;
}

function collectConstraintProblems(
  db: SqliteDatabase,
  tables: Set<string>,
  requirements: Readonly<Record<string, RequiredTableConstraint>>,
): string[] {
  const problems: string[] = [];
  for (const [table, requirement] of Object.entries(requirements)) {
    if (!tables.has(table)) continue;
    const actualPrimaryKey = tableInfo(db, table)
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    if (!sameStrings(actualPrimaryKey, requirement.primaryKey)) {
      problems.push(
        `${table} primary key mismatch: expected ${formatColumns(requirement.primaryKey)}, found ${formatColumns(actualPrimaryKey)}`,
      );
    }

    const actualUniqueKeys = indexList(db, table)
      .filter((index) => index.unique === 1)
      .map((index) => indexColumns(db, index.name).map((column) => column.name ?? "<expression>"));
    for (const expected of requirement.uniqueKeys ?? []) {
      if (!actualUniqueKeys.some((actual) => sameStrings(actual, expected))) {
        problems.push(`${table} is missing unique constraint ${formatColumns(expected)}`);
      }
    }
  }
  return problems;
}

function normalizedSql(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function collectIndexProblems(
  db: SqliteDatabase,
  tables: Set<string>,
  requirements: Readonly<Record<string, RequiredIndex>>,
): string[] {
  const problems: string[] = [];
  for (const [indexName, requirement] of Object.entries(requirements)) {
    if (!tables.has(requirement.table)) continue;
    const row = indexList(db, requirement.table).find((index) => index.name === indexName);
    if (!row) {
      problems.push(`${requirement.table} is missing required index ${indexName}`);
      continue;
    }
    const expectedUnique = requirement.unique === true;
    const expectedPartial = requirement.partial === true;
    if ((row.unique === 1) !== expectedUnique) {
      problems.push(`${indexName} unique flag mismatch`);
    }
    if ((row.partial === 1) !== expectedPartial) {
      problems.push(`${indexName} partial flag mismatch`);
    }

    const actualColumns = indexColumns(db, indexName);
    const columnsMatch = actualColumns.length === requirement.columns.length
      && requirement.columns.every((expected, index) => {
        const actual = actualColumns[index];
        return actual?.name === expected.name
          && (actual.desc === 1) === (expected.descending === true);
      });
    if (!columnsMatch) {
      const expected = requirement.columns.map((column) => (
        `${column.name}${column.descending === true ? " DESC" : " ASC"}`
      ));
      const actual = actualColumns.map((column) => (
        `${column.name ?? "<expression>"}${column.desc === 1 ? " DESC" : " ASC"}`
      ));
      problems.push(
        `${indexName} columns mismatch: expected ${formatColumns(expected)}, found ${formatColumns(actual)}`,
      );
    }

    if (requirement.predicate) {
      const schemaRow = db.prepare(
        `SELECT sql
         FROM sqlite_schema
         WHERE type = 'index' AND name = ?`,
      ).get(indexName) as { sql: string | null } | undefined;
      const actualSql = schemaRow?.sql ? normalizedSql(schemaRow.sql) : "";
      const whereOffset = actualSql.indexOf(" where ");
      const actualPredicate = whereOffset >= 0 ? actualSql.slice(whereOffset + " where ".length) : "";
      if (actualPredicate !== normalizedSql(requirement.predicate)) {
        problems.push(`${indexName} predicate mismatch: expected WHERE ${requirement.predicate}`);
      }
    }
  }
  return problems;
}

function collectMissing(
  db: SqliteDatabase,
  tables: Set<string>,
  requirements: Readonly<Record<string, readonly string[]>>,
): { missingTables: string[]; missingColumns: Record<string, string[]> } {
  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};
  for (const [table, requiredColumns] of Object.entries(requirements)) {
    if (!tables.has(table)) {
      missingTables.push(table);
      continue;
    }
    const columns = tableColumns(db, table);
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) missingColumns[table] = missing;
  }
  return { missingTables, missingColumns };
}

function detectedComponentVersion(db: SqliteDatabase, tables: Set<string>): number | null {
  if (!tables.has("lite_runtime_schema_metadata")) return null;
  const columns = tableColumns(db, "lite_runtime_schema_metadata");
  for (const required of ["component", "version", "updated_at"]) {
    if (!columns.has(required)) {
      throw new Error(`schema metadata table is missing required column: ${required}`);
    }
  }
  const row = db.prepare(
    `SELECT version
     FROM lite_runtime_schema_metadata
     WHERE component = ?`,
  ).get(LITE_RUNTIME_WRITE_SCHEMA_COMPONENT) as { version: unknown } | undefined;
  if (!row) return null;
  const version = Number(row.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`invalid write schema version: ${String(row.version)}`);
  }
  return version;
}

function assertValidInspectionTarget(target: LiteRuntimeSchemaInspectionTarget): void {
  if (!Number.isInteger(target.currentVersion) || target.currentVersion < 1) {
    throw new Error("schema inspection target currentVersion must be a positive integer");
  }
  if (!target.contracts[target.currentVersion]) {
    throw new Error(`schema inspection target is missing contract v${target.currentVersion}`);
  }
  const seen = new Set<number>();
  for (const version of target.supportedPreviousVersions) {
    if (!Number.isInteger(version) || version < 1 || version >= target.currentVersion) {
      throw new Error(`invalid supported previous schema version: ${String(version)}`);
    }
    if (seen.has(version)) {
      throw new Error(`duplicate supported previous schema version: ${version}`);
    }
    if (!target.contracts[version]) {
      throw new Error(`schema inspection target is missing contract v${version}`);
    }
    seen.add(version);
  }
}

export function inspectLiteRuntimeSchemaAgainstTarget(
  db: SqliteDatabase,
  target: LiteRuntimeSchemaInspectionTarget,
): LiteRuntimeSchemaReport {
  assertValidInspectionTarget(target);
  const tables = userTables(db);
  const problems: string[] = [];
  let detectedVersion: number | null = null;
  try {
    detectedVersion = detectedComponentVersion(db, tables);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const hasWriteSchema = Object.keys(WRITE_SCHEMA_V2.columns).some((table) => tables.has(table));
  const detectedContract = detectedVersion === null
    ? hasWriteSchema
      ? {
          columns: LEGACY_REQUIRED_COLUMNS,
          constraints: LEGACY_REQUIRED_CONSTRAINTS,
          indexes: {},
          triggers: {},
        } satisfies LiteRuntimeWriteSchemaContract
      : null
    : target.contracts[detectedVersion] ?? null;
  const selectedMissing = detectedContract
    ? collectMissing(db, tables, detectedContract.columns)
    : { missingTables: [] as string[], missingColumns: {} as Record<string, string[]> };
  const constraintProblems = detectedContract
    ? collectConstraintProblems(db, tables, detectedContract.constraints)
    : [];
  const indexProblems = detectedContract
    ? collectIndexProblems(db, tables, detectedContract.indexes)
    : [];

  if (detectedVersion !== null && detectedVersion > target.currentVersion) {
    problems.push(
      `database write schema version ${detectedVersion} is newer than supported version ${target.currentVersion}`,
    );
  }
  if (
    detectedVersion !== null
    && detectedVersion < target.currentVersion
    && !target.supportedPreviousVersions.includes(detectedVersion)
  ) {
    problems.push(
      `database write schema version ${detectedVersion} is not a supported previous version for target ${target.currentVersion}`,
    );
  }
  if (detectedVersion !== null && detectedVersion <= target.currentVersion && !detectedContract) {
    problems.push(`database write schema version ${detectedVersion} has no validation contract`);
  }
  if (detectedVersion !== null && !hasWriteSchema) {
    problems.push("schema metadata exists but the write schema is missing");
  }
  if (selectedMissing.missingTables.length > 0 || Object.keys(selectedMissing.missingColumns).length > 0) {
    problems.push(
      detectedVersion === null
        ? "existing write schema does not match the supported v0.3.4 baseline"
        : detectedVersion === target.currentVersion
          ? "schema metadata declares current version but required current tables or columns are missing"
          : `schema metadata declares version ${detectedVersion} but its required tables or columns are missing`,
    );
  }
  if (constraintProblems.length > 0) {
    problems.push("write schema primary or unique constraints do not match the required contract");
  }
  if (indexProblems.length > 0) {
    problems.push("current write schema critical indexes do not match the required contract");
  }

  const incompatible = problems.length > 0;
  const classification: LiteRuntimeSchemaClassification = incompatible
    ? "incompatible"
    : !hasWriteSchema
      ? "uninitialized"
      : detectedVersion === target.currentVersion
        ? "current"
        : detectedVersion === 2 && target.supportedPreviousVersions.includes(2)
          ? "supported_previous_v2"
          : "legacy_v0_3_4";

  return {
    contract_version: "aionis_lite_runtime_schema_report_v1",
    classification,
    component: LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
    detected_version: detectedVersion,
    current_version: target.currentVersion,
    upgrade_required: classification === "legacy_v0_3_4"
      || classification === "supported_previous_v2"
      || classification === "uninitialized",
    user_table_count: tables.size,
    missing_tables: [...selectedMissing.missingTables].sort(),
    missing_columns: selectedMissing.missingColumns,
    constraint_problems: constraintProblems,
    index_problems: indexProblems,
    problems,
  };
}

export function inspectLiteRuntimeSchema(db: SqliteDatabase): LiteRuntimeSchemaReport {
  return inspectLiteRuntimeSchemaAgainstTarget(db, ACTIVE_WRITE_SCHEMA_TARGET);
}

export function assertLiteRuntimeSchemaPreflight(db: SqliteDatabase): LiteRuntimeSchemaReport {
  const report = inspectLiteRuntimeSchema(db);
  if (report.classification === "incompatible") {
    throw new Error(`lite_runtime_schema_preflight_failed:${JSON.stringify(report)}`);
  }
  return report;
}

export function recordCurrentLiteRuntimeWriteSchema(db: SqliteDatabase, now = new Date()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lite_runtime_schema_metadata (
      component TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (version >= 1)
    );
  `);
  db.prepare(
    `INSERT INTO lite_runtime_schema_metadata (component, version, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(component) DO UPDATE SET
       version = excluded.version,
       updated_at = excluded.updated_at`,
  ).run(
    LITE_RUNTIME_WRITE_SCHEMA_COMPONENT,
    LITE_RUNTIME_WRITE_SCHEMA_VERSION,
    now.toISOString(),
  );
}
