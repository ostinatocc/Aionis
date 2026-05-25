import pg from "pg";

export type Db = {
  pool: pg.Pool;
};

export type DbPoolOptions = {
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

export function createDb(databaseUrl: string, opts: DbPoolOptions = {}): Db {
  const max = opts.max ?? envInt("DB_POOL_MAX", 30);
  const idleTimeoutMs = opts.idleTimeoutMs ?? envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000);
  const connectionTimeoutMs = opts.connectionTimeoutMs ?? envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5_000);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
  });
  return { pool };
}

export function createNoopDb(): Db {
  const noopQuery = async (sql?: unknown) => {
    const normalized = typeof sql === "string" ? sql.replace(/\s+/g, " ").trim().toUpperCase() : "";
    if (
      normalized === "BEGIN"
      || normalized === "COMMIT"
      || normalized === "ROLLBACK"
      || normalized.startsWith("SAVEPOINT ")
      || normalized.startsWith("RELEASE SAVEPOINT ")
      || normalized.startsWith("ROLLBACK TO SAVEPOINT ")
    ) {
      return { rows: [], rowCount: 0 };
    }
    const err = new Error("database query attempted through noop database");
    (err as any).code = "42P01";
    (err as any).details = { sql_preview: typeof sql === "string" ? sql.slice(0, 240) : null };
    throw err;
  };
  const fakeClient = {
    query: noopQuery,
    release() {},
  };
  return {
    pool: {
      query: noopQuery,
      async connect() {
        return fakeClient;
      },
      async end() {
        return;
      },
    } as unknown as pg.Pool,
  };
}

export async function withClient<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(db: Db): Promise<void> {
  await db.pool.end();
}
