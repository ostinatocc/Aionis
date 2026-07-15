import { drainUnusedExposureLearningControlJobs } from "../../../src/jobs/unused-exposure-learning-control-worker.ts";
import { createLiteLearningControlJobAccess } from "../../../src/store/lite-learning-control-jobs.ts";
import { createLiteLearningEpisodeLedgerAccess } from "../../../src/store/lite-learning-episode-ledger.ts";
import { createLiteRuntimeDatabase } from "../../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../../src/store/lite-write-store.ts";

const dbPath = process.argv[2];
if (!dbPath) process.exit(64);
const crashMode = process.argv[3] ?? "after_complete";
if (crashMode !== "after_claim" && crashMode !== "after_complete") process.exit(63);

let armed = false;
let committedTransactions = 0;

const database = createLiteRuntimeDatabase(dbPath, {
  faultInjector: (phase) => {
    if (!armed || phase !== "after_commit") return;
    committedTransactions += 1;
    if (crashMode === "after_claim" && committedTransactions === 1) process.exit(74);
    if (crashMode === "after_complete" && committedTransactions === 2) process.exit(75);
  },
});
const writeStore = createLiteWriteStoreFromDatabase(database, {
  annProjectionEnabled: false,
});
const access = createLiteLearningControlJobAccess(database);
const ledger = createLiteLearningEpisodeLedgerAccess(database);
const [job] = await access.listLearningControlJobs({ statuses: ["pending", "leased"] });
if (!job) process.exit(65);
const drainAt = job.status === "leased" && job.lease_expires_at
  ? new Date(new Date(job.lease_expires_at).getTime() + 1)
  : new Date(new Date(job.created_at).getTime() + 60_000);

armed = true;
const result = await drainUnusedExposureLearningControlJobs({
  access,
  ledger,
  writeStore,
  env: {
    MEMORY_SCOPE: "default",
    MEMORY_TENANT_ID: "default",
    LITE_LOCAL_ACTOR_ID: "local-user",
    MAX_TEXT_LEN: 10_000,
    PII_REDACTION: false,
  },
  limit: 8,
  leaseOwner: "learning-control-post-commit-crash-child",
  now: () => drainAt,
});
if (result.completed !== 1 || result.claimed !== 1) process.exit(66);
process.exit(67);
