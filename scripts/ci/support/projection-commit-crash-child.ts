import { persistLitePreparedWrite } from "../../../src/memory/lite-projected-write-commit.ts";
import { prepareMemoryWrite } from "../../../src/memory/write.ts";
import { createLiteRuntimeDatabase } from "../../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../../src/store/lite-write-store.ts";
import { DeterministicEmbeddingProvider } from "./deterministic-embedding.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("projection crash child requires a SQLite path");

const database = createLiteRuntimeDatabase(dbPath, {
  faultInjector: (phase) => {
    if (phase === "after_commit") process.exit(73);
  },
});
const store = createLiteWriteStoreFromDatabase(database, {
  closeDatabaseOnClose: true,
  annProjectionEnabled: true,
});
const writeOptions = {
  maxTextLen: 20_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
};
const prepared = await prepareMemoryWrite(
  {
    tenant_id: "default",
    scope: "default",
    actor: "projection-crash-child",
    input_text: "The process exits at the first instruction after SQLite commit.",
    auto_embed: true,
    nodes: [{
      client_id: "projection:real-process-crash",
      type: "concept",
      title: "Real process crash projection",
      text_summary: "The durable job must survive an immediate process exit.",
      memory_lane: "shared",
    }],
  },
  "default",
  "default",
  writeOptions,
  DeterministicEmbeddingProvider,
);
await persistLitePreparedWrite({
  prepared,
  liteWriteStore: store,
  writeOptions,
});
throw new Error("fault injector did not terminate the process after commit");
