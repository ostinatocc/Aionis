import { readFileSync } from "node:fs";

import {
  publishLearningExternalEvidenceReceipt,
} from "../../../src/operator/learning-external-evidence-receipt-writer.js";
import {
  ingestLiteLearningExternalEvidence,
  type LiteLearningExternalEvidenceServiceInput,
} from "../../../src/store/lite-learning-external-evidence-service.js";
import type { SqliteTransactionPhase } from
  "../../../src/store/sqlite-transaction-runner.js";

type ChildMode =
  | "normal"
  | "hold_before_commit"
  | "crash_after_artifact_insert"
  | "crash_after_operation_insert"
  | "crash_before_commit"
  | "crash_after_commit";

type ParentCommand = Readonly<{ type: "go" | "release_lock" }>;

type ChildConfig = Readonly<{
  serviceInput: LiteLearningExternalEvidenceServiceInput;
  recordedAt: string;
}>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requiredArg(index: number, label: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`external evidence ingest child requires ${label}`);
  return value;
}

function parseMode(value: string): ChildMode {
  const modes = new Set<ChildMode>([
    "normal",
    "hold_before_commit",
    "crash_after_artifact_insert",
    "crash_after_operation_insert",
    "crash_before_commit",
    "crash_after_commit",
  ]);
  if (!modes.has(value as ChildMode)) {
    throw new Error(`external evidence ingest child mode is invalid: ${value}`);
  }
  return value as ChildMode;
}

function hardCrash(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL unexpectedly returned");
}

const configPath = requiredArg(2, "config path");
const childIndexRaw = requiredArg(3, "child index");
const actorId = requiredArg(4, "actor ID");
const operationId = requiredArg(5, "operation ID");
const mode = parseMode(requiredArg(6, "mode"));
const busyTimeoutRaw = requiredArg(7, "busy timeout");
const outputPath = requiredArg(8, "receipt output path");
if (!process.send) throw new Error("external evidence ingest child requires IPC");
const childIndex = Number(childIndexRaw);
const busyTimeoutMs = Number(busyTimeoutRaw);
if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex > 255) {
  throw new Error("external evidence ingest child index must be one byte");
}
if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 5_000) {
  throw new Error("external evidence ingest child busy timeout must be 1..5000 ms");
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as ChildConfig;
const startGate = deferred();
const releaseLockGate = deferred();
process.on("message", (message: ParentCommand) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "go") startGate.resolve();
  if (message.type === "release_lock") releaseLockGate.resolve();
});

let heldBeforeCommit = false;
const databasePhase = async (phase: SqliteTransactionPhase): Promise<void> => {
  if (mode === "hold_before_commit" && phase === "before_commit" && !heldBeforeCommit) {
    heldBeforeCommit = true;
    process.send?.({ type: "lock_held", childIndex });
    await releaseLockGate.promise;
    return;
  }
  if (mode === "crash_before_commit" && phase === "before_commit") hardCrash();
  if (mode === "crash_after_commit" && phase === "after_commit") hardCrash();
};

process.send({ type: "ready", childIndex });

try {
  let rejectStartTimeout!: (error: Error) => void;
  const startTimeoutPromise = new Promise<never>((_, reject) => {
    rejectStartTimeout = reject;
  });
  const startTimeout = setTimeout(() => {
    rejectStartTimeout(new Error("external evidence ingest child start barrier timed out"));
  }, 20_000);
  try {
    await Promise.race([startGate.promise, startTimeoutPromise]);
  } finally {
    clearTimeout(startTimeout);
  }
  const startedAt = Date.now();
  process.send({ type: "service_calling", childIndex, startedAt });
  const result = await ingestLiteLearningExternalEvidence({
    ...config.serviceInput,
    actorId,
    operationId,
  }, {
    busyTimeoutMs,
    databasePhase,
    ingestionPhase(phase) {
      if (mode === "crash_after_artifact_insert" && phase === "after_artifact_insert") {
        hardCrash();
      }
      if (mode === "crash_after_operation_insert" && phase === "after_operation_insert") {
        hardCrash();
      }
    },
    now: () => new Date(config.recordedAt),
  });
  const published = publishLearningExternalEvidenceReceipt({
    destination: outputPath,
    receiptJson: result.receiptJson,
  });
  process.send({
    type: "result",
    ok: true,
    childIndex,
    replayed: result.replayed,
    receiptJson: result.receiptJson,
    receiptSha256: published.receipt_sha256,
    publishStatus: published.status,
    elapsedMs: Date.now() - startedAt,
  });
} catch (error) {
  process.send({
    type: "result",
    ok: false,
    childIndex,
    code: typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
      ? error.code
      : null,
    message: error instanceof Error ? error.message : String(error),
  });
}

process.disconnect();
