import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityRequestKind } from "../app/request-guards.js";
import {
  ProductDecisionTraceRequest,
  ProductFlightRecorderRequest,
  ProductForgetRequest,
  ProductGuideRequest,
  ProductMeasureRequest,
  ProductMemoryAdmissionRequest,
  ProductObserveRequest,
  ProductSkillCandidateEnqueueRequest,
  ProductSkillCandidateListQuery,
  ProductSkillCandidateMaterializeRequest,
  ProductSkillCandidateParams,
  ProductSkillCandidateReviewRequest,
  ProductToolFeedbackRequest,
  type ProductServiceResult,
  type ProductServices,
} from "../product/product-services.js";
import {
  productFeedbackRequest,
  productLifecycleGuardKind,
  productRehydrateRequest,
} from "../product/lifecycle-service.js";
import type { AuthPrincipal } from "../util/auth.js";
import { requireAdminTokenHeader } from "../util/admin_auth.js";
import { HttpError } from "../util/http.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import type { MemoryPlanningContextService } from "./memory-context-runtime.js";

type ProductFacadeRequest = FastifyRequest<{ Body: unknown }>;
type ProductFacadeQueryRequest = FastifyRequest<{ Querystring: unknown }>;
type ProductFacadeParamsRequest = FastifyRequest<{ Params: unknown; Body: unknown }>;
type ProductGuardKind = "recall" | "write";

export type ProductFacadeArgs = {
  app: FastifyInstance;
  services: ProductServices;
  planningContextService: MemoryPlanningContextService | null;
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
  adminToken?: string;
};

function sendProductResult(reply: FastifyReply, result: ProductServiceResult): FastifyReply {
  const statusCode = result.statusCode >= 100 && result.statusCode <= 599 ? result.statusCode : 500;
  return reply.code(statusCode).send(result.body);
}

function principalActorId(principal: AuthPrincipal | null): string {
  return principal?.agent_id ?? principal?.team_id ?? "lite-local-actor";
}

function requireSkillOperator(
  req: FastifyRequest,
  principal: AuthPrincipal | null,
  adminToken: string | undefined,
): string {
  if (!principal) {
    requireAdminTokenHeader(req.headers as Record<string, unknown>, adminToken);
    return "lite-admin-token";
  }
  const role = principal.role?.trim().toLowerCase() ?? "";
  if (role !== "operator" && role !== "admin") {
    throw new HttpError(
      403,
      "skill_operator_forbidden",
      "operator or admin role is required for skill candidate review and materialization",
    );
  }
  return principalActorId(principal);
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
    planningContextService,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    adminToken,
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
    const parsed = ProductObserveRequest.parse(withIdentityFromRequest(req, req.body, principal, "write"));
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
      execute: () => services.guide.execute(parsed, {
        planningContext: async (input) => {
          if (!planningContextService) {
            throw new HttpError(
              500,
              "product_dependency_missing",
              "required product service dependency is not configured",
              { dependency: "planning_context_service" },
            );
          }
          return planningContextService.assemble(req, reply, {
            body: input,
            principal,
            principalAlreadyChecked: true,
          });
        },
        applyIdentity: (input, kind) => withIdentityFromRequest(req, input, principal, kind),
      }),
    });
  });

  app.post("/v1/memory/govern", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductMemoryAdmissionRequest.parse(withIdentityFromRequest(req, req.body, principal, "recall"));
    return guarded({ req, reply, kind: "recall", body: parsed, execute: () => services.guide.govern(parsed) });
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
    execute: () => services.lifecycle.execute(input.parsed, input.surface),
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
    if (feedbackKind === "tool_selection") {
      const parsed = ProductToolFeedbackRequest.parse(
        withIdentityFromRequest(req, req.body, principal, "tools_feedback"),
      );
      return guarded({
        req,
        reply,
        kind: "write",
        body: parsed,
        execute: () => services.toolFeedback.execute(parsed),
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

  const recallRoute = async <T>(input: {
    req: FastifyRequest;
    reply: FastifyReply;
    body: T;
    execute: () => Promise<ProductServiceResult>;
  }) => guarded({ ...input, kind: "recall" });

  app.post("/v1/debug/memory-decision-trace", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductDecisionTraceRequest.parse(withIdentityFromRequest(req, req.body, principal, "recall"));
    return recallRoute({ req, reply, body: parsed, execute: () => services.lifecycle.decisionTrace(parsed) });
  });

  app.post("/v1/audit/memory-decision-report", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductDecisionTraceRequest.parse(withIdentityFromRequest(req, req.body, principal, "recall"));
    return recallRoute({ req, reply, body: parsed, execute: () => services.lifecycle.decisionAudit(parsed) });
  });

  app.post("/v1/audit/flight-recorder", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductFlightRecorderRequest.parse(withIdentityFromRequest(req, req.body, principal, "recall"));
    return recallRoute({ req, reply, body: parsed, execute: () => services.lifecycle.flightRecorder(parsed) });
  });

  app.post("/v1/measure", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductMeasureRequest.parse(withIdentityFromRequest(req, req.body, principal, "write"));
    return guarded({
      req,
      reply,
      kind: "write",
      body: parsed,
      execute: () => services.measure.execute(parsed, { actorId: principalActorId(principal) }),
    });
  });

  app.post("/v1/skills/candidates", async (req: ProductFacadeRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductSkillCandidateEnqueueRequest.parse(withIdentityFromRequest(req, req.body, principal, "write"));
    return guarded({ req, reply, kind: "write", body: parsed, execute: () => services.measure.enqueueSkillCandidates(parsed) });
  });

  app.get("/v1/skills/candidates", async (req: ProductFacadeQueryRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const query = ProductSkillCandidateListQuery.parse(req.query ?? {});
    const parsed = ProductSkillCandidateListQuery.parse(withIdentityFromRequest(req, query, principal, "recall"));
    return recallRoute({ req, reply, body: parsed, execute: () => services.measure.listSkillCandidates(parsed) });
  });

  const reviewSkill = async (input: {
    req: ProductFacadeParamsRequest;
    reply: FastifyReply;
    reviewStatus: "promoted" | "rejected";
    route: string;
  }) => {
    const principal = await requireMemoryPrincipal(input.req);
    const reviewerId = requireSkillOperator(input.req, principal, adminToken);
    const params = ProductSkillCandidateParams.parse(input.req.params ?? {});
    const parsed = ProductSkillCandidateReviewRequest.parse(
      withIdentityFromRequest(input.req, input.req.body ?? {}, principal, "write"),
    );
    return guarded({
      req: input.req,
      reply: input.reply,
      kind: "write",
      body: parsed,
      execute: () => services.measure.reviewSkillCandidate({
        candidateId: params.id,
        input: parsed,
        reviewStatus: input.reviewStatus,
        route: input.route,
        reviewerId,
      }),
    });
  };

  app.post("/v1/skills/candidates/:id/promote", (req: ProductFacadeParamsRequest, reply) =>
    reviewSkill({ req, reply, reviewStatus: "promoted", route: "/v1/skills/candidates/:id/promote" }));
  app.post("/v1/skills/candidates/:id/reject", (req: ProductFacadeParamsRequest, reply) =>
    reviewSkill({ req, reply, reviewStatus: "rejected", route: "/v1/skills/candidates/:id/reject" }));

  app.post("/v1/skills/candidates/:id/materialize", async (req: ProductFacadeParamsRequest, reply) => {
    const principal = await requireMemoryPrincipal(req);
    const actorId = requireSkillOperator(req, principal, adminToken);
    const params = ProductSkillCandidateParams.parse(req.params ?? {});
    const parsed = ProductSkillCandidateMaterializeRequest.parse(
      withIdentityFromRequest(req, req.body ?? {}, principal, "write"),
    );
    return guarded({
      req,
      reply,
      kind: "write",
      body: parsed,
      execute: () => services.measure.materializeSkillCandidate({ candidateId: params.id, input: parsed, actorId }),
    });
  });
}
