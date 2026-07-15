import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config.js";
import {
  buildAionisOperatorSnapshot,
  renderAionisOperatorSnapshotMarkdown,
} from "../memory/product-output/operator-projections.js";
import {
  RUNTIME_AUTHORITY_EFFECT_KINDS,
  type RuntimeAuthorityEffectAuditV1,
  type RuntimeAuthorityEffectKind,
} from "../memory/authority-effect-broker.js";
import { resolveTenantScope } from "../memory/tenant.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type OperatorSnapshotRequest = FastifyRequest<{ Body: unknown }>;
type OperatorAuthorityEffectAuditRequest = FastifyRequest<{ Querystring: unknown }>;

type OperatorSnapshotRouteArgs = {
  app: FastifyInstance;
  env: Env;
  liteWriteStore: LiteWriteStore;
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

const OperatorAuthorityEffectAuditQuerySchema = z
  .object({
    tenant_id: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    memory_id: z.string().trim().min(1).optional(),
    effect_kind: z.enum(RUNTIME_AUTHORITY_EFFECT_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

function isRuntimeAuthorityEffectAudit(value: unknown): value is RuntimeAuthorityEffectAuditV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const node = record.node && typeof record.node === "object" && !Array.isArray(record.node)
    ? record.node as Record<string, unknown>
    : null;
  const receipt = record.receipt && typeof record.receipt === "object" && !Array.isArray(record.receipt)
    ? record.receipt as Record<string, unknown>
    : null;
  const gate = record.gate && typeof record.gate === "object" && !Array.isArray(record.gate)
    ? record.gate as Record<string, unknown>
    : null;
  return record.audit_version === "runtime_authority_effect_audit_v1"
    && record.broker === "authority_effect_broker"
    && typeof record.effect_kind === "string"
    && (RUNTIME_AUTHORITY_EFFECT_KINDS as readonly string[]).includes(record.effect_kind)
    && Array.isArray(record.claim_paths)
    && record.claim_paths.every((entry) => typeof entry === "string")
    && !!node
    && typeof node.scope === "string"
    && typeof node.node_id === "string"
    && (typeof node.client_id === "string" || node.client_id === null)
    && typeof node.node_type === "string"
    && !!receipt
    && receipt.receipt_version === "runtime_authority_receipt_v1"
    && typeof receipt.key_id === "string"
    && typeof receipt.gate_sha256 === "string"
    && typeof receipt.issued_at === "string"
    && !!gate
    && (gate.status === "sufficient" || gate.status === "insufficient")
    && typeof gate.allows_authoritative === "boolean"
    && typeof gate.allows_stable_promotion === "boolean"
    && (typeof gate.requested_trust === "string" || gate.requested_trust === null)
    && (typeof gate.effective_trust === "string" || gate.effective_trust === null)
    && Array.isArray(gate.reasons)
    && gate.reasons.every((entry) => typeof entry === "string");
}

function summarizeAuthorityEffectAuditRow(row: LiteFindNodeRow) {
  const audit = row.slots.authority_effect_audit_v1;
  if (!isRuntimeAuthorityEffectAudit(audit)) return null;
  return {
    memory_id: row.id,
    memory_client_id: row.client_id,
    memory_type: row.type,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    effect_kind: audit.effect_kind,
    node: audit.node,
    claim_paths: [...audit.claim_paths],
    receipt: { ...audit.receipt },
    gate: {
      ...audit.gate,
      reasons: audit.gate.reasons.slice(0, 16),
    },
  };
}

function summarizeAuthorityEffectAudits(
  entries: Array<NonNullable<ReturnType<typeof summarizeAuthorityEffectAuditRow>>>,
) {
  const byEffectKind = new Map<RuntimeAuthorityEffectKind, number>();
  const byKeyId = new Map<string, number>();
  let authoritativeAllowedCount = 0;
  let stablePromotionAllowedCount = 0;
  for (const entry of entries) {
    byEffectKind.set(entry.effect_kind, (byEffectKind.get(entry.effect_kind) ?? 0) + 1);
    byKeyId.set(entry.receipt.key_id, (byKeyId.get(entry.receipt.key_id) ?? 0) + 1);
    if (entry.gate.allows_authoritative) authoritativeAllowedCount += 1;
    if (entry.gate.allows_stable_promotion) stablePromotionAllowedCount += 1;
  }
  return {
    returned_count: entries.length,
    authoritative_allowed_count: authoritativeAllowedCount,
    stable_promotion_allowed_count: stablePromotionAllowedCount,
    by_effect_kind: Object.fromEntries([...byEffectKind.entries()].sort(([a], [b]) => a.localeCompare(b))),
    by_key_id: Object.fromEntries([...byKeyId.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function registerOperatorSnapshotRoutes(args: OperatorSnapshotRouteArgs) {
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
  } = args;

  app.get("/v1/operator/authority-effect-audit", async (req: OperatorAuthorityEffectAuditRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const query = withIdentityFromRequest(req, req.query, principal, "recall");
    const parsed = OperatorAuthorityEffectAuditQuerySchema.parse(query);
    await enforceRateLimit(req, reply, "recall");
    const tenantScope = resolveTenantScope(
      { tenant_id: parsed.tenant_id, scope: parsed.scope },
      { defaultScope: env.MEMORY_SCOPE, defaultTenantId: env.MEMORY_TENANT_ID },
    );
    await enforceTenantQuota(req, reply, "recall", tenantScope.tenant_id);
    const gate = await acquireInflightSlot("recall");
    try {
      const { rows, has_more } = await liteWriteStore.findNodes({
        scope: tenantScope.scope_key,
        id: parsed.memory_id ?? undefined,
        slotsContains: {
          authority_effect_audit_v1: {
            ...(parsed.effect_kind ? { effect_kind: parsed.effect_kind } : {}),
          },
        },
        operatorView: true,
        limit: parsed.limit,
        offset: parsed.offset,
      });
      const entries = rows
        .map(summarizeAuthorityEffectAuditRow)
        .filter((entry): entry is NonNullable<ReturnType<typeof summarizeAuthorityEffectAuditRow>> => !!entry);
      return reply.code(200).send({
        contract_version: "aionis_authority_effect_audit_result_v1",
        surface_semantics: {
          read_only: true,
          persistence_effect: "none",
          authority_effect: "none",
          runtime_decision_effect: "none",
          intended_use: "operator_debug_authority_effect_audit",
        },
        tenant_id: tenantScope.tenant_id,
        scope: tenantScope.scope,
        scope_key: tenantScope.scope_key,
        filters: {
          memory_id: parsed.memory_id ?? null,
          effect_kind: parsed.effect_kind ?? null,
          limit: parsed.limit,
          offset: parsed.offset,
        },
        summary: {
          ...summarizeAuthorityEffectAudits(entries),
          has_more,
        },
        entries,
        source_map: {
          routes_used: ["/v1/operator/authority-effect-audit"],
          internal_surfaces_used: ["lite_memory_nodes.authority_effect_audit_v1"],
          omitted_internal_surfaces: [
            "raw_slots",
            "raw_embedding_vectors",
            "authority_receipt_signature",
            "authority_hmac_secret",
          ],
        },
      });
    } finally {
      gate.release();
    }
  });

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
