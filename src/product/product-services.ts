import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import type { AionisEffectObservation } from "../kernel/effect-evaluator.js";
import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
  type Env,
} from "../config.js";
import {
  AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
  buildAionisMemoryDecisionAuditReport,
  buildAionisMemoryDecisionTrace,
} from "../memory/product-output/decision-trace.js";
import {
  AionisAgentRoleSchema,
  AionisAgentContextSchema,
  AionisTaskContextProfileSchema,
  AionisEffectReportSchema,
  AionisExternalMemoryCandidateSchema,
  AionisGuidePacketSchema,
  AionisMemoryPacketSchema,
  AionisProcedureMemoryDraftV1Schema,
  type AionisEffectReport,
  type AionisAgentContext,
  type AionisAgentRole,
  type AionisTaskContextProfile,
  type AionisClaimLedgerProjection,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisGuidePacket,
  type AionisMemoryPacket,
  type AionisProcedureMemoryDraftV1,
} from "../memory/product-output-contract.js";
import { memoryFindLite } from "../memory/find.js";
import { AionisClaimWriteSchema } from "../memory/claim-ledger-contract.js";
import {
  HostTaskEnvelopeV1Schema,
  HostUseReceiptV1Schema,
} from "../memory/learning-episode-ledger.js";
import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";
import type { AuthPrincipal } from "../util/auth.js";
import { createErrorResponse, HttpError } from "../util/http.js";

export function productErrorResponse(args: {
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

const ProductWriteIdentityShape = {
  actor: z.string().trim().min(1).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().trim().min(1).optional(),
  owner_agent_id: z.string().trim().min(1).optional(),
  owner_team_id: z.string().trim().min(1).optional(),
};

export const ProductObserveRequest = z.object({
  operation_id: z.string().trim().min(1).max(256).optional(),
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

const ProductGuideServerAuthorityClaimKeys = new Set([
  "assignment_arm",
  "assignment_algorithm",
  "assignment_bucket",
  "assignment_namespace_sha256",
  "assignment_randomness_sha256",
  "assignment_reason_codes",
  "assigned_arm",
  "activation_starts_at",
  "activation_wave_index",
  "collection_class",
  "collection_principal_sha256",
  "collection_source_policy_sha256",
  "collector_id",
  "collector_version",
  "confirmatory_assignment_bits",
  "confirmatory_assignment_bits_sha256",
  "confirmatory_attempt_id",
  "candidate_allocation_bps",
  "diagnostic_assignment_seed_sha256",
  "evidence_intent",
  "experiment_config_sha256",
  "experiment_id",
  "experiment_revision",
  "host_task_envelope_sha256",
  "memory_namespace_sha256",
  "matching_covariate_sha256",
  "namespace_lease_generation",
  "namespace_lease_id",
  "namespace_set_sha256",
  "operation_protection",
  "profile_rule_sha256",
  "projection_complete",
  "promotion_eligible",
  "pair_member_ordinal",
  "randomization_pair_sha256",
  "randomization_pair_manifest_sha256",
  "hard_boundary_upgrade_count",
  "index_window_ends_at",
  "wave_analysis_at",
  "diagnostic_assignment_seed",
]);

const ProductGuideUnknownAuthoritySurfaces = [
  "context",
  "memory_layer_preference",
  "execution_state_v1",
  "execution_packet_v1",
  "edit_boundary_context",
  "runtime_verification",
  "trajectory",
  "trajectory_hints",
  "execution_tree_v1",
] as const;

function rejectNestedProductGuideAuthorityClaims(
  value: unknown,
  rootPath: string,
  context: z.RefinementCtx,
): void {
  const stack: Array<{ value: unknown; path: (string | number)[]; depth: number }> = [{
    value,
    path: [rootPath],
    depth: 0,
  }];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    visitedNodes += 1;
    if (current.depth > 8 || visitedNodes > 2048) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: current.path,
        message: "guide context exceeds the bounded authority-claim scan",
      });
      return;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => stack.push({
        value: entry,
        path: [...current.path, index],
        depth: current.depth + 1,
      }));
      continue;
    }
    for (const [key, entry] of Object.entries(current.value as Record<string, unknown>)) {
      const path = [...current.path, key];
      if (ProductGuideServerAuthorityClaimKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${key} is server-owned learning authority`,
        });
        continue;
      }
      stack.push({ value: entry, path, depth: current.depth + 1 });
    }
  }
}

export const ProductGuideRequest = z.object({
  operation_id: z.string().trim().min(1).max(256).optional(),
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
  tool_strict: z.boolean().optional(),
  include_shadow: z.boolean().optional(),
  rules_limit: z.number().int().positive().max(200).optional(),
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
  host_task_envelope_v1: HostTaskEnvelopeV1Schema.optional(),
  include_packets: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  for (const surface of ProductGuideUnknownAuthoritySurfaces) {
    if (value[surface] !== undefined) {
      rejectNestedProductGuideAuthorityClaims(value[surface], surface, context);
    }
  }
});

export const ProductToolFeedbackRequest = z.object({
  feedback_kind: z.literal("tool_selection"),
  operation_id: z.string().trim().min(1).max(256).optional(),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  consumer_agent_id: z.string().trim().min(1).optional(),
  consumer_team_id: z.string().trim().min(1).optional(),
  guide_trace_id: z.string().trim().min(1),
  decision_id: z.string().uuid(),
  run_id: z.string().trim().min(1),
  selected_tool: z.string().trim().min(1),
  candidates: z.array(z.string().trim().min(1)).min(1).max(200),
  outcome: z.enum(["positive", "negative", "neutral"]),
  context: LooseObject,
  include_shadow: z.boolean().default(false),
  rules_limit: z.number().int().positive().max(200).default(50),
  target: z.enum(["tool", "all"]).default("tool"),
  note: z.string().trim().min(1).optional(),
  input_text: z.string().trim().min(1).optional(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  learning_control_review: LooseObject.optional(),
}).strict().refine((value) => !!value.input_text || !!value.input_sha256, {
  message: "must set input_text or input_sha256",
});

export const ProductMemoryAdmissionRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  run_id: z.string().trim().min(1).optional(),
  query_text: z.string().trim().min(1),
  mode: z.enum(["standard", "strict", "firewall"]).optional(),
  context_mode: z.enum(["standard", "compact_agent"]).optional(),
  candidates: z.array(AionisExternalMemoryCandidateSchema).min(1).max(200),
  include_records: z.boolean().optional(),
}).strict();

export const ProductForgetRequest = z.object({
  operation: z.enum(["suppress", "unsuppress", "rehydrate", "activate"]),
  target: z.enum(["pattern", "archive", "payload", "memory"]).optional(),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  consumer_agent_id: z.string().trim().min(1).optional(),
  consumer_team_id: z.string().trim().min(1).optional(),
  operation_id: z.string().trim().min(1).max(256).optional(),
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
  host_use_receipt_v1: HostUseReceiptV1Schema.optional(),
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
  if (value.operation !== "activate" && (value.operation_id || value.host_use_receipt_v1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.host_use_receipt_v1 ? "host_use_receipt_v1" : "operation_id"],
      message: "feedback operation identity and host-use receipts are accepted only for activate",
    });
  }
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
    && !value.host_use_receipt_v1
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_surface"],
      message: "non-neutral activation feedback requires use_now or explicit_host_assertion attribution",
    });
  }
  if (value.operation === "activate" && value.host_use_receipt_v1) {
    const receipt = value.host_use_receipt_v1;
    if (!value.operation_id || value.operation_id !== receipt.operation_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operation_id"],
        message: "host_use_receipt_v1 requires its exact protected operation_id",
      });
    }
    if (!value.guide_trace_id || value.guide_trace_id !== receipt.guide_trace_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["guide_trace_id"],
        message: "host_use_receipt_v1 guide_trace_id must match the feedback request",
      });
    }
    if (!value.run_id || value.run_id !== receipt.run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_id"],
        message: "host_use_receipt_v1 run_id must match the feedback request",
      });
    }
    if ((value.memory_ids?.length ?? 0) > 0 || (value.node_ids?.length ?? 0) > 0 || (value.client_ids?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["used_memory_ids"],
        message: "host_use_receipt_v1 feedback accepts only the exact used_memory_ids subject set",
      });
    }
    const suppliedRequestIds = value.used_memory_ids ?? [];
    if (new Set(suppliedRequestIds).size !== suppliedRequestIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["used_memory_ids"],
        message: "host_use_receipt_v1 feedback does not allow duplicate subjects",
      });
    }
    const requestIds = [...new Set(suppliedRequestIds)].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
    const receiptIds = receipt.items.map((item) => item.memory_id);
    if (stableStringify(requestIds) !== stableStringify(receiptIds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["used_memory_ids"],
        message: "used_memory_ids must exactly match the canonical host-use receipt item set",
      });
    }
    const outcomes = new Set(receipt.items.map((item) => item.outcome));
    const surfaces = new Set(receipt.items.map((item) => item.used_surface));
    if (outcomes.size !== 1 || surfaces.size !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host_use_receipt_v1", "items"],
        message: "one feedback operation requires homogeneous receipt outcome and used_surface values",
      });
    }
    if (receipt.items[0]?.outcome !== value.outcome || receipt.items[0]?.used_surface !== value.used_surface) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host_use_receipt_v1", "items"],
        message: "host-use receipt outcome and used_surface must match the feedback request",
      });
    }
    if (value.verifier_status !== "passed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifier_status"],
        message: "host_use_receipt_v1 feedback requires verifier_status passed",
      });
    }
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
    recoveredStateApplicable: z.boolean().optional(),
    verifiedFactsCarried: z.number().nonnegative().optional(),
    verifiedFactsExpected: z.number().nonnegative().optional(),
    verifiedFactsApplicable: z.boolean().optional(),
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
    staleMemoryControlApplicable: z.boolean().optional(),
    rehydrationApplicable: z.boolean().optional(),
  }).strict().optional(),
  learning_control: z.object({
    weakEvidenceBlocked: z.number().nonnegative().optional(),
    authorityRequiresEvidence: z.boolean().optional(),
    blockedAuthorityVisible: z.boolean().optional(),
    unverifiedAuthorityApplied: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export const ProductMeasureGuideSnapshotSchema = z.object({
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

export const ProductMeasureTraceSchema = ProductDecisionTraceBaseSchema.extend({
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

export const ProductDecisionTraceRequest = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  product_trace: ProductDecisionTraceBaseSchema,
}).strict();

export const ProductFlightRecorderRequest = z.object({
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

export const ProductMeasureRequest = z.object({
  ...ProductWriteIdentityShape,
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

export const ProductSkillCandidateListQuery = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  status: ProductSkillCandidateReviewStatusSchema.default("pending_review"),
  limit: z.coerce.number().int().positive().max(500).default(50),
}).strict();

export const ProductSkillCandidateEnqueueRequest = z.object({
  ...ProductWriteIdentityShape,
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  measurement_id: z.string().trim().min(1).max(256).optional(),
  measure_result: z.object({
    measurement_id: z.string().trim().min(1).max(256),
    measurement_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).passthrough().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.measurement_id === undefined && value.measure_result === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["measurement_id"],
      message: "skill candidate enqueue requires measurement_id or a Runtime measure_result",
    });
  }
  if (
    value.measurement_id !== undefined
    && value.measure_result !== undefined
    && value.measurement_id !== value.measure_result.measurement_id
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["measurement_id"],
      message: "measurement_id must match measure_result.measurement_id",
    });
  }
});

export const ProductSkillCandidateParams = z.object({
  id: z.string().trim().min(1),
}).strict();

export const ProductSkillCandidateReviewRequest = z.object({
  ...ProductWriteIdentityShape,
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  reviewer_id: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).max(2048),
}).strict();

export const ProductSkillCandidateMaterializeRequest = z.object({
  ...ProductWriteIdentityShape,
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
}).strict();

export type InternalDispatchResult =
  | { ok: true; statusCode: number; path: string; body: unknown }
  | { ok: false; statusCode: number; path: string; body: unknown };

export function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export type ProductForgetInput = z.infer<typeof ProductForgetRequest>;

export type ProductForgetTarget = NonNullable<ProductForgetInput["target"]>;

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
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

export const ProductToolSelectionReceiptSchema = z.object({
  contract_version: z.literal("aionis_tool_selection_receipt_v1"),
  decision_id: z.string().trim().min(1),
  decision_uri: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  selected_tool: z.string().trim().min(1).nullable(),
  candidates: z.array(z.string().trim().min(1)).min(1).max(256),
  context_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rule_evaluation_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  source_rule_ids: z.array(z.string().trim().min(1)).max(256),
  created_at: z.string().trim().min(1),
}).strict();

export type ProductToolSelectionReceipt = z.infer<typeof ProductToolSelectionReceiptSchema>;

export type ProductRuntimeVerificationReceipt = {
  contract_version: "aionis_runtime_verification_receipt_v1";
  run_id: string;
  requested_mode: "execute";
  execution_state: "executed" | "partially_executed";
  result_count: number;
  authoritative_evidence_ready: boolean;
  validation_passed: boolean;
  validation_boundary: "runtime_orchestrator" | "external_verifier";
  false_confidence_detected: boolean;
  verifier_ids: string[];
  evidence_refs: string[];
  surface_sha256: string;
};

export type ProductGuideExposureLedger = {
  contract_version: "aionis_guide_exposure_v1";
  guide_trace_id: string;
  tenant_id: string;
  scope: string;
  run_id: string | null;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  query_sha256: string;
  context_sha256: string;
  task_binding_sha256: string;
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
  tool_selection: ProductToolSelectionReceipt | null;
  runtime_verification_v1: ProductRuntimeVerificationReceipt | null;
  effect_observation_v1: AionisEffectObservation | null;
  effect_observation_sha256: string | null;
};

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => typeof entry === "string" ? entry : null));
}

export function parseGuideExposureLedger(value: unknown): ProductGuideExposureLedger | null {
  const record = objectValue(value);
  if (!record || record.contract_version !== "aionis_guide_exposure_v1") return null;
  const guideTraceId = typeof record.guide_trace_id === "string" && record.guide_trace_id.trim()
    ? record.guide_trace_id.trim()
    : null;
  const tenantId = typeof record.tenant_id === "string" && record.tenant_id.trim() ? record.tenant_id.trim() : null;
  const scope = typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : null;
  const querySha = typeof record.query_sha256 === "string" && record.query_sha256.trim() ? record.query_sha256.trim() : null;
  const contextSha = typeof record.context_sha256 === "string" && record.context_sha256.trim() ? record.context_sha256.trim() : null;
  const taskBindingSha = typeof record.task_binding_sha256 === "string" && /^[a-f0-9]{64}$/.test(record.task_binding_sha256)
    ? record.task_binding_sha256
    : null;
  const recommendedPosture = record.recommended_posture;
  const authority = record.authority;
  if (!guideTraceId || !tenantId || !scope || !querySha || !contextSha || !taskBindingSha) return null;
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
  const toolSelection = record.tool_selection === undefined || record.tool_selection === null
    ? null
    : ProductToolSelectionReceiptSchema.safeParse(record.tool_selection);
  if (toolSelection !== null && !toolSelection.success) return null;
  const effectObservation = record.effect_observation_v1 === undefined || record.effect_observation_v1 === null
    ? null
    : EffectObservationSchema.safeParse(record.effect_observation_v1);
  const effectObservationSha = typeof record.effect_observation_sha256 === "string"
    && /^[a-f0-9]{64}$/.test(record.effect_observation_sha256)
    ? record.effect_observation_sha256
    : null;
  if (effectObservation !== null && !effectObservation.success) return null;
  const runtimeVerificationRecord = objectValue(record.runtime_verification_v1);
  const runtimeVerificationRunId = typeof runtimeVerificationRecord?.run_id === "string"
    && runtimeVerificationRecord.run_id.trim().length > 0
    ? runtimeVerificationRecord.run_id.trim()
    : null;
  const runtimeVerification = runtimeVerificationRecord === null
    ? null
    : {
        contract_version: runtimeVerificationRecord.contract_version,
        run_id: runtimeVerificationRunId,
        requested_mode: runtimeVerificationRecord.requested_mode,
        execution_state: runtimeVerificationRecord.execution_state,
        result_count: Math.max(0, Math.trunc(Number(runtimeVerificationRecord.result_count) || 0)),
        authoritative_evidence_ready: runtimeVerificationRecord.authoritative_evidence_ready === true,
        validation_passed: runtimeVerificationRecord.validation_passed === true,
        validation_boundary: runtimeVerificationRecord.validation_boundary,
        false_confidence_detected: runtimeVerificationRecord.false_confidence_detected === true,
        verifier_ids: stringArrayField(runtimeVerificationRecord.verifier_ids),
        evidence_refs: stringArrayField(runtimeVerificationRecord.evidence_refs),
        surface_sha256: runtimeVerificationRecord.surface_sha256,
      };
  if (runtimeVerification !== null && (
    runtimeVerification.contract_version !== "aionis_runtime_verification_receipt_v1"
    || runtimeVerification.run_id === null
    || runtimeVerification.requested_mode !== "execute"
    || (runtimeVerification.execution_state !== "executed" && runtimeVerification.execution_state !== "partially_executed")
    || (runtimeVerification.validation_boundary !== "runtime_orchestrator" && runtimeVerification.validation_boundary !== "external_verifier")
    || typeof runtimeVerification.surface_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(runtimeVerification.surface_sha256)
  )) return null;
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
    task_binding_sha256: taskBindingSha,
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
    tool_selection: toolSelection === null ? null : toolSelection.data,
    runtime_verification_v1: runtimeVerification as ProductRuntimeVerificationReceipt | null,
    effect_observation_v1: effectObservation === null ? null : effectObservation.data,
    effect_observation_sha256: effectObservationSha,
  };
}

export function sameGuideExposureConsumer(left: ProductGuideExposureLedger, right: ProductGuideExposureLedger): boolean {
  return left.consumer_agent_id === right.consumer_agent_id && left.consumer_team_id === right.consumer_team_id;
}

export function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function guideExposureSurfaceIds(ledger: ProductGuideExposureLedger, surface: keyof Pick<
  ProductGuideExposureLedger,
  "use_now_memory_ids" | "inspect_before_use_memory_ids" | "do_not_use_memory_ids" | "rehydrate_memory_ids"
>): Set<string> {
  return new Set(ledger[surface]);
}

export function guideExposureServedMemoryIds(ledger: Pick<
  ProductGuideExposureLedger,
  | "memory_ids"
  | "use_now_memory_ids"
  | "inspect_before_use_memory_ids"
  | "do_not_use_memory_ids"
  | "rehydrate_memory_ids"
>): Set<string> {
  return new Set([
    ...ledger.memory_ids,
    ...ledger.use_now_memory_ids,
    ...ledger.inspect_before_use_memory_ids,
    ...ledger.do_not_use_memory_ids,
    ...ledger.rehydrate_memory_ids,
  ]);
}

export async function findMemoryNodeSlots(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  tenant_id: string;
  scope: string;
  memory_id: string;
  actor: string;
  consumerTeamId: string | null;
}): Promise<Record<string, unknown>> {
  try {
    const found = await memoryFindLite(
      args.liteWriteStore,
      {
        tenant_id: args.tenant_id,
        scope: args.scope,
        id: args.memory_id,
        consumer_agent_id: args.actor,
        ...(args.consumerTeamId ? { consumer_team_id: args.consumerTeamId } : {}),
        include_slots: true,
        limit: 1,
      },
      args.env.MEMORY_SCOPE,
      args.env.MEMORY_TENANT_ID,
    );
    const node = Array.isArray(found.nodes) ? objectValue(found.nodes[0]) : null;
    return objectValue(node?.slots) ?? {};
  } catch {
    throw new Error(`unused exposure memory lookup failed for ${args.memory_id}`);
  }
}

export async function findGuideExposureLedger(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  consumerAgentId: string;
  consumerTeamId?: string | null;
}): Promise<ProductGuideExposureLedger | null> {
  const row = await args.liteWriteStore.getProductGuideReceipt({
    tenantId: args.tenant_id,
    scope: args.scope,
    guideTraceId: args.guide_trace_id,
  });
  if (!row || !row.commit_id) return null;
  let rawLedger: unknown;
  try {
    rawLedger = JSON.parse(row.ledger_json);
  } catch {
    return null;
  }
  if (sha256Hex(stableStringify(rawLedger)) !== row.ledger_sha256) return null;
  const ledger = parseGuideExposureLedger(rawLedger);
  if (
    !ledger
    || ledger.guide_trace_id !== row.guide_trace_id
    || ledger.tenant_id !== row.tenant_id
    || ledger.scope !== row.scope
    || ledger.query_sha256 !== row.query_sha256
    || ledger.context_sha256 !== row.context_sha256
  ) return null;
  if (ledger.consumer_agent_id !== null && ledger.consumer_agent_id !== args.consumerAgentId) return null;
  if (args.consumerTeamId !== undefined && ledger.consumer_team_id !== args.consumerTeamId) return null;
  return ledger;
}

export async function findHistoricalGuideExposureLedgers(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  tenant_id: string;
  scope: string;
  actor: string;
  consumerTeamId: string | null;
}): Promise<ProductGuideExposureLedger[]> {
  const rows = await args.liteWriteStore.listProductGuideReceipts({
    tenantId: args.tenant_id,
    scope: args.scope,
    limit: 1000,
  });
  const out: ProductGuideExposureLedger[] = [];
  for (const row of rows) {
    let rawLedger: unknown;
    try {
      rawLedger = JSON.parse(row.ledger_json);
    } catch {
      continue;
    }
    if (sha256Hex(stableStringify(rawLedger)) !== row.ledger_sha256) continue;
    const ledger = parseGuideExposureLedger(rawLedger);
    if (
      !ledger
      || ledger.guide_trace_id !== row.guide_trace_id
      || ledger.tenant_id !== row.tenant_id
      || ledger.scope !== row.scope
      || ledger.consumer_agent_id !== args.actor
      || ledger.consumer_team_id !== args.consumerTeamId
    ) continue;
    out.push(ledger);
  }
  return out;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type ProductDecisionTraceInput = z.infer<typeof ProductDecisionTraceBaseSchema>;

export function productMemoryDecisionOutputs(args: {
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

export type ProductObserveInput = z.infer<typeof ProductObserveRequest>;
export type ProductGuideInput = z.infer<typeof ProductGuideRequest>;
export type ProductToolFeedbackInput = z.infer<typeof ProductToolFeedbackRequest>;
export type ProductMemoryAdmissionInput = z.infer<typeof ProductMemoryAdmissionRequest>;
export type ProductDecisionTraceRequestInput = z.infer<typeof ProductDecisionTraceRequest>;
export type ProductFlightRecorderInput = z.infer<typeof ProductFlightRecorderRequest>;
export type ProductMeasureRequestInput = z.infer<typeof ProductMeasureRequest>;
export type ProductSkillCandidateListInput = z.infer<typeof ProductSkillCandidateListQuery>;
export type ProductSkillCandidateEnqueueInput = z.infer<typeof ProductSkillCandidateEnqueueRequest>;
export type ProductSkillCandidateReviewInput = z.infer<typeof ProductSkillCandidateReviewRequest>;
export type ProductSkillCandidateMaterializeInput = z.infer<typeof ProductSkillCandidateMaterializeRequest>;
export type ProductLifecycleSurface = "forget" | "feedback" | "rehydrate";

export type ProductServiceResult<T = unknown> =
  | { ok: true; statusCode: number; body: T }
  | { ok: false; statusCode: number; body: unknown };

export function productServiceSuccess<T>(body: T, statusCode = 200): ProductServiceResult<T> {
  return { ok: true, statusCode, body };
}

export function productServiceFailure(args: {
  statusCode: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  topLevel?: Record<string, unknown>;
}): ProductServiceResult<never> {
  return {
    ok: false,
    statusCode: args.statusCode,
    body: productErrorResponse({
      status: args.statusCode,
      error: args.error,
      message: args.message,
      details: args.details,
      topLevel: args.topLevel,
    }),
  };
}

export function productServiceDependencyFailure(
  surface: string,
  statusCode = 500,
): ProductServiceResult<never> {
  return productServiceFailure({
    statusCode,
    error: "product_dependency_failed",
    message: "A product facade dependency failed.",
    details: {
      surface,
      upstream_status: statusCode,
      retryable: statusCode === 429 || statusCode >= 500,
    },
  });
}

export function productServiceFailureFromUnknown(error: unknown): ProductServiceResult<never> {
  if (error instanceof HttpError) {
    return productServiceFailure({
      statusCode: error.statusCode,
      error: error.code,
      message: error.message,
      details: objectValue(error.details) ?? undefined,
    });
  }
  if (error instanceof z.ZodError) {
    return productServiceFailure({
      statusCode: 400,
      error: "invalid_request",
      message: "invalid request",
      details: {
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  return productServiceFailure({
    statusCode: 500,
    error: "internal_error",
    message: "Aionis product service failed.",
  });
}

export type ProductObserveExecutionContext = {
  principal: AuthPrincipal | null;
};

export type ProductGuideExecutionContext = {
  principal: AuthPrincipal | null;
  planningContext: (input: ProductGuideInput) => Promise<unknown>;
  applyIdentity: (input: Record<string, unknown>, kind: "execution_context_assemble") => unknown;
};

export type ProductLifecycleExecutionContext = {
  principal: AuthPrincipal | null;
};

export type ProductServices = {
  observe: {
    guardOrder(input: ProductObserveInput): "guards_first" | "inflight_first";
    execute(input: ProductObserveInput, context: ProductObserveExecutionContext): Promise<ProductServiceResult>;
  };
  guide: {
    execute(input: ProductGuideInput, context: ProductGuideExecutionContext): Promise<ProductServiceResult>;
    govern(input: ProductMemoryAdmissionInput): Promise<ProductServiceResult>;
  };
  toolFeedback: {
    execute(input: ProductToolFeedbackInput): Promise<ProductServiceResult>;
  };
  lifecycle: {
    execute(
      input: ProductForgetInput,
      surface: ProductLifecycleSurface,
      context: ProductLifecycleExecutionContext,
    ): Promise<ProductServiceResult>;
    decisionTrace(input: ProductDecisionTraceRequestInput): Promise<ProductServiceResult>;
    decisionAudit(input: ProductDecisionTraceRequestInput): Promise<ProductServiceResult>;
    flightRecorder(input: ProductFlightRecorderInput): Promise<ProductServiceResult>;
  };
  measure: {
    execute(input: ProductMeasureRequestInput, context: { actorId: string }): Promise<ProductServiceResult>;
    enqueueSkillCandidates(input: ProductSkillCandidateEnqueueInput): Promise<ProductServiceResult>;
    listSkillCandidates(input: ProductSkillCandidateListInput): Promise<ProductServiceResult>;
    reviewSkillCandidate(args: {
      candidateId: string;
      input: ProductSkillCandidateReviewInput;
      reviewStatus: "promoted" | "rejected";
      route: string;
      reviewerId: string;
    }): Promise<ProductServiceResult>;
    materializeSkillCandidate(args: {
      candidateId: string;
      input: ProductSkillCandidateMaterializeInput;
      actorId: string;
    }): Promise<ProductServiceResult>;
  };
};
