import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import { createLiteLearningEpisodeLedgerAccess } from
  "../../src/store/lite-learning-episode-ledger.js";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.js";
import { createSqliteReadOnlyDatabase } from "../../src/store/sqlite.js";
import {
  cloneLearningExternalEvidenceIngestFixture,
  createLearningExternalEvidenceIngestFixture,
  type LearningExternalEvidenceIngestFixture,
} from "./support/learning-external-evidence-ingest-fixture.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHILD = fileURLToPath(
  new URL("./support/learning-external-evidence-ingest-child.ts", import.meta.url),
);
const CLI = join(ROOT, "scripts", "learning-evidence.ts");

type ChildMode =
  | "normal"
  | "hold_before_commit"
  | "crash_after_artifact_insert"
  | "crash_after_operation_insert"
  | "crash_before_commit"
  | "crash_after_commit";

type ChildSuccess = Readonly<{
  type: "result";
  ok: true;
  childIndex: number;
  replayed: boolean;
  receiptJson: string;
  receiptSha256: string;
  publishStatus: "published" | "exact_replay";
  elapsedMs: number;
}>;

type ChildFailure = Readonly<{
  type: "result";
  ok: false;
  childIndex: number;
  code: string | null;
  message: string;
}>;

type ChildResult = ChildSuccess | ChildFailure;

type ChildExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type RunningChild = Readonly<{
  process: ChildProcess;
  ready: Promise<void>;
  lockHeld: Promise<void>;
  serviceCalling: Promise<void>;
  result: Promise<ChildResult>;
  exit: Promise<ChildExit>;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeChildConfig(fixture: LearningExternalEvidenceIngestFixture): string {
  const path = join(fixture.rootDirectory, "child-config.json");
  writeFileSync(path, stableStringify({
    serviceInput: fixture.serviceInput,
    recordedAt: fixture.recordedAt,
  }), { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function startChild(args: Readonly<{
  fixture: LearningExternalEvidenceIngestFixture;
  configPath: string;
  childIndex: number;
  actorId: string;
  operationId: string;
  mode: ChildMode;
  busyTimeoutMs: number;
  outputPath: string;
}>): RunningChild {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    CHILD,
    args.configPath,
    String(args.childIndex),
    args.actorId,
    args.operationId,
    args.mode,
    String(args.busyTimeoutMs),
    args.outputPath,
  ], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const ready = deferred<void>();
  const lockHeld = deferred<void>();
  const serviceCalling = deferred<void>();
  const result = deferred<ChildResult>();
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const typed = message as { type: string };
    if (typed.type === "ready") ready.resolve();
    if (typed.type === "lock_held") lockHeld.resolve();
    if (typed.type === "service_calling") serviceCalling.resolve();
    if (typed.type === "result") result.resolve(message as ChildResult);
  });
  const exit = new Promise<ChildExit>((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      ready.reject(error);
      lockHeld.reject(error);
      serviceCalling.reject(error);
      result.reject(error);
      rejectExit(error);
    });
    child.once("close", (code, signal) => {
      resolveExit({ code, signal, stdout, stderr });
    });
  });
  return {
    process: child,
    ready: ready.promise,
    lockHeld: lockHeld.promise,
    serviceCalling: serviceCalling.promise,
    result: result.promise,
    exit,
  };
}

async function completedResult(child: RunningChild, label: string): Promise<ChildResult> {
  const value = await within(child.result, `${label} result`);
  const exit = await within(child.exit, `${label} exit`);
  assert.equal(exit.code, 0, `${label} exited unexpectedly: ${exit.stderr}`);
  assert.equal(exit.signal, null, `${label} was signalled: ${String(exit.signal)}`);
  return value;
}

function counts(databasePath: string): Readonly<{
  artifacts: number;
  operations: number;
  receiptJson: string | null;
  operationId: string | null;
}> {
  const db = createSqliteReadOnlyDatabase(databasePath);
  try {
    const artifacts = db.prepare(
      "SELECT COUNT(*) AS count FROM lite_learning_evidence_artifacts",
    ).get() as { count: number };
    const operations = db.prepare(
      `SELECT operation_id, receipt_json
       FROM lite_runtime_write_operations
       WHERE scope = 'learning_external_authority_v1'
         AND operation_kind = 'learning_evidence_ingest_v1'
       ORDER BY operation_id`,
    ).all() as Array<{ operation_id: string; receipt_json: string }>;
    return {
      artifacts: Number(artifacts.count),
      operations: operations.length,
      receiptJson: operations[0]?.receipt_json ?? null,
      operationId: operations[0]?.operation_id ?? null,
    };
  } finally {
    db.close();
  }
}

async function verifyFreshConnection(databasePath: string): Promise<void> {
  const database = createLiteRuntimeDatabase(databasePath);
  try {
    const ledger = createLiteLearningEpisodeLedgerAccess(database);
    await ledger.verifyIntegrity();
  } finally {
    await database.close();
  }
}

function assertSafeReceipt(path: string, expected: string): void {
  const stat = lstatSync(path);
  assert.ok(stat.isFile());
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  assert.equal(readFileSync(path, "utf8"), expected);
}

function cliArgs(
  fixture: LearningExternalEvidenceIngestFixture,
  outputPath: string,
): string[] {
  const input = fixture.serviceInput;
  return [
    "--import",
    "tsx",
    CLI,
    "ingest",
    "--db",
    input.databasePath,
    "--tenant",
    input.tenantId,
    "--actor",
    input.actorId,
    "--operation-id",
    input.operationId,
    "--kind",
    input.artifactKind,
    "--public-run-authority",
    input.publicRunAuthorityPath,
    "--run-bundle",
    input.archivePath,
    "--series-id",
    input.evidenceSeriesId,
    "--task-family",
    input.taskFamily,
    "--applicable-experiment-id",
    input.applicableExperimentId,
    "--applicable-revision",
    String(input.applicableExperimentRevision),
    "--out",
    outputPath,
  ];
}

test("external evidence CLI, process contention, and hard crashes preserve one atomic authority pair", {
  // Every child independently re-verifies the bounded Git metadata/ACL trust
  // snapshot. Keep this integration timeout above the deliberate security cost
  // while each individual process remains bounded by the reader limits.
  timeout: 900_000,
}, async (t) => {
  const base = await createLearningExternalEvidenceIngestFixture();
  try {
    await t.test("formal CLI publishes one 0600 receipt and exact replay is byte-identical", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "formal-cli");
      const outputPath = join(fixture.rootDirectory, "receipt.json");
      const first = spawnSync(process.execPath, cliArgs(fixture, outputPath), {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        shell: false,
      });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.signal, null);
      const firstReceipt = first.stdout.trimEnd();
      assert.ok(firstReceipt.length > 0);
      assertSafeReceipt(outputPath, firstReceipt);
      const persisted = counts(fixture.databasePath);
      assert.deepEqual(
        { artifacts: persisted.artifacts, operations: persisted.operations },
        { artifacts: 1, operations: 1 },
      );
      assert.equal(persisted.receiptJson, firstReceipt);

      const replay = spawnSync(process.execPath, cliArgs(fixture, outputPath), {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        shell: false,
      });
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(replay.signal, null);
      assert.equal(replay.stdout, first.stdout);
      assertSafeReceipt(outputPath, firstReceipt);
      assert.deepEqual(
        { artifacts: counts(fixture.databasePath).artifacts,
          operations: counts(fixture.databasePath).operations },
        { artifacts: 1, operations: 1 },
      );
      await verifyFreshConnection(fixture.databasePath);
    });

    await t.test("formal CLI reports a committed output conflict and same-operation retry recovers", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "formal-cli-output-conflict");
      const outputPath = join(fixture.rootDirectory, "receipt.json");
      writeFileSync(outputPath, stableStringify({ conflict: true }), {
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(outputPath, 0o600);

      const failed = spawnSync(process.execPath, cliArgs(fixture, outputPath), {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        shell: false,
      });
      assert.equal(failed.status, 1);
      assert.equal(failed.signal, null);
      assert.equal(failed.stdout, "");
      // Node's experimental SQLite warning may share stderr with the formal
      // one-line envelope; select the sole canonical JSON line explicitly.
      const failureLines = failed.stderr
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("{"));
      assert.equal(failureLines.length, 1, failed.stderr);
      const failureText = failureLines[0]!;
      const failure = JSON.parse(failureText) as Record<string, unknown>;
      assert.equal(stableStringify(failure), failureText);
      assert.equal(failure.code, "learning_external_evidence_receipt_output_failed_after_commit");
      assert.equal(failure.committed, true);
      assert.equal(failure.retry, "same_operation_id");
      const committed = counts(fixture.databasePath);
      assert.deepEqual(
        { artifacts: committed.artifacts, operations: committed.operations },
        { artifacts: 1, operations: 1 },
      );
      assert.ok(committed.receiptJson);

      rmSync(outputPath);
      const replay = spawnSync(process.execPath, cliArgs(fixture, outputPath), {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        shell: false,
      });
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(replay.signal, null);
      assert.equal(replay.stdout, `${committed.receiptJson}\n`);
      assertSafeReceipt(outputPath, committed.receiptJson!);
      await verifyFreshConnection(fixture.databasePath);
    });

    await t.test("same operation and archive retry through a real 250 ms busy window", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "same-operation");
      const configPath = writeChildConfig(fixture);
      const outputPath = join(fixture.rootDirectory, "receipt.json");
      const holder = startChild({
        fixture,
        configPath,
        childIndex: 1,
        actorId: fixture.serviceInput.actorId,
        operationId: fixture.serviceInput.operationId,
        mode: "hold_before_commit",
        busyTimeoutMs: 5_000,
        outputPath,
      });
      await within(holder.ready, "holder ready");
      holder.process.send?.({ type: "go" });
      await within(holder.lockHeld, "holder before_commit lock");

      const contender = startChild({
        fixture,
        configPath,
        childIndex: 2,
        actorId: fixture.serviceInput.actorId,
        operationId: fixture.serviceInput.operationId,
        mode: "normal",
        busyTimeoutMs: 250,
        outputPath,
      });
      await within(contender.ready, "contender ready");
      contender.process.send?.({ type: "go" });
      await within(contender.serviceCalling, "contender service call");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      holder.process.send?.({ type: "release_lock" });

      const holderResult = await completedResult(holder, "holder");
      const contenderResult = await completedResult(contender, "contender");
      assert.equal(holderResult.ok, true);
      assert.equal(contenderResult.ok, true);
      if (!holderResult.ok || !contenderResult.ok) return;
      assert.equal(holderResult.replayed, false);
      assert.equal(contenderResult.replayed, true);
      assert.equal(holderResult.receiptJson, contenderResult.receiptJson);
      assert.ok(
        contenderResult.elapsedMs >= 500,
        `contender bypassed the held writer lock in ${String(contenderResult.elapsedMs)} ms`,
      );
      assert.deepEqual(
        new Set([holderResult.publishStatus, contenderResult.publishStatus]),
        new Set(["published", "exact_replay"]),
      );
      assertSafeReceipt(outputPath, holderResult.receiptJson);
      assert.deepEqual(
        { artifacts: counts(fixture.databasePath).artifacts,
          operations: counts(fixture.databasePath).operations },
        { artifacts: 1, operations: 1 },
      );
      await verifyFreshConnection(fixture.databasePath);
    });

    await t.test("different operations targeting one artifact have one winner and one conflict", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "operation-conflict");
      const configPath = writeChildConfig(fixture);
      const children = [0, 1].map((index) => startChild({
        fixture,
        configPath,
        childIndex: index,
        actorId: fixture.serviceInput.actorId,
        operationId: `${fixture.serviceInput.operationId}-${String(index)}`,
        mode: "normal",
        busyTimeoutMs: 5_000,
        outputPath: join(fixture.rootDirectory, `receipt-${String(index)}.json`),
      }));
      await Promise.all(children.map(async (child) => await within(child.ready, "child ready")));
      for (const child of children) child.process.send?.({ type: "go" });
      const results = await Promise.all(children.map(
        async (child, index) => await completedResult(child, `operation child ${String(index)}`),
      ));
      const successes = results.filter((value): value is ChildSuccess => value.ok);
      const failures = results.filter((value): value is ChildFailure => !value.ok);
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(successes[0]!.replayed, false);
      assert.match(failures[0]!.message, /artifact prefix exists/u);
      assert.deepEqual(
        { artifacts: counts(fixture.databasePath).artifacts,
          operations: counts(fixture.databasePath).operations },
        { artifacts: 1, operations: 1 },
      );
      await verifyFreshConnection(fixture.databasePath);
    });

    await t.test("same operation with different actors has one winner and one request conflict", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "actor-conflict");
      const configPath = writeChildConfig(fixture);
      const children = [0, 1].map((index) => startChild({
        fixture,
        configPath,
        childIndex: index,
        actorId: `${fixture.serviceInput.actorId}-${String(index)}`,
        operationId: fixture.serviceInput.operationId,
        mode: "normal",
        busyTimeoutMs: 5_000,
        outputPath: join(fixture.rootDirectory, `receipt-${String(index)}.json`),
      }));
      await Promise.all(children.map(async (child) => await within(child.ready, "child ready")));
      for (const child of children) child.process.send?.({ type: "go" });
      const results = await Promise.all(children.map(
        async (child, index) => await completedResult(child, `actor child ${String(index)}`),
      ));
      const successes = results.filter((value): value is ChildSuccess => value.ok);
      const failures = results.filter((value): value is ChildFailure => !value.ok);
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(successes[0]!.replayed, false);
      assert.match(failures[0]!.message, /ingest_mismatch:replay\.request/u);
      assert.deepEqual(
        { artifacts: counts(fixture.databasePath).artifacts,
          operations: counts(fixture.databasePath).operations },
        { artifacts: 1, operations: 1 },
      );
      await verifyFreshConnection(fixture.databasePath);
    });

    for (const mode of [
      "crash_after_artifact_insert",
      "crash_after_operation_insert",
      "crash_before_commit",
    ] as const) {
      await t.test(`${mode} leaves zero rows and an exact retry is fresh`, async () => {
        const fixture = cloneLearningExternalEvidenceIngestFixture(
          base,
          mode.replaceAll("_", "-"),
        );
        const configPath = writeChildConfig(fixture);
        const outputPath = join(fixture.rootDirectory, "receipt.json");
        const crashing = startChild({
          fixture,
          configPath,
          childIndex: 1,
          actorId: fixture.serviceInput.actorId,
          operationId: fixture.serviceInput.operationId,
          mode,
          busyTimeoutMs: 5_000,
          outputPath,
        });
        await within(crashing.ready, `${mode} ready`);
        crashing.process.send?.({ type: "go" });
        const crashExit = await within(crashing.exit, `${mode} exit`);
        assert.equal(crashExit.code, null);
        assert.equal(crashExit.signal, "SIGKILL");
        assert.equal(existsSync(outputPath), false);
        assert.deepEqual(
          { artifacts: counts(fixture.databasePath).artifacts,
            operations: counts(fixture.databasePath).operations },
          { artifacts: 0, operations: 0 },
        );

        const retry = startChild({
          fixture,
          configPath,
          childIndex: 2,
          actorId: fixture.serviceInput.actorId,
          operationId: fixture.serviceInput.operationId,
          mode: "normal",
          busyTimeoutMs: 5_000,
          outputPath,
        });
        await within(retry.ready, `${mode} retry ready`);
        retry.process.send?.({ type: "go" });
        const retried = await completedResult(retry, `${mode} retry`);
        assert.equal(retried.ok, true);
        if (!retried.ok) return;
        assert.equal(retried.replayed, false);
        assertSafeReceipt(outputPath, retried.receiptJson);
        assert.deepEqual(
          { artifacts: counts(fixture.databasePath).artifacts,
            operations: counts(fixture.databasePath).operations },
          { artifacts: 1, operations: 1 },
        );
        await verifyFreshConnection(fixture.databasePath);
      });
    }

    await t.test("after_commit hard exit leaves one pair and retry re-emits identical bytes", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "after-commit");
      const configPath = writeChildConfig(fixture);
      const outputPath = join(fixture.rootDirectory, "receipt.json");
      const crashing = startChild({
        fixture,
        configPath,
        childIndex: 1,
        actorId: fixture.serviceInput.actorId,
        operationId: fixture.serviceInput.operationId,
        mode: "crash_after_commit",
        busyTimeoutMs: 5_000,
        outputPath,
      });
      await within(crashing.ready, "after_commit ready");
      crashing.process.send?.({ type: "go" });
      const crashExit = await within(crashing.exit, "after_commit exit");
      assert.equal(crashExit.code, null);
      assert.equal(crashExit.signal, "SIGKILL");
      assert.equal(existsSync(outputPath), false);
      const committed = counts(fixture.databasePath);
      assert.deepEqual(
        { artifacts: committed.artifacts, operations: committed.operations },
        { artifacts: 1, operations: 1 },
      );
      assert.ok(committed.receiptJson);

      const retry = startChild({
        fixture,
        configPath,
        childIndex: 2,
        actorId: fixture.serviceInput.actorId,
        operationId: fixture.serviceInput.operationId,
        mode: "normal",
        busyTimeoutMs: 5_000,
        outputPath,
      });
      await within(retry.ready, "after_commit retry ready");
      retry.process.send?.({ type: "go" });
      const retried = await completedResult(retry, "after_commit retry");
      assert.equal(retried.ok, true);
      if (!retried.ok || committed.receiptJson === null) return;
      assert.equal(retried.replayed, true);
      assert.equal(retried.receiptJson, committed.receiptJson);
      assertSafeReceipt(outputPath, committed.receiptJson);
      assert.deepEqual(
        { artifacts: counts(fixture.databasePath).artifacts,
          operations: counts(fixture.databasePath).operations },
        { artifacts: 1, operations: 1 },
      );
      await verifyFreshConnection(fixture.databasePath);
    });

    await t.test("reopen integrity no longer depends on the external archive repository", async () => {
      const fixture = cloneLearningExternalEvidenceIngestFixture(base, "archive-independent-reopen");
      const outputPath = join(fixture.rootDirectory, "receipt.json");
      const ingested = spawnSync(process.execPath, cliArgs(fixture, outputPath), {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        shell: false,
      });
      assert.equal(ingested.status, 0, ingested.stderr);
      assert.equal(ingested.signal, null);
      assert.deepEqual(
        { artifacts: counts(fixture.databasePath).artifacts,
          operations: counts(fixture.databasePath).operations },
        { artifacts: 1, operations: 1 },
      );

      rmSync(base.evidenceRepositoryPath, { recursive: true, force: true });
      assert.equal(existsSync(base.archivePath), false);
      assert.equal(existsSync(base.publicRunAuthorityPath), false);
      await verifyFreshConnection(fixture.databasePath);
      assertSafeReceipt(outputPath, ingested.stdout.trimEnd());
    });
  } finally {
    rmSync(base.rootDirectory, { recursive: true, force: true });
  }
});
