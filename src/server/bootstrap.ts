import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Env } from "../config.js";
import type { LiteRuntimeStore } from "../store/memory-store.js";
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

type AsyncLifecycle = {
  shutdown: () => Promise<void>;
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
  store: LiteRuntimeStore;
  sandboxExecutor: SandboxLifecycle;
  liteRecallStore?: CloseableRuntimeStore | null;
  liteReplayStore?: CloseableRuntimeStore | null;
  liteWriteStore?: CloseableRuntimeStore | null;
  projectionWorker?: AsyncLifecycle | null;
  associativeLinkWorker?: SandboxLifecycle | null;
  liteClaimLedgerStore?: CloseableRuntimeStore | null;
  liteSkillCandidateReviewStore?: CloseableRuntimeStore | null;
  executionStateStore?: CloseableRuntimeStore | null;
  executionTreeStore?: CloseableRuntimeStore | null;
}) {
  const {
    app,
    store,
    sandboxExecutor,
    liteRecallStore,
    liteReplayStore,
    liteWriteStore,
    projectionWorker,
    associativeLinkWorker,
    liteClaimLedgerStore,
    liteSkillCandidateReviewStore,
    executionStateStore,
    executionTreeStore,
  } = args;
  app.addHook("onClose", async () => {
    associativeLinkWorker?.shutdown();
    if (projectionWorker) await projectionWorker.shutdown();
    sandboxExecutor.shutdown();
    if (executionTreeStore) await executionTreeStore.close();
    if (executionStateStore) await executionStateStore.close();
    if (liteSkillCandidateReviewStore) await liteSkillCandidateReviewStore.close();
    if (liteClaimLedgerStore) await liteClaimLedgerStore.close();
    if (liteRecallStore) await liteRecallStore.close();
    if (liteReplayStore) await liteReplayStore.close();
    if (liteWriteStore) await liteWriteStore.close();
    await store.close();
  });
}

export async function assertBootstrapStoreContracts(args: {
  liteRecallAccess: RecallStoreAccess | null;
  liteReplayAccess: ReplayStoreAccess | null;
  liteWriteStore: WriteStoreAccess;
}) {
  const { liteRecallAccess, liteReplayAccess, liteWriteStore } = args;
  if (!liteRecallAccess) throw new Error("recall store access is not available");
  if (!liteReplayAccess) throw new Error("replay store access is not available");
  assertRecallStoreAccessContract(liteRecallAccess);
  assertReplayStoreAccessContract(liteReplayAccess);
  assertWriteStoreAccessContract(liteWriteStore);
}

export function resolveListenHost(env: Pick<Env, "AIONIS_LISTEN_HOST">) {
  const configured = String(env.AIONIS_LISTEN_HOST ?? "").trim();
  if (configured.length > 0) return configured;
  return "127.0.0.1";
}

export async function listenHttpApp(app: FastifyInstance, env: Env) {
  await app.listen({ port: env.PORT, host: resolveListenHost(env) });
}
