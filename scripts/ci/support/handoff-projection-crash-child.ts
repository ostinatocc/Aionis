import { createHandoffRouteService } from "../../../src/routes/handoff.ts";
import { createLiteRuntimeDatabase } from "../../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../../src/store/lite-write-store.ts";
import { DeterministicEmbeddingProvider } from "./deterministic-embedding.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("handoff projection crash child requires a SQLite path");

const database = createLiteRuntimeDatabase(dbPath, {
  faultInjector: (phase) => {
    if (phase === "after_commit") process.exit(74);
  },
});
const store = createLiteWriteStoreFromDatabase(database, {
  closeDatabaseOnClose: true,
  annProjectionEnabled: false,
});
const service = createHandoffRouteService({
  env: {
    AIONIS_EDITION: "lite",
    APP_ENV: "test",
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
    LITE_LOCAL_ACTOR_ID: "local-user",
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    EXECUTION_TREE_DEFAULT_ENABLED: false,
    LITE_INLINE_EMBEDDING_TIMEOUT_MS: 1_000,
  } as any,
  embedder: DeterministicEmbeddingProvider,
  liteWriteStore: store,
  executionStateStore: null,
  executionTreeStore: null,
});
await service.store({
  operation_id: "handoff-crash-op",
  tenant_id: "default",
  scope: "default",
  actor: "local-user",
  producer_agent_id: "local-user",
  owner_agent_id: "local-user",
  memory_lane: "private",
  anchor: "handoff-projection-crash",
  handoff_kind: "task_handoff",
  title: "Handoff projection crash",
  summary: "Commit the handoff receipt and durable embedding intent together.",
  handoff_text: "Resume after the process restarts.",
  target_files: ["src/routes/handoff.ts"],
  next_action: "Replay the receipt and recover the queued embedding.",
});
throw new Error("fault injector did not terminate the handoff process after commit");
