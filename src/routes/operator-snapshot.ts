import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config.js";
import {
  buildAionisOperatorSnapshot,
  renderAionisOperatorSnapshotMarkdown,
} from "../memory/operator-snapshot.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type OperatorSnapshotRequest = FastifyRequest<{ Body: unknown }>;

type OperatorSnapshotRouteArgs = {
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

const SourceMapSchema = z
  .object({
    routes_used: z.array(z.string().trim().min(1)).max(128).optional(),
    internal_surfaces_used: z.array(z.string().trim().min(1)).max(128).optional(),
    omitted_internal_surfaces: z.array(z.string().trim().min(1)).max(128).optional(),
  })
  .strict();

const OperatorSnapshotRequestSchema = z
  .object({
    tenant_id: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    run_id: z.string().trim().min(1).optional(),
    task_signature: z.string().trim().min(1).optional(),
    task_family: z.string().trim().min(1).optional(),
    workflow_signature: z.string().trim().min(1).optional(),
    agent_context: z.unknown().optional(),
    guide_packet: z.unknown().optional(),
    memory_decision_trace: z.unknown().optional(),
    memory_decision_audit: z.unknown().optional(),
    effect_report: z.unknown().optional(),
    claim_ledger_projection: z.unknown().optional(),
    execution_context: z.unknown().optional(),
    guide_trace_id: z.string().trim().min(1).optional(),
    include_markdown: z.boolean().optional(),
    source_map: SourceMapSchema.optional(),
  })
  .strict();

export function registerOperatorSnapshotRoutes(args: OperatorSnapshotRouteArgs) {
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

  app.post("/v1/operator/snapshot", async (req: OperatorSnapshotRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = OperatorSnapshotRequestSchema.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
      const scope = parsed.scope ?? env.MEMORY_SCOPE;
      const snapshot = buildAionisOperatorSnapshot({
        tenant_id: tenantId,
        scope,
        run_id: parsed.run_id ?? null,
        task_signature: parsed.task_signature ?? null,
        task_family: parsed.task_family ?? null,
        workflow_signature: parsed.workflow_signature ?? null,
        agent_context: parsed.agent_context,
        guide_packet: parsed.guide_packet,
        memory_decision_trace: parsed.memory_decision_trace,
        memory_decision_audit: parsed.memory_decision_audit,
        effect_report: parsed.effect_report,
        claim_ledger_projection: parsed.claim_ledger_projection,
        execution_context: parsed.execution_context,
        guide_trace_id: parsed.guide_trace_id ?? null,
        source_map: {
          routes_used: [
            ...(parsed.source_map?.routes_used ?? []),
            "/v1/operator/snapshot",
          ],
          internal_surfaces_used: parsed.source_map?.internal_surfaces_used ?? [],
          omitted_internal_surfaces: parsed.source_map?.omitted_internal_surfaces ?? [],
        },
      });

      return reply.code(200).send({
        contract_version: "aionis_operator_snapshot_result_v1",
        tenant_id: tenantId,
        scope,
        operator_snapshot: snapshot,
        ...(parsed.include_markdown === true
          ? { markdown: renderAionisOperatorSnapshotMarkdown(snapshot) }
          : {}),
        source_map: {
          routes_used: ["/v1/operator/snapshot"],
          internal_surfaces_used: [
            "operator_snapshot_contract",
            "memory_use_receipt",
            "memory_admission_record",
            "trace_to_procedure_projection",
            ...(parsed.claim_ledger_projection ? ["claim_ledger_projection"] : []),
            "operator_snapshot_markdown_renderer",
          ],
          omitted_internal_surfaces: [
            "raw_memory_rows",
            "raw_slots",
            "raw_embedding_vectors",
          ],
        },
      });
    } finally {
      gate.release();
    }
  });
}
