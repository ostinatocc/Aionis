import { AsyncLocalStorage } from "node:async_hooks";

export type SqliteTransactionRunner = {
  run<T>(fn: () => Promise<T>): Promise<T>;
};

export function createSqliteTransactionRunner(args: {
  begin: () => void;
  commit: () => void;
  rollback: () => void;
}): SqliteTransactionRunner {
  const storage = new AsyncLocalStorage<symbol>();
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
      const currentOwner = storage.getStore();
      if (currentOwner && activeOwner === currentOwner) return await fn();

      return await enqueue(async () => {
        const owner = Symbol("sqlite-transaction");
        activeOwner = owner;
        let began = false;
        try {
          args.begin();
          began = true;
          const out = await storage.run(owner, fn);
          args.commit();
          return out;
        } catch (err) {
          if (began) args.rollback();
          throw err;
        } finally {
          activeOwner = null;
        }
      });
    },
  };
}
