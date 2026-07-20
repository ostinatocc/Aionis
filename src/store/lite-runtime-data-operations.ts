import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import stableStringify from "fast-json-stable-stringify";

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
  assertLearningLookProposalAgainstDatabase,
  inspectLiteLearningEpisodeLedgerAndCommitAuthority,
  assertLiteRuntimeAuthorityIdentity,
  type LiteLearningEpisodeLedgerReplay,
} from "./lite-learning-episode-ledger.js";
import {
  LearningLookProposalV1Schema,
  RUNTIME_INTEGRITY_FINDING_CODES,
  RuntimeIntegrityGateReportV1Schema,
  learningLookProposalDigest,
  runtimeIntegrityGateReportDigest,
  type LearningLookProposalV1,
  type RuntimeIntegrityGateReportV1,
} from "../memory/learning-authority-approval.js";
import { createLiteWriteStore } from "./lite-write-store.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
  type LiteRuntimeSchemaReport,
} from "./lite-runtime-schema.js";
import {
  assertPrivateRuntimeSqliteArtifactIdentities,
  assertPrivateRuntimeSqliteFileIdentity,
  assertPrivateRuntimeSqliteNamespacesDisjoint, assertPrivateRuntimeSqlitePathNamespacesDisjoint,
  capturePrivateRuntimeSqliteArtifactIdentities,
  createSqliteReadOnlyDatabase,
  createSqliteSnapshotSourceDatabase,
  hardenPrivateRuntimeSqliteArtifacts,
  hardenPrivateRuntimeSqliteDirectoryOffline,
  hardenPrivateRuntimeSqlitePathOffline,
  requireSqliteStreamingStatement,
  type SqliteDatabase,
} from "./sqlite.js";
import { verifyLiteReplayDatabaseForOfflineUpgrade } from "./lite-replay-store.js";
import {
  inspectLiteMemoryCommitAuthority,
  type LiteMemoryCommitAuthorityReport,
} from "./lite-memory-commit-integrity.js";
import { validNodeEmbeddingProjectionTuple } from "./write-commit-authority.js";

export type LiteExecutionHistoryVerification = {
  ok: boolean;
  violation_count: number;
  violations: ExecutionHistoryViolation[];
};

export type LiteRuntimeDataVerification = {
  contract_version: "aionis_lite_runtime_data_verification_v2";
  live_path: string;
  ok: boolean;
  checked_at: string;
  snapshot_fingerprint: {
    source: "transactionally_consistent_vacuum_snapshot";
    byte_size: number;
    sha256: string;
    retained_path: null;
  };
  database_instance_id: string | null;
  quick_check: string[];
  foreign_key_violation_count: number;
  schema: LiteRuntimeSchemaReport;
  commit_authority: LiteMemoryCommitAuthorityReport;
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
    learning_episode_events: number;
    learning_protected_events: number;
    learning_legacy_events: number;
    learning_promotion_eligible_exposures: number;
    learning_control_jobs: number;
    learning_control_dead_letters: number;
  };
  integrity_findings: {
    ready_embedding_invalid: number;
    node_commit_missing: number;
    edge_endpoint_missing: number;
    projection_payload_invalid: number;
    execution_state_history_invalid: number;
    execution_tree_history_invalid: number;
    learning_episode_ledger_invalid: number;
    commit_authority_invalid: number;
  };
  execution_history: {
    state: LiteExecutionHistoryVerification;
    tree: LiteExecutionHistoryVerification;
  };
  learning: {
    replay: LiteLearningEpisodeLedgerReplay | null;
    active_serving_blocked: boolean;
    promotion_blocked: boolean;
    blockers: string[];
    reclaimable_expired_control_job_leases: number;
    integrity_error: string | null;
  };
  warnings: string[];
};

export type LiteRuntimeBackupManifest = {
  contract_version:
    | "aionis_lite_runtime_backup_manifest_v1"
    | "aionis_lite_runtime_backup_manifest_v2";
  created_at: string;
  database_file: string;
  byte_size: number;
  sha256: string;
  database_instance_id: string | null;
  schema_component: string;
  schema_version: number | null;
  counts: LiteRuntimeDataVerification["counts"];
  learning_table_counts?: Readonly<Record<string, number>> | null;
};

const PRESERVED_COUNT_KEYS = [
  "commits", "nodes", "edges", "guide_receipts", "write_operations", "rule_feedback",
  "product_measurements", "skill_reviews",
] as const;
type LiteRuntimePreservedCounts = Pick<
  LiteRuntimeDataVerification["counts"], (typeof PRESERVED_COUNT_KEYS)[number]
>;

export type LiteRuntimeUpgradeReport = {
  contract_version: "aionis_lite_runtime_upgrade_report_v1";
  path: string;
  before: LiteRuntimeSchemaReport;
  after: LiteRuntimeSchemaReport;
  replay_database: {
    contract_version: "aionis_lite_runtime_companion_sqlite_hardening_v1"; role: "replay";
    path: string; row_count: number;
    quick_check: string[]; foreign_key_violation_count: number;
    required_table_present: true; required_columns_present: true; node_id_primary_key: true;
    required_table_definition_present: true; required_indexes_present: true;
    mode_before: string | null; mode_after: string | null;
  } | null;
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
  const db = createSqliteReadOnlyDatabase(absolute);
  try {
    return { path: absolute, schema: inspectLiteRuntimeSchema(db) };
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

function sqliteMode(path: string): string | null {
  return process.platform === "win32" ? null : (statSync(path).mode & 0o7777).toString(8).padStart(4, "0");
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

function preservedCounts(counts: LiteRuntimeDataVerification["counts"]): LiteRuntimePreservedCounts {
  return Object.fromEntries(PRESERVED_COUNT_KEYS.map((key) => [key, counts[key]])) as LiteRuntimePreservedCounts;
}

function semanticCounts(
  db: SqliteDatabase,
  learningReplay: LiteLearningEpisodeLedgerReplay | null = null,
): LiteRuntimeDataVerification["counts"] {
  const count = (table: string): number => tableExists(db, table)
    ? scalarCount(db, `SELECT COUNT(*) AS count FROM ${table}`)
    : 0;
  const projectionTableExists = tableExists(db, "lite_memory_projection_jobs");
  const projectionJobs = projectionTableExists ? count("lite_memory_projection_jobs") : 0;
  const learningEventTableExists = tableExists(db, "lite_learning_episode_events");
  const learningControlJobTableExists = tableExists(db, "lite_learning_control_jobs");
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
    learning_episode_events: learningEventTableExists
      ? count("lite_learning_episode_events")
      : 0,
    learning_protected_events: learningReplay?.protected_event_count
      ?? (learningEventTableExists
        ? scalarCount(
            db,
            `SELECT COUNT(*) AS count FROM lite_learning_episode_events
             WHERE json_extract(payload_json, '$.operation_protection') = 'protected'`,
          )
        : 0),
    learning_legacy_events: learningReplay?.legacy_event_count
      ?? (learningEventTableExists
        ? scalarCount(
            db,
            `SELECT COUNT(*) AS count FROM lite_learning_episode_events
             WHERE json_extract(payload_json, '$.operation_protection') = 'legacy_unprotected'`,
          )
        : 0),
    learning_promotion_eligible_exposures: learningReplay?.promotion_eligible_exposure_count
      ?? (learningEventTableExists
        ? scalarCount(
            db,
            `SELECT COUNT(*) AS count FROM lite_learning_episode_events
             WHERE event_kind = 'exposure_committed' AND promotion_eligible = 1`,
          )
        : 0),
    learning_control_jobs: learningControlJobTableExists
      ? count("lite_learning_control_jobs")
      : 0,
    learning_control_dead_letters: learningReplay?.control_job_dead_letter_count
      ?? (learningControlJobTableExists
        ? scalarCount(
            db,
            "SELECT COUNT(*) AS count FROM lite_learning_control_jobs WHERE status = 'dead_letter'",
          )
        : 0),
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
     WHERE status <> 'succeeded' OR job_kind = 'embedding_generate'`,
  ).all() as LiteProjectionJobRow[];
  return rows.filter((row) => (
    row.job_kind === "embedding_generate"
      ? parseEmbeddingProjectionPayload(row) === null
      : parseAnnProjectionPayload(row) === null
  )).length;
}

function invalidNodeEmbeddingProjectionTupleCount(db: SqliteDatabase): number {
  if (!tableExists(db, "lite_memory_nodes")) return 0;
  const rows = requireSqliteStreamingStatement(
    db.prepare(
      `SELECT embedding_vector_json, embedding_model,
              embedding_status, embedding_last_error
       FROM lite_memory_nodes`,
    ),
    "lite_runtime_data_verification_node_embedding_scan",
  );
  let invalid = 0;
  for (const row of rows.iterate<Record<string, unknown>>()) {
    if (!validNodeEmbeddingProjectionTuple(row)) invalid += 1;
  }
  return invalid;
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

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  if (messages.length > 0) return messages.join(": ");
  return String(error);
}

async function auditRuntimeStore(
  open: () => { close(): Promise<void> },
): Promise<LiteExecutionHistoryVerification> {
  try {
    const store = open();
    await store.close();
    return { ok: true, violation_count: 0, violations: [] };
  } catch (error) {
    return historyAuditFailure(error);
  }
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
    hardenPrivateRuntimeSqliteArtifacts(snapshotPath);

    const state = await auditRuntimeStore(() => createLiteExecutionStateStore(snapshotPath));
    const tree = await auditRuntimeStore(() => createLiteExecutionTreeStore(snapshotPath));
    return { state, tree };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyLiteRuntimeDatabaseSnapshot(
  reportPath: string,
  snapshotPath: string,
): Promise<LiteRuntimeDataVerification> {
  const absolute = resolve(reportPath);
  const stableSnapshotPath = assertReadableDatabasePath(snapshotPath);
  const checkedAt = new Date().toISOString();
  const db = createSqliteSnapshotSourceDatabase(stableSnapshotPath);
  let quickCheck: string[];
  let foreignKeyViolationCount: number;
  let schema: LiteRuntimeSchemaReport;
  let commitAuthority: LiteMemoryCommitAuthorityReport;
  let counts: LiteRuntimeDataVerification["counts"];
  let readyEmbeddingInvalid = 0;
  let nodeCommitMissing = 0;
  let edgeEndpointMissing = 0;
  let projectionPayloadInvalid = 0;
  let executionHistory: LiteRuntimeDataVerification["execution_history"];
  let databaseInstanceId: string | null = null;
  let learningEpisodeLedgerInvalid = 0;
  let learningReplay: LiteLearningEpisodeLedgerReplay | null = null;
  let learningIntegrityError: string | null = null;
  try {
    quickCheck = (db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>)
      .map((row) => String(Object.values(row)[0] ?? ""));
    foreignKeyViolationCount = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
    schema = inspectLiteRuntimeSchema(db);
    if (schema.classification === "current"
      && schema.detected_version === LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
      const learningInspection = inspectLiteLearningEpisodeLedgerAndCommitAuthority(
        db,
        checkedAt,
      );
      commitAuthority = learningInspection.commit_authority;
      learningReplay = learningInspection.replay;
      try {
        databaseInstanceId = assertLiteRuntimeAuthorityIdentity(db);
      } catch (error) {
        learningEpisodeLedgerInvalid = 1;
        learningIntegrityError = errorChainMessage(error);
      }
      if (learningInspection.integrity_error !== null) {
        learningEpisodeLedgerInvalid = 1;
        learningIntegrityError = errorChainMessage(learningInspection.integrity_error);
      }
    } else {
      commitAuthority = inspectLiteMemoryCommitAuthority(db);
    }
    counts = semanticCounts(db, learningReplay);
    if (tableExists(db, "lite_memory_nodes")) {
      // Keep the report field name for contract compatibility, but validate the
      // complete persisted tuple for every status through the shared authority rule.
      readyEmbeddingInvalid = invalidNodeEmbeddingProjectionTupleCount(db);
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
  if (!commitAuthority.ok) warnings.push("memory_commit_authority_corrupt");
  if (commitAuthority.terminal_legacy_opaque_row_count > 0) {
    warnings.push("memory_commit_authority_legacy_opaque_rows_present");
  }
  if (commitAuthority.terminal_delegated_operation_row_count > 0) {
    warnings.push("runtime_operation_receipts_use_delegated_authority");
  }
  if (commitAuthority.adoption_binding_count > 0) {
    warnings.push("memory_commit_authority_v5_adoption_present");
  }
  const learningBlockers = counts.learning_control_dead_letters > 0
    ? ["learning_control_dead_letters_present"]
    : [];
  if (counts.learning_control_dead_letters > 0) warnings.push("learning_control_dead_letters_present");
  if ((learningReplay?.control_job_expired_lease_count ?? 0) > 0) {
    warnings.push("learning_control_expired_leases_reclaimable");
  }
  const ok = quickCheck.length === 1
    && quickCheck[0] === "ok"
    && foreignKeyViolationCount === 0
    && schema.classification !== "incompatible"
    && readyEmbeddingInvalid === 0
    && nodeCommitMissing === 0
    && edgeEndpointMissing === 0
    && projectionPayloadInvalid === 0
    && commitAuthority.ok
    && learningEpisodeLedgerInvalid === 0
    && executionHistory.state.ok
    && executionHistory.tree.ok;

  return {
    contract_version: "aionis_lite_runtime_data_verification_v2",
    live_path: absolute,
    ok,
    checked_at: checkedAt,
    snapshot_fingerprint: {
      source: "transactionally_consistent_vacuum_snapshot",
      byte_size: statSync(stableSnapshotPath).size,
      sha256: await sha256File(stableSnapshotPath),
      retained_path: null,
    },
    database_instance_id: databaseInstanceId,
    quick_check: quickCheck,
    foreign_key_violation_count: foreignKeyViolationCount,
    schema,
    commit_authority: commitAuthority,
    counts,
    integrity_findings: {
      ready_embedding_invalid: readyEmbeddingInvalid,
      node_commit_missing: nodeCommitMissing,
      edge_endpoint_missing: edgeEndpointMissing,
      projection_payload_invalid: projectionPayloadInvalid,
      execution_state_history_invalid: executionHistory.state.ok ? 0 : 1,
      execution_tree_history_invalid: executionHistory.tree.ok ? 0 : 1,
      learning_episode_ledger_invalid: learningEpisodeLedgerInvalid,
      commit_authority_invalid: commitAuthority.finding_count,
    },
    execution_history: executionHistory,
    learning: {
      replay: learningReplay,
      active_serving_blocked: learningBlockers.length > 0,
      promotion_blocked: learningBlockers.length > 0,
      blockers: learningBlockers,
      reclaimable_expired_control_job_leases:
        learningReplay?.control_job_expired_lease_count ?? 0,
      integrity_error: learningIntegrityError,
    },
    warnings,
  };
}

/**
 * Verifies one transactionally fixed copy. The verifier never composes
 * multiple autocommit reads against a live WAL-backed path.
 */
export async function verifyLiteRuntimeDatabase(path: string): Promise<LiteRuntimeDataVerification> {
  const absolute = assertReadableDatabasePath(path);
  const snapshotDirectory = createPrivateStagingDirectory(
    tmpdir(),
    "aionis-runtime-data-verify-",
  );
  const snapshotPath = join(snapshotDirectory, "runtime.sqlite");
  try {
    vacuumSnapshot(absolute, snapshotPath);
    hardenPrivateRuntimeSqliteArtifacts(snapshotPath);
    return await verifyLiteRuntimeDatabaseSnapshot(absolute, snapshotPath);
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

export type LiteRuntimeLearningArtifactVerification = Readonly<{
  verification: LiteRuntimeDataVerification;
  proposal: LearningLookProposalV1;
  report: RuntimeIntegrityGateReportV1;
  report_sha256: string;
}>;

function runtimeIntegrityFindingEvidenceSha256(
  code: string,
  count: number,
  evidenceContext: string,
): string {
  return createHash("sha256").update(stableStringify({
    contract_version: "runtime_integrity_finding_evidence_v1",
    verifier_id: "aionis_lite_learning_ledger_replay",
    verifier_version: 1,
    code,
    count,
    evidence_context_sha256: createHash("sha256").update(evidenceContext).digest("hex"),
  })).digest("hex");
}

export async function verifyLiteRuntimeLearningArtifact(args: {
  path: string;
  proposal: unknown;
}): Promise<LiteRuntimeLearningArtifactVerification> {
  const proposal = LearningLookProposalV1Schema.parse(args.proposal);
  const sourcePath = assertReadableDatabasePath(args.path);
  const snapshotDirectory = mkdtempSync(join(tmpdir(), "aionis-learning-integrity-snapshot-"));
  const snapshotPath = join(snapshotDirectory, "runtime.sqlite");
  try {
    vacuumSnapshot(sourcePath, snapshotPath);
    const verification = await verifyLiteRuntimeDatabaseSnapshot(sourcePath, snapshotPath);
    let proposalIntegrityError: string | null = null;
    if (verification.schema.classification === "current"
      && verification.schema.detected_version === LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
      const db = createSqliteReadOnlyDatabase(snapshotPath);
      try {
        assertLearningLookProposalAgainstDatabase(db, proposal);
      } catch (error) {
        proposalIntegrityError = errorChainMessage(error);
      } finally {
        db.close();
      }
    } else {
      proposalIntegrityError = "look proposal requires the current Runtime authority schema";
    }

    const schemaCount = verification.quick_check.filter((value) => value !== "ok").length
      + verification.foreign_key_violation_count
      + (verification.schema.classification === "current" ? 0 : 1);
    const learningError = verification.learning.integrity_error ?? "";
    const proposalError = proposalIntegrityError ?? "";
    const findingCounts: Record<(typeof RUNTIME_INTEGRITY_FINDING_CODES)[number], number> = {
      schema_integrity: schemaCount,
      runtime_state_integrity:
        verification.integrity_findings.ready_embedding_invalid
        + verification.integrity_findings.node_commit_missing
        + verification.integrity_findings.edge_endpoint_missing
        + verification.integrity_findings.projection_payload_invalid
        + verification.integrity_findings.commit_authority_invalid
        + verification.integrity_findings.execution_state_history_invalid
        + verification.integrity_findings.execution_tree_history_invalid
        + verification.commit_authority.terminal_legacy_opaque_row_count
        + verification.commit_authority.terminal_delegated_operation_row_count
        + verification.commit_authority.terminal_projection_tuple_exception_count
        + verification.commit_authority.adoption_binding_count
        + verification.commit_authority.adoption_baseline_projection_exception_count,
      ledger_chain_integrity: verification.integrity_findings.learning_episode_ledger_invalid,
      assignment_integrity: /assignment|pair|arm|wave/u.test(learningError) ? 1 : 0,
      policy_config_integrity: /policy|revision binding/u.test(`${learningError} ${proposalError}`) ? 1 : 0,
      source_binding_integrity: /source|receipt|principal|collector/u.test(learningError) ? 1 : 0,
      attempt_binding_integrity: /attempt|confirmatory/u.test(`${learningError} ${proposalError}`) ? 1 : 0,
      artifact_head_integrity: /artifact/u.test(`${learningError} ${proposalError}`) ? 1 : 0,
      cutoff_projection_integrity: proposalIntegrityError === null ? 0 : 1,
      namespace_lease_integrity: /namespace|lease|generation/u.test(learningError) ? 1 : 0,
      control_plane_integrity: verification.counts.learning_control_dead_letters,
      external_prerequisite_integrity: /external|Task 8|unverified_external/u.test(learningError) ? 1 : 0,
    };
    const proposalSha256 = learningLookProposalDigest(proposal);
    const evidenceContext = stableStringify({
      contract_version: "runtime_integrity_finding_context_v1",
      database_instance_id: verification.database_instance_id,
      schema_component: verification.schema.component,
      schema_version: verification.schema.detected_version,
      proposal_sha256: proposalSha256,
      outcome_redacted_authority_projection_sha256:
        proposal.outcome_redacted_authority_projection_sha256,
      integrity_findings: verification.integrity_findings,
      learning_blockers: verification.learning.blockers,
      learning_table_counts: verification.learning.replay?.table_counts ?? null,
    });
    const findings = RUNTIME_INTEGRITY_FINDING_CODES.map((code) => ({
      code,
      count: findingCounts[code],
      severity: findingCounts[code] > 0 ? "error" as const : "info" as const,
      evidence_sha256: runtimeIntegrityFindingEvidenceSha256(
        code,
        findingCounts[code],
        evidenceContext,
      ),
    }));
    const passed = verification.ok
      && !verification.learning.promotion_blocked
      && proposalIntegrityError === null
      && findings.every((finding) => finding.count === 0);
    const { contract_version: _proposalContractVersion, ...proposalBody } = proposal;
    const report = RuntimeIntegrityGateReportV1Schema.parse({
      ...proposalBody,
      contract_version: "runtime_integrity_gate_report_v1",
      proposal_sha256: proposalSha256,
      verifier_id: "aionis_lite_learning_ledger_replay",
      verifier_version: 1,
      integrity_status: passed ? "passed" : "failed",
      findings,
    });
    return {
      verification,
      proposal,
      report,
      report_sha256: runtimeIntegrityGateReportDigest(report),
    };
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

function manifestPath(databasePath: string): string {
  return `${databasePath}.manifest.json`;
}

function readBackupManifest(path: string): LiteRuntimeBackupManifest | null {
  const sidecar = manifestPath(path);
  if (!existsSync(sidecar)) return null;
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as Partial<LiteRuntimeBackupManifest>;
  if (
    (parsed.contract_version !== "aionis_lite_runtime_backup_manifest_v1"
      && parsed.contract_version !== "aionis_lite_runtime_backup_manifest_v2")
    || typeof parsed.sha256 !== "string"
    || typeof parsed.byte_size !== "number"
  ) {
    throw new Error(`invalid backup manifest: ${sidecar}`);
  }
  return parsed as LiteRuntimeBackupManifest;
}

async function copyManifestBoundBackupSnapshot(
  sourcePath: string,
  snapshotPath: string,
  manifest: LiteRuntimeBackupManifest,
): Promise<void> {
  const hash = createHash("sha256");
  let actualSize = 0;
  const source = createReadStream(sourcePath);
  source.on("data", (chunk: string | Buffer) => {
    actualSize += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    hash.update(chunk);
  });
  await pipeline(source, createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }));
  const actualSha = hash.digest("hex");
  if (manifest.byte_size !== actualSize || manifest.sha256 !== actualSha) {
    throw new Error(`backup_manifest_mismatch:${JSON.stringify({
      expected_size: manifest.byte_size,
      actual_size: actualSize,
      expected_sha256: manifest.sha256,
      actual_sha256: actualSha,
    })}`);
  }
}

function assertBackupManifestSemantics(
  manifest: LiteRuntimeBackupManifest,
  verification: LiteRuntimeDataVerification,
): void {
  const mismatches: string[] = [];
  if (manifest.schema_component !== verification.schema.component) mismatches.push("schema_component");
  if (manifest.schema_version !== verification.schema.detected_version) mismatches.push("schema_version");
  if (manifest.database_instance_id !== verification.database_instance_id) mismatches.push("database_instance_id");
  const expectedCountEntries = Object.entries(verification.counts) as Array<
    [keyof LiteRuntimeDataVerification["counts"], number]
  >;
  const manifestCountEntries = Object.entries(manifest.counts ?? {}) as Array<
    [keyof LiteRuntimeDataVerification["counts"], number]
  >;
  const countMismatch = manifest.contract_version === "aionis_lite_runtime_backup_manifest_v2"
    ? manifestCountEntries.length !== expectedCountEntries.length
      || expectedCountEntries.some(([field, expected]) => manifest.counts[field] !== expected)
    : manifestCountEntries.length === 0
      || manifestCountEntries.some(([field, expected]) => verification.counts[field] !== expected);
  if (countMismatch) mismatches.push("counts");
  const expectedLearningTableCounts = verification.learning.replay?.table_counts ?? null;
  if (manifest.contract_version === "aionis_lite_runtime_backup_manifest_v2"
    && stableStringify(manifest.learning_table_counts ?? null)
      !== stableStringify(expectedLearningTableCounts)) {
    mismatches.push("learning_table_counts");
  }
  if (mismatches.length > 0) throw new Error(`backup_manifest_semantic_mismatch:${mismatches.join(",")}`);
}

function assertRestoredSnapshotMatches(
  snapshot: LiteRuntimeDataVerification,
  restored: LiteRuntimeDataVerification,
): void {
  const mismatches: string[] = [];
  if (snapshot.snapshot_fingerprint.byte_size
    !== restored.snapshot_fingerprint.byte_size) mismatches.push("byte_size");
  if (snapshot.snapshot_fingerprint.sha256
    !== restored.snapshot_fingerprint.sha256) mismatches.push("sha256");
  if (snapshot.schema.component !== restored.schema.component) mismatches.push("schema_component");
  if (snapshot.schema.detected_version !== restored.schema.detected_version) mismatches.push("schema_version");
  if (stableStringify(snapshot.counts) !== stableStringify(restored.counts)) mismatches.push("counts");
  if (stableStringify(snapshot.learning.replay?.table_counts ?? null)
    !== stableStringify(restored.learning.replay?.table_counts ?? null)) {
    mismatches.push("learning_table_counts");
  }
  if (mismatches.length > 0) throw new Error(`restored_database_snapshot_mismatch:${mismatches.join(",")}`);
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function vacuumInto(source: SqliteDatabase, destination: string): void {
  source.prepare("VACUUM INTO ?").run(destination);
}

function vacuumSnapshot(sourcePath: string, destinationPath: string): void {
  const source = createSqliteSnapshotSourceDatabase(sourcePath);
  try {
    vacuumInto(source, destinationPath);
  } finally {
    source.close();
  }
}

function createPrivateStagingDirectory(parent: string, prefix: string): string {
  const directory = mkdtempSync(join(parent, prefix));
  chmodSync(directory, 0o700);
  return directory;
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

  const destinationDirectory = dirname(destinationPath);
  mkdirSync(destinationDirectory, { recursive: true });
  const stagingDirectory = createPrivateStagingDirectory(
    destinationDirectory,
    ".aionis-runtime-backup-",
  );
  const snapshotPath = join(stagingDirectory, "runtime.sqlite");
  try {
    vacuumSnapshot(sourcePath, snapshotPath);
    hardenPrivateRuntimeSqliteArtifacts(snapshotPath);

    const verification = await verifyLiteRuntimeDatabaseSnapshot(destinationPath, snapshotPath);
    if (!verification.ok) {
      throw new Error(`source_database_verification_failed:${JSON.stringify(verification)}`);
    }
    const manifest: LiteRuntimeBackupManifest = {
      contract_version: "aionis_lite_runtime_backup_manifest_v2",
      created_at: new Date().toISOString(),
      database_file: destinationPath.split("/").at(-1) ?? destinationPath,
      byte_size: verification.snapshot_fingerprint.byte_size,
      sha256: verification.snapshot_fingerprint.sha256,
      database_instance_id: verification.database_instance_id,
      schema_component: verification.schema.component,
      schema_version: verification.schema.detected_version,
      counts: verification.counts,
      learning_table_counts: verification.learning.replay?.table_counts ?? null,
    };
    hardenPrivateRuntimeSqliteArtifacts(snapshotPath);
    fsyncPath(snapshotPath);
    linkSync(snapshotPath, destinationPath);
    writeFileSync(
      manifestPath(destinationPath),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    fsyncPath(manifestPath(destinationPath));
    fsyncPath(destinationDirectory);
    return { manifest, verification };
  } catch (error) {
    rmSync(destinationPath, { force: true });
    rmSync(manifestPath(destinationPath), { force: true });
    throw error;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
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
  const sourceManifest = readBackupManifest(backupPath);
  const destinationDirectory = dirname(destinationPath);
  mkdirSync(destinationDirectory, { recursive: true });
  const stagingDirectory = createPrivateStagingDirectory(
    destinationDirectory,
    ".aionis-runtime-restore-",
  );
  const snapshotPath = join(stagingDirectory, "runtime.sqlite");
  try {
    if (sourceManifest) {
      await copyManifestBoundBackupSnapshot(backupPath, snapshotPath, sourceManifest);
    } else {
      vacuumSnapshot(backupPath, snapshotPath);
    }
    hardenPrivateRuntimeSqliteArtifacts(snapshotPath);
    const backupVerification = await verifyLiteRuntimeDatabaseSnapshot(snapshotPath, snapshotPath);
    if (!backupVerification.ok) {
      throw new Error(`backup_database_verification_failed:${JSON.stringify(backupVerification)}`);
    }
    if (sourceManifest) assertBackupManifestSemantics(sourceManifest, backupVerification);

    // The staging directory lives beside the destination, so this hard-link
    // publishes the exact verified inode without reopening the mutable source
    // path and fails atomically if another creator won the destination race.
    // Sync the file before publishing it, then sync the containing directory so
    // a successful restore is durable across a crash after this function returns.
    hardenPrivateRuntimeSqliteArtifacts(snapshotPath);
    fsyncPath(snapshotPath);
    linkSync(snapshotPath, destinationPath);
    fsyncPath(destinationDirectory);
    const verification = await verifyLiteRuntimeDatabaseSnapshot(destinationPath, destinationPath);
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
    assertRestoredSnapshotMatches(backupVerification, verification);
    if (sourceManifest) assertBackupManifestSemantics(sourceManifest, verification);
    return { source_manifest: sourceManifest, verification };
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw error;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export async function upgradeLiteRuntimeDatabase(path: string, options: {
  replayPath?: string | null;
} = {}): Promise<LiteRuntimeUpgradeReport> {
  const absolute = assertReadableDatabasePath(path);
  const replayPath = options.replayPath?.trim() ? assertReadableDatabasePath(options.replayPath) : null;
  if (replayPath) assertPrivateRuntimeSqlitePathNamespacesDisjoint(absolute, replayPath); hardenPrivateRuntimeSqliteDirectoryOffline(absolute);
  if (replayPath) hardenPrivateRuntimeSqliteDirectoryOffline(replayPath);
  const writeArtifacts = capturePrivateRuntimeSqliteArtifactIdentities(absolute);
  const replayArtifacts = replayPath ? capturePrivateRuntimeSqliteArtifactIdentities(replayPath) : null;
  if (replayPath && replayArtifacts) assertPrivateRuntimeSqliteNamespacesDisjoint(absolute, writeArtifacts, replayPath, replayArtifacts);
  const replayVerification = replayPath && replayArtifacts
    ? { mode_before: sqliteMode(replayPath), ...verifyLiteReplayDatabaseForOfflineUpgrade(replayPath, replayArtifacts) }
    : null;
  const beforeVerification = await verifyLiteRuntimeDatabase(absolute);
  if (beforeVerification.schema.classification === "incompatible"
    || beforeVerification.schema.classification === "uninitialized") {
    throw new Error(`schema_upgrade_preflight_failed:${JSON.stringify(beforeVerification.schema)}`);
  }
  const verifiedWriteArtifacts = assertPrivateRuntimeSqliteArtifactIdentities(absolute, writeArtifacts, true);
  if (replayPath && replayArtifacts) {
    const verifiedReplayArtifacts = replayVerification?.artifacts
      ?? assertPrivateRuntimeSqliteArtifactIdentities(replayPath, replayArtifacts, true);
    assertPrivateRuntimeSqliteNamespacesDisjoint(absolute, verifiedWriteArtifacts, replayPath, verifiedReplayArtifacts);
  }
  const replayDatabase = replayPath && replayVerification
    ? (() => {
        const { artifacts, ...report } = replayVerification;
        hardenPrivateRuntimeSqlitePathOffline(replayPath, artifacts);
        assertPrivateRuntimeSqliteArtifactIdentities(replayPath, artifacts);
        return {
          contract_version: "aionis_lite_runtime_companion_sqlite_hardening_v1" as const,
          path: replayPath, role: "replay" as const, ...report, mode_after: sqliteMode(replayPath),
        };
      })()
    : null;
  // Upgrade is an explicit offline operation. Normalize legacy artifact modes
  // only after the read-only verifier accepts the source, and before Runtime
  // opens any live write/read handles whose locks must never be disturbed.
  hardenPrivateRuntimeSqlitePathOffline(absolute, verifiedWriteArtifacts);
  assertPrivateRuntimeSqliteArtifactIdentities(absolute, verifiedWriteArtifacts);
  const store = createLiteWriteStore(absolute, { annProjectionEnabled: false });
  await store.close();
  assertPrivateRuntimeSqliteFileIdentity(absolute, writeArtifacts.main);
  const afterVerification = await verifyLiteRuntimeDatabase(absolute);
  assertPrivateRuntimeSqliteFileIdentity(absolute, writeArtifacts.main);
  if (!afterVerification.ok) {
    throw new Error(`schema_upgrade_verification_failed:${JSON.stringify(afterVerification)}`);
  }
  const beforeCounts = beforeVerification.counts;
  const afterCounts = afterVerification.counts;
  for (const key of PRESERVED_COUNT_KEYS) {
    const expectedAfter = key === "commits"
      ? beforeCounts.commits
        + afterVerification.commit_authority.adoption_manifest_count
        - beforeVerification.commit_authority.adoption_manifest_count
      : beforeCounts[key];
    if (expectedAfter !== afterCounts[key]) {
      throw new Error(`schema_upgrade_changed_semantic_row_count:${key}:${expectedAfter}:${afterCounts[key]}`);
    }
  }
  return {
    contract_version: "aionis_lite_runtime_upgrade_report_v1",
    path: absolute,
    before: beforeVerification.schema,
    after: afterVerification.schema,
    replay_database: replayDatabase,
    preserved_counts: {
      before: preservedCounts(beforeCounts),
      after: preservedCounts(afterCounts),
    },
  };
}
