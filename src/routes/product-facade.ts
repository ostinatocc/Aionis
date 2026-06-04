import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config.js";
import {
  evaluateAionisEffect,
  type AionisEffectObservation,
} from "../kernel/effect-evaluator.js";
import { buildAionisEffectReport } from "../memory/product-output-assembler.js";
import { AionisEffectReportSchema } from "../memory/product-output-contract.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type ProductFacadeRequest = FastifyRequest<{ Body: unknown }>;

type ProductFacadeArgs = {
  app: FastifyInstance;
  env: Env;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: "recall",
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "recall") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "recall", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "recall") => Promise<InflightGateToken>;
};

const LooseObject = z.record(z.unknown());
const StringList = z.array(z.string().trim().min(1)).max(256).default([]);

const ProductObserveRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  input_text: z.string().trim().min(1).optional(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  model_version: z.string().trim().min(1).optional(),
  prompt_version: z.string().trim().min(1).optional(),
  auto_embed: z.boolean().optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().trim().min(1).optional(),
  owner_agent_id: z.string().trim().min(1).optional(),
  owner_team_id: z.string().trim().min(1).optional(),
  force_reembed: z.boolean().optional(),
  trigger_topic_cluster: z.boolean().optional(),
  topic_cluster_async: z.boolean().optional(),
  distill: LooseObject.optional(),
  nodes: z.array(LooseObject).optional(),
  edges: z.array(LooseObject).optional(),
  memory: LooseObject.optional(),
  handoff: LooseObject.optional(),
}).strict();

const ProductGuideRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  query_text: z.string().trim().min(1),
  context: z.unknown().optional(),
  run_id: z.string().trim().min(1).optional(),
  consumer_agent_id: z.string().trim().min(1).optional(),
  consumer_team_id: z.string().trim().min(1).optional(),
  tool_candidates: StringList.optional(),
  limit: z.number().int().positive().max(200).optional(),
  context_token_budget: z.number().int().positive().max(256000).optional(),
  context_char_budget: z.number().int().positive().max(1000000).optional(),
  context_compaction_profile: z.enum(["balanced", "aggressive"]).optional(),
  context_optimization_profile: z.enum(["balanced", "aggressive"]).optional(),
  memory_layer_preference: z.unknown().optional(),
  execution_state_v1: z.unknown().optional(),
  execution_packet_v1: z.unknown().optional(),
  edit_boundary_context: z.unknown().optional(),
  runtime_verification: z.unknown().optional(),
  trajectory: z.unknown().optional(),
  trajectory_hints: z.unknown().optional(),
}).strict();

const ProductForgetRequest = z.object({
  operation: z.enum([
    "rehydrate_archive",
    "activate",
    "suppress_pattern",
    "unsuppress_pattern",
    "rehydrate_payload",
  ]),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  payload: LooseObject.optional(),
}).catchall(z.unknown());

const EffectObservationSchema = z.object({
  label: z.string().trim().min(1).optional(),
  continuity: z.object({
    repeatedDiscoverySteps: z.number().nonnegative().optional(),
    firstActionCorrect: z.boolean().optional(),
    recoveredStateFacts: z.number().nonnegative().optional(),
    expectedStateFacts: z.number().nonnegative().optional(),
    verifiedFactsCarried: z.number().nonnegative().optional(),
    verifiedFactsExpected: z.number().nonnegative().optional(),
  }).strict().optional(),
  learning: z.object({
    workflowReused: z.boolean().optional(),
    stableWorkflowReused: z.boolean().optional(),
    provisionalMemoriesWritten: z.number().nonnegative().optional(),
    trustedPromotions: z.number().nonnegative().optional(),
    weakEvidencePromoted: z.number().nonnegative().optional(),
    counterEvidenceDemotions: z.number().nonnegative().optional(),
  }).strict().optional(),
  forgetting: z.object({
    contextItems: z.number().nonnegative().optional(),
    usefulContextItems: z.number().nonnegative().optional(),
    staleMemorySurfaced: z.number().nonnegative().optional(),
    staleMemorySuppressed: z.number().nonnegative().optional(),
    archivedMemoryRehydratedOnDemand: z.number().nonnegative().optional(),
    unnecessaryRehydrations: z.number().nonnegative().optional(),
  }).strict().optional(),
  learning_control: z.object({
    weakEvidenceBlocked: z.number().nonnegative().optional(),
    authorityRequiresEvidence: z.boolean().optional(),
    blockedAuthorityVisible: z.boolean().optional(),
    unverifiedAuthorityApplied: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();

const ProductMeasureRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  task: z.object({
    task_id: z.string().trim().min(1).nullable().optional(),
    run_id: z.string().trim().min(1).nullable().optional(),
    task_signature: z.string().trim().min(1).nullable().optional(),
    task_family: z.string().trim().min(1).nullable().optional(),
  }).strict().optional(),
  baseline: EffectObservationSchema,
  aionis: EffectObservationSchema,
  minEffectDelta: z.number().optional(),
  minAionisScore: z.number().optional(),
  comparison: z.object({
    mode: z.enum(["baseline_vs_aionis", "observe_only_vs_active", "single_run_history_impact"]).optional(),
    baseline_run_id: z.string().trim().min(1).nullable().optional(),
    aionis_run_id: z.string().trim().min(1).nullable().optional(),
    sufficient_evidence: z.boolean().optional(),
  }).strict().optional(),
  evidence_ids: StringList.optional(),
}).strict();

type InternalDispatchResult =
  | { ok: true; statusCode: number; body: unknown }
  | { ok: false; statusCode: number; body: unknown };

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parsePayload(payload: string): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return {
      error: "invalid_internal_json",
      payload,
    };
  }
}

function forwardedHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["authorization", "x-api-key", "x-admin-token", "x-tenant-id"]) {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim().length > 0) out[name] = value;
  }
  return out;
}

async function dispatchProductInternalRoute(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  path: string;
  payload: unknown;
}): Promise<InternalDispatchResult> {
  const response = await args.app.inject({
    method: "POST",
    url: args.path,
    headers: forwardedHeaders(args.req),
    payload: args.payload as Record<string, unknown>,
  } as any) as { statusCode: number; payload: string };
  const body = parsePayload(response.payload);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return { ok: true, statusCode: response.statusCode, body };
  }
  return { ok: false, statusCode: response.statusCode, body };
}

function sendInternalFailure(reply: FastifyReply, result: InternalDispatchResult): FastifyReply {
  return reply.code(result.statusCode).send(result.body);
}

function mergeProductScope(parsed: {
  tenant_id?: string;
  scope?: string;
  actor?: string;
}, payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return stripUndefined({
    tenant_id: parsed.tenant_id,
    scope: parsed.scope,
    actor: parsed.actor,
    ...(payload ?? {}),
  });
}

function observeWritePayload(parsed: z.infer<typeof ProductObserveRequest>): Record<string, unknown> | null {
  const hasInlineWrite =
    !!parsed.input_text
    || !!parsed.input_sha256
    || (Array.isArray(parsed.nodes) && parsed.nodes.length > 0)
    || (Array.isArray(parsed.edges) && parsed.edges.length > 0);
  if (!parsed.memory && !hasInlineWrite) return null;
  return mergeProductScope(parsed, {
    input_text: parsed.input_text,
    input_sha256: parsed.input_sha256,
    model_version: parsed.model_version,
    prompt_version: parsed.prompt_version,
    auto_embed: parsed.auto_embed,
    memory_lane: parsed.memory_lane,
    producer_agent_id: parsed.producer_agent_id,
    owner_agent_id: parsed.owner_agent_id,
    owner_team_id: parsed.owner_team_id,
    force_reembed: parsed.force_reembed,
    trigger_topic_cluster: parsed.trigger_topic_cluster,
    topic_cluster_async: parsed.topic_cluster_async,
    distill: parsed.distill,
    nodes: parsed.nodes,
    edges: parsed.edges,
    ...(parsed.memory ?? {}),
  });
}

function forgetRouteFor(operation: z.infer<typeof ProductForgetRequest>["operation"]): string {
  if (operation === "rehydrate_archive") return "/v1/memory/archive/rehydrate";
  if (operation === "activate") return "/v1/memory/nodes/activate";
  if (operation === "suppress_pattern") return "/v1/memory/patterns/suppress";
  if (operation === "unsuppress_pattern") return "/v1/memory/patterns/unsuppress";
  return "/v1/memory/anchors/rehydrate_payload";
}

export function registerProductFacadeRoutes(args: ProductFacadeArgs) {
  const {
    app,
    env,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite product facade routes only support AIONIS_EDITION=lite");
  }

  app.post("/v1/observe", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const parsed = ProductObserveRequest.parse(req.body);
    const writePayload = observeWritePayload(parsed);
    const handoffPayload = parsed.handoff ? mergeProductScope(parsed, parsed.handoff) : null;
    if (!writePayload && !handoffPayload) {
      return reply.code(400).send({
        error: "observe_requires_memory_or_handoff",
        message: "observe requires memory input or handoff payload",
      });
    }

    const routesUsed: string[] = [];
    const write = writePayload
      ? await dispatchProductInternalRoute({ app, req, path: "/v1/memory/write", payload: writePayload })
      : null;
    if (write && !write.ok) return sendInternalFailure(reply, write);
    if (write) routesUsed.push("/v1/memory/write");

    const handoff = handoffPayload
      ? await dispatchProductInternalRoute({ app, req, path: "/v1/handoff/store", payload: handoffPayload })
      : null;
    if (handoff && !handoff.ok) return sendInternalFailure(reply, handoff);
    if (handoff) routesUsed.push("/v1/handoff/store");

    return reply.code(200).send({
      contract_version: "aionis_observe_result_v1",
      tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: parsed.scope ?? env.MEMORY_SCOPE,
      observed: {
        memory_written: !!write,
        handoff_stored: !!handoff,
      },
      memory_write: write?.body ?? null,
      handoff: handoff?.body ?? null,
      source_map: {
        routes_used: routesUsed,
        internal_surfaces_used: ["memory_write", "handoff_store"],
      },
    });
  });

  app.post("/v1/guide", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const parsed = ProductGuideRequest.parse(req.body);
    const payload = {
      ...parsed,
      context: parsed.context ?? {},
    };
    const guide = await dispatchProductInternalRoute({
      app,
      req,
      path: "/v1/memory/planning/context",
      payload,
    });
    if (!guide.ok) return sendInternalFailure(reply, guide);
    const body = guide.body && typeof guide.body === "object" && !Array.isArray(guide.body)
      ? guide.body as Record<string, unknown>
      : {};
    const recall = body.recall && typeof body.recall === "object" && !Array.isArray(body.recall)
      ? body.recall as Record<string, unknown>
      : {};

    return reply.code(200).send({
      contract_version: "aionis_guide_result_v1",
      tenant_id: body.tenant_id ?? parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: body.scope ?? parsed.scope ?? env.MEMORY_SCOPE,
      memory_packet: recall.aionis_memory_packet ?? null,
      guide_packet: body.aionis_guide_packet ?? null,
      learning_packet: body.aionis_learning_packet ?? null,
      runtime_context_packet: body.runtime_context_packet ?? null,
      kickoff_recommendation: body.kickoff_recommendation ?? null,
      cost_signals: body.cost_signals ?? null,
      source_map: {
        routes_used: ["/v1/memory/planning/context"],
        internal_surfaces_used: ["recall", "planning_summary", "product_packets"],
      },
    });
  });

  app.post("/v1/forget", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const parsed = ProductForgetRequest.parse(req.body);
    const route = forgetRouteFor(parsed.operation);
    const { operation: _operation, payload, ...rest } = parsed;
    const forgetPayload = mergeProductScope(parsed, {
      ...rest,
      ...(payload ?? {}),
    });
    const result = await dispatchProductInternalRoute({
      app,
      req,
      path: route,
      payload: forgetPayload,
    });
    if (!result.ok) return sendInternalFailure(reply, result);

    return reply.code(200).send({
      contract_version: "aionis_forget_result_v1",
      tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: parsed.scope ?? env.MEMORY_SCOPE,
      operation: parsed.operation,
      result: result.body,
      source_map: {
        routes_used: [route],
        internal_surfaces_used: ["memory_lifecycle", "learning_control"],
      },
    });
  });

  app.post("/v1/measure", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductMeasureRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const kernelReport = evaluateAionisEffect({
        baseline: parsed.baseline as AionisEffectObservation,
        aionis: parsed.aionis as AionisEffectObservation,
        minEffectDelta: parsed.minEffectDelta,
        minAionisScore: parsed.minAionisScore,
      });
      const effectReport = buildAionisEffectReport({
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        task: parsed.task,
        report: kernelReport,
        comparison: parsed.comparison,
        evidence_ids: parsed.evidence_ids,
      });
      return reply.code(200).send({
        contract_version: "aionis_measure_result_v1",
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        effect_report: AionisEffectReportSchema.parse(effectReport),
        kernel_report: kernelReport,
        source_map: {
          routes_used: ["/v1/measure"],
          internal_surfaces_used: ["effect_evaluator", "product_effect_report"],
        },
      });
    } finally {
      gate.release();
    }
  });
}
