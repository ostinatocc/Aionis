import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
  type Env,
} from "../config.js";
import type { IdentityRequestKind } from "../app/request-guards.js";
import {
  evaluateAionisEffect,
  type AionisEffectObservation,
} from "../kernel/effect-evaluator.js";
import { sha256Hex } from "../util/crypto.js";
import {
  AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
  applyAionisInspectBeforeUseActiveProjection,
  buildAionisAgentContext,
  buildAionisEffectReport,
  buildAionisMemoryPacket,
  buildAionisMemoryDecisionAuditReport,
  buildAionisMemoryDecisionTrace,
  type BuildAionisMemoryPacketArgs,
} from "../memory/product-output-assembler.js";
import { buildAionisAgentFlightRecorderReport } from "../memory/agent-flight-recorder.js";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ACTIVE_PROJECTION_REASON,
  resolveAionisAdmissionCandidatePolicyActiveProjection,
  type AionisAdmissionCandidatePolicyActiveProjection,
} from "../memory/admission-policy-active-projection.js";
import { buildClaimLedgerProjection } from "../memory/claim-ledger-projection.js";
import { governExternalMemoryCandidates } from "../memory/external-candidate-admission.js";
import { buildAionisOperatorSnapshot } from "../memory/operator-snapshot.js";
import {
  AionisAgentRoleSchema,
  AionisAgentContextSchema,
  AionisTaskContextProfileSchema,
  AionisEffectReportSchema,
  AionisExternalMemoryCandidateSchema,
  AionisGuidePacketSchema,
  AionisMemoryPacketSchema,
  type AionisEffectReport,
  type AionisAgentContext,
  type AionisAgentRole,
  type AionisTaskContextProfile,
  type AionisClaimLedgerProjection,
  type AionisClaimLedgerProjectionItem,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisGuidePacket,
  type AionisMemoryPacket,
} from "../memory/product-output-contract.js";
import { applyUnusedExposureLearningControlLite } from "../memory/lifecycle-lite.js";
import { AionisClaimWriteSchema } from "../memory/claim-ledger-contract.js";
import { resolveTenantScope } from "../memory/tenant.js";
import type { ClaimLedgerAccess, ClaimLedgerRow } from "../store/claim-ledger-access.js";
import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import type {
  SkillCandidateReviewAccess,
  SkillCandidateReviewStatus,
  TraceDerivedSkillTrainingCandidate,
} from "../store/skill-candidate-review-access.js";
import type { AuthPrincipal } from "../util/auth.js";
import { createErrorResponse } from "../util/http.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import {
  structureProductObserveMemoryInput,
  type ProductObserveStructuringSummary,
} from "./product-observe-structuring.js";

type ProductFacadeRequest = FastifyRequest<{ Body: unknown }>;
type ProductFacadeQueryRequest = FastifyRequest<{ Querystring: unknown }>;
type ProductFacadeParamsRequest = FastifyRequest<{ Params: unknown; Body: unknown }>;

const CLAIM_LEDGER_GUIDE_LIVE_LIMIT = 12;
const CLAIM_LEDGER_GUIDE_SUPERSEDED_SLOT_LIMIT = 8;
const CLAIM_LEDGER_GUIDE_SUPERSEDED_PER_SLOT_LIMIT = 4;

type ProductFacadeArgs = {
  app: FastifyInstance;
  env: Env;
  liteWriteStore: LiteWriteStore;
  claimLedgerAccess?: ClaimLedgerAccess | null;
  skillCandidateReviewAccess?: SkillCandidateReviewAccess | null;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: IdentityRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "recall" | "write") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "recall" | "write", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "recall" | "write") => Promise<InflightGateToken>;
};

function productErrorResponse(args: {
  status: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  topLevel?: Record<string, unknown>;
}) {
  return {
    ...createErrorResponse({
      status: args.status,
      error: args.error,
      message: args.message,
      details: {
        contract: "error_v1",
        ...(args.details ?? {}),
      },
    }),
    ...(args.topLevel ?? {}),
  };
}

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
  distill: LooseObject.optional(),
  claims: z.array(AionisClaimWriteSchema).max(32).optional(),
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
  mode: z.enum(["standard", "full_power"]).optional(),
  context_mode: z.enum(["standard", "full_power", "compact_agent"]).optional(),
  agent_role: AionisAgentRoleSchema.optional(),
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
  task_context_profile: AionisTaskContextProfileSchema.optional(),
  memory_layer_preference: z.unknown().optional(),
  execution_state_v1: z.unknown().optional(),
  execution_packet_v1: z.unknown().optional(),
  edit_boundary_context: z.unknown().optional(),
  runtime_verification: z.unknown().optional(),
  trajectory: z.unknown().optional(),
  trajectory_hints: z.unknown().optional(),
  execution_tree_v1: z.unknown().optional(),
  include_packets: z.boolean().optional(),
}).strict();

const PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT = 256;
const PRODUCT_GUIDE_STRUCTURED_EXECUTION_PACKET_LIMIT = 16;

const ProductMemoryAdmissionRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  run_id: z.string().trim().min(1).optional(),
  query_text: z.string().trim().min(1),
  mode: z.enum(["standard", "strict", "firewall"]).optional(),
  context_mode: z.enum(["standard", "compact_agent"]).optional(),
  candidates: z.array(AionisExternalMemoryCandidateSchema).min(1).max(200),
  include_records: z.boolean().optional(),
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
  guide_trace_id: z.string().trim().min(1).optional(),
  used_memory_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  anchor_id: z.string().trim().min(1).optional(),
  anchor_uri: z.string().trim().min(1).optional(),
  target_tier: z.enum(["warm", "hot"]).optional(),
  outcome: z.enum(["positive", "negative", "neutral"]).optional(),
  activate: z.boolean().optional(),
  run_id: z.string().trim().min(1).optional(),
  used_surface: z.enum(["use_now", "inspect_before_use", "do_not_use", "explicit_host_assertion"]).optional(),
  verifier_status: z.enum(["passed", "failed", "not_run", "unknown"]).optional(),
  tool_status: z.enum(["succeeded", "failed", "not_run", "unknown"]).optional(),
  runtime_signal_refs: z.array(z.string().trim().min(1)).max(32).optional(),
  mode: z.enum(["shadow_learn", "hard_freeze", "summary_only", "partial", "full", "differential"]).optional(),
  until: z.string().datetime().optional(),
  include_linked_decisions: z.boolean().optional(),
  payload: LooseObject.optional(),
}).strict().superRefine((value, ctx) => {
  const memoryIdCount =
    (value.memory_ids?.length ?? 0)
    + (value.node_ids?.length ?? 0)
    + (value.client_ids?.length ?? 0)
    + (value.used_memory_ids?.length ?? 0);
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
      message: "activate requires memory_ids, node_ids, client_ids, or guide_trace_id with used_memory_ids",
    });
  }
  if (value.operation === "activate" && value.guide_trace_id && (value.client_ids?.length ?? 0) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["client_ids"],
      message: "guide_trace_id attribution uses memory node ids; client_ids are not accepted in the same activation",
    });
  }
  if (value.operation === "activate" && value.guide_trace_id && (value.used_memory_ids?.length ?? 0) === 0 && (value.memory_ids?.length ?? 0) === 0 && (value.node_ids?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_memory_ids"],
      message: "guide_trace_id activation requires used_memory_ids or memory_ids so feedback is attributed to exposed memory only",
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
  if (value.operation === "activate" && !value.used_surface) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_surface"],
      message: "activate requires used_surface so feedback is attributed only to memory actually used by the host",
    });
  }
  if (
    value.operation === "activate"
    && value.outcome
    && value.outcome !== "neutral"
    && value.used_surface
    && value.used_surface !== "use_now"
    && value.used_surface !== "explicit_host_assertion"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_surface"],
      message: "non-neutral activation feedback requires use_now or explicit_host_assertion attribution",
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

const ProductFlightRecorderRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  guide_trace_id: z.string().trim().min(1).optional(),
  run_id: z.string().trim().min(1).optional(),
  product_trace: ProductDecisionTraceBaseSchema.optional(),
  agent_context: z.unknown().optional(),
  memory_decision_trace: z.unknown().optional(),
  memory_use_receipt: z.unknown().optional(),
  memory_admission_record: z.unknown().optional(),
  claim_ledger_projection: z.unknown().optional(),
  operator_snapshot: z.unknown().optional(),
  feedback_result: z.unknown().optional(),
  decision_time: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    !value.product_trace
    && value.agent_context === undefined
    && value.memory_decision_trace === undefined
    && value.memory_use_receipt === undefined
    && value.memory_admission_record === undefined
    && value.operator_snapshot === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["product_trace"],
      message: "flight recorder requires product_trace or at least one replay artifact",
    });
  }
});

const ProductMeasureRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  task: z.object({
    task_id: z.string().trim().min(1).nullable().optional(),
    run_id: z.string().trim().min(1).nullable().optional(),
    task_signature: z.string().trim().min(1).nullable().optional(),
    task_family: z.string().trim().min(1).nullable().optional(),
    workflow_signature: z.string().trim().min(1).nullable().optional(),
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

const ProductSkillCandidateReviewStatusSchema = z.enum(["pending_review", "promoted", "rejected", "all"]);

const ProductSkillCandidateListQuery = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  status: ProductSkillCandidateReviewStatusSchema.default("pending_review"),
  limit: z.coerce.number().int().positive().max(500).default(50),
}).strict();

const ProductSkillCandidateEnqueueRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  effect_report: z.unknown().optional(),
  measure_result: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.effect_report === undefined && value.measure_result === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effect_report"],
      message: "skill candidate enqueue requires effect_report or measure_result",
    });
  }
});

const ProductSkillCandidateParams = z.object({
  id: z.string().trim().min(1),
}).strict();

const ProductSkillCandidateReviewRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  reviewer_id: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).max(2048).optional(),
}).strict();

type InternalDispatchResult =
  | { ok: true; statusCode: number; body: unknown }
  | { ok: false; statusCode: number; body: unknown };

function isPlanningContextNoEmbeddingProvider(result: InternalDispatchResult): boolean {
  if (result.ok) return false;
  const body = objectValue(result.body);
  const details = objectValue(body?.details);
  return result.statusCode === 400
    && body?.error === "no_embedding_provider"
    && details?.surface === "planning_context";
}

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
    distill: parsed.distill,
    edges: parsed.edges,
    nodes: structured.nodes,
  });
  return {
    payload,
    structuring: structured.summary,
  };
}

function parseStringListJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function firstWrittenMemoryNodeId(write: InternalDispatchResult | null): string | null {
  if (!write?.ok) return null;
  const body = objectValue(write.body);
  const nodes = Array.isArray(body?.nodes) ? body.nodes : [];
  for (const node of nodes) {
    const record = objectValue(node);
    if (typeof record?.id === "string" && record.id.trim().length > 0) return record.id;
  }
  return null;
}

function buildClaimObserveReceipt(rows: ClaimLedgerRow[]) {
  const supersededClaimIds = uniqueStrings(rows.flatMap((row) => parseStringListJson(row.supersedes_claim_ids_json)));
  const contestedClaimIds = rows
    .filter((row) => row.status === "contested")
    .map((row) => row.claim_id);
  return {
    contract_version: "aionis_claim_observe_receipt_v1",
    written_count: rows.length,
    claim_ids: rows.map((row) => row.claim_id),
    superseded_claim_ids: supersededClaimIds,
    contested_claim_ids: contestedClaimIds,
    agent_prompt_included: false,
    runtime_mutation: true,
  };
}

async function writeProductObserveClaims(args: {
  claimLedgerAccess: ClaimLedgerAccess | null | undefined;
  parsed: z.infer<typeof ProductObserveRequest>;
  write: InternalDispatchResult | null;
  tenantId: string;
  scope: string;
}) {
  const claims = args.parsed.claims ?? [];
  if (claims.length === 0) return null;
  if (!args.claimLedgerAccess) {
    return {
      ok: false as const,
      statusCode: 503,
      body: productErrorResponse({
        status: 503,
        error: "claim_ledger_unavailable",
        message: "claim ledger is not available for this Runtime",
      }),
    };
  }

  const sourceMemoryId = firstWrittenMemoryNodeId(args.write);
  const rows: ClaimLedgerRow[] = [];
  for (const claim of claims) {
    rows.push(await args.claimLedgerAccess.writeClaim({
      scope: args.scope,
      tenantId: args.tenantId,
      claim: {
        ...claim,
        source_memory_id: claim.source_memory_id ?? sourceMemoryId ?? undefined,
      },
    }));
  }
  return {
    ok: true as const,
    receipt: buildClaimObserveReceipt(rows),
  };
}

type ProductForgetInput = z.infer<typeof ProductForgetRequest>;
type ProductForgetTarget = NonNullable<ProductForgetInput["target"]>;
type ProductLifecycleSurface = "forget" | "feedback" | "rehydrate";

function productFeedbackRequest(body: unknown): ProductForgetInput {
  const record = objectValue(body) ?? {};
  return ProductForgetRequest.parse({
    ...record,
    operation: "activate",
    target: "memory",
  });
}

function productRehydrateRequest(body: unknown): ProductForgetInput {
  const record = objectValue(body) ?? {};
  return ProductForgetRequest.parse({
    ...record,
    operation: "rehydrate",
  });
}

function productLifecycleContractVersion(surface: ProductLifecycleSurface): string {
  switch (surface) {
    case "feedback": return "aionis_feedback_result_v1";
    case "rehydrate": return "aionis_rehydrate_result_v1";
    case "forget": return "aionis_forget_result_v1";
  }
}

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

function compactProductPromptText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function productPromptPostureLabel(value: AionisAgentContext["recommended_posture"]): string {
  switch (value) {
    case "ignore_history": return "ignore";
    case "rehydrate_before_use": return "rehydrate";
    case "inspect_before_use": return "inspect";
    case "reuse_supported_history": return "reuse";
    case "use_as_context": return "context";
  }
}

function productPromptAuthorityLabel(value: AionisAgentContext["authority"]): string {
  switch (value) {
    case "trusted": return "trust";
    case "advisory": return "adv";
    case "candidate": return "cand";
    case "blocked": return "block";
    case "none": return "none";
  }
}

function productPromptRiskLabel(value: AionisAgentContext["risk"]["negative_transfer_risk"]): string {
  switch (value) {
    case "high": return "hi";
    case "medium": return "med";
    case "low": return "low";
  }
}

type ProductGuideExposureLedger = {
  contract_version: "aionis_guide_exposure_v1";
  guide_trace_id: string;
  tenant_id: string;
  scope: string;
  run_id: string | null;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  query_sha256: string;
  context_sha256: string;
  memory_ids: string[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  rehydrate_memory_ids: string[];
  prompt_char_count: number;
  history_used: boolean;
  actionable_history_used: boolean;
  recommended_posture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
};

type ProductUnusedExposureObservation = {
  contract_version: "aionis_unused_exposure_observation_v1";
  mode: "read_only_measure";
  exposure_threshold: number;
  guide_trace_count: number;
  tracked_memory_count: number;
  repeated_unattributed_memory_ids: string[];
  repeated_unattributed_without_positive_memory_ids: string[];
  memory_stats: Array<{
    memory_id: string;
    current_unattributed: boolean;
    exposure_count: number;
    use_now_exposure_count: number;
    inspect_before_use_exposure_count: number;
    do_not_use_exposure_count: number;
    rehydrate_exposure_count: number;
    positive_attributed_use_count: number;
    feedback_positive_count: number;
    feedback_negative_count: number;
    repeated_without_positive_attribution: boolean;
  }>;
  reason: string;
};

type ProductGuideExposureResolution =
  | {
    ok: true;
    ledger: ProductGuideExposureLedger;
    usedMemoryIds: string[];
    unattributedRecalledMemoryIds: string[];
    unattributedUseNowMemoryIds: string[];
    unattributedInspectBeforeUseMemoryIds: string[];
    unattributedDoNotUseMemoryIds: string[];
    unattributedRehydrateMemoryIds: string[];
  }
  | {
    ok: false;
    statusCode: number;
    body: Record<string, unknown>;
  };

type ProductFeedbackLearningControlPersistence = Awaited<ReturnType<typeof applyUnusedExposureLearningControlLite>>;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function productGuideAgentRole(parsed: z.infer<typeof ProductGuideRequest>): AionisAgentRole {
  if (parsed.agent_role) return parsed.agent_role;
  const context = objectValue(parsed.context);
  const contextRole = context?.agent_role;
  const parsedContextRole = AionisAgentRoleSchema.safeParse(contextRole);
  return parsedContextRole.success ? parsedContextRole.data : "agent";
}

function productGuidePremiseFirewallVisible(agentContext: AionisAgentContext): boolean {
  return agentContext.risk.reasons.some((reason) => reason.startsWith("premise_firewall_"))
    || agentContext.inspect_before_use.some((entry) => entry.startsWith("Premise risk:"))
    || agentContext.do_not_use.some((entry) => entry.startsWith("Premise risk:"));
}

function productGuideMemoryContractVisible(memoryPacket: AionisMemoryPacket | null): boolean {
  return memoryPacket?.relevant_memories.some((entry) => !!entry.memory_contract) === true;
}

function productGuideFullPowerRequested(parsed: z.infer<typeof ProductGuideRequest>): boolean {
  return parsed.mode === "full_power" || parsed.context_mode === "full_power" || parsed.context_mode === "compact_agent";
}

function productGuideAgentContextMode(parsed: z.infer<typeof ProductGuideRequest>): AionisAgentContext["agent_context_mode"] {
  return parsed.context_mode === "compact_agent" ? "compact_agent" : "standard";
}

function productGuideTaskContextProfile(parsed: z.infer<typeof ProductGuideRequest>): AionisTaskContextProfile {
  if (parsed.task_context_profile) return parsed.task_context_profile;
  const context = objectValue(parsed.context);
  const parsedContextProfile = AionisTaskContextProfileSchema.safeParse(context?.task_context_profile);
  return parsedContextProfile.success ? parsedContextProfile.data : "general";
}

type ProductTaskContextProfileCompilerPolicy = {
  contextCharBudget: number | null;
  executionContextCharBudget: number;
  filesLimit: number;
  currentLimit: number;
  procedureLimit: number;
  inspectLimit: number;
  avoidLimit: number;
  rehydrateLimit: number;
  currentMaxChars: number;
  procedureMaxChars: number;
  inspectMaxChars: number;
  avoidMaxChars: number;
  rehydrateReasonMaxChars: number;
};

function productGuideTaskContextProfileCompilerPolicy(args: {
  profile: AionisTaskContextProfile;
  agentContextMode: AionisAgentContext["agent_context_mode"];
  explicitContextCharBudget?: number | null;
}): ProductTaskContextProfileCompilerPolicy {
  const compactAgent = args.agentContextMode === "compact_agent";
  const explicitBudget =
    typeof args.explicitContextCharBudget === "number" && args.explicitContextCharBudget > 0
      ? Math.trunc(args.explicitContextCharBudget)
      : null;
  const base: ProductTaskContextProfileCompilerPolicy = {
    contextCharBudget: explicitBudget,
    executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
    filesLimit: compactAgent ? 2 : 4,
    currentLimit: compactAgent ? 1 : 2,
    procedureLimit: compactAgent ? 1 : 3,
    inspectLimit: compactAgent ? 1 : 3,
    avoidLimit: 3,
    rehydrateLimit: compactAgent ? 2 : 3,
    currentMaxChars: compactAgent ? 90 : 160,
    procedureMaxChars: compactAgent ? 90 : 130,
    inspectMaxChars: compactAgent ? 70 : 100,
    avoidMaxChars: compactAgent ? 90 : 100,
    rehydrateReasonMaxChars: compactAgent ? 50 : 70,
  };

  switch (args.profile) {
    case "coding_verifier":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 4096 : 6144),
        executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
        filesLimit: compactAgent ? 4 : 6,
        procedureLimit: compactAgent ? 1 : 2,
        inspectLimit: compactAgent ? 2 : 3,
        avoidLimit: compactAgent ? 2 : 3,
        procedureMaxChars: compactAgent ? 110 : 150,
        inspectMaxChars: compactAgent ? 95 : 130,
      };
    case "document_integrity":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 6144 : 8192),
        executionContextCharBudget: Math.min(explicitBudget ?? 6144, 50_000),
        filesLimit: compactAgent ? 5 : 8,
        procedureLimit: compactAgent ? 2 : 3,
        inspectLimit: compactAgent ? 3 : 4,
        avoidLimit: compactAgent ? 2 : 3,
        rehydrateLimit: compactAgent ? 3 : 4,
        inspectMaxChars: compactAgent ? 95 : 130,
      };
    case "long_qa":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 8192 : 12000),
        executionContextCharBudget: Math.min(explicitBudget ?? 8192, 50_000),
        currentLimit: compactAgent ? 1 : 2,
        procedureLimit: compactAgent ? 2 : 3,
        inspectLimit: compactAgent ? 4 : 6,
        avoidLimit: compactAgent ? 2 : 3,
        rehydrateLimit: compactAgent ? 4 : 6,
        currentMaxChars: compactAgent ? 120 : 180,
        procedureMaxChars: compactAgent ? 120 : 160,
        inspectMaxChars: compactAgent ? 120 : 180,
        rehydrateReasonMaxChars: compactAgent ? 75 : 100,
      };
    case "multi_agent_handoff":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 4096 : 6144),
        executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
        currentLimit: compactAgent ? 2 : 3,
        procedureLimit: compactAgent ? 2 : 3,
        inspectLimit: compactAgent ? 1 : 2,
        avoidLimit: compactAgent ? 2 : 3,
      };
    case "loop_engineering":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 4096 : 6144),
        executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
        currentLimit: compactAgent ? 2 : 3,
        procedureLimit: compactAgent ? 2 : 4,
        inspectLimit: compactAgent ? 2 : 3,
        avoidLimit: compactAgent ? 2 : 3,
        procedureMaxChars: compactAgent ? 110 : 150,
      };
    case "general":
      return base;
  }
}

type AdmissionCandidatePolicyGuideModeResolution = {
  mode: "off" | "shadow" | "active";
  source: "global_env" | "profile_rule" | "off";
  profile_id?: string;
};

function selectorMatches(ruleValues: readonly string[] | undefined, actual: string | null): boolean {
  if (!ruleValues || ruleValues.length === 0) return true;
  if (!actual) return false;
  return ruleValues.includes(actual);
}

function prefixSelectorMatches(prefixes: readonly string[] | undefined, actual: string | null): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  if (!actual) return false;
  return prefixes.some((prefix) => actual.startsWith(prefix));
}

function stringFromContext(context: Record<string, unknown> | null, key: string): string | null {
  const value = context?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function admissionCandidatePolicyProfileRuleMatches(args: {
  rule: AionisAdmissionCandidatePolicyProfileRule;
  parsed: z.infer<typeof ProductGuideRequest>;
  scope: string;
  agentRole: AionisAgentRole;
}): boolean {
  const context = objectValue(args.parsed.context);
  const contextMode = args.parsed.context_mode ?? "standard";
  const guideMode = args.parsed.mode ?? "standard";
  return selectorMatches(args.rule.scopes, args.scope)
    && prefixSelectorMatches(args.rule.scope_prefixes, args.scope)
    && selectorMatches(args.rule.task_families, stringFromContext(context, "task_family"))
    && selectorMatches(args.rule.task_signatures, stringFromContext(context, "task_signature"))
    && selectorMatches(args.rule.agent_roles, args.agentRole)
    && selectorMatches(args.rule.context_modes, contextMode)
    && selectorMatches(args.rule.guide_modes, guideMode);
}

function resolveAdmissionCandidatePolicyGuideMode(args: {
  env: Env;
  parsed: z.infer<typeof ProductGuideRequest>;
  scope: string;
  agentRole: AionisAgentRole;
}): AdmissionCandidatePolicyGuideModeResolution {
  if (args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE === "shadow"
    || args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE === "active") {
    return {
      mode: args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE,
      source: "global_env",
    };
  }
  const rules = parseAdmissionCandidatePolicyProfileRules(
    args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON ?? "[]",
  );
  const matched = rules.find((rule) =>
    admissionCandidatePolicyProfileRuleMatches({
      rule,
      parsed: args.parsed,
      scope: args.scope,
      agentRole: args.agentRole,
    })
  );
  if (!matched) return { mode: "off", source: "off" };
  return {
    mode: matched.mode,
    source: "profile_rule",
    profile_id: matched.profile_id,
  };
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function nestedStringField(value: unknown, key: string): string | null {
  const record = objectValue(value);
  return firstStringValue(record?.[key]);
}

function productGuideExecutionSignatures(parsed: z.infer<typeof ProductGuideRequest>): {
  taskSignature: string | null;
  taskFamily: string | null;
  workflowSignature: string | null;
} {
  const context = objectValue(parsed.context);
  return {
    taskSignature: firstStringValue(
      context?.task_signature,
      nestedStringField(parsed.execution_packet_v1, "task_signature"),
      nestedStringField(parsed.execution_state_v1, "task_signature"),
    ),
    taskFamily: firstStringValue(
      context?.task_family,
      nestedStringField(parsed.execution_packet_v1, "task_family"),
      nestedStringField(parsed.execution_state_v1, "task_family"),
    ),
    workflowSignature: firstStringValue(
      context?.workflow_signature,
      nestedStringField(parsed.execution_packet_v1, "workflow_signature"),
      nestedStringField(parsed.execution_state_v1, "workflow_signature"),
    ),
  };
}

function productGuideExecutionMemoryFilters(parsed: z.infer<typeof ProductGuideRequest>): Array<Record<string, unknown>> {
  const { taskSignature, taskFamily, workflowSignature } = productGuideExecutionSignatures(parsed);
  const filters: Array<Record<string, unknown>> = [];
  if (taskSignature) filters.push({ slots_contains: { task_signature: taskSignature }, limit: 20 });
  if (taskFamily) filters.push({ slots_contains: { task_family: taskFamily }, limit: 20 });
  if (workflowSignature) filters.push({ slots_contains: { workflow_signature: workflowSignature }, limit: 20 });
  return filters.slice(0, 3);
}

function nestedObjectField(value: unknown, key: string): Record<string, unknown> | null {
  const record = objectValue(value);
  return objectValue(record?.[key]);
}

function structuredRecallRehydrationMode(row: LiteExecutionNativeNodeRow): string | null {
  const executionNative = row.execution_native as Record<string, unknown>;
  return firstStringValue(
    executionNative.rehydration_default_mode,
    objectValue(executionNative.rehydration)?.default_mode,
    nestedObjectField(row.slots.anchor_v1, "rehydration")?.default_mode,
  );
}

function structuredRecallExecutionStatus(row: LiteExecutionNativeNodeRow): string | null {
  const executionNative = row.execution_native as Record<string, unknown>;
  return firstStringValue(
    objectValue(row.slots.execution_result_summary)?.status,
    objectValue(executionNative.outcome)?.status,
  );
}

function structuredRecallExecutionOutcomeRole(row: LiteExecutionNativeNodeRow): string | null {
  const executionNative = row.execution_native as Record<string, unknown>;
  return firstStringValue(
    executionNative.execution_outcome_role,
    executionNative.outcome_role,
    objectValue(row.slots.execution_observation_v1)?.execution_outcome_role,
    objectValue(row.slots.execution_observation_v1)?.outcome_role,
    objectValue(row.slots.execution_result_summary)?.execution_outcome_role,
  );
}

function productGuideStructuredReusableWorkflowAnchor(row: LiteExecutionNativeNodeRow): boolean {
  const executionNative = row.execution_native as Record<string, unknown>;
  const outcomeRole = structuredRecallExecutionOutcomeRole(row);
  const trust = firstStringValue(executionNative.contract_trust, row.slots.contract_trust);
  const layer = firstStringValue(executionNative.compression_layer, row.slots.compression_layer);
  const summaryKind = firstStringValue(executionNative.summary_kind, row.slots.summary_kind);
  const targetFiles = Array.isArray(executionNative.target_files) ? executionNative.target_files : [];
  const hasTargetSurface = targetFiles.some((entry) => typeof entry === "string" && entry.trim().length > 0)
    || !!firstStringValue(executionNative.file_path);
  return summaryKind === "workflow_anchor"
    && outcomeRole === "passed_solution"
    && hasTargetSurface
    && (trust === "authoritative" || trust === "advisory")
    && (layer === "L2" || layer === "L3" || layer === "L4" || layer === "L5" || layer === null);
}

function productGuideStructuredControlNode(row: LiteExecutionNativeNodeRow): boolean {
  const executionNative = row.execution_native as Record<string, unknown>;
  const lifecycle = firstStringValue(row.slots.lifecycle_state);
  const status = structuredRecallExecutionStatus(row);
  const rehydrationMode = structuredRecallRehydrationMode(row);
  const tier = firstStringValue(row.tier);
  const trust = firstStringValue(executionNative.contract_trust, row.slots.contract_trust);
  const layer = firstStringValue(executionNative.compression_layer, row.slots.compression_layer);
  const summaryKind = firstStringValue(executionNative.summary_kind, row.slots.summary_kind);
  const reusableWorkflowAnchor = productGuideStructuredReusableWorkflowAnchor(row);
  const currentStateKind =
    summaryKind === "current_state"
    || summaryKind === "current_active_path"
    || summaryKind === "active_state";
  const activeStateCarrier = (
    currentStateKind
    && (status === "passed" || status === "succeeded" || lifecycle === "active" || lifecycle === null)
  )
    && (trust === "authoritative" || trust === "advisory")
    && (layer === "L2" || layer === "L3" || layer === "L4" || layer === "L5" || layer === null);
  return lifecycle === "suppressed"
    || lifecycle === "disabled"
    || lifecycle === "contested"
    || lifecycle === "candidate"
    || lifecycle === "rehydration_candidate"
    || status === "failed"
    || status === "blocked"
    || status === "contested"
    || !!rehydrationMode
    || tier === "cold"
    || tier === "archive"
    || reusableWorkflowAnchor
    || activeStateCarrier;
}

function productGuideStructuredControlSlots(row: LiteExecutionNativeNodeRow): Record<string, unknown> {
  const slots: Record<string, unknown> = { ...row.slots };
  const lifecycle = firstStringValue(slots.lifecycle_state);
  const status = structuredRecallExecutionStatus(row);
  const rehydrationMode = structuredRecallRehydrationMode(row);
  const reusableWorkflowAnchor = productGuideStructuredReusableWorkflowAnchor(row);
  const executionNative: Record<string, unknown> = objectValue(slots.execution_native_v1)
    ? { ...(objectValue(slots.execution_native_v1) as Record<string, unknown>) }
    : { ...row.execution_native };

  if (!firstStringValue(executionNative.rehydration_default_mode) && rehydrationMode) {
    executionNative.rehydration_default_mode = rehydrationMode;
  }
  if (reusableWorkflowAnchor) {
    executionNative.summary_kind = "current_state";
    executionNative.guide_projection_kind = "passed_workflow_anchor_active_route";
  }
  slots.execution_native_v1 = executionNative;

  if (status === "failed" || status === "blocked" || lifecycle === "disabled") {
    slots.lifecycle_state = "suppressed";
  } else if (status === "contested" && !lifecycle) {
    slots.lifecycle_state = "contested";
  } else if (rehydrationMode && !lifecycle) {
    slots.lifecycle_state = "rehydration_candidate";
  }

  return slots;
}

function recallSourceKey(value: unknown): string {
  const record = objectValue(value);
  if (!record) return stableStringify(value) ?? String(value);
  return stableStringify({
    kind: record.kind,
    index_name: record.index_name,
    reason: record.reason,
    matched_fields: Array.isArray(record.matched_fields) ? record.matched_fields : [],
  }) ?? String(value);
}

function mergeRecallSourceArrays(left: unknown, right: unknown): unknown[] {
  const out: unknown[] = Array.isArray(left) ? [...left] : [];
  const seen = new Set(out.map((entry) => recallSourceKey(entry)));
  for (const entry of Array.isArray(right) ? right : []) {
    const key = recallSourceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function mergeAionisMemoryPackets(
  base: AionisMemoryPacket | null,
  supplemental: AionisMemoryPacket | null,
): { packet: AionisMemoryPacket | null; changed: boolean } {
  if (!supplemental || supplemental.relevant_memories.length === 0) return { packet: base, changed: false };
  if (!base) return { packet: supplemental, changed: true };

  const seenMemoryIds = new Set(base.relevant_memories.map((entry) => entry.memory_id));
  const supplementalById = new Map(supplemental.relevant_memories.map((entry) => [entry.memory_id, entry]));
  let recallSourceChanged = false;
  const baseMemoriesWithMergedSources = base.relevant_memories.map((entry) => {
    const duplicate = supplementalById.get(entry.memory_id);
    if (!duplicate) return entry;
    const recallSources = mergeRecallSourceArrays(entry.recall_sources, duplicate.recall_sources);
    if (recallSources.length === entry.recall_sources.length) return entry;
    recallSourceChanged = true;
    return {
      ...entry,
      recall_sources: recallSources,
    };
  });
  const relevantMemories = [
    ...baseMemoriesWithMergedSources,
    ...supplemental.relevant_memories.filter((entry) => {
      if (seenMemoryIds.has(entry.memory_id)) return false;
      seenMemoryIds.add(entry.memory_id);
      return true;
    }),
  ];
  const changed = relevantMemories.length > base.relevant_memories.length || recallSourceChanged;
  if (!changed) return { packet: base, changed: false };

  const evidenceIds = new Set<string>();
  const evidenceTrail = [...base.evidence_trail, ...supplemental.evidence_trail].filter((entry) => {
    if (evidenceIds.has(entry.evidence_id)) return false;
    evidenceIds.add(entry.evidence_id);
    return true;
  });
  const contradictionWarnings = [
    ...base.contradiction_warnings,
    ...supplemental.contradiction_warnings.filter((entry) =>
      !base.contradiction_warnings.some((existing) =>
        existing.memory_id === entry.memory_id && existing.suggested_action === entry.suggested_action
      )
    ),
  ];
  const domains = new Set(relevantMemories.map((entry) => entry.domain));
  const memoryFamily: AionisMemoryPacket["memory_family"] =
    relevantMemories.length === 0
      ? "empty"
      : domains.size > 1
        ? "mixed"
        : domains.has("execution")
          ? "execution"
          : "general_cognitive";
  const staleMemoryCount = relevantMemories.filter((entry) =>
    entry.lifecycle_state === "suppressed"
    || entry.lifecycle_state === "demoted"
    || entry.lifecycle_state === "archived"
  ).length;
  const rehydrationHints = [
    ...base.lifecycle.rehydration_hints,
    ...supplemental.lifecycle.rehydration_hints.filter((hint) =>
      !base.lifecycle.rehydration_hints.some((existing) => existing.memory_id === hint.memory_id)
    ),
  ];

  return {
    packet: AionisMemoryPacketSchema.parse({
      ...base,
      memory_family: memoryFamily,
      relevant_memories: relevantMemories,
      evidence_trail: evidenceTrail,
      lifecycle: {
        used_memory_ids: uniqueStrings([
          ...base.lifecycle.used_memory_ids,
          ...supplemental.lifecycle.used_memory_ids,
        ]),
        candidate_memory_ids: uniqueStrings([
          ...base.lifecycle.candidate_memory_ids,
          ...supplemental.lifecycle.candidate_memory_ids,
        ]),
        suppressed_memory_ids: uniqueStrings([
          ...base.lifecycle.suppressed_memory_ids,
          ...supplemental.lifecycle.suppressed_memory_ids,
        ]),
        archived_memory_ids: uniqueStrings([
          ...base.lifecycle.archived_memory_ids,
          ...supplemental.lifecycle.archived_memory_ids,
        ]),
        rehydration_hints: rehydrationHints,
      },
      contradiction_warnings: contradictionWarnings,
      forgetting_state: {
        stale_memory_count: staleMemoryCount,
        suppressed_count: relevantMemories.filter((entry) => entry.lifecycle_state === "suppressed").length,
        archived_count: relevantMemories.filter((entry) => entry.lifecycle_state === "archived").length,
        rehydration_candidate_count: rehydrationHints.length,
      },
      behavior_impact: {
        will_shape_behavior:
          base.behavior_impact.will_shape_behavior || supplemental.behavior_impact.will_shape_behavior,
        changed_fields: uniqueStrings([
          ...base.behavior_impact.changed_fields,
          ...supplemental.behavior_impact.changed_fields,
          "structured_execution_control_recall",
        ]),
        expected_effects: Array.from(new Set([
          ...base.behavior_impact.expected_effects,
          ...supplemental.behavior_impact.expected_effects,
        ])),
        explanation: `${base.behavior_impact.explanation} Full-power guide also merged task-scoped execution control memory for safer context compilation.`,
      },
      risk: {
        negative_transfer_risk: maxRisk(
          base.risk.negative_transfer_risk,
          supplemental.risk.negative_transfer_risk,
        ),
        contradiction_count: contradictionWarnings.length,
        low_confidence_count: relevantMemories.filter((entry) => entry.confidence < 0.6).length,
        stale_memory_count: staleMemoryCount,
        reasons: mergeGuideStrings([
          ...base.risk.reasons,
          ...supplemental.risk.reasons,
          "full_power_structured_execution_control_memory_present",
        ], 8),
      },
      source_map: {
        routes_used: uniqueStrings([
          ...base.source_map.routes_used,
          ...supplemental.source_map.routes_used,
        ]),
        internal_surfaces_used: uniqueStrings([
          ...base.source_map.internal_surfaces_used,
          ...supplemental.source_map.internal_surfaces_used,
          "full_power_structured_execution_recall",
        ]),
        omitted_internal_surfaces: uniqueStrings([
          ...base.source_map.omitted_internal_surfaces,
          ...supplemental.source_map.omitted_internal_surfaces,
        ]),
      },
    }),
    changed: true,
  };
}

async function buildProductGuideStructuredExecutionPacket(args: {
  liteWriteStore: LiteWriteStore;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  public_scope: string;
  store_scope: string;
}): Promise<AionisMemoryPacket | null> {
  const { taskSignature, workflowSignature } = productGuideExecutionSignatures(args.parsed);
  if (!taskSignature && !workflowSignature) return null;

  const batches = await Promise.all([
    taskSignature
      ? args.liteWriteStore.findExecutionNativeNodes({
          scope: args.store_scope,
          taskSignature,
          consumerAgentId: args.parsed.consumer_agent_id ?? null,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
          limit: PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT,
          offset: 0,
        })
      : Promise.resolve({ rows: [] as LiteExecutionNativeNodeRow[], has_more: false }),
    workflowSignature
      ? args.liteWriteStore.findExecutionNativeNodes({
          scope: args.store_scope,
          workflowSignature,
          consumerAgentId: args.parsed.consumer_agent_id ?? null,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
          limit: PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT,
          offset: 0,
        })
      : Promise.resolve({ rows: [] as LiteExecutionNativeNodeRow[], has_more: false }),
  ]);
  const rowsById = new Map<string, LiteExecutionNativeNodeRow>();
  for (const row of batches.flatMap((batch) => batch.rows)) {
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }
  const rows = Array.from(rowsById.values())
    .filter(productGuideStructuredControlNode)
    .slice(0, PRODUCT_GUIDE_STRUCTURED_EXECUTION_PACKET_LIMIT);
  if (rows.length === 0) return null;

  const nodes: BuildAionisMemoryPacketArgs["nodes"] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    text_summary: row.text_summary,
    tier: row.tier,
    slots: productGuideStructuredControlSlots(row),
    raw_ref: row.raw_ref,
    evidence_ref: row.evidence_ref,
    commit_id: row.commit_id,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    confidence: row.confidence,
    salience: row.salience,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  const matchedFields = uniqueStrings([
    taskSignature ? "task_signature" : null,
    workflowSignature ? "workflow_signature" : null,
  ]);

  return buildAionisMemoryPacket({
    tenant_id: args.tenant_id,
    scope: args.public_scope,
    actor: {
      consumer_agent_id: args.parsed.consumer_agent_id ?? null,
      consumer_team_id: args.parsed.consumer_team_id ?? null,
      producer_agent_ids: [],
    },
    query: {
      source: "text",
      intent: args.parsed.query_text,
    },
    nodes,
    ranked: nodes.map((node, index) => ({
      id: node.id,
      score: Math.max(0.5, 0.99 - index * 0.01),
    })),
    recall_sources_by_memory_id: Object.fromEntries(nodes.map((node, index) => [
      node.id,
      [{
        kind: "execution_native",
        score: Math.max(0.5, 0.99 - index * 0.01),
        reason: "structured_execution_signature_recall",
        matched_fields: matchedFields,
        index_name: "lite_memory_execution_native_index",
      }],
    ])),
    source_map: {
      routes_used: ["/v1/guide"],
      internal_surfaces_used: [
        "structured_execution_signature_recall",
        "memory_contract_projection",
        "semantic_forgetting_surface",
      ],
      omitted_internal_surfaces: [
        "raw_embedding_vectors",
        "raw_slots",
        "full_payloads",
      ],
    },
  });
}

function riskRank(value: AionisAgentContext["risk"]["negative_transfer_risk"]): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

function maxRisk(
  left: AionisAgentContext["risk"]["negative_transfer_risk"],
  right: AionisAgentContext["risk"]["negative_transfer_risk"],
): AionisAgentContext["risk"]["negative_transfer_risk"] {
  return riskRank(left) >= riskRank(right) ? left : right;
}

function authorityRank(value: AionisAgentContext["authority"]): number {
  switch (value) {
    case "trusted": return 4;
    case "advisory": return 3;
    case "candidate": return 2;
    case "blocked": return 1;
    case "none": return 0;
  }
}

function conservativeAuthority(
  base: AionisAgentContext,
  executionHistoryUsed: boolean,
  executionAuthority: AionisAgentContext["authority"],
): AionisAgentContext["authority"] {
  if (!base.actionable_history_used) return executionAuthority;
  if (!executionHistoryUsed) return base.authority;
  return authorityRank(base.authority) <= authorityRank(executionAuthority) ? base.authority : executionAuthority;
}

function mergeGuideStrings(values: string[], limit: number): string[] {
  return uniqueStrings(values).slice(0, limit);
}

function productGuideSafeExecutionLines(values: string[], allowedPrefixes: string[]): string[] {
  return values.filter((entry) => allowedPrefixes.some((prefix) => entry.startsWith(prefix)));
}

function mergeCommandPostureRows(
  values: AionisAgentContext["command_posture"],
  limit: number,
): AionisAgentContext["command_posture"] {
  const seen = new Set<string>();
  const rows: AionisAgentContext["command_posture"] = [];
  for (const row of values) {
    const key = `${row.posture}:${row.memory_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

function renderProductCommandPostureLine(args: {
  commandPosture: AionisAgentContext["command_posture"];
  compactAgent: boolean;
}): string | null {
  if (args.commandPosture.length === 0) return null;
  const groups = new Map<AionisAgentContext["command_posture"][number]["posture"], string[]>();
  for (const row of args.commandPosture) {
    const values = groups.get(row.posture) ?? [];
    values.push(row.memory_id);
    groups.set(row.posture, values);
  }
  const labels: Array<[AionisAgentContext["command_posture"][number]["posture"], string]> = [
    ["must_not", args.compactAgent ? "no" : "must_not"],
    ["should_continue", args.compactAgent ? "go" : "should_continue"],
    ["inspect_first", args.compactAgent ? "chk" : "inspect_first"],
    ["rehydrate_first", args.compactAgent ? "raw" : "rehydrate_first"],
    ["optional_context", args.compactAgent ? "ctx" : "optional_context"],
  ];
  const parts = labels
    .map(([posture, label]) => {
      const values = groups.get(posture)?.slice(0, args.compactAgent ? 3 : 5) ?? [];
      return values.length > 0 ? `${label}=${values.join(",")}` : null;
    })
    .filter((entry): entry is string => !!entry);
  if (parts.length === 0) return null;
  return compactProductPromptText(`${args.compactAgent ? "cmd" : "command_posture:"} ${parts.join(" ")}`, args.compactAgent ? 180 : 320);
}

function renderProductRouteContractLine(args: {
  routeContract: AionisAgentContext["route_contract"];
  compactAgent: boolean;
}): string | null {
  const activeTargets = args.routeContract.active_targets
    .slice(0, args.compactAgent ? 2 : 4)
    .map((entry) => compactProductPromptText(entry.target, args.compactAgent ? 34 : 48));
  const referenceTargets = args.routeContract.reference_only_targets
    .slice(0, args.compactAgent ? 1 : 3)
    .map((entry) => compactProductPromptText(entry.target, args.compactAgent ? 28 : 42));
  const blockedTargets = args.routeContract.blocked_direction_targets
    .slice(0, args.compactAgent ? 1 : 3)
    .map((entry) => compactProductPromptText(entry.target, args.compactAgent ? 28 : 42));
  if (activeTargets.length === 0 && referenceTargets.length === 0 && blockedTargets.length === 0) return null;
  const parts = args.compactAgent
    ? mergeGuideStrings([
        activeTargets.length > 0 ? "conflict=missing_active_not_superseded" : null,
        activeTargets.length > 0 ? "exec=route_safe_patch_raw_if_needed" : null,
        activeTargets.length > 0 ? "after_raw=continue_if_consistent" : null,
        activeTargets.length > 0 ? `active=${activeTargets.join(",")}` : null,
        referenceTargets.length > 0 ? `ref_only=${referenceTargets.join(",")}` : null,
        blockedTargets.length > 0 ? `block_dir=${blockedTargets.join(",")}` : null,
        activeTargets.length > 0 || referenceTargets.length > 0 || blockedTargets.length > 0 ? "no_fallback_to_ref=1" : null,
      ].filter((entry): entry is string => !!entry), 8)
    : mergeGuideStrings([
        activeTargets.length > 0 ? "conflict_policy=do_not_treat_missing_active_target_as_superseded" : null,
        activeTargets.length > 0 ? "executable_evidence=route_safe_but_patch_may_require_rehydrate" : null,
        activeTargets.length > 0 ? "after_rehydrate=continue_allowed_action_if_task_consistent" : null,
        activeTargets.length > 0 ? `active_targets=${activeTargets.join(",")}` : null,
        referenceTargets.length > 0 ? `reference_only_targets=${referenceTargets.join(",")}` : null,
        blockedTargets.length > 0 ? `blocked_direction_targets=${blockedTargets.join(",")}` : null,
        activeTargets.length > 0 || referenceTargets.length > 0 || blockedTargets.length > 0 ? "fallback_policy=do_not_promote_reference_or_blocked_targets" : null,
      ].filter((entry): entry is string => !!entry), 8);
  if (parts.length === 0) return null;
  return compactProductPromptText(`${args.compactAgent ? "route" : "route_contract:"} ${parts.join(args.compactAgent ? " " : "; ")}`, args.compactAgent ? 300 : 560);
}

function renderProductRouteActionLine(args: {
  routeContract: AionisAgentContext["route_contract"];
  compactAgent: boolean;
}): string | null {
  if (args.routeContract.active_targets.length === 0) return null;
  const order = args.routeContract.action_policy.missing_active_target_preferred_order.join(">");
  const line = args.compactAgent
    ? `action missing_active=${order} terminal_inspect=0 raw_then_continue=1 conflict_after_raw_only=1`
    : `action_policy: missing_active_target_order=${order}; terminal_inspect_allowed=false; executable_evidence_policy=route_safe_but_patch_may_require_rehydrate; after_rehydrate_policy=continue_allowed_action_if_task_consistent; report_conflict_requires=rehydrate_unavailable_or_evidence_conflict`;
  return compactProductPromptText(line, args.compactAgent ? 190 : 520);
}

function renderProductTaskContextProfileLine(profile: AionisTaskContextProfile, compactAgent: boolean): string | null {
  switch (profile) {
    case "coding_verifier":
      return compactAgent
        ? "task coding_verifier: run non-excluded acceptance checks; no skip/deselect unless task says so"
        : "task_profile: coding_verifier; tests and verifiers are acceptance evidence; do not skip, deselect, or ignore non-excluded checks.";
    case "document_integrity":
      return compactAgent
        ? "task document_integrity: preserve original file identity; verify moved/copied documents"
        : "task_profile: document_integrity; preserve original file bytes, names, and identity unless transformation is explicitly required.";
    case "long_qa":
      return compactAgent
        ? "task long_qa: answer from covered evidence; rehydrate missing source spans"
        : "task_profile: long_qa; answer from covered evidence and rehydrate missing source spans before finalizing.";
    case "multi_agent_handoff":
      return compactAgent
        ? "task multi_agent_handoff: preserve owner/role/current handoff"
        : "task_profile: multi_agent_handoff; preserve role ownership, current handoff state, and verifier/reviewer boundaries.";
    case "loop_engineering":
      return compactAgent
        ? "task loop_engineering: preserve plan/iteration/validator/repair/stop reason"
        : "task_profile: loop_engineering; preserve plan, iteration, validation result, repair attempt, and stop reason.";
    case "general":
      return null;
  }
}

function renderMergedAgentPrompt(args: {
  context: AionisAgentContext;
  contextCharBudget?: number | null;
  agentContextMode?: AionisAgentContext["agent_context_mode"];
  compilerPolicy?: ProductTaskContextProfileCompilerPolicy;
}): string {
  const ctx = args.context;
  const compactAgent = args.agentContextMode === "compact_agent";
  const compilerPolicy = args.compilerPolicy ?? productGuideTaskContextProfileCompilerPolicy({
    profile: ctx.task_context_profile,
    agentContextMode: args.agentContextMode ?? ctx.agent_context_mode,
    explicitContextCharBudget: args.contextCharBudget,
  });
  const currentLines = ctx.use_now.filter((entry) => entry.startsWith("Current active path:"));
  const procedureLines = ctx.use_now.filter((entry) => !entry.startsWith("Current active path:"));
  const nextActionSource = currentLines[0] ?? ctx.use_now[0] ?? ctx.inspect_before_use[0] ?? null;
  const nextAction = nextActionSource
    ? nextActionSource.replace(/^(?:Current active path|Passed solution|Candidate workflow|Inspect gated abstraction before use):\s*/i, "")
    : null;
  const line = (label: string, values: string[], limit: number, maxChars: number): string[] =>
    values.slice(0, limit).map((entry) => `${label}: note=${compactProductPromptText(entry, maxChars)}`);
  const prompt = uniqueStrings([
    compactAgent ? "AIONIS_CTX compact_agent" : "AIONIS_CTX v2",
    `state r=${ctx.agent_role} h=${ctx.history_used ? 1 : 0} a=${ctx.actionable_history_used ? 1 : 0} p=${productPromptPostureLabel(ctx.recommended_posture)} auth=${productPromptAuthorityLabel(ctx.authority)} risk=${productPromptRiskLabel(ctx.risk.negative_transfer_risk)}`,
    renderProductTaskContextProfileLine(ctx.task_context_profile, compactAgent),
    renderProductCommandPostureLine({
      commandPosture: ctx.command_posture,
      compactAgent,
    }),
    renderProductRouteContractLine({
      routeContract: ctx.route_contract,
      compactAgent,
    }),
    renderProductRouteActionLine({
      routeContract: ctx.route_contract,
      compactAgent,
    }),
    ctx.actionable_history_used
      ? `next ${nextAction ? `action=${compactProductPromptText(nextAction, 130)} ` : ""}actor_role=${ctx.agent_role}`
      : null,
    compactAgent ? null : `summary ${compactProductPromptText(ctx.summary, 160)}`,
    ctx.target_files.length > 0 ? `files ${ctx.target_files.slice(0, compilerPolicy.filesLimit).join(",")}` : null,
    ...line(
      "current",
      currentLines.length > 0 ? currentLines : ctx.use_now.slice(0, 1),
      compilerPolicy.currentLimit,
      compilerPolicy.currentMaxChars,
    ),
    ...line("procedure", procedureLines, compilerPolicy.procedureLimit, compilerPolicy.procedureMaxChars),
    ...line("inspect", ctx.inspect_before_use, compilerPolicy.inspectLimit, compilerPolicy.inspectMaxChars),
    ...line("avoid", ctx.do_not_use, compilerPolicy.avoidLimit, compilerPolicy.avoidMaxChars),
    ctx.rehydrate_hints.length > 0
      ? `rehydrate: ${ctx.rehydrate_hints
        .slice(0, compilerPolicy.rehydrateLimit)
        .map((entry) => `id=${entry.memory_id}${entry.required ? " req=1" : ""} n=${compactProductPromptText(entry.reason, compilerPolicy.rehydrateReasonMaxChars)}`)
        .join(" | ")}`
      : null,
    !compactAgent && ctx.memory_ids.length > 0 ? `ids ${ctx.memory_ids.slice(0, 8).join(",")}` : null,
  ]).join("\n");
  const budget = compilerPolicy.contextCharBudget && compilerPolicy.contextCharBudget > 0 ? Math.trunc(compilerPolicy.contextCharBudget) : null;
  if (!budget || prompt.length <= budget) return prompt;
  return `${prompt.slice(0, Math.max(0, budget - 3)).trimEnd()}...`;
}

function mergeProductGuideAgentContexts(args: {
  base: AionisAgentContext;
  execution: AionisAgentContext | null;
  contextCharBudget?: number | null;
  agentContextMode?: AionisAgentContext["agent_context_mode"];
  compilerPolicy?: ProductTaskContextProfileCompilerPolicy;
}): { context: AionisAgentContext; changed: boolean } {
  const execution = args.execution;
  if (!execution) return { context: args.base, changed: false };
  const executionUseNow = productGuideSafeExecutionLines(execution.use_now, [
    "Current active path:",
    "Passed solution:",
  ]);
  const executionInspectBeforeUse: string[] = [];
  const executionDoNotUse = productGuideSafeExecutionLines(execution.do_not_use, [
    "Avoid failed branch:",
  ]);
  const executionHasSurface =
    executionUseNow.length > 0
    || executionInspectBeforeUse.length > 0
    || executionDoNotUse.length > 0;
  if (!executionHasSurface) return { context: args.base, changed: false };

  const knownMemoryIds = new Set(args.base.memory_ids);
  const useNow = mergeGuideStrings([...executionUseNow, ...args.base.use_now], 8);
  const inspectBeforeUse = mergeGuideStrings([...args.base.inspect_before_use, ...executionInspectBeforeUse], 8);
  const doNotUse = mergeGuideStrings([...executionDoNotUse, ...args.base.do_not_use], 8);
  const memoryIds = mergeGuideStrings(args.base.memory_ids, 10);
  const useNowMemoryIds = mergeGuideStrings([
    ...args.base.use_now_memory_ids,
    ...execution.use_now_memory_ids.filter((id) => knownMemoryIds.has(id)),
  ], 10);
  const inspectBeforeUseMemoryIds = mergeGuideStrings([
    ...args.base.inspect_before_use_memory_ids,
    ...execution.inspect_before_use_memory_ids.filter((id) => knownMemoryIds.has(id)),
  ], 10);
  const doNotUseMemoryIds = mergeGuideStrings([
    ...args.base.do_not_use_memory_ids,
    ...execution.do_not_use_memory_ids.filter((id) => knownMemoryIds.has(id)),
  ], 10);
  const targetFiles = mergeGuideStrings([...execution.target_files, ...args.base.target_files], 8);
  const rehydrateHints = [
    ...args.base.rehydrate_hints,
    ...execution.rehydrate_hints.filter((hint) => knownMemoryIds.has(hint.memory_id)),
  ].slice(0, 6);
  const commandPosture = mergeCommandPostureRows([
    ...execution.command_posture.filter((row) => knownMemoryIds.has(row.memory_id)),
    ...args.base.command_posture,
  ], 14);
  const historyUsed = args.base.history_used || execution.history_used;
  const actionableHistoryUsed = args.base.actionable_history_used || execution.actionable_history_used;
  const recommendedPosture: AionisAgentContext["recommended_posture"] = !actionableHistoryUsed
    ? "ignore_history"
    : (executionInspectBeforeUse.length > 0 || executionDoNotUse.length > 0)
      ? "inspect_before_use"
      : args.base.recommended_posture === "ignore_history"
        ? execution.recommended_posture
        : args.base.recommended_posture;
  const safeExecutionAuthority: AionisAgentContext["authority"] =
    executionUseNow.length > 0
      ? "advisory"
      : executionInspectBeforeUse.length > 0 || executionDoNotUse.length > 0
        ? "candidate"
        : "none";
  const authority = conservativeAuthority(args.base, executionHasSurface, safeExecutionAuthority);
  const safeExecutionRisk: AionisAgentContext["risk"]["negative_transfer_risk"] =
    executionDoNotUse.length > 0 || executionInspectBeforeUse.length > 0 ? "medium" : "low";
  const safeExecutionRiskReasons = execution.risk.reasons.filter((reason) =>
    reason === "failed_execution_branches_kept_out_of_use_now"
  );
  const risk = {
    negative_transfer_risk: maxRisk(args.base.risk.negative_transfer_risk, safeExecutionRisk),
    blocked_authority_count: args.base.risk.blocked_authority_count,
    stale_memory_count: Math.max(args.base.risk.stale_memory_count, execution.risk.stale_memory_count),
    reasons: mergeGuideStrings([
      ...args.base.risk.reasons,
      ...safeExecutionRiskReasons,
      "full_power_execution_context_merged",
    ], 8),
  };
  const summary = args.base.history_used && execution.history_used
    ? "Aionis recovered semantic memory and full-power execution context for this run."
    : execution.history_used
      ? execution.summary
      : args.base.summary;
  const merged = AionisAgentContextSchema.parse({
    ...args.base,
    agent_context_mode: args.agentContextMode ?? args.base.agent_context_mode,
    prompt_text: args.base.prompt_text,
    summary,
    history_used: historyUsed,
    actionable_history_used: actionableHistoryUsed,
    recommended_posture: recommendedPosture,
    authority,
    target_files: targetFiles,
    use_now: useNow,
    inspect_before_use: inspectBeforeUse,
    do_not_use: doNotUse,
    memory_ids: memoryIds,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
    do_not_use_memory_ids: doNotUseMemoryIds,
    command_posture: commandPosture,
    rehydrate_hints: rehydrateHints,
    risk,
    evidence_refs: {
      memory_ids: memoryIds,
      workflow_ids: mergeGuideStrings([
        ...args.base.evidence_refs.workflow_ids,
        ...execution.evidence_refs.workflow_ids,
      ], 10),
      evidence_count: args.base.evidence_refs.evidence_count + execution.evidence_refs.evidence_count,
    },
  });
  return {
    context: AionisAgentContextSchema.parse({
      ...merged,
      prompt_text: renderMergedAgentPrompt({
        context: merged,
        contextCharBudget: args.contextCharBudget,
        agentContextMode: args.agentContextMode ?? merged.agent_context_mode,
        compilerPolicy: args.compilerPolicy,
      }),
    }),
    changed: true,
  };
}

function claimLedgerProjectionHasPromptSurface(projection: AionisClaimLedgerProjection | null): projection is AionisClaimLedgerProjection {
  return !!projection && (
    projection.use_now.length > 0
    || projection.inspect_before_use.length > 0
    || projection.do_not_use.length > 0
  );
}

function claimLedgerProjectionHasAnySurface(projection: AionisClaimLedgerProjection | null): projection is AionisClaimLedgerProjection {
  return !!projection && (
    projection.use_now.length > 0
    || projection.inspect_before_use.length > 0
    || projection.do_not_use.length > 0
    || projection.audit_only.length > 0
  );
}

function renderClaimLedgerAgentLine(item: AionisClaimLedgerProjectionItem): string {
  const slot = item.slot_key ?? `${item.subject_key}.${item.predicate}`;
  const evidence = item.evidence_refs.length > 0
    ? ` evidence=${item.evidence_refs.slice(0, 2).join(",")}`
    : "";
  const supersededBy = item.superseded_by_claim_id
    ? ` superseded_by=${item.superseded_by_claim_id}`
    : "";
  return compactProductPromptText(
    [
      `Claim ledger ${item.surface}:`,
      `claim_id=${item.claim_id}`,
      `slot=${slot}`,
      `authority=${item.authority}`,
      `status=${item.status}`,
      `reason=${item.reason_code}`,
      `value=${item.value_text}`,
      evidence,
      supersededBy,
    ].filter((entry) => entry.trim().length > 0).join(" "),
    360,
  );
}

async function buildProductGuideClaimLedgerProjection(args: {
  claimLedgerAccess: ClaimLedgerAccess | null | undefined;
  tenantId: string;
  scope: string;
  queryText?: string | null;
}): Promise<AionisClaimLedgerProjection | null> {
  if (!args.claimLedgerAccess) return null;
  const live = await args.claimLedgerAccess.findLiveClaims({
    tenantId: args.tenantId,
    scope: args.scope,
    limit: CLAIM_LEDGER_GUIDE_LIVE_LIMIT,
  });
  const slotKeys = uniqueStrings(live.rows.map((row) => row.slot_key)).slice(
    0,
    CLAIM_LEDGER_GUIDE_SUPERSEDED_SLOT_LIMIT,
  );
  const supersededRows: ClaimLedgerRow[] = [];
  const supersededIds = new Set<string>();
  for (const slotKey of slotKeys) {
    const superseded = await args.claimLedgerAccess.findSupersededClaims({
      tenantId: args.tenantId,
      scope: args.scope,
      slotKey,
      limit: CLAIM_LEDGER_GUIDE_SUPERSEDED_PER_SLOT_LIMIT,
    });
    for (const row of superseded.rows) {
      if (supersededIds.has(row.claim_id)) continue;
      supersededIds.add(row.claim_id);
      supersededRows.push(row);
    }
  }
  if (live.rows.length === 0 && supersededRows.length === 0) return null;
  return buildClaimLedgerProjection({
    liveClaims: live.rows,
    supersededClaims: supersededRows,
    queryText: args.queryText,
    limit: CLAIM_LEDGER_GUIDE_LIVE_LIMIT,
  });
}

function applyClaimLedgerProjectionToAgentContext(args: {
  agentContext: AionisAgentContext;
  projection: AionisClaimLedgerProjection | null;
  contextCharBudget?: number | null;
  agentContextMode?: AionisAgentContext["agent_context_mode"];
  compilerPolicy?: ProductTaskContextProfileCompilerPolicy;
}): { context: AionisAgentContext; changed: boolean } {
  if (!claimLedgerProjectionHasPromptSurface(args.projection)) {
    return { context: args.agentContext, changed: false };
  }
  const projection = args.projection;
  const claimUseNow = projection.use_now.map(renderClaimLedgerAgentLine);
  const claimInspect = projection.inspect_before_use.map(renderClaimLedgerAgentLine);
  const claimDoNotUse = projection.do_not_use.map(renderClaimLedgerAgentLine);
  const claimActionable = claimUseNow.length > 0;
  const claimRequiresInspection = claimInspect.length > 0 || claimDoNotUse.length > 0;
  const projectedAuthority: AionisAgentContext["authority"] = projection.use_now.some((item) => item.authority === "trusted")
    ? "trusted"
    : claimUseNow.length > 0
      ? "advisory"
      : claimRequiresInspection
        ? "candidate"
        : args.agentContext.authority;
  const authority = authorityRank(args.agentContext.authority) >= authorityRank(projectedAuthority)
    ? args.agentContext.authority
    : projectedAuthority;
  const recommendedPosture: AionisAgentContext["recommended_posture"] = claimRequiresInspection
    ? "inspect_before_use"
    : claimActionable && args.agentContext.recommended_posture === "ignore_history"
      ? "use_as_context"
      : args.agentContext.recommended_posture;
  const risk = {
    negative_transfer_risk: claimRequiresInspection
      ? maxRisk(args.agentContext.risk.negative_transfer_risk, "medium")
      : args.agentContext.risk.negative_transfer_risk,
    blocked_authority_count: args.agentContext.risk.blocked_authority_count,
    stale_memory_count: args.agentContext.risk.stale_memory_count,
    reasons: mergeGuideStrings([
      ...args.agentContext.risk.reasons,
      "claim_ledger_projection_applied",
      ...(projection.do_not_use.length > 0 ? ["claim_ledger_blocked_or_superseded_claims_kept_out_of_use_now"] : []),
      ...(projection.inspect_before_use.length > 0 ? ["claim_ledger_contested_claims_require_inspection"] : []),
    ], 8),
  };
  const projected = AionisAgentContextSchema.parse({
    ...args.agentContext,
    history_used: args.agentContext.history_used || claimLedgerProjectionHasAnySurface(projection),
    actionable_history_used: args.agentContext.actionable_history_used || claimActionable,
    recommended_posture: recommendedPosture,
    authority,
    summary: args.agentContext.history_used || claimLedgerProjectionHasAnySurface(projection)
      ? args.agentContext.summary === "No reusable Aionis memory was found for this request."
        ? "Aionis recovered claim-ledger state for this request."
        : args.agentContext.summary
      : args.agentContext.summary,
    use_now: mergeGuideStrings([...claimUseNow, ...args.agentContext.use_now], 10),
    inspect_before_use: mergeGuideStrings([...args.agentContext.inspect_before_use, ...claimInspect], 10),
    do_not_use: mergeGuideStrings([...claimDoNotUse, ...args.agentContext.do_not_use], 10),
    risk,
  });
  return {
    context: AionisAgentContextSchema.parse({
      ...projected,
      prompt_text: renderMergedAgentPrompt({
        context: projected,
        contextCharBudget: args.contextCharBudget,
        agentContextMode: args.agentContextMode ?? projected.agent_context_mode,
        compilerPolicy: args.compilerPolicy,
      }),
    }),
    changed: true,
  };
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => typeof entry === "string" ? entry : null));
}

function buildGuideTraceId(): string {
  return `guide_trace:${randomUUID()}`;
}

function buildGuideExposureLedger(args: {
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): ProductGuideExposureLedger {
  return {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: args.guideTraceId,
    tenant_id: args.tenant_id,
    scope: args.scope,
    run_id: args.parsed.run_id ?? null,
    consumer_agent_id: args.parsed.consumer_agent_id ?? null,
    consumer_team_id: args.parsed.consumer_team_id ?? null,
    query_sha256: sha256Hex(args.parsed.query_text),
    context_sha256: sha256Hex(stableStringify(args.parsed.context ?? {})),
    memory_ids: args.agentContext.memory_ids,
    use_now_memory_ids: args.agentContext.use_now_memory_ids,
    inspect_before_use_memory_ids: args.agentContext.inspect_before_use_memory_ids,
    do_not_use_memory_ids: args.agentContext.do_not_use_memory_ids,
    rehydrate_memory_ids: args.agentContext.rehydrate_hints.map((hint) => hint.memory_id),
    prompt_char_count: args.agentContext.prompt_text.length,
    history_used: args.agentContext.history_used,
    actionable_history_used: args.agentContext.actionable_history_used,
    recommended_posture: args.agentContext.recommended_posture,
    authority: args.agentContext.authority,
  };
}

function parseGuideExposureLedger(value: unknown): ProductGuideExposureLedger | null {
  const record = objectValue(value);
  if (!record || record.contract_version !== "aionis_guide_exposure_v1") return null;
  const guideTraceId = typeof record.guide_trace_id === "string" && record.guide_trace_id.trim()
    ? record.guide_trace_id.trim()
    : null;
  const tenantId = typeof record.tenant_id === "string" && record.tenant_id.trim() ? record.tenant_id.trim() : null;
  const scope = typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : null;
  const querySha = typeof record.query_sha256 === "string" && record.query_sha256.trim() ? record.query_sha256.trim() : null;
  const contextSha = typeof record.context_sha256 === "string" && record.context_sha256.trim() ? record.context_sha256.trim() : null;
  const recommendedPosture = record.recommended_posture;
  const authority = record.authority;
  if (!guideTraceId || !tenantId || !scope || !querySha || !contextSha) return null;
  if (
    recommendedPosture !== "reuse_supported_history"
    && recommendedPosture !== "use_as_context"
    && recommendedPosture !== "inspect_before_use"
    && recommendedPosture !== "rehydrate_before_use"
    && recommendedPosture !== "ignore_history"
  ) return null;
  if (
    authority !== "trusted"
    && authority !== "advisory"
    && authority !== "candidate"
    && authority !== "blocked"
    && authority !== "none"
  ) return null;
  return {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: guideTraceId,
    tenant_id: tenantId,
    scope,
    run_id: typeof record.run_id === "string" && record.run_id.trim() ? record.run_id.trim() : null,
    consumer_agent_id: typeof record.consumer_agent_id === "string" && record.consumer_agent_id.trim() ? record.consumer_agent_id.trim() : null,
    consumer_team_id: typeof record.consumer_team_id === "string" && record.consumer_team_id.trim() ? record.consumer_team_id.trim() : null,
    query_sha256: querySha,
    context_sha256: contextSha,
    memory_ids: stringArrayField(record.memory_ids),
    use_now_memory_ids: stringArrayField(record.use_now_memory_ids),
    inspect_before_use_memory_ids: stringArrayField(record.inspect_before_use_memory_ids),
    do_not_use_memory_ids: stringArrayField(record.do_not_use_memory_ids),
    rehydrate_memory_ids: stringArrayField(record.rehydrate_memory_ids),
    prompt_char_count: Math.max(0, Math.trunc(Number(record.prompt_char_count) || 0)),
    history_used: record.history_used === true,
    actionable_history_used: record.actionable_history_used === true,
    recommended_posture: recommendedPosture,
    authority,
  };
}

function sameGuideExposureConsumer(left: ProductGuideExposureLedger, right: ProductGuideExposureLedger): boolean {
  return left.consumer_agent_id === right.consumer_agent_id && left.consumer_team_id === right.consumer_team_id;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function hasAnyAttributedUse(slots: Record<string, unknown>): boolean {
  return nonNegativeInt(slots.attributed_use_count) > 0
    || nonNegativeInt(slots.positive_attributed_use_count) > 0
    || nonNegativeInt(slots.feedback_positive) > 0
    || nonNegativeInt(slots.feedback_negative) > 0;
}

function guideExposureSurfaceIds(ledger: ProductGuideExposureLedger, surface: keyof Pick<
  ProductGuideExposureLedger,
  "use_now_memory_ids" | "inspect_before_use_memory_ids" | "do_not_use_memory_ids" | "rehydrate_memory_ids"
>): Set<string> {
  return new Set(ledger[surface]);
}

async function findMemoryNodeSlots(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  tenant_id: string;
  scope: string;
  memory_id: string;
  actor: string;
  consumerTeamId: string | null;
}): Promise<Record<string, unknown>> {
  const found = await dispatchProductInternalRoute({
    app: args.app,
    req: args.req,
    path: "/v1/memory/find",
    payload: {
      tenant_id: args.tenant_id,
      scope: args.scope,
      id: args.memory_id,
      consumer_agent_id: args.actor,
      ...(args.consumerTeamId ? { consumer_team_id: args.consumerTeamId } : {}),
      include_slots: true,
      limit: 1,
    },
  });
  if (!found.ok) {
    throw new Error(`unused exposure memory lookup failed for ${args.memory_id}`);
  }
  const body = objectValue(found.body);
  const node = Array.isArray(body?.nodes) ? objectValue(body.nodes[0]) : null;
  return objectValue(node?.slots) ?? {};
}

async function findHistoricalGuideExposureLedgers(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  tenant_id: string;
  scope: string;
  actor: string;
  consumerTeamId: string | null;
}): Promise<ProductGuideExposureLedger[]> {
  const ledgerRows: unknown[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const ledgersResult = await dispatchProductInternalRoute({
      app: args.app,
      req: args.req,
      path: "/v1/memory/find",
      payload: {
        tenant_id: args.tenant_id,
        scope: args.scope,
        type: "evidence",
        memory_lane: "shared",
        consumer_agent_id: args.actor,
        ...(args.consumerTeamId ? { consumer_team_id: args.consumerTeamId } : {}),
        include_slots: true,
        slots_contains: {
          guide_exposure_v1: {
            contract_version: "aionis_guide_exposure_v1",
          },
        },
        limit: 200,
        offset,
      },
    });
    if (!ledgersResult.ok) {
      throw new Error("guide exposure ledger lookup failed");
    }
    const body = objectValue(ledgersResult.body);
    if (Array.isArray(body?.nodes)) ledgerRows.push(...body.nodes);
    const page = objectValue(body?.page);
    if (page?.has_more !== true) break;
  }
  return ledgerRows
    .map((row) => parseGuideExposureLedger(objectValue(objectValue(row)?.slots)?.guide_exposure_v1))
    .filter((entry): entry is ProductGuideExposureLedger => !!entry)
    .filter((entry) => entry.tenant_id === args.tenant_id && entry.scope === args.scope);
}

function parseAgentContextObservedTime(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function resolveRepeatedUnusedActiveProjectionIds(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  tenant_id: string;
  scope: string;
  actor: string;
  currentLedger: ProductGuideExposureLedger;
  historicalLedgers: ProductGuideExposureLedger[];
}): Promise<string[]> {
  const exposureThreshold = 2;
  const useNowIds = uniqueStrings(args.currentLedger.use_now_memory_ids);
  const candidates: string[] = [];
  for (const memoryId of useNowIds) {
    let useNowExposureCount = 0;
    for (const ledger of args.historicalLedgers) {
      if (ledger.guide_trace_id === args.currentLedger.guide_trace_id) continue;
      if (!sameGuideExposureConsumer(ledger, args.currentLedger)) continue;
      if (guideExposureSurfaceIds(ledger, "use_now_memory_ids").has(memoryId)) {
        useNowExposureCount += 1;
      }
    }
    if (useNowExposureCount < exposureThreshold) continue;
    const slots = await findMemoryNodeSlots({
      app: args.app,
      req: args.req,
      tenant_id: args.tenant_id,
      scope: args.scope,
      memory_id: memoryId,
      actor: args.actor,
      consumerTeamId: args.currentLedger.consumer_team_id,
    });
    if (hasAnyAttributedUse(slots)) continue;
    candidates.push(memoryId);
  }
  return uniqueStrings(candidates);
}

async function resolveTimeDecayActiveProjectionIds(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  tenant_id: string;
  scope: string;
  actor: string;
  consumerTeamId: string | null;
  memoryPacket: AionisMemoryPacket | null;
  agentContext: AionisAgentContext;
}): Promise<string[]> {
  const memoryEntries = args.memoryPacket?.relevant_memories ?? [];
  const observedTimes = memoryEntries
    .map((entry) => parseAgentContextObservedTime(entry.observed_at))
    .filter((entry): entry is number => entry !== null);
  if (observedTimes.length === 0) return [];
  const referenceObservedTime = Math.max(...observedTimes);
  const currentUseNowIds = new Set(args.agentContext.use_now_memory_ids);
  const candidates: string[] = [];
  for (const entry of memoryEntries) {
    if (!currentUseNowIds.has(entry.memory_id)) continue;
    if (entry.lifecycle_state !== "active") continue;
    if (entry.authority !== "trusted" && entry.authority !== "advisory") continue;
    const observedTime = parseAgentContextObservedTime(entry.observed_at);
    if (observedTime === null || observedTime >= referenceObservedTime) continue;
    const ageDays = Math.floor((referenceObservedTime - observedTime) / (24 * 60 * 60 * 1000));
    if (ageDays < AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS) continue;
    const slots = await findMemoryNodeSlots({
      app: args.app,
      req: args.req,
      tenant_id: args.tenant_id,
      scope: args.scope,
      memory_id: entry.memory_id,
      actor: args.actor,
      consumerTeamId: args.consumerTeamId,
    });
    if (nonNegativeInt(slots.positive_attributed_use_count) > 0) continue;
    candidates.push(entry.memory_id);
  }
  return uniqueStrings(candidates);
}

async function resolveInspectBeforeUseActiveProjectionIds(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  env: Env;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  memoryPacket: AionisMemoryPacket | null;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): Promise<string[]> {
  const actor = args.parsed.consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID;
  const currentLedger = buildGuideExposureLedger({
    parsed: args.parsed,
    tenant_id: args.tenant_id,
    scope: args.scope,
    agentContext: args.agentContext,
    guideTraceId: args.guideTraceId,
  });
  const historicalLedgers = await findHistoricalGuideExposureLedgers({
    app: args.app,
    req: args.req,
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor,
    consumerTeamId: args.parsed.consumer_team_id ?? null,
  });
  const repeatedUnusedIds = await resolveRepeatedUnusedActiveProjectionIds({
    app: args.app,
    req: args.req,
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor,
    currentLedger,
    historicalLedgers,
  });
  const timeDecayIds = await resolveTimeDecayActiveProjectionIds({
    app: args.app,
    req: args.req,
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor,
    consumerTeamId: args.parsed.consumer_team_id ?? null,
    memoryPacket: args.memoryPacket,
    agentContext: args.agentContext,
  });
  return uniqueStrings([...repeatedUnusedIds, ...timeDecayIds]);
}

async function resolveAdmissionCandidatePolicyGuideProjection(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  env: Env;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  memoryPacket: AionisMemoryPacket | null;
  agentContext: AionisAgentContext;
  mode: "shadow" | "active";
}): Promise<AionisAdmissionCandidatePolicyActiveProjection | null> {
  const currentUseNowIds = uniqueStrings(args.agentContext.use_now_memory_ids);
  if (!args.memoryPacket) return null;
  const actor = args.parsed.consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID;
  const slotByMemoryId = new Map<string, Record<string, unknown>>();
  for (const memoryId of currentUseNowIds) {
    try {
      slotByMemoryId.set(
        memoryId,
        await findMemoryNodeSlots({
          app: args.app,
          req: args.req,
          tenant_id: args.tenant_id,
          scope: args.scope,
          memory_id: memoryId,
          actor,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
        }),
      );
    } catch {
      slotByMemoryId.set(memoryId, {});
    }
  }
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: args.agentContext,
    memory_packet: args.memoryPacket,
    slot_by_memory_id: slotByMemoryId,
    mode: args.mode,
  });
  if (projection.hard_boundary_upgrade_count > 0) return null;
  return projection;
}

async function buildUnusedExposureObservation(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  env: Env;
  parsed: ProductForgetInput;
  guideExposure: Extract<ProductGuideExposureResolution, { ok: true }>;
}): Promise<ProductUnusedExposureObservation> {
  const ledger = args.guideExposure.ledger;
  const actor = ledger.consumer_agent_id ?? args.parsed.actor ?? args.env.LITE_LOCAL_ACTOR_ID;
  const consumerTeamId = ledger.consumer_team_id;
  const exposureThreshold = 2;
  const historicalLedgers = await findHistoricalGuideExposureLedgers({
    app: args.app,
    req: args.req,
    tenant_id: ledger.tenant_id,
    scope: ledger.scope,
    actor,
    consumerTeamId,
  });
  const ledgers = [
    ledger,
    ...historicalLedgers
      .filter((entry) =>
        entry.guide_trace_id !== ledger.guide_trace_id
        && sameGuideExposureConsumer(entry, ledger)
      ),
  ];

  const currentMemoryIds = ledger.memory_ids;
  const currentUnattributed = new Set(args.guideExposure.unattributedRecalledMemoryIds);
  const stats: ProductUnusedExposureObservation["memory_stats"] = [];
  for (const memoryId of currentMemoryIds) {
    const slots = await findMemoryNodeSlots({
      app: args.app,
      req: args.req,
      tenant_id: ledger.tenant_id,
      scope: ledger.scope,
      memory_id: memoryId,
      actor,
      consumerTeamId,
    });
    let exposureCount = 0;
    let useNowExposureCount = 0;
    let inspectExposureCount = 0;
    let doNotUseExposureCount = 0;
    let rehydrateExposureCount = 0;
    for (const exposure of ledgers) {
      if (!exposure.memory_ids.includes(memoryId)) continue;
      exposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "use_now_memory_ids").has(memoryId)) useNowExposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "inspect_before_use_memory_ids").has(memoryId)) inspectExposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "do_not_use_memory_ids").has(memoryId)) doNotUseExposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "rehydrate_memory_ids").has(memoryId)) rehydrateExposureCount += 1;
    }
    const positiveAttributedUseCount = nonNegativeInt(slots.positive_attributed_use_count);
    const isCurrentUnattributed = currentUnattributed.has(memoryId);
    stats.push({
      memory_id: memoryId,
      current_unattributed: isCurrentUnattributed,
      exposure_count: exposureCount,
      use_now_exposure_count: useNowExposureCount,
      inspect_before_use_exposure_count: inspectExposureCount,
      do_not_use_exposure_count: doNotUseExposureCount,
      rehydrate_exposure_count: rehydrateExposureCount,
      positive_attributed_use_count: positiveAttributedUseCount,
      feedback_positive_count: nonNegativeInt(slots.feedback_positive),
      feedback_negative_count: nonNegativeInt(slots.feedback_negative),
      repeated_without_positive_attribution:
        isCurrentUnattributed && exposureCount >= exposureThreshold && positiveAttributedUseCount === 0,
    });
  }
  const repeatedUnattributed = stats
    .filter((entry) => entry.current_unattributed && entry.exposure_count >= exposureThreshold)
    .map((entry) => entry.memory_id);
  const repeatedWithoutPositive = stats
    .filter((entry) => entry.repeated_without_positive_attribution)
    .map((entry) => entry.memory_id);
  return {
    contract_version: "aionis_unused_exposure_observation_v1",
    mode: "read_only_measure",
    exposure_threshold: exposureThreshold,
    guide_trace_count: ledgers.length,
    tracked_memory_count: currentMemoryIds.length,
    repeated_unattributed_memory_ids: repeatedUnattributed,
    repeated_unattributed_without_positive_memory_ids: repeatedWithoutPositive,
    memory_stats: stats,
    reason: "Repeated exposure without host positive attribution is reported as read-only evidence; it does not lower authority or suppress memory.",
  };
}

async function persistUnusedExposureLearningControl(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  parsed: ProductForgetInput;
  guideExposure: Extract<ProductGuideExposureResolution, { ok: true }>;
  unusedExposureObservation: ProductUnusedExposureObservation;
}): Promise<ProductFeedbackLearningControlPersistence | null> {
  const candidates = args.unusedExposureObservation.memory_stats.filter((entry) =>
    entry.repeated_without_positive_attribution
    && entry.positive_attributed_use_count === 0
  );
  if (candidates.length === 0) return null;

  const result = await args.liteWriteStore.withTx(() =>
    applyUnusedExposureLearningControlLite(
      args.liteWriteStore,
      {
        tenant_id: args.guideExposure.ledger.tenant_id,
        scope: args.guideExposure.ledger.scope,
        actor: args.guideExposure.ledger.consumer_agent_id ?? args.parsed.actor ?? args.env.LITE_LOCAL_ACTOR_ID,
        consumer_team_id: args.guideExposure.ledger.consumer_team_id,
        run_id: args.parsed.run_id ?? null,
        guide_trace_id: args.guideExposure.ledger.guide_trace_id,
        reason: "Repeated guide exposure without positive host attribution should be inspected before direct reuse.",
        memory_stats: candidates,
      },
      args.env.MEMORY_SCOPE,
      args.env.MEMORY_TENANT_ID,
      {
        maxTextLen: args.env.MAX_TEXT_LEN,
        piiRedaction: args.env.PII_REDACTION,
        defaultActor: args.env.LITE_LOCAL_ACTOR_ID,
      },
    )
  );
  return result.changed_count > 0 ? result : null;
}

async function writeGuideExposureLedger(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  env: Env;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): Promise<InternalDispatchResult> {
  const ledger = buildGuideExposureLedger({
    parsed: args.parsed,
    tenant_id: args.tenant_id,
    scope: args.scope,
    agentContext: args.agentContext,
    guideTraceId: args.guideTraceId,
  });
  const ledgerSha = sha256Hex(stableStringify(ledger));
  return dispatchProductInternalRoute({
    app: args.app,
    req: args.req,
    path: "/v1/memory/write",
    payload: {
      tenant_id: args.tenant_id,
      scope: args.scope,
      actor: args.parsed.consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID,
      input_text: `Aionis guide exposure ledger ${args.guideTraceId}`,
      input_sha256: ledgerSha,
      auto_embed: false,
      distill: { enabled: false },
      nodes: [stripUndefined({
        client_id: args.guideTraceId,
        type: "evidence",
        tier: "archive",
        memory_lane: "shared",
        producer_agent_id: "aionis-runtime",
        owner_agent_id: args.parsed.consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID,
        owner_team_id: args.parsed.consumer_team_id,
        title: "Guide exposure ledger",
        text_summary: `Guide exposure ledger ${args.guideTraceId}`,
        salience: 0,
        importance: 0,
        confidence: 1,
        slots: {
          guide_exposure_v1: ledger,
          not_agent_facing: true,
        },
      })],
      edges: [],
    },
  });
}

async function resolveGuideExposureForActivation(args: {
  app: FastifyInstance;
  req: FastifyRequest;
  parsed: ProductForgetInput;
  env: Env;
}): Promise<ProductGuideExposureResolution | null> {
  if (args.parsed.operation !== "activate" || !args.parsed.guide_trace_id) return null;
  const tenantId = args.parsed.tenant_id ?? args.env.MEMORY_TENANT_ID;
  const scope = args.parsed.scope ?? args.env.MEMORY_SCOPE;
  const actor = args.parsed.actor ?? args.env.LITE_LOCAL_ACTOR_ID;
  const found = await dispatchProductInternalRoute({
    app: args.app,
    req: args.req,
    path: "/v1/memory/find",
    payload: {
      tenant_id: tenantId,
      scope,
      client_id: args.parsed.guide_trace_id,
      consumer_agent_id: actor,
      include_slots: true,
      limit: 1,
    },
  });
  if (!found.ok) {
    return {
      ok: false,
      statusCode: found.statusCode,
      body: objectValue(found.body) ?? productErrorResponse({
        status: found.statusCode,
        error: "guide_trace_lookup_failed",
        message: "guide trace lookup failed",
        details: { guide_trace_id: args.parsed.guide_trace_id },
      }),
    };
  }
  const body = objectValue(found.body);
  const node = Array.isArray(body?.nodes) ? objectValue(body.nodes[0]) : null;
  const slots = objectValue(node?.slots);
  const ledger = parseGuideExposureLedger(slots?.guide_exposure_v1);
  if (!ledger) {
    return {
      ok: false,
      statusCode: 400,
      body: productErrorResponse({
        status: 400,
        error: "guide_trace_not_found",
        message: "guide_trace_id does not resolve to a valid Aionis guide exposure ledger",
        details: { guide_trace_id: args.parsed.guide_trace_id },
        topLevel: { guide_trace_id: args.parsed.guide_trace_id },
      }),
    };
  }
  const requestedUsedMemoryIds = uniqueStrings([
    ...(args.parsed.used_memory_ids ?? []),
    ...(args.parsed.memory_ids ?? []),
    ...(args.parsed.node_ids ?? []),
  ]);
  const exposed = new Set(ledger.memory_ids);
  const notExposed = requestedUsedMemoryIds.filter((id) => !exposed.has(id));
  if (notExposed.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      body: productErrorResponse({
        status: 400,
        error: "guide_trace_used_memory_not_exposed",
        message: "activate feedback can only be attributed to memory ids exposed by the referenced guide_trace_id",
        details: {
          guide_trace_id: ledger.guide_trace_id,
          not_exposed_memory_ids: notExposed,
        },
        topLevel: {
          guide_trace_id: ledger.guide_trace_id,
          not_exposed_memory_ids: notExposed,
        },
      }),
    };
  }
  const used = new Set(requestedUsedMemoryIds);
  const unattributed = (ids: string[]) => ids.filter((id) => !used.has(id));
  return {
    ok: true,
    ledger,
    usedMemoryIds: requestedUsedMemoryIds,
    unattributedRecalledMemoryIds: unattributed(ledger.memory_ids),
    unattributedUseNowMemoryIds: unattributed(ledger.use_now_memory_ids),
    unattributedInspectBeforeUseMemoryIds: unattributed(ledger.inspect_before_use_memory_ids),
    unattributedDoNotUseMemoryIds: unattributed(ledger.do_not_use_memory_ids),
    unattributedRehydrateMemoryIds: unattributed(ledger.rehydrate_memory_ids),
  };
}

function productForgetNodeIds(parsed: ProductForgetInput, guideExposure?: ProductGuideExposureResolution | null): string[] {
  if (guideExposure?.ok) return guideExposure.usedMemoryIds;
  return uniqueStrings([
    ...(parsed.used_memory_ids ?? []),
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

function productForgetPayload(
  parsed: ProductForgetInput,
  target: ProductForgetTarget,
  guideExposure?: ProductGuideExposureResolution | null,
): Record<string, unknown> {
  const payload = parsed.payload ?? {};
  const nodeIds = productForgetNodeIds(parsed, guideExposure);
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
      consumer_team_id: guideExposure?.ok
        ? guideExposure.ledger.consumer_team_id ?? payload.consumer_team_id
        : payload.consumer_team_id,
      run_id: parsed.run_id ?? payload.run_id,
      outcome: parsed.outcome ?? payload.outcome,
      activate: parsed.activate ?? payload.activate,
      reason: parsed.reason,
      input_text: typeof payload.input_text === "string" ? payload.input_text : parsed.reason,
      input_sha256: payload.input_sha256,
      used_surface: parsed.used_surface ?? payload.used_surface,
      verifier_status: parsed.verifier_status ?? payload.verifier_status,
      tool_status: parsed.tool_status ?? payload.tool_status,
      runtime_signal_refs: parsed.runtime_signal_refs ?? payload.runtime_signal_refs,
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
  guideExposure?: ProductGuideExposureResolution | null;
  unusedExposureObservation?: ProductUnusedExposureObservation | null;
  feedbackLearningControlPersistence?: ProductFeedbackLearningControlPersistence | null;
}) {
  const nodeIds = productForgetNodeIds(args.parsed, args.guideExposure);
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
    guide_trace: args.parsed.operation === "activate" && args.guideExposure?.ok ? {
      guide_trace_id: args.guideExposure.ledger.guide_trace_id,
      exposed_memory_ids: args.guideExposure.ledger.memory_ids,
      exposed_memory_count: args.guideExposure.ledger.memory_ids.length,
      attributed_memory_ids: args.guideExposure.usedMemoryIds,
      attributed_memory_count: args.guideExposure.usedMemoryIds.length,
      unattributed_recalled_memory_ids: args.guideExposure.unattributedRecalledMemoryIds,
      unattributed_recalled_memory_count: args.guideExposure.unattributedRecalledMemoryIds.length,
      unattributed_use_now_memory_ids: args.guideExposure.unattributedUseNowMemoryIds,
      unattributed_inspect_before_use_memory_ids: args.guideExposure.unattributedInspectBeforeUseMemoryIds,
      unattributed_do_not_use_memory_ids: args.guideExposure.unattributedDoNotUseMemoryIds,
      unattributed_rehydrate_memory_ids: args.guideExposure.unattributedRehydrateMemoryIds,
      unused_exposure_observation: args.unusedExposureObservation ?? undefined,
      feedback_learning_control: args.feedbackLearningControlPersistence ?? undefined,
    } : undefined,
    attribution: args.parsed.operation === "activate" ? stripUndefined({
      run_id: args.parsed.run_id,
      outcome: args.parsed.outcome,
      used_surface: args.parsed.used_surface,
      verifier_status: args.parsed.verifier_status,
      tool_status: args.parsed.tool_status,
      runtime_signal_refs: args.parsed.runtime_signal_refs,
    }) : undefined,
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
  const actionableHistoryUsed =
    snapshot.agent_context?.actionable_history_used === true
    || guidePacket?.guide_brief.actionable_history_used === true;
  const reducesDiscovery = guidePacket?.guide_brief.expected_product_effects.reduces_repeated_discovery === true;
  if (actionableHistoryUsed && reducesDiscovery) return 0;
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

function productSkillCandidateEffectReportFromRequest(parsed: z.infer<typeof ProductSkillCandidateEnqueueRequest>): AionisEffectReport {
  if (parsed.effect_report !== undefined) {
    return AionisEffectReportSchema.parse(parsed.effect_report);
  }
  const measure = objectValue(parsed.measure_result);
  return AionisEffectReportSchema.parse(measure?.effect_report);
}

function productTraceDerivedSkillCandidates(report: AionisEffectReport): TraceDerivedSkillTrainingCandidate[] {
  return report.training_candidates.filter((candidate): candidate is TraceDerivedSkillTrainingCandidate => {
    const skill = candidate.trace_derived_skill;
    return candidate.candidate_type === "trace_derived_skill"
      && !!skill
      && skill.contract_version === "aionis_trace_derived_skill_candidate_v1";
  });
}

function productSkillCandidateReviewResponse(args: {
  route: string;
  tenantId: string;
  scope: string;
  rows: unknown[];
  inserted?: number;
  updated?: number;
}) {
  return {
    contract_version: "aionis_trace_derived_skill_review_result_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    candidates: args.rows,
    candidate_count: args.rows.length,
    inserted_count: args.inserted ?? undefined,
    updated_count: args.updated ?? undefined,
    safety: {
      agent_prompt_included: false,
      memory_runtime_mutation: false,
      required_gate: "admission_and_promotion_gate",
    },
    source_map: {
      routes_used: [args.route],
      internal_surfaces_used: ["trace_derived_skill_candidate_review"],
      omitted_internal_surfaces: [
        "agent_prompt_text",
        "raw_memory_rows",
        "raw_slots",
        "raw_embedding_vectors",
      ],
    },
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
    liteWriteStore,
    claimLedgerAccess,
    skillCandidateReviewAccess,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

  assertLocalStoreRuntimeEdition(env, "local-store product facade routes");

  app.post("/v1/observe", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "write");
    const parsed = ProductObserveRequest.parse(body);
    const writeBundle = observeWritePayload(parsed);
    const writePayload = writeBundle?.payload ?? null;
    const handoffPayload = parsed.handoff ? mergeProductScope(parsed, parsed.handoff) : null;
    const hasClaims = (parsed.claims?.length ?? 0) > 0;
    if (!writePayload && !handoffPayload && !hasClaims) {
      return reply.code(400).send(productErrorResponse({
        status: 400,
        error: "observe_requires_memory_or_handoff",
        message: "observe requires memory input, handoff payload, or explicit claims",
      }));
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

    const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
    const scope = parsed.scope ?? env.MEMORY_SCOPE;
    const claimOnlyWrite = hasClaims && !writePayload && !handoffPayload;
    const claimOnlyGate = claimOnlyWrite ? await acquireInflightSlot("write") : null;
    let claimLedger: Awaited<ReturnType<typeof writeProductObserveClaims>> = null;
    try {
      if (claimOnlyWrite) {
        await enforceRateLimit(req, reply, "write");
        await enforceTenantQuota(req, reply, "write", tenantId);
      }
      claimLedger = await writeProductObserveClaims({
        claimLedgerAccess,
        parsed,
        write,
        tenantId,
        scope,
      });
    } finally {
      claimOnlyGate?.release();
    }
    if (claimLedger && !claimLedger.ok) {
      return reply.code(claimLedger.statusCode).send(claimLedger.body);
    }

    return reply.code(200).send({
      contract_version: "aionis_observe_result_v1",
      tenant_id: tenantId,
      scope,
      observed: {
        memory_written: !!write,
        handoff_stored: !!handoff,
        ...(claimLedger ? { claim_count: claimLedger.receipt.written_count } : {}),
        general_memory_count: writeBundle?.structuring.general_memory_count ?? 0,
        execution_memory_count: writeBundle?.structuring.execution_workflow_count ?? 0,
        auto_text_memory_count: writeBundle?.structuring.auto_text_node_count ?? 0,
        execution_observation_count: writeBundle?.structuring.execution_observation_count ?? 0,
      },
      structured_memory: writeBundle?.structuring ?? null,
      ...(claimLedger ? { claim_ledger: claimLedger.receipt } : {}),
      memory_write: write?.body ?? null,
      handoff: handoff?.body ?? null,
      source_map: {
        routes_used: routesUsed,
        internal_surfaces_used: [
          ...(write ? ["memory_write"] : []),
          ...(handoff ? ["handoff_store"] : []),
          ...(claimLedger ? ["claim_ledger_write"] : []),
        ],
      },
    });
  });

  app.post("/v1/guide", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const requestBody = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductGuideRequest.parse(requestBody);
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
    const planningContextEmbeddingUnavailable = isPlanningContextNoEmbeddingProvider(guide);
    if (!guide.ok && !planningContextEmbeddingUnavailable) return sendInternalFailure(reply, guide);
    const guideBody = guide.body && typeof guide.body === "object" && !Array.isArray(guide.body)
      ? guide.body as Record<string, unknown>
      : {};
    const recall = guideBody.recall && typeof guideBody.recall === "object" && !Array.isArray(guideBody.recall)
      ? guideBody.recall as Record<string, unknown>
      : {};
    let memoryPacket: AionisMemoryPacket | null = recall.aionis_memory_packet
      ? AionisMemoryPacketSchema.parse(recall.aionis_memory_packet)
      : null;
    const guidePacket: AionisGuidePacket | null = guideBody.aionis_guide_packet
      ? AionisGuidePacketSchema.parse(guideBody.aionis_guide_packet)
      : null;
    const agentRole = productGuideAgentRole(parsed);
    const tenantId = String(guideBody.tenant_id ?? parsed.tenant_id ?? env.MEMORY_TENANT_ID);
    const scope = String(guideBody.scope ?? parsed.scope ?? env.MEMORY_SCOPE);
    const tenancy = resolveTenantScope(
      { tenant_id: tenantId, scope },
      { defaultTenantId: env.MEMORY_TENANT_ID, defaultScope: env.MEMORY_SCOPE },
    );
    const fullPowerRequested = productGuideFullPowerRequested(parsed);
    const agentContextMode = productGuideAgentContextMode(parsed);
    const taskContextProfile = productGuideTaskContextProfile(parsed);
    const taskContextProfilePolicy = productGuideTaskContextProfileCompilerPolicy({
      profile: taskContextProfile,
      agentContextMode,
      explicitContextCharBudget: parsed.context_char_budget,
    });
    let fullPowerStructuredMemoryMerged = false;
    if (fullPowerRequested) {
      const structuredExecutionPacket = await buildProductGuideStructuredExecutionPacket({
        liteWriteStore,
        parsed,
        tenant_id: tenantId,
        public_scope: scope,
        store_scope: tenancy.scope_key,
      });
      const mergedPacket = mergeAionisMemoryPackets(memoryPacket, structuredExecutionPacket);
      memoryPacket = mergedPacket.packet;
      fullPowerStructuredMemoryMerged = mergedPacket.changed;
    }
    let agentContext: AionisAgentContext = buildAionisAgentContext({
      tenant_id: tenantId,
      scope,
      agent_role: agentRole,
      memory_packet: memoryPacket,
      guide_packet: guidePacket,
      query_intent_override: parsed.query_text,
      agent_context_mode: agentContextMode,
      context_char_budget: taskContextProfilePolicy.contextCharBudget,
      context_compaction_profile: parsed.context_compaction_profile ?? parsed.context_optimization_profile ?? null,
      task_context_profile: taskContextProfile,
    });
    let fullPowerExecutionContextMerged = false;
    if (fullPowerRequested) {
      const executionContextResult = await dispatchProductInternalRoute({
        app,
        req,
        path: "/v1/execution/context/assemble",
        payload: stripUndefined({
          tenant_id: tenantId,
          scope,
          consumer_agent_id: parsed.consumer_agent_id,
          consumer_team_id: parsed.consumer_team_id,
          execution_tree_v1: parsed.execution_tree_v1,
          context_mode: "full_power",
          prompt_detail: "compact",
          include_memory_evidence: true,
          include_prompt_text: false,
          include_agent_context: true,
          agent_context_char_budget: taskContextProfilePolicy.executionContextCharBudget,
          memory_filters: productGuideExecutionMemoryFilters(parsed),
        }),
      });
      if (!executionContextResult.ok) return sendInternalFailure(reply, executionContextResult);
      const executionContextBody = objectValue(executionContextResult.body);
      const executionAgentContext = executionContextBody?.agent_context
        ? AionisAgentContextSchema.parse(executionContextBody.agent_context)
        : null;
      const merged = mergeProductGuideAgentContexts({
        base: agentContext,
        execution: executionAgentContext,
        contextCharBudget: taskContextProfilePolicy.contextCharBudget,
        agentContextMode,
        compilerPolicy: taskContextProfilePolicy,
      });
      agentContext = merged.context;
      fullPowerExecutionContextMerged = merged.changed;
    }
    const claimLedgerProjection = await buildProductGuideClaimLedgerProjection({
      claimLedgerAccess,
      tenantId,
      scope,
      queryText: parsed.query_text,
    });
    const claimLedgerContextProjection = applyClaimLedgerProjectionToAgentContext({
      agentContext,
      projection: claimLedgerProjection,
      contextCharBudget: taskContextProfilePolicy.contextCharBudget,
      agentContextMode,
      compilerPolicy: taskContextProfilePolicy,
    });
    agentContext = claimLedgerContextProjection.context;
    const guideTraceId = buildGuideTraceId();
    let activeProjectionApplied = false;
    if (env.AIONIS_INSPECT_BEFORE_USE_MODE === "active") {
      const activeProjectionMemoryIds = await resolveInspectBeforeUseActiveProjectionIds({
        app,
        req,
        env,
        parsed,
        tenant_id: tenantId,
        scope,
        memoryPacket,
        agentContext,
        guideTraceId,
      });
      const projectedContext = applyAionisInspectBeforeUseActiveProjection({
        agent_context: agentContext,
        memory_packet: memoryPacket,
        candidate_memory_ids: activeProjectionMemoryIds,
        reason: "inspect_before_use_active_projection",
        context_char_budget: taskContextProfilePolicy.contextCharBudget,
        context_compaction_profile: parsed.context_compaction_profile ?? parsed.context_optimization_profile ?? null,
      });
      activeProjectionApplied = projectedContext !== agentContext;
      agentContext = projectedContext;
    }
    let admissionCandidatePolicyProjection: AionisAdmissionCandidatePolicyActiveProjection | null = null;
    let admissionCandidatePolicyProjectionApplied = false;
    const admissionCandidatePolicyMode = resolveAdmissionCandidatePolicyGuideMode({
      env,
      parsed,
      scope,
      agentRole,
    });
    if (admissionCandidatePolicyMode.mode === "shadow" || admissionCandidatePolicyMode.mode === "active") {
      admissionCandidatePolicyProjection = await resolveAdmissionCandidatePolicyGuideProjection({
        app,
        req,
        env,
        parsed,
        tenant_id: tenantId,
        scope,
        memoryPacket,
        agentContext,
        mode: admissionCandidatePolicyMode.mode,
      });
      if (admissionCandidatePolicyMode.mode === "active" && admissionCandidatePolicyProjection) {
        const projectedContext = applyAionisInspectBeforeUseActiveProjection({
          agent_context: agentContext,
          memory_packet: memoryPacket,
          candidate_memory_ids: admissionCandidatePolicyProjection.downgraded_memory_ids,
          reason: AIONIS_ADMISSION_CANDIDATE_POLICY_ACTIVE_PROJECTION_REASON,
          context_char_budget: taskContextProfilePolicy.contextCharBudget,
          context_compaction_profile: parsed.context_compaction_profile ?? parsed.context_optimization_profile ?? null,
        });
        admissionCandidatePolicyProjectionApplied = projectedContext !== agentContext;
        agentContext = projectedContext;
      }
    }
    const exposureWrite = await writeGuideExposureLedger({
      app,
      req,
      parsed,
      tenant_id: tenantId,
      scope,
      env,
      agentContext,
      guideTraceId,
    });
    if (!exposureWrite.ok) return sendInternalFailure(reply, exposureWrite);
    const includePackets = parsed.include_packets === true;
    const premiseFirewallVisible = productGuidePremiseFirewallVisible(agentContext);
    const memoryContractVisible = productGuideMemoryContractVisible(memoryPacket);

    return reply.code(200).send({
      contract_version: "aionis_guide_result_v1",
      tenant_id: tenantId,
      scope,
      consumer_agent_id: parsed.consumer_agent_id ?? env.LITE_LOCAL_ACTOR_ID,
      ...(parsed.consumer_team_id ? { consumer_team_id: parsed.consumer_team_id } : {}),
      guide_trace_id: guideTraceId,
      agent_context: agentContext,
      ...(claimLedgerProjection ? { claim_ledger_projection: claimLedgerProjection } : {}),
      ...(admissionCandidatePolicyProjection ? { admission_candidate_policy_projection: admissionCandidatePolicyProjection } : {}),
      ...(includePackets ? {
        memory_packet: memoryPacket,
        guide_packet: guidePacket,
      } : {}),
      source_map: {
        routes_used: [
          "/v1/memory/planning/context",
          ...(fullPowerRequested ? ["/v1/execution/context/assemble"] : []),
          "/v1/memory/write",
        ],
        internal_surfaces_used: [
          ...(planningContextEmbeddingUnavailable ? ["planning_context_embedding_unavailable"] : ["recall"]),
          "product_packets",
          "agent_context_compiler",
          ...(agentRole !== "agent" ? ["role_aware_agent_context"] : []),
          ...(fullPowerRequested ? ["full_power_execution_context"] : []),
          ...(fullPowerStructuredMemoryMerged ? ["full_power_structured_execution_recall"] : []),
          ...(fullPowerExecutionContextMerged ? ["full_power_agent_context_merge"] : []),
          ...(claimLedgerProjection ? ["claim_ledger_projection"] : []),
          ...(claimLedgerContextProjection.changed ? ["claim_ledger_agent_context_projection"] : []),
          ...(agentContextMode === "compact_agent" ? ["compact_agent_context"] : []),
          ...(activeProjectionApplied ? ["inspect_before_use_active_projection"] : []),
          ...(admissionCandidatePolicyProjection && admissionCandidatePolicyMode.mode === "shadow"
            ? ["admission_candidate_policy_shadow_projection"]
            : []),
          ...(admissionCandidatePolicyProjectionApplied ? ["admission_candidate_policy_active_projection"] : []),
          ...(admissionCandidatePolicyProjection && admissionCandidatePolicyMode.source === "profile_rule"
            ? [`admission_candidate_policy_profile_${admissionCandidatePolicyMode.mode}_projection`]
            : []),
          ...(memoryContractVisible ? ["memory_contract"] : []),
          ...(premiseFirewallVisible ? ["premise_firewall"] : []),
          "guide_exposure_ledger",
        ],
        omitted_internal_surfaces: [
          "internal_planning_details",
          "internal_learning_diagnostics",
          "internal_execution_recommendation_details",
          "internal_cost_diagnostics",
          ...(fullPowerRequested ? [
            "full_power_execution_prompt_text",
            "full_power_raw_evidence",
            "full_power_gated_abstractions",
            "full_power_trace",
          ] : []),
          ...(includePackets ? [] : ["memory_packet", "guide_packet"]),
          ...(planningContextEmbeddingUnavailable ? ["semantic_planning_recall"] : []),
        ],
        admission_candidate_policy: {
          mode: admissionCandidatePolicyMode.mode,
          source: admissionCandidatePolicyMode.source,
          ...(admissionCandidatePolicyMode.profile_id ? { profile_id: admissionCandidatePolicyMode.profile_id } : {}),
        },
      },
    });
  });

  app.post("/v1/memory/govern", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductMemoryAdmissionRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
      const scope = parsed.scope ?? env.MEMORY_SCOPE;
      const external = governExternalMemoryCandidates({
        tenant_id: tenantId,
        scope,
        run_id: parsed.run_id,
        query_text: parsed.query_text,
        candidates: parsed.candidates,
        mode: parsed.mode,
        context_mode: parsed.context_mode,
      });
      return reply.code(200).send({
        contract_version: external.contract_version,
        tenant_id: tenantId,
        scope,
        run_id: external.run_id,
        mode: external.mode,
        agent_context: external.agent_context,
        memory_use_receipt: external.memory_use_receipt,
        ...(parsed.include_records === true ? { memory_admission_records: external.memory_admission_records } : {}),
        ...(external.memory_firewall ? { memory_firewall: external.memory_firewall } : {}),
        admission_summary: external.admission_summary,
        source_map: external.source_map,
      });
    } finally {
      gate.release();
    }
  });

  const handleProductLifecycle = async (
    req: ProductFacadeRequest,
    reply: FastifyReply,
    parsed: ProductForgetInput,
    surface: ProductLifecycleSurface,
  ) => {
    const guideExposure = await resolveGuideExposureForActivation({ app, req, parsed, env });
    if (guideExposure && !guideExposure.ok) {
      return reply.code(guideExposure.statusCode).send(guideExposure.body);
    }
    const target = productForgetTarget(parsed);
    const route = productForgetRoute(parsed, target);
    const forgetPayload = productForgetPayload(parsed, target, guideExposure);
    const result = await dispatchProductInternalRoute({
      app,
      req,
      path: route,
      payload: forgetPayload,
    });
    if (!result.ok) return sendInternalFailure(reply, result);
    const unusedExposureObservation = guideExposure?.ok
      ? await buildUnusedExposureObservation({ app, req, env, parsed, guideExposure })
      : null;
    const feedbackLearningControlPersistence = guideExposure?.ok && unusedExposureObservation
      ? await persistUnusedExposureLearningControl({
          liteWriteStore,
          env,
          parsed,
          guideExposure,
          unusedExposureObservation,
        })
      : null;

    return reply.code(200).send({
      contract_version: productLifecycleContractVersion(surface),
      tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: parsed.scope ?? env.MEMORY_SCOPE,
      ...(surface !== "forget" ? { product_action: surface } : {}),
      operation: parsed.operation,
      target,
      forget_effect: productForgetEffect({
        parsed,
        target,
        route,
        resultBody: result.body,
        guideExposure,
        unusedExposureObservation,
        feedbackLearningControlPersistence,
      }),
      result: result.body,
      source_map: {
        routes_used: [
          ...(guideExposure ? ["/v1/memory/find"] : []),
          route,
        ],
        internal_surfaces_used: [
          ...(guideExposure ? ["guide_exposure_ledger"] : []),
          ...(unusedExposureObservation ? ["unused_exposure_observation"] : []),
          ...(feedbackLearningControlPersistence ? ["feedback_learning_control_persistence"] : []),
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
  };

  app.post("/v1/forget", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "anchors_suppress");
    const parsed = ProductForgetRequest.parse(body);
    return handleProductLifecycle(req, reply, parsed, "forget");
  });

  app.post("/v1/feedback", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = productFeedbackRequest(body);
    return handleProductLifecycle(req, reply, parsed, "feedback");
  });

  app.post("/v1/rehydrate", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "rehydrate_payload");
    const parsed = productRehydrateRequest(body);
    return handleProductLifecycle(req, reply, parsed, "rehydrate");
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
            "memory_use_receipt",
            "memory_admission_record",
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

  app.post("/v1/audit/flight-recorder", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductFlightRecorderRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    const gate = await acquireInflightSlot("recall");
    try {
      const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
      const scope = parsed.scope ?? env.MEMORY_SCOPE;
      const decisionOutputs = parsed.product_trace
        ? productMemoryDecisionOutputs({
            tenant_id: tenantId,
            scope,
            trace: parsed.product_trace,
            routes_used: ["/v1/audit/flight-recorder"],
          })
        : null;
      const traceClaimLedgerProjection = parsed.product_trace
        ? (parsed.product_trace.after_guide as Record<string, unknown>).claim_ledger_projection
        : undefined;
      const claimLedgerProjectionInput = parsed.claim_ledger_projection ?? traceClaimLedgerProjection;
      const derivedOperatorSnapshot = parsed.product_trace
        ? buildAionisOperatorSnapshot({
            tenant_id: tenantId,
            scope,
            run_id: parsed.run_id ?? null,
            agent_context: parsed.agent_context ?? parsed.product_trace.after_guide.agent_context ?? undefined,
            guide_packet: parsed.product_trace.after_guide.guide_packet ?? undefined,
            memory_decision_trace: decisionOutputs?.memoryDecisionTrace,
            memory_decision_audit: decisionOutputs?.memoryDecisionAudit,
            claim_ledger_projection: claimLedgerProjectionInput,
            guide_trace_id: parsed.guide_trace_id ?? null,
            source_map: {
              routes_used: ["/v1/audit/flight-recorder"],
              internal_surfaces_used: [
                "product_trace_projection",
                "memory_decision_trace",
                ...(claimLedgerProjectionInput ? ["claim_ledger_projection"] : []),
              ],
            },
          })
        : null;
      const report = buildAionisAgentFlightRecorderReport({
        tenant_id: tenantId,
        scope,
        guide_trace_id: parsed.guide_trace_id ?? null,
        run_id: parsed.run_id ?? null,
        agent_context: parsed.agent_context ?? parsed.product_trace?.after_guide.agent_context,
        memory_decision_trace: parsed.memory_decision_trace ?? decisionOutputs?.memoryDecisionTrace,
        memory_use_receipt: parsed.memory_use_receipt,
        memory_admission_record: parsed.memory_admission_record,
        claim_ledger_projection: claimLedgerProjectionInput,
        operator_snapshot: parsed.operator_snapshot ?? derivedOperatorSnapshot,
        feedback_result: parsed.feedback_result ?? parsed.product_trace?.forget_result,
        now: parsed.decision_time,
        source_map: {
          routes_used: ["/v1/audit/flight-recorder"],
          internal_surfaces_used: [
            ...(parsed.product_trace ? ["product_trace_projection"] : []),
            ...(decisionOutputs ? ["memory_decision_trace", "memory_decision_audit_report"] : []),
            ...(claimLedgerProjectionInput ? ["claim_ledger_projection"] : []),
            ...(derivedOperatorSnapshot ? ["operator_snapshot_contract"] : []),
          ],
        },
      });
      return reply.code(200).send({
        contract_version: "aionis_agent_flight_recorder_result_v1",
        tenant_id: tenantId,
        scope,
        agent_flight_recorder: report,
        source_map: {
          routes_used: ["/v1/audit/flight-recorder"],
          internal_surfaces_used: [
            "agent_flight_recorder",
            ...(parsed.product_trace ? ["product_trace_projection"] : []),
            ...(decisionOutputs ? ["memory_decision_trace", "memory_use_receipt", "memory_admission_record", "memory_decision_audit_report"] : []),
            ...(claimLedgerProjectionInput ? ["claim_ledger_projection"] : []),
            ...(derivedOperatorSnapshot || parsed.operator_snapshot ? ["operator_snapshot_contract"] : []),
          ],
          omitted_internal_surfaces: [
            "agent_prompt_text",
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
      const decisionOutputs = parsed.product_trace
        ? productMemoryDecisionOutputs({
            tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
            scope: parsed.scope ?? env.MEMORY_SCOPE,
            trace: parsed.product_trace,
            routes_used: ["/v1/measure"],
          })
        : null;
      const effectReport = buildAionisEffectReport({
        tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
        scope: parsed.scope ?? env.MEMORY_SCOPE,
        task: parsed.task,
        report: kernelReport,
        comparison: measureInput.comparison,
        evidence_ids: measureInput.evidenceIds,
        feedback_signal_review: decisionOutputs?.memoryDecisionAudit.feedback_signal_review ?? null,
      });
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
            ...(decisionOutputs
              ? ["memory_decision_trace", "memory_use_receipt", "memory_admission_record", "memory_decision_audit_report"]
              : []),
            "effect_evaluator",
            "product_effect_report",
          ],
        },
      });
    } finally {
      gate.release();
    }
  });

  app.post("/v1/skills/candidates", async (req: ProductFacadeRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, "recall");
    const parsed = ProductSkillCandidateEnqueueRequest.parse(body);
    await enforceRateLimit(req, reply, "recall");
    await enforceTenantQuota(req, reply, "recall", tenantFromBody(parsed));
    if (!skillCandidateReviewAccess) {
      return reply.code(503).send(productErrorResponse({
        status: 503,
        error: "skill_candidate_review_unavailable",
        message: "trace-derived skill candidate review store is not available for this Runtime",
      }));
    }
    const gate = await acquireInflightSlot("recall");
    try {
      const report = productSkillCandidateEffectReportFromRequest(parsed);
      const tenantId = parsed.tenant_id ?? report.tenant_id ?? env.MEMORY_TENANT_ID;
      const scope = parsed.scope ?? report.scope ?? env.MEMORY_SCOPE;
      const candidates = productTraceDerivedSkillCandidates(report);
      const queued = await skillCandidateReviewAccess.enqueueTraceDerivedSkillCandidates({
        tenantId,
        scope,
        candidates,
        source: parsed.measure_result !== undefined ? "measure_result" : "effect_report",
      });
      return reply.code(200).send(productSkillCandidateReviewResponse({
        route: "/v1/skills/candidates",
        tenantId,
        scope,
        rows: queued.rows,
        inserted: queued.inserted,
        updated: queued.updated,
      }));
    } finally {
      gate.release();
    }
  });

  app.get("/v1/skills/candidates", async (req: ProductFacadeQueryRequest, reply: FastifyReply) => {
    const principal = await requireMemoryPrincipal(req);
    const parsed = ProductSkillCandidateListQuery.parse(req.query ?? {});
    const identifiedQuery = withIdentityFromRequest(req, parsed, principal, "recall");
    const identityParsed = ProductSkillCandidateListQuery.parse(identifiedQuery);
    await enforceRateLimit(req, reply, "recall");
    const tenantId = identityParsed.tenant_id ?? env.MEMORY_TENANT_ID;
    const scope = identityParsed.scope ?? env.MEMORY_SCOPE;
    await enforceTenantQuota(req, reply, "recall", tenantId);
    if (!skillCandidateReviewAccess) {
      return reply.code(503).send(productErrorResponse({
        status: 503,
        error: "skill_candidate_review_unavailable",
        message: "trace-derived skill candidate review store is not available for this Runtime",
      }));
    }
    const gate = await acquireInflightSlot("recall");
    try {
      const listed = await skillCandidateReviewAccess.listTraceDerivedSkillCandidates({
        tenantId,
        scope,
        reviewStatus: identityParsed.status as SkillCandidateReviewStatus | "all",
        limit: identityParsed.limit,
      });
      return reply.code(200).send(productSkillCandidateReviewResponse({
        route: "/v1/skills/candidates",
        tenantId,
        scope,
        rows: listed.rows,
      }));
    } finally {
      gate.release();
    }
  });

  async function reviewSkillCandidate(args: {
    req: ProductFacadeParamsRequest;
    reply: FastifyReply;
    reviewStatus: Exclude<SkillCandidateReviewStatus, "pending_review">;
    route: string;
  }) {
    const principal = await requireMemoryPrincipal(args.req);
    const body = withIdentityFromRequest(args.req, args.req.body ?? {}, principal, "recall");
    const params = ProductSkillCandidateParams.parse(args.req.params ?? {});
    const parsed = ProductSkillCandidateReviewRequest.parse(body);
    await enforceRateLimit(args.req, args.reply, "recall");
    const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
    const scope = parsed.scope ?? env.MEMORY_SCOPE;
    await enforceTenantQuota(args.req, args.reply, "recall", tenantId);
    if (!skillCandidateReviewAccess) {
      return args.reply.code(503).send(productErrorResponse({
        status: 503,
        error: "skill_candidate_review_unavailable",
        message: "trace-derived skill candidate review store is not available for this Runtime",
      }));
    }
    const gate = await acquireInflightSlot("recall");
    try {
      const row = await skillCandidateReviewAccess.reviewTraceDerivedSkillCandidate({
        tenantId,
        scope,
        candidateId: params.id,
        reviewStatus: args.reviewStatus,
        reviewerId: parsed.reviewer_id ?? null,
        reason: parsed.reason ?? null,
      });
      if (!row) {
        return args.reply.code(404).send(productErrorResponse({
          status: 404,
          error: "skill_candidate_not_found",
          message: "trace-derived skill candidate was not found in this tenant/scope",
          details: { candidate_id: params.id },
        }));
      }
      return args.reply.code(200).send(productSkillCandidateReviewResponse({
        route: args.route,
        tenantId,
        scope,
        rows: [row],
      }));
    } finally {
      gate.release();
    }
  }

  app.post("/v1/skills/candidates/:id/promote", async (req: ProductFacadeParamsRequest, reply: FastifyReply) =>
    reviewSkillCandidate({
      req,
      reply,
      reviewStatus: "promoted",
      route: "/v1/skills/candidates/:id/promote",
    })
  );

  app.post("/v1/skills/candidates/:id/reject", async (req: ProductFacadeParamsRequest, reply: FastifyReply) =>
    reviewSkillCandidate({
      req,
      reply,
      reviewStatus: "rejected",
      route: "/v1/skills/candidates/:id/reject",
    })
  );
}
