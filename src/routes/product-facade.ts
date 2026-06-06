import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config.js";
import {
  evaluateAionisEffect,
  type AionisEffectObservation,
} from "../kernel/effect-evaluator.js";
import {
  buildAionisAgentContext,
  buildAionisEffectReport,
  buildAionisMemoryDecisionAuditReport,
  buildAionisMemoryDecisionTrace,
} from "../memory/product-output-assembler.js";
import {
  AionisAgentContextSchema,
  AionisEffectReportSchema,
  AionisGuidePacketSchema,
  AionisMemoryPacketSchema,
  type AionisAgentContext,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisGuidePacket,
  type AionisMemoryPacket,
} from "../memory/product-output-contract.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import {
  structureProductObserveMemoryInput,
  type ProductObserveStructuringSummary,
} from "./product-observe-structuring.js";

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
  memory_kind: z.enum(["general_memory", "execution_workflow"]).optional(),
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
  execution: z.object({
    client_id: z.string().trim().min(1).optional(),
    run_id: z.string().trim().min(1).optional(),
    task_id: z.string().trim().min(1).optional(),
    task_family: z.string().trim().min(1).optional(),
    task_signature: z.string().trim().min(1).optional(),
    workflow_signature: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1).optional(),
    outcome: z.enum(["succeeded", "failed", "blocked", "interrupted", "unknown"]).optional(),
    workflow_steps: StringList.optional(),
    steps: StringList.optional(),
    target_files: StringList.optional(),
    files: StringList.optional(),
    tool_set: StringList.optional(),
    tools: StringList.optional(),
    acceptance_checks: StringList.optional(),
    verifier: StringList.optional(),
    continuation_hint: z.string().trim().min(1).optional(),
    resume_hint: z.string().trim().min(1).optional(),
    reuse_hint: z.string().trim().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence_ref: z.string().trim().min(1).optional(),
    raw_ref: z.string().trim().min(1).optional(),
    evidence: z.array(LooseObject).max(64).optional(),
    artifacts: z.array(LooseObject).max(64).optional(),
    verification: LooseObject.optional(),
    slots: LooseObject.optional(),
  }).strict().optional(),
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
  include_packets: z.boolean().optional(),
}).strict();

const ProductForgetRequest = z.object({
  operation: z.enum(["suppress", "unsuppress", "rehydrate", "activate"]),
  target: z.enum(["pattern", "archive", "payload", "memory"]).optional(),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
  memory_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  node_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  client_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  anchor_id: z.string().trim().min(1).optional(),
  anchor_uri: z.string().trim().min(1).optional(),
  target_tier: z.enum(["warm", "hot"]).optional(),
  outcome: z.enum(["positive", "negative", "neutral"]).optional(),
  activate: z.boolean().optional(),
  run_id: z.string().trim().min(1).optional(),
  mode: z.enum(["shadow_learn", "hard_freeze", "summary_only", "partial", "full", "differential"]).optional(),
  until: z.string().datetime().optional(),
  include_linked_decisions: z.boolean().optional(),
  payload: LooseObject.optional(),
}).strict().superRefine((value, ctx) => {
  const memoryIdCount = (value.memory_ids?.length ?? 0) + (value.node_ids?.length ?? 0) + (value.client_ids?.length ?? 0);
  const payloadAnchorId = typeof value.payload?.anchor_id === "string" && value.payload.anchor_id.trim().length > 0;
  const payloadAnchorUri = typeof value.payload?.anchor_uri === "string" && value.payload.anchor_uri.trim().length > 0;
  const anchorPresent = !!value.anchor_id || !!value.anchor_uri || payloadAnchorId || payloadAnchorUri;
  if ((value.operation === "suppress" || value.operation === "unsuppress") && !value.anchor_id && !payloadAnchorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anchor_id"],
      message: "suppress and unsuppress require anchor_id",
    });
  }
  if (value.operation === "activate" && memoryIdCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_ids"],
      message: "activate requires memory_ids, node_ids, or client_ids",
    });
  }
  if (value.operation === "activate" && !value.run_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_id"],
      message: "activate requires run_id so feedback can be attributed to a real run",
    });
  }
  if (value.operation === "activate" && !value.outcome) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "activate requires outcome so memory feedback is not lost as neutral default",
    });
  }
  if (value.operation === "rehydrate" && memoryIdCount === 0 && !anchorPresent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_ids"],
      message: "rehydrate requires memory_ids, node_ids, client_ids, anchor_id, or anchor_uri",
    });
  }
});

const EffectObservationSchema = z.object({
  label: z.string().trim().min(1).optional(),
  continuity: z.object({
    repeatedDiscoverySteps: z.number().nonnegative().optional(),
    continuityGuidanceCorrect: z.boolean().optional(),
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

const ProductMeasureGuideSnapshotSchema = z.object({
  memory_packet: AionisMemoryPacketSchema.nullable().optional(),
  guide_packet: AionisGuidePacketSchema.nullable().optional(),
  agent_context: AionisAgentContextSchema.nullable().optional(),
  repeated_discovery_steps: z.number().nonnegative().optional(),
  context_items: z.number().nonnegative().optional(),
  useful_context_items: z.number().nonnegative().optional(),
  expected_state_facts: z.number().nonnegative().optional(),
  verified_facts_expected: z.number().nonnegative().optional(),
}).passthrough();

const ProductMeasureForgetSnapshotSchema = z.object({
  operation: z.enum(["suppress", "unsuppress", "rehydrate", "activate"]).optional(),
  target: z.enum(["pattern", "archive", "payload", "memory"]).optional(),
  forget_effect: z.object({
    action: z.enum(["suppress", "unsuppress", "rehydrate", "activate"]).optional(),
    target: z.enum(["pattern", "archive", "payload", "memory"]).optional(),
    changed_count: z.number().nonnegative().optional(),
    affected_memory_ids: StringList.optional(),
    affected_client_ids: StringList.optional(),
    anchor_id: z.string().trim().min(1).nullable().optional(),
    anchor_uri: z.string().trim().min(1).nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const ProductDecisionTraceBaseSchema = z.object({
  before_guide: ProductMeasureGuideSnapshotSchema.optional(),
  after_guide: ProductMeasureGuideSnapshotSchema,
  forget_result: ProductMeasureForgetSnapshotSchema.optional(),
  evidence_ids: StringList.optional(),
  sufficient_evidence: z.boolean().optional(),
}).strict();

const ProductMeasureTraceSchema = ProductDecisionTraceBaseSchema.extend({
  baseline: EffectObservationSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.baseline && !value.before_guide) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["before_guide"],
      message: "product_trace requires baseline or before_guide for comparison",
    });
  }
});

const ProductDecisionTraceRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  product_trace: ProductDecisionTraceBaseSchema,
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
  baseline: EffectObservationSchema.optional(),
  aionis: EffectObservationSchema.optional(),
  product_trace: ProductMeasureTraceSchema.optional(),
  minEffectDelta: z.number().optional(),
  minAionisScore: z.number().optional(),
  comparison: z.object({
    mode: z.enum(["baseline_vs_aionis", "observe_only_vs_active", "single_run_history_impact"]).optional(),
    baseline_run_id: z.string().trim().min(1).nullable().optional(),
    aionis_run_id: z.string().trim().min(1).nullable().optional(),
    sufficient_evidence: z.boolean().optional(),
  }).strict().optional(),
  evidence_ids: StringList.optional(),
}).strict().superRefine((value, ctx) => {
  const hasManualPair = !!value.baseline && !!value.aionis;
  if (!hasManualPair && !value.product_trace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["product_trace"],
      message: "measure requires baseline/aionis or product_trace",
    });
  }
  if (!!value.baseline !== !!value.aionis && !value.product_trace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["aionis"],
      message: "manual measurement requires both baseline and aionis observations",
    });
  }
});

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

function observeWritePayload(parsed: z.infer<typeof ProductObserveRequest>): {
  payload: Record<string, unknown>;
  structuring: ProductObserveStructuringSummary;
} | null {
  const hasInlineWrite =
    !!parsed.input_text
    || !!parsed.input_sha256
    || !!parsed.execution
    || (Array.isArray(parsed.nodes) && parsed.nodes.length > 0)
    || (Array.isArray(parsed.edges) && parsed.edges.length > 0);
  if (!parsed.memory && !hasInlineWrite) return null;
  const structured = structureProductObserveMemoryInput(parsed);
  const payload = mergeProductScope(parsed, {
    ...(parsed.memory ?? {}),
    input_text: structured.input_text,
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
    edges: parsed.edges,
    nodes: structured.nodes,
  });
  return {
    payload,
    structuring: structured.summary,
  };
}

type ProductForgetInput = z.infer<typeof ProductForgetRequest>;
type ProductForgetTarget = NonNullable<ProductForgetInput["target"]>;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function productForgetNodeIds(parsed: ProductForgetInput): string[] {
  return uniqueStrings([
    ...(parsed.node_ids ?? []),
    ...(parsed.memory_ids ?? []),
  ]);
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function productForgetTarget(parsed: ProductForgetInput): ProductForgetTarget {
  if (parsed.operation === "suppress" || parsed.operation === "unsuppress") return "pattern";
  if (parsed.operation === "activate") return "memory";
  if (parsed.target) return parsed.target;
  if (parsed.anchor_id || parsed.anchor_uri || payloadString(parsed.payload, "anchor_id") || payloadString(parsed.payload, "anchor_uri")) {
    return "payload";
  }
  return "archive";
}

function productForgetRoute(parsed: ProductForgetInput, target: ProductForgetTarget): string {
  if (parsed.operation === "suppress") return "/v1/memory/anchors/suppress";
  if (parsed.operation === "unsuppress") return "/v1/memory/anchors/unsuppress";
  if (parsed.operation === "activate") return "/v1/memory/nodes/activate";
  if (target === "payload") return "/v1/memory/anchors/rehydrate_payload";
  return "/v1/memory/archive/rehydrate";
}

function productForgetPayload(parsed: ProductForgetInput, target: ProductForgetTarget): Record<string, unknown> {
  const payload = parsed.payload ?? {};
  const nodeIds = productForgetNodeIds(parsed);
  const clientIds = uniqueStrings(parsed.client_ids ?? []);
  const scope = stripUndefined({
    tenant_id: parsed.tenant_id,
    scope: parsed.scope,
    actor: parsed.actor,
  });
  if (parsed.operation === "suppress") {
    const suppressMode = parsed.mode === "hard_freeze" || parsed.mode === "shadow_learn" ? parsed.mode : undefined;
    return stripUndefined({
      ...scope,
      ...payload,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      reason: parsed.reason,
      until: parsed.until ?? payload.until,
      mode: suppressMode ?? payload.mode,
    });
  }
  if (parsed.operation === "unsuppress") {
    return stripUndefined({
      ...scope,
      ...payload,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      reason: parsed.reason,
    });
  }
  if (parsed.operation === "activate") {
    return stripUndefined({
      ...scope,
      ...payload,
      node_ids: nodeIds.length > 0 ? nodeIds : payload.node_ids,
      client_ids: clientIds.length > 0 ? clientIds : payload.client_ids,
      run_id: parsed.run_id ?? payload.run_id,
      outcome: parsed.outcome ?? payload.outcome,
      activate: parsed.activate ?? payload.activate,
      reason: parsed.reason,
      input_text: typeof payload.input_text === "string" ? payload.input_text : parsed.reason,
      input_sha256: payload.input_sha256,
    });
  }
  if (target === "payload") {
    const rehydrationMode =
      parsed.mode === "summary_only" || parsed.mode === "partial" || parsed.mode === "full" || parsed.mode === "differential"
        ? parsed.mode
        : undefined;
    return stripUndefined({
      ...scope,
      ...payload,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      anchor_uri: parsed.anchor_uri ?? payloadString(payload, "anchor_uri"),
      mode: rehydrationMode ?? payload.mode,
      include_linked_decisions: parsed.include_linked_decisions ?? payload.include_linked_decisions,
      reason: parsed.reason,
    });
  }
  return stripUndefined({
    ...scope,
    ...payload,
    node_ids: nodeIds.length > 0 ? nodeIds : payload.node_ids,
    client_ids: clientIds.length > 0 ? clientIds : payload.client_ids,
    target_tier: parsed.target_tier ?? payload.target_tier,
    reason: parsed.reason,
    input_text: typeof payload.input_text === "string" ? payload.input_text : parsed.reason,
    input_sha256: payload.input_sha256,
  });
}

function productForgetChangedCount(resultBody: unknown, operation: ProductForgetInput["operation"], target: ProductForgetTarget): number {
  const body = resultBody && typeof resultBody === "object" && !Array.isArray(resultBody)
    ? resultBody as Record<string, unknown>
    : {};
  if (operation === "suppress" || operation === "unsuppress") return 1;
  if (operation === "activate") {
    const activated = body.activated && typeof body.activated === "object" && !Array.isArray(body.activated)
      ? body.activated as Record<string, unknown>
      : {};
    return finiteNumber(activated.updated_nodes) ?? 0;
  }
  if (target === "payload") {
    const rehydrated = body.rehydrated && typeof body.rehydrated === "object" && !Array.isArray(body.rehydrated)
      ? body.rehydrated as Record<string, unknown>
      : {};
    const summary = rehydrated.summary && typeof rehydrated.summary === "object" && !Array.isArray(rehydrated.summary)
      ? rehydrated.summary as Record<string, unknown>
      : {};
    return (finiteNumber(summary.resolved_nodes) ?? 0) + (finiteNumber(summary.resolved_decisions) ?? 0);
  }
  const rehydrated = body.rehydrated && typeof body.rehydrated === "object" && !Array.isArray(body.rehydrated)
    ? body.rehydrated as Record<string, unknown>
    : {};
  return finiteNumber(rehydrated.moved_nodes) ?? 0;
}

function productForgetEffect(args: {
  parsed: ProductForgetInput;
  target: ProductForgetTarget;
  route: string;
  resultBody: unknown;
}) {
  const nodeIds = productForgetNodeIds(args.parsed);
  const changedCount = productForgetChangedCount(args.resultBody, args.parsed.operation, args.target);
  const result = args.resultBody && typeof args.resultBody === "object" && !Array.isArray(args.resultBody)
    ? args.resultBody as Record<string, unknown>
    : {};
  const anchorKind = typeof result.anchor_kind === "string" ? result.anchor_kind : null;
  return {
    action: args.parsed.operation,
    target: args.target,
    ...(anchorKind ? { anchor_kind: anchorKind } : {}),
    reason: args.parsed.reason,
    changed_count: changedCount,
    reversible: args.parsed.operation !== "activate",
    affected_memory_ids: nodeIds,
    affected_client_ids: uniqueStrings(args.parsed.client_ids ?? []),
    anchor_id: args.parsed.anchor_id ?? (typeof args.parsed.payload?.anchor_id === "string" ? args.parsed.payload.anchor_id : null),
    anchor_uri: args.parsed.anchor_uri ?? (typeof args.parsed.payload?.anchor_uri === "string" ? args.parsed.payload.anchor_uri : null),
  };
}

type ProductMeasureInput = z.infer<typeof ProductMeasureRequest>;
type ProductMeasureTraceInput = z.infer<typeof ProductMeasureTraceSchema>;
type ProductDecisionTraceInput = z.infer<typeof ProductDecisionTraceBaseSchema>;
type ProductMeasureGuideSnapshot = z.infer<typeof ProductMeasureGuideSnapshotSchema>;

function productMeasureContextItems(snapshot: ProductMeasureGuideSnapshot): number {
  const explicit = finiteNumber(snapshot.context_items);
  if (explicit !== null) return explicit;
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return (memoryPacket?.relevant_memories.length ?? 0)
    + (guidePacket?.guidance.workflow_candidates.length ?? 0)
    + (guidePacket?.proven_facts.length ?? 0)
    + (guidePacket?.memory_lifecycle.rehydration_hints.length ?? 0);
}

function productMeasureUsefulContextItems(snapshot: ProductMeasureGuideSnapshot): number {
  const explicit = finiteNumber(snapshot.useful_context_items);
  if (explicit !== null) return explicit;
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  const usefulMemories = memoryPacket?.relevant_memories.filter((memory) =>
    memory.authority !== "blocked"
    && memory.lifecycle_state !== "suppressed"
    && memory.lifecycle_state !== "archived",
  ).length ?? 0;
  const usefulWorkflows = guidePacket?.guidance.workflow_candidates.filter((workflow) => workflow.authority !== "blocked").length ?? 0;
  return usefulMemories
    + usefulWorkflows
    + (guidePacket?.proven_facts.length ?? 0);
}

function productMeasureHistoricalContextCount(snapshot: ProductMeasureGuideSnapshot): number {
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return (memoryPacket?.relevant_memories.length ?? 0)
    + (guidePacket?.guidance.workflow_candidates.length ?? 0)
    + (guidePacket?.proven_facts.length ?? 0)
    + (guidePacket?.memory_lifecycle.rehydration_hints.length ?? 0);
}

function productMeasureRecoveredFactCount(snapshot: ProductMeasureGuideSnapshot): number {
  const guidePacket = snapshot.guide_packet ?? null;
  const memoryPacket = snapshot.memory_packet ?? null;
  if (!guidePacket && !memoryPacket) return 0;
  return (guidePacket?.proven_facts.length ?? 0)
    + (guidePacket?.recovered_state.resumable ? 1 : 0)
    + (guidePacket?.recovered_state.target_files.length ?? 0)
    + (guidePacket?.recovered_state.acceptance_checks.length ?? 0)
    + (memoryPacket?.relevant_memories.length ?? 0);
}

function productMeasureVerifiedFactCount(snapshot: ProductMeasureGuideSnapshot): number {
  const guidePacket = snapshot.guide_packet ?? null;
  const memoryPacket = snapshot.memory_packet ?? null;
  return (guidePacket?.proven_facts.length ?? 0)
    + (memoryPacket?.evidence_trail.length ?? 0)
    + (guidePacket?.history_contributions.handoff.source_count ?? 0)
    + (guidePacket?.history_contributions.replay.source_count ?? 0);
}

function productMeasureExpectedCount(explicit: unknown, observed: number): number {
  const expected = finiteNumber(explicit);
  if (expected !== null && expected > 0) return expected;
  return Math.max(observed, 1);
}

function productMeasureRepeatedDiscovery(snapshot: ProductMeasureGuideSnapshot, baseline: boolean): number {
  const explicit = finiteNumber(snapshot.repeated_discovery_steps);
  if (explicit !== null) return explicit;
  const guidePacket = snapshot.guide_packet ?? null;
  const memoryPacket = snapshot.memory_packet ?? null;
  const historyUsed = guidePacket?.guide_brief.history_used === true;
  const reducesDiscovery = guidePacket?.guide_brief.expected_product_effects.reduces_repeated_discovery === true;
  if (historyUsed && reducesDiscovery) return 0;
  const actionableHistory =
    (memoryPacket?.relevant_memories.length ?? 0) > 0
    || (guidePacket?.guidance.workflow_candidates.length ?? 0) > 0
    || (guidePacket?.proven_facts.length ?? 0) > 0
    || guidePacket?.recovered_state.resumable === true;
  if (actionableHistory) return 1;
  return baseline ? 4 : 3;
}

function productMeasureStaleSurfaced(snapshot: ProductMeasureGuideSnapshot): number {
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return Math.max(
    memoryPacket?.forgetting_state.stale_memory_count ?? 0,
    memoryPacket?.risk.stale_memory_count ?? 0,
    guidePacket?.risk.stale_memory_count ?? 0,
  );
}

function productMeasureStaleSuppressed(snapshot: ProductMeasureGuideSnapshot): number {
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return (memoryPacket?.forgetting_state.suppressed_count ?? 0)
    + (guidePacket?.memory_lifecycle.suppressed_memory_ids.length ?? 0)
    + (guidePacket?.guide_brief.do_not_use.length ?? 0);
}

function productMeasureForgetChanged(trace: ProductMeasureTraceInput, action: ProductForgetInput["operation"], target?: ProductForgetTarget): number {
  const effect = trace.forget_result?.forget_effect;
  if (!effect) return 0;
  if (effect.action && effect.action !== action) return 0;
  if (target && effect.target && effect.target !== target) return 0;
  return finiteNumber(effect.changed_count) ?? 0;
}

function productMeasureObservationFromGuideSnapshot(args: {
  snapshot: ProductMeasureGuideSnapshot;
  trace: ProductMeasureTraceInput;
  baseline: boolean;
}): AionisEffectObservation {
  const { snapshot, trace, baseline } = args;
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  let contextItems = productMeasureContextItems(snapshot);
  let usefulContextItems = productMeasureUsefulContextItems(snapshot);
  const recoveredFacts = productMeasureRecoveredFactCount(snapshot);
  const verifiedFacts = productMeasureVerifiedFactCount(snapshot);
  if (
    baseline
    && finiteNumber(snapshot.context_items) === null
    && finiteNumber(snapshot.useful_context_items) === null
    && productMeasureHistoricalContextCount(snapshot) === 0
  ) {
    contextItems = 1;
    usefulContextItems = 0;
  }
  const workflowCandidates = guidePacket?.guidance.workflow_candidates ?? [];
  const trustedWorkflowCount = workflowCandidates.filter((workflow) => workflow.authority === "trusted").length;
  const weakTrustedWorkflowCount = workflowCandidates.filter((workflow) =>
    workflow.authority === "trusted" && workflow.evidence_count <= 0,
  ).length;
  const blockedAuthorityCount = guidePacket?.risk.blocked_authority_count ?? 0;
  const inspectOrBlockedCount =
    (guidePacket?.guide_brief.inspect_before_use.length ?? 0)
    + (guidePacket?.guide_brief.do_not_use.length ?? 0)
    + blockedAuthorityCount;
  const staleSuppressed = productMeasureStaleSuppressed(snapshot)
    + (baseline ? 0 : productMeasureForgetChanged(trace, "suppress", "pattern"));
  const archivedRehydrated = baseline ? 0 : (
    productMeasureForgetChanged(trace, "rehydrate", "archive")
    + productMeasureForgetChanged(trace, "rehydrate", "payload")
  );
  const unverifiedPacketAuthority = guidePacket?.guide_brief.authority === "trusted"
    && (memoryPacket?.evidence_trail.length ?? 0) === 0
    && (guidePacket?.proven_facts.length ?? 0) === 0
    ? 1
    : 0;

  return {
    label: baseline ? "product_trace.before_guide" : "product_trace.after_guide",
    continuity: {
      repeatedDiscoverySteps: productMeasureRepeatedDiscovery(snapshot, baseline),
      continuityGuidanceCorrect:
        guidePacket?.guide_brief.expected_product_effects.reduces_repeated_discovery === true
        || recoveredFacts > 0,
      recoveredStateFacts: recoveredFacts,
      expectedStateFacts: productMeasureExpectedCount(snapshot.expected_state_facts, recoveredFacts),
      verifiedFactsCarried: verifiedFacts,
      verifiedFactsExpected: productMeasureExpectedCount(snapshot.verified_facts_expected, verifiedFacts),
    },
    learning: {
      workflowReused: workflowCandidates.length > 0,
      stableWorkflowReused: trustedWorkflowCount > 0,
      provisionalMemoriesWritten: workflowCandidates.filter((workflow) => workflow.authority === "candidate" || workflow.authority === "advisory").length,
      trustedPromotions: trustedWorkflowCount,
      weakEvidencePromoted: weakTrustedWorkflowCount,
      counterEvidenceDemotions: staleSuppressed > 0 ? staleSuppressed : 0,
    },
    forgetting: {
      contextItems,
      usefulContextItems,
      staleMemorySurfaced: productMeasureStaleSurfaced(snapshot),
      staleMemorySuppressed: staleSuppressed,
      archivedMemoryRehydratedOnDemand: archivedRehydrated,
      unnecessaryRehydrations: 0,
    },
    learning_control: {
      weakEvidenceBlocked: inspectOrBlockedCount,
      authorityRequiresEvidence: true,
      blockedAuthorityVisible: true,
      unverifiedAuthorityApplied: weakTrustedWorkflowCount + unverifiedPacketAuthority,
    },
  };
}

function productMeasureInputs(parsed: ProductMeasureInput): {
  baseline: AionisEffectObservation;
  aionis: AionisEffectObservation;
  source: "manual_observations" | "product_trace";
  evidenceIds: string[];
  comparison: ProductMeasureInput["comparison"];
} {
  if (parsed.product_trace) {
    const trace = parsed.product_trace;
    const baseline = trace.baseline
      ? trace.baseline as AionisEffectObservation
      : productMeasureObservationFromGuideSnapshot({
        snapshot: trace.before_guide as ProductMeasureGuideSnapshot,
        trace,
        baseline: true,
      });
    const aionis = productMeasureObservationFromGuideSnapshot({
      snapshot: trace.after_guide,
      trace,
      baseline: false,
    });
    return {
      baseline,
      aionis,
      source: "product_trace",
      evidenceIds: compactProductMeasureEvidenceIds(parsed, trace),
      comparison: {
        mode: parsed.comparison?.mode ?? "observe_only_vs_active",
        baseline_run_id: parsed.comparison?.baseline_run_id ?? null,
        aionis_run_id: parsed.comparison?.aionis_run_id ?? null,
        sufficient_evidence: parsed.comparison?.sufficient_evidence ?? trace.sufficient_evidence ?? true,
      },
    };
  }
  return {
    baseline: parsed.baseline as AionisEffectObservation,
    aionis: parsed.aionis as AionisEffectObservation,
    source: "manual_observations",
    evidenceIds: parsed.evidence_ids ?? [],
    comparison: parsed.comparison,
  };
}

function compactProductMeasureEvidenceIds(parsed: ProductMeasureInput, trace: ProductMeasureTraceInput): string[] {
  return uniqueStrings([
    ...(parsed.evidence_ids ?? []),
    ...(trace.evidence_ids ?? []),
    ...(trace.before_guide?.memory_packet?.lifecycle.used_memory_ids ?? []).map((id) => `before:${id}`),
    ...(trace.after_guide.memory_packet?.lifecycle.used_memory_ids ?? []).map((id) => `after:${id}`),
    ...(trace.after_guide.guide_packet?.guidance.workflow_candidates ?? []).map((workflow) => `workflow:${workflow.workflow_id}`),
    ...(trace.forget_result?.forget_effect?.affected_memory_ids ?? []).map((id) => `forget:${id}`),
  ]);
}

function productMemoryDecisionOutputs(args: {
  tenant_id: string;
  scope: string;
  trace: ProductDecisionTraceInput;
  routes_used: string[];
}): {
  memoryDecisionTrace: AionisMemoryDecisionTrace;
  memoryDecisionAudit: AionisMemoryDecisionAuditReport;
} {
  const memoryDecisionTrace = buildAionisMemoryDecisionTrace({
    tenant_id: args.tenant_id,
    scope: args.scope,
    before_guide: args.trace.before_guide ?? null,
    after_guide: args.trace.after_guide,
    forget_result: args.trace.forget_result ?? null,
    source_map: {
      routes_used: args.routes_used,
    },
  });
  const memoryDecisionAudit = buildAionisMemoryDecisionAuditReport({
    trace: memoryDecisionTrace,
    source_map: {
      routes_used: args.routes_used,
    },
  });
  return { memoryDecisionTrace, memoryDecisionAudit };
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
    const writeBundle = observeWritePayload(parsed);
    const writePayload = writeBundle?.payload ?? null;
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
        general_memory_count: writeBundle?.structuring.general_memory_count ?? 0,
        execution_memory_count: writeBundle?.structuring.execution_workflow_count ?? 0,
        auto_text_memory_count: writeBundle?.structuring.auto_text_node_count ?? 0,
        execution_observation_count: writeBundle?.structuring.execution_observation_count ?? 0,
      },
      structured_memory: writeBundle?.structuring ?? null,
      memory_write: write?.body ?? null,
      handoff: handoff?.body ?? null,
      source_map: {
        routes_used: routesUsed,
        internal_surfaces_used: [
          ...(write ? ["memory_write"] : []),
          ...(handoff ? ["handoff_store"] : []),
        ],
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
    const memoryPacket: AionisMemoryPacket | null = recall.aionis_memory_packet
      ? AionisMemoryPacketSchema.parse(recall.aionis_memory_packet)
      : null;
    const guidePacket: AionisGuidePacket | null = body.aionis_guide_packet
      ? AionisGuidePacketSchema.parse(body.aionis_guide_packet)
      : null;
    const agentContext: AionisAgentContext = buildAionisAgentContext({
      tenant_id: String(body.tenant_id ?? parsed.tenant_id ?? env.MEMORY_TENANT_ID),
      scope: String(body.scope ?? parsed.scope ?? env.MEMORY_SCOPE),
      memory_packet: memoryPacket,
      guide_packet: guidePacket,
    });
    const includePackets = parsed.include_packets === true;

    return reply.code(200).send({
      contract_version: "aionis_guide_result_v1",
      tenant_id: body.tenant_id ?? parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: body.scope ?? parsed.scope ?? env.MEMORY_SCOPE,
      agent_context: agentContext,
      ...(includePackets ? {
        memory_packet: memoryPacket,
        guide_packet: guidePacket,
      } : {}),
      source_map: {
        routes_used: ["/v1/memory/planning/context"],
        internal_surfaces_used: [
          "recall",
          "product_packets",
          "agent_context_compiler",
        ],
        omitted_internal_surfaces: [
          "internal_planning_details",
          "internal_learning_diagnostics",
          "internal_execution_recommendation_details",
          "internal_cost_diagnostics",
          ...(includePackets ? [] : ["memory_packet", "guide_packet"]),
        ],
      },
    });
  });

  app.post("/v1/forget", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const parsed = ProductForgetRequest.parse(req.body);
    const target = productForgetTarget(parsed);
    const route = productForgetRoute(parsed, target);
    const forgetPayload = productForgetPayload(parsed, target);
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
      target,
      forget_effect: productForgetEffect({
        parsed,
        target,
        route,
        resultBody: result.body,
      }),
      result: result.body,
      source_map: {
        routes_used: [route],
        internal_surfaces_used: [
          target === "payload" ? "anchor_payload_rehydration" : "memory_lifecycle",
          parsed.operation === "suppress" || parsed.operation === "unsuppress" ? "learning_control" : "controlled_forgetting",
        ],
        omitted_internal_surfaces: [
          "raw_memory_rows",
          "raw_slots",
          "internal_route_schema",
        ],
      },
    });
  });

  app.post("/v1/debug/memory-decision-trace", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductDecisionTraceRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const decisionOutputs = productMemoryDecisionOutputs({
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        trace: parsed.product_trace,
        routes_used: ["/v1/debug/memory-decision-trace"],
      });
      return reply.code(200).send({
        contract_version: "aionis_memory_decision_trace_result_v1",
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        memory_decision_trace: decisionOutputs.memoryDecisionTrace,
        source_map: {
          routes_used: ["/v1/debug/memory-decision-trace"],
          internal_surfaces_used: [
            "product_trace_projection",
            "memory_decision_trace",
          ],
        },
      });
    } finally {
      gate.release();
    }
  });

  app.post("/v1/audit/memory-decision-report", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductDecisionTraceRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const decisionOutputs = productMemoryDecisionOutputs({
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        trace: parsed.product_trace,
        routes_used: ["/v1/audit/memory-decision-report"],
      });
      return reply.code(200).send({
        contract_version: "aionis_memory_decision_audit_result_v1",
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        memory_decision_audit: decisionOutputs.memoryDecisionAudit,
        source_map: {
          routes_used: ["/v1/audit/memory-decision-report"],
          internal_surfaces_used: [
            "product_trace_projection",
            "memory_decision_trace",
            "memory_decision_audit_report",
          ],
        },
      });
    } finally {
      gate.release();
    }
  });

  app.post("/v1/measure", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductMeasureRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const measureInput = productMeasureInputs(parsed);
      const kernelReport = evaluateAionisEffect({
        baseline: measureInput.baseline,
        aionis: measureInput.aionis,
        minEffectDelta: parsed.minEffectDelta,
        minAionisScore: parsed.minAionisScore,
      });
      const effectReport = buildAionisEffectReport({
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        task: parsed.task,
        report: kernelReport,
        comparison: measureInput.comparison,
        evidence_ids: measureInput.evidenceIds,
      });
      const decisionOutputs = parsed.product_trace
        ? productMemoryDecisionOutputs({
            tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
            scope: parsed.scope ?? env.MEMORY_SCOPE,
            trace: parsed.product_trace,
            routes_used: ["/v1/measure"],
          })
        : null;
      return reply.code(200).send({
        contract_version: "aionis_measure_result_v1",
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        measurement_input: {
          source: measureInput.source,
          baseline: measureInput.baseline,
          aionis: measureInput.aionis,
        },
        effect_report: AionisEffectReportSchema.parse(effectReport),
        ...(decisionOutputs ? {
          memory_decision_trace: decisionOutputs.memoryDecisionTrace,
          memory_decision_audit: decisionOutputs.memoryDecisionAudit,
        } : {}),
        kernel_report: kernelReport,
        source_map: {
          routes_used: ["/v1/measure"],
          internal_surfaces_used: [
            ...(measureInput.source === "product_trace" ? ["product_trace_projection"] : []),
            ...(decisionOutputs ? ["memory_decision_trace", "memory_decision_audit_report"] : []),
            "effect_evaluator",
            "product_effect_report",
          ],
        },
      });
    } finally {
      gate.release();
    }
  });
}
