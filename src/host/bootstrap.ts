import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Env } from "../config.js";
import type { MemoryStore } from "../store/memory-store.js";
import { assertRecallStoreAccessContract } from "../store/recall-access.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import { assertReplayStoreAccessContract } from "../store/replay-access.js";
import type { ReplayStoreAccess } from "../store/replay-access.js";
import { assertWriteStoreAccessContract } from "../store/write-access.js";
import type { WriteStoreAccess } from "../store/write-access.js";

type CloseableRuntimeStore = {
  close: () => Promise<void>;
};

type SandboxLifecycle = {
  shutdown: () => void;
};

export function createHttpApp(env: Env) {
  return Fastify({
    logger: true,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: env.TRUST_PROXY,
    genReqId: (req) => {
      const rawHeader = req.headers["x-request-id"] ?? req.headers["X-Request-Id"];
      const hdr = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (typeof hdr === "string" && hdr.trim().length > 0) {
        return hdr.trim();
      }
      return randomUUID();
    },
  });
}

export function registerBootstrapLifecycle(args: {
  app: FastifyInstance;
  store: MemoryStore;
  sandboxExecutor: SandboxLifecycle;
  liteRecallStore?: CloseableRuntimeStore | null;
  liteReplayStore?: CloseableRuntimeStore | null;
  liteWriteStore?: CloseableRuntimeStore | null;
  executionStateStore?: CloseableRuntimeStore | null;
}) {
  const { app, store, sandboxExecutor, liteRecallStore, liteReplayStore, liteWriteStore, executionStateStore } = args;
  app.addHook("onClose", async () => {
    sandboxExecutor.shutdown();
    if (executionStateStore) await executionStateStore.close();
    if (liteRecallStore) await liteRecallStore.close();
    if (liteReplayStore) await liteReplayStore.close();
    if (liteWriteStore) await liteWriteStore.close();
    await store.close();
  });
}

export async function assertBootstrapStoreContracts(args: {
  store: MemoryStore;
  recallAccessForClient: (client: pg.PoolClient) => RecallStoreAccess | null;
  replayAccessForClient: (client: pg.PoolClient) => ReplayStoreAccess | null;
  writeAccessForClient: (client: pg.PoolClient) => WriteStoreAccess;
  liteWriteStore?: WriteStoreAccess | null;
}) {
  const { store, recallAccessForClient, replayAccessForClient, writeAccessForClient, liteWriteStore } = args;
  await store.withClient(async (client) => {
    const recallAccess = recallAccessForClient(client);
    const replayAccess = replayAccessForClient(client);
    if (!recallAccess) throw new Error("recall store access is not available");
    if (!replayAccess) throw new Error("replay store access is not available");
    assertRecallStoreAccessContract(recallAccess);
    assertReplayStoreAccessContract(replayAccess);
    assertWriteStoreAccessContract(writeAccessForClient(client));
  });
  if (liteWriteStore) {
    assertWriteStoreAccessContract(liteWriteStore);
  }
}

export function resolveListenHost(env: Pick<Env, "AIONIS_EDITION" | "AIONIS_LISTEN_HOST">) {
  const configured = String(env.AIONIS_LISTEN_HOST ?? "").trim();
  if (configured.length > 0) return configured;
  return env.AIONIS_EDITION === "lite" ? "127.0.0.1" : "0.0.0.0";
}

export async function listenHttpApp(app: FastifyInstance, env: Env) {
  await app.listen({ port: env.PORT, host: resolveListenHost(env) });
}
