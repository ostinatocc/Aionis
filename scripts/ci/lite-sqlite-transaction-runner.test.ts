import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteTransactionRunner } from "../../src/store/sqlite-transaction-runner.ts";

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
