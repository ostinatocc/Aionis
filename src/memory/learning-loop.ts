import { z } from "zod";
import stableStringify from "fast-json-stable-stringify";
import {
  adjudicatePolicyMutationV1,
  buildPolicyMutationFromLearningControlApply,
  buildPolicyMutationFromWorkflowPromotion,
  type PolicyMutationV1,
  type PolicyMutationAdjudicationV1,
} from "../kernel/policy-mutation-loop.js";
import {
  buildWorkflowMaintenanceMetadata,
  buildWorkflowPromotionMetadata,
  compareMemoryTierRank,
  normalizeMemoryTier,
  resolveTierTransitionTarget,
  type MemoryEvolutionAction,
  type MemoryTierName,
} from "./evolution-operators.js";
import {
  ExecutionNativeV1Schema,
  MemoryAnchorV1Schema,
} from "./schemas.js";
import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import {
  resolveNodeExecutionContract,
  resolveNodeExecutionContractTrust,
  resolveNodeCompressionLayer,
  resolveNodeCredibilityState,
  resolveNodeExecutionKind,
  resolveNodeFilePath,
  resolveNodeNextAction,
  resolveNodePatternHints,
  resolveNodePolicyMemorySurface,
  resolveNodePolicyMemoryState,
  resolveNodeServiceLifecycleConstraints,
  resolveNodeSummaryKind,
  resolveNodeTaskFamily,
  resolveNodeTaskSignature,
  resolveNodeTargetFiles,
  resolveNodeWorkflowSignature,
  resolveNodeWorkflowSteps,
  resolveNodeToolSet,
} from "./node-execution-surface.js";
import { applyPolicyMemoryLearningControlLite } from "./policy-memory.js";
import { buildPromotionEvidenceLedgerV1 } from "./promotion-evidence-ledger.js";
import {
  runtimeAuthorityGateFromValue,
  sealRuntimeAuthorityEffectReceipt,
} from "./authority-effect-broker.js";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "./write.js";
import { resolveTenantScope } from "./tenant.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";

export const LearningLoopModeSchema = z.enum(["dry_run", "apply"]);
export const LearningLoopSurfaceSchema = z.enum(["workflow", "pattern", "policy", "forgetting"]);
export const LearningLoopActionSchema = z.enum([
  "promote_workflow",
  "retire_policy",
  "demote_memory",
  "archive_memory",
  "monitor",
  "skip",
]);
export const ForgettingMutationPolicySchema = z.object({
  policy_id: z.string().trim().min(1).max(128).default("learning_loop_default"),
  low_level_grace_hours: z.number().int().min(0).max(24 * 365).default(24),
  allow_low_level_stale_mutation: z.boolean().default(true),
  allow_high_level_mutation: z.boolean().default(true),
  allow_explicit_lifecycle_mutation: z.boolean().default(true),
  source_code_change_allowed: z.literal(false).default(false),
}).strict();
export type LearningLoopMode = z.infer<typeof LearningLoopModeSchema>;
export type LearningLoopSurface = z.infer<typeof LearningLoopSurfaceSchema>;
export type LearningLoopAction = z.infer<typeof LearningLoopActionSchema>;
export type ForgettingMutationPolicy = z.infer<typeof ForgettingMutationPolicySchema>;

export const LearningLoopRunRequestSchema = z.object({
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  mode: LearningLoopModeSchema.default("apply"),
  surfaces: z.array(LearningLoopSurfaceSchema).min(1).max(4).default(["workflow", "pattern", "policy", "forgetting"]),
  limit: z.number().int().positive().max(100).default(40),
  max_mutations: z.number().int().positive().max(50).default(20),
  forgetting_mutation_policy: ForgettingMutationPolicySchema.optional(),
}).strict();
export type LearningLoopRunRequest = z.infer<typeof LearningLoopRunRequestSchema>;

const LearningLoopDecisionSchema = z.object({
  decision_version: z.literal("learning_loop_decision_v1"),
  surface: LearningLoopSurfaceSchema,
  target_id: z.string().min(1),
  action: LearningLoopActionSchema,
  applied: z.boolean(),
  mode: LearningLoopModeSchema,
  reasons: z.array(z.string().min(1)).min(1).max(24),
  confidence: z.number().min(0).max(1),
  source_code_change_allowed: z.literal(false),
  policy_mutation_v1: z.custom<PolicyMutationV1>().nullable().default(null),
  policy_mutation_adjudication_v1: z.custom<PolicyMutationAdjudicationV1>().nullable().default(null),
  commit_id: z.string().nullable().default(null),
});
export type LearningLoopDecision = z.infer<typeof LearningLoopDecisionSchema>;

export const LearningLoopRunResponseSchema = z.object({
  ok: z.literal(true),
  run_version: z.literal("learning_loop_run_v1"),
  tenant_id: z.string().min(1),
  scope: z.string().min(1),
  mode: LearningLoopModeSchema,
  actor: z.string().min(1),
  scanned: z.object({
    workflow_candidates: z.number().int().min(0),
    pattern_anchors: z.number().int().min(0),
    policy_memories: z.number().int().min(0),
    forgetting_nodes: z.number().int().min(0),
  }),
  decisions: z.array(LearningLoopDecisionSchema).max(200),
  applied_count: z.number().int().min(0),
  source_code_change_allowed: z.literal(false),
});
export type LearningLoopRunResponse = z.infer<typeof LearningLoopRunResponseSchema>;

export type LearningLoopLiteOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
};

type LearningLoopLiteStore = Pick<
  LiteWriteStore,
  "findExecutionNativeNodes" | "findNodes" | "updateNodeAnchorState" | "withTx"
> & LiteWriteStore;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )).slice(0, 64);
}

function numberField(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function limitText(value: string | null | undefined, maxLength: number): string {
  const normalized = (value ?? "").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function decision(args: Omit<LearningLoopDecision, "decision_version" | "source_code_change_allowed">): LearningLoopDecision {
  return LearningLoopDecisionSchema.parse({
    decision_version: "learning_loop_decision_v1",
    source_code_change_allowed: false,
    ...args,
  });
}

type ForgettingMutationAction = "demote_memory" | "archive_memory";

const DEFAULT_FORGETTING_MUTATION_POLICY = ForgettingMutationPolicySchema.parse({});
const HOURS_TO_MS = 60 * 60 * 1000;

const HIGH_LEVEL_FORGETTING_SUMMARY_KINDS = new Set([
  "workflow_anchor",
  "pattern_anchor",
  "policy_memory",
  "compression_rollup",
]);

function asMemoryEvolutionAction(value: unknown): MemoryEvolutionAction | null {
  if (value === "retain" || value === "demote" || value === "archive" || value === "rehydrate" || value === "review") {
    return value;
  }
  return null;
}

function forgettingMutationAction(action: MemoryEvolutionAction): ForgettingMutationAction | null {
  if (action === "demote") return "demote_memory";
  if (action === "archive") return "archive_memory";
  return null;
}

function resolveForgettingMutationPolicy(value: unknown): ForgettingMutationPolicy {
  return ForgettingMutationPolicySchema.parse(value ?? DEFAULT_FORGETTING_MUTATION_POLICY);
}

function parseTimeMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function ageMs(createdAt: unknown, referenceTime: unknown): number | null {
  const created = parseTimeMs(createdAt);
  const reference = parseTimeMs(referenceTime);
  if (created == null || reference == null) return null;
  const age = reference - created;
  return Number.isFinite(age) ? age : null;
}

function feedbackQuality(slots: Record<string, unknown>): number {
  const direct = numberField(slots.feedback_quality);
  if (direct != null) return Math.max(-1, Math.min(1, direct));
  const positive = Math.max(0, numberField(slots.feedback_positive) ?? 0);
  const negative = Math.max(0, numberField(slots.feedback_negative) ?? 0);
  if (positive <= 0 && negative <= 0) return 0;
  return Math.max(-1, Math.min(1, (positive - negative) / Math.max(1, positive + negative)));
}

function isLowLevelExecutionMemory(args: {
  row: LiteFindNodeRow;
  compressionLayer: string | null;
  highLevelForgettingSurface: boolean;
}): boolean {
  if (args.highLevelForgettingSurface) return false;
  if (args.compressionLayer === "L0" || args.compressionLayer === "L1") return true;
  return args.row.type === "event" || args.row.type === "evidence";
}

function hasExplicitForgettingLifecycleSignal(args: {
  slots: Record<string, unknown>;
  forgetting: Record<string, unknown>;
  rationale: string[];
}): boolean {
  const lifecycleState = firstString(args.forgetting.lifecycle_state, args.slots.lifecycle_state);
  const policyState = resolveNodePolicyMemoryState(args.slots);
  const credibilityState = resolveNodeCredibilityState(args.slots);
  const quality = feedbackQuality(args.slots);
  return lifecycleState === "contested"
    || lifecycleState === "retired"
    || policyState === "contested"
    || policyState === "retired"
    || credibilityState === "contested"
    || quality <= -0.7
    || args.rationale.includes("contested_lifecycle_state")
    || args.rationale.includes("retired_policy_memory");
}

function forgettingMutationAdmissibility(args: {
  row: LiteFindNodeRow;
  forgetting: Record<string, unknown>;
  now: string;
  policy: ForgettingMutationPolicy;
}): { admissible: boolean; reasons: string[] } {
  const slots = asRecord(args.row.slots) ?? {};
  const rationale = stringList(args.forgetting.rationale);
  const summaryKind = resolveNodeSummaryKind(slots);
  const compressionLayer = resolveNodeCompressionLayer({
    type: args.row.type,
    slots,
  });
  const executionKind = resolveNodeExecutionKind(slots);
  const highLevelForgettingSurface = compressionLayer === "L2"
    || compressionLayer === "L3"
    || compressionLayer === "L4"
    || compressionLayer === "L5"
    || (summaryKind != null && HIGH_LEVEL_FORGETTING_SUMMARY_KINDS.has(summaryKind));
  const explicitLifecycleSignal = hasExplicitForgettingLifecycleSignal({
    slots,
    forgetting: args.forgetting,
    rationale,
  });
  const age = ageMs(args.row.created_at, args.now);
  const lowLevelGraceMs = args.policy.low_level_grace_hours * HOURS_TO_MS;
  const fresh = age == null || age < lowLevelGraceMs;
  const staleEnough = age != null && age >= lowLevelGraceMs;
  const lowLevelExecutionMemory = isLowLevelExecutionMemory({
    row: args.row,
    compressionLayer,
    highLevelForgettingSurface,
  });

  const lifecycleMutationAllowed = explicitLifecycleSignal && args.policy.allow_explicit_lifecycle_mutation;
  const highLevelMutationAllowed = highLevelForgettingSurface && args.policy.allow_high_level_mutation;
  const staleLowLevelMutationAllowed = staleEnough && args.policy.allow_low_level_stale_mutation;

  if (lifecycleMutationAllowed || highLevelMutationAllowed || staleLowLevelMutationAllowed) {
    return {
      admissible: true,
      reasons: [
        `forgetting_mutation_policy_${args.policy.policy_id}`,
        ...(lifecycleMutationAllowed ? ["explicit_lifecycle_or_feedback_signal"] : []),
        ...(highLevelMutationAllowed ? ["high_level_cognitive_memory_surface"] : []),
        ...(staleLowLevelMutationAllowed ? ["memory_age_exceeds_forgetting_grace_period"] : []),
      ],
    };
  }

  if (lowLevelExecutionMemory && fresh) {
    return {
      admissible: false,
      reasons: [
        `forgetting_mutation_policy_${args.policy.policy_id}`,
        "maintenance_mutation_not_admissible",
        "fresh_low_level_memory_grace_period",
        `low_level_grace_hours_${args.policy.low_level_grace_hours}`,
        `compression_layer_${compressionLayer ?? "unknown"}`,
        ...(summaryKind ? [`summary_kind_${summaryKind}`] : ["summary_kind_missing"]),
        ...(executionKind ? [`execution_kind_${executionKind}`] : []),
        "low_level_memory_requires_staleness_or_explicit_lifecycle_signal",
      ],
    };
  }

  return {
    admissible: false,
    reasons: [
      `forgetting_mutation_policy_${args.policy.policy_id}`,
      "maintenance_mutation_not_admissible",
      "forgetting_mutation_requires_high_level_stale_or_explicit_lifecycle_signal",
      ...(!args.policy.allow_explicit_lifecycle_mutation && explicitLifecycleSignal
        ? ["explicit_lifecycle_mutation_disabled_by_policy"]
        : []),
      ...(!args.policy.allow_high_level_mutation && highLevelForgettingSurface
        ? ["high_level_mutation_disabled_by_policy"]
        : []),
      ...(!args.policy.allow_low_level_stale_mutation && staleEnough
        ? ["stale_low_level_mutation_disabled_by_policy"]
        : []),
      ...(summaryKind ? [`summary_kind_${summaryKind}`] : ["summary_kind_missing"]),
      `compression_layer_${compressionLayer ?? "unknown"}`,
    ],
  };
}

async function insertLearningLoopMutationCommit(args: {
  liteWriteStore: LearningLoopLiteStore;
  scope: string;
  actor: string;
  kind: string;
  input: Record<string, unknown>;
  diff: Record<string, unknown>;
}): Promise<string> {
  const parent = await args.liteWriteStore.latestCommit(args.scope);
  const inputSha = sha256Hex(stableStringify(args.input));
  const diffJson = stableStringify(args.diff);
  const diffSha = sha256Hex(diffJson);
  const commitHash = sha256Hex(stableStringify({
    parentHash: parent?.commit_hash ?? "",
    inputSha,
    diffSha,
    scope: args.scope,
    actor: args.actor,
    kind: args.kind,
  }));
  return await args.liteWriteStore.insertCommit({
    scope: args.scope,
    parentCommitId: parent?.id ?? null,
    inputSha256: inputSha,
    diffJson,
    actor: args.actor,
    modelVersion: null,
    promptVersion: null,
    commitHash,
  });
}

function workflowPromotionOrigin(value: unknown): "execution_write_projection" | "replay_learning_projection" {
  const raw = firstString(value);
  return raw && raw.startsWith("replay_") ? "replay_learning_projection" : "execution_write_projection";
}

function sourceKindForWorkflowOrigin(value: unknown): "execution_write" | "playbook" {
  return workflowPromotionOrigin(value) === "replay_learning_projection" ? "playbook" : "execution_write";
}

function workflowEvidenceRefs(slots: Record<string, unknown>): string[] {
  const evidence = asRecord(slots.execution_evidence_v1);
  return stringList(evidence?.evidence_refs);
}

function workflowPromotionData(row: LiteFindNodeRow): {
  slots: Record<string, unknown>;
  native: Record<string, unknown>;
  promotion: Record<string, unknown>;
  contract: Record<string, unknown> | null;
  contractTrust: "authoritative" | "advisory" | "observational" | null;
  workflowSignature: string | null;
  taskSignature: string | null;
  observedCount: number | null;
  requiredObservations: number | null;
  authorityGate: Record<string, unknown> | null;
  evidenceAssessment: Record<string, unknown> | null;
} {
  const slots = asRecord(row.slots) ?? {};
  const native = asRecord(slots.execution_native_v1) ?? {};
  const promotion = asRecord(native.workflow_promotion) ?? asRecord(slots.workflow_promotion) ?? {};
  const contract = resolveNodeExecutionContract({ slots }) as Record<string, unknown> | null;
  return {
    slots,
    native,
    promotion,
    contract,
    contractTrust: resolveNodeExecutionContractTrust({ slots }),
    workflowSignature: resolveNodeWorkflowSignature({ slots }),
    taskSignature: resolveNodeTaskSignature({ slots }),
    observedCount: numberField(promotion.observed_count),
    requiredObservations: numberField(promotion.required_observations),
    authorityGate: asRecord(slots.authority_gate_v1),
    evidenceAssessment: asRecord(slots.execution_evidence_assessment),
  };
}

async function processWorkflowCandidate(args: {
  liteWriteStore: LearningLoopLiteStore;
  row: LiteFindNodeRow;
  tenantId: string;
  scope: string;
  actor: string;
  mode: "dry_run" | "apply";
  now: string;
  opts: LearningLoopLiteOptions;
}): Promise<LearningLoopDecision> {
  const data = workflowPromotionData(args.row);
  const reasons: string[] = [];
  const observed = data.observedCount ?? 0;
  const required = data.requiredObservations ?? 2;

  if (!data.workflowSignature) reasons.push("missing_workflow_signature");
  if (!data.contract) reasons.push("missing_execution_contract");
  if (data.contractTrust !== "authoritative") reasons.push("workflow_contract_not_authoritative");
  if (observed < required) reasons.push("insufficient_distinct_observations");
  if (data.authorityGate?.allows_authoritative !== true) reasons.push("authority_gate_blocks_authoritative");
  if (data.authorityGate?.allows_stable_promotion !== true) reasons.push("authority_gate_blocks_stable_promotion");
  if (data.evidenceAssessment?.status !== "succeeded") reasons.push("execution_evidence_not_succeeded");

  if (data.workflowSignature) {
    const existingStable = await args.liteWriteStore.findExecutionNativeNodes({
      scope: args.scope,
      executionKind: "workflow_anchor",
      workflowSignature: data.workflowSignature,
      consumerAgentId: args.row.owner_agent_id ?? null,
      consumerTeamId: args.row.owner_team_id ?? null,
      limit: 4,
      offset: 0,
    });
    if (existingStable.rows.length > 0) reasons.push("stable_workflow_already_exists");
  }

  if (reasons.length > 0) {
    return decision({
      surface: "workflow",
      target_id: args.row.id,
      action: reasons.includes("stable_workflow_already_exists") ? "skip" : "monitor",
      applied: false,
      mode: args.mode,
      reasons,
      confidence: 0.64,
      policy_mutation_v1: null,
      policy_mutation_adjudication_v1: null,
      commit_id: null,
    });
  }

  const workflowSignature = data.workflowSignature!;
  const stableClientId = `learning_loop:workflow:stable:${workflowSignature}`;
  const stableNodeId = stableUuid(`${args.scope}:node:${stableClientId}`);
  const promotionOrigin = workflowPromotionOrigin(data.promotion.promotion_origin);
  const policyMutation = buildPolicyMutationFromWorkflowPromotion({
    scope: args.scope,
    workflow_memory_id: stableNodeId,
    workflow_signature: workflowSignature,
    task_signature: data.taskSignature,
    source_node_id: args.row.id,
    origin: promotionOrigin,
    observed_count: observed,
    required_observations: required,
    authority_gate_allows_stable_promotion: true,
    learning_control_admissible: true,
    runtime_apply_changed_promotion_state: true,
    execution_evidence_status: "succeeded",
    execution_evidence_refs: workflowEvidenceRefs(data.slots),
  });
  const adjudication = adjudicatePolicyMutationV1(policyMutation);
  if (!adjudication.admissible) {
    return decision({
      surface: "workflow",
      target_id: args.row.id,
      action: "monitor",
      applied: false,
      mode: args.mode,
      reasons: adjudication.reasons,
      confidence: 0.58,
      policy_mutation_v1: policyMutation,
      policy_mutation_adjudication_v1: adjudication,
      commit_id: null,
    });
  }

  if (args.mode === "dry_run") {
    return decision({
      surface: "workflow",
      target_id: args.row.id,
      action: "promote_workflow",
      applied: false,
      mode: args.mode,
      reasons: ["eligible_for_stable_workflow_promotion", "dry_run_no_mutation"],
      confidence: 0.9,
      policy_mutation_v1: policyMutation,
      policy_mutation_adjudication_v1: adjudication,
      commit_id: null,
    });
  }

  const title = limitText(firstString(args.row.title, args.row.text_summary, workflowSignature), 200);
  const summary = limitText(firstString(args.row.text_summary, args.row.title, workflowSignature), 400);
  const toolSet = resolveNodeToolSet({ slots: data.slots }).slice(0, 32);
  const targetFiles = resolveNodeTargetFiles({ slots: data.slots }).slice(0, 64);
  const workflowSteps = resolveNodeWorkflowSteps({ slots: data.slots }).slice(0, 64);
  const patternHints = resolveNodePatternHints({ slots: data.slots }).slice(0, 64);
  const serviceLifecycleConstraints = resolveNodeServiceLifecycleConstraints({ slots: data.slots }).slice(0, 16);
  const executionEvidenceRefs = workflowEvidenceRefs(data.slots);
  const promotionEvidenceLedger = buildPromotionEvidenceLedgerV1({
    targetKind: "workflow",
    targetId: stableNodeId,
    sourceLayers: ["L1"],
    targetLayer: "L2",
    transition: "L1_to_L2",
    promotionState: "stable",
    promotionOrigin: promotionOrigin,
    observedCount: observed,
    requiredCount: required,
    authorityGateAdmitted: data.authorityGate?.allows_stable_promotion === true,
    learningControlAdmitted: true,
    verifierStatus: "succeeded",
    contractTrust: data.contractTrust,
    sourceNodeIds: [args.row.id],
    sourceCommitIds: [args.row.commit_id ?? null],
    promotionEvidenceRefs: executionEvidenceRefs,
    reasonCodes: ["learning_loop_promote_workflow", "workflow_promotion_gate_committed_stable_memory"],
    evidence: [
      {
        evidence_id: `${stableNodeId}:observation_gate`,
        evidence_kind: "distinct_observation",
        polarity: "positive",
        source_ref: args.row.id,
        claim: `observed ${observed} of ${required} required workflow observations`,
        confidence: 0.86,
      },
      {
        evidence_id: `${stableNodeId}:authority_gate`,
        evidence_kind: "authority_gate",
        polarity: data.authorityGate?.allows_stable_promotion === true ? "positive" : "negative",
        source_ref: `${args.row.id}:authority_gate_v1`,
        claim: data.authorityGate?.allows_stable_promotion === true
          ? "authority gate admits stable workflow promotion"
          : "authority gate does not admit stable workflow promotion",
        confidence: 0.86,
      },
      {
        evidence_id: `${stableNodeId}:learning_control`,
        evidence_kind: "learning_control",
        polarity: "positive",
        source_ref: `${stableNodeId}:policy_mutation_v1`,
        claim: "learning control admitted workflow promotion mutation",
        confidence: 0.86,
      },
      ...(executionEvidenceRefs.length > 0
        ? [{
            evidence_id: `${stableNodeId}:runtime_verifier`,
            evidence_kind: "runtime_verifier" as const,
            polarity: "positive" as const,
            source_ref: executionEvidenceRefs[0]!,
            claim: "execution evidence succeeded for promoted workflow",
            confidence: 0.9,
          }]
        : []),
    ],
  });
  const workflowPromotion = buildWorkflowPromotionMetadata({
    promotion_state: "stable",
    promotion_origin: promotionOrigin === "replay_learning_projection" ? "replay_learning_auto_promotion" : "execution_write_auto_promotion",
    observed_count: observed,
    required_observations: required,
    at: args.now,
  });
  const maintenance = buildWorkflowMaintenanceMetadata({
    promotion_state: "stable",
    at: args.now,
  });
  const rehydration = {
    default_mode: "partial" as const,
    payload_cost_hint: "medium" as const,
    recommended_when: ["workflow_summary_is_not_enough", "continuity_resume_needs_evidence"],
  };
  const anchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    contract_trust: data.contractTrust,
    task_signature: data.taskSignature ?? workflowSignature,
    task_class: "learning_loop_promotion",
    ...(resolveNodeTaskFamily({ slots: data.slots }) ? { task_family: resolveNodeTaskFamily({ slots: data.slots }) } : {}),
    workflow_signature: workflowSignature,
    summary,
    tool_set: toolSet,
    file_path: resolveNodeFilePath({ slots: data.slots }),
    target_files: targetFiles,
    next_action: resolveNodeNextAction({ slots: data.slots }),
    ...(workflowSteps.length > 0 ? { key_steps: workflowSteps } : {}),
    ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
    ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    outcome_contract_gate: data.authorityGate?.outcome_contract_gate ?? data.slots.outcome_contract_gate,
    outcome: {
      status: "success",
      result_class: "learning_loop_stable_workflow",
      success_score: 0.9,
    },
    source: {
      source_kind: sourceKindForWorkflowOrigin(data.promotion.promotion_origin),
      node_id: args.row.id,
      commit_id: args.row.commit_id ?? null,
    },
    payload_refs: {
      node_ids: [args.row.id],
      decision_ids: [],
      run_ids: [],
      step_ids: [],
      commit_ids: args.row.commit_id ? [args.row.commit_id] : [],
    },
    rehydration,
    recall_features: {
      tool_tags: toolSet,
      outcome_tags: ["learning_loop", "stable_workflow"],
      keywords: [title, summary, workflowSignature].filter(Boolean).slice(0, 8),
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 0,
      reuse_failure_count: 0,
      distinct_run_count: 0,
      last_used_at: null,
    },
    maintenance,
    workflow_promotion: workflowPromotion,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
    schema_version: "anchor_v1",
  });
  const executionNative = ExecutionNativeV1Schema.parse({
    ...(data.native ?? {}),
    schema_version: "execution_native_v1",
    execution_kind: "workflow_anchor",
    summary_kind: "workflow_anchor",
    compression_layer: "L2",
    contract_trust: data.contractTrust,
    task_signature: anchor.task_signature,
    ...(anchor.task_family ? { task_family: anchor.task_family } : {}),
    workflow_signature: workflowSignature,
    anchor_kind: "workflow",
    anchor_level: "L2",
    tool_set: toolSet,
    file_path: anchor.file_path ?? null,
    target_files: targetFiles,
    next_action: anchor.next_action ?? null,
    ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
    ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
    ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    outcome_contract_gate: data.authorityGate?.outcome_contract_gate ?? data.slots.outcome_contract_gate,
    workflow_promotion: workflowPromotion,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
    maintenance,
    rehydration,
  });

  const stableSlots = {
    summary_kind: "workflow_anchor",
    compression_layer: "L2",
    lifecycle_state: "active",
    contract_trust: data.contractTrust,
    anchor_v1: anchor,
    execution_contract_v1: data.contract,
    outcome_contract_gate: data.authorityGate?.outcome_contract_gate ?? data.slots.outcome_contract_gate,
    ...(data.slots.execution_evidence_v1 ? { execution_evidence_v1: data.slots.execution_evidence_v1 } : {}),
    execution_evidence_assessment: data.evidenceAssessment,
    authority_gate_v1: data.authorityGate,
    policy_mutation_v1: policyMutation,
    policy_mutation_adjudication_v1: adjudication,
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
    execution_native_v1: executionNative,
    learning_loop_v1: {
      loop_version: "learning_loop_run_v1",
      action: "promote_workflow",
      source_candidate_id: args.row.id,
      applied_at: args.now,
      actor: args.actor,
    },
  };
  const lifecycle = resolveNodeLifecycleSignals({
    type: "procedure",
    tier: "hot",
    title,
    text_summary: summary,
    slots: stableSlots,
    salience: Math.max(args.row.salience, 0.72),
    importance: Math.max(args.row.importance, 0.72),
    confidence: Math.max(args.row.confidence, 0.82),
    raw_ref: args.row.raw_ref ?? null,
    evidence_ref: args.row.evidence_ref ?? null,
    reference_time: args.now,
  });
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: args.tenantId,
      scope: args.scope,
      actor: args.actor,
      input_text: `learning_loop promote workflow ${workflowSignature}`,
      auto_embed: false,
      distill: { enabled: false },
      nodes: [{
        id: stableNodeId,
        client_id: stableClientId,
        type: "procedure",
        tier: "hot",
        memory_lane: args.row.memory_lane,
        producer_agent_id: args.actor,
        owner_agent_id: args.row.owner_agent_id ?? undefined,
        owner_team_id: args.row.owner_team_id ?? undefined,
        title,
        text_summary: summary,
        slots: lifecycle.slots,
        salience: lifecycle.salience,
        importance: lifecycle.importance,
        confidence: lifecycle.confidence,
      }],
      edges: [{
        type: "derived_from",
        src: { id: stableNodeId },
        dst: { id: args.row.id },
        weight: 0.92,
        confidence: 0.9,
      }],
    },
    args.opts.defaultScope,
    args.opts.defaultTenantId,
    {
      maxTextLen: args.opts.maxTextLen,
      piiRedaction: args.opts.piiRedaction,
      allowCrossScopeEdges: args.opts.allowCrossScopeEdges,
    },
    null,
  );
  const preparedStableNode = prepared.nodes[0];
  const preparedAuthorityGate = preparedStableNode
    ? runtimeAuthorityGateFromValue(preparedStableNode.slots.authority_gate_v1)
    : null;
  if (preparedStableNode && preparedAuthorityGate) {
    sealRuntimeAuthorityEffectReceipt({
      effectKind: "stable_workflow_projection",
      node: preparedStableNode,
      slots: preparedStableNode.slots,
      authorityGate: preparedAuthorityGate,
      issuedAt: args.now,
      mutate: true,
      requireAuthorityClaims: true,
    });
  }
  const out = await args.liteWriteStore.withTx(() =>
    applyPreparedMemoryWrite(args.liteWriteStore, prepared, {
      maxTextLen: args.opts.maxTextLen,
      piiRedaction: args.opts.piiRedaction,
      allowCrossScopeEdges: args.opts.allowCrossScopeEdges,
    }),
  );
  await markNodeLearningLoopDecision({
    liteWriteStore: args.liteWriteStore,
    scope: args.scope,
    row: args.row,
    decision: {
      action: "promote_workflow",
      status: "applied",
      stable_node_id: stableNodeId,
      commit_id: out.commit_id,
      applied_at: args.now,
      actor: args.actor,
    },
  });

  return decision({
    surface: "workflow",
    target_id: args.row.id,
    action: "promote_workflow",
    applied: true,
    mode: args.mode,
    reasons: ["eligible_for_stable_workflow_promotion", "stable_workflow_written"],
    confidence: 0.9,
    policy_mutation_v1: policyMutation,
    policy_mutation_adjudication_v1: adjudication,
    commit_id: out.commit_id,
  });
}

async function markNodeLearningLoopDecision(args: {
  liteWriteStore: Pick<LiteWriteStore, "updateNodeAnchorState">;
  scope: string;
  row: LiteFindNodeRow;
  decision: Record<string, unknown>;
}) {
  const slots = {
    ...(asRecord(args.row.slots) ?? {}),
    learning_loop_v1: {
      loop_version: "learning_loop_run_v1",
      ...args.decision,
    },
  };
  const lifecycle = resolveNodeLifecycleSignals({
    type: args.row.type,
    tier: args.row.tier,
    title: args.row.title,
    text_summary: args.row.text_summary,
    slots,
    salience: args.row.salience,
    importance: args.row.importance,
    confidence: args.row.confidence,
    raw_ref: args.row.raw_ref ?? null,
    evidence_ref: args.row.evidence_ref ?? null,
  });
  await args.liteWriteStore.updateNodeAnchorState({
    scope: args.scope,
    id: args.row.id,
    slots: lifecycle.slots,
    textSummary: args.row.text_summary,
    salience: lifecycle.salience,
    importance: lifecycle.importance,
    confidence: lifecycle.confidence,
    commitId: firstString(args.decision.commit_id),
  });
}

async function processPolicyMemory(args: {
  liteWriteStore: LearningLoopLiteStore;
  row: LiteFindNodeRow;
  tenantId: string;
  scope: string;
  actor: string;
  mode: "dry_run" | "apply";
  now: string;
}): Promise<LearningLoopDecision> {
  const slots = asRecord(args.row.slots) ?? {};
  const surface = resolveNodePolicyMemorySurface(slots);
  const positive = numberField(slots.feedback_positive) ?? 0;
  const negative = numberField(slots.feedback_negative) ?? 0;
  const shouldRetire = surface.policy_memory_state === "active" && negative >= 2 && negative > positive;
  if (!shouldRetire) {
    return decision({
      surface: "policy",
      target_id: args.row.id,
      action: "monitor",
      applied: false,
      mode: args.mode,
      reasons: ["policy_memory_not_ready_for_lifecycle_mutation"],
      confidence: 0.58,
      policy_mutation_v1: null,
      policy_mutation_adjudication_v1: null,
      commit_id: null,
    });
  }
  if (args.mode === "dry_run") {
    return decision({
      surface: "policy",
      target_id: args.row.id,
      action: "retire_policy",
      applied: false,
      mode: args.mode,
      reasons: ["negative_feedback_exceeds_positive_feedback", "dry_run_no_mutation"],
      confidence: 0.76,
      policy_mutation_v1: null,
      policy_mutation_adjudication_v1: null,
      commit_id: null,
    });
  }

  const applied = await args.liteWriteStore.withTx(() =>
    applyPolicyMemoryLearningControlLite(args.liteWriteStore, {
      tenant_id: args.tenantId,
      scope: args.scope,
      policy_memory_id: args.row.id,
      action: "retire",
      actor: args.actor,
      reason: "learning_loop_negative_feedback_threshold",
      applied_at: args.now,
    }),
  );
  const mutation = buildPolicyMutationFromLearningControlApply({
    tenant_id: args.tenantId,
    scope: args.scope,
    policy_memory_id: applied.policy_memory.node_id,
    action: "retire",
    actor: args.actor,
    reason: "learning_loop_negative_feedback_threshold",
    previous_state: applied.previous_state,
    next_state: applied.next_state,
    learning_control_contract_present: false,
    live_policy_contract_present: false,
    contract_trust: applied.policy_memory.policy_contract.contract_trust ?? null,
    activation_mode: applied.policy_memory.policy_contract.activation_mode,
    selected_tool: applied.policy_memory.selected_tool,
    workflow_signature: applied.policy_memory.policy_contract.workflow_signature,
    file_path: applied.policy_memory.policy_contract.file_path,
  });
  const adjudication = adjudicatePolicyMutationV1(mutation);
  const refreshed = await args.liteWriteStore.findNodes({
    scope: args.scope,
    id: args.row.id,
    limit: 1,
    offset: 0,
  });
  const nextRow = refreshed.rows[0];
  if (nextRow) {
    const nextSlots = {
      ...(asRecord(nextRow.slots) ?? {}),
      policy_mutation_v1: mutation,
      policy_mutation_adjudication_v1: adjudication,
      learning_loop_v1: {
        loop_version: "learning_loop_run_v1",
        action: "retire_policy",
        status: "applied",
        applied_at: args.now,
        actor: args.actor,
      },
    };
    await args.liteWriteStore.updateNodeAnchorState({
      scope: args.scope,
      id: nextRow.id,
      slots: nextSlots,
      textSummary: nextRow.text_summary,
      salience: nextRow.salience,
      importance: nextRow.importance,
      confidence: nextRow.confidence,
      commitId: nextRow.commit_id ?? null,
    });
  }

  return decision({
    surface: "policy",
    target_id: args.row.id,
    action: "retire_policy",
    applied: true,
    mode: args.mode,
    reasons: ["negative_feedback_exceeds_positive_feedback", "policy_memory_retired"],
    confidence: 0.76,
    policy_mutation_v1: mutation,
    policy_mutation_adjudication_v1: adjudication,
    commit_id: null,
  });
}

async function processMemoryForgetting(args: {
  liteWriteStore: LearningLoopLiteStore;
  row: LiteFindNodeRow;
  scope: string;
  actor: string;
  mode: "dry_run" | "apply";
  now: string;
  forgettingMutationPolicy: ForgettingMutationPolicy;
}): Promise<LearningLoopDecision> {
  const currentTier = normalizeMemoryTier(args.row.tier);
  const lifecycle = resolveNodeLifecycleSignals({
    type: args.row.type,
    tier: currentTier,
    title: args.row.title,
    text_summary: args.row.text_summary,
    slots: asRecord(args.row.slots) ?? {},
    salience: args.row.salience,
    importance: args.row.importance,
    confidence: args.row.confidence,
    raw_ref: args.row.raw_ref ?? null,
    evidence_ref: args.row.evidence_ref ?? null,
    reference_time: args.now,
  });
  const forgetting = asRecord(lifecycle.slots.semantic_forgetting_v1) ?? {};
  const semanticAction = asMemoryEvolutionAction(forgetting.action);
  const mutationAction = semanticAction ? forgettingMutationAction(semanticAction) : null;
  const requestedTargetTier = firstString(forgetting.target_tier);
  const targetTier: MemoryTierName | null = semanticAction
    ? resolveTierTransitionTarget({
        current_tier: currentTier,
        action: semanticAction,
        requested_target_tier: requestedTargetTier,
      })
    : null;
  const transitionMovesColder = targetTier
    ? compareMemoryTierRank(targetTier, currentTier) < 0
    : false;
  const rationale = stringList(forgetting.rationale);

  if (!semanticAction || !mutationAction || !targetTier || !transitionMovesColder) {
    return decision({
      surface: "forgetting",
      target_id: args.row.id,
      action: "monitor",
      applied: false,
      mode: args.mode,
      reasons: [
        ...(semanticAction ? [`semantic_action_${semanticAction}`] : ["missing_semantic_forgetting_action"]),
        ...(targetTier && targetTier === currentTier ? ["already_at_target_tier"] : []),
        ...(rationale.length > 0 ? rationale : ["memory_not_ready_for_forgetting_mutation"]),
      ].slice(0, 24),
      confidence: 0.54,
      policy_mutation_v1: null,
      policy_mutation_adjudication_v1: null,
      commit_id: null,
    });
  }

  const reasons = [
    `semantic_action_${semanticAction}`,
    `tier_transition_${currentTier}_to_${targetTier}`,
    ...rationale,
  ].slice(0, 24);
  const admissibility = forgettingMutationAdmissibility({
    row: args.row,
    forgetting,
    now: args.now,
    policy: args.forgettingMutationPolicy,
  });
  if (!admissibility.admissible) {
    return decision({
      surface: "forgetting",
      target_id: args.row.id,
      action: "monitor",
      applied: false,
      mode: args.mode,
      reasons: [
        `semantic_action_${semanticAction}`,
        `tier_transition_${currentTier}_to_${targetTier}`,
        ...rationale,
        ...admissibility.reasons,
        "semantic_forgetting_signal_recorded_without_tier_mutation",
      ].slice(0, 24),
      confidence: 0.6,
      policy_mutation_v1: null,
      policy_mutation_adjudication_v1: null,
      commit_id: null,
    });
  }
  if (args.mode === "dry_run") {
    return decision({
      surface: "forgetting",
      target_id: args.row.id,
      action: mutationAction,
      applied: false,
      mode: args.mode,
      reasons: [...reasons, ...admissibility.reasons, "dry_run_no_mutation"].slice(0, 24),
      confidence: semanticAction === "archive" ? 0.8 : 0.72,
      policy_mutation_v1: null,
      policy_mutation_adjudication_v1: null,
      commit_id: null,
    });
  }

  const nextSlots = {
    ...lifecycle.slots,
    controlled_forgetting_v1: {
      schema_version: "controlled_forgetting_v1",
      loop_version: "learning_loop_run_v1",
      action: mutationAction,
      semantic_action: semanticAction,
      previous_tier: currentTier,
      target_tier: targetTier,
      retention_score: numberField(forgetting.retention_score),
      applied_at: args.now,
      actor: args.actor,
      source_code_change_allowed: false,
    },
    learning_loop_v1: {
      loop_version: "learning_loop_run_v1",
      action: mutationAction,
      status: "applied",
      previous_tier: currentTier,
      target_tier: targetTier,
      semantic_action: semanticAction,
      applied_at: args.now,
      actor: args.actor,
    },
  };
  const commitId = await args.liteWriteStore.withTx(async () => {
    const nextCommitId = await insertLearningLoopMutationCommit({
      liteWriteStore: args.liteWriteStore,
      scope: args.scope,
      actor: args.actor,
      kind: "learning_loop_controlled_forgetting",
      input: {
        node_id: args.row.id,
        action: mutationAction,
        previous_tier: currentTier,
        target_tier: targetTier,
      },
      diff: {
        job: "learning_loop_controlled_forgetting",
        node_id: args.row.id,
        actor: args.actor,
        action: mutationAction,
        semantic_action: semanticAction,
        previous_tier: currentTier,
        target_tier: targetTier,
        retention_score: numberField(forgetting.retention_score),
        source_code_change_allowed: false,
      },
    });
    await args.liteWriteStore.updateNodeAnchorState({
      scope: args.scope,
      id: args.row.id,
      tier: targetTier,
      slots: nextSlots,
      textSummary: args.row.text_summary,
      salience: lifecycle.salience,
      importance: lifecycle.importance,
      confidence: lifecycle.confidence,
      commitId: nextCommitId,
    });
    return nextCommitId;
  });

  return decision({
    surface: "forgetting",
    target_id: args.row.id,
    action: mutationAction,
    applied: true,
    mode: args.mode,
    reasons: [...reasons, ...admissibility.reasons, "memory_tier_mutated"].slice(0, 24),
    confidence: semanticAction === "archive" ? 0.8 : 0.72,
    policy_mutation_v1: null,
    policy_mutation_adjudication_v1: null,
    commit_id: commitId,
  });
}

async function processPatternAnchor(args: {
  row: LiteFindNodeRow;
  mode: "dry_run" | "apply";
}): Promise<LearningLoopDecision> {
  const slots = asRecord(args.row.slots) ?? {};
  const native = asRecord(slots.execution_native_v1) ?? {};
  const promotion = asRecord(native.promotion) ?? asRecord(slots.promotion) ?? {};
  const distinct = numberField(promotion.distinct_run_count) ?? 0;
  const required = numberField(promotion.required_distinct_runs) ?? 2;
  const counterOpen = promotion.counter_evidence_open === true;
  const ready = distinct >= required && !counterOpen;
  return decision({
    surface: "pattern",
    target_id: args.row.id,
    action: "monitor",
    applied: false,
    mode: args.mode,
    reasons: ready
      ? ["pattern_ready_requires_form_pattern_learning_control_review"]
      : ["pattern_not_ready_for_trust_mutation"],
    confidence: ready ? 0.66 : 0.54,
    policy_mutation_v1: null,
    policy_mutation_adjudication_v1: null,
    commit_id: null,
  });
}

export async function runLearningLoopLite(
  liteWriteStore: LearningLoopLiteStore,
  body: unknown,
  opts: LearningLoopLiteOptions,
): Promise<LearningLoopRunResponse> {
  const parsed = LearningLoopRunRequestSchema.parse(body);
  const forgettingMutationPolicy = resolveForgettingMutationPolicy(parsed.forgetting_mutation_policy);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const actor = firstString(parsed.actor) ?? "learning_loop";
  const now = new Date().toISOString();
  const surfaces = new Set(parsed.surfaces);
  const scanned = {
    workflow_candidates: 0,
    pattern_anchors: 0,
    policy_memories: 0,
    forgetting_nodes: 0,
  };
  const decisions: LearningLoopDecision[] = [];
  const canMutate = () => parsed.mode === "apply" && decisions.filter((entry) => entry.applied).length < parsed.max_mutations;

  if (surfaces.has("workflow")) {
    const workflows = await liteWriteStore.findExecutionNativeNodes({
      scope: tenancy.scope_key,
      executionKind: "workflow_candidate",
      limit: parsed.limit,
      offset: 0,
    });
    scanned.workflow_candidates = workflows.rows.length;
    for (const row of workflows.rows) {
      const mode = parsed.mode === "apply" && !canMutate() ? "dry_run" : parsed.mode;
      decisions.push(await processWorkflowCandidate({
        liteWriteStore,
        row,
        tenantId: tenancy.tenant_id,
        scope: tenancy.scope_key,
        actor,
        mode,
        now,
        opts,
      }));
    }
  }

  if (surfaces.has("policy")) {
    const policies = await liteWriteStore.findNodes({
      scope: tenancy.scope_key,
      type: "concept",
      slotsContains: { summary_kind: "policy_memory" },
      limit: parsed.limit,
      offset: 0,
    });
    scanned.policy_memories = policies.rows.length;
    for (const row of policies.rows) {
      const mode = parsed.mode === "apply" && !canMutate() ? "dry_run" : parsed.mode;
      decisions.push(await processPolicyMemory({
        liteWriteStore,
        row,
        tenantId: tenancy.tenant_id,
        scope: tenancy.scope_key,
        actor,
        mode,
        now,
      }));
    }
  }

  if (surfaces.has("forgetting")) {
    const nodes = await liteWriteStore.findNodes({
      scope: tenancy.scope_key,
      consumerAgentId: actor,
      consumerTeamId: null,
      limit: parsed.limit,
      offset: 0,
    });
    scanned.forgetting_nodes = nodes.rows.length;
    for (const row of nodes.rows) {
      const mode = parsed.mode === "apply" && !canMutate() ? "dry_run" : parsed.mode;
      decisions.push(await processMemoryForgetting({
        liteWriteStore,
        row,
        scope: tenancy.scope_key,
        actor,
        mode,
        now,
        forgettingMutationPolicy,
      }));
    }
  }

  if (surfaces.has("pattern")) {
    const patterns = await liteWriteStore.findExecutionNativeNodes({
      scope: tenancy.scope_key,
      executionKind: "pattern_anchor",
      limit: parsed.limit,
      offset: 0,
    });
    scanned.pattern_anchors = patterns.rows.length;
    for (const row of patterns.rows) {
      decisions.push(await processPatternAnchor({
        row,
        mode: parsed.mode,
      }));
    }
  }

  const uniqueDecisions = dedupeDecisions(decisions);
  return LearningLoopRunResponseSchema.parse({
    ok: true,
    run_version: "learning_loop_run_v1",
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    mode: parsed.mode,
    actor,
    scanned,
    decisions: uniqueDecisions,
    applied_count: uniqueDecisions.filter((entry) => entry.applied).length,
    source_code_change_allowed: false,
  });
}

function dedupeDecisions(decisions: LearningLoopDecision[]): LearningLoopDecision[] {
  const out: LearningLoopDecision[] = [];
  const seen = new Set<string>();
  for (const entry of decisions) {
    const key = stableStringify([entry.surface, entry.target_id, entry.action, entry.applied, entry.commit_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
