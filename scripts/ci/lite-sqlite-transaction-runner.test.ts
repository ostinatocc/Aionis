import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSqliteDatabase, ignoreSqliteDuplicateColumnError } from "../../src/store/sqlite.ts";
import { createSqliteTransactionRunner } from "../../src/store/sqlite-transaction-runner.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-sqlite-"));
  return path.join(dir, `${name}.sqlite`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("sqlite transaction runner serializes concurrent top-level transactions", async () => {
  const events: string[] = [];
  const runner = createSqliteTransactionRunner({
    begin: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });
  const gate = deferred();
  const started = deferred();

  const first = runner.run(async () => {
    events.push("first:start");
    started.resolve();
    await gate.promise;
    events.push("first:end");
    return "first";
  });

  const second = runner.run(async () => {
    events.push("second:start");
    return "second";
  });

  await started.promise;
  assert.deepEqual(events, ["begin", "first:start"]);

  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, [
    "begin",
    "first:start",
    "first:end",
    "commit",
    "begin",
    "second:start",
    "commit",
  ]);
});

test("sqlite transaction runner allows same async transaction to nest", async () => {
  const events: string[] = [];
  const runner = createSqliteTransactionRunner({
    begin: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });

  const out = await runner.run(async () => {
    events.push("outer:start");
    const nested = await runner.run(async () => {
      events.push("inner");
      return "inner-out";
    });
    events.push(`outer:${nested}`);
    return "outer-out";
  });

  assert.equal(out, "outer-out");
  assert.deepEqual(events, ["begin", "outer:start", "inner", "outer:inner-out", "commit"]);
});

test("sqlite transaction runner rolls back and releases queue on failure", async () => {
  const events: string[] = [];
  const runner = createSqliteTransactionRunner({
    begin: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });

  await assert.rejects(
    () =>
      runner.run(async () => {
        events.push("first:start");
        throw new Error("boom");
      }),
    /boom/,
  );

  const out = await runner.run(async () => {
    events.push("second:start");
    return "second";
  });

  assert.equal(out, "second");
  assert.deepEqual(events, ["begin", "first:start", "rollback", "begin", "second:start", "commit"]);
});

test("sqlite transaction runner releases queue when begin fails", async () => {
  const events: string[] = [];
  let failBegin = true;
  const runner = createSqliteTransactionRunner({
    begin: () => {
      events.push("begin");
      if (failBegin) throw new Error("begin failed");
    },
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });

  await assert.rejects(
    () =>
      runner.run(async () => {
        events.push("first:start");
        return "first";
      }),
    /begin failed/,
  );

  failBegin = false;
  const out = await runner.run(async () => {
    events.push("second:start");
    return "second";
  });

  assert.equal(out, "second");
  assert.deepEqual(events, ["begin", "begin", "second:start", "commit"]);
});

test("serialized reads wait until a top-level transaction commits or rolls back", async () => {
  for (const outcome of ["commit", "rollback"] as const) {
    const events: string[] = [];
    const gate = deferred();
    const started = deferred();
    const runner = createSqliteTransactionRunner({
      begin: () => events.push("begin"),
      commit: () => events.push("commit"),
      rollback: () => events.push("rollback"),
    });
    const mutation = runner.run(async () => {
      events.push("mutation");
      started.resolve();
      await gate.promise;
      if (outcome === "rollback") throw new Error("rollback requested");
    });
    await started.promise;
    const read = runner.read(() => {
      events.push("read");
      return "visible";
    });
    await Promise.resolve();
    assert.deepEqual(events, ["begin", "mutation"]);
    gate.resolve();
    if (outcome === "rollback") await assert.rejects(mutation, /rollback requested/);
    else await mutation;
    assert.equal(await read, "visible");
    assert.deepEqual(events, ["begin", "mutation", outcome, "read"]);
  }
});

test("post-commit callbacks do not hold the transaction queue", async () => {
  const events: string[] = [];
  const callbackGate = deferred();
  const callbackStarted = deferred();
  const runner = createSqliteTransactionRunner({
    begin: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });
  const first = runner.run(async () => {
    await runner.afterCommit(async () => {
      events.push("callback:start");
      callbackStarted.resolve();
      await callbackGate.promise;
      events.push("callback:end");
    });
  });
  await callbackStarted.promise;
  const second = await runner.run(async () => {
    events.push("second");
    return "second";
  });
  assert.equal(second, "second");
  assert.deepEqual(events, ["begin", "commit", "callback:start", "begin", "second", "commit"]);
  callbackGate.resolve();
  await first;
});

test("a post-commit callback can start another transaction without deadlock", async () => {
  const events: string[] = [];
  const runner = createSqliteTransactionRunner({
    begin: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });
  await runner.run(async () => {
    await runner.afterCommit(async () => {
      await runner.run(async () => {
        events.push("callback:transaction");
      });
    });
  });
  assert.deepEqual(events, ["begin", "commit", "begin", "callback:transaction", "commit"]);
});

test("a failing post-commit callback does not change committed result", async () => {
  const events: string[] = [];
  const runner = createSqliteTransactionRunner({
    begin: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback"),
  });
  const result = await runner.run(async () => {
    await runner.afterCommit(async () => {
      throw new Error("post-commit failure");
    });
    return "committed";
  });
  assert.equal(result, "committed");
  assert.deepEqual(events, ["begin", "commit"]);
});

test("sqlite duplicate-column migration guard rethrows real ALTER failures", () => {
  const db = createSqliteDatabase(tmpDbPath("duplicate-column-guard"));
  try {
    db.exec("CREATE TABLE migration_guard (id TEXT PRIMARY KEY)");
    db.exec("ALTER TABLE migration_guard ADD COLUMN value TEXT");

    assert.doesNotThrow(() => {
      try {
        db.exec("ALTER TABLE migration_guard ADD COLUMN value TEXT");
      } catch (err) {
        ignoreSqliteDuplicateColumnError(err);
      }
    });

    assert.throws(
      () => {
        try {
          db.exec("ALTER TABLE missing_migration_guard ADD COLUMN value TEXT");
        } catch (err) {
          ignoreSqliteDuplicateColumnError(err);
        }
      },
      /missing_migration_guard|no such table/i,
    );
  } finally {
    db.close();
  }
});
