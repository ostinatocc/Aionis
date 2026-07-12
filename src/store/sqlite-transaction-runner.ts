import { AsyncLocalStorage } from "node:async_hooks";

export type SqliteTransactionRunner = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  read<T>(fn: () => Promise<T> | T): Promise<T>;
  afterCommit(fn: () => Promise<void>): Promise<void>;
  inTransaction(): boolean;
};

export type SqliteTransactionPhase = "after_begin" | "before_commit" | "after_commit" | "before_rollback";

type SqliteTransactionContext = {
  owner: symbol;
  afterCommit: Array<() => Promise<void>>;
};

export function createSqliteTransactionRunner(args: {
  begin: () => void;
  commit: () => void;
  rollback: () => void;
  onPhase?: (phase: SqliteTransactionPhase) => void | Promise<void>;
}): SqliteTransactionRunner {
  const storage = new AsyncLocalStorage<SqliteTransactionContext>();
  let activeOwner: symbol | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const current = storage.getStore();
      if (current && activeOwner === current.owner) return await fn();

      const completed = await enqueue(async () => {
        const owner = Symbol("sqlite-transaction");
        const context: SqliteTransactionContext = { owner, afterCommit: [] };
        activeOwner = owner;
        let began = false;
        try {
          args.begin();
          began = true;
          await args.onPhase?.("after_begin");
          const out = await storage.run(context, fn);
          await args.onPhase?.("before_commit");
          args.commit();
          return { out, afterCommit: context.afterCommit };
        } catch (err) {
          if (began) {
            try {
              await args.onPhase?.("before_rollback");
              args.rollback();
            } catch {
              // Preserve the original transaction failure. A failed rollback makes the
              // connection unusable, but must not hide the cause that triggered it.
            }
          }
          throw err;
        } finally {
          activeOwner = null;
        }
      });

      try {
        await args.onPhase?.("after_commit");
      } catch (error) {
        process.emitWarning(`SQLite after-commit hook failed: ${error instanceof Error ? error.message : String(error)}`, {
          code: "AIONIS_SQLITE_AFTER_COMMIT_FAILED",
        });
      }
      for (const callback of completed.afterCommit) {
        try {
          await callback();
        } catch (error) {
          process.emitWarning(`SQLite post-commit callback failed: ${error instanceof Error ? error.message : String(error)}`, {
            code: "AIONIS_SQLITE_POST_COMMIT_FAILED",
          });
        }
      }
      return completed.out;
    },

    async read<T>(fn: () => Promise<T> | T): Promise<T> {
      const current = storage.getStore();
      if (current && activeOwner === current.owner) return await fn();
      return await enqueue(async () => await fn());
    },

    async afterCommit(fn: () => Promise<void>): Promise<void> {
      const current = storage.getStore();
      if (current && activeOwner === current.owner) {
        current.afterCommit.push(fn);
        return;
      }
      await fn();
    },

    inTransaction(): boolean {
      const current = storage.getStore();
      return !!current && activeOwner === current.owner;
    },
  };
}
