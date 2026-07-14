import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createLiteExecutionStateStore } from "../execution/state-store.js";
import { createLiteExecutionTreeStore } from "../execution/tree-store.js";
import type { ExecutionHistoryViolation } from "../execution/history-integrity.js";
import { HttpError } from "../util/http.js";
import {
  parseAnnProjectionPayload,
  parseEmbeddingProjectionPayload,
  type LiteProjectionJobRow,
} from "./lite-projection-outbox.js";
import {
  assertLiteLearningEpisodeLedgerIntegrity,
  assertLiteRuntimeAuthorityIdentity,
} from "./lite-learning-episode-ledger.js";
import { createLiteWriteStore } from "./lite-write-store.js";
import { inspectLiteRuntimeSchema, type LiteRuntimeSchemaReport } from "./lite-runtime-schema.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export type LiteExecutionHistoryVerification = {
  ok: boolean;
  violation_count: number;
  violations: ExecutionHistoryViolation[];
};

export type LiteRuntimeDataVerification = {
  contract_version: "aionis_lite_runtime_data_verification_v1";
  path: string;
  ok: boolean;
  checked_at: string;
  byte_size: number;
  sha256: string;
  database_instance_id: string | null;
  quick_check: string[];
  foreign_key_violation_count: number;
  schema: LiteRuntimeSchemaReport;
  counts: {
    commits: number;
    nodes: number;
    edges: number;
    projection_jobs: number;
    projection_dead_letters: number;
    legacy_pending_without_job: number;
    guide_receipts: number;
    write_operations: number;
    rule_feedback: number;
    product_measurements: number;
    skill_reviews: number;
  };
  integrity_findings: {
    ready_embedding_invalid: number;
    node_commit_missing: number;
    edge_endpoint_missing: number;
    projection_payload_invalid: number;
    execution_state_history_invalid: number;
    execution_tree_history_invalid: number;
    learning_episode_ledger_invalid: number;
  };
  execution_history: {
    state: LiteExecutionHistoryVerification;
    tree: LiteExecutionHistoryVerification;
  };
  warnings: string[];
};

export type LiteRuntimeBackupManifest = {
  contract_version: "aionis_lite_runtime_backup_manifest_v1";
  created_at: string;
  database_file: string;
  byte_size: number;
  sha256: string;
  database_instance_id: string | null;
  schema_component: string;
  schema_version: number | null;
  counts: LiteRuntimeDataVerification["counts"];
};

type LiteRuntimePreservedCounts = Pick<
  LiteRuntimeDataVerification["counts"],
  | "commits"
  | "nodes"
  | "edges"
  | "guide_receipts"
  | "write_operations"
  | "rule_feedback"
  | "product_measurements"
  | "skill_reviews"
>;

export type LiteRuntimeUpgradeReport = {
  contract_version: "aionis_lite_runtime_upgrade_report_v1";
  path: string;
  before: LiteRuntimeSchemaReport;
  after: LiteRuntimeSchemaReport;
  preserved_counts: {
    before: LiteRuntimePreservedCounts;
    after: LiteRuntimePreservedCounts;
  };
};

export function preflightLiteRuntimeDatabase(path: string): {
  path: string;
  schema: LiteRuntimeSchemaReport;
} {
  const absolute = assertReadableDatabasePath(path);
  const db = createSqliteDatabase(absolute);
  try {
    return {
      path: absolute,
      schema: inspectLiteRuntimeSchema(db),
    };
  } finally {
    db.close();
  }
}

function assertReadableDatabasePath(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`SQLite database does not exist: ${absolute}`);
  if (!statSync(absolute).isFile()) throw new Error(`SQLite database path is not a file: ${absolute}`);
  return absolute;
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return !!db.prepare(
    `SELECT 1 AS ok
     FROM sqlite_schema
     WHERE type = 'table' AND name = ?`,
  ).get(table);
}

function scalarCount(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function semanticCounts(db: SqliteDatabase): LiteRuntimeDataVerification["counts"] {
  const count = (table: string): number => tableExists(db, table)
    ? scalarCount(db, `SELECT COUNT(*) AS count FROM ${table}`)
    : 0;
  const projectionTableExists = tableExists(db, "lite_memory_projection_jobs");
  const projectionJobs = projectionTableExists ? count("lite_memory_projection_jobs") : 0;
  return {
    commits: count("lite_memory_commits"),
    nodes: count("lite_memory_nodes"),
    edges: count("lite_memory_edges"),
    projection_jobs: projectionJobs,
    projection_dead_letters: projectionJobs > 0
      ? scalarCount(
          db,
          "SELECT COUNT(*) AS count FROM lite_memory_projection_jobs WHERE status = 'dead_letter'",
        )
      : 0,
    legacy_pending_without_job: !tableExists(db, "lite_memory_nodes")
      ? 0
      : !projectionTableExists
        ? scalarCount(
            db,
            "SELECT COUNT(*) AS count FROM lite_memory_nodes WHERE embedding_status = 'pending'",
          )
        : scalarCount(
            db,
            `SELECT COUNT(*) AS count
             FROM lite_memory_nodes AS node
             WHERE node.embedding_status = 'pending'
               AND NOT EXISTS (
                 SELECT 1
                 FROM lite_memory_projection_jobs AS job
                 WHERE job.scope = node.scope
                   AND job.node_id = node.id
                   AND job.job_kind = 'embedding_generate'
               )`,
          ),
    guide_receipts: count("lite_product_guide_receipts"),
    write_operations: count("lite_runtime_write_operations"),
    rule_feedback: count("lite_memory_rule_feedback"),
    product_measurements: count("lite_product_measurements"),
    skill_reviews: count("lite_skill_candidate_reviews"),
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function projectionPayloadInvalidCount(db: SqliteDatabase): number {
  if (!tableExists(db, "lite_memory_projection_jobs")) return 0;
  const rows = db.prepare(
    `SELECT scope, node_id, job_kind, generation, source_commit_id,
            payload_sha256, payload_json, status, attempt_count, available_at,
            lease_owner, lease_token, lease_expires_at, last_error, created_at, updated_at
     FROM lite_memory_projection_jobs
     WHERE status <> 'succeeded'`,
  ).all() as LiteProjectionJobRow[];
  return rows.filter((row) => (
    row.job_kind === "embedding_generate"
      ? parseEmbeddingProjectionPayload(row) === null
      : parseAnnProjectionPayload(row) === null
  )).length;
}

function historyAuditFailure(error: unknown): LiteExecutionHistoryVerification {
  if (error instanceof HttpError && error.code === "execution_history_corrupt") {
    const details = error.details && typeof error.details === "object"
      ? error.details as Record<string, unknown>
      : {};
    const violations = Array.isArray(details.violations)
      ? details.violations.filter(
          (value): value is ExecutionHistoryViolation => (
            value != null
            && typeof value === "object"
            && typeof (value as Record<string, unknown>).kind === "string"
          ),
        )
      : [];
    const reportedCount = Number(details.violation_count);
    return {
      ok: false,
      violation_count: Number.isInteger(reportedCount) && reportedCount > 0
        ? reportedCount
        : Math.max(violations.length, 1),
      violations,
    };
  }
  return {
    ok: false,
    violation_count: 1,
    violations: [{
      kind: "execution_history_audit_failed",
      error: error instanceof Error ? error.message : String(error),
    }],
  };
}

async function auditExecutionHistoryWithRuntimeStores(
  source: SqliteDatabase,
): Promise<LiteRuntimeDataVerification["execution_history"]> {
  const directory = mkdtempSync(join(tmpdir(), "aionis-runtime-history-verify-"));
  const snapshotPath = join(directory, "runtime.sqlite");
  try {
    // Store startup is the canonical full-history audit. Run it against a
    // transactionally consistent snapshot so verification never installs
    // tables or indexes into the operator's source database.
    vacuumInto(source, snapshotPath);

    let state: LiteExecutionHistoryVerification = {
      ok: true,
      violation_count: 0,
      violations: [],
    };
    try {
      const store = createLiteExecutionStateStore(snapshotPath);
      await store.close();
    } catch (error) {
      state = historyAuditFailure(error);
    }

    let tree: LiteExecutionHistoryVerification = {
      ok: true,
      violation_count: 0,
      violations: [],
    };
    try {
      const store = createLiteExecutionTreeStore(snapshotPath);
      await store.close();
    } catch (error) {
      tree = historyAuditFailure(error);
    }
    return { state, tree };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function verifyLiteRuntimeDatabase(path: string): Promise<LiteRuntimeDataVerification> {
  const absolute = assertReadableDatabasePath(path);
  const db = createSqliteDatabase(absolute);
  let quickCheck: string[];
  let foreignKeyViolationCount: number;
  let schema: LiteRuntimeSchemaReport;
  let counts: LiteRuntimeDataVerification["counts"];
  let readyEmbeddingInvalid = 0;
  let nodeCommitMissing = 0;
  let edgeEndpointMissing = 0;
  let projectionPayloadInvalid = 0;
  let executionHistory: LiteRuntimeDataVerification["execution_history"];
  let databaseInstanceId: string | null = null;
  let learningEpisodeLedgerInvalid = 0;
  try {
    quickCheck = (db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>)
      .map((row) => String(Object.values(row)[0] ?? ""));
    foreignKeyViolationCount = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    schema = inspectLiteRuntimeSchema(db);
    counts = semanticCounts(db);
    if (schema.classification === "current" && schema.detected_version === 3) {
      try {
        databaseInstanceId = assertLiteRuntimeAuthorityIdentity(db);
        assertLiteLearningEpisodeLedgerIntegrity(db);
      } catch {
        learningEpisodeLedgerInvalid = 1;
      }
    }
    if (tableExists(db, "lite_memory_nodes")) {
      readyEmbeddingInvalid = scalarCount(
        db,
        `SELECT COUNT(*) AS count
         FROM lite_memory_nodes
         WHERE embedding_status = 'ready'
           AND (
             embedding_vector_json IS NULL
             OR json_valid(embedding_vector_json) = 0
             OR json_array_length(embedding_vector_json) <> 1536
           )`,
      );
      if (tableExists(db, "lite_memory_commits")) {
        nodeCommitMissing = scalarCount(
          db,
          `SELECT COUNT(*) AS count
           FROM lite_memory_nodes AS node
           LEFT JOIN lite_memory_commits AS commit_row
             ON commit_row.id = node.commit_id
            AND commit_row.scope = node.scope
           WHERE commit_row.id IS NULL`,
        );
      }
    }
    if (tableExists(db, "lite_memory_edges") && tableExists(db, "lite_memory_nodes")) {
      edgeEndpointMissing = scalarCount(
        db,
        `SELECT COUNT(*) AS count
         FROM lite_memory_edges AS edge
         LEFT JOIN lite_memory_nodes AS src
           ON src.scope = edge.scope AND src.id = edge.src_id
         LEFT JOIN lite_memory_nodes AS dst
           ON dst.scope = edge.scope AND dst.id = edge.dst_id
         WHERE src.id IS NULL OR dst.id IS NULL`,
      );
    }
    projectionPayloadInvalid = projectionPayloadInvalidCount(db);
    executionHistory = await auditExecutionHistoryWithRuntimeStores(db);
  } finally {
    db.close();
  }

  const warnings: string[] = [];
  if (schema.upgrade_required) warnings.push("schema_upgrade_required");
  if (counts.projection_dead_letters > 0) warnings.push("projection_dead_letters_present");
  if (counts.legacy_pending_without_job > 0) warnings.push("legacy_pending_projection_repair_required");
  if (projectionPayloadInvalid > 0) warnings.push("projection_payload_repair_required");
  if (!executionHistory.state.ok) warnings.push("execution_state_history_corrupt");
  if (!executionHistory.tree.ok) warnings.push("execution_tree_history_corrupt");
  if (learningEpisodeLedgerInvalid > 0) warnings.push("learning_episode_ledger_corrupt");
  const ok = quickCheck.length === 1
    && quickCheck[0] === "ok"
    && foreignKeyViolationCount === 0
    && schema.classification !== "incompatible"
    && readyEmbeddingInvalid === 0
    && nodeCommitMissing === 0
    && edgeEndpointMissing === 0
    && projectionPayloadInvalid === 0
    && learningEpisodeLedgerInvalid === 0
    && executionHistory.state.ok
    && executionHistory.tree.ok;

  return {
    contract_version: "aionis_lite_runtime_data_verification_v1",
    path: absolute,
    ok,
    checked_at: new Date().toISOString(),
    byte_size: statSync(absolute).size,
    sha256: await sha256File(absolute),
    database_instance_id: databaseInstanceId,
    quick_check: quickCheck,
    foreign_key_violation_count: foreignKeyViolationCount,
    schema,
    counts,
    integrity_findings: {
      ready_embedding_invalid: readyEmbeddingInvalid,
      node_commit_missing: nodeCommitMissing,
      edge_endpoint_missing: edgeEndpointMissing,
      projection_payload_invalid: projectionPayloadInvalid,
      execution_state_history_invalid: executionHistory.state.ok ? 0 : 1,
      execution_tree_history_invalid: executionHistory.tree.ok ? 0 : 1,
      learning_episode_ledger_invalid: learningEpisodeLedgerInvalid,
    },
    execution_history: executionHistory,
    warnings,
  };
}

function manifestPath(databasePath: string): string {
  return `${databasePath}.manifest.json`;
}

function readBackupManifest(path: string): LiteRuntimeBackupManifest | null {
  const sidecar = manifestPath(path);
  if (!existsSync(sidecar)) return null;
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as Partial<LiteRuntimeBackupManifest>;
  if (
    parsed.contract_version !== "aionis_lite_runtime_backup_manifest_v1"
    || typeof parsed.sha256 !== "string"
    || typeof parsed.byte_size !== "number"
  ) {
    throw new Error(`invalid backup manifest: ${sidecar}`);
  }
  return parsed as LiteRuntimeBackupManifest;
}

async function assertBackupManifestMatches(path: string): Promise<LiteRuntimeBackupManifest | null> {
  const manifest = readBackupManifest(path);
  if (!manifest) return null;
  const actualSize = statSync(path).size;
  const actualSha = await sha256File(path);
  if (manifest.byte_size !== actualSize || manifest.sha256 !== actualSha) {
    throw new Error(`backup_manifest_mismatch:${JSON.stringify({
      expected_size: manifest.byte_size,
      actual_size: actualSize,
      expected_sha256: manifest.sha256,
      actual_sha256: actualSha,
    })}`);
  }
  return manifest;
}

function assertBackupManifestSemantics(
  manifest: LiteRuntimeBackupManifest,
  verification: LiteRuntimeDataVerification,
): void {
  const mismatches: string[] = [];
  if (manifest.schema_component !== verification.schema.component) mismatches.push("schema_component");
  if (manifest.schema_version !== verification.schema.detected_version) mismatches.push("schema_version");
  if (manifest.database_instance_id !== verification.database_instance_id) {
    mismatches.push("database_instance_id");
  }
  const expectedCountEntries = Object.entries(verification.counts) as Array<
    [keyof LiteRuntimeDataVerification["counts"], number]
  >;
  if (!manifest.counts
    || Object.keys(manifest.counts).length !== expectedCountEntries.length
    || expectedCountEntries.some(([field, expected]) => manifest.counts[field] !== expected)) {
    mismatches.push("counts");
  }
  if (mismatches.length > 0) {
    throw new Error(`backup_manifest_semantic_mismatch:${mismatches.join(",")}`);
  }
}

function vacuumInto(source: SqliteDatabase, destination: string): void {
  source.prepare("VACUUM INTO ?").run(destination);
}

export async function backupLiteRuntimeDatabase(args: {
  sourcePath: string;
  destinationPath: string;
}): Promise<{ manifest: LiteRuntimeBackupManifest; verification: LiteRuntimeDataVerification }> {
  const sourcePath = assertReadableDatabasePath(args.sourcePath);
  const destinationPath = resolve(args.destinationPath);
  if (sourcePath === destinationPath) throw new Error("backup destination must differ from source database");
  if (existsSync(destinationPath) || existsSync(manifestPath(destinationPath))) {
    throw new Error(`backup destination already exists: ${destinationPath}`);
  }

  const sourceVerification = await verifyLiteRuntimeDatabase(sourcePath);
  if (!sourceVerification.ok) {
    throw new Error(`source_database_verification_failed:${JSON.stringify(sourceVerification)}`);
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const source = createSqliteDatabase(sourcePath);
  try {
    vacuumInto(source, destinationPath);
  } catch (error) {
    if (existsSync(destinationPath)) rmSync(destinationPath, { force: true });
    throw error;
  } finally {
    source.close();
  }

  try {
    const verification = await verifyLiteRuntimeDatabase(destinationPath);
    if (!verification.ok) {
      throw new Error(`backup_database_verification_failed:${JSON.stringify(verification)}`);
    }
    if (verification.database_instance_id !== sourceVerification.database_instance_id) {
      throw new Error("backup_database_identity_mismatch");
    }
    const manifest: LiteRuntimeBackupManifest = {
      contract_version: "aionis_lite_runtime_backup_manifest_v1",
      created_at: new Date().toISOString(),
      database_file: destinationPath.split("/").at(-1) ?? destinationPath,
      byte_size: verification.byte_size,
      sha256: verification.sha256,
      database_instance_id: verification.database_instance_id,
      schema_component: verification.schema.component,
      schema_version: verification.schema.detected_version,
      counts: verification.counts,
    };
    writeFileSync(manifestPath(destinationPath), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { manifest, verification };
  } catch (error) {
    rmSync(destinationPath, { force: true });
    rmSync(manifestPath(destinationPath), { force: true });
    throw error;
  }
}

export async function restoreLiteRuntimeDatabase(args: {
  backupPath: string;
  destinationPath: string;
}): Promise<{
  source_manifest: LiteRuntimeBackupManifest | null;
  verification: LiteRuntimeDataVerification;
}> {
  const backupPath = assertReadableDatabasePath(args.backupPath);
  const destinationPath = resolve(args.destinationPath);
  if (backupPath === destinationPath) throw new Error("restore destination must differ from backup database");
  if (existsSync(destinationPath)) {
    throw new Error(`restore destination already exists; restore only targets a new path: ${destinationPath}`);
  }
  const sourceManifest = await assertBackupManifestMatches(backupPath);
  const backupVerification = await verifyLiteRuntimeDatabase(backupPath);
  if (!backupVerification.ok) {
    throw new Error(`backup_database_verification_failed:${JSON.stringify(backupVerification)}`);
  }
  if (sourceManifest) assertBackupManifestSemantics(sourceManifest, backupVerification);

  mkdirSync(dirname(destinationPath), { recursive: true });
  const source = createSqliteDatabase(backupPath);
  try {
    vacuumInto(source, destinationPath);
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw error;
  } finally {
    source.close();
  }
  try {
    const verification = await verifyLiteRuntimeDatabase(destinationPath);
    if (!verification.ok) {
      throw new Error(`restored_database_verification_failed:${JSON.stringify(verification)}`);
    }
    if (verification.database_instance_id !== backupVerification.database_instance_id) {
      throw new Error("restored_database_identity_mismatch");
    }
    if (
      sourceManifest
      && sourceManifest.database_instance_id !== undefined
      && verification.database_instance_id !== sourceManifest.database_instance_id
    ) {
      throw new Error("restored_database_manifest_identity_mismatch");
    }
    return { source_manifest: sourceManifest, verification };
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw error;
  }
}

export async function upgradeLiteRuntimeDatabase(path: string): Promise<LiteRuntimeUpgradeReport> {
  const absolute = assertReadableDatabasePath(path);
  const beforeVerification = await verifyLiteRuntimeDatabase(absolute);
  if (beforeVerification.schema.classification === "incompatible") {
    throw new Error(`schema_upgrade_preflight_failed:${JSON.stringify(beforeVerification.schema)}`);
  }
  const store = createLiteWriteStore(absolute, { annProjectionEnabled: false });
  await store.close();
  const afterVerification = await verifyLiteRuntimeDatabase(absolute);
  if (!afterVerification.ok) {
    throw new Error(`schema_upgrade_verification_failed:${JSON.stringify(afterVerification)}`);
  }
  const beforeCounts = beforeVerification.counts;
  const afterCounts = afterVerification.counts;
  const preservedCountKeys = [
    "commits",
    "nodes",
    "edges",
    "guide_receipts",
    "write_operations",
    "rule_feedback",
    "product_measurements",
    "skill_reviews",
  ] as const;
  for (const key of preservedCountKeys) {
    if (beforeCounts[key] !== afterCounts[key]) {
      throw new Error(`schema_upgrade_changed_semantic_row_count:${key}:${beforeCounts[key]}:${afterCounts[key]}`);
    }
  }
  return {
    contract_version: "aionis_lite_runtime_upgrade_report_v1",
    path: absolute,
    before: beforeVerification.schema,
    after: afterVerification.schema,
    preserved_counts: {
      before: {
        commits: beforeCounts.commits,
        nodes: beforeCounts.nodes,
        edges: beforeCounts.edges,
        guide_receipts: beforeCounts.guide_receipts,
        write_operations: beforeCounts.write_operations,
        rule_feedback: beforeCounts.rule_feedback,
        product_measurements: beforeCounts.product_measurements,
        skill_reviews: beforeCounts.skill_reviews,
      },
      after: {
        commits: afterCounts.commits,
        nodes: afterCounts.nodes,
        edges: afterCounts.edges,
        guide_receipts: afterCounts.guide_receipts,
        write_operations: afterCounts.write_operations,
        rule_feedback: afterCounts.rule_feedback,
        product_measurements: afterCounts.product_measurements,
        skill_reviews: afterCounts.skill_reviews,
      },
    },
  };
}
