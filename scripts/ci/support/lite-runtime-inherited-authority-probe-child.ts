import {
  adoptLiteRuntimeInheritedAuthorityDatabase,
  closeLiteRuntimeInheritedAuthorityDatabase,
  inspectLiteRuntimeInheritedAuthorityDatabase,
  openLiteRuntimeInheritedAuthorityDatabaseSnapshot,
  runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction,
} from "../../../src/store/lite-runtime-inherited-authority-database.ts";

async function main(): Promise<void> {
  const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
  try {
    const inspection = inspectLiteRuntimeInheritedAuthorityDatabase(capability);
    const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
    const value = await runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
      capability,
      database,
      async () => {
        const row = database.db.prepare(
          "SELECT value FROM attestation_probe WHERE id = 1",
        ).get() as { value: string };
        return row.value;
      },
    );
    process.stdout.write(`${JSON.stringify({ inspection, value })}\n`);
  } finally {
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
  }
}

await main();
