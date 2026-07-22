import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertContinuationRuntimeV1AuthorityClock,
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import {
  CONTINUATION_RUNTIME_V1_APPLICATION_ID,
  CONTINUATION_RUNTIME_V1_TABLES,
  CONTINUATION_RUNTIME_V1_USER_VERSION,
  loadContinuationRuntimeV1SchemaManifest,
} from "../../src/store/continuation-runtime-v1-schema.js";
import {
  createSqliteDatabase,
  createSqliteReadWriteExistingDatabase,
} from "../../src/store/sqlite.js";

const FIXED_NOW = "2026-07-21T00:00:00.000Z";
const FIXED_DATABASE_ID = "a".repeat(64);
const ARTIFACT_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const BOOTSTRAP_CRASH_CHILD = fileURLToPath(
  new URL("./support/continuation-runtime-v1-bootstrap-crash-child.ts", import.meta.url),
);

function fixture(): { root: string; path: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "aionis-continuation-v1-db-"));
  return {
    root,
    path: join(root, "authority", "runtime.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifactSnapshot(path: string): ReadonlyArray<Readonly<{
  suffix: string;
  sha256: string;
  size: number;
  mode: number;
}>> {
  return ARTIFACT_SUFFIXES
    .filter((suffix) => existsSync(`${path}${suffix}`))
    .map((suffix) => {
      const artifactPath = `${path}${suffix}`;
      const stat = lstatSync(artifactPath);
      return {
        suffix,
        sha256: sha256File(artifactPath),
        size: stat.size,
        mode: stat.mode & 0o7777,
      };
    });
}

function pragmaNumber(database: ContinuationRuntimeV1Database, pragma: string): number {
  const row = database.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
  return Object.values(row)[0] as number;
}

function authorityClockFloor(database: ContinuationRuntimeV1Database): string {
  return (database.db.prepare(
    "SELECT authority_clock_floor_at FROM runtime_meta WHERE singleton = 1",
  ).get() as { authority_clock_floor_at: string }).authority_clock_floor_at;
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function createDatabase(path: string): ContinuationRuntimeV1Database {
  return openContinuationRuntimeV1Database(path, {
    authorityNow: () => FIXED_NOW,
    databaseInstanceId: FIXED_DATABASE_ID,
  });
}

test("database authority fails closed before touching storage on unsupported platforms", () => {
  const current = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    assert.throws(
      () => createDatabase(current.path),
      /continuation_runtime_v1_host_platform_unsupported/u,
    );
    assert.equal(existsSync(current.path), false);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    current.cleanup();
  }
});

test("database authority rejects unsupported Node majors before touching storage", () => {
  const current = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  assert.ok(descriptor);
  try {
    Object.defineProperty(process.versions, "node", { ...descriptor, value: "23.10.0" });
    assert.throws(
      () => createDatabase(current.path),
      /continuation_runtime_v1_host_node_version_unsupported/u,
    );
    assert.equal(existsSync(current.path), false);
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
    current.cleanup();
  }
});

test("database authority authenticates its sole clock before claiming storage", () => {
  for (const authorityNow of [
    () => { throw new Error("raw clock failure must be redacted"); },
    (() => 123) as unknown as () => string,
    () => "2026-07-21T00:00:00Z",
  ]) {
    const current = fixture();
    try {
      assert.throws(
        () => openContinuationRuntimeV1Database(current.path, { authorityNow }),
        (error: unknown) => {
          assert.equal(
            (error as Error).message,
            "continuation_runtime_v1_authority_clock_invalid",
          );
          return true;
        },
      );
      assert.equal(existsSync(current.path), false);
    } finally {
      current.cleanup();
    }
  }
});

test("bootstrap consumes one cached clock value and later clock faults fail stably", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  let clockCalls = 0;
  try {
    database = openContinuationRuntimeV1Database(current.path, {
      databaseInstanceId: FIXED_DATABASE_ID,
      authorityNow: () => {
        clockCalls += 1;
        if (clockCalls === 1) return FIXED_NOW;
        if (clockCalls === 2) throw new Error("later raw clock failure must be redacted");
        return "2026-07-21T00:00:00Z";
      },
    });
    assert.equal(clockCalls, 1);
    assert.equal(
      (database.db.prepare("SELECT created_at FROM runtime_meta").get() as {
        created_at: string;
      }).created_at,
      FIXED_NOW,
    );
    for (const expectedCalls of [2, 3]) {
      assert.throws(
        () => database!.authorityNow(),
        (error: unknown) => {
          assert.equal(
            (error as Error).message,
            "continuation_runtime_v1_authority_clock_invalid",
          );
          return true;
        },
      );
      assert.equal(clockCalls, expectedCalls);
    }
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("database authority clock is a frozen opaque capability", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = createDatabase(current.path);
    const clock = database.authorityNow;
    assert.equal(clock, database.authorityNow);
    assert.equal(Object.isFrozen(clock), true);
    assert.doesNotThrow(() => assertContinuationRuntimeV1AuthorityClock(clock));

    const rawClock = () => FIXED_NOW;
    assert.throws(
      () => assertContinuationRuntimeV1AuthorityClock(rawClock),
      /continuation_runtime_v1_authority_clock_capability_invalid/u,
    );
    const forgedDatabase = Object.freeze({
      ...database,
      authorityNow: rawClock,
    }) as unknown as ContinuationRuntimeV1Database;
    assert.throws(
      () => assertContinuationRuntimeV1AuthorityClock(forgedDatabase.authorityNow),
      /continuation_runtime_v1_authority_clock_capability_invalid/u,
    );
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("authority time mint is transaction-only, clamps regressions, and advances only on commit", async () => {
  const current = fixture();
  let rawClock = FIXED_NOW;
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openContinuationRuntimeV1Database(current.path, {
      databaseInstanceId: FIXED_DATABASE_ID,
      authorityNow: () => rawClock,
    });
    assert.throws(
      () => database!.mintAuthorityTime(null),
      /continuation_runtime_v1_authority_time_mint_requires_transaction/u,
    );
    assert.equal(authorityClockFloor(database), FIXED_NOW);

    rawClock = "2026-07-20T23:59:59.000Z";
    assert.equal(database.authorityNow(), FIXED_NOW);
    const committedBound = plusMilliseconds(FIXED_NOW, 100);
    const expectedCommitted = plusMilliseconds(committedBound, 1);
    let committed = "";
    await database.withTx(async () => {
      committed = database!.mintAuthorityTime(committedBound);
      assert.equal(committed, expectedCommitted);
      assert.equal(authorityClockFloor(database!), expectedCommitted);
      assert.equal(
        database!.authorityNow(),
        expectedCommitted,
        "the transaction owner must observe its tentative persisted floor",
      );
    });
    assert.equal(committed, expectedCommitted);
    assert.equal(authorityClockFloor(database), expectedCommitted);
    assert.equal(database.authorityNow(), expectedCommitted);

    const rolledBackBoundOne = plusMilliseconds(expectedCommitted, 100);
    const expectedRolledBackOne = plusMilliseconds(rolledBackBoundOne, 1);
    const rolledBackBoundTwo = plusMilliseconds(expectedRolledBackOne, 100);
    const expectedRolledBackTwo = plusMilliseconds(rolledBackBoundTwo, 1);
    await assert.rejects(
      database.withTx(async () => {
        assert.equal(
          database!.mintAuthorityTime(rolledBackBoundOne),
          expectedRolledBackOne,
        );
        assert.equal(authorityClockFloor(database!), expectedRolledBackOne);
        assert.equal(
          database!.authorityNow(),
          expectedRolledBackOne,
          "the transaction owner must observe its first tentative mint",
        );
        assert.equal(
          database!.mintAuthorityTime(rolledBackBoundTwo),
          expectedRolledBackTwo,
        );
        assert.equal(authorityClockFloor(database!), expectedRolledBackTwo);
        assert.equal(
          database!.authorityNow(),
          expectedRolledBackTwo,
          "the transaction owner must observe its second tentative mint",
        );
        throw new Error("rollback authority floor");
      }),
      /rollback authority floor/u,
    );
    assert.equal(authorityClockFloor(database), expectedCommitted);
    assert.equal(database.authorityNow(), expectedCommitted);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("committed authority time floor survives close, reopen, and raw clock regression", async () => {
  const current = fixture();
  let rawClock = FIXED_NOW;
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openContinuationRuntimeV1Database(current.path, {
      databaseInstanceId: FIXED_DATABASE_ID,
      authorityNow: () => rawClock,
    });
    const bound = plusMilliseconds(FIXED_NOW, 1_000);
    const expected = plusMilliseconds(bound, 1);
    assert.equal(
      await database.withTx(async () => database!.mintAuthorityTime(bound)),
      expected,
    );
    await database.close();
    database = null;

    rawClock = "2026-07-20T00:00:00.000Z";
    database = openContinuationRuntimeV1Database(current.path, {
      authorityNow: () => rawClock,
    });
    assert.equal(authorityClockFloor(database), expected);
    assert.equal(database.authorityNow(), expected);
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("a stale second opener refreshes the persisted authority floor while minting", async () => {
  const current = fixture();
  const rawClock = FIXED_NOW;
  let first: ContinuationRuntimeV1Database | null = null;
  let second: ContinuationRuntimeV1Database | null = null;
  try {
    first = openContinuationRuntimeV1Database(current.path, {
      databaseInstanceId: FIXED_DATABASE_ID,
      authorityNow: () => rawClock,
    });
    second = openContinuationRuntimeV1Database(current.path, {
      authorityNow: () => rawClock,
    });
    assert.equal(first.authorityNow(), FIXED_NOW);
    assert.equal(second.authorityNow(), FIXED_NOW);

    const firstBound = plusMilliseconds(FIXED_NOW, 2_000);
    const firstMinted = plusMilliseconds(firstBound, 1);
    assert.equal(
      await first.withTx(async () => first!.mintAuthorityTime(firstBound)),
      firstMinted,
    );
    assert.equal(first.authorityNow(), firstMinted);
    assert.equal(
      second.authorityNow(),
      FIXED_NOW,
      "the second opener intentionally retains a stale process floor",
    );
    assert.equal(authorityClockFloor(second), firstMinted);

    const refreshed = await second.withTx(async () => second!.mintAuthorityTime(null));
    assert.equal(refreshed, firstMinted);
    assert.equal(second.authorityNow(), firstMinted);
    assert.equal(authorityClockFloor(second), firstMinted);
  } finally {
    await second?.close();
    await first?.close();
    current.cleanup();
  }
});

test("clean bootstrap creates only the exact V1 authority schema and reopens it", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = createDatabase(current.path);
    assert.equal(Object.isFrozen(database), true);
    assert.equal(database.authorityNow(), FIXED_NOW);
    const tableRows = database.db.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tableRows.map((row) => row.name), CONTINUATION_RUNTIME_V1_TABLES);
    assert.equal(pragmaNumber(database, "application_id"), CONTINUATION_RUNTIME_V1_APPLICATION_ID);
    assert.equal(pragmaNumber(database, "user_version"), CONTINUATION_RUNTIME_V1_USER_VERSION);
    assert.equal(
      (database.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      "wal",
    );
    assert.deepEqual(
      { ...database.db.prepare(
        `SELECT database_instance_id, schema_id, schema_version,
                schema_manifest_sha256, created_at
           FROM runtime_meta`,
      ).get() },
      {
        database_instance_id: FIXED_DATABASE_ID,
        schema_id: "continuation_runtime_v1",
        schema_version: 1,
        schema_manifest_sha256: loadContinuationRuntimeV1SchemaManifest().schema_sha256,
        created_at: FIXED_NOW,
      },
    );
    assert.throws(
      () => database!.db.exec("UPDATE runtime_meta SET created_at = created_at"),
      /runtime_meta is immutable/u,
    );
    assert.equal(lstatSync(current.root).mode & 0o7777, 0o700);
    assert.equal(lstatSync(join(current.root, "authority")).mode & 0o7777, 0o700);
    assert.equal(lstatSync(current.path).mode & 0o7777, 0o600);

    await database.close();
    database = openContinuationRuntimeV1Database(current.path);
    assert.equal(database.databaseInstanceId, FIXED_DATABASE_ID);
    assert.equal(database.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("an existing empty path is rejected without bootstrap or sidecar writes", () => {
  const current = fixture();
  try {
    mkdirSync(join(current.root, "authority"), { mode: 0o700 });
    const descriptor = openSync(current.path, "wx", 0o600);
    closeSync(descriptor);
    const before = artifactSnapshot(current.path);
    assert.throws(
      () => openContinuationRuntimeV1Database(current.path),
      /continuation_runtime_v1_schema_mismatch/u,
    );
    assert.deepEqual(artifactSnapshot(current.path), before);
    assert.deepEqual(before.map((artifact) => artifact.suffix), [""]);
  } finally {
    current.cleanup();
  }
});

test("a legacy or unrelated SQLite file is rejected byte-for-byte without sidecars", () => {
  const current = fixture();
  try {
    mkdirSync(join(current.root, "authority"), { mode: 0o700 });
    const legacy = createSqliteDatabase(current.path);
    legacy.exec("CREATE TABLE legacy_memory(id TEXT PRIMARY KEY) STRICT;");
    legacy.close();
    chmodSync(current.path, 0o600);
    const before = artifactSnapshot(current.path);
    assert.throws(
      () => openContinuationRuntimeV1Database(current.path),
      /continuation_runtime_v1_schema_mismatch/u,
    );
    assert.deepEqual(artifactSnapshot(current.path), before);
    assert.deepEqual(before.map((artifact) => artifact.suffix), [""]);
  } finally {
    current.cleanup();
  }
});

test("a failed bootstrap claim is retained and can never be retried as migration", () => {
  const current = fixture();
  try {
    assert.throws(
      () => openContinuationRuntimeV1Database(current.path, {
        authorityNow: () => FIXED_NOW,
        databaseInstanceId: "not-a-digest",
      }),
      /database_instance_id_invalid/u,
    );
    assert.equal(existsSync(current.path), true);
    assert.equal(lstatSync(current.path).mode & 0o7777, 0o600);
    assert.throws(
      () => createDatabase(current.path),
      /continuation_runtime_v1_schema_mismatch/u,
    );
  } finally {
    current.cleanup();
  }
});

test("extra schema objects are rejected without mutating the tampered database", async () => {
  const current = fixture();
  try {
    const database = createDatabase(current.path);
    await database.close();
    const tamper = createSqliteReadWriteExistingDatabase(current.path);
    tamper.exec("PRAGMA journal_mode = DELETE; CREATE TABLE injected(value TEXT) STRICT;");
    tamper.close();
    const before = artifactSnapshot(current.path);
    assert.throws(
      () => openContinuationRuntimeV1Database(current.path),
      /extra_schema_object:table:injected/u,
    );
    assert.deepEqual(artifactSnapshot(current.path), before);
  } finally {
    current.cleanup();
  }
});

test("the side-effect-free preflight reconstructs WAL beside the database without global tmp", async () => {
  const current = fixture();
  let first: ContinuationRuntimeV1Database | null = null;
  let second: ContinuationRuntimeV1Database | null = null;
  const previousTemp = ["TMPDIR", "TMP", "TEMP"].map((field) => [
    field,
    process.env[field],
  ] as const);
  try {
    first = createDatabase(current.path);
    await first.withTx(async () => {
      first!.db.prepare(
        `INSERT INTO operations(
           tenant_id, scope, operation_kind, operation_id, actor_kind,
           actor_principal_sha256, request_sha256, request_json, receipt_sha256,
           receipt_json, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      ).run(
        "tenant-a",
        "scope-a",
        "record_observations",
        "operation-a",
        "trusted_host",
        "1".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "{}",
        FIXED_NOW,
      );
    });
    assert.equal(existsSync(`${current.path}-wal`), true);

    const authorityDirectory = join(current.root, "authority");
    const beforeEntries = readdirSync(authorityDirectory).sort();
    // The old implementation called mkdtemp under os.tmpdir(). Point every
    // supported global temp selector at a regular file so that dependency
    // fails with ENOTDIR while same-directory private scratch remains valid.
    for (const [field] of previousTemp) process.env[field] = current.path;

    // Keep the first connection alive so the committed row remains represented
    // by the original WAL namespace while the second opener performs preflight.
    second = openContinuationRuntimeV1Database(current.path);
    assert.equal(
      (second.db.prepare("SELECT count(*) AS count FROM operations").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(readdirSync(authorityDirectory).sort(), beforeEntries);
  } finally {
    for (const [field, value] of previousTemp) {
      if (value === undefined) delete process.env[field];
      else process.env[field] = value;
    }
    await second?.close();
    await first?.close();
    current.cleanup();
  }
});

test("transaction failures roll back authority writes", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = createDatabase(current.path);
    await assert.rejects(
      database.withTx(async () => {
        database!.db.prepare(
          `INSERT INTO operations(
             tenant_id, scope, operation_kind, operation_id, actor_kind,
             actor_principal_sha256, request_sha256, request_json, receipt_sha256,
             receipt_json, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
        ).run(
          "tenant-a",
          "scope-a",
          "record_observations",
          "operation-rollback",
          "trusted_host",
          "1".repeat(64),
          "d".repeat(64),
          "e".repeat(64),
          "{}",
          FIXED_NOW,
        );
        throw new Error("injected failure");
      }),
      /injected failure/u,
    );
    assert.equal(
      (database.db.prepare("SELECT count(*) AS count FROM operations").get() as { count: number }).count,
      0,
    );
    await database.withTx(async () => {
      await assert.rejects(
        database!.close(),
        /continuation_runtime_v1_cannot_close_inside_transaction/u,
      );
      assert.equal(database!.transaction.inTransaction(), true);
    });

    const firstClose = database.close();
    const concurrentClose = database.close();
    assert.equal(firstClose, concurrentClose);
    await firstClose;
    database = null;
  } finally {
    await database?.close();
    current.cleanup();
  }
});

test("SIGKILL during bootstrap leaves either a rejected partial claim or a complete V1 database", async () => {
  const incompletePhases = [
    "after_claim",
    "after_begin",
    "after_schema",
    "after_meta",
    "before_commit",
  ] as const;
  const completePhases = ["after_commit", "after_wal"] as const;

  for (const phase of [...incompletePhases, ...completePhases]) {
    const current = fixture();
    let database: ContinuationRuntimeV1Database | null = null;
    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", BOOTSTRAP_CRASH_CHILD, current.path, phase],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(child.signal, "SIGKILL", `${phase}: ${child.stderr || child.stdout}`);
      assert.equal(existsSync(current.path), true, `${phase}: missing claimed path`);

      if ((incompletePhases as readonly string[]).includes(phase)) {
        const before = artifactSnapshot(current.path);
        assert.throws(
          () => openContinuationRuntimeV1Database(current.path),
          /continuation_runtime_v1_(?:schema_mismatch|runtime_meta)/u,
          phase,
        );
        assert.deepEqual(artifactSnapshot(current.path), before, phase);
      } else {
        database = openContinuationRuntimeV1Database(current.path);
        assert.equal(database.databaseInstanceId, FIXED_DATABASE_ID, phase);
        assert.equal(
          (database.db.prepare("SELECT count(*) AS count FROM runtime_meta").get() as { count: number }).count,
          1,
          phase,
        );
      }
    } finally {
      await database?.close();
      current.cleanup();
    }
  }
});
