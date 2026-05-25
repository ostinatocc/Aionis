import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ReplayPlaybookDispatchRequest, ReplayPlaybookRunRequest } from "../memory/schemas.js";
import { replayPlaybookDispatch, replayPlaybookRepairReview, replayPlaybookRun } from "../memory/replay.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type ReplayLearningControlRequest = FastifyRequest<{ Body: unknown }>;
type ReplayPlaybookReviewOptionsLike = Parameters<typeof replayPlaybookRepairReview>[2];
type ReplayPlaybookRunOptionsLike = Parameters<typeof replayPlaybookRun>[2];
type ReplayLearningControlRequestKind =
  | "replay_playbook_repair_review"
  | "replay_playbook_run"
  | "replay_playbook_dispatch";
type ReplayLearningControlRateKind = "write" | "recall";

export function registerMemoryReplayLearningControlRoutes(args: {
  app: FastifyInstance;
  env: { AIONIS_EDITION?: string };
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
  buildReplayRepairReviewOptions: () => ReplayPlaybookReviewOptionsLike;
  buildReplayPlaybookRunOptions: (reply: FastifyReply, source: string) => ReplayPlaybookRunOptionsLike;
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
  if (env?.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite memory-replay-learning-control routes only support AIONIS_EDITION=lite");
  }
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
    const executeFallback = parsed.success ? parsed.data.execute_fallback !== false : true;
    return deterministicPossible || executeFallback ? "write" : "recall";
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
        const reviewOptions = buildReplayRepairReviewOptions();
        reviewOptions.writeAccess = liteWriteStore;
        return executeLearningControlWrite(body, (requestBody) =>
          replayPlaybookRepairReview(null, requestBody, reviewOptions),
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
        const runOptions = buildReplayPlaybookRunOptions(reply, "replay_playbook_run");
        if (runOptions.writeOptions) {
          runOptions.writeOptions.writeAccess = liteWriteStore;
        }
        return executeLearningControlRead(requestBody, (resolvedBody) => replayPlaybookRun(null, resolvedBody, runOptions));
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
        const runOptions = buildReplayPlaybookRunOptions(reply, "replay_playbook_dispatch");
        if (runOptions.writeOptions) {
          runOptions.writeOptions.writeAccess = liteWriteStore;
        }
        return executeLearningControlRead(requestBody, (resolvedBody) =>
          replayPlaybookDispatch(null, resolvedBody, runOptions),
        );
      },
    });
    return reply.code(200).send(out);
  });
}
