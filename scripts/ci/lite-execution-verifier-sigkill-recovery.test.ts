import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import {
  createSqliteDatabase,
} from "../../src/store/sqlite.js";

const TENANT_ID = "tenant-sigkill-verifier";
const STORE_SCOPE =
  "tenant:tenant-sigkill-verifier:project:real-recovery";
const EXPECTED_ANSWER = "verified after real execution\n";

type ProbeMessage =
  | Readonly<{
      contract_version: "aionis_real_verifier_crash_probe_v1";
      event: "ready";
      pid: number;
      ppid: number;
      episode_id: string;
      verifier_invocation_id: string;
      launch_attempt_id: string;
      subject_root: string;
      answer_sha256: string;
    }>
  | Readonly<{
      contract_version: "aionis_real_verifier_crash_probe_v1";
      event: "completed";
      pid: number;
      answer_sha256: string;
      would_exit_code: 0;
    }>;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout_waiting_for_${label}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function childCompletion(child: ChildProcess): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function captureStream(
  stream: NodeJS.ReadableStream | null,
): { text(): string } {
  let value = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    value += chunk;
  });
  return { text: () => value };
}

async function waitForDatabaseState(
  databasePath: string,
  predicate: (counts: Readonly<{
    attempts: number;
    launchCommitted: number;
    spawnObserved: number;
    terminals: number;
    receipts: number;
  }>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(databasePath)) {
      const db = createSqliteDatabase(databasePath);
      try {
        const count = (sql: string): number => Number(
          (db.prepare(sql).get() as { count: number }).count,
        );
        const counts = {
          attempts: count(
            "SELECT count(*) AS count FROM lite_execution_verifier_launch_attempts",
          ),
          launchCommitted: count(
            `SELECT count(*) AS count
             FROM lite_execution_verifier_launch_attempt_events
             WHERE event_kind = 'launch_committed'`,
          ),
          spawnObserved: count(
            `SELECT count(*) AS count
             FROM lite_execution_verifier_launch_attempt_events
             WHERE event_kind = 'spawn_observed'`,
          ),
          terminals: count(
            `SELECT count(*) AS count
             FROM lite_execution_verifier_launch_attempt_events
             WHERE event_kind IN ('completed', 'interrupted')`,
          ),
          receipts: count(
            "SELECT count(*) AS count FROM lite_execution_verifier_receipts",
          ),
        };
        if (predicate(counts)) return;
      } finally {
        db.close();
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout_waiting_for_durable_verifier_database_state");
}

test("real SIGKILL after verifier spawn reopens as arm-caused failure and a late orphan cannot mint success", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "aionis-real-verifier-sigkill-"),
  );
  const databasePath = join(directory, "runtime.sqlite");
  const subjectRoot = join(directory, "subject");
  const verifierRoot = join(directory, "verifier");
  mkdirSync(subjectRoot, { mode: 0o700 });
  mkdirSync(verifierRoot, { mode: 0o700 });
  writeFileSync(join(subjectRoot, "answer.txt"), "not verified\n", "utf8");
  const verifierPath = join(verifierRoot, "sigkill-verifier.mjs");
  writeFileSync(
    verifierPath,
    `
      import { createHash } from "node:crypto";
      import { readFileSync, realpathSync } from "node:fs";
      import { connect } from "node:net";
      import { join } from "node:path";

      const subjectRoot = realpathSync(
        process.env.AIONIS_VERIFIER_SUBJECT_ROOT,
      );
      const answer = readFileSync(join(subjectRoot, "answer.txt"));
      const answerSha256 = createHash("sha256")
        .update(answer)
        .digest("hex");
      if (answerSha256 !== process.env.AIONIS_EXPECTED_ANSWER_SHA256) {
        process.exit(41);
      }
      const socket = connect({
        host: "127.0.0.1",
        port: Number(process.env.AIONIS_SIGKILL_PROBE_PORT),
      });
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(JSON.stringify({
          contract_version: "aionis_real_verifier_crash_probe_v1",
          event: "ready",
          pid: process.pid,
          ppid: process.ppid,
          episode_id: process.env.AIONIS_VERIFIER_EPISODE_ID,
          verifier_invocation_id:
            process.env.AIONIS_VERIFIER_INVOCATION_ID,
          launch_attempt_id:
            process.env.AIONIS_VERIFIER_LAUNCH_ATTEMPT_ID,
          subject_root: subjectRoot,
          answer_sha256: answerSha256,
        }) + "\\n");
      });
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\\n")) return;
        if (input.trim() !== "release") process.exit(42);
        socket.end(JSON.stringify({
          contract_version: "aionis_real_verifier_crash_probe_v1",
          event: "completed",
          pid: process.pid,
          answer_sha256: answerSha256,
          would_exit_code: 0,
        }) + "\\n");
      });
      socket.once("close", () => process.exit(0));
      setTimeout(() => process.exit(43), 25_000).unref();
    `,
    { encoding: "utf8", mode: 0o600 },
  );

  let probeSocket: Socket | null = null;
  let runtimeChild: ChildProcess | null = null;
  let orphanVerifierPid: number | null = null;
  const probeMessages: ProbeMessage[] = [];
  let publishReady!: (message: Extract<
    ProbeMessage,
    { event: "ready" }
  >) => void;
  let publishCompleted!: (message: Extract<
    ProbeMessage,
    { event: "completed" }
  >) => void;
  const readyPromise = new Promise<Extract<
    ProbeMessage,
    { event: "ready" }
  >>((resolve) => {
    publishReady = resolve;
  });
  const completedPromise = new Promise<Extract<
    ProbeMessage,
    { event: "completed" }
  >>((resolve) => {
    publishCompleted = resolve;
  });
  const server = createServer((socket) => {
    assert.equal(probeSocket, null, "only one verifier may connect");
    probeSocket = socket;
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = JSON.parse(line) as ProbeMessage;
        probeMessages.push(message);
        if (message.event === "ready") publishReady(message);
        if (message.event === "completed") publishCompleted(message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const childPath = join(
    import.meta.dirname,
    "support",
    "lite-execution-verifier-sigkill-child.ts",
  );
  const childEnvironment = (mode: "run" | "recover") => ({
    ...process.env,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    AIONIS_SIGKILL_CHILD_MODE: mode,
    AIONIS_SIGKILL_DATABASE_PATH: databasePath,
    AIONIS_SIGKILL_SUBJECT_ROOT: subjectRoot,
    AIONIS_SIGKILL_VERIFIER_PATH: verifierPath,
    AIONIS_SIGKILL_PROBE_PORT: String(address.port),
  });
  const spawnRuntime = (mode: "run" | "recover") => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", childPath],
      {
        env: childEnvironment(mode),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      child,
      stdout: captureStream(child.stdout),
      stderr: captureStream(child.stderr),
      completion: childCompletion(child),
    };
  };

  t.after(async () => {
    if (runtimeChild?.exitCode === null && runtimeChild.signalCode === null) {
      runtimeChild.kill("SIGKILL");
    }
    if (orphanVerifierPid !== null) {
      try {
        process.kill(orphanVerifierPid, "SIGKILL");
      } catch {
        // The real verifier already exited.
      }
    }
    probeSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  const first = spawnRuntime("run");
  runtimeChild = first.child;
  const ready = await withTimeout(
    readyPromise,
    12_000,
    "real_verifier_ready",
  );
  orphanVerifierPid = ready.pid;
  assert.equal(ready.ppid, first.child.pid);
  assert.equal(ready.answer_sha256, sha256(EXPECTED_ANSWER));
  assert.notEqual(ready.subject_root, subjectRoot);

  await waitForDatabaseState(
    databasePath,
    (counts) =>
      counts.attempts === 1
      && counts.launchCommitted === 1
      && counts.spawnObserved === 1
      && counts.terminals === 0
      && counts.receipts === 0,
  );
  assert.equal(first.child.kill("SIGKILL"), true);
  const killed = await withTimeout(
    first.completion,
    5_000,
    "runtime_sigkill_exit",
  );
  assert.equal(killed.code, null, first.stderr.text());
  assert.equal(killed.signal, "SIGKILL", first.stderr.text());

  const recovery = spawnRuntime("recover");
  runtimeChild = recovery.child;
  const recoveredExit = await withTimeout(
    recovery.completion,
    12_000,
    "runtime_recovery",
  );
  assert.equal(recoveredExit.code, 0, recovery.stderr.text());
  assert.equal(recoveredExit.signal, null, recovery.stderr.text());
  const recoveredLine = recovery.stdout.text().trim().split("\n").at(-1);
  assert.ok(recoveredLine);
  const recovered = JSON.parse(recoveredLine) as {
    recovery: {
      recovered_count: number;
      cleanup_failure_count: number;
    };
    close_replayed: boolean;
    verifier_status: string;
    verified_success: number | null;
    outcome_class: string | null;
    reward_authority: string | null;
  };
  assert.deepEqual(recovered.recovery, {
    recovered_count: 1,
    cleanup_failure_count: 0,
  });
  assert.equal(recovered.close_replayed, false);
  assert.equal(recovered.verifier_status, "infrastructure_error");
  assert.equal(recovered.verified_success, 0);
  assert.equal(recovered.outcome_class, "arm_caused_incomplete");
  assert.equal(recovered.reward_authority, "protocol_itt_failure");

  const db = createSqliteDatabase(databasePath);
  let materializedSubjectRoot: string;
  try {
    const attempt = db.prepare(
      `SELECT materialized_subject_root
       FROM lite_execution_verifier_launch_attempts`,
    ).get() as { materialized_subject_root: string };
    materializedSubjectRoot = attempt.materialized_subject_root;
    const events = db.prepare(
      `SELECT event_kind
       FROM lite_execution_verifier_launch_attempt_events
       ORDER BY event_sequence`,
    ).all() as Array<{ event_kind: string }>;
    assert.deepEqual(
      events.map((event) => event.event_kind),
      ["launch_committed", "spawn_observed", "interrupted"],
    );
    const truth = db.prepare(
      `SELECT receipt.status, receipt.infrastructure_failure_attribution,
              receipt.execution_exit_code, reward.verified_success,
              reward.outcome_class, reward.reward_authority,
              terminal.event_sha256 AS terminal_sha256,
              receipt.runtime_launch_sha256
       FROM lite_execution_verifier_receipts AS receipt
       JOIN lite_execution_episode_rewards AS reward
         ON reward.tenant_id = receipt.tenant_id
        AND reward.scope = receipt.scope
        AND reward.episode_id = receipt.episode_id
       JOIN lite_execution_verifier_launch_attempt_events AS terminal
         ON terminal.tenant_id = receipt.tenant_id
        AND terminal.scope = receipt.scope
        AND terminal.episode_id = receipt.episode_id
        AND terminal.event_kind = 'interrupted'`,
    ).get() as {
      status: string;
      infrastructure_failure_attribution: string | null;
      execution_exit_code: number | null;
      verified_success: number | null;
      outcome_class: string;
      reward_authority: string;
      terminal_sha256: string;
      runtime_launch_sha256: string;
    };
    assert.equal(truth.status, "infrastructure_error");
    assert.equal(truth.infrastructure_failure_attribution, "arm_caused");
    assert.equal(truth.execution_exit_code, null);
    assert.equal(truth.verified_success, 0);
    assert.equal(truth.outcome_class, "arm_caused_incomplete");
    assert.equal(truth.reward_authority, "protocol_itt_failure");
    assert.equal(truth.runtime_launch_sha256, truth.terminal_sha256);
    const passedReceipts = db.prepare(
      `SELECT count(*) AS count
       FROM lite_execution_verifier_receipts
       WHERE status = 'passed'`,
    ).get() as { count: number };
    assert.equal(passedReceipts.count, 0);
    const quickCheck = db.prepare("PRAGMA quick_check").all() as Array<
      { quick_check: string }
    >;
    assert.deepEqual(
      quickCheck.map((row) => row.quick_check),
      ["ok"],
    );
    assert.equal(
      db.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );
  } finally {
    db.close();
  }
  assert.equal(existsSync(dirname(materializedSubjectRoot)), false);

  assert.ok(probeSocket);
  probeSocket.write("release\n");
  const completed = await withTimeout(
    completedPromise,
    5_000,
    "late_orphan_completion",
  );
  assert.equal(completed.pid, ready.pid);
  assert.equal(completed.answer_sha256, sha256(EXPECTED_ANSWER));
  assert.equal(completed.would_exit_code, 0);
  const verifierExitDeadline = Date.now() + 5_000;
  while (Date.now() <= verifierExitDeadline) {
    try {
      process.kill(ready.pid, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } catch {
      orphanVerifierPid = null;
      break;
    }
  }

  const replayRecovery = spawnRuntime("recover");
  runtimeChild = replayRecovery.child;
  const replayExit = await withTimeout(
    replayRecovery.completion,
    12_000,
    "idempotent_recovery_replay",
  );
  assert.equal(replayExit.code, 0, replayRecovery.stderr.text());
  const replayLine =
    replayRecovery.stdout.text().trim().split("\n").at(-1);
  assert.ok(replayLine);
  const replay = JSON.parse(replayLine) as {
    recovery: {
      recovered_count: number;
      cleanup_failure_count: number;
    };
    close_replayed: boolean;
    verified_success: number | null;
  };
  assert.deepEqual(replay.recovery, {
    recovered_count: 0,
    cleanup_failure_count: 0,
  });
  assert.equal(replay.close_replayed, true);
  assert.equal(replay.verified_success, 0);

  const finalDb = createSqliteDatabase(databasePath);
  try {
    const counts = finalDb.prepare(
      `SELECT
         (SELECT count(*) FROM lite_execution_verifier_launch_attempts)
           AS attempts,
         (SELECT count(*) FROM lite_execution_verifier_launch_attempt_events)
           AS attempt_events,
         (SELECT count(*) FROM lite_execution_verifier_receipts)
           AS receipts,
         (SELECT count(*) FROM lite_execution_episode_rewards)
           AS rewards,
         (SELECT count(*) FROM lite_execution_verifier_receipts
          WHERE status = 'passed') AS passed_receipts`,
    ).get() as {
      attempts: number;
      attempt_events: number;
      receipts: number;
      rewards: number;
      passed_receipts: number;
    };
    assert.deepEqual({ ...counts }, {
      attempts: 1,
      attempt_events: 3,
      receipts: 1,
      rewards: 1,
      passed_receipts: 0,
    });
  } finally {
    finalDb.close();
  }
  assert.deepEqual(
    probeMessages.map((message) => message.event),
    ["ready", "completed"],
  );
});
