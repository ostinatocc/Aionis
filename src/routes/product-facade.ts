import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityRequestKind } from "../app/request-guards.js";
import {
  ProductExecutionEpisodeOutcomeRequest,
  ProductForgetRequest,
  ProductGuideRequest,
  ProductObserveRouteRequest,
  type ProductServiceResult,
  type ProductServices,
} from "../product/product-services.js";
import {
  productFeedbackRequest,
  productLifecycleGuardKind,
  productRehydrateRequest,
} from "../product/lifecycle-service.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type ProductFacadeRequest = FastifyRequest<{ Body: unknown }>;
type ProductGuardKind = "recall" | "write";

export type ProductFacadeArgs = {
  app: FastifyInstance;
  services: ProductServices;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: IdentityRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: ProductGuardKind) => Promise<void>;
  enforceTenantQuota: (
    req: FastifyRequest,
    reply: FastifyReply,
    kind: ProductGuardKind,
    tenantId: string,
  ) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: ProductGuardKind) => Promise<InflightGateToken>;
};

function sendProductResult(reply: FastifyReply, result: ProductServiceResult): FastifyReply {
  const statusCode = result.statusCode >= 100 && result.statusCode <= 599 ? result.statusCode : 500;
  return reply.code(statusCode).send(result.body);
}

async function runGuarded(args: {
  req: FastifyRequest;
  reply: FastifyReply;
  kind: ProductGuardKind;
  tenantId: string;
  inflightFirst?: boolean;
  enforceRateLimit: ProductFacadeArgs["enforceRateLimit"];
  enforceTenantQuota: ProductFacadeArgs["enforceTenantQuota"];
  acquireInflightSlot: ProductFacadeArgs["acquireInflightSlot"];
  execute: () => Promise<ProductServiceResult>;
}): Promise<FastifyReply> {
  let gate: InflightGateToken | null = args.inflightFirst
    ? await args.acquireInflightSlot(args.kind)
    : null;
  try {
    await args.enforceRateLimit(args.req, args.reply, args.kind);
    await args.enforceTenantQuota(args.req, args.reply, args.kind, args.tenantId);
    gate ??= await args.acquireInflightSlot(args.kind);
    return sendProductResult(args.reply, await args.execute());
  } finally {
    gate?.release();
  }
}

export function registerProductFacadeRoutes(args: ProductFacadeArgs): void {
  const {
    app,
    services,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

  const guarded = (input: {
    req: FastifyRequest;
    reply: FastifyReply;
    kind: ProductGuardKind;
    body: unknown;
    inflightFirst?: boolean;
    execute: () => Promise<ProductServiceResult>;
  }) => runGuarded({
    ...input,
    tenantId: tenantFromBody(input.body),
    enforceRateLimit,
    enforceTenantQuota,
    acquireInflightSlot,
  });

  app.post("/v1/observe", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const executionProtocol =
      req.body !== null
      && typeof req.body === "object"
      && !Array.isArray(req.body)
      && (
        (req.body as Record<string, unknown>).observation_kind
          === "execution_episode"
        || (req.body as Record<string, unknown>).observation_kind
          === "execution_session"
      );
    const parsed = ProductObserveRouteRequest.parse(withIdentityFromRequest(
      req,
      req.body,
      principal,
      executionProtocol ? "execution_episode" : "write",
    ));
    if (
      "observation_kind" in parsed
      && parsed.observation_kind === "execution_session"
    ) {
      return guarded({
        req,
        reply,
        kind: "write",
        body: parsed,
        execute: () => services.executionSession.observe(parsed),
      });
    }
    if (
      "observation_kind" in parsed
      && parsed.observation_kind === "execution_episode"
    ) {
      return guarded({
        req,
        reply,
        kind: "write",
        body: parsed,
        execute: () => services.executionEpisode.observe(parsed),
      });
    }
    return guarded({
      req,
      reply,
      kind: "write",
      body: parsed,
      inflightFirst: services.observe.guardOrder(parsed) === "inflight_first",
      execute: () => services.observe.execute(parsed, { principal }),
    });
  });

  app.post("/v1/guide", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductGuideRequest.parse(withIdentityFromRequest(req, req.body, principal, "product_guide"));
    return guarded({
      req,
      reply,
      kind: "write",
      body: parsed,
      execute: () => services.guide.execute(parsed),
    });
  });

  const lifecycle = async (input: {
    req: ProductFacadeRequest;
    reply: FastifyReply;
    principal: AuthPrincipal | null;
    parsed: ReturnType<typeof ProductForgetRequest.parse>;
    surface: "forget" | "feedback" | "rehydrate";
  }) => guarded({
    req: input.req,
    reply: input.reply,
    kind: productLifecycleGuardKind(input.parsed),
    body: input.parsed,
    execute: () => services.lifecycle.execute(input.parsed, input.surface, { principal: input.principal }),
  });

  app.post("/v1/forget", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const operation = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).operation
      : null;
    const parsed = ProductForgetRequest.parse(withIdentityFromRequest(
      req,
      req.body,
      principal,
      operation === "activate" ? "feedback" : "anchors_suppress",
    ));
    return lifecycle({ req, reply, principal, parsed, surface: "forget" });
  });

  app.post("/v1/feedback", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const feedbackKind = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).feedback_kind
      : null;
    if (feedbackKind === "episode_outcome") {
      const parsed = ProductExecutionEpisodeOutcomeRequest.parse(
        withIdentityFromRequest(
          req,
          req.body,
          principal,
          "execution_episode",
        ),
      );
      return guarded({
        req,
        reply,
        kind: "write",
        body: parsed,
        execute: () => services.executionEpisode.outcome(parsed),
      });
    }
    const body = withIdentityFromRequest(req, req.body, principal, "feedback");
    return lifecycle({ req, reply, principal, parsed: productFeedbackRequest(body), surface: "feedback" });
  });

  app.post("/v1/rehydrate", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "rehydrate_payload");
    return lifecycle({ req, reply, principal, parsed: productRehydrateRequest(body), surface: "rehydrate" });
  });

}
