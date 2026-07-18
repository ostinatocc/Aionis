import type {
  CompareAndSwapWriteScopeHeadArgs,
  CompareAndSwapWriteScopeHeadResult,
  WriteCommitInsertArgs,
  WriteScopeHead,
} from "./write-access.js";
import { ignoreSqliteDuplicateColumnError, type SqliteDatabase } from "./sqlite.js";
import type { LiteRuntimeAuthorityTransactionFence } from
  "./lite-runtime-authority-transaction-fence.js";
import {
  assertLiteMemoryCommitV2SelfIntegrity,
  assertLiteMemoryPendingCommitAppliedAuthority,
  assertLiteMemoryScopeHeadAuthority,
  LiteMemoryCommitAuthorityError,
} from "./lite-memory-commit-integrity.js";
import { stableUuid } from "../util/uuid.js";

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

function assertScope(scope: string): void {
  if (!scope.trim()) throw new Error("lite_memory_scope_head_scope_required");
}

function sqliteChanges(result: unknown): number {
  if (!result || typeof result !== "object" || !("changes" in result)) return 0;
  const changes = Number((result as { changes: unknown }).changes);
  return Number.isSafeInteger(changes) && changes >= 0 ? changes : 0;
}

export function insertLiteMemoryCommitV2InCurrentTransaction(args: {
  db: SqliteDatabase;
  authorityFence: LiteRuntimeAuthorityTransactionFence;
  commit: WriteCommitInsertArgs;
}): string {
  const { db, authorityFence, commit } = args;
  if (commit.digestVersion !== 2) throw new Error("lite_memory_commit_digest_v2_required");
  authorityFence.assertCurrent();
  let parentHash = "";
  if (commit.parentCommitId !== null) {
    const parent = db.prepare(
      `SELECT commit_hash FROM lite_memory_commits
       WHERE scope = ? AND id = ? LIMIT 1`,
    ).get(commit.scope, commit.parentCommitId) as { commit_hash: string } | undefined;
    if (!parent) throw new Error(`lite_memory_commit_v2_parent_missing:${commit.parentCommitId}`);
    parentHash = parent.commit_hash;
  }
  const id = stableUuid(`lite:commit:${commit.commitHash}`);
  assertLiteMemoryCommitV2SelfIntegrity({
    row: {
      id,
      scope: commit.scope,
      parent_commit_id: commit.parentCommitId,
      input_sha256: commit.inputSha256,
      diff_json: commit.diffJson,
      actor: commit.actor,
      model_version: commit.modelVersion,
      prompt_version: commit.promptVersion,
      commit_hash: commit.commitHash,
      created_at: commit.createdAt,
      digest_version: 2,
      revision: commit.revision,
      mutation_digest: commit.mutationDigest,
      legacy_anchor_commit_id: commit.legacyAnchorCommitId,
    },
    parentHash,
  });

  const existing = db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at,
            digest_version, revision, mutation_digest, legacy_anchor_commit_id
     FROM lite_memory_commits WHERE commit_hash = ? LIMIT 1`,
  ).get(commit.commitHash) as Record<string, unknown> | undefined;
  if (typeof existing?.id === "string") {
    const exactReplay = existing.digest_version === 2
      && existing.scope === commit.scope
      && existing.parent_commit_id === commit.parentCommitId
      && existing.input_sha256 === commit.inputSha256
      && existing.diff_json === commit.diffJson
      && existing.actor === commit.actor
      && existing.model_version === commit.modelVersion
      && existing.prompt_version === commit.promptVersion
      && existing.created_at === commit.createdAt
      && existing.revision === commit.revision
      && existing.mutation_digest === commit.mutationDigest
      && existing.legacy_anchor_commit_id === commit.legacyAnchorCommitId;
    if (!exactReplay) throw new Error(`lite_memory_commit_v2_hash_collision:${commit.commitHash}`);
    return existing.id;
  }

  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at,
       digest_version, revision, mutation_digest, legacy_anchor_commit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)`,
  ).run(
    id,
    commit.scope,
    commit.parentCommitId,
    commit.inputSha256,
    commit.diffJson,
    commit.actor,
    commit.modelVersion,
    commit.promptVersion,
    commit.commitHash,
    commit.createdAt,
    commit.revision,
    commit.mutationDigest,
    commit.legacyAnchorCommitId,
  );
  return id;
}

/**
 * Reads the authoritative head for one scope. Migrated v1 histories do not get
 * an invented durable head: the highest SQLite rowid is exposed as revision 0
 * until the first v2 mutation binds that unauthenticated boundary and advances
 * the explicit forward authority head.
 */
export function readLiteMemoryScopeHead(
  db: SqliteDatabase,
  scope: string,
  options: { pendingSuccessorCommitId?: string } = {},
): WriteScopeHead | null {
  assertScope(scope);
  try {
    return assertLiteMemoryScopeHeadAuthority(db, scope, options);
  } catch (error) {
    if (error instanceof LiteMemoryCommitAuthorityError) {
      throw new Error(`lite_memory_scope_head_corrupt:${scope}:${error.code}`, {
        cause: error,
      });
    }
    throw error;
  }
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
  authorityFence: LiteRuntimeAuthorityTransactionFence;
  request: CompareAndSwapWriteScopeHeadArgs;
  now?: Date;
}): CompareAndSwapWriteScopeHeadResult {
  const { db, authorityFence, request } = args;
  assertScope(request.scope);
  if (!request.commitId.trim()) throw new Error("lite_memory_scope_head_commit_id_required");
  authorityFence.assertCurrent();
  if (request.expectedRevision !== undefined
    && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) {
    throw new Error("lite_memory_scope_head_expected_revision_invalid");
  }

  const current = readLiteMemoryScopeHead(db, request.scope, {
    pendingSuccessorCommitId: request.commitId,
  });
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

  assertLiteMemoryPendingCommitAppliedAuthority({
    db,
    scope: request.scope,
    commitId: request.commitId,
  });

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
    return {
      status: "conflict",
      current: readLiteMemoryScopeHead(db, request.scope, {
        pendingSuccessorCommitId: request.commitId,
      }),
    };
  }
  const head = readLiteMemoryScopeHead(db, request.scope);
  if (!head?.persisted || head.commitId !== target.id || head.revision !== nextRevision) {
    throw new Error(`lite_memory_scope_head_advance_verification_failed:${request.scope}`);
  }
  return { status: "advanced", head };
}
