import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  adoptLiteRuntimeInheritedAuthorityDatabase,
  assertLiteRuntimeInheritedAuthorityDatabase,
  assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability,
  closeLiteRuntimeInheritedAuthorityDatabase,
  inspectLiteRuntimeInheritedAuthorityDatabase,
  LiteRuntimeInheritedAuthorityDatabaseError,
  openLiteRuntimeInheritedAuthorityDatabaseSnapshot,
  runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction,
  type LiteRuntimeInheritedAuthorityDatabaseCapability,
  type LiteRuntimeInheritedAuthorityDatabaseErrorCode,
  type LiteRuntimeInheritedAuthorityDatabaseTransactionCapability,
} from "../../src/store/lite-runtime-inherited-authority-database.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";

const CHILD_ACTION_ENV = "AIONIS_INHERITED_AUTHORITY_DATABASE_CHILD_ACTION";
const CHILD_REOPEN_PATH_ENV = "AIONIS_INHERITED_AUTHORITY_DATABASE_REOPEN_PATH";
const THIS_FILE = fileURLToPath(import.meta.url);
const SUPPORTED_PLATFORM = process.platform === "darwin" || process.platform === "linux";

type TempDatabase = Readonly<{
  directory: string;
  path: string;
}>;

type ChildResult = Readonly<{
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}>;

function errorCode(error: unknown): string {
  return error instanceof LiteRuntimeInheritedAuthorityDatabaseError
    ? error.code
    : error instanceof Error
      ? error.name
      : "unknown_error";
}

function expectedErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return errorCode(error);
  }
  return "no_error";
}

async function expectedAsyncErrorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return errorCode(error);
  }
  return "no_error";
}

function waitForParent(): void {
  process.stdout.write("READY\n");
  const byte = Buffer.alloc(1);
  const bytesRead = fs.readSync(0, byte, 0, 1, null);
  if (bytesRead !== 1) throw new Error("parent_continue_byte_required");
}

async function childAction(action: string): Promise<Record<string, unknown>> {
  if (action === "adopt") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    const inspection = inspectLiteRuntimeInheritedAuthorityDatabase(capability);
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
    return { inspection };
  }

  if (action === "open") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
    const probe = database.db.prepare(
      "SELECT value FROM inherited_snapshot_probe WHERE id = 1",
    ).get() as { value: string };
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
    return { probe: probe.value };
  }

  if (action === "pause_before_open") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    waitForParent();
    const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
    const probe = database.db.prepare(
      "SELECT value FROM inherited_snapshot_probe WHERE id = 1",
    ).get() as { value: string };
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
    return { probe: probe.value };
  }

  if (action === "pause_in_transaction") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
    const probe = await runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
      capability,
      database,
      async () => {
        const row = database.db.prepare(
          "SELECT value FROM inherited_snapshot_probe WHERE id = 1",
        ).get() as { value: string };
        waitForParent();
        return row.value;
      },
    );
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
    return { probe };
  }

  if (action === "fd_reuse_after_adopt") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    fs.closeSync(3);
    const replacement = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    if (replacement !== 3) {
      fs.closeSync(replacement);
      throw new Error(`fixed_descriptor_not_reused:${replacement}`);
    }
    assertLiteRuntimeInheritedAuthorityDatabase(capability);
    return { unexpected: "descriptor reuse accepted" };
  }

  if (action === "fd_reuse_then_close") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    fs.closeSync(3);
    const replacement = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    if (replacement !== 3) {
      fs.closeSync(replacement);
      throw new Error(`fixed_descriptor_not_reused:${replacement}`);
    }
    const closeCode = await expectedAsyncErrorCode(async () =>
      await closeLiteRuntimeInheritedAuthorityDatabase(capability));
    const replacementAlive = expectedErrorCode(() => fs.fstatSync(3)) === "no_error";
    fs.closeSync(3);
    return { closeCode, replacementAlive };
  }

  if (action === "same_inode_writable_fd_reuse") {
    const reopenPath = process.env[CHILD_REOPEN_PATH_ENV];
    if (!reopenPath) throw new Error("same_inode_reopen_path_required");
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    fs.closeSync(3);
    const replacement = fs.openSync(reopenPath, fs.constants.O_RDWR);
    if (replacement !== 3) {
      fs.closeSync(replacement);
      throw new Error(`fixed_descriptor_not_reused:${replacement}`);
    }
    const assertCode = expectedErrorCode(() =>
      assertLiteRuntimeInheritedAuthorityDatabase(capability));
    const closeCode = await expectedAsyncErrorCode(async () =>
      await closeLiteRuntimeInheritedAuthorityDatabase(capability));
    const replacementAlive = expectedErrorCode(() => fs.fstatSync(3)) === "no_error";
    fs.closeSync(3);
    return { assertCode, closeCode, replacementAlive };
  }

  if (action === "nested_caller_transaction") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
    const nestedCode = await database.transaction.run(async () =>
      await expectedAsyncErrorCode(async () =>
        await runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
          capability,
          database,
          async () => "unexpected-nested-result",
        )));
    const value = await runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
      capability,
      database,
      async () => {
        const row = database.db.prepare(
          "SELECT value FROM inherited_snapshot_probe WHERE id = 1",
        ).get() as { value: string };
        return row.value;
      },
    );
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
    return { nestedCode, value };
  }

  if (action === "raw_transaction_restart"
    || action === "raw_commit_transaction_restart") {
    const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
    const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
    const restartCode = await expectedAsyncErrorCode(async () =>
      await runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
        capability,
        database,
        async (transactionCapability) => {
          assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
            transactionCapability,
            database,
          );
          database.db.exec(
            action === "raw_commit_transaction_restart" ? "COMMIT" : "ROLLBACK",
          );
          database.db.exec("BEGIN");
          assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
            transactionCapability,
            database,
          );
          return "unexpected-restarted-snapshot";
        },
      ));
    await closeLiteRuntimeInheritedAuthorityDatabase(capability);
    return { restartCode };
  }

  if (action !== "happy") throw new Error(`unknown_child_action:${action}`);

  const capability = adoptLiteRuntimeInheritedAuthorityDatabase();
  const forgedCapability = Object.freeze(Object.create(null)) as
    LiteRuntimeInheritedAuthorityDatabaseCapability;
  const forgedCapabilityCode = expectedErrorCode(() =>
    inspectLiteRuntimeInheritedAuthorityDatabase(forgedCapability));
  const secondAdoptionCode = expectedErrorCode(() =>
    adoptLiteRuntimeInheritedAuthorityDatabase());
  const inspection = inspectLiteRuntimeInheritedAuthorityDatabase(capability);
  const database = openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability);
  const secondOpenCode = expectedErrorCode(() =>
    openLiteRuntimeInheritedAuthorityDatabaseSnapshot(capability));
  const main = database.db.prepare("PRAGMA database_list").all() as Array<{
    name: string;
    file: string;
  }>;
  const queryOnly = database.db.prepare("PRAGMA query_only").get() as {
    query_only: number;
  };
  const probe = database.db.prepare(
    "SELECT value FROM inherited_snapshot_probe WHERE id = 1",
  ).get() as { value: string };
  const writeCode = expectedErrorCode(() =>
    database.db.exec("CREATE TABLE forbidden_snapshot_write (id INTEGER)"));

  let issued:
    LiteRuntimeInheritedAuthorityDatabaseTransactionCapability | null = null;
  const transactionProbe = await runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
    capability,
    database,
    async (transactionCapability) => {
      issued = transactionCapability;
      const forgedTransaction = Object.freeze(Object.create(null)) as
        LiteRuntimeInheritedAuthorityDatabaseTransactionCapability;
      const forgedTransactionCode = expectedErrorCode(() =>
        assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
          forgedTransaction,
          database,
        ));
      assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
        transactionCapability,
        database,
      );
      const row = database.db.prepare(
        "SELECT value FROM inherited_snapshot_probe WHERE id = 1",
      ).get() as { value: string };
      return {
        value: row.value,
        forgedTransactionCode,
        capabilityFrozen: Object.isFrozen(transactionCapability),
        capabilityPrototypeNull: Object.getPrototypeOf(transactionCapability) === null,
        capabilityKeys: Object.keys(transactionCapability),
      };
    },
  );
  const revokedTransactionCode = expectedErrorCode(() =>
    assertLiteRuntimeInheritedAuthorityDatabaseTransactionCapability(
      issued!,
      database,
    ));
  const secondTransactionCode = await expectedAsyncErrorCode(() =>
    runLiteRuntimeInheritedAuthorityDatabaseSnapshotTransaction(
      capability,
      database,
      async () => "unexpected-second-snapshot",
    ));

  await closeLiteRuntimeInheritedAuthorityDatabase(capability);
  await closeLiteRuntimeInheritedAuthorityDatabase(capability);
  const closedCapabilityCode = expectedErrorCode(() =>
    inspectLiteRuntimeInheritedAuthorityDatabase(capability));
  const inheritedDescriptorRetained = expectedErrorCode(() => fs.fstatSync(3))
    === "no_error";

  return {
    inspection,
    forgedCapabilityCode,
    secondAdoptionCode,
    secondOpenCode,
    main,
    queryOnly: queryOnly.query_only,
    probe: probe.value,
    writeCode,
    transactionProbe,
    revokedTransactionCode,
    secondTransactionCode,
    closedCapabilityCode,
    inheritedDescriptorRetained,
    databaseCapabilityFrozen: Object.isFrozen(capability),
    databaseCapabilityPrototypeNull: Object.getPrototypeOf(capability) === null,
    databaseCapabilityKeys: Object.keys(capability),
  };
}

async function runChildProcess(): Promise<void> {
  const action = process.env[CHILD_ACTION_ENV];
  if (!action) return;
  let result: ChildResult;
  try {
    result = { ok: true, ...(await childAction(action)) };
  } catch (error) {
    result = {
      ok: false,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function tempDatabase(name: string): TempDatabase {
  const directory = fs.mkdtempSync(
    path.join(os.homedir(), `.aionis-inherited-authority-${name}-`),
  );
  fs.chmodSync(directory, 0o700);
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function createRealWalDatabase(
  databasePath: string,
  value = "trusted-inherited-snapshot",
): void {
  const database = createSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE inherited_snapshot_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    database.prepare(
      "INSERT INTO inherited_snapshot_probe (id, value) VALUES (1, ?)",
    ).run(value);
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      Record<string, unknown>;
    assert.deepEqual(Object.values(checkpoint), [0, 0, 0]);
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  assert.equal(fs.existsSync(`${databasePath}-wal`), false);
  assert.equal(fs.existsSync(`${databasePath}-shm`), false);
  assert.equal(fs.existsSync(`${databasePath}-journal`), false);
}

function parseChildResult(stdout: string): ChildResult {
  const lines = stdout.trim().split(/\r?\n/u).filter((line) => line.length > 0);
  assert.ok(lines.length >= 1, "child must return a JSON result");
  return JSON.parse(lines[lines.length - 1]!) as ChildResult;
}

function runChildSync(
  action: string,
  descriptor?: number,
  childEnvironment: NodeJS.ProcessEnv = {},
): ChildResult {
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
  if (descriptor !== undefined) stdio.push(descriptor);
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", THIS_FILE],
    {
      cwd: path.resolve(path.dirname(THIS_FILE), "../.."),
      env: { ...process.env, ...childEnvironment, [CHILD_ACTION_ENV]: action },
      encoding: "utf8",
      timeout: 30_000,
      stdio,
    },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(typeof child.stdout, "string");
  return parseChildResult(child.stdout);
}

async function runPausedChild(
  action: "pause_before_open" | "pause_in_transaction",
  descriptor: number,
  mutate: () => void,
): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", THIS_FILE],
      {
        cwd: path.resolve(path.dirname(THIS_FILE), "../.."),
        env: { ...process.env, [CHILD_ACTION_ENV]: action },
        stdio: ["pipe", "pipe", "pipe", descriptor],
      },
    );
    assert.ok(child.stdin);
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    let stdout = "";
    let stderr = "";
    let continued = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`paused child timed out: ${stderr}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!continued && stdout.includes("READY\n")) {
        continued = true;
        try {
          mutate();
          child.stdin!.end("x");
        } catch (error) {
          child.kill();
          reject(error);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal !== null || code !== 0) {
        reject(new Error(`paused child failed code=${code} signal=${signal}: ${stderr}`));
        return;
      }
      try {
        resolve(parseChildResult(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

const childMode = process.env[CHILD_ACTION_ENV] !== undefined;
if (childMode) {
  await runChildProcess();
} else {
  test("inherited authority database adopts fixed fd 3 and runs one real read-only immutable snapshot", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, () => {
    const temp = tempDatabase("happy");
    let descriptor: number | null = null;
    try {
      createRealWalDatabase(temp.path);
      const stat = fs.statSync(temp.path, { bigint: true });
      const expectedSha256 = createHash("sha256")
        .update(fs.readFileSync(temp.path))
        .digest("hex");
      descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
      const result = runChildSync("happy", descriptor);
      assert.equal(result.ok, true, result.message);
      assert.equal(result.probe, "trusted-inherited-snapshot");
      assert.equal(result.queryOnly, 1);
      assert.equal(result.writeCode, "Error");
      assert.equal(
        result.forgedCapabilityCode,
        "lite_runtime_inherited_authority_database_capability_invalid",
      );
      assert.equal(
        result.secondAdoptionCode,
        "lite_runtime_inherited_authority_database_already_adopted",
      );
      assert.equal(
        result.secondOpenCode,
        "lite_runtime_inherited_authority_database_already_open",
      );
      assert.equal(
        result.revokedTransactionCode,
        "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      );
      assert.equal(
        result.secondTransactionCode,
        "lite_runtime_inherited_authority_database_transaction_already_consumed",
      );
      assert.equal(
        result.closedCapabilityCode,
        "lite_runtime_inherited_authority_database_capability_closed",
      );
      assert.equal(result.inheritedDescriptorRetained, true);
      assert.equal(result.databaseCapabilityFrozen, true);
      assert.equal(result.databaseCapabilityPrototypeNull, true);
      assert.deepEqual(result.databaseCapabilityKeys, []);

      const transactionProbe = result.transactionProbe as Record<string, unknown>;
      assert.equal(transactionProbe.value, "trusted-inherited-snapshot");
      assert.equal(
        transactionProbe.forgedTransactionCode,
        "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      );
      assert.equal(transactionProbe.capabilityFrozen, true);
      assert.equal(transactionProbe.capabilityPrototypeNull, true);
      assert.deepEqual(transactionProbe.capabilityKeys, []);

      const inspection = result.inspection as Record<string, unknown>;
      assert.deepEqual(inspection, {
        contract_version:
          "aionis_lite_runtime_inherited_authority_database_inspection_v1",
        inherited_descriptor: 3,
        descriptor_namespace_path: process.platform === "linux"
          ? "/proc/self/fd/3"
          : "/dev/fd/3",
        database_file_device: stat.dev.toString(10),
        database_file_inode: stat.ino.toString(10),
        database_file_uid: stat.uid.toString(10),
        database_file_gid: stat.gid.toString(10),
        database_file_mode: (stat.mode & 0o7777n).toString(10),
        database_file_link_count: 1,
        database_main_file_byte_length: stat.size.toString(10),
        database_main_file_sha256: expectedSha256,
        descriptor_read_only_verified: true,
        sqlite_snapshot_mode: "ro_immutable",
        launcher_provenance: "not_established",
        launcher_write_fence: "not_established",
        wal_checkpoint: "not_established",
        signing_eligible: false,
      });
      const main = result.main as Array<Record<string, unknown>>;
      const mainRow = main.find((row) => row.name === "main");
      assert.ok(mainRow);
      if (mainRow.file !== inspection.descriptor_namespace_path) {
        assert.equal(typeof mainRow.file, "string");
        const reportedMain = fs.statSync(mainRow.file as string, { bigint: true });
        assert.equal(reportedMain.dev.toString(10), inspection.database_file_device);
        assert.equal(reportedMain.ino.toString(10), inspection.database_file_inode);
      }
      assert.ok(main.every((row) => row.name === "main"
        || (row.name === "temp" && row.file === "")));
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("inherited authority database fails closed for absent, writable, and non-regular fd 3", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, async (t) => {
    await t.test("absent fixed descriptor", () => {
      const result = runChildSync("adopt");
      assert.equal(result.ok, false);
      assert.equal(
        result.code,
        // Node reserves ignored stdio slots with /dev/null on some platforms;
        // either way fd 3 is not an admissible regular database descriptor.
        "lite_runtime_inherited_authority_database_descriptor_untrusted",
      );
    });

    await t.test("writable database descriptor", () => {
      const temp = tempDatabase("writable-fd");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        const before = fs.readFileSync(temp.path);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDWR);
        const result = runChildSync("adopt", descriptor);
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_descriptor_not_read_only",
        );
        assert.deepEqual(fs.readFileSync(temp.path), before);
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });

    await t.test("directory descriptor", () => {
      const temp = tempDatabase("directory-fd");
      let descriptor: number | null = null;
      try {
        descriptor = fs.openSync(temp.directory, fs.constants.O_RDONLY);
        const result = runChildSync("adopt", descriptor);
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_descriptor_untrusted",
        );
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  });

  test("inherited authority database freezes owner, mode, and single-link identity", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, async (t) => {
    await t.test("hardlinked main file is rejected", () => {
      const temp = tempDatabase("hardlink");
      const hardlink = path.join(temp.directory, "runtime-hardlink.sqlite");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        fs.linkSync(temp.path, hardlink);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = runChildSync("adopt", descriptor);
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_descriptor_untrusted",
        );
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });

    await t.test("group-writable main file is rejected", () => {
      const temp = tempDatabase("mode");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        fs.chmodSync(temp.path, 0o620);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = runChildSync("adopt", descriptor);
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_descriptor_untrusted",
        );
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });

    await t.test("even a permission tightening after adoption changes frozen identity", async () => {
      const temp = tempDatabase("mode-race");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = await runPausedChild("pause_before_open", descriptor, () => {
          fs.chmodSync(temp.path, 0o400);
        });
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_identity_changed",
        );
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  });

  test("inherited descriptor remains the authority when its former pathname is replaced", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, async () => {
    const temp = tempDatabase("path-replacement");
    const retiredPath = path.join(temp.directory, "retired.sqlite");
    let descriptor: number | null = null;
    try {
      createRealWalDatabase(temp.path, "inherited-original");
      descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
      const result = await runPausedChild("pause_before_open", descriptor, () => {
        fs.renameSync(temp.path, retiredPath);
        createRealWalDatabase(temp.path, "caller-path-replacement");
      });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.probe, "inherited-original");
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("inherited authority database detects descriptor reuse and main-file mutation", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, async (t) => {
    await t.test("closed fd 3 reused for another object", () => {
      const temp = tempDatabase("fd-reuse");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = runChildSync("fd_reuse_after_adopt", descriptor);
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_identity_changed",
        );
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });

    await t.test("close never closes a replacement in reused fd 3", () => {
      const temp = tempDatabase("fd-reuse-close");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = runChildSync("fd_reuse_then_close", descriptor);
        assert.equal(result.ok, true, result.message);
        assert.equal(
          result.closeCode,
          "lite_runtime_inherited_authority_database_identity_changed",
        );
        assert.equal(result.replacementAlive, true);
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });

    await t.test("same-inode writable fd reuse loses read-only authority", () => {
      const temp = tempDatabase("same-inode-writable-fd-reuse");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = runChildSync(
          "same_inode_writable_fd_reuse",
          descriptor,
          { [CHILD_REOPEN_PATH_ENV]: temp.path },
        );
        assert.equal(result.ok, true, result.message);
        assert.equal(
          result.assertCode,
          "lite_runtime_inherited_authority_database_descriptor_not_read_only",
        );
        assert.equal(
          result.closeCode,
          "lite_runtime_inherited_authority_database_descriptor_not_read_only",
        );
        assert.equal(result.replacementAlive, true);
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });

    await t.test("bytes changed during snapshot transaction", async () => {
      const temp = tempDatabase("transaction-mutation");
      let descriptor: number | null = null;
      try {
        createRealWalDatabase(temp.path);
        descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
        const result = await runPausedChild("pause_in_transaction", descriptor, () => {
          const writer = fs.openSync(temp.path, fs.constants.O_RDWR);
          try {
            const byte = Buffer.alloc(1);
            assert.equal(fs.readSync(writer, byte, 0, 1, 0), 1);
            byte[0] = byte[0]! ^ 0xff;
            assert.equal(fs.writeSync(writer, byte, 0, 1, 0), 1);
            fs.fsyncSync(writer);
          } finally {
            fs.closeSync(writer);
          }
        });
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          "lite_runtime_inherited_authority_database_identity_changed",
        );
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  });

  test("inherited authority database rejects a non-SQLite regular-file snapshot", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, () => {
    const temp = tempDatabase("invalid-sqlite");
    let descriptor: number | null = null;
    try {
      fs.writeFileSync(temp.path, "not-a-sqlite-database", { mode: 0o600 });
      fs.chmodSync(temp.path, 0o600);
      descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
      const result = runChildSync("open", descriptor);
      assert.equal(result.ok, false);
      assert.equal(
        result.code,
        "lite_runtime_inherited_authority_database_open_failed",
      );
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("inherited authority snapshot refuses to reuse a caller-owned transaction", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, () => {
    const temp = tempDatabase("caller-transaction");
    let descriptor: number | null = null;
    try {
      createRealWalDatabase(temp.path);
      descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
      const result = runChildSync("nested_caller_transaction", descriptor);
      assert.equal(result.ok, true, result.message);
      assert.equal(
        result.nestedCode,
        "lite_runtime_inherited_authority_database_transaction_active",
      );
      assert.equal(result.value, "trusted-inherited-snapshot");
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("inherited authority snapshot detects raw SQLite transaction restart", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, () => {
    const temp = tempDatabase("raw-transaction-restart");
    let descriptor: number | null = null;
    try {
      createRealWalDatabase(temp.path);
      descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
      const result = runChildSync("raw_transaction_restart", descriptor);
      assert.equal(result.ok, true, result.message);
      assert.equal(
        result.restartCode,
        "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      );
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("inherited authority snapshot detects raw SQLite commit and restart", {
    skip: !SUPPORTED_PLATFORM,
    timeout: 30_000,
  }, () => {
    const temp = tempDatabase("raw-commit-transaction-restart");
    let descriptor: number | null = null;
    try {
      createRealWalDatabase(temp.path);
      descriptor = fs.openSync(temp.path, fs.constants.O_RDONLY);
      const result = runChildSync("raw_commit_transaction_restart", descriptor);
      assert.equal(result.ok, true, result.message);
      assert.equal(
        result.restartCode,
        "lite_runtime_inherited_authority_database_transaction_capability_invalid",
      );
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temp.directory, { recursive: true, force: true });
    }
  });
}
