import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";
import type { SqliteDatabase } from "./sqlite.js";

const LITE_RUNTIME_AUTHORITY_TRANSACTION_FENCE: unique symbol =
  Symbol("lite-runtime-authority-transaction-fence");

/**
 * Opaque proof that an authority coordinator currently owns the SQLite write
 * transaction. The private symbol prevents callers from satisfying this type
 * with an object literal; only the two owned transaction coordinators mint it.
 */
export type LiteRuntimeAuthorityTransactionFence = Readonly<{
  [LITE_RUNTIME_AUTHORITY_TRANSACTION_FENCE]: true;
  assertCurrent(): void;
}>;

function createFence(assertCurrent: () => void): LiteRuntimeAuthorityTransactionFence {
  return Object.freeze({
    [LITE_RUNTIME_AUTHORITY_TRANSACTION_FENCE]: true as const,
    assertCurrent,
  });
}

export function authorityFenceForRuntimeTransaction(
  transaction: SqliteTransactionRunner,
): LiteRuntimeAuthorityTransactionFence {
  const identity = transaction.currentTransactionIdentity();
  if (!transaction.inTransaction() || identity === null) {
    throw new Error("lite_runtime_authority_requires_shared_transaction");
  }
  return createFence(() => {
    if (!transaction.inTransaction()
      || transaction.currentTransactionIdentity() !== identity) {
      throw new Error("lite_runtime_authority_transaction_identity_changed");
    }
  });
}

export type LiteRuntimeOwnedSchemaMigration = Readonly<{
  authorityFence: LiteRuntimeAuthorityTransactionFence;
  isOpen(): boolean;
  commit(): void;
  rollback(): void;
}>;

/** @internal Begins and exclusively owns the synchronous schema transaction. */
export function beginLiteRuntimeOwnedSchemaMigration(
  db: SqliteDatabase,
): LiteRuntimeOwnedSchemaMigration {
  db.exec("BEGIN IMMEDIATE");
  let state: "open" | "committed" | "rolled_back" = "open";
  const assertOpen = (): void => {
    if (state !== "open") {
      throw new Error("lite_runtime_authority_schema_migration_transaction_closed");
    }
  };
  const authorityFence = createFence(assertOpen);
  return Object.freeze({
    authorityFence,
    isOpen: () => state === "open",
    commit: () => {
      assertOpen();
      db.exec("COMMIT");
      state = "committed";
    },
    rollback: () => {
      assertOpen();
      try {
        db.exec("ROLLBACK");
      } finally {
        state = "rolled_back";
      }
    },
  });
}
