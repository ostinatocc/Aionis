import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import { ReplayPlaybookDispatchRequest, ReplayPlaybookRunRequest } from "../memory/schemas.js";
import { replayPlaybookDispatch, replayPlaybookRepairReview, replayPlaybookRun } from "../memory/replay.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import { secretTokensEqual } from "../util/admin_auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type ReplayLearningControlRequest = FastifyRequest<{ Body: unknown }>;
type ReplayPlaybookReviewOptionsLike = Parameters<typeof replayPlaybookRepairReview>[1];
type ReplayPlaybookRunOptionsLike = Parameters<typeof replayPlaybookRun>[1];
type ReplayLearningControlRequestKind =
  | "replay_playbook_repair_review"
  | "replay_playbook_run"
  | "replay_playbook_dispatch";
type ReplayLearningControlRateKind = "write" | "recall";

export function registerMemoryReplayLearningControlRoutes(args: {
  app: FastifyInstance;
  env: {
    AIONIS_EDITION?: string;
    SANDBOX_ENABLED?: boolean;
    SANDBOX_ADMIN_ONLY?: boolean;
    ADMIN_TOKEN?: string;
  };
  liteWriteStore: LiteWriteStore;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: ReplayLearningControlRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: ReplayLearningControlRateKind) => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: ReplayLearningControlRateKind, tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: ReplayLearningControlRateKind) => Promise<InflightGateToken>;
  withReplayRepairReviewDefaults: (body: unknown) => { body: Record<string, unknown>; resolution: unknown };
  buildReplayRepairReviewOptions: (options?: { allowSandboxExecution?: boolean }) => ReplayPlaybookReviewOptionsLike;
  buildReplayPlaybookRunOptions: (
    reply: FastifyReply,
    source: string,
    options?: { allowSandboxExecution?: boolean },
  ) => ReplayPlaybookRunOptionsLike;
}) {
  const {
    app,
    env,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    withReplayRepairReviewDefaults,
    buildReplayRepairReviewOptions,
    buildReplayPlaybookRunOptions,
  } = args;
  assertLocalStoreRuntimeEdition(env, "local-store memory-replay-learning-control routes");
  const executeLearningControlWrite = <TResult>(
    body: unknown,
    operation: (requestBody: unknown) => Promise<TResult>,
  ) => liteWriteStore.withTx(() => operation(body));

  const executeLearningControlRead = <TResult>(
    body: unknown,
    operation: (requestBody: unknown) => Promise<TResult>,
  ) => operation(body);

  const resolveReplayPlaybookRunRateKind = (body: unknown): ReplayLearningControlRateKind => {
    const parsedForMode = ReplayPlaybookRunRequest.safeParse(body);
    const replayMode = parsedForMode.success ? parsedForMode.data.mode : "simulate";
    const prefersDeterministicExecution =
      parsedForMode.success
      && replayMode === "simulate"
      && parsedForMode.data.deterministic_gate?.enabled !== false
      && parsedForMode.data.deterministic_gate?.prefer_deterministic_execution !== false;
    return replayMode === "simulate" && !prefersDeterministicExecution ? "recall" : "write";
  };

  const resolveReplayPlaybookDispatchRateKind = (body: unknown): ReplayLearningControlRateKind => {
    const parsed = ReplayPlaybookDispatchRequest.safeParse(body);
    const deterministicPossible =
      parsed.success
      && parsed.data.deterministic_gate?.enabled !== false
      && parsed.data.deterministic_gate?.prefer_deterministic_execution !== false;
    return deterministicPossible ? "write" : "recall";
  };

  const requestAllowsSandboxExecution = (req: FastifyRequest): boolean => {
    if (!env.SANDBOX_ENABLED || !env.SANDBOX_ADMIN_ONLY) return true;
    const raw = req.headers?.["x-admin-token"];
    const headerToken = typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
    return secretTokensEqual(headerToken, env.ADMIN_TOKEN);
  };

  const runLearningControlRoute = async <TResult>(args: {
    req: ReplayLearningControlRequest;
    reply: FastifyReply;
    requestKind: ReplayLearningControlRequestKind;
    rateKind: ReplayLearningControlRateKind;
    bodyFactory?: (body: unknown) => unknown;
    execute: (body: unknown) => Promise<TResult>;
  }): Promise<TResult> => {
    const { req, reply, requestKind, rateKind, bodyFactory, execute } = args;
    const principal = await requireMemoryPrincipal(req);
    const identifiedBody = withIdentityFromRequest(req, req.body, principal, requestKind);
    const body = bodyFactory ? bodyFactory(identifiedBody) : identifiedBody;
    await enforceRateLimit(req, reply, rateKind);
    await enforceTenantQuota(req, reply, rateKind, tenantFromBody(body));
    const gate = await acquireInflightSlot(rateKind);
    try {
      return await execute(body);
    } finally {
      gate.release();
    }
  };

  app.post("/v1/memory/replay/playbooks/repair/review", async (req: ReplayLearningControlRequest, reply: FastifyReply) => {
    const defaulted = withReplayRepairReviewDefaults(
      withIdentityFromRequest(req, req.body, await requireMemoryPrincipal(req), "replay_playbook_repair_review"),
    );
    const out = await runLearningControlRoute({
      req,
      reply,
      requestKind: "replay_playbook_repair_review",
      rateKind: "write",
      bodyFactory: () => {
        const body = defaulted.body;
        const metadata =
          body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? { ...(body.metadata as Record<string, unknown>) }
            : {};
        body.metadata = {
          ...metadata,
          auto_promote_policy_resolution: defaulted.resolution,
        };
        return body;
      },
      execute: (body) => {
        const reviewOptions = buildReplayRepairReviewOptions({
          allowSandboxExecution: requestAllowsSandboxExecution(req),
        });
        reviewOptions.writeAccess = liteWriteStore;
        return executeLearningControlWrite(body, (requestBody) =>
          replayPlaybookRepairReview(requestBody, reviewOptions),
        );
      },
    });
    if (out && typeof out === "object" && !Array.isArray(out)) {
      (out as Record<string, unknown>).auto_promote_policy_resolution = defaulted.resolution;
    }
    return reply.code(200).send(out);
  });

  app.post("/v1/memory/replay/playbooks/run", async (req: ReplayLearningControlRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "replay_playbook_run");
    const rateKind = resolveReplayPlaybookRunRateKind(body);
    const out = await runLearningControlRoute({
      req,
      reply,
      requestKind: "replay_playbook_run",
      rateKind,
      execute: (requestBody) => {
        const runOptions = buildReplayPlaybookRunOptions(reply, "replay_playbook_run", {
          allowSandboxExecution: requestAllowsSandboxExecution(req),
        });
        if (runOptions.writeOptions) {
          runOptions.writeOptions.writeAccess = liteWriteStore;
        }
        return executeLearningControlRead(requestBody, (resolvedBody) => replayPlaybookRun(resolvedBody, runOptions));
      },
    });
    return reply.code(200).send(out);
  });

  app.post("/v1/memory/replay/playbooks/dispatch", async (req: ReplayLearningControlRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "replay_playbook_dispatch");
    const rateKind = resolveReplayPlaybookDispatchRateKind(body);
    const out = await runLearningControlRoute({
      req,
      reply,
      requestKind: "replay_playbook_dispatch",
      rateKind,
      execute: (requestBody) => {
        const runOptions = buildReplayPlaybookRunOptions(reply, "replay_playbook_dispatch", {
          allowSandboxExecution: requestAllowsSandboxExecution(req),
        });
        if (runOptions.writeOptions) {
          runOptions.writeOptions.writeAccess = liteWriteStore;
        }
        return executeLearningControlRead(requestBody, (resolvedBody) =>
          replayPlaybookDispatch(resolvedBody, runOptions),
        );
      },
    });
    return reply.code(200).send(out);
  });
}
