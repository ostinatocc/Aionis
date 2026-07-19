import {
  createLiteLearningExternalRunAuthorityAccess,
  type LiteLearningExternalRunAuthorityAccess,
} from "../../../packages/aionis-learning-authority/src/store/lite-learning-external-run-authority.js";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  openLiteRuntimeProtectedAuthorityDatabase,
  pinLiteRuntimeProtectedAuthorityDatabase,
  runLiteRuntimeProtectedAuthorityTransaction,
} from "../../../packages/aionis-learning-authority/src/store/lite-runtime-protected-authority-database.js";
import type { LiteRuntimeDatabase } from
  "../../../src/store/lite-runtime-database.js";

export type LearningExternalRunAuthoritySession = Readonly<{
  authority: LiteLearningExternalRunAuthorityAccess;
  close(): Promise<void>;
}>;

export function openLearningExternalRunAuthoritySession(
  databasePath: string,
): LearningExternalRunAuthoritySession {
  const pin = pinLiteRuntimeProtectedAuthorityDatabase(databasePath);
  let database: LiteRuntimeDatabase;
  try {
    database = openLiteRuntimeProtectedAuthorityDatabase(pin);
  } catch (error) {
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
    throw error;
  }
  let closePromise: Promise<void> | null = null;
  const mutate = async <T>(
    fn: (authority: LiteLearningExternalRunAuthorityAccess) => Promise<T>,
  ): Promise<T> => {
    if (closePromise !== null) {
      throw new Error("learning external run authority session is closed");
    }
    return await runLiteRuntimeProtectedAuthorityTransaction(
      pin,
      database,
      async (capability) => await fn(createLiteLearningExternalRunAuthorityAccess({
        database,
        capability,
      })),
    );
  };
  const authority: LiteLearningExternalRunAuthorityAccess = Object.freeze({
    reserveExternalRun: async (args) => await mutate(
      async (access) => await access.reserveExternalRun(args),
    ),
    consumeExternalTicket: async (args) => await mutate(
      async (access) => await access.consumeExternalTicket(args),
    ),
    closeReservedExternalRun: async (args) => await mutate(
      async (access) => await access.closeReservedExternalRun(args),
    ),
    recordExternalPreclaimHold: async (args) => await mutate(
      async (access) => await access.recordExternalPreclaimHold(args),
    ),
    claimExternalRun: async (args) => await mutate(
      async (access) => await access.claimExternalRun(args),
    ),
    bindExternalSupervisor: async (args) => await mutate(
      async (access) => await access.bindExternalSupervisor(args),
    ),
    terminateExternalSession: async (args) => await mutate(
      async (access) => await access.terminateExternalSession(args),
    ),
  });
  return Object.freeze({
    authority,
    async close() {
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
