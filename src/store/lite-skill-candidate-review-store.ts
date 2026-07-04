import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SkillCandidateReviewAccess,
  SkillCandidateReviewRow,
  SkillCandidateReviewStatus,
  TraceDerivedSkillTrainingCandidate,
} from "./skill-candidate-review-access.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.js";
import { createSqliteTransactionRunner } from "./sqlite-transaction-runner.js";

export type LiteSkillCandidateReviewStore = {
  createSkillCandidateReviewAccess(): SkillCandidateReviewAccess;
  close(): Promise<void>;
  healthSnapshot(): { path: string; mode: "sqlite_skill_candidate_review_v1" };
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
  candidate: TraceDerivedSkillTrainingCandidate;
}): string {
  const skill = args.candidate.trace_derived_skill;
  const hash = createHash("sha256")
    .update(JSON.stringify({
      tenant_id: args.tenantId,
      scope: args.scope,
      contract_version: skill.contract_version,
      skill_name: skill.skill_name,
      source_trace_ids: skill.source_trace_ids,
      source_signal_ids: skill.source_signal_ids,
      applies_when: skill.applies_when,
      procedure_steps: skill.procedure_steps,
      evidence_refs: skill.evidence_refs,
    }))
    .digest("hex")
    .slice(0, 32);
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

function migrate(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

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
}

function reviewAccessForDb(db: SqliteDatabase): SkillCandidateReviewAccess {
  const transaction = createSqliteTransactionRunner({
    begin: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  });

  const getByIdStmt = db.prepare<SkillCandidateReviewRecord>(`
    SELECT * FROM lite_skill_candidate_reviews
    WHERE tenant_id = ? AND scope = ? AND candidate_id = ?
    LIMIT 1
  `);
  const insertStmt = db.prepare(`
    INSERT INTO lite_skill_candidate_reviews (
      candidate_id, tenant_id, scope, review_status, skill_name, label,
      export_ready, promotion_status, reason, source_ids_json, source_trace_ids_json,
      source_signal_ids_json, applies_when_json, does_not_apply_when_json,
      procedure_steps_json, target_files_json, acceptance_checks_json,
      failure_counterexamples_json, evidence_refs_json, candidate_json,
      reviewer_id, review_reason, created_at, updated_at, reviewed_at
    ) VALUES (
      ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL
    )
  `);
  const updatePendingStmt = db.prepare(`
    UPDATE lite_skill_candidate_reviews
    SET skill_name = ?,
        label = ?,
        export_ready = ?,
        promotion_status = ?,
        reason = ?,
        source_ids_json = ?,
        source_trace_ids_json = ?,
        source_signal_ids_json = ?,
        applies_when_json = ?,
        does_not_apply_when_json = ?,
        procedure_steps_json = ?,
        target_files_json = ?,
        acceptance_checks_json = ?,
        failure_counterexamples_json = ?,
        evidence_refs_json = ?,
        candidate_json = ?,
        updated_at = ?
    WHERE tenant_id = ? AND scope = ? AND candidate_id = ? AND review_status = 'pending_review'
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
  const reviewStmt = db.prepare(`
    UPDATE lite_skill_candidate_reviews
    SET review_status = ?,
        reviewer_id = ?,
        review_reason = ?,
        reviewed_at = ?,
        updated_at = ?
    WHERE tenant_id = ? AND scope = ? AND candidate_id = ?
  `);

  return {
    async enqueueTraceDerivedSkillCandidates(args) {
      return await transaction.run(async () => {
        const rows: SkillCandidateReviewRow[] = [];
        let inserted = 0;
        let updated = 0;
        const at = args.now ?? nowIso();
        for (const candidate of args.candidates) {
          const skill = candidate.trace_derived_skill;
          const candidateId = candidateIdFor({
            tenantId: args.tenantId,
            scope: args.scope,
            candidate,
          });
          const existing = getByIdStmt.get(args.tenantId, args.scope, candidateId) as SkillCandidateReviewRecord | undefined;
          if (!existing) {
            insertStmt.run(
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
              at,
              at,
            );
            inserted += 1;
          } else if (existing.review_status === "pending_review") {
            updatePendingStmt.run(
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
              at,
              args.tenantId,
              args.scope,
              candidateId,
            );
            updated += 1;
          }
          const row = getByIdStmt.get(args.tenantId, args.scope, candidateId) as SkillCandidateReviewRecord | undefined;
          if (row) rows.push(rowFromRecord(row));
        }
        return { rows, inserted, updated };
      });
    },

    async listTraceDerivedSkillCandidates(args) {
      const limit = normalizeLimit(args.limit);
      const rows = args.reviewStatus && args.reviewStatus !== "all"
        ? listByStatusStmt.all(args.tenantId, args.scope, args.reviewStatus, limit)
        : listAllStmt.all(args.tenantId, args.scope, limit);
      return { rows: rows.map(rowFromRecord) };
    },

    async reviewTraceDerivedSkillCandidate(args) {
      const at = args.now ?? nowIso();
      reviewStmt.run(
        args.reviewStatus,
        args.reviewerId ?? null,
        args.reason ?? null,
        at,
        at,
        args.tenantId,
        args.scope,
        args.candidateId,
      );
      const row = getByIdStmt.get(args.tenantId, args.scope, args.candidateId) as SkillCandidateReviewRecord | undefined;
      return row ? rowFromRecord(row) : null;
    },

    async close() {
      db.close();
    },
  };
}

export function createLiteSkillCandidateReviewStore(path: string): LiteSkillCandidateReviewStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = createSqliteDatabase(path);
  migrate(db);
  const access = reviewAccessForDb(db);
  return {
    createSkillCandidateReviewAccess() {
      return access;
    },
    async close() {
      await access.close();
    },
    healthSnapshot() {
      return { path, mode: "sqlite_skill_candidate_review_v1" };
    },
  };
}
