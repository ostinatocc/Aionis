import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1BootstrapPhase,
} from "../../../src/store/continuation-runtime-v1-database.js";

const [path, targetPhase] = process.argv.slice(2);
const phases: readonly ContinuationRuntimeV1BootstrapPhase[] = [
  "after_claim",
  "after_begin",
  "after_schema",
  "after_meta",
  "before_commit",
  "after_commit",
  "after_wal",
];

if (!path || !phases.includes(targetPhase as ContinuationRuntimeV1BootstrapPhase)) {
  throw new Error("usage: continuation-runtime-v1-bootstrap-crash-child.ts PATH PHASE");
}

openContinuationRuntimeV1Database(path, {
  authorityNow: () => "2026-07-21T00:00:00.000Z",
  databaseInstanceId: "a".repeat(64),
  bootstrapFaultInjector: (phase) => {
    if (phase !== targetPhase) return;
    process.kill(process.pid, "SIGKILL");
  },
});

throw new Error(`bootstrap crash phase was not reached: ${targetPhase}`);
