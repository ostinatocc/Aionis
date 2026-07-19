import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLiteRuntimeProtectedAuthorityDatabasePinned,
  assertLiteRuntimeProtectedAuthorityTransactionCapability,
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  inspectLiteRuntimeProtectedAuthorityDatabase,
  LiteRuntimeProtectedAuthorityDatabaseError,
  openLiteRuntimeProtectedAuthorityDatabase,
  pinLiteRuntimeProtectedAuthorityDatabase,
  runLiteRuntimeProtectedAuthorityTransaction,
  type LiteRuntimeProtectedAuthorityDatabaseErrorCode,
  type LiteRuntimeProtectedAuthorityDatabasePin,
  type LiteRuntimeProtectedAuthorityTransactionCapability,
} from "../../packages/aionis-learning-authority/src/store/lite-runtime-protected-authority-database.ts";
import {
  createLiteLearningFixedExperimentAuthorityAccess,
  type LiteLearningFixedExperimentAuthorityAccess,
} from "../../packages/aionis-learning-authority/src/store/lite-learning-fixed-experiment-authority.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";

const SUPPORTED_PLATFORM = process.platform === "darwin" || process.platform === "linux";

type TempDatabase = Readonly<{
  directory: string;
  path: string;
}>;

function tempDatabase(name: string): TempDatabase {
  const directory = fs.mkdtempSync(
    path.join(os.homedir(), `.aionis-protected-authority-${name}-`),
  );
  fs.chmodSync(directory, 0o700);
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function createRealDatabase(
  databasePath: string,
  value = "real-sqlite-database",
): void {
  const database = createSqliteDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE authority_boundary_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    database.prepare(
      "INSERT INTO authority_boundary_probe (id, value) VALUES (1, ?)",
    ).run(value);
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
}

function processDescriptorCount(): number | null {
  const descriptorDirectory = process.platform === "linux"
    ? "/proc/self/fd"
    : process.platform === "darwin"
      ? "/dev/fd"
      : null;
  if (!descriptorDirectory) return null;
  try {
    return fs.readdirSync(descriptorDirectory).length;
  } catch {
    return null;
  }
}

function writeSecureSidecar(sidecarPath: string, contents: string): void {
  fs.writeFileSync(sidecarPath, contents, { flag: "wx", mode: 0o600 });
  fs.chmodSync(sidecarPath, 0o600);
}

function boundaryCode(expectedCode: LiteRuntimeProtectedAuthorityDatabaseErrorCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LiteRuntimeProtectedAuthorityDatabaseError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function closePinBestEffort(pin: LiteRuntimeProtectedAuthorityDatabasePin | null): void {
  if (!pin) return;
  try {
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
  } catch {
    // A failed assertion must not prevent test fixture cleanup.
  }
}

function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

test("protected authority database pins an existing absolute SQLite file as an opaque capability", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const temp = tempDatabase("pin-contract");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  try {
    createRealDatabase(temp.path);
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase("runtime.sqlite"),
      boundaryCode("lite_runtime_protected_authority_database_absolute_path_required"),
    );
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase(path.join(temp.directory, "missing.sqlite")),
      boundaryCode("lite_runtime_protected_authority_database_required"),
    );

    pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
    assert.equal(Object.isFrozen(pin), true);
    assert.equal(Object.getPrototypeOf(pin), null);
    assert.deepEqual(Object.keys(pin), []);

    const databaseStat = fs.statSync(temp.path);
    const inspection = inspectLiteRuntimeProtectedAuthorityDatabase(pin);
    assert.equal(Object.isFrozen(inspection), true);
    assert.deepEqual(inspection, {
      contract_version: "aionis_lite_runtime_protected_authority_database_inspection_v1",
      requested_path: temp.path,
      database_realpath: fs.realpathSync.native(temp.path),
      database_device: databaseStat.dev,
      database_inode: databaseStat.ino,
      database_uid: databaseStat.uid,
      database_gid: databaseStat.gid,
      database_mode: databaseStat.mode & 0o7777,
      database_link_count: 1,
      wal_present: false,
      shared_memory_present: false,
      rollback_journal_present: false,
    });
    assert.deepEqual(
      assertLiteRuntimeProtectedAuthorityDatabasePinned(pin),
      inspection,
    );

    const forged = Object.freeze(Object.create(null)) as
      LiteRuntimeProtectedAuthorityDatabasePin;
    assert.throws(
      () => inspectLiteRuntimeProtectedAuthorityDatabase(forged),
      boundaryCode("lite_runtime_protected_authority_database_pin_invalid"),
    );
    assert.throws(
      () => closeLiteRuntimeProtectedAuthorityDatabasePin(forged),
      boundaryCode("lite_runtime_protected_authority_database_pin_invalid"),
    );

    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
    assert.throws(
      () => inspectLiteRuntimeProtectedAuthorityDatabase(pin!),
      boundaryCode("lite_runtime_protected_authority_database_pin_closed"),
    );
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_pin_closed"),
    );
    pin = null;
  } finally {
    closePinBestEffort(pin);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected authority database opens the pinned canonical SQLite main and closes normally", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const temp = tempDatabase("protected-open");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let database: ReturnType<typeof openLiteRuntimeProtectedAuthorityDatabase> | null = null;
  try {
    createRealDatabase(temp.path, "opened-through-boundary");
    pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
    database = openLiteRuntimeProtectedAuthorityDatabase(pin);

    const expectedRealpath = inspectLiteRuntimeProtectedAuthorityDatabase(pin).database_realpath;
    assert.equal(database.path, expectedRealpath);
    assert.equal(database.readDb, database.db);
    const mainRows = database.db.prepare("PRAGMA database_list").all() as Array<{
      name: string;
      file: string;
    }>;
    const main = mainRows.find((row) => row.name === "main");
    assert.ok(main);
    assert.equal(fs.realpathSync.native(main.file), expectedRealpath);
    const probe = database.db.prepare(
      "SELECT value FROM authority_boundary_probe WHERE id = 1",
    ).get() as { value: string };
    assert.equal(probe.value, "opened-through-boundary");

    const opened = database;
    await opened.close();
    await opened.close();
    assert.throws(() => opened.db.prepare("SELECT 1").get());
    database = null;
    assert.doesNotThrow(() => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!));
  } finally {
    if (database) await database.close().catch(() => undefined);
    closePinBestEffort(pin);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected transaction capability is opaque and bound to one database transaction scope", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const temp = tempDatabase("transaction-capability");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let database: ReturnType<typeof openLiteRuntimeProtectedAuthorityDatabase> | null = null;
  let issued: LiteRuntimeProtectedAuthorityTransactionCapability | null = null;
  try {
    createRealDatabase(temp.path);
    pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
    database = openLiteRuntimeProtectedAuthorityDatabase(pin);
    await runLiteRuntimeProtectedAuthorityTransaction(
      pin,
      database,
      async (capability) => {
        const forged = Object.freeze(Object.create(null)) as
          LiteRuntimeProtectedAuthorityTransactionCapability;
        assert.throws(
          () => assertLiteRuntimeProtectedAuthorityTransactionCapability(
            forged,
            database!,
          ),
          boundaryCode(
            "lite_runtime_protected_authority_transaction_capability_invalid",
          ),
        );
        issued = capability;
        assert.equal(Object.isFrozen(issued), true);
        assert.equal(Object.getPrototypeOf(issued), null);
        assert.deepEqual(Object.keys(issued), []);
        assert.doesNotThrow(() =>
          assertLiteRuntimeProtectedAuthorityTransactionCapability(
            issued!,
            database!,
          ));
      },
    );

    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityTransactionCapability(
        issued!,
        database!,
      ),
      boundaryCode("lite_runtime_protected_authority_transaction_required"),
    );
    await runLiteRuntimeProtectedAuthorityTransaction(
      pin,
      database,
      async () => {
        assert.throws(
          () => assertLiteRuntimeProtectedAuthorityTransactionCapability(
            issued!,
            database!,
          ),
          boundaryCode(
            "lite_runtime_protected_authority_transaction_capability_invalid",
          ),
        );
      },
    );
  } finally {
    if (database) await database.close().catch(() => undefined);
    closePinBestEffort(pin);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("fixed experiment writer rejects forged and escaped protected transaction authority", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async () => {
  const temp = tempDatabase("fixed-experiment-capability");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let database: ReturnType<typeof openLiteRuntimeProtectedAuthorityDatabase> | null = null;
  let escaped: LiteLearningFixedExperimentAuthorityAccess | null = null;
  try {
    createRealDatabase(temp.path);
    pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
    database = openLiteRuntimeProtectedAuthorityDatabase(pin);
    const forged = Object.freeze(Object.create(null)) as
      LiteRuntimeProtectedAuthorityTransactionCapability;
    assert.throws(
      () => createLiteLearningFixedExperimentAuthorityAccess({
        database: database!,
        capability: forged,
      }),
      boundaryCode("lite_runtime_protected_authority_transaction_capability_invalid"),
    );

    await runLiteRuntimeProtectedAuthorityTransaction(
      pin,
      database,
      async (capability) => {
        escaped = createLiteLearningFixedExperimentAuthorityAccess({
          database: database!,
          capability,
        });
      },
    );
    await assert.rejects(
      escaped!.insertPolicyVersion({}),
      boundaryCode("lite_runtime_protected_authority_transaction_required"),
    );
  } finally {
    if (database) await database.close().catch(() => undefined);
    closePinBestEffort(pin);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected authority database rejects pre-open replacement and an opened connection stays on its original file", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async (t) => {
  await t.test("replacement before protected open is rejected", () => {
    const temp = tempDatabase("pre-open-replacement");
    const retiredPath = path.join(temp.directory, "retired.sqlite");
    let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
    try {
      createRealDatabase(temp.path, "pinned-original");
      pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
      fs.renameSync(temp.path, retiredPath);
      createRealDatabase(temp.path, "path-replacement");
      assert.throws(
        () => openLiteRuntimeProtectedAuthorityDatabase(pin!),
        boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
      );
    } finally {
      closePinBestEffort(pin);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  await t.test("replacement after protected open cannot rebind the returned connection", async () => {
    const temp = tempDatabase("post-open-replacement");
    const retiredPath = path.join(temp.directory, "retired.sqlite");
    let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
    let database: ReturnType<typeof openLiteRuntimeProtectedAuthorityDatabase> | null = null;
    try {
      createRealDatabase(temp.path, "pinned-original");
      pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
      database = openLiteRuntimeProtectedAuthorityDatabase(pin);
      fs.renameSync(temp.path, retiredPath);
      createRealDatabase(temp.path, "path-replacement");

      const probe = database.db.prepare(
        "SELECT value FROM authority_boundary_probe WHERE id = 1",
      ).get() as { value: string };
      assert.equal(probe.value, "pinned-original");
      assert.throws(
        () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
        boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
      );
    } finally {
      if (database) await database.close().catch(() => undefined);
      closePinBestEffort(pin);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });
});

test("protected authority database closes a failed SQLite open without leaking a descriptor", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const temp = tempDatabase("open-failure");
  const renamedPath = path.join(temp.directory, "renamed-invalid.sqlite");
  const invalidBytes = Buffer.from("not-a-sqlite-database", "utf8");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  try {
    fs.writeFileSync(temp.path, invalidBytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(temp.path, 0o600);
    pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
    const descriptorsBeforeOpen = processDescriptorCount();
    assert.throws(
      () => openLiteRuntimeProtectedAuthorityDatabase(pin!),
      boundaryCode("lite_runtime_protected_authority_database_open_failed"),
    );
    const descriptorsAfterFailure = processDescriptorCount();
    if (descriptorsBeforeOpen !== null && descriptorsAfterFailure !== null) {
      assert.equal(descriptorsAfterFailure, descriptorsBeforeOpen);
    }
    assert.deepEqual(fs.readFileSync(temp.path), invalidBytes);
    fs.renameSync(temp.path, renamedPath);
    fs.renameSync(renamedPath, temp.path);
  } finally {
    closePinBestEffort(pin);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected authority database accepts an initial symlink but detects symlink and path replacement", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const temp = tempDatabase("identity");
  const originalPath = path.join(temp.directory, "original.sqlite");
  const replacementPath = path.join(temp.directory, "replacement.sqlite");
  const retiredPath = path.join(temp.directory, "retired.sqlite");
  const aliasPath = path.join(temp.directory, "runtime-link.sqlite");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  try {
    createRealDatabase(originalPath);
    createRealDatabase(replacementPath);
    fs.symlinkSync(path.basename(originalPath), aliasPath);

    pin = pinLiteRuntimeProtectedAuthorityDatabase(aliasPath);
    assert.equal(
      inspectLiteRuntimeProtectedAuthorityDatabase(pin).database_realpath,
      fs.realpathSync.native(originalPath),
    );
    fs.unlinkSync(aliasPath);
    fs.symlinkSync(path.basename(replacementPath), aliasPath);
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
    );
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
    pin = null;

    pin = pinLiteRuntimeProtectedAuthorityDatabase(originalPath);
    fs.renameSync(originalPath, retiredPath);
    createRealDatabase(originalPath);
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
    );
  } finally {
    closePinBestEffort(pin);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected authority descriptor acquisition does not block when a checked file becomes a FIFO", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async (t) => {
  const temp = tempDatabase("fifo-race");
  let directParent = temp.directory;
  for (let index = 0; index < 128; index += 1) {
    directParent = path.join(directParent, "d");
    fs.mkdirSync(directParent, { mode: 0o700 });
  }
  const databasePath = path.join(directParent, "runtime.sqlite");
  const retiredPath = path.join(directParent, "retired.sqlite");
  const fifoPath = path.join(directParent, "replacement.fifo");
  let swap: ChildProcess | null = null;
  let exited: Promise<void> | null = null;
  try {
    createRealDatabase(databasePath);
    const createFifo = spawnSync("/usr/bin/mkfifo", [fifoPath], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (createFifo.error || createFifo.status !== 0) {
      t.skip(`FIFO setup unavailable: ${createFifo.error?.message ?? createFifo.stderr}`);
      return;
    }

    swap = spawn(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          const [databasePath, retiredPath, fifoPath] = process.argv.slice(1);
          const swapAt = Date.now() + 100;
          while (Date.now() < swapAt) {}
          fs.renameSync(databasePath, retiredPath);
          fs.renameSync(fifoPath, databasePath);
          setTimeout(() => {
            try {
              const descriptor = fs.openSync(
                databasePath,
                fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
              );
              fs.closeSync(descriptor);
            } catch {}
          }, 8_000);
        `,
        databasePath,
        retiredPath,
        fifoPath,
      ],
      { stdio: "ignore" },
    );
    exited = childExit(swap);
    const startedAt = Date.now();
    assert.throws(
      () => {
        const unexpectedPin = pinLiteRuntimeProtectedAuthorityDatabase(databasePath);
        closeLiteRuntimeProtectedAuthorityDatabasePin(unexpectedPin);
      },
      boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
    );
    assert.ok(
      Date.now() - startedAt < 7_000,
      "descriptor acquisition blocked on a raced FIFO",
    );
    if (swap.exitCode === null && swap.signalCode === null) swap.kill();
    await exited;
    exited = null;
    swap = null;
  } finally {
    if (swap && swap.exitCode === null && swap.signalCode === null) swap.kill();
    if (exited) await exited.catch(() => undefined);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected authority database rejects hardlinks, writable files, and writable ancestors", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const temp = tempDatabase("filesystem-trust");
  const hardlinkPath = path.join(temp.directory, "runtime-hardlink.sqlite");
  const ancestor = path.join(temp.directory, "replaceable-ancestor");
  const directParent = path.join(ancestor, "runtime-owner-only");
  const nestedDatabasePath = path.join(directParent, "runtime.sqlite");
  try {
    createRealDatabase(temp.path);
    fs.linkSync(temp.path, hardlinkPath);
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
      boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
    );
    fs.unlinkSync(hardlinkPath);

    fs.chmodSync(temp.path, 0o620);
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
      boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
    );
    fs.chmodSync(temp.path, 0o600);

    fs.mkdirSync(directParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(ancestor, 0o700);
    fs.chmodSync(directParent, 0o700);
    createRealDatabase(nestedDatabasePath);
    fs.chmodSync(ancestor, 0o770);
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase(nestedDatabasePath),
      boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
    );
    fs.chmodSync(ancestor, 0o700);
  } finally {
    if (fs.existsSync(ancestor)) fs.chmodSync(ancestor, 0o700);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected authority database enforces SQLite sidecar pairing and trust", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, async (t) => {
  await t.test("a lone WAL requires recovery", () => {
    const temp = tempDatabase("lone-wal");
    try {
      createRealDatabase(temp.path);
      writeSecureSidecar(`${temp.path}-wal`, "lone-wal");
      assert.throws(
        () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
        boundaryCode("lite_runtime_protected_authority_database_recovery_required"),
      );
    } finally {
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  await t.test("a real live WAL and shared-memory pair remains pinnable", () => {
    const temp = tempDatabase("live-wal-pair");
    const database = createSqliteDatabase(temp.path);
    let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE live_wal_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO live_wal_probe (id, value) VALUES (1, 'uncheckpointed');
      `);
      fs.chmodSync(temp.path, 0o600);
      assert.equal(fs.existsSync(`${temp.path}-wal`), true);
      assert.equal(fs.existsSync(`${temp.path}-shm`), true);

      pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
      const inspection = inspectLiteRuntimeProtectedAuthorityDatabase(pin);
      assert.equal(inspection.wal_present, true);
      assert.equal(inspection.shared_memory_present, true);
      assert.equal(inspection.rollback_journal_present, false);
      assert.deepEqual(
        assertLiteRuntimeProtectedAuthorityDatabasePinned(pin),
        inspection,
      );
    } finally {
      closePinBestEffort(pin);
      database.close();
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  await t.test("a rollback journal is always rejected", () => {
    const temp = tempDatabase("rollback-journal");
    try {
      createRealDatabase(temp.path);
      writeSecureSidecar(`${temp.path}-journal`, "rollback-journal");
      assert.throws(
        () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
        boundaryCode("lite_runtime_protected_authority_database_recovery_required"),
      );
    } finally {
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  await t.test("writable, hardlinked, and symlink sidecars are rejected", () => {
    for (const scenario of ["writable", "hardlink", "symlink"] as const) {
      const temp = tempDatabase(`sidecar-${scenario}`);
      const walPath = `${temp.path}-wal`;
      const sharedMemoryPath = `${temp.path}-shm`;
      try {
        createRealDatabase(temp.path);
        writeSecureSidecar(sharedMemoryPath, "trusted-shm");
        if (scenario === "symlink") {
          const targetPath = path.join(temp.directory, "sidecar-target");
          writeSecureSidecar(targetPath, "symlink-target");
          fs.symlinkSync(path.basename(targetPath), walPath);
        } else {
          writeSecureSidecar(walPath, "wal");
          if (scenario === "writable") fs.chmodSync(walPath, 0o620);
          if (scenario === "hardlink") {
            fs.linkSync(walPath, path.join(temp.directory, "wal-hardlink"));
          }
        }
        assert.throws(
          () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
          boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
        );
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    }
  });
});

test("pinned authority database revalidates database, directory, hardlink, and sidecar state", {
  skip: !SUPPORTED_PLATFORM,
  timeout: 30_000,
}, () => {
  const temp = tempDatabase("revalidation");
  let pin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  try {
    createRealDatabase(temp.path);
    pin = pinLiteRuntimeProtectedAuthorityDatabase(temp.path);
    fs.chmodSync(temp.path, 0o620);
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
    );
    fs.chmodSync(temp.path, 0o600);
    assert.doesNotThrow(() => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!));

    fs.chmodSync(temp.directory, 0o770);
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
    );
    fs.chmodSync(temp.directory, 0o700);
    assert.doesNotThrow(() => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!));

    const hardlinkPath = path.join(temp.directory, "runtime-hardlink.sqlite");
    fs.linkSync(temp.path, hardlinkPath);
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_identity_changed"),
    );
    fs.unlinkSync(hardlinkPath);
    assert.doesNotThrow(() => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!));

    writeSecureSidecar(`${temp.path}-wal`, "late-lone-wal");
    assert.throws(
      () => assertLiteRuntimeProtectedAuthorityDatabasePinned(pin!),
      boundaryCode("lite_runtime_protected_authority_database_recovery_required"),
    );
  } finally {
    closePinBestEffort(pin);
    if (fs.existsSync(temp.directory)) fs.chmodSync(temp.directory, 0o700);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("macOS delegated write ACL is rejected by the protected authority boundary", {
  skip: process.platform !== "darwin",
  timeout: 30_000,
}, (t) => {
  const temp = tempDatabase("darwin-acl");
  let aclInstalled = false;
  try {
    createRealDatabase(temp.path);
    const addAcl = spawnSync(
      "/bin/chmod",
      ["+a", "everyone allow write", temp.path],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (addAcl.error || addAcl.status !== 0) {
      t.skip(`macOS ACL setup unavailable: ${addAcl.error?.message ?? addAcl.stderr}`);
      return;
    }
    aclInstalled = true;
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
      boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
    );
  } finally {
    if (aclInstalled && fs.existsSync(temp.path)) {
      spawnSync("/bin/chmod", ["-N", temp.path], { timeout: 5_000 });
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("Linux extended ACL is rejected even when mode has no group or other write bit", {
  skip: process.platform !== "linux",
  timeout: 30_000,
}, (t) => {
  const temp = tempDatabase("linux-acl");
  let aclInstalled = false;
  try {
    createRealDatabase(temp.path);
    const serviceUid = typeof process.getuid === "function" ? process.getuid() : -1;
    const delegatedUid = serviceUid === 65_534 ? 65_533 : 65_534;
    const addAcl = spawnSync(
      "/usr/bin/setfacl",
      ["-m", `u:${String(delegatedUid)}:r--`, temp.path],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (addAcl.error || addAcl.status !== 0) {
      t.skip(`Linux ACL setup unavailable: ${addAcl.error?.message ?? addAcl.stderr}`);
      return;
    }
    aclInstalled = true;
    assert.equal(fs.statSync(temp.path).mode & 0o022, 0);
    assert.throws(
      () => pinLiteRuntimeProtectedAuthorityDatabase(temp.path),
      boundaryCode("lite_runtime_protected_authority_database_filesystem_untrusted"),
    );
  } finally {
    if (aclInstalled && fs.existsSync(temp.path)) {
      spawnSync("/usr/bin/setfacl", ["-b", temp.path], { timeout: 5_000 });
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
