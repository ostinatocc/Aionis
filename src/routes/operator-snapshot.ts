import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config.js";
import {
  buildAionisOperatorSnapshot,
  renderAionisOperatorSnapshotMarkdown,
} from "../memory/operator-snapshot.js";
import { resolveTenantScope } from "../memory/tenant.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type OperatorSnapshotRequest = FastifyRequest<{ Body: unknown }>;
type OperatorBrowserQueryRequest = FastifyRequest<{ Querystring: unknown }>;
type OperatorRunDetailRequest = FastifyRequest<{
  Params: { run_id: string };
  Querystring: unknown;
}>;

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

const OperatorWorkspacesQuerySchema = z
  .object({
    tenant_id: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

const OperatorRunsQuerySchema = z
  .object({
    tenant_id: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

const OperatorRunDetailQuerySchema = z
  .object({
    tenant_id: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

type ParsedGuideExposure = {
  guide_trace_id: string;
  tenant_id: string;
  scope: string;
  run_id: string | null;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  query_sha256: string | null;
  context_sha256: string | null;
  memory_ids: string[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  rehydrate_memory_ids: string[];
  prompt_char_count: number;
  history_used: boolean;
  actionable_history_used: boolean;
  recommended_posture: string | null;
  authority: string | null;
  created_at: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = stringValue(entry);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseScopeKey(scopeKey: string, defaultTenantId: string): { tenant_id: string; scope: string; scope_key: string } {
  const prefix = "tenant:";
  const marker = "::scope:";
  if (scopeKey.startsWith(prefix)) {
    const markerIndex = scopeKey.indexOf(marker, prefix.length);
    if (markerIndex > prefix.length) {
      const tenantId = scopeKey.slice(prefix.length, markerIndex);
      const scope = scopeKey.slice(markerIndex + marker.length);
      if (tenantId && scope) return { tenant_id: tenantId, scope, scope_key: scopeKey };
    }
  }
  return { tenant_id: defaultTenantId, scope: scopeKey, scope_key: scopeKey };
}

function parseGuideExposure(row: LiteFindNodeRow): ParsedGuideExposure | null {
  const record = objectValue(row.slots.guide_exposure_v1);
  if (record.contract_version !== "aionis_guide_exposure_v1") return null;
  const guideTraceId = stringValue(record.guide_trace_id);
  const tenantId = stringValue(record.tenant_id);
  const scope = stringValue(record.scope);
  if (!guideTraceId || !tenantId || !scope) return null;
  return {
    guide_trace_id: guideTraceId,
    tenant_id: tenantId,
    scope,
    run_id: stringValue(record.run_id),
    consumer_agent_id: stringValue(record.consumer_agent_id),
    consumer_team_id: stringValue(record.consumer_team_id),
    query_sha256: stringValue(record.query_sha256),
    context_sha256: stringValue(record.context_sha256),
    memory_ids: stringArrayValue(record.memory_ids),
    use_now_memory_ids: stringArrayValue(record.use_now_memory_ids),
    inspect_before_use_memory_ids: stringArrayValue(record.inspect_before_use_memory_ids),
    do_not_use_memory_ids: stringArrayValue(record.do_not_use_memory_ids),
    rehydrate_memory_ids: stringArrayValue(record.rehydrate_memory_ids),
    prompt_char_count: Math.max(0, Math.trunc(Number(record.prompt_char_count) || 0)),
    history_used: record.history_used === true,
    actionable_history_used: record.actionable_history_used === true,
    recommended_posture: stringValue(record.recommended_posture),
    authority: stringValue(record.authority),
    created_at: row.created_at,
  };
}

function addToSet(set: Set<string>, values: readonly string[]): void {
  for (const value of values) set.add(value);
}

function latestIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function summarizeOperatorRuns(args: {
  exposures: ParsedGuideExposure[];
  executionRuns: Awaited<ReturnType<LiteWriteStore["listExecutionRuns"]>>;
  limit: number;
}) {
  type RunAccumulator = {
    thread_id: string;
    run_id: string | null;
    guide_trace_ids: Set<string>;
    latest_at: string | null;
    consumer_agent_id: string | null;
    consumer_team_id: string | null;
    latest_recommended_posture: string | null;
    latest_authority: string | null;
    latest_prompt_char_count: number;
    memory_ids: Set<string>;
    use_now_memory_ids: Set<string>;
    inspect_before_use_memory_ids: Set<string>;
    do_not_use_memory_ids: Set<string>;
    rehydrate_memory_ids: Set<string>;
    history_used: boolean;
    actionable_history_used: boolean;
    decision_count: number;
    feedback_total: number;
    latest_selected_tool: string | null;
    latest_feedback_at: string | null;
  };
  const byThread = new Map<string, RunAccumulator>();
  const ensure = (threadId: string, runId: string | null): RunAccumulator => {
    const existing = byThread.get(threadId);
    if (existing) return existing;
    const created: RunAccumulator = {
      thread_id: threadId,
      run_id: runId,
      guide_trace_ids: new Set<string>(),
      latest_at: null,
      consumer_agent_id: null,
      consumer_team_id: null,
      latest_recommended_posture: null,
      latest_authority: null,
      latest_prompt_char_count: 0,
      memory_ids: new Set<string>(),
      use_now_memory_ids: new Set<string>(),
      inspect_before_use_memory_ids: new Set<string>(),
      do_not_use_memory_ids: new Set<string>(),
      rehydrate_memory_ids: new Set<string>(),
      history_used: false,
      actionable_history_used: false,
      decision_count: 0,
      feedback_total: 0,
      latest_selected_tool: null,
      latest_feedback_at: null,
    };
    byThread.set(threadId, created);
    return created;
  };

  for (const exposure of args.exposures) {
    const threadId = exposure.run_id ? `run:${exposure.run_id}` : `guide:${exposure.guide_trace_id}`;
    const item = ensure(threadId, exposure.run_id);
    item.guide_trace_ids.add(exposure.guide_trace_id);
    item.latest_at = latestIso(item.latest_at, exposure.created_at);
    item.consumer_agent_id ??= exposure.consumer_agent_id;
    item.consumer_team_id ??= exposure.consumer_team_id;
    item.history_used = item.history_used || exposure.history_used;
    item.actionable_history_used = item.actionable_history_used || exposure.actionable_history_used;
    if (item.latest_at === exposure.created_at) {
      item.latest_recommended_posture = exposure.recommended_posture;
      item.latest_authority = exposure.authority;
      item.latest_prompt_char_count = exposure.prompt_char_count;
    }
    addToSet(item.memory_ids, exposure.memory_ids);
    addToSet(item.use_now_memory_ids, exposure.use_now_memory_ids);
    addToSet(item.inspect_before_use_memory_ids, exposure.inspect_before_use_memory_ids);
    addToSet(item.do_not_use_memory_ids, exposure.do_not_use_memory_ids);
    addToSet(item.rehydrate_memory_ids, exposure.rehydrate_memory_ids);
  }

  for (const run of args.executionRuns) {
    const item = ensure(`run:${run.run_id}`, run.run_id);
    item.latest_at = latestIso(item.latest_at, run.latest_decision_at);
    item.decision_count = run.decision_count;
    item.feedback_total = run.feedback_total;
    item.latest_selected_tool = run.latest_selected_tool;
    item.latest_feedback_at = run.latest_feedback_at;
  }

  return Array.from(byThread.values())
    .sort((left, right) => (right.latest_at ?? "").localeCompare(left.latest_at ?? "") || left.thread_id.localeCompare(right.thread_id))
    .slice(0, args.limit)
    .map((item) => ({
      thread_id: item.thread_id,
      run_id: item.run_id,
      guide_trace_ids: Array.from(item.guide_trace_ids),
      latest_at: item.latest_at,
      consumer_agent_id: item.consumer_agent_id,
      consumer_team_id: item.consumer_team_id,
      memory_count: item.memory_ids.size,
      use_now_count: item.use_now_memory_ids.size,
      inspect_before_use_count: item.inspect_before_use_memory_ids.size,
      do_not_use_count: item.do_not_use_memory_ids.size,
      rehydrate_count: item.rehydrate_memory_ids.size,
      history_used: item.history_used,
      actionable_history_used: item.actionable_history_used,
      recommended_posture: item.latest_recommended_posture,
      authority: item.latest_authority,
      prompt_char_count: item.latest_prompt_char_count,
      decision_count: item.decision_count,
      feedback_total: item.feedback_total,
      latest_selected_tool: item.latest_selected_tool,
      latest_feedback_at: item.latest_feedback_at,
    }));
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

  app.get("/v1/operator/workspaces", async (req: OperatorBrowserQueryRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const query = withIdentityFromRequest(req, req.query, principal, "recall");
    const parsed = OperatorWorkspacesQuerySchema.parse(query);
    await enforceRateLimit(req, reply, "recall");
    const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
    await enforceTenantQuota(req, reply, "recall", tenantId);
    const gate = await acquireInflightSlot("recall");
    try {
      const rows = await liteWriteStore.listOperatorScopes({
        tenantId: parsed.tenant_id ? tenantId : null,
        defaultTenantId: env.MEMORY_TENANT_ID,
        limit: parsed.limit,
      });
      const workspaces = rows
        .map((row) => {
          const scopeRef = parseScopeKey(row.scope, env.MEMORY_TENANT_ID);
          return {
            tenant_id: scopeRef.tenant_id,
            scope: scopeRef.scope,
            scope_key: scopeRef.scope_key,
            memory_count: row.memory_count,
            guide_trace_count: row.guide_trace_count,
            run_count: row.run_count,
            actor_count: row.actor_count,
            latest_memory_at: row.latest_memory_at,
          };
        })
      const tenantSummaries = Array.from(
        workspaces.reduce((map, workspace) => {
          const existing = map.get(workspace.tenant_id) ?? {
            tenant_id: workspace.tenant_id,
            scope_count: 0,
            memory_count: 0,
            guide_trace_count: 0,
            run_count: 0,
            latest_memory_at: null as string | null,
          };
          existing.scope_count += 1;
          existing.memory_count += workspace.memory_count;
          existing.guide_trace_count += workspace.guide_trace_count;
          existing.run_count += workspace.run_count;
          existing.latest_memory_at = latestIso(existing.latest_memory_at, workspace.latest_memory_at);
          map.set(workspace.tenant_id, existing);
          return map;
        }, new Map<string, {
          tenant_id: string;
          scope_count: number;
          memory_count: number;
          guide_trace_count: number;
          run_count: number;
          latest_memory_at: string | null;
        }>()).values(),
      ).sort((left, right) =>
        (right.latest_memory_at ?? "").localeCompare(left.latest_memory_at ?? "")
        || left.tenant_id.localeCompare(right.tenant_id)
      );
      return reply.code(200).send({
        contract_version: "aionis_operator_workspaces_result_v1",
        tenant_id: parsed.tenant_id ? tenantId : null,
        default_tenant_id: env.MEMORY_TENANT_ID,
        tenants: tenantSummaries,
        workspaces,
        source_map: {
          routes_used: ["/v1/operator/workspaces"],
          internal_surfaces_used: ["lite_memory_nodes", "guide_exposure_ledger"],
          omitted_internal_surfaces: ["raw_slots", "raw_embedding_vectors"],
        },
      });
    } finally {
      gate.release();
    }
  });

  app.get("/v1/operator/runs", async (req: OperatorBrowserQueryRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const query = withIdentityFromRequest(req, req.query, principal, "recall");
    const parsed = OperatorRunsQuerySchema.parse(query);
    await enforceRateLimit(req, reply, "recall");
    const tenantScope = resolveTenantScope(
      { tenant_id: parsed.tenant_id, scope: parsed.scope },
      { defaultScope: env.MEMORY_SCOPE, defaultTenantId: env.MEMORY_TENANT_ID },
    );
    await enforceTenantQuota(req, reply, "recall", tenantScope.tenant_id);
    const gate = await acquireInflightSlot("recall");
    try {
      const [exposureRows, executionRuns] = await Promise.all([
        liteWriteStore.listOperatorGuideExposures({ scope: tenantScope.scope_key, limit: Math.max(parsed.limit, 250) }),
        liteWriteStore.listExecutionRuns({ scope: tenantScope.scope_key, limit: parsed.limit }),
      ]);
      const exposures = exposureRows.map(parseGuideExposure).filter((value): value is ParsedGuideExposure => value !== null);
      const runs = summarizeOperatorRuns({ exposures, executionRuns, limit: parsed.limit });
      return reply.code(200).send({
        contract_version: "aionis_operator_runs_result_v1",
        tenant_id: tenantScope.tenant_id,
        scope: tenantScope.scope,
        scope_key: tenantScope.scope_key,
        runs,
        source_map: {
          routes_used: ["/v1/operator/runs"],
          internal_surfaces_used: ["guide_exposure_ledger", "execution_decisions", "rule_feedback"],
          omitted_internal_surfaces: ["raw_slots", "raw_embedding_vectors"],
        },
      });
    } finally {
      gate.release();
    }
  });

  app.get("/v1/operator/runs/:run_id", async (req: OperatorRunDetailRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const query = withIdentityFromRequest(req, req.query, principal, "recall");
    const parsed = OperatorRunDetailQuerySchema.parse(query);
    await enforceRateLimit(req, reply, "recall");
    const tenantScope = resolveTenantScope(
      { tenant_id: parsed.tenant_id, scope: parsed.scope },
      { defaultScope: env.MEMORY_SCOPE, defaultTenantId: env.MEMORY_TENANT_ID },
    );
    await enforceTenantQuota(req, reply, "recall", tenantScope.tenant_id);
    const gate = await acquireInflightSlot("recall");
    try {
      const runId = req.params.run_id;
      const [exposureRows, decisionSummary, feedbackSummary] = await Promise.all([
        liteWriteStore.listOperatorGuideExposures({ scope: tenantScope.scope_key, runId, limit: parsed.limit }),
        liteWriteStore.listExecutionDecisionsByRun({ scope: tenantScope.scope_key, runId, limit: parsed.limit }),
        liteWriteStore.listRuleFeedbackByRun({ scope: tenantScope.scope_key, runId, limit: parsed.limit }),
      ]);
      const exposures = exposureRows.map(parseGuideExposure).filter((value): value is ParsedGuideExposure => value !== null);
      const run = summarizeOperatorRuns({
        exposures,
        executionRuns: [{
          run_id: runId,
          decision_count: decisionSummary.count,
          latest_decision_at: decisionSummary.latest_created_at ?? "",
          latest_selected_tool: decisionSummary.rows[0]?.selected_tool ?? null,
          feedback_total: feedbackSummary.total,
          latest_feedback_at: feedbackSummary.latest_feedback_at,
        }],
        limit: 1,
      })[0] ?? null;
      return reply.code(200).send({
        contract_version: "aionis_operator_run_detail_result_v1",
        tenant_id: tenantScope.tenant_id,
        scope: tenantScope.scope,
        scope_key: tenantScope.scope_key,
        run_id: runId,
        run,
        guide_traces: exposures.map((exposure) => ({
          guide_trace_id: exposure.guide_trace_id,
          run_id: exposure.run_id,
          created_at: exposure.created_at,
          consumer_agent_id: exposure.consumer_agent_id,
          consumer_team_id: exposure.consumer_team_id,
          memory_count: exposure.memory_ids.length,
          memory_ids: exposure.memory_ids,
          use_now_count: exposure.use_now_memory_ids.length,
          use_now_memory_ids: exposure.use_now_memory_ids,
          inspect_before_use_count: exposure.inspect_before_use_memory_ids.length,
          inspect_before_use_memory_ids: exposure.inspect_before_use_memory_ids,
          do_not_use_count: exposure.do_not_use_memory_ids.length,
          do_not_use_memory_ids: exposure.do_not_use_memory_ids,
          rehydrate_count: exposure.rehydrate_memory_ids.length,
          rehydrate_memory_ids: exposure.rehydrate_memory_ids,
          prompt_char_count: exposure.prompt_char_count,
          history_used: exposure.history_used,
          actionable_history_used: exposure.actionable_history_used,
          recommended_posture: exposure.recommended_posture,
          authority: exposure.authority,
          query_sha256: exposure.query_sha256,
          context_sha256: exposure.context_sha256,
        })),
        decisions: decisionSummary,
        feedback: feedbackSummary,
        source_map: {
          routes_used: ["/v1/operator/runs/:run_id"],
          internal_surfaces_used: ["guide_exposure_ledger", "execution_decisions", "rule_feedback"],
          omitted_internal_surfaces: ["raw_slots", "raw_embedding_vectors"],
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
