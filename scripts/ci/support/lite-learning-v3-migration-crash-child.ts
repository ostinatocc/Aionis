import { createLiteRuntimeDatabase } from "../../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteSchemaMigrationPhase,
} from "../../../src/store/lite-write-store.ts";

const dbPath = process.argv[2];
const killPhase = process.argv[3] as LiteWriteSchemaMigrationPhase | undefined;

if (!dbPath || !killPhase) {
  throw new Error("Expected database path and schema migration phase");
}

const database = createLiteRuntimeDatabase(dbPath);
createLiteWriteStoreFromDatabase(database, {
  annProjectionEnabled: false,
  schemaMigrationFaultInjector(phase) {
    if (phase === killPhase) process.kill(process.pid, "SIGKILL");
  },
});

throw new Error(`Schema migration child did not terminate at ${killPhase}`);
