import type { SqliteDatabase } from "./sqlite.js";
import {
  LITE_RUNTIME_AUTHORITY_IDENTITY_COLUMNS,
  LITE_RUNTIME_AUTHORITY_IDENTITY_TABLE_SQL,
  LITE_TENANT_SCOPE_ENCODING_ANCHOR_COLUMNS,
  LITE_TENANT_SCOPE_ENCODING_ANCHOR_TABLE_SQL,
} from "./lite-runtime-identity.js";
import {
  LITE_MEMORY_COMMIT_SCOPE_REVISION_INDEX_SQL,
  LITE_MEMORY_SCOPE_HEAD_TABLE_SQL,
} from "./lite-memory-commit-authority.js";
import {
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_COLUMNS,
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE_SQL,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_COLUMNS,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE_SQL,
  LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS,
} from "./lite-runtime-authority-adoption-contract.js";
import {
  LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES,
  LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS,
} from "./lite-execution-episode-schema.js";
import {
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEXES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES,
  LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGERS,
} from "./lite-execution-verifier-launch-schema.js";
import {
  LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_COLUMNS,
  LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_CONSTRAINTS,
} from "./lite-execution-semantic-event-schema.js";
import {
  LITE_EXECUTION_SESSION_V10_REQUIRED_COLUMNS,
  LITE_EXECUTION_SESSION_V10_REQUIRED_CONSTRAINTS,
  LITE_EXECUTION_SESSION_V10_REQUIRED_INDEXES,
  LITE_EXECUTION_SESSION_V10_REQUIRED_TRIGGERS,
} from "./lite-execution-session-schema.js";
import { normalizeSqliteSchemaSql } from "./sqlite-schema-sql.js";

export const LITE_RUNTIME_WRITE_SCHEMA_COMPONENT = "write_projection";
export const LITE_RUNTIME_WRITE_SCHEMA_VERSION = 11;

export type LiteRuntimeSchemaClassification =
  | "uninitialized"
  | "legacy_v0_3_4"
  | "supported_previous_v2"
  | "supported_previous_v3"
  | "supported_previous_v4"
  | "supported_previous_v5"
  | "supported_previous_v6"
  | "supported_previous_v7"
  | "supported_previous_v8"
  | "supported_previous_v9"
  | "supported_previous_v10"
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
  table_definition_problems: string[];
  index_problems: string[];
  trigger_problems: string[];
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
  sql?: string;
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
  sql?: string;
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
    sql: `CREATE INDEX idx_lite_memory_projection_jobs_lease
      ON lite_memory_projection_jobs(lease_expires_at)
      WHERE status = 'running'`,
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

// Historical v3/v4 added experiment tables. They are intentionally outside
// the product schema now; existing databases may retain them as unowned data.
export const WRITE_SCHEMA_V3: LiteRuntimeWriteSchemaContract = WRITE_SCHEMA_V2;
export const WRITE_SCHEMA_V4: LiteRuntimeWriteSchemaContract = WRITE_SCHEMA_V2;

// Schema v5 makes commit order explicit without rewriting or pretending to
// authenticate historical v1 commits. Migrated rows remain digest_version=1
// with null revision/digest fields; the first v2 mutation records an explicit,
// unauthenticated legacy boundary and creates the forward authority head.
export const WRITE_SCHEMA_V5: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...WRITE_SCHEMA_V4.columns,
    lite_memory_commits: [
      ...WRITE_SCHEMA_V4.columns.lite_memory_commits,
      "digest_version",
      "revision",
      "mutation_digest",
      "legacy_anchor_commit_id",
    ],
    lite_memory_scope_heads: [
      "scope",
      "commit_id",
      "revision",
      "updated_at",
    ],
  },
  constraints: {
    ...WRITE_SCHEMA_V4.constraints,
    lite_memory_scope_heads: {
      primaryKey: ["scope"],
      sql: LITE_MEMORY_SCOPE_HEAD_TABLE_SQL,
    },
  },
  indexes: {
    ...WRITE_SCHEMA_V4.indexes,
    idx_lite_memory_commits_scope_revision: {
      table: "lite_memory_commits",
      columns: [{ name: "scope" }, { name: "revision" }],
      unique: true,
      partial: true,
      predicate: "revision IS NOT NULL",
      sql: LITE_MEMORY_COMMIT_SCOPE_REVISION_INDEX_SQL,
    },
  },
  triggers: WRITE_SCHEMA_V4.triggers,
};

// Schema v6 removes the open-ended v1/delegated terminal-row exceptions.
// A v5 upgrade may preserve those rows only through one immutable, per-scope
// adoption manifest whose exact row bindings are authenticated by a normal v2
// authority commit. Fresh v6 writes must be claimed directly.
export const WRITE_SCHEMA_V6: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...WRITE_SCHEMA_V5.columns,
    [LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE]:
      LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_COLUMNS,
    [LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE]:
      LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_COLUMNS,
  },
  constraints: {
    ...WRITE_SCHEMA_V5.constraints,
    [LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE]: {
      primaryKey: ["scope"],
      uniqueKeys: [["manifest_id"], ["scope", "manifest_id"]],
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE_SQL,
    },
    [LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE]: {
      primaryKey: ["scope", "authority_table", "identity_sha256"],
      uniqueKeys: [["scope", "authority_table", "identity_json"]],
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE_SQL,
    },
  },
  indexes: WRITE_SCHEMA_V5.indexes,
  triggers: {
    ...WRITE_SCHEMA_V5.triggers,
    trg_lite_runtime_authority_adoption_manifest_sealed_after_v6: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_manifest_sealed_after_v6,
    },
    trg_lite_runtime_authority_adoption_binding_sealed_after_v6: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_binding_sealed_after_v6,
    },
    trg_lite_runtime_authority_adoption_manifest_no_update: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_manifest_no_update,
    },
    trg_lite_runtime_authority_adoption_manifest_no_delete: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_manifest_no_delete,
    },
    trg_lite_runtime_authority_adoption_binding_no_update: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_binding_no_update,
    },
    trg_lite_runtime_authority_adoption_binding_no_delete: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_binding_no_delete,
    },
    trg_lite_runtime_authority_adoption_binding_frozen_after_manifest: {
      table: LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
      sql: LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS
        .trg_lite_runtime_authority_adoption_binding_frozen_after_manifest,
    },
  },
};

const V7_EXECUTION_EPISODE_CONSTRAINTS = Object.fromEntries(
  Object.entries(LITE_EXECUTION_EPISODE_V7_REQUIRED_CONSTRAINTS).map(
    ([table, requirement]) => [
      table,
      {
        primaryKey: requirement.primaryKey,
        uniqueKeys: requirement.uniqueKeys,
        sql: requirement.sql,
      } satisfies RequiredTableConstraint,
    ],
  ),
);

// Schema v7 adds the generic, verifier-bound execution episode truth stream
// and tenant-scoped content-addressed artifacts. Existing learning events
// remain specialized projections and are linked by immutable IDs.
export const WRITE_SCHEMA_V7: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...WRITE_SCHEMA_V6.columns,
    ...LITE_EXECUTION_EPISODE_V7_REQUIRED_COLUMNS,
  },
  constraints: {
    ...WRITE_SCHEMA_V6.constraints,
    ...V7_EXECUTION_EPISODE_CONSTRAINTS,
  },
  indexes: {
    ...WRITE_SCHEMA_V6.indexes,
    ...LITE_EXECUTION_EPISODE_V7_REQUIRED_INDEXES,
  },
  triggers: {
    ...WRITE_SCHEMA_V6.triggers,
    ...LITE_EXECUTION_EPISODE_V7_REQUIRED_TRIGGERS,
  },
};

const V8_VERIFIER_LAUNCH_CONSTRAINTS = Object.fromEntries(
  Object.entries(
    LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_CONSTRAINTS,
  ).map(([table, requirement]) => [
    table,
    {
      primaryKey: requirement.primaryKey,
      uniqueKeys: requirement.uniqueKeys,
      sql: requirement.sql,
    } satisfies RequiredTableConstraint,
  ]),
);

// Schema v8 makes every real verifier launch attempt durable before process
// execution and gives completed or interrupted attempts one immutable terminal.
export const WRITE_SCHEMA_V8: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...WRITE_SCHEMA_V7.columns,
    ...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_COLUMNS,
  },
  constraints: {
    ...WRITE_SCHEMA_V7.constraints,
    ...V8_VERIFIER_LAUNCH_CONSTRAINTS,
  },
  indexes: {
    ...WRITE_SCHEMA_V7.indexes,
    ...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_INDEXES,
  },
  triggers: {
    ...WRITE_SCHEMA_V7.triggers,
    ...LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TRIGGERS,
  },
};

const V9_SEMANTIC_EVENT_CONSTRAINTS = Object.fromEntries(
  Object.entries(
    LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_CONSTRAINTS,
  ).map(([table, requirement]) => [
    table,
    {
      primaryKey: requirement.primaryKey,
      uniqueKeys: requirement.uniqueKeys,
      sql: requirement.sql,
    } satisfies RequiredTableConstraint,
  ]),
);

// Schema v9 extends the authoritative episode hash-chain with evidence-bound
// observation, decision, progress, and planned-action semantics. No parallel
// semantic log is introduced.
export const WRITE_SCHEMA_V9: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...WRITE_SCHEMA_V8.columns,
    ...LITE_EXECUTION_SEMANTIC_EVENTS_V9_REQUIRED_COLUMNS,
  },
  constraints: {
    ...WRITE_SCHEMA_V8.constraints,
    ...V9_SEMANTIC_EVENT_CONSTRAINTS,
  },
  indexes: WRITE_SCHEMA_V8.indexes,
  triggers: WRITE_SCHEMA_V8.triggers,
};

const V10_EXECUTION_SESSION_CONSTRAINTS = Object.fromEntries(
  Object.entries(
    LITE_EXECUTION_SESSION_V10_REQUIRED_CONSTRAINTS,
  ).map(([table, requirement]) => [
    table,
    {
      primaryKey: requirement.primaryKey,
      uniqueKeys: requirement.uniqueKeys,
      sql: requirement.sql,
    } satisfies RequiredTableConstraint,
  ]),
);

// Schema v10 adds one durable, CAS-governed session/continuation lease over
// the existing authoritative episode and CurrentExecutionState streams.
export const WRITE_SCHEMA_V10: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...WRITE_SCHEMA_V9.columns,
    ...LITE_EXECUTION_SESSION_V10_REQUIRED_COLUMNS,
  },
  constraints: {
    ...WRITE_SCHEMA_V9.constraints,
    ...V10_EXECUTION_SESSION_CONSTRAINTS,
  },
  indexes: {
    ...WRITE_SCHEMA_V9.indexes,
    ...LITE_EXECUTION_SESSION_V10_REQUIRED_INDEXES,
  },
  triggers: {
    ...WRITE_SCHEMA_V9.triggers,
    ...LITE_EXECUTION_SESSION_V10_REQUIRED_TRIGGERS,
  },
};

const V11_OBSOLETE_PRODUCT_TABLES = new Set([
  "lite_execution_learning_links",
]);

function withoutObsoleteProductTables<T>(
  values: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name]) => !V11_OBSOLETE_PRODUCT_TABLES.has(name),
    ),
  );
}

function withoutObsoleteProductTableObjects<T extends { table: string }>(
  values: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, requirement]) =>
        !V11_OBSOLETE_PRODUCT_TABLES.has(requirement.table),
    ),
  );
}

// Schema v11 removes old experiment/measurement linkage from the product
// contract and gives Runtime identity plus tenant-scope encoding their own
// storage.
export const WRITE_SCHEMA_V11: LiteRuntimeWriteSchemaContract = {
  columns: {
    ...withoutObsoleteProductTables(WRITE_SCHEMA_V10.columns),
    lite_runtime_authority_identity:
      LITE_RUNTIME_AUTHORITY_IDENTITY_COLUMNS,
    lite_tenant_scope_encoding_anchor:
      LITE_TENANT_SCOPE_ENCODING_ANCHOR_COLUMNS,
  },
  constraints: {
    ...withoutObsoleteProductTables(WRITE_SCHEMA_V10.constraints),
    lite_runtime_authority_identity: {
      primaryKey: ["singleton"],
      uniqueKeys: [["database_instance_id"]],
      sql: LITE_RUNTIME_AUTHORITY_IDENTITY_TABLE_SQL,
    },
    lite_tenant_scope_encoding_anchor: {
      primaryKey: ["singleton"],
      sql: LITE_TENANT_SCOPE_ENCODING_ANCHOR_TABLE_SQL,
    },
  },
  indexes: withoutObsoleteProductTableObjects(WRITE_SCHEMA_V10.indexes),
  triggers: withoutObsoleteProductTableObjects(WRITE_SCHEMA_V10.triggers),
};

const ACTIVE_WRITE_SCHEMA_TARGET: LiteRuntimeSchemaInspectionTarget = {
  currentVersion: LITE_RUNTIME_WRITE_SCHEMA_VERSION,
  contracts: {
    2: WRITE_SCHEMA_V2,
    3: WRITE_SCHEMA_V3,
    4: WRITE_SCHEMA_V4,
    5: WRITE_SCHEMA_V5,
    6: WRITE_SCHEMA_V6,
    7: WRITE_SCHEMA_V7,
    8: WRITE_SCHEMA_V8,
    9: WRITE_SCHEMA_V9,
    10: WRITE_SCHEMA_V10,
    11: WRITE_SCHEMA_V11,
  },
  supportedPreviousVersions: [2, 3, 4, 5, 6, 7, 8, 9, 10],
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

function collectTableDefinitionProblems(
  db: SqliteDatabase,
  tables: Set<string>,
  requirements: Readonly<Record<string, RequiredTableConstraint>>,
): string[] {
  const problems: string[] = [];
  const statement = db.prepare(
    `SELECT sql
     FROM sqlite_schema
     WHERE type = 'table' AND name = ?`,
  );
  for (const [table, requirement] of Object.entries(requirements)) {
    if (!tables.has(table) || !requirement.sql) continue;
    const row = statement.get(table) as { sql: string | null } | undefined;
    if (!row?.sql || normalizeSqliteSchemaSql(row.sql) !== normalizeSqliteSchemaSql(requirement.sql)) {
      problems.push(`${table} CREATE TABLE definition does not match the required contract`);
    }
  }
  return problems;
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

    if (requirement.sql) {
      const schemaRow = db.prepare(
        `SELECT sql
         FROM sqlite_schema
         WHERE type = 'index' AND name = ?`,
      ).get(indexName) as { sql: string | null } | undefined;
      if (!schemaRow?.sql
        || normalizeSqliteSchemaSql(schemaRow.sql) !== normalizeSqliteSchemaSql(requirement.sql)) {
        problems.push(requirement.predicate
          ? `${indexName} predicate mismatch: expected WHERE ${requirement.predicate}`
          : `${indexName} definition does not match the required contract`);
      }
    } else if (requirement.predicate) {
      problems.push(`${indexName} predicate contract is missing its full SQL definition`);
    }
  }
  return problems;
}

function collectTriggerProblems(
  db: SqliteDatabase,
  tables: Set<string>,
  requirements: Readonly<Record<string, RequiredTrigger>>,
): string[] {
  const problems: string[] = [];
  const statement = db.prepare(
    `SELECT tbl_name AS table_name, sql
     FROM sqlite_schema
     WHERE type = 'trigger' AND name = ?`,
  );
  for (const [triggerName, requirement] of Object.entries(requirements)) {
    if (!tables.has(requirement.table)) continue;
    const row = statement.get(triggerName) as { table_name: string; sql: string | null } | undefined;
    if (!row) {
      problems.push(`${requirement.table} is missing required trigger ${triggerName}`);
      continue;
    }
    if (row.table_name !== requirement.table) {
      problems.push(`${triggerName} table mismatch: expected ${requirement.table}, found ${row.table_name}`);
      continue;
    }
    if (!row.sql || normalizeSqliteSchemaSql(row.sql) !== normalizeSqliteSchemaSql(requirement.sql)) {
      problems.push(`${triggerName} definition does not match the required contract`);
    }
  }
  return problems;
}

export type LiteRuntimeSchemaContractShapeReport = {
  missing_tables: string[];
  missing_columns: Record<string, string[]>;
  constraint_problems: string[];
  table_definition_problems: string[];
  index_problems: string[];
  trigger_problems: string[];
};

export function inspectLiteRuntimeSchemaContractShape(
  db: SqliteDatabase,
  contract: LiteRuntimeWriteSchemaContract,
): LiteRuntimeSchemaContractShapeReport {
  const tables = userTables(db);
  const missing = collectMissing(db, tables, contract.columns);
  return {
    missing_tables: missing.missingTables,
    missing_columns: missing.missingColumns,
    constraint_problems: collectConstraintProblems(db, tables, contract.constraints),
    table_definition_problems: collectTableDefinitionProblems(db, tables, contract.constraints),
    index_problems: collectIndexProblems(db, tables, contract.indexes),
    trigger_problems: collectTriggerProblems(db, tables, contract.triggers),
  };
}

export function assertLiteRuntimeSchemaContractShape(
  db: SqliteDatabase,
  contract: LiteRuntimeWriteSchemaContract,
): void {
  const report = inspectLiteRuntimeSchemaContractShape(db, contract);
  if (
    report.missing_tables.length > 0
    || Object.keys(report.missing_columns).length > 0
    || report.constraint_problems.length > 0
    || report.table_definition_problems.length > 0
    || report.index_problems.length > 0
    || report.trigger_problems.length > 0
  ) {
    throw new Error(`lite_runtime_schema_target_shape_failed:${JSON.stringify(report)}`);
  }
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
  const tableDefinitionProblems = detectedContract
    ? collectTableDefinitionProblems(db, tables, detectedContract.constraints)
    : [];
  const indexProblems = detectedContract
    ? collectIndexProblems(db, tables, detectedContract.indexes)
    : [];
  const triggerProblems = detectedContract
    ? collectTriggerProblems(db, tables, detectedContract.triggers)
    : [];

  const v6OnlyObjectsPresent = (detectedVersion ?? 0) < 6
    && target.currentVersion >= 6
    && (tables.has(LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE)
      || tables.has(LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE));
  if (v6OnlyObjectsPresent) {
    problems.push(
      "schema metadata is older than v6 but v6 authority-adoption objects already exist",
    );
  }

  const v7OnlyObjectsPresent = (detectedVersion ?? 0) < 7
    && target.currentVersion >= 7
    && LITE_EXECUTION_EPISODE_V7_REQUIRED_TABLE_NAMES.some(
      (table) => tables.has(table),
    );
  if (v7OnlyObjectsPresent) {
    problems.push(
      "schema metadata is older than v7 but v7 execution-episode objects already exist",
    );
  }

  const v8OnlyObjectsPresent = (detectedVersion ?? 0) < 8
    && target.currentVersion >= 8
    && LITE_EXECUTION_VERIFIER_LAUNCH_V8_REQUIRED_TABLE_NAMES.some(
      (table) => tables.has(table),
    );
  if (v8OnlyObjectsPresent) {
    problems.push(
      "schema metadata is older than v8 but v8 verifier-launch objects already exist",
    );
  }

  const v10OnlyObjectsPresent = (detectedVersion ?? 0) < 10
    && target.currentVersion >= 10
    && Object.keys(LITE_EXECUTION_SESSION_V10_REQUIRED_COLUMNS).some(
      (table) => tables.has(table),
    );
  if (v10OnlyObjectsPresent) {
    problems.push(
      "schema metadata is older than v10 but v10 execution-session objects already exist",
    );
  }

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
  if (tableDefinitionProblems.length > 0) {
    problems.push("current write schema table definitions do not match the required contract");
  }
  if (indexProblems.length > 0) {
    problems.push("current write schema critical indexes do not match the required contract");
  }
  if (triggerProblems.length > 0) {
    problems.push("current write schema critical triggers do not match the required contract");
  }

  const incompatible = problems.length > 0;
  const classification: LiteRuntimeSchemaClassification = incompatible
    ? "incompatible"
    : !hasWriteSchema
      ? "uninitialized"
      : detectedVersion === target.currentVersion
        ? "current"
        : detectedVersion === 10 && target.supportedPreviousVersions.includes(10)
          ? "supported_previous_v10"
          : detectedVersion === 9 && target.supportedPreviousVersions.includes(9)
          ? "supported_previous_v9"
          : detectedVersion === 8 && target.supportedPreviousVersions.includes(8)
            ? "supported_previous_v8"
          : detectedVersion === 7 && target.supportedPreviousVersions.includes(7)
            ? "supported_previous_v7"
            : detectedVersion === 6 && target.supportedPreviousVersions.includes(6)
            ? "supported_previous_v6"
            : detectedVersion === 5 && target.supportedPreviousVersions.includes(5)
              ? "supported_previous_v5"
              : detectedVersion === 4 && target.supportedPreviousVersions.includes(4)
                ? "supported_previous_v4"
                : detectedVersion === 3 && target.supportedPreviousVersions.includes(3)
                  ? "supported_previous_v3"
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
      || classification === "supported_previous_v3"
      || classification === "supported_previous_v4"
      || classification === "supported_previous_v5"
      || classification === "supported_previous_v6"
      || classification === "supported_previous_v7"
      || classification === "supported_previous_v8"
      || classification === "supported_previous_v9"
      || classification === "supported_previous_v10"
      || classification === "uninitialized",
    user_table_count: tables.size,
    missing_tables: [...selectedMissing.missingTables].sort(),
    missing_columns: selectedMissing.missingColumns,
    constraint_problems: constraintProblems,
    table_definition_problems: tableDefinitionProblems,
    index_problems: indexProblems,
    trigger_problems: triggerProblems,
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
