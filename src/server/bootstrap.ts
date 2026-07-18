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

type AsyncLifecycle = {
  shutdown: () => Promise<void>;
};

export type RuntimeShutdownSignal = "SIGTERM" | "SIGINT";

export type RuntimeShutdownHost = {
  addSignalListener(signal: RuntimeShutdownSignal, listener: () => void): void;
  removeSignalListener(signal: RuntimeShutdownSignal, listener: () => void): void;
  setExitCode(code: number): void;
  forceExit(code: number): void;
};

export type RuntimeSignalShutdownController = {
  requestShutdown(signal: RuntimeShutdownSignal): Promise<void>;
  shutdownRequested(): boolean;
  waitForShutdown(): Promise<void>;
  dispose(): void;
};

export const DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS = 30_000;

function signalExitCode(signal: RuntimeShutdownSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

function nodeRuntimeShutdownHost(): RuntimeShutdownHost {
  return {
    addSignalListener: (signal, listener) => process.on(signal, listener),
    removeSignalListener: (signal, listener) => process.off(signal, listener),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    forceExit: (code) => process.exit(code),
  };
}

/**
 * Routes process termination through Fastify's existing onClose authority.
 * The first signal drains; a second signal or the deadline forces termination.
 */
export function registerRuntimeSignalShutdown(args: {
  app: FastifyInstance;
  timeoutMs?: number;
  host?: RuntimeShutdownHost;
}): RuntimeSignalShutdownController {
  const host = args.host ?? nodeRuntimeShutdownHost();
  const timeoutMs = Math.max(
    1,
    Math.trunc(args.timeoutMs ?? DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS),
  );
  let closing: Promise<void> | null = null;
  let deadline: NodeJS.Timeout | null = null;
  let firstSignal: RuntimeShutdownSignal | null = null;
  let disposed = false;
  let forced = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    host.removeSignalListener("SIGTERM", onSigterm);
    host.removeSignalListener("SIGINT", onSigint);
  };

  const force = (reason: "second_signal" | "shutdown_timeout"): void => {
    if (forced) return;
    forced = true;
    const signal = firstSignal ?? "SIGTERM";
    const code = signalExitCode(signal);
    args.app.log.error({ signal, reason, exit_code: code }, "forcing Runtime shutdown");
    dispose();
    host.forceExit(code);
  };

  const requestShutdown = (signal: RuntimeShutdownSignal): Promise<void> => {
    if (closing) {
      force("second_signal");
      return closing;
    }

    firstSignal = signal;
    // A completed drain is a normal orchestrated stop. Only a failed close,
    // second signal, or deadline reports a non-zero/128+signal exit status.
    host.setExitCode(0);
    args.app.log.info({ signal, timeout_ms: timeoutMs }, "draining Runtime before shutdown");

    deadline = setTimeout(() => force("shutdown_timeout"), timeoutMs);
    deadline.unref?.();

    let finish!: () => void;
    closing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    void args.app.close().then(
      finish,
      (error) => {
        args.app.log.error({
          signal,
          error: error instanceof Error ? error.message : String(error),
        }, "Runtime graceful shutdown failed");
        host.setExitCode(1);
        finish();
      },
    );
    void closing.then(() => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
      dispose();
    });
    return closing;
  };

  const onSigterm = (): void => {
    void requestShutdown("SIGTERM");
  };
  const onSigint = (): void => {
    void requestShutdown("SIGINT");
  };

  host.addSignalListener("SIGTERM", onSigterm);
  host.addSignalListener("SIGINT", onSigint);
  args.app.addHook("onClose", async () => {
    // Programmatic close must not leak process listeners. Signal-driven close
    // retains them until the drain finishes so a second signal can force exit.
    if (!closing) dispose();
  });

  return {
    requestShutdown,
    shutdownRequested: () => closing !== null,
    waitForShutdown: async () => {
      if (closing) await closing;
    },
    dispose,
  };
}

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
  sandboxExecutor: AsyncLifecycle;
  liteRecallStore?: CloseableRuntimeStore | null;
  liteReplayStore?: CloseableRuntimeStore | null;
  liteWriteStore?: CloseableRuntimeStore | null;
  projectionWorker?: AsyncLifecycle | null;
  learningControlWorker?: AsyncLifecycle | null;
  associativeLinkWorker?: AsyncLifecycle | null;
  liteClaimLedgerStore?: CloseableRuntimeStore | null;
  liteSkillCandidateReviewStore?: CloseableRuntimeStore | null;
  executionStateStore?: CloseableRuntimeStore | null;
  executionTreeStore?: CloseableRuntimeStore | null;
}) {
  const { app } = args;
  app.addHook("onClose", async () => {
    await closeBootstrapResources(args);
  });
}

export async function closeBootstrapResources(args: {
  store: LiteRuntimeStore;
  sandboxExecutor: AsyncLifecycle;
  liteRecallStore?: CloseableRuntimeStore | null;
  liteReplayStore?: CloseableRuntimeStore | null;
  liteWriteStore?: CloseableRuntimeStore | null;
  projectionWorker?: AsyncLifecycle | null;
  learningControlWorker?: AsyncLifecycle | null;
  associativeLinkWorker?: AsyncLifecycle | null;
  liteClaimLedgerStore?: CloseableRuntimeStore | null;
  liteSkillCandidateReviewStore?: CloseableRuntimeStore | null;
  executionStateStore?: CloseableRuntimeStore | null;
  executionTreeStore?: CloseableRuntimeStore | null;
}): Promise<void> {
  const {
    store,
    sandboxExecutor,
    liteRecallStore,
    liteReplayStore,
    liteWriteStore,
    projectionWorker,
    learningControlWorker,
    associativeLinkWorker,
    liteClaimLedgerStore,
    liteSkillCandidateReviewStore,
    executionStateStore,
    executionTreeStore,
  } = args;
  const errors: Error[] = [];
  const lifecycles: Array<readonly [string, () => Promise<void>]> = [
    ["associative_link_worker", () => associativeLinkWorker?.shutdown() ?? Promise.resolve()],
    ["learning_control_worker", () => learningControlWorker?.shutdown() ?? Promise.resolve()],
    ["projection_worker", () => projectionWorker?.shutdown() ?? Promise.resolve()],
    ["sandbox_executor", () => sandboxExecutor.shutdown()],
  ];
  const workerResults = await Promise.allSettled(
    lifecycles.map(([, close]) => Promise.resolve().then(close)),
  );
  for (let index = 0; index < workerResults.length; index += 1) {
    const result = workerResults[index];
    if (result?.status === "rejected") {
      errors.push(new Error(`runtime_close_failed:${lifecycles[index]?.[0] ?? "worker"}`, {
        cause: result.reason,
      }));
    }
  }

  const stores: Array<readonly [string, CloseableRuntimeStore | LiteRuntimeStore | null | undefined]> = [
    ["execution_tree_store", executionTreeStore],
    ["execution_state_store", executionStateStore],
    ["skill_candidate_review_store", liteSkillCandidateReviewStore],
    ["claim_ledger_store", liteClaimLedgerStore],
    ["recall_store", liteRecallStore],
    ["replay_store", liteReplayStore],
    ["write_store", liteWriteStore],
    ["runtime_store", store],
  ];
  for (const [label, closeable] of stores) {
    if (!closeable) continue;
    try {
      await closeable.close();
    } catch (error) {
      errors.push(new Error(`runtime_close_failed:${label}`, { cause: error }));
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "one or more Runtime resources failed to close");
  }
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
