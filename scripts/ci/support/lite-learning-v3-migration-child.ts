import { createLiteRuntimeDatabase } from "../../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../../src/store/lite-write-store.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Expected database path");

const database = createLiteRuntimeDatabase(dbPath);
const store = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
const identity = database.db.prepare(
  "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
).get() as { database_instance_id: string };
process.stdout.write(`${identity.database_instance_id}\n`);
await store.close();
await database.close();
