import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";
import {
  buildCanonicalAppliedAuthorityMutationV2,
  canonicalAuthorityMutationVerificationProjection,
  canonicalizeAuthorityMutationVerificationV2,
  canonicalV2CommitHash,
  canonicalAuthorityMutationIdentityKey,
  normalizeAppliedAuthorityRow,
  type CanonicalAppliedAuthorityMutationV2,
  type CanonicalAuthorityMutationVerificationV2,
  type CanonicalAuthorityTableMutationV2,
} from "./write-commit-authority.js";
import {
  compareAndSwapLiteMemoryScopeHead,
  insertLiteMemoryCommitV2InCurrentTransaction,
  readLiteMemoryScopeHead,
} from "./lite-memory-commit-authority.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";
import {
  authorityFenceForRuntimeTransaction,
  type LiteRuntimeAuthorityTransactionFence,
} from "./lite-runtime-authority-transaction-fence.js";

export type LiteRuntimeAppliedAuthorityContext = Readonly<{
  commitId: string;
  commitHash: string;
  revision: number;
  appliedAt: string;
  mutation: CanonicalAppliedAuthorityMutationV2;
}>;

function totalChanges(db: SqliteDatabase): number {
  const row = db.prepare("SELECT total_changes() AS count").get() as { count: unknown };
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("lite_runtime_applied_authority_change_count_invalid");
  }
  return count;
}

let authoritySavepointSequence = 0;

type AppliedAuthorityTransactionProof =
  | Readonly<{
      transaction: SqliteTransactionRunner;
      authorityFence?: never;
    }>
  | Readonly<{
      transaction?: never;
      authorityFence: LiteRuntimeAuthorityTransactionFence;
    }>;

export function appendLiteRuntimeAppliedAuthorityInCurrentTransaction<T>(args: {
  db: SqliteDatabase;
  scope: string;
  inputSha256: string;
  actor: string;
  appliedAt: string;
  authorityKind: string;
  mutations: readonly CanonicalAuthorityTableMutationV2[];
  apply(context: LiteRuntimeAppliedAuthorityContext): T;
  verify(context: LiteRuntimeAppliedAuthorityContext & { value: T }):
    readonly CanonicalAuthorityMutationVerificationV2[];
} & AppliedAuthorityTransactionProof): LiteRuntimeAppliedAuthorityContext & { value: T } {
  const authorityFence = args.authorityFence
    ?? authorityFenceForRuntimeTransaction(args.transaction);
  authorityFence.assertCurrent();
  if (!args.scope.trim() || !args.actor.trim() || !/^[a-f0-9]{64}$/u.test(args.inputSha256)) {
    throw new Error("lite_runtime_applied_authority_identity_invalid");
  }
  if (args.mutations.length !== 1) {
    throw new Error("lite_runtime_applied_authority_single_row_required");
  }
  const appliedAtMs = Date.parse(args.appliedAt);
  if (!Number.isFinite(appliedAtMs) || new Date(appliedAtMs).toISOString() !== args.appliedAt) {
    throw new Error("lite_runtime_applied_authority_time_invalid");
  }
  authoritySavepointSequence += 1;
  const savepoint = `lite_runtime_applied_authority_${String(authoritySavepointSequence)}`;
  args.db.exec(`SAVEPOINT ${savepoint}`);
  try {
  const head = readLiteMemoryScopeHead(args.db, args.scope);
  const mutation = buildCanonicalAppliedAuthorityMutationV2({
    appliedAt: args.appliedAt,
    authorityKind: args.authorityKind,
    mutations: args.mutations,
  });
  const diffJson = stableStringify(mutation);
  const mutationDigest = sha256Hex(diffJson);
  const revision = (head?.revision ?? 0) + 1;
  const commitHash = canonicalV2CommitHash({
    digestVersion: 2,
    revision,
    parentHash: head?.commitHash ?? "",
    inputSha256: args.inputSha256,
    mutationDigest,
    scope: args.scope,
    actor: args.actor,
    modelVersion: null,
    promptVersion: null,
  });
  const commitId = insertLiteMemoryCommitV2InCurrentTransaction({
    db: args.db,
    authorityFence,
    commit: {
      scope: args.scope,
      parentCommitId: head?.commitId ?? null,
      inputSha256: args.inputSha256,
      diffJson,
      actor: args.actor,
      modelVersion: null,
      promptVersion: null,
      commitHash,
      digestVersion: 2,
      revision,
      mutationDigest,
      legacyAnchorCommitId: head?.digestVersion === 1
        ? head.commitId
        : head?.legacyAnchorCommitId ?? null,
      createdAt: args.appliedAt,
    },
  });
  const context: LiteRuntimeAppliedAuthorityContext = {
    commitId,
    commitHash,
    revision,
    appliedAt: args.appliedAt,
    mutation,
  };
  const changesBeforeApply = totalChanges(args.db);
  const value = args.apply(context);
  if (totalChanges(args.db) !== changesBeforeApply + 1) {
    throw new Error("lite_runtime_applied_authority_apply_change_count_invalid");
  }
  const changesBeforeVerify = totalChanges(args.db);
  const rawVerified = args.verify({ ...context, value });
  if (totalChanges(args.db) !== changesBeforeVerify) {
    throw new Error("lite_runtime_applied_authority_verify_must_be_read_only");
  }
  const expectedByIdentity = new Map(args.mutations.map((mutation) => [
    canonicalAuthorityMutationIdentityKey(mutation),
    mutation,
  ]));
  const verified = canonicalizeAuthorityMutationVerificationV2(rawVerified.map((entry) => {
    const expectedEntry = expectedByIdentity.get(canonicalAuthorityMutationIdentityKey(entry));
    if (!expectedEntry || expectedEntry.after.commit_id !== "$self") return entry;
    return {
      ...entry,
      after: normalizeAppliedAuthorityRow(entry.table, entry.after, commitId),
    };
  }));
  const expected = canonicalAuthorityMutationVerificationProjection(mutation.mutations);
  if (stableStringify(verified) !== stableStringify(expected)) {
    throw new Error("lite_runtime_applied_authority_read_after_mismatch");
  }
  const cas = compareAndSwapLiteMemoryScopeHead({
    db: args.db,
    authorityFence,
    request: {
      scope: args.scope,
      commitId,
      expectedRevision: head?.revision ?? 0,
      expectedCommitId: head?.commitId ?? null,
    },
  });
  if (cas.status !== "advanced") {
    throw new Error(`lite_runtime_applied_authority_head_conflict:${args.scope}`);
  }
    args.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return { ...context, value };
  } catch (error) {
    try {
      args.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      args.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the authority failure. The owning transaction will fail its
      // own final fence if SQLite could not restore this savepoint.
    }
    throw error;
  }
}

type LiteRuntimeWriteOperationAuthorityRow = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string | null;
  created_at: string;
}>;

export const LITE_RUNTIME_OPERATION_AUTHORITY_ACTOR =
  "aionis-runtime-operation-authority" as const;

function exactOperationRow(value: unknown): LiteRuntimeWriteOperationAuthorityRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lite_runtime_operation_authority_row_missing");
  }
  return value as LiteRuntimeWriteOperationAuthorityRow;
}

export function appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
  tenantId: string;
  scope: string;
  operationKind: string;
  operationId: string;
  requestSha256: string;
  receiptJson: string;
  commitId: string | null;
  createdAt: string;
  actor?: string;
}): Readonly<{
  row: LiteRuntimeWriteOperationAuthorityRow;
  authorityCommitId: string;
  authorityCommitHash: string;
  authorityRevision: number;
}> {
  if (!args.tenantId.trim() || !args.scope.trim() || !args.operationKind.trim()
    || !args.operationId.trim() || !/^[a-f0-9]{64}$/u.test(args.requestSha256)) {
    throw new Error("lite_runtime_operation_authority_identity_invalid");
  }
  try {
    const parsed = JSON.parse(args.receiptJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
  } catch {
    throw new Error("lite_runtime_operation_authority_receipt_invalid");
  }
  if (args.commitId === "$self") {
    throw new Error("lite_runtime_operation_authority_domain_commit_reserved");
  }
  const identity = {
    tenant_id: args.tenantId,
    scope: args.scope,
    operation_kind: args.operationKind,
    operation_id: args.operationId,
  };
  const after = {
    ...identity,
    request_sha256: args.requestSha256,
    receipt_json: args.receiptJson,
    commit_id: args.commitId,
    created_at: args.createdAt,
  };
  const appended = appendLiteRuntimeAppliedAuthorityInCurrentTransaction({
    db: args.db,
    transaction: args.transaction,
    scope: args.scope,
    inputSha256: args.requestSha256,
    actor: args.actor ?? LITE_RUNTIME_OPERATION_AUTHORITY_ACTOR,
    appliedAt: args.createdAt,
    authorityKind: "runtime_operation_receipt",
    mutations: [{
      table: "lite_runtime_write_operations",
      identity,
      operation: "insert",
      before: null,
      requested: {
        scope: args.scope,
        operation_kind: args.operationKind,
        operation_id: args.operationId,
        domain_commit_id: args.commitId,
      },
      after,
    }],
    apply: () => {
      args.db.prepare(
        `INSERT INTO lite_runtime_write_operations
          (tenant_id, scope, operation_kind, operation_id, request_sha256,
           receipt_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.tenantId,
        args.scope,
        args.operationKind,
        args.operationId,
        args.requestSha256,
        args.receiptJson,
        args.commitId,
        args.createdAt,
      );
      return exactOperationRow(args.db.prepare(
        `SELECT tenant_id, scope, operation_kind, operation_id,
                request_sha256, receipt_json, commit_id, created_at
         FROM lite_runtime_write_operations
         WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
      ).get(args.tenantId, args.scope, args.operationKind, args.operationId));
    },
    verify: ({ value }) => [{ table: "lite_runtime_write_operations", identity, after: value }],
  });
  return {
    row: appended.value,
    authorityCommitId: appended.commitId,
    authorityCommitHash: appended.commitHash,
    authorityRevision: appended.revision,
  };
}
