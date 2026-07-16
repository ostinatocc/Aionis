import type {
  ProductMeasurementRecord,
  SkillCandidateReviewAccess,
  SkillCandidateReviewRow,
  SkillCandidateReviewStatus,
  TraceDerivedSkillTrainingCandidate,
} from "./memory-store.js";
import {
  stableJsonDigest,
} from "./memory-store.js";
import {
  PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX,
  assertProductMeasurementRecordIntegrity,
  parseProductMeasureOperationEvidenceReference,
  productMeasurementFromDbRecord,
  type LiteProductMeasurementDbRecord,
} from "./lite-product-measurement-record.js";
import { createLiteRuntimeDatabase, type LiteRuntimeDatabase } from "./lite-runtime-database.js";
import { ignoreSqliteDuplicateColumnError, type SqliteDatabase } from "./sqlite.js";

export type LiteSkillCandidateReviewStore = {
  createSkillCandidateReviewAccess(): SkillCandidateReviewAccess;
  close(): Promise<void>;
  healthSnapshot(): { path: string; mode: "sqlite_skill_candidate_review_v2" };
};

type SkillCandidateReviewRecord = {
  candidate_id: string;
  tenant_id: string;
  scope: string;
  review_status: SkillCandidateReviewStatus;
  skill_name: string;
  label: TraceDerivedSkillTrainingCandidate["label"];
  export_ready: number;
  promotion_status: TraceDerivedSkillTrainingCandidate["trace_derived_skill"]["promotion_status"];
  reason: string;
  source_ids_json: string;
  source_trace_ids_json: string;
  source_signal_ids_json: string;
  applies_when_json: string;
  does_not_apply_when_json: string;
  procedure_steps_json: string;
  target_files_json: string;
  acceptance_checks_json: string;
  failure_counterexamples_json: string;
  evidence_refs_json: string;
  candidate_json: string;
  measurement_id: string | null;
  measurement_digest: string | null;
  candidate_digest: string;
  eligible_for_promotion: number;
  row_version: number;
  reviewer_id: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function jsonColumnValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseCandidate(raw: string): TraceDerivedSkillTrainingCandidate {
  return JSON.parse(raw) as TraceDerivedSkillTrainingCandidate;
}

function candidateIdFor(args: {
  tenantId: string;
  scope: string;
  measurementId: string;
  measurementDigest: string;
  candidateDigest: string;
  candidate: TraceDerivedSkillTrainingCandidate;
}): string {
  const hash = stableJsonDigest({
    tenant_id: args.tenantId,
    scope: args.scope,
    measurement_id: args.measurementId,
    measurement_digest: args.measurementDigest,
    candidate_digest: args.candidateDigest,
  }).slice(0, 32);
  return `skillcand_${hash}`;
}

function rowFromRecord(record: SkillCandidateReviewRecord): SkillCandidateReviewRow {
  return {
    candidate_id: record.candidate_id,
    tenant_id: record.tenant_id,
    scope: record.scope,
    review_status: record.review_status,
    skill_name: record.skill_name,
    label: record.label,
    export_ready: record.export_ready === 1,
    promotion_status: record.promotion_status,
    reason: record.reason,
    source_ids: parseJsonArray(record.source_ids_json),
    source_trace_ids: parseJsonArray(record.source_trace_ids_json),
    source_signal_ids: parseJsonArray(record.source_signal_ids_json),
    applies_when: parseJsonArray(record.applies_when_json),
    does_not_apply_when: parseJsonArray(record.does_not_apply_when_json),
    procedure_steps: parseJsonArray(record.procedure_steps_json),
    target_files: parseJsonArray(record.target_files_json),
    acceptance_checks: parseJsonArray(record.acceptance_checks_json),
    failure_counterexamples: parseJsonArray(record.failure_counterexamples_json),
    evidence_refs: parseJsonArray(record.evidence_refs_json),
    candidate: parseCandidate(record.candidate_json),
    measurement_id: record.measurement_id,
    measurement_digest: record.measurement_digest,
    candidate_digest: record.candidate_digest,
    eligible_for_promotion: record.eligible_for_promotion === 1,
    row_version: Math.max(1, Math.trunc(record.row_version || 1)),
    reviewer_id: record.reviewer_id,
    review_reason: record.review_reason,
    created_at: record.created_at,
    updated_at: record.updated_at,
    reviewed_at: record.reviewed_at,
  };
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 50;
}

const REQUIRED_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  lite_product_measurements: [
    "measurement_id",
    "tenant_id",
    "scope",
    "source",
    "measurement_digest",
    "effect_report_json",
    "eligible_for_skill_export",
    "evidence_status",
    "runtime_evidence_ids_json",
    "eligibility_reasons_json",
    "created_by",
    "created_at",
  ],
  lite_skill_candidate_reviews: [
    "candidate_id",
    "tenant_id",
    "scope",
    "review_status",
    "skill_name",
    "label",
    "export_ready",
    "promotion_status",
    "reason",
    "source_ids_json",
    "source_trace_ids_json",
    "source_signal_ids_json",
    "applies_when_json",
    "does_not_apply_when_json",
    "procedure_steps_json",
    "target_files_json",
    "acceptance_checks_json",
    "failure_counterexamples_json",
    "evidence_refs_json",
    "candidate_json",
    "measurement_id",
    "measurement_digest",
    "candidate_digest",
    "eligible_for_promotion",
    "row_version",
    "reviewer_id",
    "review_reason",
    "created_at",
    "updated_at",
    "reviewed_at",
  ],
};

const V3_MEASUREMENT_LINK_COLUMNS = [
  "baseline_episode_id",
  "after_episode_id",
  "record_sha256",
] as const;

const REQUIRED_SCHEMA_INDEXES: Readonly<Record<string, string>> = {
  idx_lite_product_measurements_scope_digest: "lite_product_measurements",
  idx_lite_skill_candidate_reviews_scope_status: "lite_skill_candidate_reviews",
  idx_lite_skill_candidate_reviews_scope_updated: "lite_skill_candidate_reviews",
};

function assertLiteSkillCandidateReviewSchema(db: SqliteDatabase): void {
  const problems: string[] = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string; pk: number }>;
    if (rows.length === 0) {
      problems.push(`missing table ${table}`);
      continue;
    }
    const columns = new Set(rows.map((row) => row.name));
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) problems.push(`${table} missing columns: ${missing.join(", ")}`);
    const primaryKey = rows
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    const expectedPrimaryKey = table === "lite_product_measurements" ? "measurement_id" : "candidate_id";
    if (primaryKey.length !== 1 || primaryKey[0] !== expectedPrimaryKey) {
      problems.push(`${table} primary key must be (${expectedPrimaryKey})`);
    }
  }
  const indexStmt = db.prepare(
    "SELECT tbl_name AS table_name FROM sqlite_schema WHERE type = 'index' AND name = ?",
  );
  for (const [index, expectedTable] of Object.entries(REQUIRED_SCHEMA_INDEXES)) {
    const row = indexStmt.get(index) as { table_name: string } | undefined;
    if (!row || row.table_name !== expectedTable) {
      problems.push(`missing required index ${index} on ${expectedTable}`);
    }
  }
  const measurementColumns = new Set(
    (db.prepare("PRAGMA table_info('lite_product_measurements')").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const presentV3LinkColumns = V3_MEASUREMENT_LINK_COLUMNS.filter((column) => measurementColumns.has(column));
  const metadataColumns = db.prepare("PRAGMA table_info('lite_runtime_schema_metadata')").all() as Array<{
    name: string;
  }>;
  let declaredWriteSchemaVersion: number | null = null;
  if (metadataColumns.length > 0) {
    const names = new Set(metadataColumns.map((column) => column.name));
    if (["component", "version"].every((column) => names.has(column))) {
      const metadata = db.prepare(
        `SELECT version FROM lite_runtime_schema_metadata
         WHERE component = 'write_projection'`,
      ).get() as { version: unknown } | undefined;
      if (metadata && Number.isInteger(Number(metadata.version))) {
        declaredWriteSchemaVersion = Number(metadata.version);
      }
    }
  }
  if (declaredWriteSchemaVersion !== null && declaredWriteSchemaVersion >= 3) {
    const missing = V3_MEASUREMENT_LINK_COLUMNS.filter((column) => !measurementColumns.has(column));
    if (missing.length > 0) {
      problems.push(`v3 lite_product_measurements missing columns: ${missing.join(", ")}`);
    }
  } else if (presentV3LinkColumns.length > 0) {
    problems.push(
      `v3 measurement linkage columns exist without write schema metadata v3: ${presentV3LinkColumns.join(", ")}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`lite_skill_candidate_review_schema_preflight_failed:${JSON.stringify(problems)}`);
  }
}

export function migrateLiteSkillCandidateReviewSchema(
  db: SqliteDatabase,
  options: { includeLearningEpisodeLinks?: boolean } = {},
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lite_product_measurements (
      measurement_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      measurement_digest TEXT NOT NULL,
      effect_report_json TEXT NOT NULL,
      eligible_for_skill_export INTEGER NOT NULL,
      evidence_status TEXT NOT NULL,
      runtime_evidence_ids_json TEXT NOT NULL,
      eligibility_reasons_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_lite_product_measurements_scope_digest
      ON lite_product_measurements(tenant_id, scope, measurement_id, measurement_digest);

    CREATE TABLE IF NOT EXISTS lite_skill_candidate_reviews (
      candidate_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      review_status TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      label TEXT NOT NULL,
      export_ready INTEGER NOT NULL,
      promotion_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_ids_json TEXT NOT NULL,
      source_trace_ids_json TEXT NOT NULL,
      source_signal_ids_json TEXT NOT NULL,
      applies_when_json TEXT NOT NULL,
      does_not_apply_when_json TEXT NOT NULL,
      procedure_steps_json TEXT NOT NULL,
      target_files_json TEXT NOT NULL,
      acceptance_checks_json TEXT NOT NULL,
      failure_counterexamples_json TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      measurement_id TEXT,
      measurement_digest TEXT,
      candidate_digest TEXT NOT NULL DEFAULT '',
      eligible_for_promotion INTEGER NOT NULL DEFAULT 0,
      row_version INTEGER NOT NULL DEFAULT 1,
      reviewer_id TEXT,
      review_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lite_skill_candidate_reviews_scope_status
      ON lite_skill_candidate_reviews(tenant_id, scope, review_status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_lite_skill_candidate_reviews_scope_updated
      ON lite_skill_candidate_reviews(tenant_id, scope, updated_at DESC);
  `);

  const addedColumns = [
    "measurement_id TEXT",
    "measurement_digest TEXT",
    "candidate_digest TEXT NOT NULL DEFAULT ''",
    "eligible_for_promotion INTEGER NOT NULL DEFAULT 0",
    "row_version INTEGER NOT NULL DEFAULT 1",
  ];
  for (const column of addedColumns) {
    try {
      db.exec(`ALTER TABLE lite_skill_candidate_reviews ADD COLUMN ${column}`);
    } catch (error) {
      ignoreSqliteDuplicateColumnError(error);
    }
  }
  if (options.includeLearningEpisodeLinks) {
    const addedMeasurementColumns = [
      "baseline_episode_id TEXT",
      "after_episode_id TEXT",
      "record_sha256 TEXT",
    ];
    for (const column of addedMeasurementColumns) {
      try {
        db.exec(`ALTER TABLE lite_product_measurements ADD COLUMN ${column}`);
      } catch (error) {
        ignoreSqliteDuplicateColumnError(error);
      }
    }
  }
}

function reviewAccessForDb(
  database: LiteRuntimeDatabase,
  closeAccess?: () => Promise<void>,
): SkillCandidateReviewAccess {
  const { db, transaction } = database;
  const measurementColumns = new Set(
    (db.prepare("PRAGMA table_info('lite_product_measurements')").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const hasLearningEpisodeLinks = V3_MEASUREMENT_LINK_COLUMNS.every((column) => measurementColumns.has(column));

  const getByIdStmt = db.prepare<SkillCandidateReviewRecord>(`
    SELECT * FROM lite_skill_candidate_reviews
    WHERE tenant_id = ? AND scope = ? AND candidate_id = ?
    LIMIT 1
  `);
  const getMeasurementStmt = db.prepare<LiteProductMeasurementDbRecord>(`
    SELECT * FROM lite_product_measurements
    WHERE tenant_id = ? AND scope = ? AND measurement_id = ?
    LIMIT 1
  `);
  const getMeasurementsWithOperationEvidenceStmt = db.prepare<LiteProductMeasurementDbRecord>(`
    SELECT measurement.* FROM lite_product_measurements AS measurement
    WHERE measurement.tenant_id = ? AND measurement.scope = ?
      AND EXISTS (
        SELECT 1 FROM json_each(measurement.runtime_evidence_ids_json) AS evidence
        WHERE evidence.type = 'text' AND substr(evidence.value, 1, ?) = ?
      )
    ORDER BY measurement.created_at, measurement.measurement_id
  `);
  const insertMeasurementStmt = db.prepare(hasLearningEpisodeLinks
    ? `
      INSERT INTO lite_product_measurements (
        measurement_id, tenant_id, scope, source, measurement_digest,
        effect_report_json, eligible_for_skill_export, evidence_status,
        runtime_evidence_ids_json, eligibility_reasons_json, created_by, created_at,
        baseline_episode_id, after_episode_id, record_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    : `
      INSERT INTO lite_product_measurements (
        measurement_id, tenant_id, scope, source, measurement_digest,
        effect_report_json, eligible_for_skill_export, evidence_status,
        runtime_evidence_ids_json, eligibility_reasons_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO lite_skill_candidate_reviews (
      candidate_id, tenant_id, scope, review_status, skill_name, label,
      export_ready, promotion_status, reason, source_ids_json, source_trace_ids_json,
      source_signal_ids_json, applies_when_json, does_not_apply_when_json,
      procedure_steps_json, target_files_json, acceptance_checks_json,
      failure_counterexamples_json, evidence_refs_json, candidate_json,
      measurement_id, measurement_digest, candidate_digest, eligible_for_promotion,
      row_version, reviewer_id, review_reason,
      created_at, updated_at, reviewed_at
    ) VALUES (
      ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 1, NULL, NULL, ?, ?, NULL
    )
  `);
  const listAllStmt = db.prepare<SkillCandidateReviewRecord>(`
    SELECT * FROM lite_skill_candidate_reviews
    WHERE tenant_id = ? AND scope = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `);
  const listByStatusStmt = db.prepare<SkillCandidateReviewRecord>(`
    SELECT * FROM lite_skill_candidate_reviews
    WHERE tenant_id = ? AND scope = ? AND review_status = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `);
  const promoteStmt = db.prepare(`
    UPDATE lite_skill_candidate_reviews
    SET review_status = 'promoted',
        reviewer_id = ?,
        review_reason = ?,
        reviewed_at = ?,
        updated_at = ?,
        row_version = row_version + 1
    WHERE tenant_id = ? AND scope = ? AND candidate_id = ?
      AND review_status = 'pending_review'
      AND row_version = ?
      AND eligible_for_promotion = 1
  `);
  const rejectStmt = db.prepare(`
    UPDATE lite_skill_candidate_reviews
    SET review_status = 'rejected',
        reviewer_id = ?,
        review_reason = ?,
        reviewed_at = ?,
        updated_at = ?,
        row_version = row_version + 1
    WHERE tenant_id = ? AND scope = ? AND candidate_id = ?
      AND review_status = 'pending_review'
      AND row_version = ?
  `);
  function changed(result: unknown): boolean {
    return Number((result as { changes?: number } | null)?.changes ?? 0) === 1;
  }

  return {
    transactionRunner() {
      return transaction;
    },

    async recordMeasurement(args) {
      return await transaction.run(async () => {
        assertProductMeasurementRecordIntegrity(args.record);
        const hasBaselineEpisode = args.record.baseline_episode_id !== null;
        const hasAfterEpisode = args.record.after_episode_id !== null;
        if (hasBaselineEpisode !== hasAfterEpisode) {
          throw new Error("measurement episode pair must be both null or both non-null");
        }
        if (!hasLearningEpisodeLinks
          && (hasBaselineEpisode || hasAfterEpisode || args.record.record_sha256 !== null)) {
          throw new Error("measurement episode linkage requires the Runtime v3 write schema");
        }
        const existing = getMeasurementStmt.get(
          args.record.tenant_id,
          args.record.scope,
          args.record.measurement_id,
        ) as LiteProductMeasurementDbRecord | undefined;
        if (existing) {
          const parsed = productMeasurementFromDbRecord(existing);
          if (parsed.measurement_digest !== args.record.measurement_digest) {
            throw new Error("measurement id already exists with a different digest");
          }
          if (parsed.record_sha256 !== args.record.record_sha256) {
            throw new Error("measurement id already exists with a different record digest");
          }
          return parsed;
        }
        const values: Array<string | number | null> = [
          args.record.measurement_id,
          args.record.tenant_id,
          args.record.scope,
          args.record.source,
          args.record.measurement_digest,
          jsonColumnValue(args.record.effect_report),
          args.record.eligible_for_skill_export ? 1 : 0,
          args.record.evidence_status,
          jsonColumnValue(args.record.runtime_evidence_ids),
          jsonColumnValue(args.record.eligibility_reasons),
          args.record.created_by,
          args.record.created_at,
        ];
        if (hasLearningEpisodeLinks) {
          values.push(
            args.record.baseline_episode_id,
            args.record.after_episode_id,
            args.record.record_sha256,
          );
        }
        insertMeasurementStmt.run(...values);
        const inserted = getMeasurementStmt.get(
          args.record.tenant_id,
          args.record.scope,
          args.record.measurement_id,
        ) as LiteProductMeasurementDbRecord | undefined;
        if (!inserted) throw new Error("measurement persistence failed");
        return productMeasurementFromDbRecord(inserted);
      });
    },

    async getMeasurement(args) {
      return await transaction.read(() => {
        const row = getMeasurementStmt.get(
          args.tenantId,
          args.scope,
          args.measurementId,
        ) as LiteProductMeasurementDbRecord | undefined;
        return row ? productMeasurementFromDbRecord(row) : null;
      });
    },

    async getMeasurementByOperationId(args) {
      return await transaction.read(() => {
        const rows = getMeasurementsWithOperationEvidenceStmt.all(
          args.tenantId,
          args.scope,
          PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX.length,
          PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX,
        ) as LiteProductMeasurementDbRecord[];
        const matches = rows.flatMap((row) => {
          const measurement = productMeasurementFromDbRecord(row);
          return measurement.runtime_evidence_ids.flatMap((value) => {
            const reference = parseProductMeasureOperationEvidenceReference(value);
            return reference?.operationId === args.operationId
              ? [{ measurement, requestSha256: reference.requestSha256 }]
              : [];
          });
        });
        if (matches.length > 1) {
          throw new Error("product measure operation identity resolves to multiple measurements");
        }
        return matches[0] ?? null;
      });
    },

    async enqueueTraceDerivedSkillCandidates(args) {
      return await transaction.run(async () => {
        const measurementRecord = getMeasurementStmt.get(
          args.tenantId,
          args.scope,
          args.measurementId,
        ) as LiteProductMeasurementDbRecord | undefined;
        if (!measurementRecord || measurementRecord.measurement_digest !== args.measurementDigest) {
          throw new Error("measurement record is missing or does not match the supplied digest");
        }
        const measurement = productMeasurementFromDbRecord(measurementRecord);
        const rows: SkillCandidateReviewRow[] = [];
        let inserted = 0;
        const at = args.now ?? nowIso();
        for (const candidate of args.candidates) {
          const skill = candidate.trace_derived_skill;
          const candidateDigest = stableJsonDigest(candidate);
          const candidateId = candidateIdFor({
            tenantId: args.tenantId,
            scope: args.scope,
            measurementId: args.measurementId,
            measurementDigest: args.measurementDigest,
            candidateDigest,
            candidate,
          });
          const eligible = args.eligibleForPromotion
            && measurement.eligible_for_skill_export
            && candidate.export_ready
            && candidate.label === "positive"
            && skill.promotion_status === "promotion_ready";
          const result = insertStmt.run(
            candidateId,
            args.tenantId,
            args.scope,
            skill.skill_name,
            candidate.label,
            candidate.export_ready ? 1 : 0,
            skill.promotion_status,
            candidate.reason,
            jsonColumnValue(candidate.source_ids),
            jsonColumnValue(skill.source_trace_ids),
            jsonColumnValue(skill.source_signal_ids),
            jsonColumnValue(skill.applies_when),
            jsonColumnValue(skill.does_not_apply_when),
            jsonColumnValue(skill.procedure_steps),
            jsonColumnValue(skill.target_files),
            jsonColumnValue(skill.acceptance_checks),
            jsonColumnValue(skill.failure_counterexamples),
            jsonColumnValue(skill.evidence_refs),
            jsonColumnValue(candidate),
            args.measurementId,
            args.measurementDigest,
            candidateDigest,
            eligible ? 1 : 0,
            at,
            at,
          );
          if (changed(result)) inserted += 1;
          const row = getByIdStmt.get(args.tenantId, args.scope, candidateId) as SkillCandidateReviewRecord | undefined;
          if (row) rows.push(rowFromRecord(row));
        }
        return { rows, inserted, updated: 0 };
      });
    },

    async listTraceDerivedSkillCandidates(args) {
      return await transaction.read(() => {
        const limit = normalizeLimit(args.limit);
        const rows = args.reviewStatus && args.reviewStatus !== "all"
          ? listByStatusStmt.all(args.tenantId, args.scope, args.reviewStatus, limit)
          : listAllStmt.all(args.tenantId, args.scope, limit);
        return { rows: rows.map(rowFromRecord) };
      });
    },

    async getTraceDerivedSkillCandidate(args) {
      return await transaction.read(() => {
        const row = getByIdStmt.get(args.tenantId, args.scope, args.candidateId) as SkillCandidateReviewRecord | undefined;
        return row ? rowFromRecord(row) : null;
      });
    },

    async reviewTraceDerivedSkillCandidate(args) {
      return await transaction.run(async () => {
        const at = args.now ?? nowIso();
        const statement = args.reviewStatus === "promoted" ? promoteStmt : rejectStmt;
        const result = statement.run(
          args.reviewerId,
          args.reason,
          at,
          at,
          args.tenantId,
          args.scope,
          args.candidateId,
          args.expectedVersion,
        );
        if (!changed(result)) return null;
        const row = getByIdStmt.get(args.tenantId, args.scope, args.candidateId) as SkillCandidateReviewRecord | undefined;
        return row ? rowFromRecord(row) : null;
      });
    },

    async close() {
      await closeAccess?.();
    },
  };
}

export function createLiteSkillCandidateReviewStore(path: string): LiteSkillCandidateReviewStore {
  const database = createLiteRuntimeDatabase(path);
  try {
    migrateLiteSkillCandidateReviewSchema(database.db);
    return createLiteSkillCandidateReviewStoreFromDatabase(database, { closeDatabaseOnClose: true });
  } catch (error) {
    void database.close();
    throw error;
  }
}

export function createLiteSkillCandidateReviewStoreFromDatabase(
  database: LiteRuntimeDatabase,
  options: { closeDatabaseOnClose?: boolean } = {},
): LiteSkillCandidateReviewStore {
  const { path, db } = database;
  assertLiteSkillCandidateReviewSchema(db);
  const closeDatabase = options.closeDatabaseOnClose ? () => database.close() : undefined;
  const access = reviewAccessForDb(database, closeDatabase);
  return {
    createSkillCandidateReviewAccess() {
      return access;
    },
    async close() {
      if (options.closeDatabaseOnClose) await database.close();
    },
    healthSnapshot() {
      return { path, mode: "sqlite_skill_candidate_review_v2" };
    },
  };
}
