import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import {
  acquireLiteRuntimeAttestationWriterFence,
  assertLiteRuntimeAttestationWriterFence,
  inspectLiteRuntimeAttestationWriterFence,
  LiteRuntimeAttestationWriterFenceError,
  liteRuntimeAttestationWriterFenceInspectionDigest,
  openLiteRuntimeAttestationDatabaseHandoffDescriptor,
  releaseLiteRuntimeAttestationWriterFence,
  type LiteRuntimeAttestationWriterFenceCapability,
  type LiteRuntimeAttestationWriterFenceErrorCode,
} from "../../packages/aionis-learning-authority/src/store/lite-runtime-attestation-writer-fence.ts";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  LiteRuntimeProtectedAuthorityDatabaseError,
  pinLiteRuntimeProtectedAuthorityDatabase,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "../../packages/aionis-learning-authority/src/store/lite-runtime-protected-authority-database.ts";
import {
  createSqliteDatabase,
  createSqliteReadOnlyDatabase,
  createSqliteReadWriteExistingDatabase,
  type SqliteDatabase,
} from "../../src/store/sqlite.ts";

const SUPPORTED_PLATFORM = process.platform === "darwin" || process.platform === "linux";
const INHERITED_PROBE_CHILD = path.resolve(
  "scripts/ci/support/lite-runtime-inherited-authority-probe-child.ts",
);
const POST_BEGIN_MUTATOR = String.raw`
const fs = require("node:fs");
const walPath = process.argv[1];
const databasePath = process.argv[2];
const deadline = Date.now() + 10_000;
let ready = false;
const interval = setInterval(() => {
  if (Date.now() >= deadline) {
    clearInterval(interval);
    process.stderr.write("mutation_timeout\n");
    process.exitCode = 2;
    return;
  }
  let size;
  try {
    size = fs.statSync(walPath).size;
  } catch {
    return;
  }
  if (!ready && size > 0) {
    ready = true;
    process.stdout.write("READY\n");
    return;
  }
  if (ready && size === 0) {
    clearInterval(interval);
    fs.chmodSync(databasePath, 0o620);
    process.stdout.write("MUTATED\n");
  }
}, 1);
`;

type Fixture = Readonly<{
  directory: string;
  databasePath: string;
  writer: SqliteDatabase;
}>;

function createWalFixture(name: string): Fixture {
  const directory = fs.mkdtempSync(
    path.join(os.homedir(), `.aionis-attestation-writer-fence-${name}-`),
  );
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, "runtime.sqlite");
  const writer = createSqliteDatabase(databasePath);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE attestation_probe (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO attestation_probe (id, value) VALUES (1, 'before-checkpoint');
  `);
  fs.chmodSync(databasePath, 0o600);
  for (const suffix of ["-wal", "-shm"] as const) {
    if (fs.existsSync(`${databasePath}${suffix}`)) {
      fs.chmodSync(`${databasePath}${suffix}`, 0o600);
    }
  }
  return { directory, databasePath, writer };
}

function closeSqliteBestEffort(database: SqliteDatabase | null): void {
  if (!database) return;
  try {
    database.close();
  } catch {
    // Fixture cleanup must preserve the assertion that failed first.
  }
}

function closePinBestEffort(pin: LiteRuntimeProtectedAuthorityDatabasePin | null): void {
  if (!pin) return;
  try {
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
  } catch {
    // Fixture cleanup must preserve the assertion that failed first.
  }
}

function fenceCode(expectedCode: LiteRuntimeAttestationWriterFenceErrorCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LiteRuntimeAttestationWriterFenceError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

test("attestation writer fence checkpoints a real WAL and retains the exact main-file descriptor", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const fixture = createWalFixture("checkpoint");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let fence: LiteRuntimeAttestationWriterFenceCapability | null = null;
  let contender: SqliteDatabase | null = null;
  let handoffDescriptor: number | null = null;
  try {
    const walPath = `${fixture.databasePath}-wal`;
    assert.ok(fs.statSync(walPath).size > 0, "fixture must contain real WAL frames");
    pin = pinLiteRuntimeProtectedAuthorityDatabase(fixture.databasePath);
    fence = acquireLiteRuntimeAttestationWriterFence(pin);

    assert.equal(Object.isFrozen(fence), true);
    assert.equal(Object.getPrototypeOf(fence), null);
    assert.deepEqual(Object.keys(fence), []);
    handoffDescriptor = openLiteRuntimeAttestationDatabaseHandoffDescriptor(fence);
    const descriptorStat = fs.fstatSync(handoffDescriptor, { bigint: true });
    const databaseStat = fs.statSync(fixture.databasePath, { bigint: true });
    assert.equal(descriptorStat.dev, databaseStat.dev);
    assert.equal(descriptorStat.ino, databaseStat.ino);

    const inspection = inspectLiteRuntimeAttestationWriterFence(fence);
    assert.equal(Object.isFrozen(inspection), true);
    assert.deepEqual(inspection, {
      contract_version: "aionis_lite_runtime_attestation_writer_fence_inspection_v1",
      signing_eligible: false,
      database_realpath: fs.realpathSync.native(fixture.databasePath),
      database_file_device: databaseStat.dev.toString(10),
      database_file_inode: databaseStat.ino.toString(10),
      database_main_file_byte_length: databaseStat.size.toString(10),
      database_main_file_sha256: createHash("sha256")
        .update(fs.readFileSync(fixture.databasePath))
        .digest("hex"),
      wal_checkpoint_busy: 0,
      wal_checkpoint_log_frames: 0,
      wal_checkpointed_frames: 0,
      wal_file_byte_length: 0,
      wal_checkpointed_and_truncated: true,
      required_outer_capabilities: [
        "deployment_slot_exclusive_lease",
        "durable_checkpoint_generation",
        "launcher_database_binding_receipt",
        "private_signer_channel",
      ],
    });
    assert.deepEqual(assertLiteRuntimeAttestationWriterFence(fence), inspection);
    assert.equal(
      liteRuntimeAttestationWriterFenceInspectionDigest(fence),
      createHash("sha256").update(stableStringify(inspection)).digest("hex"),
    );
    assert.equal(fs.statSync(walPath).size, 0);

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", INHERITED_PROBE_CHILD],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe", handoffDescriptor],
      },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const inherited = JSON.parse(child.stdout.trim()) as {
      value: string;
      inspection: Record<string, unknown>;
    };
    assert.equal(inherited.value, "before-checkpoint");
    assert.equal(
      inherited.inspection.database_file_device,
      inspection.database_file_device,
    );
    assert.equal(
      inherited.inspection.database_file_inode,
      inspection.database_file_inode,
    );
    assert.equal(
      inherited.inspection.database_main_file_byte_length,
      inspection.database_main_file_byte_length,
    );
    assert.equal(
      inherited.inspection.database_main_file_sha256,
      inspection.database_main_file_sha256,
    );
    assert.equal(inherited.inspection.signing_eligible, false);
    fs.closeSync(handoffDescriptor);
    handoffDescriptor = null;
    assert.deepEqual(assertLiteRuntimeAttestationWriterFence(fence), inspection);

    contender = createSqliteReadWriteExistingDatabase(fixture.databasePath);
    contender.exec("PRAGMA busy_timeout = 0");
    assert.throws(() => contender!.exec("BEGIN IMMEDIATE"), /database is locked/u);

    await releaseLiteRuntimeAttestationWriterFence(fence);
    await releaseLiteRuntimeAttestationWriterFence(fence);
    assert.throws(
      () => inspectLiteRuntimeAttestationWriterFence(fence!),
      fenceCode("lite_runtime_attestation_writer_fence_closed"),
    );
    contender.exec("BEGIN IMMEDIATE");
    contender.exec("ROLLBACK");
    fence = null;
  } finally {
    if (handoffDescriptor !== null) fs.closeSync(handoffDescriptor);
    if (fence) await releaseLiteRuntimeAttestationWriterFence(fence);
    closeSqliteBestEffort(contender);
    closeSqliteBestEffort(fixture.writer);
    closePinBestEffort(pin);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("attestation writer fence fails closed while another real writer owns the WAL", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const fixture = createWalFixture("writer-busy");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  try {
    fixture.writer.exec("BEGIN IMMEDIATE");
    fixture.writer.prepare(
      "UPDATE attestation_probe SET value = ? WHERE id = 1",
    ).run("uncommitted-writer");
    pin = pinLiteRuntimeProtectedAuthorityDatabase(fixture.databasePath);
    assert.throws(
      () => acquireLiteRuntimeAttestationWriterFence(pin!),
      (error: unknown) => {
        assert.ok(error instanceof LiteRuntimeAttestationWriterFenceError);
        assert.ok(
          error.code === "lite_runtime_attestation_writer_fence_acquire_failed"
            || error.code === "lite_runtime_attestation_writer_fence_checkpoint_incomplete",
        );
        return true;
      },
    );
    fixture.writer.exec("ROLLBACK");
  } finally {
    try {
      fixture.writer.exec("ROLLBACK");
    } catch {
      // The success path already rolled back.
    }
    closeSqliteBestEffort(fixture.writer);
    closePinBestEffort(pin);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("attestation writer fence rejects a partial checkpoint held by a real reader snapshot", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const fixture = createWalFixture("reader-busy");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let reader: SqliteDatabase | null = null;
  try {
    reader = createSqliteReadOnlyDatabase(fixture.databasePath);
    reader.exec("BEGIN");
    const snapshot = reader.prepare(
      "SELECT value FROM attestation_probe WHERE id = 1",
    ).get() as { value: string };
    assert.equal(snapshot.value, "before-checkpoint");
    fixture.writer.prepare(
      "UPDATE attestation_probe SET value = ? WHERE id = 1",
    ).run("after-reader-snapshot");
    pin = pinLiteRuntimeProtectedAuthorityDatabase(fixture.databasePath);
    assert.throws(
      () => acquireLiteRuntimeAttestationWriterFence(pin!),
      (error: unknown) => {
        assert.ok(error instanceof LiteRuntimeAttestationWriterFenceError);
        assert.ok(
          error.code === "lite_runtime_attestation_writer_fence_acquire_failed"
            || error.code === "lite_runtime_attestation_writer_fence_checkpoint_incomplete",
        );
        return true;
      },
    );
    reader.exec("ROLLBACK");
  } finally {
    try {
      reader?.exec("ROLLBACK");
    } catch {
      // The success path already rolled back.
    }
    closeSqliteBestEffort(reader);
    closeSqliteBestEffort(fixture.writer);
    closePinBestEffort(pin);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("writer-fence acquisition failure after BEGIN IMMEDIATE releases its SQLite lock", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const fixture = createWalFixture("post-begin-cleanup");
  const walPath = `${fixture.databasePath}-wal`;
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let fence: LiteRuntimeAttestationWriterFenceCapability | null = null;
  let contender: SqliteDatabase | null = null;
  const mutator = spawn(
    process.execPath,
    ["-e", POST_BEGIN_MUTATOR, walPath, fixture.databasePath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ok(mutator.stdout);
  assert.ok(mutator.stderr);
  let stdout = "";
  let stderr = "";
  const ready = new Promise<void>((resolve, reject) => {
    mutator.stdout!.setEncoding("utf8");
    mutator.stderr!.setEncoding("utf8");
    mutator.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) resolve();
    });
    mutator.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    mutator.once("error", reject);
    mutator.once("close", (code, signal) => {
      if (!stdout.includes("READY\n")) {
        reject(new Error(`mutator exited before ready code=${code} signal=${signal}: ${stderr}`));
      }
    });
  });
  const exited = new Promise<Readonly<{ code: number | null; signal: string | null }>>(
    (resolve, reject) => {
      mutator.once("error", reject);
      mutator.once("close", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    fixture.writer.exec("UPDATE attestation_probe SET value = zeroblob(33554432)");
    assert.ok(fs.statSync(walPath).size > 8 * 1024 * 1024);
    pin = pinLiteRuntimeProtectedAuthorityDatabase(fixture.databasePath);
    await ready;

    assert.throws(
      () => {
        fence = acquireLiteRuntimeAttestationWriterFence(pin!);
      },
      (error: unknown) => {
        assert.ok(error instanceof LiteRuntimeProtectedAuthorityDatabaseError);
        assert.ok(
          error.code === "lite_runtime_protected_authority_database_filesystem_untrusted"
            || error.code === "lite_runtime_protected_authority_database_identity_changed",
          `unexpected protected-database code: ${error.code}`,
        );
        return true;
      },
    );
    const exit = await exited;
    assert.equal(exit.signal, null, stderr);
    assert.equal(exit.code, 0, stderr);
    assert.match(stdout, /READY\n.*MUTATED\n/su);

    fs.chmodSync(fixture.databasePath, 0o600);
    contender = createSqliteReadWriteExistingDatabase(fixture.databasePath);
    contender.exec("PRAGMA busy_timeout = 0");
    contender.exec("BEGIN IMMEDIATE");
    contender.exec("ROLLBACK");
  } finally {
    if (mutator.exitCode === null && mutator.signalCode === null) mutator.kill();
    fs.chmodSync(fixture.databasePath, 0o600);
    if (fence) await releaseLiteRuntimeAttestationWriterFence(fence);
    closeSqliteBestEffort(contender);
    closeSqliteBestEffort(fixture.writer);
    closePinBestEffort(pin);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("attestation writer-fence capability cannot be forged and detects frozen-file mutation", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const forged = Object.freeze(Object.create(null)) as
    LiteRuntimeAttestationWriterFenceCapability;
  assert.throws(
    () => inspectLiteRuntimeAttestationWriterFence(forged),
    fenceCode("lite_runtime_attestation_writer_fence_capability_invalid"),
  );
  await assert.rejects(
    releaseLiteRuntimeAttestationWriterFence(forged),
    fenceCode("lite_runtime_attestation_writer_fence_capability_invalid"),
  );

  const fixture = createWalFixture("identity-change");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let fence: LiteRuntimeAttestationWriterFenceCapability | null = null;
  try {
    pin = pinLiteRuntimeProtectedAuthorityDatabase(fixture.databasePath);
    fence = acquireLiteRuntimeAttestationWriterFence(pin);
    fs.chmodSync(fixture.databasePath, 0o640);
    assert.throws(() => assertLiteRuntimeAttestationWriterFence(fence!));
  } finally {
    if (fence) await releaseLiteRuntimeAttestationWriterFence(fence);
    fs.chmodSync(fixture.databasePath, 0o600);
    closeSqliteBestEffort(fixture.writer);
    closePinBestEffort(pin);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("writer-fence release never closes a reused caller-owned handoff descriptor", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const fixture = createWalFixture("handoff-reuse");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let fence: LiteRuntimeAttestationWriterFenceCapability | null = null;
  let replacement: number | null = null;
  try {
    pin = pinLiteRuntimeProtectedAuthorityDatabase(fixture.databasePath);
    fence = acquireLiteRuntimeAttestationWriterFence(pin);
    const handoff = openLiteRuntimeAttestationDatabaseHandoffDescriptor(fence);
    assert.throws(
      () => openLiteRuntimeAttestationDatabaseHandoffDescriptor(fence!),
      fenceCode("lite_runtime_attestation_writer_fence_handoff_already_opened"),
    );
    fs.closeSync(handoff);
    replacement = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    assert.equal(replacement, handoff, "fixture must reuse the released handoff fd");

    await releaseLiteRuntimeAttestationWriterFence(fence);
    fence = null;
    assert.doesNotThrow(() => fs.fstatSync(replacement!));
  } finally {
    if (replacement !== null) fs.closeSync(replacement);
    if (fence) await releaseLiteRuntimeAttestationWriterFence(fence);
    closeSqliteBestEffort(fixture.writer);
    closePinBestEffort(pin);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
