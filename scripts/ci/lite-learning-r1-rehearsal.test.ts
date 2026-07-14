import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import type {
  LiteRuntimeBackupManifest,
  LiteRuntimeDataVerification,
  LiteRuntimeUpgradeReport,
} from "../../src/store/lite-runtime-data-operations.ts";
import { LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES } from "../../src/store/lite-learning-episode-ledger.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_OPS_CLI = path.join(ROOT, "scripts", "runtime-data-ops.ts");
const START_LITE = path.join(ROOT, "scripts", "start-lite.sh");
const FIXTURE_AT = "2026-07-13T00:00:00.000Z";

const PROTECTED_TABLES = [
  "lite_memory_commits",
  "lite_memory_nodes",
  "lite_memory_edges",
  "lite_product_guide_receipts",
  "lite_runtime_write_operations",
  "lite_memory_rule_feedback",
  "lite_product_measurements",
  "lite_skill_candidate_reviews",
] as const;

type ProtectedTable = typeof PROTECTED_TABLES[number];
type ProtectedSnapshot = {
  columns: Record<ProtectedTable, string[]>;
  counts: Record<ProtectedTable, number>;
  digest: string;
};

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type RuntimeProcess = {
  child: ChildProcess;
  baseUrl: string;
  logs(): string;
};

type BackupCliReport = {
  manifest: LiteRuntimeBackupManifest;
  verification: LiteRuntimeDataVerification;
};

type RestoreCliReport = {
  source_manifest: LiteRuntimeBackupManifest | null;
  verification: LiteRuntimeDataVerification;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child command timed out: ${command} ${args.join(" ")}\n${stderr}`));
    }, options.timeoutMs ?? 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function runDataOps<T>(args: string[]): Promise<T> {
  const result = await runCommand(
    process.execPath,
    ["--import", "tsx", DATA_OPS_CLI, ...args],
    { timeoutMs: 90_000 },
  );
  assert.equal(
    result.code,
    0,
    `runtime-data-ops ${args[0] ?? ""} failed (${result.signal ?? result.code}):\n${result.stderr}\n${result.stdout}`,
  );
  return JSON.parse(result.stdout) as T;
}

async function unusedTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

async function startRuntime(args: {
  writePath: string;
  replayPath: string;
  actorId: string;
}): Promise<RuntimeProcess> {
  const port = await unusedTcpPort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIONIS_EDITION: "lite",
    AIONIS_MODE: "local",
    APP_ENV: "ci",
    AIONIS_LISTEN_HOST: "127.0.0.1",
    AIONIS_ALLOW_UNAUTHENTICATED_REMOTE: "false",
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: "[]",
    MEMORY_AUTH_MODE: "off",
    TENANT_QUOTA_ENABLED: "false",
    RATE_LIMIT_BYPASS_LOOPBACK: "true",
    LITE_WRITE_SQLITE_PATH: args.writePath,
    LITE_REPLAY_SQLITE_PATH: args.replayPath,
    LITE_LOCAL_ACTOR_ID: args.actorId,
    LITE_INSPECTOR_ENABLED: "false",
    SANDBOX_ENABLED: "false",
    PORT: String(port),
  };
  assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "off");
  assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON, "[]");

  const child = spawn("bash", [START_LITE], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const runtime: RuntimeProcess = {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    logs: () => `${stdout}\n${stderr}`.trim(),
  };

  const deadline = Date.now() + 30_000;
  let lastError = "Runtime did not answer /readyz";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Runtime exited before readiness (${child.signalCode ?? child.exitCode}):\n${runtime.logs()}`);
    }
    let response: Response;
    try {
      response = await fetch(`${runtime.baseUrl}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      continue;
    }
    const text = await response.text();
    if (response.ok) {
      try {
        const body = JSON.parse(text) as Record<string, any>;
        assert.equal(body.ok, true);
        assert.equal(body.ready, true);
        assert.equal(body.edition, "lite");
        assert.equal(body.storage_backend, "lite_sqlite");
        assert.equal(body.checks?.write_store, true);
        assert.equal(body.checks?.recall_store, true);
      } catch (error) {
        await stopRuntime(runtime);
        throw error;
      }
      return runtime;
    }
    lastError = `/readyz returned ${response.status}: ${text}`;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`${lastError}\n${runtime.logs()}`);
}

async function stopRuntime(runtime: RuntimeProcess): Promise<void> {
  const { child } = runtime;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise, reject) => {
    child.once("exit", () => resolvePromise());
    child.once("error", reject);
  });
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 5_000)),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise<never>((_resolvePromise, reject) => {
        setTimeout(() => reject(new Error(`Runtime did not stop:\n${runtime.logs()}`)), 5_000);
      }),
    ]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, runtime.logs());
}

function insertPopulatedV2Rows(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO lite_memory_commits
      (id, scope, parent_commit_id, input_sha256, diff_json, actor,
       model_version, prompt_version, commit_hash, created_at)
     VALUES ('commit-r1', 'scope-r1', NULL, 'input-r1', '{}',
             'r1-rehearsal', NULL, NULL, 'commit-hash-r1', ?)`,
  ).run(FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_memory_nodes
      (id, scope, client_id, type, tier, title, text_summary, slots_json,
       raw_ref, evidence_ref, embedding_vector_json, embedding_model,
       memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
       embedding_status, embedding_last_error, salience, importance, confidence,
       redaction_version, commit_id, created_at)
     VALUES ('node-r1', 'scope-r1', 'client-r1', 'concept', 'hot', 'R1 continuity',
             'Preserve this dormant R1 authority row.', '{}', NULL, NULL, NULL, NULL,
             'shared', 'r1-rehearsal', 'r1-rehearsal', NULL, 'failed',
             'embedding_not_requested', 0.5, 0.5, 0.5, 1, 'commit-r1', ?)`,
  ).run(FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_memory_edges
      (id, scope, type, src_id, dst_id, weight, confidence, decay_rate,
       metadata_json, commit_id, created_at)
     VALUES ('edge-r1', 'scope-r1', 'related_to', 'node-r1', 'node-r1',
             0.5, 0.5, 0.1, '{}', 'commit-r1', ?)`,
  ).run(FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_product_guide_receipts
      (tenant_id, scope, guide_trace_id, run_id, consumer_agent_id,
       consumer_team_id, query_sha256, context_sha256, ledger_sha256,
       ledger_json, commit_id, created_at)
     VALUES ('tenant-r1', 'scope-r1', 'guide-r1', 'run-r1', 'agent-r1', NULL,
             ?, ?, ?, '{}', 'commit-r1', ?)`,
  ).run("1".repeat(64), "2".repeat(64), "3".repeat(64), FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_runtime_write_operations
      (tenant_id, scope, operation_kind, operation_id, request_sha256,
       receipt_json, commit_id, created_at)
     VALUES ('tenant-r1', 'scope-r1', 'r1-preservation', 'operation-r1',
             ?, '{}', 'commit-r1', ?)`,
  ).run("4".repeat(64), FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_memory_rule_feedback
      (id, scope, rule_node_id, run_id, outcome, note, source,
       decision_id, commit_id, created_at)
     VALUES ('feedback-r1', 'scope-r1', 'rule-r1', 'run-r1', 'neutral', NULL,
             'rule_feedback', NULL, 'commit-r1', ?)`,
  ).run(FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_product_measurements
      (measurement_id, tenant_id, scope, source, measurement_digest,
       effect_report_json, eligible_for_skill_export, evidence_status,
       runtime_evidence_ids_json, eligibility_reasons_json, created_by, created_at)
     VALUES ('measurement-r1', 'tenant-r1', 'scope-r1', 'product_trace', ?,
             '{}', 0, 'insufficient', '[]', '[]', 'r1-rehearsal', ?)`,
  ).run("5".repeat(64), FIXTURE_AT);
  db.prepare(
    `INSERT INTO lite_skill_candidate_reviews
      (candidate_id, tenant_id, scope, review_status, skill_name, label,
       export_ready, promotion_status, reason, source_ids_json,
       source_trace_ids_json, source_signal_ids_json, applies_when_json,
       does_not_apply_when_json, procedure_steps_json, target_files_json,
       acceptance_checks_json, failure_counterexamples_json, evidence_refs_json,
       candidate_json, measurement_id, measurement_digest, candidate_digest,
       eligible_for_promotion, row_version, reviewer_id, review_reason,
       created_at, updated_at, reviewed_at)
     VALUES ('candidate-r1', 'tenant-r1', 'scope-r1', 'pending_review',
             'Dormant R1 candidate', 'positive', 0, 'needs_more_evidence',
             'preserve row', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]',
             '[]', '[]', '{}', 'measurement-r1', ?, ?, 0, 1, NULL, NULL,
             ?, ?, NULL)`,
  ).run("5".repeat(64), "6".repeat(64), FIXTURE_AT, FIXTURE_AT);
}

async function createPopulatedV2Fixture(dbPath: string): Promise<void> {
  const initialized = createLiteWriteStore(dbPath, { annProjectionEnabled: false });
  await initialized.close();

  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const table of [...LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES].reverse()) {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    }
    for (const column of ["record_sha256", "after_episode_id", "baseline_episode_id"]) {
      db.exec(`ALTER TABLE lite_product_measurements DROP COLUMN ${quoteIdentifier(column)}`);
    }
    db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 2, updated_at = ?
       WHERE component = 'write_projection'`,
    ).run(FIXTURE_AT);
    insertPopulatedV2Rows(db);
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed DDL statement may already have ended the transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

function protectedSnapshot(
  dbPath: string,
  expectedColumns?: Record<ProtectedTable, string[]>,
): ProtectedSnapshot {
  const db = createSqliteDatabase(dbPath);
  try {
    const columns = {} as Record<ProtectedTable, string[]>;
    const counts = {} as Record<ProtectedTable, number>;
    const tables = PROTECTED_TABLES.map((table) => {
      const availableColumns = (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
        name: string;
      }>).map((row) => row.name);
      const selectedColumns = expectedColumns?.[table] ?? availableColumns;
      assert.ok(selectedColumns.length > 0, `${table} has no columns`);
      for (const column of selectedColumns) {
        assert.ok(availableColumns.includes(column), `${table}.${column} is missing`);
      }
      columns[table] = [...selectedColumns];
      const rows = db.prepare(
        `SELECT ${selectedColumns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`,
      ).all() as Array<Record<string, unknown>>;
      const canonicalRows = rows.map((row) => stableStringify(row)).sort();
      counts[table] = canonicalRows.length;
      return { table, columns: selectedColumns, rows: canonicalRows };
    });
    return {
      columns,
      counts,
      digest: sha256(stableStringify({
        contract_version: "aionis_learning_r1_protected_snapshot_v1",
        tables,
      })),
    };
  } finally {
    db.close();
  }
}

function authorityBundleDigest(
  dbPath: string,
  protectedColumns: Record<ProtectedTable, string[]>,
): string {
  const protectedState = protectedSnapshot(dbPath, protectedColumns);
  const db = createSqliteDatabase(dbPath);
  try {
    const schemaMetadata = db.prepare(
      `SELECT component, version, updated_at
       FROM lite_runtime_schema_metadata
       ORDER BY component`,
    ).all();
    const identity = db.prepare(
      `SELECT * FROM lite_runtime_authority_identity ORDER BY singleton`,
    ).all();
    const learningAuthorityRows = [...LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES]
      .sort()
      .map((table) => ({
        table,
        rows: (db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>)
          .map((row) => stableStringify(row))
          .sort(),
      }));
    return sha256(stableStringify({
      contract_version: "aionis_learning_r1_authority_bundle_v1",
      schema_metadata: schemaMetadata,
      identity,
      protected_digest: protectedState.digest,
      protected_counts: protectedState.counts,
      learning_authority_rows: learningAuthorityRows,
    }));
  } finally {
    db.close();
  }
}

function preservedVerificationCounts(snapshot: ProtectedSnapshot): LiteRuntimeUpgradeReport["preserved_counts"]["before"] {
  return {
    commits: snapshot.counts.lite_memory_commits,
    nodes: snapshot.counts.lite_memory_nodes,
    edges: snapshot.counts.lite_memory_edges,
    guide_receipts: snapshot.counts.lite_product_guide_receipts,
    write_operations: snapshot.counts.lite_runtime_write_operations,
    rule_feedback: snapshot.counts.lite_memory_rule_feedback,
    product_measurements: snapshot.counts.lite_product_measurements,
    skill_reviews: snapshot.counts.lite_skill_candidate_reviews,
  };
}

test("dormant R1 explicitly migrates, verifies, backs up, restores, and replays a populated v2 authority", {
  timeout: 180_000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-learning-r1-rehearsal-"));
  const fixturePath = path.join(directory, "fixture", "populated-v2.sqlite");
  const runtimePath = path.join(directory, "deployment", "runtime.sqlite");
  const replayPath = path.join(directory, "deployment", "replay.sqlite");
  const backupPath = path.join(directory, "backup", "runtime.backup.sqlite");
  const restoredPath = path.join(directory, "restored", "runtime.sqlite");
  const restoredReplayPath = path.join(directory, "restored", "replay.sqlite");
  let primaryRuntime: RuntimeProcess | null = null;
  let restoredRuntime: RuntimeProcess | null = null;

  try {
    assert.equal(path.isAbsolute(runtimePath), true);
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    await createPopulatedV2Fixture(fixturePath);
    fs.copyFileSync(fixturePath, runtimePath, fs.constants.COPYFILE_EXCL);

    const v2Snapshot = protectedSnapshot(runtimePath);
    assert.deepEqual(Object.values(v2Snapshot.counts), Array(PROTECTED_TABLES.length).fill(1));
    const v2Verification = await runDataOps<LiteRuntimeDataVerification>(["verify", "--db", runtimePath]);
    assert.equal(v2Verification.ok, true);
    assert.equal(v2Verification.schema.classification, "supported_previous_v2");
    assert.equal(v2Verification.schema.detected_version, 2);
    assert.deepEqual(
      preservedVerificationCounts(v2Snapshot),
      {
        commits: 1,
        nodes: 1,
        edges: 1,
        guide_receipts: 1,
        write_operations: 1,
        rule_feedback: 1,
        product_measurements: 1,
        skill_reviews: 1,
      },
    );

    const upgrade = await runDataOps<LiteRuntimeUpgradeReport>(["upgrade", "--db", runtimePath]);
    assert.equal(upgrade.before.classification, "supported_previous_v2");
    assert.equal(upgrade.after.classification, "current");
    assert.equal(upgrade.after.detected_version, 3);
    assert.deepEqual(upgrade.preserved_counts.before, preservedVerificationCounts(v2Snapshot));
    assert.deepEqual(upgrade.preserved_counts.after, preservedVerificationCounts(v2Snapshot));
    const migratedSnapshot = protectedSnapshot(runtimePath, v2Snapshot.columns);
    assert.deepEqual(migratedSnapshot.counts, v2Snapshot.counts);
    assert.equal(migratedSnapshot.digest, v2Snapshot.digest);

    primaryRuntime = await startRuntime({
      writePath: runtimePath,
      replayPath,
      actorId: "r1-primary",
    });
    const liveVerification = await runDataOps<LiteRuntimeDataVerification>(["verify", "--db", runtimePath]);
    assert.equal(liveVerification.ok, true);
    assert.equal(liveVerification.schema.detected_version, 3);
    assert.match(liveVerification.database_instance_id ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(
      preservedVerificationCounts(protectedSnapshot(runtimePath, v2Snapshot.columns)),
      preservedVerificationCounts(v2Snapshot),
    );
    const liveBundleDigest = authorityBundleDigest(runtimePath, v2Snapshot.columns);

    const backup = await runDataOps<BackupCliReport>([
      "backup",
      "--db",
      runtimePath,
      "--out",
      backupPath,
    ]);
    assert.equal(backup.verification.ok, true);
    assert.equal(backup.manifest.sha256, backup.verification.sha256);
    assert.equal(backup.manifest.database_instance_id, liveVerification.database_instance_id);
    assert.equal(backup.verification.database_instance_id, liveVerification.database_instance_id);
    assert.equal(sha256(fs.readFileSync(backupPath)), backup.manifest.sha256);
    assert.equal(authorityBundleDigest(backupPath, v2Snapshot.columns), liveBundleDigest);

    await stopRuntime(primaryRuntime);
    primaryRuntime = null;

    const restored = await runDataOps<RestoreCliReport>([
      "restore",
      "--backup",
      backupPath,
      "--to",
      restoredPath,
    ]);
    assert.ok(restored.source_manifest);
    assert.equal(restored.source_manifest.sha256, backup.manifest.sha256);
    assert.equal(restored.verification.ok, true);
    assert.equal(restored.verification.database_instance_id, liveVerification.database_instance_id);
    assert.equal(sha256(fs.readFileSync(restoredPath)), restored.verification.sha256);
    assert.equal(authorityBundleDigest(restoredPath, v2Snapshot.columns), liveBundleDigest);
    const restoredSnapshot = protectedSnapshot(restoredPath, v2Snapshot.columns);
    assert.deepEqual(restoredSnapshot.counts, v2Snapshot.counts);
    assert.equal(restoredSnapshot.digest, v2Snapshot.digest);

    restoredRuntime = await startRuntime({
      writePath: restoredPath,
      replayPath: restoredReplayPath,
      actorId: "r1-restored",
    });
    await stopRuntime(restoredRuntime);
    restoredRuntime = null;

    const replayVerification = await runDataOps<LiteRuntimeDataVerification>(["verify", "--db", restoredPath]);
    assert.equal(replayVerification.ok, true);
    assert.equal(replayVerification.database_instance_id, liveVerification.database_instance_id);
    assert.deepEqual(
      preservedVerificationCounts(protectedSnapshot(restoredPath, v2Snapshot.columns)),
      preservedVerificationCounts(v2Snapshot),
    );
    assert.equal(authorityBundleDigest(restoredPath, v2Snapshot.columns), liveBundleDigest);
  } finally {
    if (restoredRuntime) await stopRuntime(restoredRuntime);
    if (primaryRuntime) await stopRuntime(primaryRuntime);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
