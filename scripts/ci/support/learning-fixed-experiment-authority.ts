import {
  createLiteLearningFixedExperimentAuthorityAccess,
  type LiteLearningFixedExperimentAuthorityAccess,
} from "../../../packages/aionis-learning-authority/src/store/lite-learning-fixed-experiment-authority.js";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  openLiteRuntimeProtectedAuthorityDatabase,
  pinLiteRuntimeProtectedAuthorityDatabase,
  runLiteRuntimeProtectedAuthorityTransaction,
} from "../../../packages/aionis-learning-authority/src/store/lite-runtime-protected-authority-database.js";
import type { LiteRuntimeDatabase } from
  "../../../src/store/lite-runtime-database.js";
import type { SqliteTransactionRunOptions } from
  "../../../src/store/sqlite-transaction-runner.js";
import type { AuthorityReceiptResolvedKeyring } from
  "../../../src/util/authority-receipt-keys.js";

export type LearningFixedExperimentAuthoritySession = Readonly<{
  withTransaction<T>(
    fn: (authority: LiteLearningFixedExperimentAuthorityAccess) => Promise<T>,
    options?: SqliteTransactionRunOptions,
  ): Promise<T>;
  close(): Promise<void>;
}>;

export function openLearningFixedExperimentAuthoritySession(
  databasePath: string,
  options: Readonly<{
    authorityReceiptKeyring?: AuthorityReceiptResolvedKeyring;
  }> = {},
): LearningFixedExperimentAuthoritySession {
  const pin = pinLiteRuntimeProtectedAuthorityDatabase(databasePath);
  let database: LiteRuntimeDatabase;
  try {
    database = openLiteRuntimeProtectedAuthorityDatabase(pin);
  } catch (error) {
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    async withTransaction<T>(
      fn: (authority: LiteLearningFixedExperimentAuthorityAccess) => Promise<T>,
      transactionOptions?: SqliteTransactionRunOptions,
    ): Promise<T> {
      if (closePromise !== null) {
        throw new Error("learning fixed experiment authority session is closed");
      }
      return await runLiteRuntimeProtectedAuthorityTransaction(
        pin,
        database,
        async (capability) => await fn(
          createLiteLearningFixedExperimentAuthorityAccess({
            database,
            capability,
            authorityReceiptKeyring: options.authorityReceiptKeyring,
          }),
        ),
        transactionOptions,
      );
    },

    async close(): Promise<void> {
      if (closePromise === null) {
        closePromise = (async () => {
          try {
            await database.transaction.sealAndRun(async () => undefined);
          } finally {
            try {
              await database.close();
            } finally {
              closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
            }
          }
        })();
      }
      await closePromise;
    },
  });
}
