import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

export type SqliteBeginBusyRetry = Readonly<{
  maxAttempts: number;
  delayMs: number;
}>;

export type SqliteTransactionRunOptions = Readonly<{
  beginBusyRetry?: SqliteBeginBusyRetry;
}>;

export type SqliteTransactionRunner = {
  run<T>(fn: () => Promise<T>, options?: SqliteTransactionRunOptions): Promise<T>;
  read<T>(fn: () => Promise<T> | T): Promise<T>;
  afterCommit(fn: () => Promise<void>): Promise<void>;
  inTransaction(): boolean;
};

export type SqliteTransactionPhase = "after_begin" | "before_commit" | "after_commit" | "before_rollback";

type SqliteTransactionContext = {
  owner: symbol;
  afterCommit: Array<() => Promise<void>>;
};

function assertBeginBusyRetry(options: SqliteBeginBusyRetry): void {
  if (!Number.isSafeInteger(options.maxAttempts)
    || options.maxAttempts < 1 || options.maxAttempts > 12) {
    throw new Error("SQLite BEGIN busy retry maxAttempts must be an integer between 1 and 12");
  }
  if (!Number.isSafeInteger(options.delayMs)
    || options.delayMs < 0 || options.delayMs > 1_000) {
    throw new Error("SQLite BEGIN busy retry delayMs must be an integer between 0 and 1000");
  }
}

function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const sqliteError = error as { code?: unknown; errcode?: unknown };
  return sqliteError.code === "ERR_SQLITE_ERROR"
    && typeof sqliteError.errcode === "number"
    && Number.isInteger(sqliteError.errcode)
    && (sqliteError.errcode & 0xff) === 5;
}

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
    async run<T>(fn: () => Promise<T>, options: SqliteTransactionRunOptions = {}): Promise<T> {
      const beginBusyRetry = options.beginBusyRetry;
      if (beginBusyRetry) assertBeginBusyRetry(beginBusyRetry);
      const current = storage.getStore();
      if (current && activeOwner === current.owner) return await fn();

      const completed = await enqueue(async () => {
        const owner = Symbol("sqlite-transaction");
        const context: SqliteTransactionContext = { owner, afterCommit: [] };
        activeOwner = owner;
        let began = false;
        try {
          let beginAttempt = 0;
          while (true) {
            beginAttempt += 1;
            try {
              args.begin();
              break;
            } catch (error) {
              if (!beginBusyRetry
                || beginAttempt >= beginBusyRetry.maxAttempts
                || !isSqliteBusyError(error)) {
                throw error;
              }
              if (beginBusyRetry.delayMs > 0) {
                await delay(beginBusyRetry.delayMs);
              }
            }
          }
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
