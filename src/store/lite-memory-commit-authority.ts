import type {
  CompareAndSwapWriteScopeHeadArgs,
  CompareAndSwapWriteScopeHeadResult,
  WriteScopeHead,
} from "./write-access.js";
import { ignoreSqliteDuplicateColumnError, type SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

export const LITE_MEMORY_SCOPE_HEAD_TABLE_SQL = `CREATE TABLE lite_memory_scope_heads (
  scope TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (revision >= 1)
)`;

export const LITE_MEMORY_COMMIT_SCOPE_REVISION_INDEX_SQL =
  `CREATE UNIQUE INDEX idx_lite_memory_commits_scope_revision
   ON lite_memory_commits(scope, revision)
   WHERE revision IS NOT NULL`;

const V5_COMMIT_COLUMNS = [
  "digest_version INTEGER NOT NULL DEFAULT 1 CHECK (digest_version IN (1, 2))",
  "revision INTEGER CHECK (revision IS NULL OR revision >= 1)",
  "mutation_digest TEXT",
  "legacy_anchor_commit_id TEXT",
] as const;

function schemaObjectExists(db: SqliteDatabase, type: "table" | "index", name: string): boolean {
  return !!db.prepare(
    `SELECT 1 AS present
     FROM sqlite_schema
     WHERE type = ? AND name = ?`,
  ).get(type, name);
}

export function migrateLiteMemoryCommitAuthorityV5(db: SqliteDatabase): void {
  for (const definition of V5_COMMIT_COLUMNS) {
    try {
      db.exec(`ALTER TABLE lite_memory_commits ADD COLUMN ${definition}`);
    } catch (error) {
      ignoreSqliteDuplicateColumnError(error);
    }
  }
  if (!schemaObjectExists(db, "table", "lite_memory_scope_heads")) {
    db.exec(`${LITE_MEMORY_SCOPE_HEAD_TABLE_SQL};`);
  }
  if (!schemaObjectExists(db, "index", "idx_lite_memory_commits_scope_revision")) {
    db.exec(`${LITE_MEMORY_COMMIT_SCOPE_REVISION_INDEX_SQL};`);
  }
}

type ScopeHeadDbRow = {
  scope: string;
  commit_id: string;
  head_revision: number;
  updated_at: string;
  commit_scope: string | null;
  commit_hash: string | null;
  commit_revision: number | null;
  digest_version: number | null;
  legacy_anchor_commit_id: string | null;
};

type LegacyHeadDbRow = {
  scope: string;
  id: string;
  commit_hash: string;
  created_at: string;
};

function assertScope(scope: string): void {
  if (!scope.trim()) throw new Error("lite_memory_scope_head_scope_required");
}

function sqliteChanges(result: unknown): number {
  if (!result || typeof result !== "object" || !("changes" in result)) return 0;
  const changes = Number((result as { changes: unknown }).changes);
  return Number.isSafeInteger(changes) && changes >= 0 ? changes : 0;
}

/**
 * Reads the authoritative head for one scope. Migrated v1 histories do not get
 * an invented durable head: the highest SQLite rowid is exposed as revision 0
 * until the first v2 mutation binds that unauthenticated boundary and advances
 * the explicit forward authority head.
 */
export function readLiteMemoryScopeHead(db: SqliteDatabase, scope: string): WriteScopeHead | null {
  assertScope(scope);
  const persisted = db.prepare(
    `SELECT h.scope,
            h.commit_id,
            h.revision AS head_revision,
            h.updated_at,
            c.scope AS commit_scope,
            c.commit_hash,
            c.revision AS commit_revision,
            c.digest_version,
            c.legacy_anchor_commit_id
     FROM lite_memory_scope_heads h
     LEFT JOIN lite_memory_commits c ON c.id = h.commit_id
     WHERE h.scope = ?
     LIMIT 1`,
  ).get(scope) as ScopeHeadDbRow | undefined;
  if (persisted) {
    if (persisted.commit_scope !== persisted.scope
      || persisted.digest_version !== 2
      || persisted.commit_revision !== persisted.head_revision
      || !persisted.commit_hash) {
      throw new Error(`lite_memory_scope_head_corrupt:${scope}`);
    }
    return {
      scope: persisted.scope,
      commitId: persisted.commit_id,
      commitHash: persisted.commit_hash,
      revision: persisted.head_revision,
      digestVersion: 2,
      legacyAnchorCommitId: persisted.legacy_anchor_commit_id,
      persisted: true,
      updatedAt: persisted.updated_at,
    };
  }

  const legacy = db.prepare(
    `SELECT scope, id, commit_hash, created_at
     FROM lite_memory_commits
     WHERE scope = ?
       AND digest_version = 1
     ORDER BY rowid DESC
     LIMIT 1`,
  ).get(scope) as LegacyHeadDbRow | undefined;
  if (!legacy) return null;
  return {
    scope: legacy.scope,
    commitId: legacy.id,
    commitHash: legacy.commit_hash,
    revision: 0,
    digestVersion: 1,
    legacyAnchorCommitId: legacy.id,
    persisted: false,
    updatedAt: legacy.created_at,
  };
}

type TargetCommitDbRow = {
  id: string;
  scope: string;
  parent_commit_id: string | null;
  revision: number | null;
  digest_version: number;
  legacy_anchor_commit_id: string | null;
};

function sameNullableString(left: string | null, right: string | null): boolean {
  return left === right;
}

export function compareAndSwapLiteMemoryScopeHead(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
  request: CompareAndSwapWriteScopeHeadArgs;
  now?: Date;
}): CompareAndSwapWriteScopeHeadResult {
  const { db, transaction, request } = args;
  assertScope(request.scope);
  if (!request.commitId.trim()) throw new Error("lite_memory_scope_head_commit_id_required");
  if (!transaction.inTransaction()) {
    throw new Error("lite_memory_scope_head_cas_requires_shared_transaction");
  }
  if (request.expectedRevision !== undefined
    && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) {
    throw new Error("lite_memory_scope_head_expected_revision_invalid");
  }

  const current = readLiteMemoryScopeHead(db, request.scope);
  const currentRevision = current?.revision ?? 0;
  const currentCommitId = current?.commitId ?? null;
  const expectedCommitWasProvided = Object.prototype.hasOwnProperty.call(request, "expectedCommitId");
  if ((request.expectedRevision !== undefined && request.expectedRevision !== currentRevision)
    || (expectedCommitWasProvided
      && !sameNullableString(request.expectedCommitId ?? null, currentCommitId))) {
    return { status: "conflict", current };
  }

  const target = db.prepare(
    `SELECT id, scope, parent_commit_id, revision, digest_version, legacy_anchor_commit_id
     FROM lite_memory_commits
     WHERE id = ?
     LIMIT 1`,
  ).get(request.commitId) as TargetCommitDbRow | undefined;
  if (!target) throw new Error(`lite_memory_scope_head_target_missing:${request.commitId}`);

  const nextRevision = currentRevision + 1;
  const expectedLegacyAnchor = current?.legacyAnchorCommitId ?? null;
  if (target.scope !== request.scope
    || target.digest_version !== 2
    || target.revision !== nextRevision
    || !sameNullableString(target.parent_commit_id, currentCommitId)
    || !sameNullableString(target.legacy_anchor_commit_id, expectedLegacyAnchor)) {
    throw new Error(`lite_memory_scope_head_target_mismatch:${JSON.stringify({
      scope: request.scope,
      commitId: request.commitId,
      expectedRevision: nextRevision,
      expectedParentCommitId: currentCommitId,
      expectedLegacyAnchorCommitId: expectedLegacyAnchor,
    })}`);
  }

  const updatedAt = (args.now ?? new Date()).toISOString();
  const result = current?.persisted === true
    ? db.prepare(
      `UPDATE lite_memory_scope_heads
       SET commit_id = ?, revision = ?, updated_at = ?
       WHERE scope = ?
         AND revision = ?
         AND commit_id = ?`,
    ).run(
      target.id,
      nextRevision,
      updatedAt,
      request.scope,
      currentRevision,
      currentCommitId,
    )
    : db.prepare(
      `INSERT OR IGNORE INTO lite_memory_scope_heads
         (scope, commit_id, revision, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(request.scope, target.id, nextRevision, updatedAt);

  if (sqliteChanges(result) !== 1) {
    return { status: "conflict", current: readLiteMemoryScopeHead(db, request.scope) };
  }
  const head = readLiteMemoryScopeHead(db, request.scope);
  if (!head?.persisted || head.commitId !== target.id || head.revision !== nextRevision) {
    throw new Error(`lite_memory_scope_head_advance_verification_failed:${request.scope}`);
  }
  return { status: "advanced", head };
}
