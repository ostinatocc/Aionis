import { z } from "zod";
import {
  ControlProfileV1Schema,
  ExecutionArtifactRoutingRecordV1Schema,
  ExecutionDelegationPacketRecordV1Schema,
  ExecutionDelegationReturnRecordV1Schema,
  ExecutionPacketV1Schema,
  ServiceLifecycleConstraintV1Schema,
  ExecutionStateV1Schema,
} from "../execution/types.js";
import { ExecutionStateTransitionV1Schema } from "../execution/transitions.js";
import { ExecutionTreeV1Schema, ExecutionTreeOperationV1Schema } from "../execution/tree.js";
import {
  RuntimeVerificationControlV1Schema,
  RuntimeVerificationSurfaceV1Schema,
} from "../execution/verification.js";
import { ContractTrustSchema, OutcomeContractGateSchema } from "./contract-trust.js";
import { ExecutionContractV1Schema } from "./execution-contract.js";
import { AionisGuidePacketSchema, AionisLearningPacketSchema, AionisMemoryPacketSchema } from "./product-output-contract.js";

export const UUID = z.string().uuid();

export const NodeType = z.enum(["event", "entity", "topic", "rule", "evidence", "concept", "procedure", "self_model"]);
export const EdgeType = z.enum(["part_of", "related_to", "derived_from", "supersedes", "contradicts", "invalidates"]);
export const MemoryLayerId = z.enum(["L0", "L1", "L2", "L3", "L4", "L5"]);
export const MemoryLayerPreference = z
  .object({
    allowed_layers: z.array(MemoryLayerId).min(1).max(6),
  })
  .strict();

const QueryBoolean = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
    return v;
  }
  if (typeof v === "string") {
    const raw = v.trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off" || raw === "") return false;
    return v;
  }
  return v;
}, z.boolean());

export const WriteNode = z.object({
  id: UUID.optional(),
  client_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  type: NodeType,
  tier: z.enum(["hot", "warm", "cold", "archive"]).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().min(1).optional(),
  owner_agent_id: z.string().min(1).optional(),
  owner_team_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  text_summary: z.string().min(1).optional(),
  slots: z.record(z.any()).optional(),
  raw_ref: z.string().min(1).optional(),
  evidence_ref: z.string().min(1).optional(),
  embedding: z.array(z.number()).optional(),
  // Optional: label the embedding's generating model/provider for auditability.
  // If omitted and `embedding` is client-supplied, the server may default this to "client".
  embedding_model: z.string().min(1).optional(),
  salience: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const WriteEdgeEndpoint = z.object({
  id: UUID.optional(),
  client_id: z.string().min(1).optional(),
  ref: z
    .object({
      id: UUID.optional(),
      client_id: z.string().min(1).optional(),
    })
    .refine((v) => !!v.id || !!v.client_id, { message: "must set id or client_id" }),
});

export const WriteEdge = z.object({
  id: UUID.optional(),
  scope: z.string().min(1).optional(),
  type: EdgeType,
  src: z.object({ id: UUID.optional(), client_id: z.string().min(1).optional() }).refine((v) => !!v.id || !!v.client_id, {
    message: "src must set id or client_id",
  }),
  dst: z.object({ id: UUID.optional(), client_id: z.string().min(1).optional() }).refine((v) => !!v.id || !!v.client_id, {
    message: "dst must set id or client_id",
  }),
  weight: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  decay_rate: z.number().min(0).max(1).optional(),
  metadata: z.record(z.any()).optional(),
});

export const MemoryWriteRequest = z
  .object({
    tenant_id: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    parent_commit_id: UUID.optional(),
    input_text: z.string().min(1).optional(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    model_version: z.string().min(1).optional(),
    prompt_version: z.string().min(1).optional(),
    // Tri-state: if omitted, server defaults may apply.
    auto_embed: z.boolean().optional(),
    memory_lane: z.enum(["private", "shared"]).optional(),
    producer_agent_id: z.string().min(1).optional(),
    owner_agent_id: z.string().min(1).optional(),
    owner_team_id: z.string().min(1).optional(),
    // If true, re-embed nodes even if they already have READY embeddings (for model upgrades).
    force_reembed: z.boolean().optional(),
    execution_tree_disabled: z.boolean().optional(),
    execution_tree_default_disabled: z.boolean().optional(),
    distill: z
      .object({
        enabled: z.boolean().default(true),
        sources: z.array(z.enum(["input_text", "event_nodes", "evidence_nodes"])).min(1).max(3).default([
          "input_text",
          "event_nodes",
          "evidence_nodes",
        ]),
        max_evidence_nodes: z.number().int().positive().max(20).default(4),
        max_fact_nodes: z.number().int().positive().max(20).default(6),
        min_sentence_chars: z.number().int().min(12).max(500).default(24),
        attach_edges: z.boolean().default(true),
      })
      .optional(),
    nodes: z.array(WriteNode).default([]),
    edges: z.array(WriteEdge).default([]),
  })
  .refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export const MemoryRecallRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  query_text: z.string().min(1).optional(),
  query_embedding: z.array(z.number()),
  recall_strategy: z.enum(["local", "balanced", "global"]).optional(),
  recall_mode: z.enum(["dense_edge"]).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(30),
  neighborhood_hops: z.number().int().min(1).max(2).default(2),
  return_debug: z.boolean().default(false),
  include_embeddings: z.boolean().default(false),
  include_meta: z.boolean().default(false),
  include_slots: z.boolean().default(false),
  include_slots_preview: z.boolean().default(false),
  slots_preview_keys: z.number().int().positive().max(50).default(10),
  max_nodes: z.number().int().positive().max(200).default(50),
  // Hard contract: always cap returned edges to avoid response explosion.
  max_edges: z.number().int().positive().max(100).default(100),
  ranked_limit: z.number().int().positive().max(500).default(100),
  // Optional neighborhood quality filters (applied in stage-2 edge fetch).
  min_edge_weight: z.number().min(0).max(1).default(0),
  min_edge_confidence: z.number().min(0).max(1).default(0),
  // Optional context compaction budgets (for context.text only).
  context_token_budget: z.number().int().positive().max(256000).optional(),
  context_char_budget: z.number().int().positive().max(1000000).optional(),
  // Optional context compaction policy preset.
  context_compaction_profile: z.enum(["balanced", "aggressive"]).optional(),
  // Optional caller-controlled layer tightening. The server always preserves trust anchors.
  memory_layer_preference: MemoryLayerPreference.optional(),
  // Optional: evaluate SHADOW/ACTIVE rules alongside recall to produce an applied policy patch for the planner.
  // Use the normalized "Planner Context" shape (see docs/PLANNER_CONTEXT.md).
  rules_context: z.any().optional(),
  // Optional structured recall signals. These only expand candidate generation; the admission gate still decides use.
  structured_recall_context: z.any().optional(),
  // Default to ACTIVE-only for safety; callers can opt into SHADOW visibility explicitly.
  rules_include_shadow: z.boolean().optional().default(false),
  // Hard cap for how many rules the server may scan.
  rules_limit: z.number().int().positive().max(200).optional().default(50),
});

export const MemoryRecallTextRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  query_text: z.string().min(1),
  recall_strategy: z.enum(["local", "balanced", "global"]).optional(),
  recall_mode: z.enum(["dense_edge"]).optional(),
  recall_class_aware: z.boolean().optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(30),
  neighborhood_hops: z.number().int().min(1).max(2).default(2),
  return_debug: z.boolean().default(false),
  include_embeddings: z.boolean().default(false),
  include_meta: z.boolean().default(false),
  include_slots: z.boolean().default(false),
  include_slots_preview: z.boolean().default(false),
  slots_preview_keys: z.number().int().positive().max(50).default(10),
  max_nodes: z.number().int().positive().max(200).default(50),
  // Hard contract: always cap returned edges to avoid response explosion.
  max_edges: z.number().int().positive().max(100).default(100),
  ranked_limit: z.number().int().positive().max(500).default(100),
  // Optional neighborhood quality filters (applied in stage-2 edge fetch).
  min_edge_weight: z.number().min(0).max(1).default(0),
  min_edge_confidence: z.number().min(0).max(1).default(0),
  // Optional context compaction budgets (for context.text only).
  context_token_budget: z.number().int().positive().max(256000).optional(),
  context_char_budget: z.number().int().positive().max(1000000).optional(),
  // Optional context compaction policy preset.
  context_compaction_profile: z.enum(["balanced", "aggressive"]).optional(),
  memory_layer_preference: MemoryLayerPreference.optional(),
  // Optional: same as MemoryRecallRequest.rules_* but for recall_text.
  rules_context: z.any().optional(),
  structured_recall_context: z.any().optional(),
  rules_include_shadow: z.boolean().optional().default(false),
  rules_limit: z.number().int().positive().max(200).optional().default(50),
});

export type MemoryRecallInput = z.infer<typeof MemoryRecallRequest>;
export type MemoryRecallTextInput = z.infer<typeof MemoryRecallTextRequest>;
export type MemoryWriteInput = z.infer<typeof MemoryWriteRequest>;

export const MemoryAnchorKind = z.enum(["execution", "workflow", "pattern", "decision"]);
export const MemoryAnchorLevel = z.enum(["L1", "L2", "L3"]);
export const MemoryPatternState = z.enum(["provisional", "stable"]);
export const MemoryPatternCredibilityState = z.enum(["candidate", "trusted", "contested"]);
export const PatternOperatorOverrideMode = z.enum(["shadow_learn", "hard_freeze"]);
export const MemoryPatternTransitionKind = z.enum([
  "candidate_observed",
  "promoted_to_trusted",
  "counter_evidence_opened",
  "revalidated_to_trusted",
]);
export const MemoryPatternPromotionGateKind = z.enum(["current_distinct_runs_v1"]);
export const MemoryPatternRevalidationFloorKind = z.enum(["post_contest_two_fresh_runs_v1"]);
export const MemoryAnchorSourceKind = z.enum([
  "replay_step",
  "playbook",
  "distilled_trace",
  "tool_decision",
  "workflow_cluster",
  "execution_write",
]);
export const MemoryAnchorRehydrationMode = z.enum(["summary_only", "partial", "full", "differential"]);
export const MemoryAnchorPayloadCostHint = z.enum(["low", "medium", "high"]);
export const MemoryAnchorOutcomeStatus = z.enum(["success", "failure", "partial", "mixed", "unknown"]);

const MemoryAnchorStringList = z.array(z.string().min(1).max(256)).max(64);
const MemoryAnchorIdList = z.array(z.string().min(1).max(256)).max(256);

export const MemoryAnchorOutcomeSchema = z.object({
  status: MemoryAnchorOutcomeStatus,
  result_class: z.string().min(1).max(128).optional(),
  success_score: z.number().min(0).max(1).optional(),
});

export const MemoryAnchorSourceSchema = z.object({
  source_kind: MemoryAnchorSourceKind,
  node_id: z.string().min(1).max(256).nullable().optional(),
  decision_id: z.string().min(1).max(256).nullable().optional(),
  run_id: z.string().min(1).max(256).nullable().optional(),
  step_id: z.string().min(1).max(256).nullable().optional(),
  playbook_id: z.string().min(1).max(256).nullable().optional(),
  commit_id: z.string().min(1).max(256).nullable().optional(),
});

export const MemoryAnchorPayloadRefsSchema = z.object({
  node_ids: MemoryAnchorIdList.default([]),
  decision_ids: MemoryAnchorIdList.default([]),
  run_ids: MemoryAnchorIdList.default([]),
  step_ids: MemoryAnchorIdList.default([]),
  commit_ids: MemoryAnchorIdList.default([]),
});

export const MemoryAbstractionBoundaryV1Schema = z.object({
  boundary_version: z.literal("abstraction_boundary_v1"),
  abstraction_kind: z.enum(["workflow", "pattern", "policy", "distillation", "execution_native", "unknown"]).default("unknown"),
  applies_when: MemoryAnchorStringList.default([]),
  does_not_apply_when: MemoryAnchorStringList.default([]),
  counterexamples: MemoryAnchorStringList.default([]),
  source_episode_refs: MemoryAnchorIdList.default([]),
  promotion_reason: z.string().min(1).max(512).nullable().default(null),
  promotion_state: z.string().min(1).max(64).nullable().default(null),
  source_evidence_refs: MemoryAnchorIdList.default([]),
  gate_contract: z.literal("raw_episode_first_bounded_abstraction").default("raw_episode_first_bounded_abstraction"),
}).strict();

export const MemoryAnchorRehydrationHintSchema = z.object({
  default_mode: MemoryAnchorRehydrationMode.default("summary_only"),
  payload_cost_hint: MemoryAnchorPayloadCostHint.default("medium"),
  recommended_when: MemoryAnchorStringList.default([]),
});

export const MemoryAnchorRecallFeaturesSchema = z.object({
  error_tags: MemoryAnchorStringList.optional(),
  tool_tags: MemoryAnchorStringList.optional(),
  outcome_tags: MemoryAnchorStringList.optional(),
  keywords: MemoryAnchorStringList.optional(),
});

export const MemoryAnchorMetricsSchema = z.object({
  usage_count: z.number().int().min(0).default(0),
  reuse_success_count: z.number().int().min(0).default(0),
  reuse_failure_count: z.number().int().min(0).default(0),
  distinct_run_count: z.number().int().min(0).default(0),
  last_used_at: z.string().min(1).nullable().default(null),
});

export const MemoryAnchorMaintenanceState = z.enum(["observe", "retain", "review"]);
export const MemoryAnchorMaintenancePriority = z.enum([
  "none",
  "promote_candidate",
  "promote_to_workflow",
  "promote_to_pattern",
  "promote_to_policy",
  "promote_to_default",
  "review_counter_evidence",
  "review_contested_policy",
  "retain_distillation",
  "retain_active_policy",
  "retain_trusted",
  "retain_workflow",
  "retire_policy",
  "reactivate_policy",
]);

export const MemoryAnchorMaintenanceSchema = z.object({
  model: z.literal("lazy_online_v1").default("lazy_online_v1"),
  maintenance_state: MemoryAnchorMaintenanceState,
  offline_priority: MemoryAnchorMaintenancePriority.default("none"),
  lazy_update_fields: MemoryAnchorStringList.default([
    "usage_count",
    "last_used_at",
    "reuse_success_count",
    "reuse_failure_count",
  ]),
  last_maintenance_at: z.string().min(1).nullable().default(null),
});

export const MemoryWorkflowPromotionState = z.enum(["candidate", "stable"]);
export const MemoryWorkflowPromotionOrigin = z.enum([
  "replay_compile_from_run",
  "replay_promote",
  "replay_stable_normalization",
  "replay_learning_episode",
  "replay_learning_auto_promotion",
  "execution_write_projection",
  "execution_write_auto_promotion",
]);
export const MemoryWorkflowTransitionKind = z.enum(["candidate_observed", "promoted_to_stable", "normalized_latest_stable"]);

export const MemoryWorkflowPromotionSchema = z.object({
  promotion_state: MemoryWorkflowPromotionState.default("stable"),
  promotion_origin: MemoryWorkflowPromotionOrigin,
  required_observations: z.number().int().min(2).max(32).default(2),
  observed_count: z.number().int().min(0).default(0),
  last_transition: MemoryWorkflowTransitionKind,
  last_transition_at: z.string().min(1).nullable().default(null),
  source_status: z.string().min(1).max(64).nullable().default(null),
});

export const MemoryPatternPromotionSchema = z.object({
  required_distinct_runs: z.number().int().min(2).max(32).default(2),
  distinct_run_count: z.number().int().min(0).default(0),
  observed_run_ids: z.array(z.string().min(1).max(256)).max(16).default([]),
  counter_evidence_count: z.number().int().min(0).default(0),
  counter_evidence_open: z.boolean().default(false),
  credibility_state: MemoryPatternCredibilityState.default("candidate"),
  previous_credibility_state: MemoryPatternCredibilityState.nullable().default(null),
  last_transition: MemoryPatternTransitionKind.nullable().default(null),
  last_transition_at: z.string().min(1).nullable().default(null),
  stable_at: z.string().min(1).nullable().default(null),
  last_validated_at: z.string().min(1).nullable().default(null),
  last_counter_evidence_at: z.string().min(1).nullable().default(null),
});

export const PromotionEvidenceTargetKindSchema = z.enum([
  "distilled_step",
  "workflow",
  "pattern",
  "policy",
]);

export const PromotionEvidenceTransitionSchema = z.enum([
  "L0_to_L1",
  "L1_to_L2",
  "L2_to_L3",
  "L3_to_L4",
]);

export const PromotionEvidenceVerdictSchema = z.enum([
  "candidate_only",
  "promotion_admitted",
  "promotion_blocked",
  "contested",
]);

export const PromotionEvidenceEntryV1Schema = z.object({
  evidence_id: z.string().min(1).max(128),
  evidence_kind: z.enum([
    "execution_observation",
    "runtime_verifier",
    "authority_gate",
    "learning_control",
    "distinct_observation",
    "counter_evidence",
    "source_anchor",
    "operator_feedback",
  ]),
  polarity: z.enum(["positive", "neutral", "negative"]),
  source_ref: z.string().min(1).max(256),
  claim: z.string().min(1).max(256),
  confidence: z.number().min(0).max(1),
}).strict();

export const PromotionEvidenceScopeSchema = z.enum([
  "exact_task",
  "task_family",
  "repository",
  "ecosystem",
  "global",
]);

export const PromotionEvidenceCandidateProducerSchema = z.enum([
  "runtime_history",
  "agent_trace",
  "llm_candidate",
  "operator_feedback",
  "eval_report",
]);

export const PromotionEvidenceProtocolGateStateSchema = z.enum([
  "passed",
  "pending",
  "failed",
  "not_applicable",
]);

export const PromotionEvidenceProtocolV1Schema = z.object({
  protocol_version: z.literal("promotion_evidence_protocol_v1").default("promotion_evidence_protocol_v1"),
  candidate_producer: PromotionEvidenceCandidateProducerSchema.default("runtime_history"),
  source_scope: PromotionEvidenceScopeSchema.default("exact_task"),
  authority_scope: PromotionEvidenceScopeSchema.default("exact_task"),
  local_reuse_allowed: z.boolean().default(false),
  wider_generalization_allowed: z.boolean().default(false),
  source_code_change_allowed: z.literal(false).default(false),
  distinct_run_count: z.number().int().min(0).default(0),
  distinct_task_count: z.number().int().min(0).default(0),
  holdout_evidence_count: z.number().int().min(0).default(0),
  regression_evidence_count: z.number().int().min(0).default(0),
  negative_transfer_count: z.number().int().min(0).default(0),
  provider_protocol_contamination_count: z.number().int().min(0).default(0),
  task_specific_signal_count: z.number().int().min(0).default(0),
  promoted_item_count: z.number().int().min(0).default(0),
  covered_task_count: z.number().int().min(0).default(0),
  promotion_growth_ratio: z.number().min(0).nullable().default(null),
  leakage_gate: PromotionEvidenceProtocolGateStateSchema.default("pending"),
  holdout_gate: PromotionEvidenceProtocolGateStateSchema.default("pending"),
  interference_gate: PromotionEvidenceProtocolGateStateSchema.default("pending"),
  growth_gate: PromotionEvidenceProtocolGateStateSchema.default("not_applicable"),
  reason_codes: z.array(z.string().min(1).max(128)).max(32).default([]),
}).strict();

export const PromotionEvidenceLedgerV1Schema = z.object({
  ledger_version: z.literal("promotion_evidence_ledger_v1"),
  ledger_id: z.string().min(1).max(128),
  target_kind: PromotionEvidenceTargetKindSchema,
  target_id: z.string().min(1).max(256).nullable(),
  source_layers: z.array(MemoryLayerId).min(1).max(6),
  target_layer: MemoryLayerId,
  transition: PromotionEvidenceTransitionSchema,
  verdict: PromotionEvidenceVerdictSchema,
  promotion_state: z.string().min(1).max(64),
  promotion_origin: z.string().min(1).max(128).nullable(),
  observed_count: z.number().int().min(0),
  required_count: z.number().int().min(0),
  authority_gate_admitted: z.boolean().nullable(),
  learning_control_admitted: z.boolean().nullable(),
  verifier_status: z.enum(["succeeded", "failed", "incomplete", "unknown"]).nullable(),
  contract_trust: ContractTrustSchema.nullable(),
  evidence: z.array(PromotionEvidenceEntryV1Schema).max(32),
  promotion_evidence_refs: z.array(z.string().min(1).max(256)).max(64),
  counter_evidence_refs: z.array(z.string().min(1).max(256)).max(64),
  source_node_ids: z.array(z.string().min(1).max(256)).max(64),
  source_run_ids: z.array(z.string().min(1).max(256)).max(64),
  source_commit_ids: z.array(z.string().min(1).max(256)).max(64),
  reason_codes: z.array(z.string().min(1).max(128)).max(32),
  promotion_protocol: PromotionEvidenceProtocolV1Schema.default({}),
  source_code_change_allowed: z.literal(false),
}).strict();

export type PromotionEvidenceLedgerV1 = z.infer<typeof PromotionEvidenceLedgerV1Schema>;

export const PromotionQualityVerdictCountsV1Schema = z.object({
  candidate_only: z.number().int().min(0),
  promotion_admitted: z.number().int().min(0),
  promotion_blocked: z.number().int().min(0),
  contested: z.number().int().min(0),
}).strict();

export const PromotionQualityGateCountsV1Schema = z.object({
  admitted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  unknown: z.number().int().min(0),
}).strict();

export const PromotionQualityVerifierStatusCountsV1Schema = z.object({
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  incomplete: z.number().int().min(0),
  unknown: z.number().int().min(0),
  missing: z.number().int().min(0),
}).strict();

export const PromotionQualityContractTrustCountsV1Schema = z.object({
  authoritative: z.number().int().min(0),
  advisory: z.number().int().min(0),
  observational: z.number().int().min(0),
  missing: z.number().int().min(0),
}).strict();

export const PromotionQualityProtocolGateCountsV1Schema = z.object({
  passed: z.number().int().min(0).default(0),
  pending: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  not_applicable: z.number().int().min(0).default(0),
}).strict();

export const PromotionQualityProtocolSummaryV1Schema = z.object({
  local_reuse_allowed_count: z.number().int().min(0).default(0),
  wider_generalization_allowed_count: z.number().int().min(0).default(0),
  source_code_change_allowed_count: z.number().int().min(0).default(0),
  provider_protocol_contamination_count: z.number().int().min(0).default(0),
  task_specific_signal_count: z.number().int().min(0).default(0),
  regression_evidence_count: z.number().int().min(0).default(0),
  negative_transfer_count: z.number().int().min(0).default(0),
  holdout_evidence_count: z.number().int().min(0).default(0),
  promoted_item_count: z.number().int().min(0).default(0),
  covered_task_count: z.number().int().min(0).default(0),
  leakage_gate_counts: PromotionQualityProtocolGateCountsV1Schema.default({}),
  holdout_gate_counts: PromotionQualityProtocolGateCountsV1Schema.default({}),
  interference_gate_counts: PromotionQualityProtocolGateCountsV1Schema.default({}),
  growth_gate_counts: PromotionQualityProtocolGateCountsV1Schema.default({}),
}).strict();

export const PromotionQualityTransitionCountV1Schema = z.object({
  transition: PromotionEvidenceTransitionSchema,
  total: z.number().int().min(0),
  candidate_only: z.number().int().min(0),
  promotion_admitted: z.number().int().min(0),
  promotion_blocked: z.number().int().min(0),
  contested: z.number().int().min(0),
  counter_evidence_count: z.number().int().min(0),
}).strict();

export const PromotionQualityTargetKindCountV1Schema = z.object({
  target_kind: PromotionEvidenceTargetKindSchema,
  total: z.number().int().min(0),
  candidate_only: z.number().int().min(0),
  promotion_admitted: z.number().int().min(0),
  promotion_blocked: z.number().int().min(0),
  contested: z.number().int().min(0),
  counter_evidence_count: z.number().int().min(0),
}).strict();

export const PromotionQualitySummaryV1Schema = z.object({
  summary_version: z.literal("promotion_quality_summary_v1"),
  scanned_node_count: z.number().int().min(0),
  included_ledger_count: z.number().int().min(0),
  evidence_entry_count: z.number().int().min(0),
  truncated: z.boolean(),
  verdict_counts: PromotionQualityVerdictCountsV1Schema,
  transition_counts: z.array(PromotionQualityTransitionCountV1Schema).max(4),
  target_kind_counts: z.array(PromotionQualityTargetKindCountV1Schema).max(4),
  authority_gate_counts: PromotionQualityGateCountsV1Schema,
  learning_control_counts: PromotionQualityGateCountsV1Schema,
  verifier_status_counts: PromotionQualityVerifierStatusCountsV1Schema,
  contract_trust_counts: PromotionQualityContractTrustCountsV1Schema,
  promotion_evidence_ref_count: z.number().int().min(0),
  counter_evidence_ref_count: z.number().int().min(0),
  distinct_target_count: z.number().int().min(0),
  distinct_source_run_count: z.number().int().min(0),
  distinct_source_commit_count: z.number().int().min(0),
  promotion_admission_rate: z.number().min(0).max(1),
  contested_rate: z.number().min(0).max(1),
  invalidation_pressure: z.enum(["none", "low", "medium", "high"]),
  recommended_learning_posture: z.enum([
    "insufficient_evidence",
    "candidate_only",
    "promotion_ready",
    "constrain",
    "invalidate",
  ]),
  promotion_protocol_summary: PromotionQualityProtocolSummaryV1Schema.default({}),
  findings: z.array(z.string().min(1).max(256)).max(12),
  source_node_ids: z.array(z.string().min(1).max(128)).max(64),
  source_code_change_allowed: z.literal(false),
}).strict();

export type PromotionQualitySummaryV1 = z.infer<typeof PromotionQualitySummaryV1Schema>;

export const MemoryPatternTrustHardeningSchema = z.object({
  task_family: z.string().min(1).max(128).nullable().default(null),
  error_family: z.string().min(1).max(128).nullable().default(null),
  observed_task_families: MemoryAnchorStringList.default([]),
  observed_error_families: MemoryAnchorStringList.default([]),
  distinct_task_family_count: z.number().int().min(0).default(0),
  distinct_error_family_count: z.number().int().min(0).default(0),
  post_contest_observed_run_ids: z.array(z.string().min(1).max(256)).max(16).default([]),
  post_contest_distinct_run_count: z.number().int().min(0).default(0),
  promotion_gate_kind: MemoryPatternPromotionGateKind.default("current_distinct_runs_v1"),
  promotion_gate_satisfied: z.boolean().default(false),
  revalidation_floor_kind: MemoryPatternRevalidationFloorKind.default("post_contest_two_fresh_runs_v1"),
  revalidation_floor_satisfied: z.boolean().default(true),
  task_affinity_weighting_enabled: z.boolean().default(false),
  semantic_review_override_applied: z.boolean().default(false),
  semantic_review_override_reason: z.string().min(1).max(128).nullable().default(null),
});

export const MemoryDistillationOrigin = z.enum([
  "write_distillation_input_text",
  "write_distillation_event_node",
  "write_distillation_evidence_node",
  "execution_write_projection",
  "handoff_continuity_carrier",
  "session_event_continuity_carrier",
  "session_continuity_carrier",
  "replay_learning_episode",
]);

export const MemoryDistillationTransitionKind = z.enum([
  "distilled_from_input_text",
  "distilled_from_event_node",
  "distilled_from_evidence_node",
  "projected_from_execution_write",
  "projected_from_handoff_carrier",
  "projected_from_session_event_carrier",
  "projected_from_session_carrier",
  "projected_from_replay_learning",
]);

export const MemoryDistillationPromotionTarget = z.enum(["workflow", "pattern", "policy"]);

export const MemoryDistillationSchema = z.object({
  abstraction_state: z.literal("distilled").default("distilled"),
  distillation_origin: MemoryDistillationOrigin,
  source_kind: z.string().min(1).max(64),
  preferred_promotion_target: MemoryDistillationPromotionTarget,
  extraction_pattern: z.string().min(1).max(64).nullable().default(null),
  source_node_id: z.string().min(1).max(256).nullable().default(null),
  source_evidence_node_id: z.string().min(1).max(256).nullable().default(null),
  has_execution_signature: z.boolean().default(false),
  last_transition: MemoryDistillationTransitionKind,
  last_transition_at: z.string().min(1).nullable().default(null),
});

export const MemoryPolicySourceKind = z.enum(["trusted_pattern", "stable_workflow", "blended"]);
export const MemoryPolicyState = z.enum(["candidate", "stable"]);
export const MemoryPolicyMemoryState = z.enum(["active", "contested", "retired"]);
export const MemoryPolicyTransitionKind = z.enum([
  "materialized",
  "refreshed",
  "contested_by_feedback",
  "retired_by_feedback",
  "retired_by_learning_control",
  "reactivated_by_learning_control",
]);

export const MemoryPolicyEvolutionSchema = z.object({
  policy_kind: z.literal("tool_preference").default("tool_preference"),
  policy_source_kind: MemoryPolicySourceKind,
  policy_state: MemoryPolicyState,
  policy_memory_state: MemoryPolicyMemoryState,
  activation_mode: z.enum(["hint", "default"]),
  materialization_state: z.enum(["computed", "persisted"]).default("persisted"),
  source_anchor_count: z.number().int().min(0).default(0),
  last_transition: MemoryPolicyTransitionKind,
  last_transition_at: z.string().min(1).nullable().default(null),
});

export { ContractTrustSchema } from "./contract-trust.js";
export type { ContractTrust } from "./contract-trust.js";

export const MemoryAnchorV1Schema = z.object({
  anchor_kind: MemoryAnchorKind,
  anchor_level: MemoryAnchorLevel,
  contract_trust: ContractTrustSchema.nullable().optional(),
  pattern_state: MemoryPatternState.optional(),
  credibility_state: MemoryPatternCredibilityState.optional(),
  task_signature: z.string().min(1).max(256),
  task_class: z.string().min(1).max(128).optional(),
  task_family: z.string().min(1).max(128).optional(),
  error_signature: z.string().min(1).max(256).optional(),
  error_family: z.string().min(1).max(128).optional(),
  workflow_signature: z.string().min(1).max(256).optional(),
  pattern_signature: z.string().min(1).max(256).optional(),
  summary: z.string().min(1).max(400),
  tool_set: z.array(z.string().min(1).max(128)).max(64),
  selected_tool: z.string().min(1).max(128).nullable().optional(),
  file_path: z.string().min(1).max(2048).nullable().optional(),
  target_files: z.array(z.string().min(1).max(2048)).max(64).optional(),
  next_action: z.string().min(1).max(400).nullable().optional(),
  key_steps: MemoryAnchorStringList.optional(),
  pattern_hints: MemoryAnchorStringList.optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  outcome_contract_gate: OutcomeContractGateSchema.optional(),
  outcome: MemoryAnchorOutcomeSchema,
  source: MemoryAnchorSourceSchema,
  payload_refs: MemoryAnchorPayloadRefsSchema,
  rehydration: MemoryAnchorRehydrationHintSchema.optional(),
  recall_features: MemoryAnchorRecallFeaturesSchema.optional(),
  metrics: MemoryAnchorMetricsSchema.optional(),
  maintenance: MemoryAnchorMaintenanceSchema.optional(),
  workflow_promotion: MemoryWorkflowPromotionSchema.optional(),
  promotion: MemoryPatternPromotionSchema.optional(),
  promotion_evidence_ledger_v1: PromotionEvidenceLedgerV1Schema.optional(),
  trust_hardening: MemoryPatternTrustHardeningSchema.optional(),
  schema_version: z.literal("anchor_v1"),
});

export type MemoryAnchorV1 = z.infer<typeof MemoryAnchorV1Schema>;

export const ExecutionNativeKind = z.enum([
  "distilled_evidence",
  "distilled_fact",
  "workflow_candidate",
  "workflow_anchor",
  "pattern_anchor",
  "execution_native",
]);

export const ExecutionOutcomeRoleSchema = z.enum(["passed_solution", "failed_branch", "blocked", "unknown"]);

export const ExecutionNativeV1Schema = z.object({
  schema_version: z.literal("execution_native_v1"),
  execution_kind: ExecutionNativeKind,
  execution_outcome_role: ExecutionOutcomeRoleSchema.optional(),
  summary_kind: z.string().min(1).max(128).nullable().optional(),
  compression_layer: MemoryLayerId.optional(),
  contract_trust: ContractTrustSchema.optional(),
  task_signature: z.string().min(1).max(256).optional(),
  task_family: z.string().min(1).max(128).optional(),
  error_signature: z.string().min(1).max(256).optional(),
  error_family: z.string().min(1).max(128).optional(),
  workflow_signature: z.string().min(1).max(256).optional(),
  pattern_signature: z.string().min(1).max(256).optional(),
  anchor_kind: MemoryAnchorKind.optional(),
  anchor_level: MemoryAnchorLevel.optional(),
  tool_set: z.array(z.string().min(1).max(128)).max(64).optional(),
  pattern_state: MemoryPatternState.optional(),
  credibility_state: MemoryPatternCredibilityState.optional(),
  selected_tool: z.string().min(1).max(128).nullable().optional(),
  file_path: z.string().min(1).max(2048).nullable().optional(),
  target_files: z.array(z.string().min(1).max(2048)).max(64).optional(),
  next_action: z.string().min(1).max(400).nullable().optional(),
  actor_role: z.string().min(1).max(128).nullable().optional(),
  handoff_target: z.string().min(1).max(128).nullable().optional(),
  handoff_target_role: z.string().min(1).max(128).nullable().optional(),
  next_actor_role: z.string().min(1).max(128).nullable().optional(),
  workflow_steps: MemoryAnchorStringList.optional(),
  pattern_hints: MemoryAnchorStringList.optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  outcome_contract_gate: OutcomeContractGateSchema.optional(),
  workflow_promotion: MemoryWorkflowPromotionSchema.optional(),
  promotion: MemoryPatternPromotionSchema.optional(),
  trust_hardening: MemoryPatternTrustHardeningSchema.optional(),
  maintenance: MemoryAnchorMaintenanceSchema.optional(),
  rehydration: MemoryAnchorRehydrationHintSchema.optional(),
  distillation: MemoryDistillationSchema.optional(),
  policy_evolution: MemoryPolicyEvolutionSchema.optional(),
  promotion_evidence_ledger_v1: PromotionEvidenceLedgerV1Schema.optional(),
  abstraction_boundary_v1: MemoryAbstractionBoundaryV1Schema.optional(),
});

export type ExecutionNativeV1 = z.infer<typeof ExecutionNativeV1Schema>;

export const MemoryLearningControlOperation = z.enum([
  "promote_memory",
  "compress_memory",
  "form_pattern",
  "derive_policy_hint",
  "rehydrate_payload",
]);

export type MemoryLearningControlOperationName = z.infer<typeof MemoryLearningControlOperation>;

export const MemoryAdjudicationDisposition = z.enum(["recommend", "reject", "insufficient_evidence"]);
export const MemoryAdjudicationTargetKind = z.enum(["event", "execution", "workflow", "pattern", "decision", "policy_hint", "none"]);
export const MemoryAdjudicationStrategicValue = z.enum(["low", "medium", "high"]);

export const MemoryAdjudicationProposalBaseSchema = z.object({
  disposition: MemoryAdjudicationDisposition.default("recommend"),
  target_kind: MemoryAdjudicationTargetKind.default("none"),
  target_level: MemoryAnchorLevel.optional(),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  strategic_value: MemoryAdjudicationStrategicValue.optional(),
  keep_details: MemoryAnchorStringList.optional(),
  drop_details: MemoryAnchorStringList.optional(),
  related_memory_ids: MemoryAnchorIdList.optional(),
  related_decision_ids: MemoryAnchorIdList.optional(),
  expected_task_signature: z.string().min(1).max(256).optional(),
  expected_error_signature: z.string().min(1).max(256).optional(),
  notes: z.record(z.unknown()).optional(),
});

function addTargetLevelRequirement<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value: any, ctx) => {
    if (value.disposition === "recommend" && value.target_kind !== "none" && !value.target_level
      && (value.target_kind === "execution" || value.target_kind === "workflow" || value.target_kind === "pattern")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_level is required when recommending execution/workflow/pattern memory",
        path: ["target_level"],
      });
    }
  });
}

export const MemoryPromoteAdjudicationSchema = addTargetLevelRequirement(
  MemoryAdjudicationProposalBaseSchema.extend({
    operation: z.literal("promote_memory"),
    target_kind: z.enum(["execution", "workflow", "pattern", "decision", "none"]).default("none"),
  }),
);

export const MemoryCompressAdjudicationSchema = addTargetLevelRequirement(
  MemoryAdjudicationProposalBaseSchema.extend({
    operation: z.literal("compress_memory"),
    target_kind: z.enum(["event", "execution", "workflow", "pattern", "decision", "none"]).default("none"),
  }),
);

export const MemoryFormPatternAdjudicationSchema = addTargetLevelRequirement(
  MemoryAdjudicationProposalBaseSchema.extend({
    operation: z.literal("form_pattern"),
    target_kind: z.enum(["pattern", "none"]).default("none"),
  }),
);

export const MemoryPolicyHintAdjudicationSchema = MemoryAdjudicationProposalBaseSchema.extend({
  operation: z.literal("derive_policy_hint"),
  target_kind: z.enum(["policy_hint", "none"]).default("none"),
});

export const MemoryPayloadRehydrateAdjudicationSchema = MemoryAdjudicationProposalBaseSchema.extend({
  operation: z.literal("rehydrate_payload"),
  target_kind: z.enum(["none", "decision", "workflow", "execution"]).default("none"),
});

export const MemoryAdjudicationProposalSchema = z.union([
  MemoryPromoteAdjudicationSchema,
  MemoryCompressAdjudicationSchema,
  MemoryFormPatternAdjudicationSchema,
  MemoryPolicyHintAdjudicationSchema,
  MemoryPayloadRehydrateAdjudicationSchema,
]);

export type MemoryAdjudicationProposal = z.infer<typeof MemoryAdjudicationProposalSchema>;

export const MemoryAdmissibilityReasonCode = z.enum([
  "budget_limit",
  "policy_restricted",
  "confidence_too_low",
  "threshold_not_met",
  "schema_invalid",
  "write_scope_unsafe",
  "irreversible_action_denied",
]);

export const MemoryAdmissibilityResultSchema = z.object({
  operation: MemoryLearningControlOperation,
  admissible: z.boolean(),
  requires_manual_review: z.boolean().default(false),
  accepted_mutation_count: z.number().int().min(0).default(0),
  reason_codes: z.array(MemoryAdmissibilityReasonCode).max(16).default([]),
  notes: z.record(z.unknown()).optional(),
});

export type MemoryAdmissibilityResult = z.infer<typeof MemoryAdmissibilityResultSchema>;

const MemoryLearningControlMutationBase = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  input_text: z.string().min(1).optional(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const MemoryPromoteRequest = MemoryLearningControlMutationBase.extend({
  candidate_node_ids: MemoryAnchorIdList.min(1).max(200),
  target_kind: z.enum(["execution", "workflow", "pattern", "decision"]),
  target_level: MemoryAnchorLevel,
  write_anchor: z.boolean().default(true),
  adjudication: MemoryPromoteAdjudicationSchema.optional(),
}).refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export type MemoryPromoteInput = z.infer<typeof MemoryPromoteRequest>;

export const MemoryPromoteSemanticReviewCandidateSchema = z.object({
  node_id: z.string().min(1).max(256),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(1000).optional(),
  task_signature: z.string().min(1).max(256).nullable().optional(),
  error_signature: z.string().min(1).max(256).nullable().optional(),
  workflow_signature: z.string().min(1).max(256).nullable().optional(),
  selected_tool: z.string().min(1).max(128).nullable().optional(),
  outcome_status: z.string().min(1).max(64).nullable().optional(),
  success_score: z.number().min(0).max(1).nullable().optional(),
});

export const MEMORY_PROMOTE_SEMANTIC_REVIEW_VERSION = "promote_memory_semantic_review_v1" as const;
export const MEMORY_FORM_PATTERN_SEMANTIC_REVIEW_VERSION = "form_pattern_semantic_review_v1" as const;

export const MemoryPromoteSemanticReviewPacketSchema = z.object({
  review_version: z.literal(MEMORY_PROMOTE_SEMANTIC_REVIEW_VERSION),
  operation: z.literal("promote_memory"),
  requested_target_kind: z.enum(["execution", "workflow", "pattern", "decision"]),
  requested_target_level: MemoryAnchorLevel,
  candidate_count: z.number().int().min(0).max(200),
  deterministic_gate: z.object({
    candidate_count_satisfied: z.boolean(),
    target_kind_present: z.boolean(),
    target_level_present: z.boolean(),
    gate_satisfied: z.boolean(),
  }),
  candidate_examples: z.array(MemoryPromoteSemanticReviewCandidateSchema).max(6),
});

export type MemoryPromoteSemanticReviewPacket = z.infer<typeof MemoryPromoteSemanticReviewPacketSchema>;

export const MemoryPromoteSemanticReviewResultSchema = z.object({
  review_version: z.literal(MEMORY_PROMOTE_SEMANTIC_REVIEW_VERSION),
  adjudication: MemoryPromoteAdjudicationSchema,
});

export type MemoryPromoteSemanticReviewResult = z.infer<typeof MemoryPromoteSemanticReviewResultSchema>;

export const MemoryCompressRequest = MemoryLearningControlMutationBase.extend({
  node_ids: MemoryAnchorIdList.min(1).max(200),
  compression_mode: z.enum(["summarize", "drop_redundant_details", "anchor_only"]).default("summarize"),
  preserve_anchor: z.boolean().default(true),
  adjudication: MemoryCompressAdjudicationSchema.optional(),
}).refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export type MemoryCompressInput = z.infer<typeof MemoryCompressRequest>;

export const MemoryFormPatternRequest = MemoryLearningControlMutationBase.extend({
  source_node_ids: MemoryAnchorIdList.min(2).max(100),
  task_signature: z.string().min(1).max(256).optional(),
  error_signature: z.string().min(1).max(256).optional(),
  pattern_signature: z.string().min(1).max(256).optional(),
  target_level: z.literal("L3").default("L3"),
  adjudication: MemoryFormPatternAdjudicationSchema.optional(),
}).refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export type MemoryFormPatternInput = z.infer<typeof MemoryFormPatternRequest>;

export const MemoryFormPatternSemanticReviewExampleSchema = z.object({
  node_id: z.string().min(1).max(256),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(1000).optional(),
  task_signature: z.string().min(1).max(256).nullable().optional(),
  error_signature: z.string().min(1).max(256).nullable().optional(),
  pattern_signature: z.string().min(1).max(256).nullable().optional(),
  selected_tool: z.string().min(1).max(128).nullable().optional(),
  outcome_status: z.string().min(1).max(64).nullable().optional(),
  success_score: z.number().min(0).max(1).nullable().optional(),
});

export const MemoryFormPatternSemanticReviewPacketSchema = z.object({
  review_version: z.literal(MEMORY_FORM_PATTERN_SEMANTIC_REVIEW_VERSION),
  operation: z.literal("form_pattern"),
  target_level: z.literal("L3"),
  source_count: z.number().int().min(2).max(100),
  deterministic_gate: z.object({
    source_count_satisfied: z.boolean(),
    signature_present: z.boolean(),
    gate_satisfied: z.boolean(),
  }),
  signatures: z.object({
    task_signature: z.string().min(1).max(256).nullable().optional(),
    error_signature: z.string().min(1).max(256).nullable().optional(),
    pattern_signature: z.string().min(1).max(256).nullable().optional(),
  }),
  source_examples: z.array(MemoryFormPatternSemanticReviewExampleSchema).max(6),
});

export type MemoryFormPatternSemanticReviewPacket = z.infer<typeof MemoryFormPatternSemanticReviewPacketSchema>;

export const MemoryFormPatternSemanticReviewResultSchema = z.object({
  review_version: z.literal(MEMORY_FORM_PATTERN_SEMANTIC_REVIEW_VERSION),
  adjudication: MemoryFormPatternAdjudicationSchema,
});

export type MemoryFormPatternSemanticReviewResult = z.infer<typeof MemoryFormPatternSemanticReviewResultSchema>;

export const MemoryPayloadRehydrateToolRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  anchor_id: z.string().min(1).max(256).optional(),
  anchor_uri: z.string().min(1).max(512).optional(),
  mode: MemoryAnchorRehydrationMode.default("partial"),
  include_linked_decisions: z.boolean().default(true),
  reason: z.string().min(1).max(1000).optional(),
  adjudication: MemoryPayloadRehydrateAdjudicationSchema.optional(),
}).refine((v) => !!v.anchor_id || !!v.anchor_uri, {
  message: "must set anchor_id or anchor_uri",
});

export type MemoryPayloadRehydrateToolInput = z.infer<typeof MemoryPayloadRehydrateToolRequest>;

export const ContextLayerName = z.enum(["facts", "episodes", "rules", "static", "decisions", "tools", "citations"]);
export const MemoryTier = z.enum(["hot", "warm", "cold", "archive"]);

export const ContextForgettingPolicy = z.object({
  enabled: z.boolean().default(true),
  allowed_tiers: z.array(MemoryTier).min(1).max(4).default(["hot", "warm"]),
  exclude_archived: z.boolean().default(true),
  min_salience: z.number().min(0).max(1).optional(),
});

export const ContextLayerConfig = z.object({
  enabled: z.array(ContextLayerName).min(1).max(7).optional(),
  char_budget_total: z.number().int().positive().max(200000).optional(),
  char_budget_by_layer: z.record(z.string(), z.number().int().positive().max(200000)).optional(),
  max_items_by_layer: z.record(z.string(), z.number().int().positive().max(500)).optional(),
  include_merge_trace: z.boolean().default(true),
  forgetting_policy: ContextForgettingPolicy.optional(),
});

export const StaticContextBlock = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20000),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  intents: z.array(z.string().min(1).max(64)).max(32).optional(),
  tools: z.array(z.string().min(1).max(128)).max(64).optional(),
  priority: z.number().int().min(0).max(100).default(50),
  always_include: z.boolean().default(false),
});
export type StaticContextBlock = z.infer<typeof StaticContextBlock>;

export const StaticInjectionPolicy = z.object({
  enabled: z.boolean().default(true),
  max_blocks: z.number().int().positive().max(32).default(4),
  min_score: z.number().int().min(0).max(500).default(50),
  include_selection_trace: z.boolean().default(true),
});

export const TrajectoryCompileStepSchema = z.object({
  step_id: z.string().min(1).max(256).optional(),
  role: z.string().min(1).max(64).optional(),
  kind: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(400).optional(),
  text: z.string().min(1).max(20000).optional(),
  content: z.string().min(1).max(20000).optional(),
  summary: z.string().min(1).max(4000).optional(),
  tool_name: z.string().min(1).max(128).optional(),
  command: z.string().min(1).max(20000).optional(),
  tool_input: z.unknown().optional(),
  observation: z.unknown().optional(),
  result: z.unknown().optional(),
  exit_code: z.number().int().optional(),
  file_paths: z.array(z.string().min(1).max(2048)).max(64).optional(),
  urls: z.array(z.string().min(1).max(2048)).max(32).optional(),
}).passthrough();

export const TrajectoryCompileSourceSchema = z.object({
  run_id: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(400).optional(),
  task_family: z.string().min(1).max(128).optional(),
  steps: z.array(TrajectoryCompileStepSchema).min(1).max(500),
});

export const TrajectoryCompileHintsSchema = z.object({
  repo_root: z.string().min(1).max(2048).optional(),
  target_files: z.array(z.string().min(1).max(2048)).max(64).optional(),
  acceptance_checks: z.array(z.string().min(1).max(400)).max(64).optional(),
  success_invariants: z.array(z.string().min(1).max(400)).max(64).optional(),
  dependency_requirements: z.array(z.string().min(1).max(400)).max(64).optional(),
  environment_assumptions: z.array(z.string().min(1).max(400)).max(64).optional(),
  must_hold_after_exit: z.array(z.string().min(1).max(400)).max(64).optional(),
  external_visibility_requirements: z.array(z.string().min(1).max(400)).max(64).optional(),
});

export type TrajectoryCompileSourceInput = z.infer<typeof TrajectoryCompileSourceSchema>;
export type TrajectoryCompileHintsInput = z.infer<typeof TrajectoryCompileHintsSchema>;

export const RuntimeEditBoundaryContextSchema = z.object({
  allowed_edit_files: z.array(z.string().min(1).max(2048)).max(64).default([]),
  forbidden_edit_files: z.array(z.string().min(1).max(2048)).max(64).default([]),
  required_verifiers: z.array(z.string().min(1).max(800)).max(64).default([]),
  anti_shortcut_rules: z.array(z.string().min(1).max(800)).max(64).default([]),
}).strict();

export type RuntimeEditBoundaryContextInput = z.infer<typeof RuntimeEditBoundaryContextSchema>;

export const PlanningContextRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  query_text: z.string().min(1),
  recall_strategy: z.enum(["local", "balanced", "global"]).optional(),
  recall_mode: z.enum(["dense_edge"]).optional(),
  recall_class_aware: z.boolean().optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  // Planner/runtime execution context used by rules + tool selection.
  context: z.any(),
  include_shadow: z.boolean().default(false),
  rules_limit: z.number().int().positive().max(200).default(50),
  run_id: z.string().min(1).optional(),
  tool_candidates: z.array(z.string().min(1)).max(200).optional(),
  tool_strict: z.boolean().default(true),
  limit: z.number().int().positive().max(200).default(30),
  neighborhood_hops: z.number().int().min(1).max(2).default(2),
  return_debug: z.boolean().default(false),
  include_embeddings: z.boolean().default(false),
  include_meta: z.boolean().default(false),
  include_slots: z.boolean().default(false),
  include_slots_preview: z.boolean().default(false),
  slots_preview_keys: z.number().int().positive().max(50).default(10),
  max_nodes: z.number().int().positive().max(200).default(50),
  max_edges: z.number().int().positive().max(100).default(100),
  ranked_limit: z.number().int().positive().max(500).default(100),
  min_edge_weight: z.number().min(0).max(1).default(0),
  min_edge_confidence: z.number().min(0).max(1).default(0),
  context_token_budget: z.number().int().positive().max(256000).optional(),
  context_char_budget: z.number().int().positive().max(1000000).optional(),
  context_compaction_profile: z.enum(["balanced", "aggressive"]).optional(),
  context_optimization_profile: z.enum(["balanced", "aggressive"]).optional(),
  memory_layer_preference: MemoryLayerPreference.optional(),
  // Experimental: return explicit multi-layer context assembly (facts/episodes/rules/decisions/tools/citations).
  return_layered_context: z.boolean().default(false),
  context_layers: ContextLayerConfig.optional(),
  static_context_blocks: z.array(StaticContextBlock).max(100).optional(),
  static_injection: StaticInjectionPolicy.optional(),
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  execution_packet_v1: ExecutionPacketV1Schema.optional(),
  execution_tree_v1: ExecutionTreeV1Schema.optional(),
  edit_boundary_context: RuntimeEditBoundaryContextSchema.optional(),
  runtime_verification: RuntimeVerificationControlV1Schema.optional(),
  trajectory: TrajectoryCompileSourceSchema.optional(),
  trajectory_hints: TrajectoryCompileHintsSchema.optional(),
});

export type ContextLayerConfigInput = z.infer<typeof ContextLayerConfig>;
export type PlanningContextInput = z.infer<typeof PlanningContextRequest>;

export const ContextAssembleRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  query_text: z.string().min(1),
  recall_strategy: z.enum(["local", "balanced", "global"]).optional(),
  recall_mode: z.enum(["dense_edge"]).optional(),
  recall_class_aware: z.boolean().optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  context: z.any().optional(),
  include_rules: z.boolean().default(true),
  include_shadow: z.boolean().default(false),
  rules_limit: z.number().int().positive().max(200).default(50),
  tool_candidates: z.array(z.string().min(1)).max(200).optional(),
  tool_strict: z.boolean().default(true),
  limit: z.number().int().positive().max(200).default(30),
  neighborhood_hops: z.number().int().min(1).max(2).default(2),
  return_debug: z.boolean().default(false),
  include_embeddings: z.boolean().default(false),
  include_meta: z.boolean().default(false),
  include_slots: z.boolean().default(false),
  include_slots_preview: z.boolean().default(false),
  slots_preview_keys: z.number().int().positive().max(50).default(10),
  max_nodes: z.number().int().positive().max(200).default(50),
  max_edges: z.number().int().positive().max(100).default(100),
  ranked_limit: z.number().int().positive().max(500).default(100),
  min_edge_weight: z.number().min(0).max(1).default(0),
  min_edge_confidence: z.number().min(0).max(1).default(0),
  context_token_budget: z.number().int().positive().max(256000).optional(),
  context_char_budget: z.number().int().positive().max(1000000).optional(),
  context_compaction_profile: z.enum(["balanced", "aggressive"]).optional(),
  context_optimization_profile: z.enum(["balanced", "aggressive"]).optional(),
  memory_layer_preference: MemoryLayerPreference.optional(),
  return_layered_context: z.boolean().default(false),
  context_layers: ContextLayerConfig.optional(),
  static_context_blocks: z.array(StaticContextBlock).max(100).optional(),
  static_injection: StaticInjectionPolicy.optional(),
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  execution_packet_v1: ExecutionPacketV1Schema.optional(),
  execution_tree_v1: ExecutionTreeV1Schema.optional(),
  edit_boundary_context: RuntimeEditBoundaryContextSchema.optional(),
  runtime_verification: RuntimeVerificationControlV1Schema.optional(),
  trajectory: TrajectoryCompileSourceSchema.optional(),
  trajectory_hints: TrajectoryCompileHintsSchema.optional(),
});

export type ContextAssembleInput = z.infer<typeof ContextAssembleRequest>;

const PlannerPacketEntrySchema = z.object({}).passthrough();

export const ExecutionMemoryIntrospectionRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(50).default(8),
});

export type ExecutionMemoryIntrospectionInput = z.infer<typeof ExecutionMemoryIntrospectionRequest>;

export const ExperienceIntelligenceRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  query_text: z.string().min(1),
  context: z.any(),
  candidates: z.array(z.string().min(1)).min(1).max(200),
  include_shadow: z.boolean().default(false),
  rules_limit: z.number().int().positive().max(200).default(50),
  strict: z.boolean().default(true),
  reorder_candidates: z.boolean().default(true),
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  edit_boundary_context: RuntimeEditBoundaryContextSchema.optional(),
  trajectory: TrajectoryCompileSourceSchema.optional(),
  trajectory_hints: TrajectoryCompileHintsSchema.optional(),
  policy_learning_control_apply_mode: z.enum(["manual", "auto_apply"]).optional(),
  workflow_limit: z.number().int().positive().max(32).default(8),
});

export type ExperienceIntelligenceInput = z.infer<typeof ExperienceIntelligenceRequest>;

export const TrajectoryCompileRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  query_text: z.string().min(1).max(20000),
  trajectory: TrajectoryCompileSourceSchema,
  hints: TrajectoryCompileHintsSchema.optional(),
});

export type TrajectoryCompileInput = z.infer<typeof TrajectoryCompileRequest>;

export const TrajectoryCompileContractSchema = z.object({
  target_files: z.array(z.string()),
  acceptance_checks: z.array(z.string()),
  success_invariants: z.array(z.string()),
  dependency_requirements: z.array(z.string()),
  environment_assumptions: z.array(z.string()),
  must_hold_after_exit: z.array(z.string()),
  external_visibility_requirements: z.array(z.string()),
  next_action: z.string().nullable(),
  workflow_steps: z.array(z.string()),
  pattern_hints: z.array(z.string()),
  likely_tool: z.string().nullable(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema),
  noise_markers: z.array(z.string()),
}).passthrough();

export const TrajectoryCompilePromotionSeedSchema = z.object({
  task_family: z.string().nullable(),
  task_signature: z.string().nullable(),
  workflow_signature: z.string().nullable(),
  key_steps: z.array(z.string()),
  recall_keywords: z.array(z.string()),
}).passthrough();

export const TrajectoryCompileResponseSchema = z.object({
  summary_version: z.literal("trajectory_compile_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  compiler_version: z.literal("trajectory_compile_v1"),
  task_family: z.string().nullable(),
  task_signature: z.string().nullable(),
  workflow_signature: z.string().nullable(),
  contract: TrajectoryCompileContractSchema,
  promotion_seed: TrajectoryCompilePromotionSeedSchema,
  diagnostics: z.object({
    step_count: z.number().int().min(0),
    command_count: z.number().int().min(0),
    target_file_count: z.number().int().min(0),
    acceptance_check_count: z.number().int().min(0),
    workflow_step_count: z.number().int().min(0),
    service_constraint_count: z.number().int().min(0),
    noise_marker_count: z.number().int().min(0),
  }).passthrough(),
}).passthrough();

export type TrajectoryCompileResponse = z.infer<typeof TrajectoryCompileResponseSchema>;

export const ActionRetrievalRequest = ExperienceIntelligenceRequest;

export type ActionRetrievalInput = z.infer<typeof ActionRetrievalRequest>;

export const ContinuityGuidanceRequest = ExperienceIntelligenceRequest;

export type ContinuityGuidanceInput = z.infer<typeof ContinuityGuidanceRequest>;

export const ContinuityFocusItemSchema = z.object({
  source_kind: z.string(),
  continuity_kind: z.string(),
  continuity_phase: z.string(),
  occurred_at: z.string().nullable(),
  title: z.string().nullable(),
  text_summary: z.string().nullable(),
  anchor: z.string().nullable().optional(),
  handoff_kind: z.string().nullable().optional(),
  file_path: z.string().nullable().optional(),
  repo_root: z.string().nullable().optional(),
  symbol: z.string().nullable().optional(),
  next_action: z.string().nullable().optional(),
}).passthrough();

export const ContinuityInspectSummarySchema = z.object({
  inspect_version: z.literal("continuity_inspect_v1"),
  latest_handoff: ContinuityFocusItemSchema.nullable(),
  latest_resume: ContinuityFocusItemSchema.nullable(),
  latest_terminal_run: ContinuityFocusItemSchema.nullable(),
}).passthrough();

export const ContinuityReviewContractSchema = z.object({
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  target_files: z.array(z.string()),
  next_action: z.string().nullable(),
  acceptance_checks: z.array(z.string()),
  must_change: z.array(z.string()),
  must_remove: z.array(z.string()),
  must_keep: z.array(z.string()),
  rollback_required: z.boolean(),
}).passthrough();

export const ContinuityReviewPackSummarySchema = z.object({
  pack_version: z.literal("continuity_review_pack_v1"),
  latest_handoff: ContinuityFocusItemSchema.nullable(),
  latest_resume: ContinuityFocusItemSchema.nullable(),
  latest_terminal_run: ContinuityFocusItemSchema.nullable(),
  recovered_handoff: z.record(z.unknown()).nullable(),
  review_contract: ContinuityReviewContractSchema.nullable(),
}).passthrough();

export const ContinuityReviewPackResponseSchema = z.object({
  tenant_id: z.string(),
  scope: z.string(),
  sources: z.array(z.record(z.unknown())),
  items: z.array(z.record(z.unknown())),
  page: z.object({
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
  counters: z.object({
    total_items: z.number().int().nonnegative().optional(),
    returned_items: z.number().int().nonnegative().optional(),
    source_count: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  continuity_inspect: ContinuityInspectSummarySchema,
  continuity_review_pack: ContinuityReviewPackSummarySchema,
}).passthrough();

export type ContinuityReviewPackResponse = z.infer<typeof ContinuityReviewPackResponseSchema>;

export const RuntimeAuthorityVisibilityContractSchema = z.object({
  surface_version: z.literal("runtime_authority_visibility_v1"),
  node_id: z.string().nullable(),
  node_kind: z.string().nullable(),
  title: z.string().nullable(),
  requested_trust: z.string().nullable(),
  effective_trust: z.string().nullable(),
  status: z.enum(["sufficient", "insufficient", "unknown"]),
  allows_authoritative: z.boolean(),
  allows_stable_promotion: z.boolean(),
  authority_blocked: z.boolean(),
  stable_promotion_blocked: z.boolean(),
  primary_blocker: z.string().nullable(),
  authority_reasons: z.array(z.string()),
  outcome_contract_reasons: z.array(z.string()),
  execution_evidence_reasons: z.array(z.string()),
  execution_evidence_status: z.string().nullable(),
  false_confidence_detected: z.boolean(),
}).strict();

export const RuntimeAuthorityDecisionSurfaceSchema = z.enum([
  "outcome_contract_gate",
  "execution_evidence_gate",
  "stable_promotion_gate",
  "false_confidence_gate",
  "candidate_workflow_reuse",
  "trusted_pattern_policy_materialization",
  "policy_default_materialization",
]);

export const RuntimeAuthorityDecisionDispositionSchema = z.enum([
  "allowed",
  "blocked",
  "advisory_only",
  "inspect_or_rehydrate_only",
  "unblocked_false_confidence",
]);

export const RuntimeAuthorityDecisionEffectSchema = z.enum([
  "authoritative_allowed",
  "stable_promotion_allowed",
  "advisory_only",
  "inspection_required",
  "blocked",
  "none",
]);

export const RuntimeAuthorityDecisionV1Schema = z.object({
  decision_version: z.literal("runtime_authority_decision_v1"),
  decision_id: z.string().min(1),
  surface: RuntimeAuthorityDecisionSurfaceSchema,
  subject: z.string().min(1),
  disposition: RuntimeAuthorityDecisionDispositionSchema,
  authority_effect: RuntimeAuthorityDecisionEffectSchema,
  reasons: z.array(z.string().min(1)).max(32),
  rule_refs: z.array(z.string().min(1)).max(64),
  source_ids: z.array(z.string().min(1)).max(32),
  recommended_action: z.string().min(1),
}).strict();

export const RuntimeAuthorityDecisionSummaryV1Schema = z.object({
  summary_version: z.literal("runtime_authority_decision_summary_v1"),
  total_decisions: z.number().int().min(0),
  allowed_count: z.number().int().min(0),
  blocked_count: z.number().int().min(0),
  advisory_only_count: z.number().int().min(0),
  inspect_or_rehydrate_count: z.number().int().min(0),
  unblocked_false_confidence_count: z.number().int().min(0),
  decisions_by_surface: z.record(z.object({
    total: z.number().int().min(0),
    allowed: z.number().int().min(0),
    blocked: z.number().int().min(0),
    advisory_only: z.number().int().min(0),
    inspect_or_rehydrate_only: z.number().int().min(0),
    unblocked_false_confidence: z.number().int().min(0),
  }).strict()),
  blocked_by_reason: z.record(z.number().int().min(0)),
}).strict();

export const RuntimeAuthorityReadSideRuleReportV1Schema = z.object({
  source_id: z.string().min(1),
  file: z.string().min(1),
  layer: z.string().min(1),
  role: z.string().min(1),
  authority_rules: z.array(z.string().min(1)),
}).strict();

export const RuntimeAuthorityDecisionReportV1Schema = z.object({
  report_version: z.literal("runtime_authority_decision_report_v1"),
  summary: RuntimeAuthorityDecisionSummaryV1Schema,
  read_side_rules: z.array(RuntimeAuthorityReadSideRuleReportV1Schema),
  decisions: z.array(RuntimeAuthorityDecisionV1Schema),
}).strict();

export type RuntimeAuthorityDecisionReportV1 = z.infer<typeof RuntimeAuthorityDecisionReportV1Schema>;

export const ExperienceIntelligencePathRecommendationSchema = z.object({
  source_kind: z.enum(["recommended_workflow", "candidate_workflow", "none"]),
  anchor_id: z.string().nullable(),
  contract_trust: ContractTrustSchema.nullable().optional(),
  task_family: z.string().nullable().optional(),
  workflow_signature: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  next_action: z.string().nullable(),
  workflow_steps: z.array(z.string()).optional(),
  pattern_hints: z.array(z.string()).optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  confidence: z.number().nullable(),
  tool_set: z.array(z.string()),
  authority_visibility: RuntimeAuthorityVisibilityContractSchema.nullable().optional(),
  authority_blocked: z.boolean().optional(),
  authority_primary_blocker: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
}).strict();

export const ExperienceIntelligenceToolRecommendationSchema = z.object({
  selected_tool: z.string().nullable(),
  ordered_tools: z.array(z.string()),
  preferred_tools: z.array(z.string()),
  allowed_tools: z.array(z.string()),
  trusted_pattern_anchor_ids: z.array(z.string()),
  candidate_pattern_anchor_ids: z.array(z.string()),
  suppressed_pattern_anchor_ids: z.array(z.string()),
}).strict();

export const AdaptiveGuidanceSubtaskV1Schema = z.object({
  subtask_id: z.string().min(1).max(128),
  role: z.enum(["task_intent", "tool_selection", "file_focus", "verification", "continuity"]),
  query_text: z.string().min(1).max(2048),
  match_terms: z.array(z.string().min(1).max(128)).max(32),
}).strict();

export type AdaptiveGuidanceSubtaskV1 = z.infer<typeof AdaptiveGuidanceSubtaskV1Schema>;

export const AdaptiveGuidanceDecompositionV1Schema = z.object({
  summary_version: z.literal("adaptive_guidance_decomposition_v1"),
  query_text: z.string().min(1).max(20000),
  task_family: z.string().nullable(),
  query_terms: z.array(z.string().min(1).max(128)).max(96),
  file_hints: z.array(z.string().min(1).max(512)).max(32),
  tool_hints: z.array(z.string().min(1).max(128)).max(32),
  subtasks: z.array(AdaptiveGuidanceSubtaskV1Schema).min(1).max(8),
}).strict();

export type AdaptiveGuidanceDecompositionV1 = z.infer<typeof AdaptiveGuidanceDecompositionV1Schema>;

export const AdaptiveGuidanceSourceKindSchema = z.enum([
  "stable_workflow",
  "candidate_workflow",
  "trusted_pattern",
  "contested_pattern",
  "continuity_carrier",
  "supporting_knowledge",
]);

export type AdaptiveGuidanceSourceKind = z.infer<typeof AdaptiveGuidanceSourceKindSchema>;

export const AdaptiveGuidanceCandidateV1Schema = z.object({
  summary_version: z.literal("adaptive_guidance_candidate_v1"),
  candidate_id: z.string().min(1).max(128),
  source_kind: AdaptiveGuidanceSourceKindSchema,
  source_anchor_id: z.string().nullable(),
  authority: z.literal("advisory_candidate"),
  contract_trust: z.literal("observational"),
  selected_tool: z.string().nullable(),
  task_family: z.string().nullable(),
  workflow_signature: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()).max(32),
  next_action: z.string().nullable(),
  workflow_steps: z.array(z.string()).max(32),
  pattern_hints: z.array(z.string()).max(32),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16),
  evidence_refs: z.array(z.string().min(1).max(256)).max(32),
  source_refs: z.array(z.string().min(1).max(256)).max(32),
  confidence: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
  match_reasons: z.array(z.string().min(1).max(512)).max(16),
  promotion_blockers: z.array(z.string().min(1).max(256)).max(16),
  source_code_change_allowed: z.literal(false),
}).strict();

export type AdaptiveGuidanceCandidateV1 = z.infer<typeof AdaptiveGuidanceCandidateV1Schema>;

export const AdaptiveGuidanceInstructionV1Schema = z.object({
  instruction_id: z.string().min(1).max(128),
  priority: z.enum(["primary", "supporting", "verification"]),
  instruction: z.string().min(1).max(2048),
  selected_tool: z.string().nullable(),
  file_path: z.string().nullable(),
  task_family: z.string().nullable(),
  source_candidate_ids: z.array(z.string().min(1).max(128)).max(16),
  source_anchor_ids: z.array(z.string().min(1).max(256)).max(16),
  evidence_refs: z.array(z.string().min(1).max(256)).max(32),
  contract_trust: z.literal("observational"),
}).strict();

export type AdaptiveGuidanceInstructionV1 = z.infer<typeof AdaptiveGuidanceInstructionV1Schema>;

export const AdaptiveGuidanceAuthorityV1Schema = z.object({
  summary_version: z.literal("adaptive_guidance_authority_v1"),
  contract_trust: z.literal("observational"),
  may_override_policy: z.literal(false),
  may_promote_directly: z.literal(false),
  required_promotion_path: z.literal("runtime_signal_attribution_and_learning_control_gate"),
  blocked_authority_levels: z.array(z.enum(["authoritative", "advisory"])).max(2),
}).strict();

export type AdaptiveGuidanceAuthorityV1 = z.infer<typeof AdaptiveGuidanceAuthorityV1Schema>;

export const AdaptiveGuidanceAttributionPlanV1Schema = z.object({
  summary_version: z.literal("adaptive_guidance_attribution_plan_v1"),
  candidate_ids: z.array(z.string().min(1).max(128)).max(16),
  expected_signal_kind: z.literal("adaptive_guidance_outcome"),
  feedback_slots: z.array(z.string().min(1).max(128)).max(16),
  positive_authority_effect: z.literal("promotion_evidence_candidate"),
  negative_authority_effect: z.literal("counter_evidence"),
}).strict();

export type AdaptiveGuidanceAttributionPlanV1 = z.infer<typeof AdaptiveGuidanceAttributionPlanV1Schema>;

export const AdaptiveGuidanceUncertaintyAdjustmentV1Schema = z.object({
  summary_version: z.literal("adaptive_guidance_uncertainty_adjustment_v1"),
  confidence_delta: z.number().min(-1).max(1),
  recommended_actions: z.array(z.enum([
    "widen_recall",
    "inspect_context",
    "request_operator_review",
  ])).max(8),
  reason: z.string().nullable(),
}).strict();

export type AdaptiveGuidanceUncertaintyAdjustmentV1 = z.infer<typeof AdaptiveGuidanceUncertaintyAdjustmentV1Schema>;

export const AdaptiveGuidanceOverlayV1Schema = z.object({
  summary_version: z.literal("adaptive_guidance_overlay_v1"),
  activation_state: z.enum(["active", "empty", "blocked"]),
  query_text: z.string().min(1).max(20000),
  decomposition: AdaptiveGuidanceDecompositionV1Schema,
  candidate_count: z.number().int().min(0),
  selected_candidate_count: z.number().int().min(0),
  skipped_candidate_count: z.number().int().min(0),
  skipped_reasons: z.array(z.string().min(1).max(512)).max(32),
  selected_candidates: z.array(AdaptiveGuidanceCandidateV1Schema).max(8),
  adapted_instructions: z.array(AdaptiveGuidanceInstructionV1Schema).max(16),
  authority_visibility: AdaptiveGuidanceAuthorityV1Schema,
  attribution_plan: AdaptiveGuidanceAttributionPlanV1Schema,
  uncertainty_adjustment: AdaptiveGuidanceUncertaintyAdjustmentV1Schema,
  source_code_change_allowed: z.literal(false),
}).strict();

export type AdaptiveGuidanceOverlayV1 = z.infer<typeof AdaptiveGuidanceOverlayV1Schema>;

export const ExecutionExperienceAdaptationStageNameSchema = z.enum([
  "trajectory_compile",
  "experience_intelligence",
  "task_decomposition",
  "action_retrieval",
  "adaptive_guidance",
  "feedback_attribution",
]);

export type ExecutionExperienceAdaptationStageName = z.infer<typeof ExecutionExperienceAdaptationStageNameSchema>;

export const ExecutionExperienceAdaptationStageV1Schema = z.object({
  stage: ExecutionExperienceAdaptationStageNameSchema,
  status: z.enum(["active", "observed", "ready", "blocked", "empty"]),
  summary: z.string().min(1).max(512),
  source_refs: z.array(z.string().min(1).max(256)).max(32),
  evidence_refs: z.array(z.string().min(1).max(256)).max(32),
}).strict();

export type ExecutionExperienceAdaptationStageV1 = z.infer<typeof ExecutionExperienceAdaptationStageV1Schema>;

export const ExecutionExperienceAdaptationTraceV1Schema = z.object({
  summary_version: z.literal("execution_experience_adaptation_trace_v1"),
  activation_state: z.enum(["active", "empty", "blocked"]),
  trajectory: z.object({
    present: z.boolean(),
    compiled: z.boolean(),
    task_family: z.string().nullable(),
    task_signature: z.string().nullable(),
    workflow_signature: z.string().nullable(),
    target_file_count: z.number().int().min(0),
    acceptance_check_count: z.number().int().min(0),
    service_constraint_count: z.number().int().min(0),
    likely_tool: z.string().nullable(),
  }).strict(),
  experience_sources: z.object({
    stable_workflow_count: z.number().int().min(0),
    candidate_workflow_count: z.number().int().min(0),
    trusted_pattern_count: z.number().int().min(0),
    contested_pattern_count: z.number().int().min(0),
    rehydration_candidate_count: z.number().int().min(0),
    supporting_knowledge_count: z.number().int().min(0),
    adaptive_guidance_candidate_count: z.number().int().min(0),
    delegation_recommendation_count: z.number().int().min(0),
  }).strict(),
  task_decomposition: AdaptiveGuidanceDecompositionV1Schema,
  retrieval: z.object({
    selected_tool: z.string().nullable(),
    tool_source_kind: z.enum(["tools_select", "trusted_pattern", "stable_workflow", "persisted_policy_memory", "adaptive_guidance", "blended"]),
    path_source_kind: z.enum(["recommended_workflow", "candidate_workflow", "none"]),
    selected_path_anchor_id: z.string().nullable(),
    evidence_entry_count: z.number().int().min(0),
    uncertainty_level: z.enum(["low", "moderate", "high"]),
    confidence: z.number().min(0).max(1),
  }).strict(),
  adaptation: z.object({
    activation_state: z.enum(["active", "empty", "blocked"]),
    selected_candidate_ids: z.array(z.string().min(1).max(128)).max(16),
    adapted_instruction_count: z.number().int().min(0),
    primary_instruction: z.string().nullable(),
    recommended_actions: z.array(z.enum([
      "widen_recall",
      "inspect_context",
      "request_operator_review",
    ])).max(8),
    confidence_delta: z.number().min(-1).max(1),
    feedback_slots: z.array(z.string().min(1).max(128)).max(16),
    expected_signal_kind: z.literal("adaptive_guidance_outcome"),
    promotion_requires_candidate_binding: z.literal(true),
  }).strict(),
  authority: z.object({
    contract_trust: z.literal("observational"),
    may_promote_directly: z.literal(false),
    required_promotion_path: z.literal("runtime_signal_attribution_and_learning_control_gate"),
    source_code_change_allowed: z.literal(false),
  }).strict(),
  stages: z.array(ExecutionExperienceAdaptationStageV1Schema).min(6).max(6),
  source_code_change_allowed: z.literal(false),
}).strict();

export type ExecutionExperienceAdaptationTraceV1 = z.infer<typeof ExecutionExperienceAdaptationTraceV1Schema>;

export const ActionRetrievalEvidenceEntrySchema = z.object({
  source_kind: z.enum([
    "persisted_policy_memory",
    "trusted_pattern",
    "stable_workflow",
    "candidate_workflow",
    "contested_pattern",
    "rehydration_candidate",
    "adaptive_guidance_candidate",
  ]),
  anchor_id: z.string().nullable(),
  selected_tool: z.string().nullable(),
  task_family: z.string().nullable().optional(),
  workflow_signature: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  workflow_steps: z.array(z.string()).optional(),
  pattern_hints: z.array(z.string()).optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  authority_visibility: RuntimeAuthorityVisibilityContractSchema.nullable().optional(),
  authority_blocked: z.boolean().optional(),
  authority_primary_blocker: z.string().nullable().optional(),
  confidence: z.number().nullable(),
  reason: z.string(),
}).strict();

export type ActionRetrievalEvidenceEntry = z.infer<typeof ActionRetrievalEvidenceEntrySchema>;

export const ActionRetrievalEvidenceSchema = z.object({
  stable_workflow_count: z.number().int().min(0),
  candidate_workflow_count: z.number().int().min(0),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  rehydration_candidate_count: z.number().int().min(0),
  adaptive_guidance_candidate_count: z.number().int().min(0),
  persisted_policy_memory_id: z.string().nullable(),
  selected_path_anchor_id: z.string().nullable(),
  entries: z.array(ActionRetrievalEvidenceEntrySchema),
}).strict();

export type ActionRetrievalEvidence = z.infer<typeof ActionRetrievalEvidenceSchema>;

export const ActionRetrievalUncertaintySchema = z.object({
  summary_version: z.literal("action_retrieval_uncertainty_v1"),
  level: z.enum(["low", "moderate", "high"]),
  confidence: z.number().min(0).max(1),
  evidence_gap_count: z.number().int().min(0),
  reasons: z.array(z.string()),
  recommended_actions: z.array(z.enum([
    "proceed",
    "widen_recall",
    "rehydrate_payload",
    "inspect_context",
    "request_operator_review",
  ])),
}).strict();

export type ActionRetrievalUncertainty = z.infer<typeof ActionRetrievalUncertaintySchema>;

export const ActionRetrievalGateActionSchema = z.enum([
  "inspect_context",
  "widen_recall",
  "rehydrate_payload",
  "request_operator_review",
]);

export type ActionRetrievalGateAction = z.infer<typeof ActionRetrievalGateActionSchema>;

export const ActionRetrievalGateRehydrationHintSchema = z.object({
  anchor_id: z.string().nullable(),
  anchor_kind: z.string().nullable(),
  anchor_level: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  mode: z.enum(["summary_only", "partial", "full", "differential"]).nullable(),
  example_call: z.string().nullable(),
  payload_cost_hint: z.enum(["low", "medium", "high"]).nullable(),
}).strict();

export type ActionRetrievalGateRehydrationHint = z.infer<typeof ActionRetrievalGateRehydrationHintSchema>;

export const ActionRetrievalGateSummarySchema = z.object({
  summary_version: z.literal("action_retrieval_gate_v1"),
  gate_action: ActionRetrievalGateActionSchema,
  escalates_task_start: z.boolean(),
  confidence: z.number().min(0).max(1),
  primary_reason: z.string().nullable(),
  recommended_actions: z.array(ActionRetrievalGateActionSchema),
  instruction: z.string().nullable(),
  rehydration_candidate_count: z.number().int().min(0),
  preferred_rehydration: ActionRetrievalGateRehydrationHintSchema.nullable(),
}).strict();

export type ActionRetrievalGateSummary = z.infer<typeof ActionRetrievalGateSummarySchema>;

export const ActionRetrievalResponseSchema = z.object({
  summary_version: z.literal("action_retrieval_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  history_applied: z.boolean(),
  tool_source_kind: z.enum(["tools_select", "trusted_pattern", "stable_workflow", "persisted_policy_memory", "adaptive_guidance", "blended"]),
  selected_tool: z.string().nullable(),
  recommended_file_path: z.string().nullable(),
  recommended_next_action: z.string().nullable(),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  tool: ExperienceIntelligenceToolRecommendationSchema,
  path: ExperienceIntelligencePathRecommendationSchema,
  evidence: ActionRetrievalEvidenceSchema,
  adaptive_guidance: AdaptiveGuidanceOverlayV1Schema,
  experience_adaptation_trace: ExecutionExperienceAdaptationTraceV1Schema,
  uncertainty: ActionRetrievalUncertaintySchema,
  rationale: z.object({
    summary: z.string(),
  }).strict(),
}).strict();

export type ActionRetrievalResponse = z.infer<typeof ActionRetrievalResponseSchema>;

export const ActionIntelligenceRuntimeStageNameSchema = z.enum([
  "recall",
  "assess",
  "retrieve",
  "act",
  "distill",
  "evaluate",
  "attribute",
  "mutate",
  "maintain",
  "reuse",
]);

export type ActionIntelligenceRuntimeStageName = z.infer<typeof ActionIntelligenceRuntimeStageNameSchema>;

export const RuntimeSignalKindSchema = z.enum([
  "verifier_result",
  "recovery_cost",
  "retry_count",
  "repeated_discovery",
  "repeated_failed_action",
  "provider_protocol_failure",
  "edit_boundary_rejection",
  "tool_selection_outcome",
  "workflow_reuse_outcome",
  "adaptive_guidance_outcome",
  "maintenance_effect",
  "token_context_pressure",
  "rehydration_usefulness",
]);

export type RuntimeSignalKind = z.infer<typeof RuntimeSignalKindSchema>;

export const RuntimeSignalPolaritySchema = z.enum(["positive", "neutral", "negative"]);
export type RuntimeSignalPolarity = z.infer<typeof RuntimeSignalPolaritySchema>;

export const RuntimeSignalCapabilitySchema = z.enum([
  "continuity",
  "learning",
  "forgetting",
  "learning_control",
]);

export type RuntimeSignalCapability = z.infer<typeof RuntimeSignalCapabilitySchema>;

export const RuntimeSignalAuthorityEffectSchema = z.enum([
  "none",
  "promotion_evidence_candidate",
  "counter_evidence",
  "quarantine",
  "forgetting_signal",
]);

export type RuntimeSignalAuthorityEffect = z.infer<typeof RuntimeSignalAuthorityEffectSchema>;

export const RuntimeSignalLedgerEntryV1Schema = z.object({
  signal_id: z.string().min(1).max(128),
  signal_kind: RuntimeSignalKindSchema,
  polarity: RuntimeSignalPolaritySchema,
  numeric_value: z.number().nullable(),
  text_value: z.string().min(1).max(512).nullable(),
  evidence_refs: z.array(z.string().min(1).max(256)).max(32),
  source_refs: z.array(z.string().min(1).max(256)).max(32),
  affected_capabilities: z.array(RuntimeSignalCapabilitySchema).min(1).max(4),
  authority_effect: RuntimeSignalAuthorityEffectSchema,
}).strict();

export type RuntimeSignalLedgerEntryV1 = z.infer<typeof RuntimeSignalLedgerEntryV1Schema>;

export const RuntimeSignalLedgerV1Schema = z.object({
  ledger_version: z.literal("runtime_signal_ledger_v1"),
  signal_count: z.number().int().min(0),
  positive_signal_count: z.number().int().min(0),
  negative_signal_count: z.number().int().min(0),
  quarantine_signal_count: z.number().int().min(0),
  entries: z.array(RuntimeSignalLedgerEntryV1Schema).max(64),
  source_code_change_allowed: z.literal(false),
}).strict();

export type RuntimeSignalLedgerV1 = z.infer<typeof RuntimeSignalLedgerV1Schema>;

export const RuntimeSignalTrendCountV1Schema = z.object({
  signal_kind: RuntimeSignalKindSchema,
  total: z.number().int().min(0),
  positive: z.number().int().min(0),
  neutral: z.number().int().min(0),
  negative: z.number().int().min(0),
  authority_effects: z.object({
    none: z.number().int().min(0),
    promotion_evidence_candidate: z.number().int().min(0),
    counter_evidence: z.number().int().min(0),
    quarantine: z.number().int().min(0),
    forgetting_signal: z.number().int().min(0),
  }).strict(),
}).strict();

export type RuntimeSignalTrendCountV1 = z.infer<typeof RuntimeSignalTrendCountV1Schema>;

export const RuntimeSignalNumericTrendV1Schema = z.object({
  signal_kind: RuntimeSignalKindSchema,
  count: z.number().int().min(0),
  min: z.number(),
  max: z.number(),
  average: z.number(),
}).strict();

export type RuntimeSignalNumericTrendV1 = z.infer<typeof RuntimeSignalNumericTrendV1Schema>;

export const RuntimeSignalTrendSummaryV1Schema = z.object({
  summary_version: z.literal("runtime_signal_trend_summary_v1"),
  scanned_node_count: z.number().int().min(0),
  included_ledger_count: z.number().int().min(0),
  entry_count: z.number().int().min(0),
  truncated: z.boolean(),
  signal_counts: z.array(RuntimeSignalTrendCountV1Schema).max(13),
  polarity_counts: z.object({
    positive: z.number().int().min(0),
    neutral: z.number().int().min(0),
    negative: z.number().int().min(0),
  }).strict(),
  authority_effect_counts: z.object({
    none: z.number().int().min(0),
    promotion_evidence_candidate: z.number().int().min(0),
    counter_evidence: z.number().int().min(0),
    quarantine: z.number().int().min(0),
    forgetting_signal: z.number().int().min(0),
  }).strict(),
  capability_counts: z.object({
    continuity: z.number().int().min(0),
    learning: z.number().int().min(0),
    forgetting: z.number().int().min(0),
    learning_control: z.number().int().min(0),
  }).strict(),
  quarantine_signal_count: z.number().int().min(0),
  counter_evidence_count: z.number().int().min(0),
  promotion_evidence_candidate_count: z.number().int().min(0),
  forgetting_signal_count: z.number().int().min(0),
  numeric_trends: z.array(RuntimeSignalNumericTrendV1Schema).max(13),
  dominant_negative_signals: z.array(RuntimeSignalKindSchema).max(12),
  dominant_positive_signals: z.array(RuntimeSignalKindSchema).max(12),
  recommended_runtime_posture: z.enum(["reuse", "explore", "constrain", "quarantine"]),
  findings: z.array(z.string().min(1).max(256)).max(12),
  source_node_ids: z.array(z.string().min(1).max(128)).max(64),
  source_code_change_allowed: z.literal(false),
}).strict();

export type RuntimeSignalTrendSummaryV1 = z.infer<typeof RuntimeSignalTrendSummaryV1Schema>;

export const RuntimeEffectPostureV1Schema = z.enum([
  "insufficient_evidence",
  "positive",
  "mixed",
  "constrained",
  "blocked",
]);

export const RuntimeEffectSummaryV1Schema = z.object({
  summary_version: z.literal("runtime_effect_summary_v1"),
  scanned_node_count: z.number().int().min(0),
  included_signal_ledger_count: z.number().int().min(0),
  included_promotion_ledger_count: z.number().int().min(0),
  context_cost_observation_count: z.number().int().min(0),
  truncated: z.boolean(),
  baseline_comparison_required: z.literal(true),
  token_context: z.object({
    observed_count: z.number().int().min(0),
    within_budget_count: z.number().int().min(0),
    over_budget_count: z.number().int().min(0),
    unknown_budget_count: z.number().int().min(0),
    average_est_tokens: z.number().min(0),
    average_token_budget: z.number().min(0).nullable(),
    max_est_tokens: z.number().min(0),
    context_items_reduced_count: z.number().int().min(0),
    primary_savings_levers: z.array(z.string().min(1).max(128)).max(32),
  }).strict(),
  continuity: z.object({
    repeated_discovery_count: z.number().int().min(0),
    repeated_failed_action_count: z.number().int().min(0),
    continuity_ready_signal_count: z.number().int().min(0),
  }).strict(),
  verification: z.object({
    verifier_success_count: z.number().int().min(0),
    verifier_failure_count: z.number().int().min(0),
    retry_count_total: z.number().int().min(0),
    recovery_cost_total: z.number().int().min(0),
    provider_quarantine_count: z.number().int().min(0),
  }).strict(),
  learning: z.object({
    workflow_reuse_success_count: z.number().int().min(0),
    workflow_reuse_failure_count: z.number().int().min(0),
    tool_selection_success_count: z.number().int().min(0),
    tool_selection_failure_count: z.number().int().min(0),
    promotion_admission_rate: z.number().min(0).max(1),
    promotion_contested_rate: z.number().min(0).max(1),
    promotion_invalidation_pressure: z.enum(["none", "low", "medium", "high"]),
    recommended_learning_posture: z.enum([
      "insufficient_evidence",
      "candidate_only",
      "promotion_ready",
      "constrain",
      "invalidate",
    ]),
  }).strict(),
  forgetting: z.object({
    forgetting_signal_count: z.number().int().min(0),
    memory_demotions: z.number().int().min(0),
    memory_archives: z.number().int().min(0),
    rehydration_useful_count: z.number().int().min(0),
    rehydration_unhelpful_count: z.number().int().min(0),
  }).strict(),
  measurable_effect_posture: RuntimeEffectPostureV1Schema,
  findings: z.array(z.string().min(1).max(256)).max(12),
  source_node_ids: z.array(z.string().min(1).max(128)).max(64),
  source_code_change_allowed: z.literal(false),
}).strict();

export type RuntimeEffectSummaryV1 = z.infer<typeof RuntimeEffectSummaryV1Schema>;

export const RuntimeEntropyLevelSchema = z.enum(["low", "medium", "high", "lockdown"]);
export type RuntimeEntropyLevel = z.infer<typeof RuntimeEntropyLevelSchema>;

export const RuntimeRecallBreadthSchema = z.enum(["narrow", "balanced", "wide"]);
export type RuntimeRecallBreadth = z.infer<typeof RuntimeRecallBreadthSchema>;

export const RuntimeVerificationDepthSchema = z.enum(["light", "normal", "strict"]);
export type RuntimeVerificationDepth = z.infer<typeof RuntimeVerificationDepthSchema>;

export const RuntimePromotionThresholdSchema = z.enum(["low", "normal", "high", "blocked"]);
export type RuntimePromotionThreshold = z.infer<typeof RuntimePromotionThresholdSchema>;

export const RuntimeMutationAuthoritySchema = z.enum([
  "none",
  "candidate_only",
  "scoped",
  "stable_allowed",
]);
export type RuntimeMutationAuthority = z.infer<typeof RuntimeMutationAuthoritySchema>;

export const RuntimePlasticityLevelSchema = z.enum(["low", "medium", "high"]);
export type RuntimePlasticityLevel = z.infer<typeof RuntimePlasticityLevelSchema>;

export const RuntimeEntropyProfileV1Schema = z.object({
  profile_version: z.literal("runtime_entropy_profile_v1"),
  entropy_level: RuntimeEntropyLevelSchema,
  exploration_budget: z.number().min(0).max(1),
  control_strength: z.number().min(0).max(1),
  plasticity_level: RuntimePlasticityLevelSchema,
  recall_breadth: RuntimeRecallBreadthSchema,
  verification_depth: RuntimeVerificationDepthSchema,
  promotion_threshold: RuntimePromotionThresholdSchema,
  mutation_authority: RuntimeMutationAuthoritySchema,
  runtime_signal_trend_posture: z.enum(["none", "reuse", "explore", "constrain", "quarantine"]).default("none"),
  reason_codes: z.array(z.string().min(1).max(128)).max(32),
  source_signals: z.array(RuntimeSignalKindSchema).max(64),
  source_code_change_allowed: z.literal(false),
}).strict();

export type RuntimeEntropyProfileV1 = z.infer<typeof RuntimeEntropyProfileV1Schema>;

export const RuntimeVerifierScheduleSchema = z.enum(["skip", "light", "normal", "strict", "blocked"]);
export type RuntimeVerifierSchedule = z.infer<typeof RuntimeVerifierScheduleSchema>;

export const RuntimeEntropyControlsV1Schema = z.object({
  controls_version: z.literal("runtime_entropy_controls_v1"),
  recall: z.object({
    breadth: RuntimeRecallBreadthSchema,
    recommended_limit: z.number().int().min(1).max(200),
    recommended_ranked_limit: z.number().int().min(1).max(500),
    recommended_max_nodes: z.number().int().min(1).max(200),
    recommended_max_edges: z.number().int().min(1).max(100),
    reason: z.string().min(1).max(256),
  }).strict(),
  verifier: z.object({
    verification_depth: RuntimeVerificationDepthSchema,
    schedule: RuntimeVerifierScheduleSchema,
    runtime_verifier_required: z.boolean(),
    reason: z.string().min(1).max(256),
  }).strict(),
  promotion: z.object({
    promotion_threshold: RuntimePromotionThresholdSchema,
    mutation_authority: RuntimeMutationAuthoritySchema,
    minimum_observations: z.number().int().min(1).max(32),
    stable_promotion_allowed: z.boolean(),
    reason: z.string().min(1).max(256),
  }).strict(),
  maintenance: z.object({
    recommended_profile: z.enum(["immediate", "daily", "long_horizon"]),
    run_after_task: z.boolean(),
    reason: z.string().min(1).max(256),
  }).strict(),
  source_code_change_allowed: z.literal(false),
}).strict();

export type RuntimeEntropyControlsV1 = z.infer<typeof RuntimeEntropyControlsV1Schema>;

export const ActionIntelligenceRuntimeStageStatusSchema = z.enum([
  "observed",
  "ready",
  "pending",
  "blocked",
]);

export type ActionIntelligenceRuntimeStageStatus = z.infer<typeof ActionIntelligenceRuntimeStageStatusSchema>;

export const ActionIntelligenceRuntimeStageSchema = z.object({
  stage: ActionIntelligenceRuntimeStageNameSchema,
  status: ActionIntelligenceRuntimeStageStatusSchema,
  summary: z.string().min(1),
  source_refs: z.array(z.string().min(1)).max(64),
  evidence_refs: z.array(z.string().min(1)).max(64),
  required_next: z.string().nullable(),
}).strict();

export type ActionIntelligenceRuntimeStage = z.infer<typeof ActionIntelligenceRuntimeStageSchema>;

export const ActionIntelligenceRuntimeGateSchema = z.object({
  gate_version: z.literal("action_intelligence_pre_action_gate_v1"),
  known_enough: z.boolean(),
  requires_recall: z.boolean(),
  requires_rehydration: z.boolean(),
  requires_operator_review: z.boolean(),
  authority_blocked: z.boolean(),
  uncertainty_level: z.enum(["low", "moderate", "high"]),
  confidence: z.number().min(0).max(1),
  recommended_actions: z.array(z.enum([
    "proceed",
    "widen_recall",
    "rehydrate_payload",
    "inspect_context",
    "request_operator_review",
  ])).max(16),
  primary_reason: z.string().nullable(),
}).strict();

export type ActionIntelligenceRuntimeGate = z.infer<typeof ActionIntelligenceRuntimeGateSchema>;

export const ActionIntelligenceRuntimeEvidenceSummarySchema = z.object({
  summary_version: z.literal("action_intelligence_evidence_summary_v1"),
  stable_workflow_count: z.number().int().min(0),
  candidate_workflow_count: z.number().int().min(0),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  rehydration_candidate_count: z.number().int().min(0),
  adaptive_guidance_candidate_count: z.number().int().min(0),
  persisted_policy_memory_id: z.string().nullable(),
  execution_artifact_count: z.number().int().min(0),
  execution_evidence_count: z.number().int().min(0),
  verifier_evidence_count: z.number().int().min(0),
  distilled_evidence_count: z.number().int().min(0),
  distilled_fact_count: z.number().int().min(0),
  projected_workflow_candidate_count: z.number().int().min(0),
  authority_blocked_count: z.number().int().min(0),
  evidence_refs: z.array(z.string().min(1)).max(128),
}).strict();

export type ActionIntelligenceRuntimeEvidenceSummary = z.infer<typeof ActionIntelligenceRuntimeEvidenceSummarySchema>;

export const ActionIntelligenceRuntimeLifecycleSchema = z.object({
  lifecycle_version: z.literal("action_intelligence_lifecycle_v1"),
  history_applied: z.boolean(),
  post_action_material_present: z.boolean(),
  distillation_ready: z.boolean(),
  workflow_candidate_available: z.boolean(),
  policy_candidate_available: z.boolean(),
  mutation_candidate_available: z.boolean(),
  maintenance_ready: z.boolean(),
  recommended_maintenance_profile: z.enum(["immediate", "daily", "long_horizon"]),
}).strict();

export type ActionIntelligenceRuntimeLifecycle = z.infer<typeof ActionIntelligenceRuntimeLifecycleSchema>;

export const ActionIntelligenceRuntimeContractV1Schema = z.object({
  contract_version: z.literal("action_intelligence_runtime_contract_v1"),
  loop_version: z.literal("action_intelligence_loop_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  run_id: z.string().nullable(),
  query_text: z.string(),
  source_code_change_allowed: z.literal(false),
  selected_tool: z.string().nullable(),
  recommended_next_action: z.string().nullable(),
  target_files: z.array(z.string().min(1)).max(64),
  workflow_anchor_id: z.string().nullable(),
  policy_memory_id: z.string().nullable(),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  pre_action_gate: ActionIntelligenceRuntimeGateSchema,
  runtime_entropy_profile: RuntimeEntropyProfileV1Schema,
  runtime_entropy_controls: RuntimeEntropyControlsV1Schema,
  runtime_signal_trend_summary: RuntimeSignalTrendSummaryV1Schema.nullable().default(null),
  promotion_quality_summary: PromotionQualitySummaryV1Schema.nullable().default(null),
  runtime_effect_summary: RuntimeEffectSummaryV1Schema.nullable().default(null),
  loop: z.object({
    recall: ActionIntelligenceRuntimeStageSchema,
    assess: ActionIntelligenceRuntimeStageSchema,
    retrieve: ActionIntelligenceRuntimeStageSchema,
    act: ActionIntelligenceRuntimeStageSchema,
    distill: ActionIntelligenceRuntimeStageSchema,
    evaluate: ActionIntelligenceRuntimeStageSchema,
    attribute: ActionIntelligenceRuntimeStageSchema,
    mutate: ActionIntelligenceRuntimeStageSchema,
    maintain: ActionIntelligenceRuntimeStageSchema,
    reuse: ActionIntelligenceRuntimeStageSchema,
  }).strict(),
  evidence_summary: ActionIntelligenceRuntimeEvidenceSummarySchema,
  lifecycle: ActionIntelligenceRuntimeLifecycleSchema,
  rationale: z.object({
    summary: z.string(),
  }).strict(),
}).strict();

export type ActionIntelligenceRuntimeContractV1 = z.infer<typeof ActionIntelligenceRuntimeContractV1Schema>;

export const PolicyHintEntrySchema = z.object({
  hint_id: z.string(),
  source_kind: z.enum(["trusted_pattern", "contested_pattern", "stable_workflow", "rehydration_candidate"]),
  hint_kind: z.enum(["tool_preference", "tool_avoidance", "workflow_reuse", "payload_rehydration"]),
  action: z.enum(["prefer", "avoid", "reuse", "rehydrate"]),
  source_anchor_id: z.string(),
  source_anchor_level: z.string().nullable(),
  selected_tool: z.string().nullable(),
  task_family: z.string().nullable().optional(),
  workflow_signature: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  workflow_steps: z.array(z.string()).optional(),
  pattern_hints: z.array(z.string()).optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  rehydration_mode: z.string().nullable(),
  confidence: z.number().nullable(),
  priority: z.number().int().min(0),
  reason: z.string(),
}).passthrough();
export type PolicyHintEntry = z.infer<typeof PolicyHintEntrySchema>;

export const PolicyHintPackSchema = z.object({
  summary_version: z.literal("policy_hint_pack_v1"),
  total_hints: z.number().int().min(0),
  tool_preference_count: z.number().int().min(0),
  tool_avoidance_count: z.number().int().min(0),
  workflow_reuse_count: z.number().int().min(0),
  payload_rehydration_count: z.number().int().min(0),
  hints: z.array(PolicyHintEntrySchema),
});
export type PolicyHintPack = z.infer<typeof PolicyHintPackSchema>;

export const DerivedPolicySurfaceSchema = z.object({
  summary_version: z.literal("derived_policy_v1"),
  policy_kind: z.literal("tool_preference"),
  source_kind: z.enum(["trusted_pattern", "stable_workflow", "blended"]),
  policy_state: z.enum(["candidate", "stable"]),
  contract_trust: ContractTrustSchema.optional(),
  selected_tool: z.string(),
  task_family: z.string().nullable().optional(),
  workflow_signature: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  workflow_steps: z.array(z.string()).optional(),
  pattern_hints: z.array(z.string()).optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  acceptance_checks: z.array(z.string()).optional(),
  success_invariants: z.array(z.string()).optional(),
  dependency_requirements: z.array(z.string()).optional(),
  environment_assumptions: z.array(z.string()).optional(),
  must_hold_after_exit: z.array(z.string()).optional(),
  external_visibility_requirements: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  supporting_anchor_ids: z.array(z.string()),
  reason: z.string(),
  evidence: z.object({
    trusted_pattern_count: z.number().int().min(0),
    stable_workflow_count: z.number().int().min(0),
    usage_count: z.number().int().min(0),
    reuse_success_count: z.number().int().min(0),
    reuse_failure_count: z.number().int().min(0),
    feedback_quality: z.number().nullable(),
  }),
}).passthrough();
export type DerivedPolicySurface = z.infer<typeof DerivedPolicySurfaceSchema>;

export const PolicyContractSchema = z.object({
  summary_version: z.literal("policy_contract_v1"),
  policy_kind: z.literal("tool_preference"),
  source_kind: z.enum(["trusted_pattern", "stable_workflow", "blended"]),
  policy_state: z.enum(["candidate", "stable"]),
  contract_trust: ContractTrustSchema.optional(),
  policy_memory_state: z.enum(["active", "contested", "retired"]).default("active"),
  activation_mode: z.enum(["hint", "default"]),
  materialization_state: z.enum(["computed", "persisted"]).default("computed"),
  history_applied: z.boolean(),
  selected_tool: z.string(),
  avoid_tools: z.array(z.string()),
  task_family: z.string().nullable().optional(),
  workflow_signature: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  next_action: z.string().nullable(),
  workflow_steps: z.array(z.string()).optional(),
  pattern_hints: z.array(z.string()).optional(),
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).optional(),
  acceptance_checks: z.array(z.string()).optional(),
  success_invariants: z.array(z.string()).optional(),
  dependency_requirements: z.array(z.string()).optional(),
  environment_assumptions: z.array(z.string()).optional(),
  must_hold_after_exit: z.array(z.string()).optional(),
  external_visibility_requirements: z.array(z.string()).optional(),
  outcome_contract_gate: OutcomeContractGateSchema.optional(),
  rehydration_mode: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  source_anchor_ids: z.array(z.string()),
  policy_memory_id: z.string().nullable().default(null),
  reason: z.string(),
}).passthrough();
export type PolicyContract = z.infer<typeof PolicyContractSchema>;

export const PolicyReviewAttentionSchema = z.object({
  node_id: z.string(),
  policy_memory_state: z.enum(["active", "contested", "retired"]),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  selected_tool: z.string().nullable(),
  file_path: z.string().nullable(),
  workflow_signature: z.string().nullable(),
  summary: z.string().nullable(),
  feedback_quality: z.number().nullable(),
  last_feedback_at: z.string().nullable(),
  last_materialized_at: z.string().nullable(),
  review_reason: z.string(),
}).passthrough();
export type PolicyReviewAttention = z.infer<typeof PolicyReviewAttentionSchema>;

export const PolicyReviewSummarySchema = z.object({
  summary_version: z.literal("policy_review_summary_v1"),
  persisted_policy_count: z.number().int().min(0),
  active_policy_count: z.number().int().min(0),
  contested_policy_count: z.number().int().min(0),
  retired_policy_count: z.number().int().min(0),
  review_recommended: z.boolean(),
  selected_policy_memory_id: z.string().nullable(),
  selected_policy_memory_state: z.enum(["active", "contested", "retired"]).nullable(),
  attention_policy: PolicyReviewAttentionSchema.nullable(),
}).passthrough();
export type PolicyReviewSummary = z.infer<typeof PolicyReviewSummarySchema>;

export const PolicyLearningControlApplyActionSchema = z.enum(["refresh", "retire", "reactivate"]);
export type PolicyLearningControlApplyAction = z.infer<typeof PolicyLearningControlApplyActionSchema>;

export const PolicyLearningControlContractSchema = z.object({
  contract_version: z.literal("policy_learning_control_contract_v1"),
  action: z.enum(["none", "monitor", "refresh", "retire", "reactivate"]),
  applies: z.boolean(),
  review_required: z.boolean(),
  policy_memory_id: z.string().nullable(),
  current_state: z.enum(["active", "contested", "retired"]).nullable(),
  target_state: z.enum(["active", "contested", "retired"]).nullable(),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  selected_tool: z.string().nullable(),
  file_path: z.string().nullable(),
  workflow_signature: z.string().nullable(),
  rationale: z.string(),
  next_action: z.string().nullable(),
}).passthrough();
export type PolicyLearningControlContract = z.infer<typeof PolicyLearningControlContractSchema>;

export const PolicyLearningControlApplyPayloadSchema = z.object({
  payload_version: z.literal("policy_learning_control_apply_payload_v1"),
  route: z.literal("/v1/memory/policies/learning-control/apply"),
  method: z.literal("POST"),
  action: PolicyLearningControlApplyActionSchema,
  policy_memory_id: z.string(),
  selected_tool: z.string().nullable(),
  current_state: z.enum(["active", "contested", "retired"]).nullable(),
  target_state: z.enum(["active", "contested", "retired"]).nullable(),
  requires_live_context: z.boolean(),
  request_body: z.record(z.unknown()),
  rationale: z.string(),
}).passthrough();
export type PolicyLearningControlApplyPayload = z.infer<typeof PolicyLearningControlApplyPayloadSchema>;

export const PersistedPolicyMemorySchema = z.object({
  node_id: z.string(),
  node_uri: z.string(),
  client_id: z.string(),
  policy_memory_signature: z.string(),
  selected_tool: z.string(),
  policy_state: z.enum(["candidate", "stable"]),
  policy_memory_state: z.enum(["active", "contested", "retired"]),
  activation_mode: z.enum(["hint", "default"]),
  policy_contract: PolicyContractSchema,
}).passthrough();
export type PersistedPolicyMemory = z.infer<typeof PersistedPolicyMemorySchema>;

export const PolicyLearningControlApplyResultSchema = z.object({
  ok: z.boolean(),
  auto_applied: z.boolean(),
  attempted: z.boolean().default(false),
  trigger: z.string(),
  surface: z.string(),
  action: PolicyLearningControlApplyActionSchema.nullable().default(null),
  policy_memory_id: z.string().nullable().default(null),
  previous_state: z.enum(["active", "contested", "retired"]).nullable().default(null),
  next_state: z.enum(["active", "contested", "retired"]).nullable().default(null),
  policy_memory: PersistedPolicyMemorySchema.nullable().default(null),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).nullable().default(null),
}).passthrough();
export type PolicyLearningControlApplyResult = z.infer<typeof PolicyLearningControlApplyResultSchema>;

export const DelegationLearningSummarySchema = z.object({
  task_family: z.string().nullable(),
  matched_records: z.number().int().min(0),
  truncated: z.boolean(),
  route_role_counts: z.record(z.number().int().min(0)),
  record_outcome_counts: z.record(z.number().int().min(0)),
  recommendation_count: z.number().int().min(0),
}).passthrough();

export const DelegationLearningProjectionSchema = z.object({
  summary_version: z.literal("delegation_learning_projection_v1"),
  learning_summary: DelegationLearningSummarySchema,
  learning_recommendations: z.array(z.lazy(() => DelegationRecordsLearningRecommendationSchema)),
}).passthrough();

export const ExperienceIntelligenceResponseSchema = z.object({
  summary_version: z.literal("experience_intelligence_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  action_retrieval: ActionRetrievalResponseSchema,
  action_intelligence_runtime_contract: ActionIntelligenceRuntimeContractV1Schema,
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  recommendation: z.object({
    history_applied: z.boolean(),
    tool: ExperienceIntelligenceToolRecommendationSchema,
    path: ExperienceIntelligencePathRecommendationSchema,
    combined_next_action: z.string().nullable(),
  }).passthrough(),
  policy_hints: PolicyHintPackSchema,
  derived_policy: DerivedPolicySurfaceSchema.nullable(),
  policy_contract: PolicyContractSchema.nullable().default(null),
  learning_summary: DelegationLearningSummarySchema,
  learning_recommendations: z.array(z.lazy(() => DelegationRecordsLearningRecommendationSchema)),
  experience_adaptation_trace: ExecutionExperienceAdaptationTraceV1Schema,
  rationale: z.object({
    summary: z.string(),
  }).passthrough(),
}).passthrough();

export type ExperienceIntelligenceResponse = z.infer<typeof ExperienceIntelligenceResponseSchema>;

export const RuntimeContinuitySignalKindSchema = z.enum([
  "read_file",
  "inspect_context",
  "widen_recall",
  "rehydrate_payload",
  "request_operator_review",
]);

export type RuntimeContinuitySignalKind = z.infer<typeof RuntimeContinuitySignalKindSchema>;

export const RuntimeContinuitySignalSchema = z.object({
  summary_version: z.literal("runtime_continuity_signal_v1"),
  action: RuntimeContinuitySignalKindSchema,
  priority: z.enum(["required", "recommended"]),
  contract_trust: ContractTrustSchema,
  tool_name: z.string().nullable(),
  learned_tool: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  reason: z.string(),
  instruction: z.string(),
}).strict();

export type RuntimeContinuitySignal = z.infer<typeof RuntimeContinuitySignalSchema>;

export const RuntimeEditBoundaryRecommendationSchema = z.object({
  summary_version: z.literal("runtime_edit_boundary_v1"),
  contract_trust: ContractTrustSchema,
  allowed_edit_files: z.array(z.string()),
  forbidden_edit_files: z.array(z.string()),
  required_verifiers: z.array(z.string()),
  anti_shortcut_rules: z.array(z.string()),
  reason: z.string(),
  instruction: z.string(),
}).strict();

export type RuntimeEditBoundaryRecommendation = z.infer<typeof RuntimeEditBoundaryRecommendationSchema>;

export const RuntimeVerificationRepairFileHintSchema = z.object({
  path: z.string().min(1).max(2048),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  message: z.string().min(1).max(800).nullable(),
}).strict();

export const RuntimeVerifierFailurePhaseSchema = z.object({
  summary_version: z.literal("verifier_failure_phase_v1"),
  phase: z.enum([
    "hidden_contract_failure",
    "authored_test_failure",
    "lint_type_failure",
    "provider_failure",
    "tool_protocol_failure",
    "edit_operation_failure",
    "environment_failure",
    "unknown_verifier_failure",
  ]),
  confidence: z.number().min(0).max(1),
  primary_reason: z.string().min(1).max(800),
  failing_command: z.string().min(1).max(800).nullable(),
  primary_files: z.array(z.string().min(1).max(2048)).max(32),
  line_hints: z.array(RuntimeVerificationRepairFileHintSchema).max(32),
  allowed_next_actions: z.array(z.enum([
    "read_file",
    "replace_text",
    "replace_lines",
    "apply_patch",
    "run_command",
    "request_operator_review",
  ])).max(16),
  forbidden_next_actions: z.array(z.enum([
    "list_files",
    "search",
    "edit_unrelated_files",
    "run_unrelated_command",
    "write_tests_only",
    "persist_learning",
  ])).max(16),
  recommended_focus: z.string().min(1).max(1200),
}).strict();

export const RuntimeEditFailurePhaseSchema = z.object({
  summary_version: z.literal("edit_failure_phase_v1"),
  phase: z.enum([
    "stale_line_anchor",
    "unchanged_edit",
    "apply_patch_payload_failure",
    "replace_text_anchor_failure",
    "replace_lines_payload_failure",
    "edit_policy_block",
    "edit_tool_schema_failure",
    "edit_operation_failure",
  ]),
  confidence: z.number().min(0).max(1),
  source_tool: z.enum(["replace_text", "replace_lines", "apply_patch"]),
  failure_count: z.number().int().positive(),
  primary_file: z.string().min(1).max(2048).nullable(),
  line_hints: z.array(RuntimeVerificationRepairFileHintSchema).max(32),
  allowed_next_actions: z.array(z.enum([
    "read_file",
    "replace_text",
    "replace_lines",
    "apply_patch",
    "run_command",
    "request_operator_review",
  ])).max(16),
  forbidden_next_actions: z.array(z.enum([
    "list_files",
    "search",
    "edit_unrelated_files",
    "run_unrelated_command",
    "reuse_stale_anchor",
    "repeat_same_edit",
    "repeat_same_patch",
    "persist_learning",
  ])).max(16),
  recommended_focus: z.string().min(1).max(1200),
  evidence_summary: z.string().min(1).max(800),
}).strict();

export const RuntimeVerificationRepairRecommendationSchema = z.object({
  summary_version: z.literal("runtime_verification_repair_v1"),
  priority: z.enum(["required", "recommended"]),
  contract_trust: ContractTrustSchema,
  failed_verifier_count: z.number().int().min(0),
  failed_commands: z.array(z.string().min(1).max(800)).max(32),
  categories: z.array(z.string().min(1).max(128)).max(32),
  affected_files: z.array(RuntimeVerificationRepairFileHintSchema).max(64),
  verifier_failure_phase_v1: RuntimeVerifierFailurePhaseSchema,
  edit_failure_phase_v1: RuntimeEditFailurePhaseSchema.nullable(),
  failed_tool_schema_hints: z.array(z.string().min(1).max(400)).max(32),
  next_actions: z.array(z.string().min(1).max(800)).max(32),
  reason: z.string().min(1).max(1200),
  instruction: z.string().min(1).max(2000),
}).strict();

export type RuntimeVerificationRepairRecommendation = z.infer<typeof RuntimeVerificationRepairRecommendationSchema>;

export const ContinuityGuidanceSchema = z.object({
  source_kind: z.enum(["experience_intelligence", "tool_selection"]),
  history_applied: z.boolean(),
  contract_trust: ContractTrustSchema,
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  continuity_signal_v1: RuntimeContinuitySignalSchema.nullable().default(null),
  edit_boundary_v1: RuntimeEditBoundaryRecommendationSchema.nullable().default(null),
  verification_repair_v1: RuntimeVerificationRepairRecommendationSchema.nullable().default(null),
  selected_tool: z.string().nullable(),
  task_family: z.string().nullable(),
  workflow_signature: z.string().nullable(),
  policy_memory_id: z.string().nullable(),
  file_path: z.string().nullable(),
  next_action: z.string().nullable(),
});

export const PatternSignalSummarySchema = z.object({
  candidate_pattern_count: z.number().int().min(0),
  candidate_pattern_tools: z.array(z.string()),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  trusted_pattern_tools: z.array(z.string()),
  contested_pattern_tools: z.array(z.string()),
});

export type PatternSignalSummary = z.infer<typeof PatternSignalSummarySchema>;

export const WorkflowSignalSummarySchema = z.object({
  stable_workflow_count: z.number().int().min(0),
  promotion_ready_workflow_count: z.number().int().min(0),
  observing_workflow_count: z.number().int().min(0),
  stable_workflow_titles: z.array(z.string()),
  promotion_ready_workflow_titles: z.array(z.string()),
  observing_workflow_titles: z.array(z.string()),
});

export type WorkflowSignalSummary = z.infer<typeof WorkflowSignalSummarySchema>;

export const PatternLifecycleSummarySchema = z.object({
  candidate_count: z.number().int().min(0),
  trusted_count: z.number().int().min(0),
  contested_count: z.number().int().min(0),
  near_promotion_count: z.number().int().min(0),
  counter_evidence_open_count: z.number().int().min(0),
  transition_counts: z.object({
    candidate_observed: z.number().int().min(0),
    promoted_to_trusted: z.number().int().min(0),
    counter_evidence_opened: z.number().int().min(0),
    revalidated_to_trusted: z.number().int().min(0),
  }),
});

export type PatternLifecycleSummary = z.infer<typeof PatternLifecycleSummarySchema>;

export const PatternMaintenanceSummarySchema = z.object({
  model: z.literal("lazy_online_v1"),
  observe_count: z.number().int().min(0),
  retain_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  promote_candidate_count: z.number().int().min(0),
  review_counter_evidence_count: z.number().int().min(0),
  retain_trusted_count: z.number().int().min(0),
});

export type PatternMaintenanceSummary = z.infer<typeof PatternMaintenanceSummarySchema>;

export const WorkflowLifecycleSummarySchema = z.object({
  candidate_count: z.number().int().min(0),
  stable_count: z.number().int().min(0),
  replay_source_count: z.number().int().min(0),
  rehydration_ready_count: z.number().int().min(0),
  promotion_ready_count: z.number().int().min(0),
  transition_counts: z.object({
    candidate_observed: z.number().int().min(0),
    promoted_to_stable: z.number().int().min(0),
    normalized_latest_stable: z.number().int().min(0),
  }),
});

export type WorkflowLifecycleSummary = z.infer<typeof WorkflowLifecycleSummarySchema>;

export const WorkflowMaintenanceSummarySchema = z.object({
  model: z.literal("lazy_online_v1"),
  observe_count: z.number().int().min(0),
  retain_count: z.number().int().min(0),
  promote_candidate_count: z.number().int().min(0),
  retain_workflow_count: z.number().int().min(0),
});

export type WorkflowMaintenanceSummary = z.infer<typeof WorkflowMaintenanceSummarySchema>;

export const AuthorityVisibilitySummarySchema = z.object({
  summary_version: z.literal("runtime_authority_visibility_summary_v1"),
  surface_count: z.number().int().min(0),
  sufficient_count: z.number().int().min(0),
  insufficient_count: z.number().int().min(0),
  authoritative_allowed_count: z.number().int().min(0),
  authoritative_blocked_count: z.number().int().min(0),
  stable_promotion_allowed_count: z.number().int().min(0),
  stable_promotion_blocked_count: z.number().int().min(0),
  execution_evidence_failed_count: z.number().int().min(0),
  execution_evidence_incomplete_count: z.number().int().min(0),
  false_confidence_count: z.number().int().min(0),
  reason_counts: z.record(z.number().int().min(0)),
  top_blockers: z.array(z.string()),
}).passthrough();

export type AuthorityVisibilitySummary = z.infer<typeof AuthorityVisibilitySummarySchema>;

export const DistillationSignalSummarySchema = z.object({
  distilled_evidence_count: z.number().int().min(0),
  distilled_fact_count: z.number().int().min(0),
  projected_workflow_candidate_count: z.number().int().min(0),
  origin_counts: z.object({
    write_distillation_input_text: z.number().int().min(0),
    write_distillation_event_node: z.number().int().min(0),
    write_distillation_evidence_node: z.number().int().min(0),
    execution_write_projection: z.number().int().min(0),
    handoff_continuity_carrier: z.number().int().min(0),
    session_event_continuity_carrier: z.number().int().min(0),
    session_continuity_carrier: z.number().int().min(0),
    replay_learning_episode: z.number().int().min(0),
  }),
  promotion_target_counts: z.object({
    workflow: z.number().int().min(0),
    pattern: z.number().int().min(0),
    policy: z.number().int().min(0),
  }),
});

export type DistillationSignalSummary = z.infer<typeof DistillationSignalSummarySchema>;

export const PolicyLifecycleSummarySchema = z.object({
  persisted_count: z.number().int().min(0),
  active_count: z.number().int().min(0),
  contested_count: z.number().int().min(0),
  retired_count: z.number().int().min(0),
  default_mode_count: z.number().int().min(0),
  hint_mode_count: z.number().int().min(0),
  stable_policy_count: z.number().int().min(0),
  transition_counts: z.object({
    materialized: z.number().int().min(0),
    refreshed: z.number().int().min(0),
    contested_by_feedback: z.number().int().min(0),
    retired_by_feedback: z.number().int().min(0),
    retired_by_learning_control: z.number().int().min(0),
    reactivated_by_learning_control: z.number().int().min(0),
  }),
});

export type PolicyLifecycleSummary = z.infer<typeof PolicyLifecycleSummarySchema>;

export const PolicyMaintenanceSummarySchema = z.object({
  model: z.literal("lazy_online_v1"),
  observe_count: z.number().int().min(0),
  retain_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  promote_to_default_count: z.number().int().min(0),
  retain_active_policy_count: z.number().int().min(0),
  review_contested_policy_count: z.number().int().min(0),
  retire_policy_count: z.number().int().min(0),
  reactivate_policy_count: z.number().int().min(0),
});

export type PolicyMaintenanceSummary = z.infer<typeof PolicyMaintenanceSummarySchema>;

export const ContinuityCarrierSummarySchema = z.object({
  total_count: z.number().int().min(0),
  handoff_count: z.number().int().min(0),
  session_event_count: z.number().int().min(0),
  session_count: z.number().int().min(0),
});

export type ContinuityCarrierSummary = z.infer<typeof ContinuityCarrierSummarySchema>;

export const ActionPacketSummarySchema = z.object({
  recommended_workflow_count: z.number().int().min(0),
  candidate_workflow_count: z.number().int().min(0),
  candidate_pattern_count: z.number().int().min(0),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  rehydration_candidate_count: z.number().int().min(0),
  supporting_knowledge_count: z.number().int().min(0),
  workflow_anchor_ids: z.array(z.string()),
  candidate_workflow_anchor_ids: z.array(z.string()),
  candidate_pattern_anchor_ids: z.array(z.string()),
  trusted_pattern_anchor_ids: z.array(z.string()),
  contested_pattern_anchor_ids: z.array(z.string()),
  rehydration_anchor_ids: z.array(z.string()),
});

export type ActionPacketSummary = z.infer<typeof ActionPacketSummarySchema>;

export const PlannerPacketTextSurfaceSchema = z.object({
  packet_version: z.literal("planner_packet_v1"),
  sections: z.object({
    recommended_workflows: z.array(z.string()),
    candidate_workflows: z.array(z.string()),
    candidate_patterns: z.array(z.string()),
    trusted_patterns: z.array(z.string()),
    contested_patterns: z.array(z.string()),
    rehydration_candidates: z.array(z.string()),
    supporting_knowledge: z.array(z.string()),
  }),
  merged_text: z.string(),
});

export type PlannerPacketTextSurface = z.infer<typeof PlannerPacketTextSurfaceSchema>;

export const ExecutionTreeEffectSummarySchema = z.object({
  summary_version: z.literal("execution_tree_effect_summary_v1"),
  tree_present: z.boolean(),
  static_selection_observed: z.boolean(),
  current_compressed_node_count: z.number().int().min(0),
  current_raw_node_count: z.number().int().min(0),
  branch_hint_count: z.number().int().min(0),
  failed_branch_hint_count: z.number().int().min(0),
  alternate_branch_hint_count: z.number().int().min(0),
  validated_current_node_count: z.number().int().min(0),
  selected_current_block_count: z.number().int().min(0),
  selected_failed_hint_block_count: z.number().int().min(0),
  compression_signal_present: z.boolean(),
  revision_signal_present: z.boolean(),
  raw_continuation_signal_present: z.boolean(),
  failed_branch_isolated: z.boolean(),
  next_action_contamination_risk: z.enum(["none", "unobserved", "possible"]),
  effect_posture: z.enum(["absent", "continuity_available", "branch_isolated", "needs_review"]),
  findings: z.array(z.string().min(1).max(256)).max(8),
}).strict();

export type ExecutionTreeEffectSummary = z.infer<typeof ExecutionTreeEffectSummarySchema>;

export const ExecutionMemoryOperatorSurfaceSchema = z.object({
  surface_version: z.literal("execution_memory_operator_v1"),
  headline: z.string(),
  sections: z.object({
    workflows: z.array(z.string()),
    patterns: z.array(z.string()),
    maintenance: z.array(z.string()),
  }),
  merged_text: z.string(),
});

export type ExecutionMemoryOperatorSurface = z.infer<typeof ExecutionMemoryOperatorSurfaceSchema>;

export const ExecutionKernelPacketSummarySchema = z.object({
  packet_source_mode: z.string(),
  state_first_assembly: z.boolean(),
  execution_packet_v1_present: z.boolean(),
  execution_state_v1_present: z.boolean(),
  runtime_verification: RuntimeVerificationSurfaceV1Schema.optional(),
  execution_tree_effect_summary: ExecutionTreeEffectSummarySchema.optional(),
  pattern_signal_summary: PatternSignalSummarySchema,
  workflow_signal_summary: WorkflowSignalSummarySchema,
  workflow_lifecycle_summary: WorkflowLifecycleSummarySchema,
  workflow_maintenance_summary: WorkflowMaintenanceSummarySchema,
  authority_visibility_summary: AuthorityVisibilitySummarySchema,
  distillation_signal_summary: DistillationSignalSummarySchema,
  pattern_lifecycle_summary: PatternLifecycleSummarySchema,
  pattern_maintenance_summary: PatternMaintenanceSummarySchema,
  policy_lifecycle_summary: PolicyLifecycleSummarySchema,
  policy_maintenance_summary: PolicyMaintenanceSummarySchema,
  continuity_carrier_summary: ContinuityCarrierSummarySchema,
  action_packet_summary: ActionPacketSummarySchema,
});

export type ExecutionKernelPacketSummary = z.infer<typeof ExecutionKernelPacketSummarySchema>;

export const ExecutionPacketAssemblySummarySchema = z.object({
  packet_source_mode: z.string().nullable(),
  state_first_assembly: z.boolean().nullable(),
  execution_packet_v1_present: z.boolean().nullable(),
  execution_state_v1_present: z.boolean().nullable(),
}).strict();

export type ExecutionPacketAssemblySummary = z.infer<typeof ExecutionPacketAssemblySummarySchema>;

export const ExecutionStrategySummarySchema = z.object({
  summary_version: z.literal("execution_strategy_summary_v1"),
  trust_signal: z.string(),
  strategy_profile: z.string(),
  validation_style: z.string(),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  family_candidate_count: z.number().int().min(0),
  selected_working_set: z.array(z.string()),
  selected_validation_paths: z.array(z.string()),
  selected_pattern_summaries: z.array(z.string()),
  preferred_artifact_refs: z.array(z.string()),
  explanation: z.string(),
}).strict();

export type ExecutionStrategySummary = z.infer<typeof ExecutionStrategySummarySchema>;

export const ExecutionCollaborationSummarySchema = z.object({
  summary_version: z.literal("execution_collaboration_summary_v1"),
  packet_present: z.boolean(),
  coordination_mode: z.string(),
  current_stage: z.string().nullable(),
  active_role: z.string().nullable(),
  next_action: z.string().nullable(),
  target_file_count: z.number().int().min(0),
  pending_validation_count: z.number().int().min(0),
  unresolved_blocker_count: z.number().int().min(0),
  review_contract_present: z.boolean(),
  review_standard: z.string().nullable(),
  acceptance_check_count: z.number().int().min(0),
  rollback_required: z.boolean(),
  resume_anchor_present: z.boolean(),
  resume_anchor_file_path: z.string().nullable(),
  resume_anchor_symbol: z.string().nullable(),
  artifact_ref_count: z.number().int().min(0),
  evidence_ref_count: z.number().int().min(0),
  side_output_artifact_count: z.number().int().min(0),
  side_output_evidence_count: z.number().int().min(0),
  artifact_refs: z.array(z.string()),
  evidence_refs: z.array(z.string()),
}).strict();

export type ExecutionCollaborationSummary = z.infer<typeof ExecutionCollaborationSummarySchema>;

export const ExecutionContinuitySnapshotSummarySchema = z.object({
  summary_version: z.literal("execution_continuity_snapshot_v1"),
  snapshot_mode: z.enum(["memory_only", "packet_backed"]),
  coordination_mode: z.string(),
  trust_signal: z.string(),
  strategy_profile: z.string(),
  validation_style: z.string(),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  selected_tool: z.string().nullable(),
  current_stage: z.string().nullable(),
  active_role: z.string().nullable(),
  next_action: z.string().nullable(),
  working_set: z.array(z.string()),
  validation_paths: z.array(z.string()),
  selected_pattern_summaries: z.array(z.string()),
  preferred_artifact_refs: z.array(z.string()),
  preferred_evidence_refs: z.array(z.string()),
  reviewer_ready: z.boolean(),
  resume_anchor_file_path: z.string().nullable(),
  selected_memory_layers: z.array(z.string()),
  recommended_action: z.string(),
}).strict();

export type ExecutionContinuitySnapshotSummary = z.infer<typeof ExecutionContinuitySnapshotSummarySchema>;

const ExecutionForgettingCountSchema = z.object({
  retain: z.number().int().min(0),
  demote: z.number().int().min(0),
  archive: z.number().int().min(0),
  review: z.number().int().min(0),
}).strict();

const ExecutionForgettingLifecycleStateCountsSchema = z.object({
  active: z.number().int().min(0),
  contested: z.number().int().min(0),
  retired: z.number().int().min(0),
  archived: z.number().int().min(0),
}).strict();

const ExecutionArchiveRelocationStateCountsSchema = z.object({
  none: z.number().int().min(0),
  candidate: z.number().int().min(0),
  cold_archive: z.number().int().min(0),
}).strict();

const ExecutionArchiveRelocationTargetCountsSchema = z.object({
  none: z.number().int().min(0),
  local_cold_store: z.number().int().min(0),
  external_object_store: z.number().int().min(0),
}).strict();

const ExecutionArchivePayloadScopeCountsSchema = z.object({
  none: z.number().int().min(0),
  anchor_payload: z.number().int().min(0),
  node: z.number().int().min(0),
}).strict();

const ExecutionRehydrationModeCountsSchema = z.object({
  summary_only: z.number().int().min(0),
  partial: z.number().int().min(0),
  full: z.number().int().min(0),
  differential: z.number().int().min(0),
}).strict();

export const ExecutionForgettingSummarySchema = z.object({
  summary_version: z.literal("execution_forgetting_summary_v1"),
  substrate_mode: z.enum(["stable", "suppression_present", "forgetting_active"]),
  forgotten_items: z.number().int().min(0),
  forgotten_by_reason: z.record(z.number().int().min(0)),
  primary_forgetting_reason: z.string().nullable(),
  suppressed_pattern_count: z.number().int().min(0),
  suppressed_pattern_anchor_ids: z.array(z.string()),
  suppressed_pattern_sources: z.array(z.string()),
  selected_memory_layers: z.array(z.string()),
  semantic_action_counts: ExecutionForgettingCountSchema,
  lifecycle_state_counts: ExecutionForgettingLifecycleStateCountsSchema,
  archive_relocation_state_counts: ExecutionArchiveRelocationStateCountsSchema,
  archive_relocation_target_counts: ExecutionArchiveRelocationTargetCountsSchema,
  archive_payload_scope_counts: ExecutionArchivePayloadScopeCountsSchema,
  rehydration_mode_counts: ExecutionRehydrationModeCountsSchema,
  differential_rehydration_candidate_count: z.number().int().min(0),
  primary_savings_levers: z.array(z.string()),
  stale_signal_count: z.number().int().min(0),
  recommended_action: z.string(),
}).strict();

export type ExecutionForgettingSummary = z.infer<typeof ExecutionForgettingSummarySchema>;

export const ExecutionCollaborationRoutingSummarySchema = z.object({
  summary_version: z.literal("execution_collaboration_routing_v1"),
  route_mode: z.enum(["memory_only", "packet_backed"]),
  coordination_mode: z.string(),
  route_intent: z.string(),
  task_brief: z.string().nullable(),
  current_stage: z.string().nullable(),
  active_role: z.string().nullable(),
  selected_tool: z.string().nullable(),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  next_action: z.string().nullable(),
  target_files: z.array(z.string()),
  validation_paths: z.array(z.string()),
  unresolved_blockers: z.array(z.string()),
  hard_constraints: z.array(z.string()),
  review_standard: z.string().nullable(),
  required_outputs: z.array(z.string()),
  acceptance_checks: z.array(z.string()),
  preferred_artifact_refs: z.array(z.string()),
  preferred_evidence_refs: z.array(z.string()),
  routing_drivers: z.array(z.string()),
}).strict();

export type ExecutionCollaborationRoutingSummary = z.infer<typeof ExecutionCollaborationRoutingSummarySchema>;

export const ExecutionDelegationRecordsSummarySchema = z.object({
  summary_version: z.literal("execution_delegation_records_v1"),
  record_mode: z.enum(["memory_only", "packet_backed"]),
  route_role: z.string(),
  packet_count: z.number().int().min(0),
  return_count: z.number().int().min(0),
  artifact_routing_count: z.number().int().min(0),
  missing_record_types: z.array(z.string()),
  delegation_packets: z.array(ExecutionDelegationPacketRecordV1Schema),
  delegation_returns: z.array(ExecutionDelegationReturnRecordV1Schema),
  artifact_routing_records: z.array(ExecutionArtifactRoutingRecordV1Schema),
}).strict();

export type ExecutionDelegationRecordsSummary = z.infer<typeof ExecutionDelegationRecordsSummarySchema>;

export const ExecutionRoutingSignalSummarySchema = z.object({
  summary_version: z.literal("execution_routing_summary_v1"),
  selected_tool: z.string().nullable(),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  stable_workflow_anchor_ids: z.array(z.string()),
  candidate_workflow_anchor_ids: z.array(z.string()),
  rehydration_anchor_ids: z.array(z.string()),
  workflow_source_kinds: z.array(z.string()),
  same_family_rehydration_anchor_ids: z.array(z.string()),
  other_family_rehydration_anchor_ids: z.array(z.string()),
  unknown_family_rehydration_anchor_ids: z.array(z.string()),
}).strict();

export type ExecutionRoutingSignalSummary = z.infer<typeof ExecutionRoutingSignalSummarySchema>;

export const ExecutionMaintenanceSummarySchema = z.object({
  summary_version: z.literal("execution_maintenance_summary_v1"),
  forgotten_items: z.number().int().min(0),
  forgotten_by_reason: z.record(z.number().int().min(0)),
  suppressed_pattern_count: z.number().int().min(0),
  stable_workflow_count: z.number().int().min(0),
  promotion_ready_workflow_count: z.number().int().min(0),
  selected_memory_layers: z.array(z.string()),
  primary_savings_levers: z.array(z.string()),
  recommended_action: z.string(),
}).strict();

export type ExecutionMaintenanceSummary = z.infer<typeof ExecutionMaintenanceSummarySchema>;

export const ExecutionInstrumentationSummarySchema = z.object({
  summary_version: z.literal("execution_instrumentation_summary_v1"),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  family_hit: z.boolean(),
  family_reason: z.string(),
  selected_pattern_hit_count: z.number().int().min(0),
  selected_pattern_miss_count: z.number().int().min(0),
  rehydration_candidate_count: z.number().int().min(0),
  known_family_rehydration_count: z.number().int().min(0),
  same_family_rehydration_count: z.number().int().min(0),
  other_family_rehydration_count: z.number().int().min(0),
  unknown_family_rehydration_count: z.number().int().min(0),
  rehydration_family_hit_rate: z.number().min(0).max(1),
  same_family_rehydration_anchor_ids: z.array(z.string()),
  other_family_rehydration_anchor_ids: z.array(z.string()),
}).strict();

export type ExecutionInstrumentationSummary = z.infer<typeof ExecutionInstrumentationSummarySchema>;

export const ExecutionSummaryV1Schema = z.object({
  summary_version: z.literal("execution_summary_v1"),
  planner_packet: PlannerPacketTextSurfaceSchema.nullable(),
  pattern_signals: z.array(PlannerPacketEntrySchema),
  workflow_signals: z.array(PlannerPacketEntrySchema),
  packet_assembly: ExecutionPacketAssemblySummarySchema,
  strategy_summary: ExecutionStrategySummarySchema,
  collaboration_summary: ExecutionCollaborationSummarySchema,
  continuity_snapshot_summary: ExecutionContinuitySnapshotSummarySchema,
  routing_signal_summary: ExecutionRoutingSignalSummarySchema,
  maintenance_summary: ExecutionMaintenanceSummarySchema,
  forgetting_summary: ExecutionForgettingSummarySchema,
  collaboration_routing_summary: ExecutionCollaborationRoutingSummarySchema,
  delegation_records_summary: ExecutionDelegationRecordsSummarySchema,
  instrumentation_summary: ExecutionInstrumentationSummarySchema,
  execution_tree_effect_summary: ExecutionTreeEffectSummarySchema.optional(),
  pattern_signal_summary: PatternSignalSummarySchema,
  workflow_signal_summary: WorkflowSignalSummarySchema,
  workflow_lifecycle_summary: WorkflowLifecycleSummarySchema,
  workflow_maintenance_summary: WorkflowMaintenanceSummarySchema,
  authority_visibility_summary: AuthorityVisibilitySummarySchema,
  distillation_signal_summary: DistillationSignalSummarySchema,
  pattern_lifecycle_summary: PatternLifecycleSummarySchema,
  pattern_maintenance_summary: PatternMaintenanceSummarySchema,
  policy_lifecycle_summary: PolicyLifecycleSummarySchema,
  policy_maintenance_summary: PolicyMaintenanceSummarySchema,
  continuity_carrier_summary: ContinuityCarrierSummarySchema,
  action_packet_summary: ActionPacketSummarySchema,
}).strict();

export type ExecutionSummaryV1 = z.infer<typeof ExecutionSummaryV1Schema>;

export const ExecutionMemoryIntrospectionResponseSchema = z.object({
  summary_version: z.literal("execution_memory_introspection_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  inventory: z.object({
    raw_workflow_anchor_count: z.number().int().min(0),
    raw_workflow_candidate_count: z.number().int().min(0),
    suppressed_candidate_workflow_count: z.number().int().min(0),
    continuity_projected_candidate_count: z.number().int().min(0),
    continuity_auto_promoted_workflow_count: z.number().int().min(0),
    raw_pattern_anchor_count: z.number().int().min(0),
    raw_distilled_evidence_count: z.number().int().min(0),
    raw_distilled_fact_count: z.number().int().min(0),
  }),
  continuity_projection_report: z.object({
    sampled_source_event_count: z.number().int().min(0),
    decision_counts: z.object({
      projected: z.number().int().min(0),
      skipped_missing_execution_continuity: z.number().int().min(0),
      skipped_invalid_execution_state: z.number().int().min(0),
      skipped_invalid_execution_packet: z.number().int().min(0),
      skipped_existing_workflow_memory: z.number().int().min(0),
      skipped_stable_exists: z.number().int().min(0),
      eligible_without_projection: z.number().int().min(0),
    }),
    samples: z.array(z.object({
      source_node_id: z.string(),
      source_client_id: z.string().nullable(),
      title: z.string().nullable(),
      decision: z.string(),
      workflow_signature: z.string().nullable(),
      projection_client_id: z.string().nullable(),
    })),
  }),
  operator_surface: ExecutionMemoryOperatorSurfaceSchema,
  execution_summary: ExecutionSummaryV1Schema,
  cognitive_structure_v1: z.object({
    structure_version: z.literal("cognitive_structure_v1"),
  }).passthrough(),
  recommended_workflows: z.array(PlannerPacketEntrySchema),
  candidate_workflows: z.array(PlannerPacketEntrySchema),
  candidate_patterns: z.array(PlannerPacketEntrySchema),
  trusted_patterns: z.array(PlannerPacketEntrySchema),
  contested_patterns: z.array(PlannerPacketEntrySchema),
  rehydration_candidates: z.array(PlannerPacketEntrySchema),
  supporting_knowledge: z.array(PlannerPacketEntrySchema),
  pattern_signals: z.array(PlannerPacketEntrySchema),
  workflow_signals: z.array(PlannerPacketEntrySchema),
  authority_decision_report: RuntimeAuthorityDecisionReportV1Schema,
  action_packet_summary: ActionPacketSummarySchema,
  pattern_signal_summary: PatternSignalSummarySchema,
  workflow_signal_summary: WorkflowSignalSummarySchema,
  workflow_lifecycle_summary: WorkflowLifecycleSummarySchema,
  workflow_maintenance_summary: WorkflowMaintenanceSummarySchema,
  authority_visibility_summary: AuthorityVisibilitySummarySchema,
  distillation_signal_summary: DistillationSignalSummarySchema,
  pattern_lifecycle_summary: PatternLifecycleSummarySchema,
  pattern_maintenance_summary: PatternMaintenanceSummarySchema,
  policy_lifecycle_summary: PolicyLifecycleSummarySchema,
  policy_maintenance_summary: PolicyMaintenanceSummarySchema,
  continuity_carrier_summary: ContinuityCarrierSummarySchema,
  outcome_contract_gate_summary: z.object({
    summary_version: z.literal("outcome_contract_gate_summary_v1"),
    sufficient_count: z.number().int().min(0),
    insufficient_count: z.number().int().min(0),
    authoritative_allowed_count: z.number().int().min(0),
    authoritative_blocked_count: z.number().int().min(0),
    service_lifecycle_gap_count: z.number().int().min(0),
    reason_counts: z.record(z.number().int().min(0)),
  }).default({
    summary_version: "outcome_contract_gate_summary_v1",
    sufficient_count: 0,
    insufficient_count: 0,
    authoritative_allowed_count: 0,
    authoritative_blocked_count: 0,
    service_lifecycle_gap_count: 0,
    reason_counts: {},
  }),
});

export type ExecutionMemoryIntrospectionResponse = z.infer<typeof ExecutionMemoryIntrospectionResponseSchema>;

export const EvolutionInspectRequest = ExperienceIntelligenceRequest;
export type EvolutionInspectInput = z.infer<typeof EvolutionInspectRequest>;

export const EvolutionInspectSummarySchema = z.object({
  summary_version: z.literal("evolution_inspect_summary_v1"),
  history_applied: z.boolean(),
  selected_tool: z.string().nullable(),
  recommended_file_path: z.string().nullable(),
  recommended_next_action: z.string().nullable(),
  stable_workflow_count: z.number().int().min(0),
  promotion_ready_workflow_count: z.number().int().min(0),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  suppressed_pattern_count: z.number().int().min(0),
  distilled_evidence_count: z.number().int().min(0).default(0),
  distilled_fact_count: z.number().int().min(0).default(0),
  persisted_policy_count: z.number().int().min(0).default(0),
  active_policy_count: z.number().int().min(0).default(0),
  contested_policy_count: z.number().int().min(0).default(0),
  retired_policy_count: z.number().int().min(0).default(0),
}).passthrough();

export const EvolutionInspectResponseSchema = z.object({
  summary_version: z.literal("evolution_inspect_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  experience_intelligence: ExperienceIntelligenceResponseSchema,
  policy_hints: PolicyHintPackSchema.optional(),
  derived_policy: DerivedPolicySurfaceSchema.nullable(),
  policy_contract: PolicyContractSchema.nullable().default(null),
  policy_review: PolicyReviewSummarySchema,
  policy_learning_control_contract: PolicyLearningControlContractSchema,
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_apply_result: PolicyLearningControlApplyResultSchema.nullable().default(null),
  execution_introspection: ExecutionMemoryIntrospectionResponseSchema,
  evolution_summary: EvolutionInspectSummarySchema,
}).passthrough();

export type EvolutionInspectResponse = z.infer<typeof EvolutionInspectResponseSchema>;

export const EvolutionReviewContractSchema = z.object({
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  selected_tool: z.string().nullable(),
  file_path: z.string().nullable(),
  target_files: z.array(z.string()),
  next_action: z.string().nullable(),
  stable_workflow_anchor_id: z.string().nullable(),
  promotion_ready_anchor_ids: z.array(z.string()),
  trusted_pattern_anchor_ids: z.array(z.string()),
  contested_pattern_anchor_ids: z.array(z.string()),
  suppressed_pattern_anchor_ids: z.array(z.string()),
}).passthrough();

export const EvolutionReviewPackSummarySchema = z.object({
  pack_version: z.literal("evolution_review_pack_v1"),
  stable_workflow: z.record(z.unknown()).nullable(),
  promotion_ready_workflow: z.record(z.unknown()).nullable(),
  trusted_pattern: z.record(z.unknown()).nullable(),
  contested_pattern: z.record(z.unknown()).nullable(),
  derived_policy: DerivedPolicySurfaceSchema.nullable(),
  policy_contract: PolicyContractSchema.nullable().default(null),
  policy_review: PolicyReviewSummarySchema,
  policy_learning_control_contract: PolicyLearningControlContractSchema,
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_apply_result: PolicyLearningControlApplyResultSchema.nullable().default(null),
  review_contract: EvolutionReviewContractSchema,
  learning_summary: DelegationLearningSummarySchema,
  learning_recommendations: z.array(z.lazy(() => DelegationRecordsLearningRecommendationSchema)),
}).passthrough();

export const EvolutionReviewPackResponseSchema = z.object({
  summary_version: z.literal("evolution_review_pack_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  evolution_inspect: EvolutionInspectResponseSchema,
  evolution_review_pack: EvolutionReviewPackSummarySchema,
}).passthrough();

export type EvolutionReviewPackResponse = z.infer<typeof EvolutionReviewPackResponseSchema>;

export const AgentMemoryInspectRequest = ExperienceIntelligenceRequest.extend({
  handoff_id: z.string().min(1).optional(),
  handoff_uri: z.string().min(1).optional(),
  anchor: z.string().min(1).optional(),
  repo_root: z.string().min(1).optional(),
  file_path: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  handoff_kind: z.enum(["patch_handoff", "review_handoff", "task_handoff"]).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  include_payload: z.boolean().optional(),
  session_id: z.string().min(1).max(128).optional(),
  source_kind: z.string().min(1).optional(),
  continuity_kind: z.string().min(1).optional(),
  continuity_phase: z.string().min(1).optional(),
  include_meta: z.boolean().default(false),
  limit: z.coerce.number().int().positive().max(20).default(5),
  offset: z.coerce.number().int().min(0).max(200000).default(0),
});

export type AgentMemoryInspectInput = z.infer<typeof AgentMemoryInspectRequest>;

export const AgentMemoryInspectSummarySchema = z.object({
  summary_version: z.literal("agent_memory_inspect_summary_v1"),
  has_continuity: z.boolean(),
  latest_handoff_anchor: z.string().nullable(),
  latest_resume_source_kind: z.string().nullable(),
  selected_tool: z.string().nullable(),
  recommended_file_path: z.string().nullable(),
  recommended_next_action: z.string().nullable(),
  history_applied: z.boolean(),
  stable_workflow_count: z.number().int().min(0),
  promotion_ready_workflow_count: z.number().int().min(0),
  trusted_pattern_count: z.number().int().min(0),
  suppressed_pattern_count: z.number().int().min(0),
  distilled_evidence_count: z.number().int().min(0).default(0),
  distilled_fact_count: z.number().int().min(0).default(0),
  handoff_related_items: z.number().int().min(0),
  resume_related_items: z.number().int().min(0),
  derived_policy_source_kind: z.enum(["trusted_pattern", "stable_workflow", "blended"]).nullable().default(null),
  derived_policy_selected_tool: z.string().nullable().default(null),
  derived_policy_state: z.enum(["candidate", "stable"]).nullable().default(null),
  policy_activation_mode: z.enum(["hint", "default"]).nullable().default(null),
  policy_review_recommended: z.boolean().default(false),
  active_policy_count: z.number().int().min(0).default(0),
  contested_policy_count: z.number().int().min(0).default(0),
  retired_policy_count: z.number().int().min(0).default(0),
  selected_policy_memory_state: z.enum(["active", "contested", "retired"]).nullable().default(null),
  policy_learning_control_action: z.enum(["none", "monitor", "refresh", "retire", "reactivate"]).default("none"),
  policy_learning_control_review_required: z.boolean().default(false),
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_auto_applied: z.boolean().default(false),
});

export type AgentMemoryInspectSummary = z.infer<typeof AgentMemoryInspectSummarySchema>;

export const AgentMemoryInspectResponseSchema = z.object({
  summary_version: z.literal("agent_memory_inspect_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  continuity_inspect: ContinuityInspectSummarySchema.nullable(),
  continuity_review_pack: ContinuityReviewPackSummarySchema.nullable(),
  evolution_inspect: EvolutionInspectResponseSchema,
  evolution_review_pack: EvolutionReviewPackSummarySchema,
  derived_policy: DerivedPolicySurfaceSchema.nullable().default(null),
  policy_contract: PolicyContractSchema.nullable().default(null),
  policy_review: PolicyReviewSummarySchema,
  policy_learning_control_contract: PolicyLearningControlContractSchema,
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_apply_result: PolicyLearningControlApplyResultSchema.nullable().default(null),
  agent_memory_summary: AgentMemoryInspectSummarySchema,
}).passthrough();

export type AgentMemoryInspectResponse = z.infer<typeof AgentMemoryInspectResponseSchema>;

export const AgentMemoryReviewPackRequest = AgentMemoryInspectRequest;
export type AgentMemoryReviewPackInput = z.infer<typeof AgentMemoryReviewPackRequest>;

export const AgentMemoryReviewPackSummarySchema = z.object({
  pack_version: z.literal("agent_memory_review_pack_v1"),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  selected_tool: z.string().nullable(),
  recommended_file_path: z.string().nullable(),
  recommended_next_action: z.string().nullable(),
  latest_handoff_anchor: z.string().nullable(),
  latest_resume_source_kind: z.string().nullable(),
  stable_workflow_anchor_id: z.string().nullable(),
  promotion_ready_anchor_ids: z.array(z.string()),
  trusted_pattern_anchor_ids: z.array(z.string()),
  contested_pattern_anchor_ids: z.array(z.string()),
  suppressed_pattern_anchor_ids: z.array(z.string()),
  handoff_target_files: z.array(z.string()),
  acceptance_checks: z.array(z.string()),
  must_change: z.array(z.string()),
  must_remove: z.array(z.string()),
  must_keep: z.array(z.string()),
  rollback_required: z.boolean(),
  derived_policy: DerivedPolicySurfaceSchema.nullable().default(null),
  policy_contract: PolicyContractSchema.nullable().default(null),
  policy_review: PolicyReviewSummarySchema,
  policy_learning_control_contract: PolicyLearningControlContractSchema,
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_apply_result: PolicyLearningControlApplyResultSchema.nullable().default(null),
});

export type AgentMemoryReviewPackSummary = z.infer<typeof AgentMemoryReviewPackSummarySchema>;

export const AgentMemoryReviewPackResponseSchema = z.object({
  summary_version: z.literal("agent_memory_review_pack_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  agent_memory_inspect: AgentMemoryInspectResponseSchema,
  agent_memory_review_pack: AgentMemoryReviewPackSummarySchema,
}).passthrough();

export type AgentMemoryReviewPackResponse = z.infer<typeof AgentMemoryReviewPackResponseSchema>;

export const AgentMemoryResumePackRequest = AgentMemoryInspectRequest;
export type AgentMemoryResumePackInput = z.infer<typeof AgentMemoryResumePackRequest>;

export const AgentMemoryResumePackSummarySchema = z.object({
  pack_version: z.literal("agent_memory_resume_pack_v1"),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  latest_handoff_anchor: z.string().nullable(),
  latest_resume_source_kind: z.string().nullable(),
  resume_selected_tool: z.string().nullable(),
  resume_file_path: z.string().nullable(),
  resume_target_files: z.array(z.string()),
  resume_next_action: z.string().nullable(),
  stable_workflow_anchor_id: z.string().nullable(),
  promotion_ready_anchor_ids: z.array(z.string()),
  trusted_pattern_anchor_ids: z.array(z.string()),
  suppressed_pattern_anchor_ids: z.array(z.string()),
  rollback_required: z.boolean(),
  recovered_handoff: z.record(z.unknown()).nullable(),
  execution_ready_handoff: z.record(z.unknown()).nullable(),
  derived_policy: DerivedPolicySurfaceSchema.nullable().default(null),
  policy_contract: PolicyContractSchema.nullable().default(null),
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_apply_result: PolicyLearningControlApplyResultSchema.nullable().default(null),
});

export type AgentMemoryResumePackSummary = z.infer<typeof AgentMemoryResumePackSummarySchema>;

export const AgentMemoryResumePackResponseSchema = z.object({
  summary_version: z.literal("agent_memory_resume_pack_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  agent_memory_inspect: AgentMemoryInspectResponseSchema,
  agent_memory_resume_pack: AgentMemoryResumePackSummarySchema,
}).passthrough();

export type AgentMemoryResumePackResponse = z.infer<typeof AgentMemoryResumePackResponseSchema>;

export const AgentMemoryHandoffPackRequest = AgentMemoryInspectRequest;
export type AgentMemoryHandoffPackInput = z.infer<typeof AgentMemoryHandoffPackRequest>;

export const AgentMemoryHandoffPackSummarySchema = z.object({
  pack_version: z.literal("agent_memory_handoff_pack_v1"),
  execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
  latest_handoff_anchor: z.string().nullable(),
  handoff_kind: z.string().nullable(),
  handoff_file_path: z.string().nullable(),
  handoff_repo_root: z.string().nullable(),
  handoff_symbol: z.string().nullable(),
  handoff_target_files: z.array(z.string()),
  handoff_next_action: z.string().nullable(),
  acceptance_checks: z.array(z.string()),
  must_change: z.array(z.string()),
  must_remove: z.array(z.string()),
  must_keep: z.array(z.string()),
  rollback_required: z.boolean(),
  stable_workflow_anchor_id: z.string().nullable(),
  trusted_pattern_anchor_ids: z.array(z.string()),
  suppressed_pattern_anchor_ids: z.array(z.string()),
  recovered_handoff: z.record(z.unknown()).nullable(),
  execution_ready_handoff: z.record(z.unknown()).nullable(),
  derived_policy: DerivedPolicySurfaceSchema.nullable().default(null),
  policy_contract: PolicyContractSchema.nullable().default(null),
  policy_learning_control_apply_payload: PolicyLearningControlApplyPayloadSchema.nullable().default(null),
  policy_learning_control_apply_result: PolicyLearningControlApplyResultSchema.nullable().default(null),
});

export type AgentMemoryHandoffPackSummary = z.infer<typeof AgentMemoryHandoffPackSummarySchema>;

export const AgentMemoryHandoffPackResponseSchema = z.object({
  summary_version: z.literal("agent_memory_handoff_pack_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  query_text: z.string(),
  agent_memory_inspect: AgentMemoryInspectResponseSchema,
  agent_memory_handoff_pack: AgentMemoryHandoffPackSummarySchema,
}).passthrough();

export type AgentMemoryHandoffPackResponse = z.infer<typeof AgentMemoryHandoffPackResponseSchema>;

export const PolicyLearningControlApplyRequestSchema = ExperienceIntelligenceRequest.partial()
  .extend({
    tenant_id: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    policy_memory_id: z.string().uuid(),
    action: PolicyLearningControlApplyActionSchema,
    reason: z.string().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "refresh" && value.action !== "reactivate") return;
    if (typeof value.query_text !== "string" || !value.query_text.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query_text"],
        message: "must set query_text for refresh/reactivate",
      });
    }
    if (value.context === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context"],
        message: "must set context for refresh/reactivate",
      });
    }
    if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "must set candidates for refresh/reactivate",
      });
    }
  });

export type PolicyLearningControlApplyInput = z.infer<typeof PolicyLearningControlApplyRequestSchema>;

export const PolicyLearningControlApplyResponseSchema = z.object({
  ok: z.literal(true),
  tenant_id: z.string(),
  scope: z.string(),
  action: PolicyLearningControlApplyActionSchema,
  applied: z.boolean(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  policy_memory_id: z.string(),
  previous_state: z.enum(["active", "contested", "retired"]),
  next_state: z.enum(["active", "contested", "retired"]),
  learning_control_contract: PolicyLearningControlContractSchema,
  live_policy_contract: PolicyContractSchema.nullable(),
  policy_memory: PersistedPolicyMemorySchema,
  policy_mutation_v1: z.object({
    mutation_version: z.literal("policy_mutation_v1"),
  }).passthrough(),
  policy_mutation_adjudication_v1: z.object({
    adjudication_version: z.literal("policy_mutation_adjudication_v1"),
  }).passthrough(),
}).passthrough();

export type PolicyLearningControlApplyResponse = z.infer<typeof PolicyLearningControlApplyResponseSchema>;

export const HistoryImpactCapabilitySchema = z.enum([
  "continuity",
  "learning",
  "forgetting",
  "learning_control",
]);

export const HistoryImpactLevelSchema = z.enum([
  "none",
  "context_shaping",
  "action_shaping",
  "learning_controlled",
]);

export const HistoryImpactNextRunChangeSchema = z.enum([
  "continuity_state_available",
  "trusted_evidence_available",
  "workflow_reuse_available",
  "candidate_learning_visible",
  "contested_memory_visible",
  "memory_suppressed_or_forgotten",
  "rehydration_available",
  "learning_control_limited_authority",
  "continuity_signal_shaped_by_history",
  "runtime_entropy_visible",
]);

export const HistoryImpactSummarySchema = z.object({
  summary_version: z.literal("history_impact_summary_v1"),
  history_applied: z.boolean(),
  changed_next_run: z.boolean(),
  impact_level: HistoryImpactLevelSchema,
  affected_capabilities: z.array(HistoryImpactCapabilitySchema),
  continuity: z.object({
    continuity_carrier_count: z.number().int().min(0),
    static_blocks_selected: z.number().int().min(0),
    selected_memory_layer_count: z.number().int().min(0),
  }).strict(),
  learning: z.object({
    stable_workflow_count: z.number().int().min(0),
    candidate_workflow_count: z.number().int().min(0),
    promotion_ready_workflow_count: z.number().int().min(0),
    trusted_pattern_count: z.number().int().min(0),
    contested_pattern_count: z.number().int().min(0),
    active_policy_count: z.number().int().min(0),
    contested_policy_count: z.number().int().min(0),
  }).strict(),
  forgetting: z.object({
    substrate_mode: z.enum(["stable", "suppression_present", "forgetting_active"]),
    forgotten_items: z.number().int().min(0),
    suppressed_pattern_count: z.number().int().min(0),
    differential_rehydration_candidate_count: z.number().int().min(0),
    stale_signal_count: z.number().int().min(0),
  }).strict(),
  learning_control: z.object({
    contract_trust: ContractTrustSchema.nullable(),
    action_start_blocked: z.boolean(),
    authoritative_allowed_count: z.number().int().min(0),
    authoritative_blocked_count: z.number().int().min(0),
    stable_promotion_allowed_count: z.number().int().min(0),
    stable_promotion_blocked_count: z.number().int().min(0),
    primary_blockers: z.array(z.string()),
  }).strict(),
  runtime_entropy: z.object({
    profile_present: z.boolean(),
    controls_present: z.boolean(),
    entropy_level: RuntimeEntropyLevelSchema.nullable(),
    plasticity_level: RuntimePlasticityLevelSchema.nullable(),
    exploration_budget: z.number().min(0).max(1).nullable(),
    control_strength: z.number().min(0).max(1).nullable(),
  }).strict(),
  next_run_changes: z.array(HistoryImpactNextRunChangeSchema),
  primary_reason: z.string(),
}).strict();

export type HistoryImpactSummary = z.infer<typeof HistoryImpactSummarySchema>;

export const PlanningSummaryContractSchema = z.object({
  summary_version: z.literal("planning_summary_v1"),
  planner_explanation: z.string().nullable(),
  continuity_guidance: ContinuityGuidanceSchema.nullable().optional(),
  action_intelligence_pre_action_gate: ActionIntelligenceRuntimeGateSchema.nullable().optional(),
  runtime_entropy_profile: RuntimeEntropyProfileV1Schema.nullable().optional(),
  runtime_entropy_controls: RuntimeEntropyControlsV1Schema.nullable().optional(),
  action_retrieval_uncertainty: ActionRetrievalUncertaintySchema.nullable().optional(),
  action_retrieval_gate: ActionRetrievalGateSummarySchema.nullable().optional(),
  history_impact_summary: HistoryImpactSummarySchema,
  workflow_signal_summary: WorkflowSignalSummarySchema,
  action_packet_summary: ActionPacketSummarySchema,
  workflow_lifecycle_summary: WorkflowLifecycleSummarySchema,
  workflow_maintenance_summary: WorkflowMaintenanceSummarySchema,
  authority_visibility_summary: AuthorityVisibilitySummarySchema,
  distillation_signal_summary: DistillationSignalSummarySchema,
  pattern_lifecycle_summary: PatternLifecycleSummarySchema,
  pattern_maintenance_summary: PatternMaintenanceSummarySchema,
  policy_lifecycle_summary: PolicyLifecycleSummarySchema,
  policy_maintenance_summary: PolicyMaintenanceSummarySchema,
  continuity_carrier_summary: ContinuityCarrierSummarySchema,
  forgetting_summary: ExecutionForgettingSummarySchema,
  execution_tree_effect_summary: ExecutionTreeEffectSummarySchema.optional(),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  trusted_pattern_tools: z.array(z.string()),
  contested_pattern_tools: z.array(z.string()),
}).passthrough();

export type PlanningSummaryContract = z.infer<typeof PlanningSummaryContractSchema>;

export const AssemblySummaryContractSchema = z.object({
  summary_version: z.literal("assembly_summary_v1"),
  planner_explanation: z.string().nullable(),
  continuity_guidance: ContinuityGuidanceSchema.nullable().optional(),
  action_intelligence_pre_action_gate: ActionIntelligenceRuntimeGateSchema.nullable().optional(),
  runtime_entropy_profile: RuntimeEntropyProfileV1Schema.nullable().optional(),
  runtime_entropy_controls: RuntimeEntropyControlsV1Schema.nullable().optional(),
  action_retrieval_uncertainty: ActionRetrievalUncertaintySchema.nullable().optional(),
  action_retrieval_gate: ActionRetrievalGateSummarySchema.nullable().optional(),
  history_impact_summary: HistoryImpactSummarySchema,
  workflow_signal_summary: WorkflowSignalSummarySchema,
  action_packet_summary: ActionPacketSummarySchema,
  workflow_lifecycle_summary: WorkflowLifecycleSummarySchema,
  workflow_maintenance_summary: WorkflowMaintenanceSummarySchema,
  authority_visibility_summary: AuthorityVisibilitySummarySchema,
  distillation_signal_summary: DistillationSignalSummarySchema,
  pattern_lifecycle_summary: PatternLifecycleSummarySchema,
  pattern_maintenance_summary: PatternMaintenanceSummarySchema,
  policy_lifecycle_summary: PolicyLifecycleSummarySchema,
  policy_maintenance_summary: PolicyMaintenanceSummarySchema,
  continuity_carrier_summary: ContinuityCarrierSummarySchema,
  forgetting_summary: ExecutionForgettingSummarySchema,
  execution_tree_effect_summary: ExecutionTreeEffectSummarySchema.optional(),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  trusted_pattern_tools: z.array(z.string()),
  contested_pattern_tools: z.array(z.string()),
}).passthrough();

export type AssemblySummaryContract = z.infer<typeof AssemblySummaryContractSchema>;

export const ContextOperatorProjectionSchema = z.object({
  delegation_learning: DelegationLearningProjectionSchema.optional(),
  action_intelligence_pre_action_gate: ActionIntelligenceRuntimeGateSchema.optional(),
  runtime_entropy_profile: RuntimeEntropyProfileV1Schema.optional(),
  runtime_entropy_controls: RuntimeEntropyControlsV1Schema.optional(),
  action_retrieval_gate: ActionRetrievalGateSummarySchema.optional(),
  adaptive_guidance: AdaptiveGuidanceOverlayV1Schema.optional(),
  experience_adaptation_trace: ExecutionExperienceAdaptationTraceV1Schema.optional(),
  continuity_signal_v1: RuntimeContinuitySignalSchema.optional(),
  edit_boundary_v1: RuntimeEditBoundaryRecommendationSchema.optional(),
  action_hints: z.array(z.object({
    summary_version: z.literal("context_operator_action_hint_v1"),
    action: ActionRetrievalGateActionSchema,
    priority: z.enum(["required", "recommended"]),
    contract_trust: ContractTrustSchema,
    execution_contract_v1: ExecutionContractV1Schema.nullable().default(null),
    instruction: z.string().nullable(),
    selected_tool: z.string().nullable(),
    file_path: z.string().nullable(),
    task_family: z.string().nullable(),
    workflow_signature: z.string().nullable(),
    policy_memory_id: z.string().nullable(),
    tool_route: z.string().nullable(),
    tool_method: z.enum(["POST"]).nullable(),
    example_call: z.string().nullable(),
    preferred_rehydration_anchor_id: z.string().nullable(),
  }).passthrough()).optional(),
}).passthrough();

export type ContextOperatorProjection = z.infer<typeof ContextOperatorProjectionSchema>;

const PlannerPacketRouteContractBaseSchema = z.object({
  recall: z.object({
    aionis_memory_packet: AionisMemoryPacketSchema,
  }).passthrough(),
  planner_packet: PlannerPacketTextSurfaceSchema,
  pattern_signals: z.array(PlannerPacketEntrySchema),
  workflow_signals: z.array(PlannerPacketEntrySchema),
  execution_kernel: ExecutionKernelPacketSummarySchema,
  execution_summary: ExecutionSummaryV1Schema,
  aionis_guide_packet: AionisGuidePacketSchema,
  aionis_learning_packet: AionisLearningPacketSchema,
}).passthrough();

export const PlanningContextRouteContractSchema = PlannerPacketRouteContractBaseSchema.extend({
  planning_summary: PlanningSummaryContractSchema,
  operator_projection: ContextOperatorProjectionSchema.optional(),
});

export type PlanningContextRouteContract = z.infer<typeof PlanningContextRouteContractSchema>;

export const ContextAssembleRouteContractSchema = PlannerPacketRouteContractBaseSchema.extend({
  assembly_summary: AssemblySummaryContractSchema,
  operator_projection: ContextOperatorProjectionSchema.optional(),
});

export type ContextAssembleRouteContract = z.infer<typeof ContextAssembleRouteContractSchema>;

export const DecisionPatternSummaryContractSchema = z.object({
  used_trusted_pattern_anchor_ids: z.array(z.string()),
  used_trusted_pattern_tools: z.array(z.string()),
  used_trusted_pattern_affinity_levels: z.array(z.string()).optional(),
  skipped_contested_pattern_anchor_ids: z.array(z.string()),
  skipped_contested_pattern_tools: z.array(z.string()),
  skipped_contested_pattern_affinity_levels: z.array(z.string()).optional(),
  skipped_suppressed_pattern_anchor_ids: z.array(z.string()),
  skipped_suppressed_pattern_tools: z.array(z.string()),
  skipped_suppressed_pattern_affinity_levels: z.array(z.string()).optional(),
}).strict();

export type DecisionPatternSummaryContract = z.infer<typeof DecisionPatternSummaryContractSchema>;

export const PatternMatchAnchorContractSchema = z.object({
  node_id: z.string(),
  selected_tool: z.string().nullable().optional(),
  pattern_state: z.string().nullable().optional(),
  credibility_state: z.string().nullable().optional(),
  trust_hardening: MemoryPatternTrustHardeningSchema.nullable().optional(),
  suppressed: z.boolean().optional(),
  suppression_mode: z.string().nullable().optional(),
  suppression_reason: z.string().nullable().optional(),
  suppressed_until: z.string().nullable().optional(),
  trusted: z.boolean().optional(),
  counter_evidence_open: z.boolean().optional(),
  last_transition: z.string().nullable().optional(),
  maintenance_state: z.string().nullable().optional(),
  offline_priority: z.string().nullable().optional(),
  distinct_run_count: z.number().nullable().optional(),
  required_distinct_runs: z.number().nullable().optional(),
  similarity: z.number().nullable().optional(),
  confidence: z.number().nullable().optional(),
  task_signature: z.string().nullable().optional(),
  task_family: z.string().nullable().optional(),
  error_family: z.string().nullable().optional(),
  affinity_level: z.string().nullable().optional(),
  affinity_score: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
}).passthrough();

export type PatternMatchAnchorContract = z.infer<typeof PatternMatchAnchorContractSchema>;

export const ToolsSelectionDeniedEntryContractSchema = z.object({
  name: z.string(),
  reason: z.enum(["deny_list", "not_in_allow_list", "control_profile"]),
}).strict();

export const ToolsSelectionPolicyRelaxationContractSchema = z.object({
  applied: z.boolean(),
  reason: z.enum(["none", "allowlist_filtered_all", "deny_filtered_all"]),
  note: z.string(),
  effective_mode: z.enum(["allow_and_deny", "deny_only"]),
}).strict();

export const ToolsSelectionContractSchema = z.object({
  candidates: z.array(z.string()),
  allowed: z.array(z.string()),
  denied: z.array(ToolsSelectionDeniedEntryContractSchema),
  preferred: z.array(z.string()),
  ordered: z.array(z.string()),
  selected: z.string().nullable(),
  policy_relaxation: ToolsSelectionPolicyRelaxationContractSchema.optional(),
}).strict();

export const ToolsCandidateFamilyContractSchema = z.object({
  tool_name: z.string(),
  capability_family: z.string().nullable(),
  quality_tier: z.enum(["experimental", "supported", "preferred", "retired"]).nullable(),
  status: z.enum(["active", "disabled", "shadow_only"]).nullable(),
  replacement_for: z.array(z.string()),
  replaced_by: z.array(z.string()),
}).strict();

export const ToolsExecutionKernelContractSchema = z.object({
  control_profile_origin: z.string(),
  execution_state_v1_present: z.boolean(),
  execution_result_summary_present: z.boolean(),
  execution_artifacts_count: z.number().int().min(0),
  execution_evidence_count: z.number().int().min(0),
  current_stage: z.string().nullable(),
  active_role: z.string().nullable(),
  tool_registry_present: z.boolean(),
  family_aware_ordering_applied: z.boolean(),
  candidate_families: z.array(ToolsCandidateFamilyContractSchema),
}).strict();

export const ToolsInvalidThenSampleContractSchema = z.object({
  rule_node_id: z.string(),
  state: z.string(),
  commit_id: z.string(),
}).strict();

export const ToolsRulesContractSchema = z.object({
  considered: z.number().int().min(0),
  matched: z.number().int().min(0),
  skipped_invalid_then: z.number().int().min(0),
  invalid_then_sample: z.array(ToolsInvalidThenSampleContractSchema),
  agent_visibility_summary: z.unknown(),
  applied: z.unknown(),
  tool_conflicts_summary: z.array(z.string()),
  shadow_selection: ToolsSelectionContractSchema.optional(),
  shadow_tool_conflicts_summary: z.array(z.string()).optional(),
}).strict();

export const ToolsPatternMatchesContractSchema = z.object({
  matched: z.number().int().min(0),
  trusted: z.number().int().min(0),
  preferred_tools: z.array(z.string()),
  anchors: z.array(PatternMatchAnchorContractSchema),
}).strict();

export const ToolsDecisionContractSchema = z.object({
  decision_id: z.string(),
  decision_uri: z.string(),
  run_id: z.string().nullable(),
  selected_tool: z.string().nullable(),
  policy_sha256: z.string(),
  source_rule_ids: z.array(z.string()),
  created_at: z.string().nullable(),
  pattern_summary: DecisionPatternSummaryContractSchema,
}).strict();

export const ToolsSelectionSummaryContractSchema = z.object({
  summary_version: z.literal("tools_selection_summary_v1"),
  selected_tool: z.string().nullable(),
  candidate_count: z.number().int().min(0),
  allowed_count: z.number().int().min(0),
  denied_count: z.number().int().min(0),
  preferred_count: z.number().int().min(0),
  matched_rules: z.number().int().min(0),
  source_rule_count: z.number().int().min(0),
  trusted_pattern_count: z.number().int().min(0),
  contested_pattern_count: z.number().int().min(0),
  suppressed_pattern_count: z.number().int().min(0),
  used_trusted_pattern_tools: z.array(z.string()),
  used_trusted_pattern_affinity_levels: z.array(z.string()).optional(),
  skipped_contested_pattern_tools: z.array(z.string()),
  skipped_contested_pattern_affinity_levels: z.array(z.string()).optional(),
  skipped_suppressed_pattern_tools: z.array(z.string()),
  skipped_suppressed_pattern_affinity_levels: z.array(z.string()).optional(),
  policy_relaxation_applied: z.boolean(),
  policy_relaxation_reason: z.string().nullable(),
  provenance_explanation: z.string().nullable(),
  pattern_lifecycle_summary: PatternLifecycleSummarySchema,
  pattern_maintenance_summary: PatternMaintenanceSummarySchema,
  shadow_selected_tool: z.string().nullable(),
  tool_conflicts: z.array(z.string()),
}).strict();

export type ToolsSelectionSummaryContract = z.infer<typeof ToolsSelectionSummaryContractSchema>;

export const ToolsSelectRouteContractSchema = z.object({
  tenant_id: z.string(),
  scope: z.string(),
  candidates: z.array(z.string()),
  selection: ToolsSelectionContractSchema,
  execution_kernel: ToolsExecutionKernelContractSchema,
  rules: ToolsRulesContractSchema,
  pattern_matches: ToolsPatternMatchesContractSchema,
  decision: ToolsDecisionContractSchema,
  selection_summary: ToolsSelectionSummaryContractSchema,
}).strict();

export type ToolsSelectRouteContract = z.infer<typeof ToolsSelectRouteContractSchema>;

export const ReplayLearningProjectionResultContractSchema = z.object({
  triggered: z.boolean(),
  delivery: z.enum(["sync_inline"]),
  status: z.enum(["applied", "skipped", "failed"]),
  reason: z.string().nullable().optional(),
  generated_rule_node_id: z.string().nullable().optional(),
  generated_episode_node_id: z.string().nullable().optional(),
}).passthrough();

export type ReplayLearningProjectionResultContract = z.infer<typeof ReplayLearningProjectionResultContractSchema>;

export const ReplayRepairReviewLearningControlPolicyEffectSchema = z.object({
  source: z.enum(["default_learning_projection", "promote_memory_learning_control_review"]),
  applies: z.boolean(),
  base_target_rule_state: z.enum(["draft", "shadow"]),
  review_suggested_target_rule_state: z.enum(["draft", "shadow"]).nullable().optional(),
  effective_target_rule_state: z.enum(["draft", "shadow"]),
  reason_code: z.enum([
    "review_not_supplied",
    "review_not_admissible",
    "explicit_target_rule_state_preserved",
    "review_did_not_raise_target_rule_state",
    "high_strategic_value_workflow_promotion",
  ]),
}).passthrough();

export type ReplayRepairReviewLearningControlPolicyEffect = z.infer<typeof ReplayRepairReviewLearningControlPolicyEffectSchema>;

export const ReplayRepairReviewLearningControlDecisionTraceSchema = z.object({
  trace_version: z.literal("replay_learning_control_trace_v1"),
  review_supplied: z.boolean(),
  admissibility_evaluated: z.boolean(),
  admissible: z.boolean().nullable(),
  policy_effect_applies: z.boolean(),
  base_target_rule_state: z.enum(["draft", "shadow"]),
  effective_target_rule_state: z.enum(["draft", "shadow"]),
  runtime_apply_changed_target_rule_state: z.boolean(),
  stage_order: z.array(z.enum([
    "review_packet_built",
    "review_result_received",
    "admissibility_evaluated",
    "policy_effect_derived",
    "runtime_policy_applied",
  ])).min(2).max(5),
  reason_codes: z.array(z.string().min(1).max(128)).max(8).default([]),
}).passthrough();

export type ReplayRepairReviewLearningControlDecisionTrace = z.infer<typeof ReplayRepairReviewLearningControlDecisionTraceSchema>;

export const ReplayRepairReviewLearningControlPreviewSchema = z.object({
  promote_memory: z.object({
    review_packet: MemoryPromoteSemanticReviewPacketSchema,
    review_result: MemoryPromoteSemanticReviewResultSchema.nullable().optional(),
    admissibility: MemoryAdmissibilityResultSchema.nullable().optional(),
    policy_effect: ReplayRepairReviewLearningControlPolicyEffectSchema.nullable().optional(),
    decision_trace: ReplayRepairReviewLearningControlDecisionTraceSchema.nullable().optional(),
  }),
}).passthrough();

export type ReplayRepairReviewLearningControlPreview = z.infer<typeof ReplayRepairReviewLearningControlPreviewSchema>;

export const ReplayRepairReviewLearningControlInputSchema = z.object({
  promote_memory: z.object({
    review_result: MemoryPromoteSemanticReviewResultSchema,
  }),
}).passthrough();

export type ReplayRepairReviewLearningControlInput = z.infer<typeof ReplayRepairReviewLearningControlInputSchema>;

export const ReplayPlaybookRepairReviewResponseSchema = z.object({
  tenant_id: z.string(),
  scope: z.string(),
  playbook_id: z.string(),
  reviewed_version: z.number().int().min(1),
  to_version: z.number().int().min(1),
  action: z.enum(["approve", "reject"]),
  status: z.enum(["draft", "shadow", "active", "disabled"]),
  review_state: z.enum(["approved", "rejected"]),
  shadow_validation: z.unknown().nullable().optional(),
  auto_promotion: z.unknown().nullable().optional(),
  playbook_node_id: z.string().nullable(),
  playbook_uri: z.string().nullable(),
  commit_id: z.string().nullable(),
  commit_uri: z.string().nullable(),
  commit_hash: z.string().nullable(),
  learning_projection_result: ReplayLearningProjectionResultContractSchema.nullable().optional(),
  learning_control_preview: ReplayRepairReviewLearningControlPreviewSchema.nullable().optional(),
  policy_mutation_v1: z.object({
    mutation_version: z.literal("policy_mutation_v1"),
  }).passthrough().nullable().optional(),
  policy_mutation_adjudication_v1: z.object({
    adjudication_version: z.literal("policy_mutation_adjudication_v1"),
  }).passthrough().nullable().optional(),
}).passthrough();

export type ReplayPlaybookRepairReviewResponse = z.infer<typeof ReplayPlaybookRepairReviewResponseSchema>;

export const ToolsFeedbackPatternAnchorSchema = z.object({
  node_id: z.string().min(1).max(256),
  node_uri: z.string().min(1).max(512),
  client_id: z.string().min(1).max(256),
  pattern_signature: z.string().min(1).max(256),
  anchor_kind: z.literal("pattern"),
  anchor_level: z.literal("L3"),
  pattern_state: z.enum(["provisional", "stable"]),
  credibility_state: z.enum(["candidate", "trusted", "contested"]),
  maintenance: z.record(z.unknown()).optional(),
  promotion: z.record(z.unknown()).optional(),
  promotion_evidence_ledger_v1: PromotionEvidenceLedgerV1Schema.optional(),
}).passthrough();

export type ToolsFeedbackPatternAnchor = z.infer<typeof ToolsFeedbackPatternAnchorSchema>;

export const WorkflowWriteProjectionLearningControlDecisionTraceSchema = z.object({
  trace_version: z.literal("workflow_promotion_learning_control_trace_v1"),
  review_supplied: z.boolean(),
  admissibility_evaluated: z.boolean(),
  admissible: z.boolean().nullable(),
  policy_effect_applies: z.boolean(),
  base_promotion_state: z.enum(["candidate", "stable"]),
  effective_promotion_state: z.enum(["candidate", "stable"]),
  runtime_apply_changed_promotion_state: z.boolean(),
  stage_order: z.array(z.enum([
    "review_packet_built",
    "review_result_received",
    "admissibility_evaluated",
    "policy_effect_derived",
    "runtime_policy_applied",
  ])).min(2).max(5),
  reason_codes: z.array(z.string().min(1).max(128)).max(8).default([]),
  outcome_contract_gate: OutcomeContractGateSchema.optional(),
}).passthrough();

export type WorkflowWriteProjectionLearningControlDecisionTrace = z.infer<typeof WorkflowWriteProjectionLearningControlDecisionTraceSchema>;

export const WorkflowWriteProjectionLearningControlPolicyEffectSchema = z.object({
  source: z.enum(["default_workflow_promotion_state", "workflow_promotion_learning_control_review"]),
  applies: z.boolean(),
  base_promotion_state: z.enum(["candidate", "stable"]),
  review_suggested_promotion_state: z.enum(["candidate", "stable"]).nullable().optional(),
  effective_promotion_state: z.enum(["candidate", "stable"]),
  reason_code: z.enum([
    "review_not_supplied",
    "review_not_admissible",
    "already_stable",
    "contract_trust_below_authoritative",
    "outcome_contract_insufficient",
    "execution_evidence_insufficient",
    "review_did_not_raise_promotion_state",
    "high_confidence_workflow_promotion",
  ]),
  outcome_contract_gate: OutcomeContractGateSchema.optional(),
}).passthrough();

export type WorkflowWriteProjectionLearningControlPolicyEffect = z.infer<typeof WorkflowWriteProjectionLearningControlPolicyEffectSchema>;

export const WorkflowWriteProjectionLearningControlPreviewSchema = z.object({
  promote_memory: z.object({
    review_packet: MemoryPromoteSemanticReviewPacketSchema,
    review_result: MemoryPromoteSemanticReviewResultSchema.nullable().optional(),
    admissibility: MemoryAdmissibilityResultSchema.nullable().optional(),
    policy_effect: WorkflowWriteProjectionLearningControlPolicyEffectSchema.nullable().optional(),
    decision_trace: WorkflowWriteProjectionLearningControlDecisionTraceSchema,
  }).passthrough(),
}).passthrough();

export type WorkflowWriteProjectionLearningControlPreview = z.infer<typeof WorkflowWriteProjectionLearningControlPreviewSchema>;

export const ToolsFeedbackFormPatternLearningControlDecisionTraceSchema = z.object({
  trace_version: z.literal("form_pattern_learning_control_trace_v1"),
  review_supplied: z.boolean(),
  admissibility_evaluated: z.boolean(),
  admissible: z.boolean().nullable(),
  policy_effect_applies: z.boolean(),
  base_pattern_state: z.enum(["provisional", "stable"]),
  effective_pattern_state: z.enum(["provisional", "stable"]),
  runtime_apply_changed_pattern_state: z.boolean(),
  stage_order: z.array(z.enum([
    "review_packet_built",
    "review_result_received",
    "admissibility_evaluated",
    "policy_effect_derived",
    "runtime_policy_applied",
  ])).min(1).max(5),
  reason_codes: z.array(z.string().min(1).max(128)).max(8).default([]),
}).passthrough();

export type ToolsFeedbackFormPatternLearningControlDecisionTrace = z.infer<typeof ToolsFeedbackFormPatternLearningControlDecisionTraceSchema>;

export const ToolsFeedbackFormPatternLearningControlPolicyEffectSchema = z.object({
  source: z.enum(["default_pattern_anchor_state", "form_pattern_learning_control_review"]),
  applies: z.boolean(),
  base_pattern_state: z.enum(["provisional", "stable"]),
  review_suggested_pattern_state: z.enum(["provisional", "stable"]).nullable().optional(),
  effective_pattern_state: z.enum(["provisional", "stable"]),
  reason_code: z.enum([
    "review_not_supplied",
    "review_not_admissible",
    "already_stable",
    "review_did_not_raise_pattern_state",
    "high_confidence_pattern_stabilization",
  ]),
}).passthrough();

export type ToolsFeedbackFormPatternLearningControlPolicyEffect = z.infer<typeof ToolsFeedbackFormPatternLearningControlPolicyEffectSchema>;

export const ToolsFeedbackLearningControlPreviewSchema = z.object({
  form_pattern: z.object({
    review_packet: MemoryFormPatternSemanticReviewPacketSchema,
    review_result: MemoryFormPatternSemanticReviewResultSchema.nullable().optional(),
    admissibility: MemoryAdmissibilityResultSchema.nullable().optional(),
    policy_effect: ToolsFeedbackFormPatternLearningControlPolicyEffectSchema.nullable().optional(),
    decision_trace: ToolsFeedbackFormPatternLearningControlDecisionTraceSchema,
  }).passthrough(),
}).passthrough();

export type ToolsFeedbackLearningControlPreview = z.infer<typeof ToolsFeedbackLearningControlPreviewSchema>;

export const ToolsFeedbackLearningControlInputSchema = z.object({
  form_pattern: z.object({
    review_result: MemoryFormPatternSemanticReviewResultSchema,
  }),
}).passthrough();

export type ToolsFeedbackLearningControlInput = z.infer<typeof ToolsFeedbackLearningControlInputSchema>;

export const ToolsFeedbackResponseSchema = z.object({
  ok: z.literal(true),
  scope: z.string(),
  tenant_id: z.string(),
  updated_rules: z.number().int().min(0),
  rule_node_ids: z.array(z.string()),
  commit_id: z.string(),
  commit_uri: z.string(),
  commit_hash: z.string(),
  decision_id: z.string(),
  decision_uri: z.string(),
  decision_link_mode: z.enum(["provided", "inferred", "created_from_feedback"]),
  decision_policy_sha256: z.string(),
  pattern_anchor: ToolsFeedbackPatternAnchorSchema.nullable().optional(),
  policy_memory: PersistedPolicyMemorySchema.nullable().optional(),
  learning_control_preview: ToolsFeedbackLearningControlPreviewSchema.nullable().optional(),
}).passthrough();

export type ToolsFeedbackResponse = z.infer<typeof ToolsFeedbackResponseSchema>;

export const MemoryFindRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  // Canonical object locator: aionis://tenant/scope/type/id
  uri: z.string().min(1).optional(),
  id: UUID.optional(),
  client_id: z.string().min(1).optional(),
  type: NodeType.optional(),
  title_contains: z.string().min(1).optional(),
  text_contains: z.string().min(1).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  slots_contains: z.record(z.any()).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  include_meta: z.boolean().default(false),
  include_slots: z.boolean().default(false),
  include_slots_preview: z.boolean().default(false),
  slots_preview_keys: z.number().int().positive().max(50).default(10),
  limit: z.number().int().positive().max(200).default(20),
  offset: z.number().int().min(0).max(200000).default(0),
});

export type MemoryFindInput = z.infer<typeof MemoryFindRequest>;

export const MemoryResolveRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  uri: z.string().min(1),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  include_meta: z.boolean().default(false),
  include_slots: z.boolean().default(false),
  include_slots_preview: z.boolean().default(false),
  slots_preview_keys: z.number().int().positive().max(50).default(10),
});

export type MemoryResolveInput = z.infer<typeof MemoryResolveRequest>;

export const HandoffKind = z.enum(["patch_handoff", "review_handoff", "task_handoff"]);

export const HandoffStoreRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  memory_lane: z.enum(["private", "shared"]).default("shared"),
  producer_agent_id: z.string().min(1).optional(),
  owner_agent_id: z.string().min(1).optional(),
  owner_team_id: z.string().min(1).optional(),
  anchor: z.string().min(1),
  file_path: z.string().min(1).optional(),
  repo_root: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  handoff_kind: HandoffKind.default("patch_handoff"),
  task_family: z.string().min(1).max(256).optional(),
  task_signature: z.string().min(1).max(256).optional(),
  workflow_signature: z.string().min(1).max(256).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1),
  handoff_text: z.string().min(1),
  salience: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  risk: z.string().min(1).optional(),
  acceptance_checks: z.array(z.string().min(1)).max(50).optional(),
  tags: z.array(z.string().min(1)).max(50).optional(),
  target_files: z.array(z.string().min(1)).max(50).optional(),
  next_action: z.string().min(1).optional(),
  must_change: z.array(z.string().min(1)).max(100).optional(),
  must_remove: z.array(z.string().min(1)).max(100).optional(),
  must_keep: z.array(z.string().min(1)).max(100).optional(),
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  execution_packet_v1: ExecutionPacketV1Schema.optional(),
  control_profile_v1: ControlProfileV1Schema.optional(),
  execution_transitions_v1: z.array(ExecutionStateTransitionV1Schema).optional(),
  execution_tree_disabled: z.boolean().optional(),
  execution_tree_default_disabled: z.boolean().optional(),
  execution_tree_v1: ExecutionTreeV1Schema.optional(),
  execution_tree_operations_v1: z.array(ExecutionTreeOperationV1Schema).optional(),
  trajectory: TrajectoryCompileSourceSchema.optional(),
  trajectory_hints: TrajectoryCompileHintsSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.handoff_kind !== "task_handoff" && !value.file_path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["file_path"],
      message: "file_path is required unless handoff_kind is task_handoff",
    });
  }
});

export type HandoffStoreInput = z.infer<typeof HandoffStoreRequest>;

export const HandoffRecoverRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  handoff_id: z.string().min(1).optional(),
  handoff_uri: z.string().min(1).optional(),
  anchor: z.string().min(1).optional(),
  repo_root: z.string().min(1).optional(),
  file_path: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  handoff_kind: HandoffKind.default("patch_handoff"),
  memory_lane: z.enum(["private", "shared"]).optional(),
  include_payload: z.boolean().optional(),
  limit: z.number().int().positive().max(20).default(5),
}).superRefine((value, ctx) => {
  if (!value.anchor && !value.handoff_id && !value.handoff_uri && !value.repo_root && !value.file_path && !value.symbol) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anchor"],
      message: "anchor, handoff_id, handoff_uri, repo_root, file_path, or symbol is required",
    });
  }
});

export type HandoffRecoverInput = z.infer<typeof HandoffRecoverRequest>;

export const DelegationRecordsWriteRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  memory_lane: z.enum(["private", "shared"]).default("shared"),
  producer_agent_id: z.string().min(1).optional(),
  owner_agent_id: z.string().min(1).optional(),
  owner_team_id: z.string().min(1).optional(),
  record_id: z.string().min(1).max(128).optional(),
  run_id: z.string().min(1).max(256).optional(),
  handoff_anchor: z.string().min(1).max(512).optional(),
  handoff_uri: z.string().min(1).max(2048).optional(),
  route_role: z.string().min(1).max(128).optional(),
  task_family: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(512).optional(),
  summary: z.string().min(1).max(4000).optional(),
  input_text: z.string().min(1).optional(),
  tags: z.array(z.string().min(1).max(128)).max(50).optional(),
  delegation_records_v1: ExecutionDelegationRecordsSummarySchema,
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  execution_packet_v1: ExecutionPacketV1Schema.optional(),
});

export type DelegationRecordsWriteInput = z.infer<typeof DelegationRecordsWriteRequest>;

export const DelegationRecordsWriteResponseSchema = z.object({
  summary_version: z.literal("delegation_records_write_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  commit_id: z.string(),
  commit_uri: z.string().nullable(),
  record_event: z.object({
    node_id: z.string(),
    uri: z.string(),
    client_id: z.string(),
    record_id: z.string(),
    memory_lane: z.enum(["private", "shared"]),
    run_id: z.string().nullable(),
    handoff_anchor: z.string().nullable(),
    route_role: z.string(),
    task_family: z.string().nullable(),
    family_scope: z.string(),
    record_mode: z.enum(["memory_only", "packet_backed"]),
  }).nullable(),
  delegation_records_v1: ExecutionDelegationRecordsSummarySchema,
  execution_result_summary: z.record(z.unknown()).nullable(),
  execution_artifacts: z.array(z.record(z.unknown())),
  execution_evidence: z.array(z.record(z.unknown())),
  execution_state_v1: ExecutionStateV1Schema.nullable(),
  execution_packet_v1: ExecutionPacketV1Schema.nullable(),
});

export type DelegationRecordsWriteResponse = z.infer<typeof DelegationRecordsWriteResponseSchema>;

export const DelegationRecordsFindRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  record_id: z.string().min(1).max(128).optional(),
  run_id: z.string().min(1).max(256).optional(),
  handoff_anchor: z.string().min(1).max(512).optional(),
  handoff_uri: z.string().min(1).max(2048).optional(),
  route_role: z.string().min(1).max(128).optional(),
  task_family: z.string().min(1).max(256).optional(),
  family_scope: z.string().min(1).max(512).optional(),
  record_mode: z.enum(["memory_only", "packet_backed"]).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  include_payload: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().min(0).max(200000).default(0),
});

export type DelegationRecordsFindInput = z.infer<typeof DelegationRecordsFindRequest>;

export const DelegationRecordSideOutputSummarySchema = z.object({
  result_present: z.boolean(),
  artifact_count: z.number().int().min(0),
  evidence_count: z.number().int().min(0),
  execution_state_v1_present: z.boolean(),
  execution_packet_v1_present: z.boolean(),
});

export const DelegationRecordFindEntrySchema = z.object({
  uri: z.string(),
  node_id: z.string(),
  client_id: z.string().nullable(),
  record_id: z.string().nullable(),
  title: z.string().nullable(),
  text_summary: z.string().nullable(),
  memory_lane: z.enum(["private", "shared"]),
  producer_agent_id: z.string().nullable(),
  owner_agent_id: z.string().nullable(),
  owner_team_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  commit_id: z.string().nullable(),
  run_id: z.string().nullable(),
  handoff_anchor: z.string().nullable(),
  handoff_uri: z.string().nullable(),
  route_role: z.string(),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  record_mode: z.enum(["memory_only", "packet_backed"]),
  tags: z.array(z.string()),
  delegation_records_v1: ExecutionDelegationRecordsSummarySchema,
  execution_side_outputs: DelegationRecordSideOutputSummarySchema,
  execution_result_summary: z.record(z.unknown()).nullable().optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: z.record(z.unknown()).nullable().optional(),
  execution_packet_v1: z.record(z.unknown()).nullable().optional(),
}).passthrough();

export type DelegationRecordFindEntry = z.infer<typeof DelegationRecordFindEntrySchema>;

export const DelegationRecordsFindSummarySchema = z.object({
  summary_version: z.literal("delegation_records_find_summary_v1"),
  returned_records: z.number().int().min(0),
  has_more: z.boolean(),
  invalid_records: z.number().int().min(0),
  filters_applied: z.array(z.string()),
  record_mode_counts: z.record(z.number().int().min(0)),
  memory_lane_counts: z.record(z.number().int().min(0)),
  route_role_counts: z.record(z.number().int().min(0)),
  task_family_counts: z.record(z.number().int().min(0)),
  missing_record_type_counts: z.record(z.number().int().min(0)),
  return_status_counts: z.record(z.number().int().min(0)),
  artifact_source_counts: z.record(z.number().int().min(0)),
  packet_count: z.number().int().min(0),
  return_count: z.number().int().min(0),
  artifact_routing_count: z.number().int().min(0),
  run_id_count: z.number().int().min(0),
  handoff_anchor_count: z.number().int().min(0),
});

export type DelegationRecordsFindSummary = z.infer<typeof DelegationRecordsFindSummarySchema>;

export const DelegationRecordsFindResponseSchema = z.object({
  summary_version: z.literal("delegation_records_find_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  records: z.array(DelegationRecordFindEntrySchema),
  summary: DelegationRecordsFindSummarySchema,
});

export type DelegationRecordsFindResponse = z.infer<typeof DelegationRecordsFindResponseSchema>;

export const DelegationRecordsAggregateRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  record_id: z.string().min(1).max(128).optional(),
  run_id: z.string().min(1).max(256).optional(),
  handoff_anchor: z.string().min(1).max(512).optional(),
  handoff_uri: z.string().min(1).max(2048).optional(),
  route_role: z.string().min(1).max(128).optional(),
  task_family: z.string().min(1).max(256).optional(),
  family_scope: z.string().min(1).max(512).optional(),
  record_mode: z.enum(["memory_only", "packet_backed"]).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(100),
});

export type DelegationRecordsAggregateInput = z.infer<typeof DelegationRecordsAggregateRequest>;

const DelegationRecordsAggregateBucketSchema = z.object({
  key: z.string(),
  record_count: z.number().int().min(0),
  packet_count: z.number().int().min(0),
  return_count: z.number().int().min(0),
  artifact_routing_count: z.number().int().min(0),
  record_mode_counts: z.record(z.number().int().min(0)),
  task_family_counts: z.record(z.number().int().min(0)).optional(),
  route_role_counts: z.record(z.number().int().min(0)).optional(),
  return_status_counts: z.record(z.number().int().min(0)),
  artifact_source_counts: z.record(z.number().int().min(0)),
}).passthrough();

export const DelegationRecordsAggregateRefStatSchema = z.object({
  ref: z.string(),
  ref_kind: z.enum(["artifact", "evidence"]),
  count: z.number().int().min(0),
  source_counts: z.record(z.number().int().min(0)),
}).passthrough();

export const DelegationRecordsAggregateStringStatSchema = z.object({
  value: z.string(),
  count: z.number().int().min(0),
}).passthrough();

export const DelegationRecordsReusablePatternSchema = z.object({
  route_role: z.string(),
  task_family: z.string(),
  record_count: z.number().int().min(0),
  record_mode_counts: z.record(z.number().int().min(0)),
  record_outcome_counts: z.record(z.number().int().min(0)),
  sample_mission: z.string().nullable(),
  sample_acceptance_checks: z.array(z.string()),
  sample_working_set_files: z.array(z.string()),
  sample_artifact_refs: z.array(z.string()),
}).passthrough();

export const DelegationRecordsLearningRecommendationSchema = z.object({
  recommendation_kind: z.enum([
    "capture_missing_returns",
    "review_blocked_pattern",
    "increase_artifact_capture",
    "promote_reusable_pattern",
  ]),
  priority: z.enum(["high", "medium", "low"]),
  route_role: z.string().nullable(),
  task_family: z.string().nullable(),
  recommended_action: z.string(),
  rationale: z.string(),
  sample_mission: z.string().nullable(),
  sample_acceptance_checks: z.array(z.string()),
  sample_working_set_files: z.array(z.string()),
  sample_artifact_refs: z.array(z.string()),
}).passthrough();

export type DelegationRecordsLearningRecommendation = z.infer<typeof DelegationRecordsLearningRecommendationSchema>;

export const DelegationRecordsAggregateSummarySchema = z.object({
  summary_version: z.literal("delegation_records_aggregate_summary_v1"),
  matched_records: z.number().int().min(0),
  truncated: z.boolean(),
  invalid_records: z.number().int().min(0),
  filters_applied: z.array(z.string()),
  record_mode_counts: z.record(z.number().int().min(0)),
  memory_lane_counts: z.record(z.number().int().min(0)),
  route_role_counts: z.record(z.number().int().min(0)),
  task_family_counts: z.record(z.number().int().min(0)),
  missing_record_type_counts: z.record(z.number().int().min(0)),
  return_status_counts: z.record(z.number().int().min(0)),
  normalized_return_status_counts: z.record(z.number().int().min(0)),
  record_outcome_counts: z.record(z.number().int().min(0)),
  artifact_source_counts: z.record(z.number().int().min(0)),
  packet_count: z.number().int().min(0),
  return_count: z.number().int().min(0),
  artifact_routing_count: z.number().int().min(0),
  run_id_count: z.number().int().min(0),
  handoff_anchor_count: z.number().int().min(0),
  records_with_returns: z.number().int().min(0),
  records_with_missing_types: z.number().int().min(0),
  records_with_payload_result: z.number().int().min(0),
  records_with_payload_artifacts: z.number().int().min(0),
  records_with_payload_evidence: z.number().int().min(0),
  records_with_payload_state: z.number().int().min(0),
  records_with_payload_packet: z.number().int().min(0),
  completion_rate: z.number().min(0).max(1),
  blocked_rate: z.number().min(0).max(1),
  missing_return_rate: z.number().min(0).max(1),
  route_role_buckets: z.array(DelegationRecordsAggregateBucketSchema),
  task_family_buckets: z.array(DelegationRecordsAggregateBucketSchema),
  top_reusable_patterns: z.array(DelegationRecordsReusablePatternSchema),
  learning_recommendations: z.array(DelegationRecordsLearningRecommendationSchema),
  top_artifact_refs: z.array(DelegationRecordsAggregateRefStatSchema),
  top_acceptance_checks: z.array(DelegationRecordsAggregateStringStatSchema),
  top_working_set_files: z.array(DelegationRecordsAggregateStringStatSchema),
});

export type DelegationRecordsAggregateSummary = z.infer<typeof DelegationRecordsAggregateSummarySchema>;

export const DelegationRecordsAggregateResponseSchema = z.object({
  summary_version: z.literal("delegation_records_aggregate_v1"),
  tenant_id: z.string(),
  scope: z.string(),
  summary: DelegationRecordsAggregateSummarySchema,
});

export type DelegationRecordsAggregateResponse = z.infer<typeof DelegationRecordsAggregateResponseSchema>;

export const ContinuityReviewPackRequest = HandoffRecoverRequest;

export type ContinuityReviewPackInput = z.infer<typeof ContinuityReviewPackRequest>;

export const MemorySessionCreateRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  session_id: z.string().min(1).max(128),
  title: z.string().min(1).max(512).optional(),
  text_summary: z.string().min(1).max(4000).optional(),
  input_text: z.string().min(1).optional(),
  metadata: z.record(z.any()).optional(),
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  execution_packet_v1: ExecutionPacketV1Schema.optional(),
  execution_transitions_v1: z.array(ExecutionStateTransitionV1Schema).optional(),
  auto_embed: z.boolean().optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().min(1).optional(),
  owner_agent_id: z.string().min(1).optional(),
  owner_team_id: z.string().min(1).optional(),
});

export type MemorySessionCreateInput = z.infer<typeof MemorySessionCreateRequest>;

export const MemorySessionsListRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  owner_agent_id: z.string().min(1).optional(),
  owner_team_id: z.string().min(1).optional(),
  include_meta: QueryBoolean.default(false),
  limit: z.coerce.number().int().positive().max(200).default(20),
  offset: z.coerce.number().int().min(0).max(200000).default(0),
});

export type MemorySessionsListInput = z.infer<typeof MemorySessionsListRequest>;

export const MemoryArchiveRehydrateRequest = z
  .object({
    tenant_id: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    consumer_team_id: z.string().min(1).optional(),
    node_ids: z.array(UUID).min(1).max(200).optional(),
    client_ids: z.array(z.string().min(1)).min(1).max(200).optional(),
    target_tier: z.enum(["warm", "hot"]).default("warm"),
    reason: z.string().min(1).optional(),
    input_text: z.string().min(1).optional(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .refine((v) => (v.node_ids?.length ?? 0) > 0 || (v.client_ids?.length ?? 0) > 0, {
    message: "must set node_ids or client_ids",
  })
  .refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export type MemoryArchiveRehydrateInput = z.infer<typeof MemoryArchiveRehydrateRequest>;

export const MemoryNodesActivateRequest = z
  .object({
    tenant_id: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    consumer_team_id: z.string().min(1).optional(),
    node_ids: z.array(UUID).min(1).max(200).optional(),
    client_ids: z.array(z.string().min(1)).min(1).max(200).optional(),
    run_id: z.string().min(1).optional(),
    outcome: z.enum(["positive", "negative", "neutral"]).default("neutral"),
    activate: z.boolean().default(true),
    reason: z.string().min(1).optional(),
    input_text: z.string().min(1).optional(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    used_surface: z.enum(["use_now", "inspect_before_use", "do_not_use", "explicit_host_assertion"]).optional(),
    verifier_status: z.enum(["passed", "failed", "not_run", "unknown"]).optional(),
    tool_status: z.enum(["succeeded", "failed", "not_run", "unknown"]).optional(),
    runtime_signal_refs: z.array(z.string().min(1)).max(32).optional(),
  })
  .refine((v) => (v.node_ids?.length ?? 0) > 0 || (v.client_ids?.length ?? 0) > 0, {
    message: "must set node_ids or client_ids",
  })
  .refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export type MemoryNodesActivateInput = z.infer<typeof MemoryNodesActivateRequest>;
export type RuleFeedbackInput = z.infer<typeof RuleFeedbackRequest>;
export type RuleStateUpdateInput = z.infer<typeof RuleStateUpdateRequest>;

export const RuleFeedbackRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  rule_node_id: UUID,
  run_id: z.string().min(1).optional(),
  outcome: z.enum(["positive", "negative", "neutral"]),
  note: z.string().min(1).optional(),
  input_text: z.string().min(1).optional(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export const RuleStateUpdateRequest = z
  .object({
    tenant_id: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    rule_node_id: UUID,
    state: z.enum(["draft", "shadow", "active", "disabled"]),
    input_text: z.string().min(1).optional(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export const RulesEvaluateRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  // Arbitrary execution context from the caller (planner/tool selector), used to match rule conditions.
  context: z.any(),
  // By default, both ACTIVE and SHADOW rules are returned (separately).
  include_shadow: z.boolean().default(true),
  // Hard cap: don't scan/return unbounded rules.
  limit: z.number().int().positive().max(200).default(50),
});

export type RulesEvaluateInput = z.infer<typeof RulesEvaluateRequest>;

export const ToolsSelectRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  // Optional execution run correlation id for provenance.
  run_id: z.string().min(1).optional(),
  context: z.any(),
  execution_result_summary: z.record(z.unknown()).optional(),
  execution_artifacts: z.array(z.record(z.unknown())).optional(),
  execution_evidence: z.array(z.record(z.unknown())).optional(),
  execution_state_v1: ExecutionStateV1Schema.optional(),
  // Tool names provided by the caller's execution environment.
  candidates: z.array(z.string().min(1)).min(1).max(200),
  // Include SHADOW rules as a non-enforcing preview channel.
  include_shadow: z.boolean().default(false),
  // Hard cap: don't scan unbounded rules.
  rules_limit: z.number().int().positive().max(200).default(50),
  // If true and allow/deny filters eliminate all candidates, return 400 instead of relaxing policy.
  strict: z.boolean().default(true),
  // Experimental: if true, Aionis may reorder candidates before final selection.
  reorder_candidates: z.boolean().default(false),
});

export type ToolsSelectInput = z.input<typeof ToolsSelectRequest>;

export const ToolsDecisionRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  decision_id: UUID.optional(),
  decision_uri: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
}).refine((v) => !!v.decision_id || !!v.decision_uri || !!v.run_id, {
  message: "must set decision_id, decision_uri, or run_id",
});

export type ToolsDecisionInput = z.infer<typeof ToolsDecisionRequest>;

export const ToolsRunRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  run_id: z.string().min(1),
  decision_limit: z.number().int().positive().max(200).default(10),
  include_feedback: z.boolean().default(true),
  feedback_limit: z.number().int().positive().max(200).default(50),
});

export type ToolsRunInput = z.infer<typeof ToolsRunRequest>;

export const ToolsRunsListRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(20),
});

export type ToolsRunsListInput = z.infer<typeof ToolsRunsListRequest>;

export const ToolsFeedbackRequest = z
  .object({
    tenant_id: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    // Optional direct link to the persisted tools/select decision record.
    decision_id: UUID.optional(),
    decision_uri: z.string().min(1).optional(),
    // Feedback for the tool selection decision.
    outcome: z.enum(["positive", "negative", "neutral"]),
    // Same execution context used for tool selection.
    context: z.any(),
    // Candidate tools shown to the selector.
    candidates: z.array(z.string().min(1)).min(1).max(200),
    // The tool that was actually used (selected/executed) by the caller.
    selected_tool: z.string().min(1),
    // Whether to include SHADOW rules for attribution; by default feedback applies to ACTIVE tool rules only.
    include_shadow: z.boolean().default(false),
    rules_limit: z.number().int().positive().max(200).default(50),
    // Attribution target:
    // - tool: only rules that touched tool.* paths
    // - all: all applied rules (rare; use with care)
    target: z.enum(["tool", "all"]).default("tool"),
    note: z.string().min(1).optional(),
    input_text: z.string().min(1).optional(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    learning_control_review: ToolsFeedbackLearningControlInputSchema.optional(),
  })
  .refine((v) => !!v.input_text || !!v.input_sha256, { message: "must set input_text or input_sha256" });

export type ToolsFeedbackInput = z.infer<typeof ToolsFeedbackRequest>;

export const PatternOperatorOverrideSchema = z.object({
  schema_version: z.literal("operator_override_v1"),
  suppressed: z.boolean(),
  reason: z.string().nullable(),
  mode: PatternOperatorOverrideMode,
  until: z.string().nullable(),
  updated_at: z.string(),
  updated_by: z.string().nullable(),
  last_action: z.enum(["suppress", "unsuppress"]),
});

export type PatternOperatorOverride = z.infer<typeof PatternOperatorOverrideSchema>;

export const PatternSuppressRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  anchor_id: UUID,
  reason: z.string().min(1),
  until: z.string().datetime().optional(),
  mode: PatternOperatorOverrideMode.default("shadow_learn"),
});

export type PatternSuppressInput = z.infer<typeof PatternSuppressRequest>;

export const PatternUnsuppressRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  anchor_id: UUID,
  reason: z.string().min(1).optional(),
});

export type PatternUnsuppressInput = z.infer<typeof PatternUnsuppressRequest>;

export const AnchorSuppressRequest = PatternSuppressRequest;
export type AnchorSuppressInput = z.infer<typeof AnchorSuppressRequest>;

export const AnchorUnsuppressRequest = PatternUnsuppressRequest;
export type AnchorUnsuppressInput = z.infer<typeof AnchorUnsuppressRequest>;

export const PatternSuppressResponseSchema = z.object({
  tenant_id: z.string(),
  scope: z.string(),
  anchor_id: z.string(),
  anchor_uri: z.string(),
  selected_tool: z.string().nullable(),
  pattern_state: z.string().nullable(),
  credibility_state: z.string().nullable(),
  operator_override: PatternOperatorOverrideSchema,
});

export type PatternSuppressResponse = z.infer<typeof PatternSuppressResponseSchema>;

export const AnchorSuppressResponseSchema = z.object({
  tenant_id: z.string(),
  scope: z.string(),
  anchor_id: z.string(),
  anchor_uri: z.string(),
  anchor_kind: z.string().nullable(),
  node_type: z.string(),
  selected_tool: z.string().nullable(),
  pattern_state: z.string().nullable(),
  credibility_state: z.string().nullable(),
  operator_override: PatternOperatorOverrideSchema,
});

export type AnchorSuppressResponse = z.infer<typeof AnchorSuppressResponseSchema>;

export const ReplaySafetyLevel = z.enum(["auto_ok", "needs_confirm", "manual_only"]);
export type ReplaySafetyLevelInput = z.infer<typeof ReplaySafetyLevel>;

export const ReplayRunStatus = z.enum(["success", "failed", "partial"]);
export type ReplayRunStatusInput = z.infer<typeof ReplayRunStatus>;
export const ReplayPlaybookStatus = z.enum(["draft", "shadow", "active", "disabled"]);
export type ReplayPlaybookStatusInput = z.infer<typeof ReplayPlaybookStatus>;
export const ReplayRunMode = z.enum(["strict", "guided", "simulate"]);
export type ReplayRunModeInput = z.infer<typeof ReplayRunMode>;

const ReplayCondition = z.record(z.any());
const ReplayConsumerIdentityFields = {
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
} as const;
const ReplayWriteIdentityFields = {
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().min(1).optional(),
  owner_agent_id: z.string().min(1).optional(),
  owner_team_id: z.string().min(1).optional(),
} as const;

export const ReplayRunStartRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  run_id: UUID.optional(),
  goal: z.string().min(1),
  context_snapshot_ref: z.string().min(1).optional(),
  context_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  metadata: z.record(z.any()).optional(),
});

export type ReplayRunStartInput = z.infer<typeof ReplayRunStartRequest>;

export const ReplayStepBeforeRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  run_id: UUID,
  step_id: UUID.optional(),
  decision_id: UUID.optional(),
  step_index: z.number().int().positive(),
  tool_name: z.string().min(1),
  tool_input: z.any(),
  expected_output_signature: z.any().optional(),
  preconditions: z.array(ReplayCondition).max(200).default([]),
  retry_policy: z.record(z.any()).optional(),
  safety_level: ReplaySafetyLevel.default("needs_confirm"),
  metadata: z.record(z.any()).optional(),
});

export type ReplayStepBeforeInput = z.infer<typeof ReplayStepBeforeRequest>;

export const ReplayStepAfterRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  run_id: UUID,
  step_id: UUID.optional(),
  step_index: z.number().int().positive().optional(),
  status: z.enum(["success", "failed", "skipped", "partial"]),
  output_signature: z.any().optional(),
  postconditions: z.array(ReplayCondition).max(200).default([]),
  artifact_refs: z.array(z.string().min(1)).max(200).default([]),
  repair_applied: z.boolean().default(false),
  repair_note: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  metadata: z.record(z.any()).optional(),
});

export type ReplayStepAfterInput = z.infer<typeof ReplayStepAfterRequest>;

export const ReplayRunEndRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  run_id: UUID,
  status: ReplayRunStatus,
  summary: z.string().min(1).optional(),
  success_criteria: z.record(z.any()).optional(),
  metrics: z.record(z.any()).optional(),
  metadata: z.record(z.any()).optional(),
});

export type ReplayRunEndInput = z.infer<typeof ReplayRunEndRequest>;

export const ReplayRunGetRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  run_id: UUID,
  include_steps: z.boolean().default(true),
  include_artifacts: z.boolean().default(true),
});

export type ReplayRunGetInput = z.infer<typeof ReplayRunGetRequest>;

export const ReplayPlaybookCompileRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  run_id: UUID,
  playbook_id: UUID.optional(),
  name: z.string().min(1).optional(),
  version: z.number().int().positive().default(1),
  matchers: z.record(z.any()).optional(),
  success_criteria: z.record(z.any()).optional(),
  risk_profile: z.enum(["low", "medium", "high"]).default("medium"),
  allow_partial: z.boolean().default(false),
  metadata: z.record(z.any()).optional(),
});

export type ReplayPlaybookCompileInput = z.infer<typeof ReplayPlaybookCompileRequest>;

export const ReplayPlaybookGetRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  playbook_id: UUID,
});

export type ReplayPlaybookGetInput = z.infer<typeof ReplayPlaybookGetRequest>;

export const ReplayPlaybookCandidateRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  playbook_id: UUID,
  version: z.number().int().positive().optional(),
  deterministic_gate: z.object({
    enabled: z.boolean().default(true),
    prefer_deterministic_execution: z.boolean().default(true),
    on_mismatch: z.enum(["candidate_only", "reject"]).default("candidate_only"),
    required_statuses: z.array(ReplayPlaybookStatus).min(1).max(4).default(["shadow", "active"]),
    matchers: z.record(z.any()).optional(),
    policy_constraints: z.record(z.any()).optional(),
  }).optional(),
});

export type ReplayPlaybookCandidateInput = z.infer<typeof ReplayPlaybookCandidateRequest>;

export const ReplayPlaybookPromoteRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  playbook_id: UUID,
  from_version: z.number().int().positive().optional(),
  target_status: ReplayPlaybookStatus,
  note: z.string().min(1).max(1000).optional(),
  metadata: z.record(z.any()).optional(),
});

export type ReplayPlaybookPromoteInput = z.infer<typeof ReplayPlaybookPromoteRequest>;

export const ReplayPlaybookRunRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  project_id: z.string().min(1).max(128).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  playbook_id: UUID,
  mode: ReplayRunMode.default("simulate"),
  version: z.number().int().positive().optional(),
  deterministic_gate: z.object({
    enabled: z.boolean().default(true),
    prefer_deterministic_execution: z.boolean().default(true),
    on_mismatch: z.enum(["candidate_only", "reject"]).default("candidate_only"),
    required_statuses: z.array(ReplayPlaybookStatus).min(1).max(4).default(["shadow", "active"]),
    matchers: z.record(z.any()).optional(),
    policy_constraints: z.record(z.any()).optional(),
  }).optional(),
  params: z.record(z.any()).optional(),
  max_steps: z.number().int().positive().max(500).default(200),
});

export type ReplayPlaybookRunInput = z.infer<typeof ReplayPlaybookRunRequest>;

export const ReplayPlaybookDispatchRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  project_id: z.string().min(1).max(128).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  playbook_id: UUID,
  version: z.number().int().positive().optional(),
  deterministic_gate: z.object({
    enabled: z.boolean().default(true),
    prefer_deterministic_execution: z.boolean().default(true),
    on_mismatch: z.enum(["candidate_only", "reject"]).default("candidate_only"),
    required_statuses: z.array(ReplayPlaybookStatus).min(1).max(4).default(["shadow", "active"]),
    matchers: z.record(z.any()).optional(),
    policy_constraints: z.record(z.any()).optional(),
  }).optional(),
  params: z.record(z.any()).optional(),
  max_steps: z.number().int().positive().max(500).default(200),
});

export type ReplayPlaybookDispatchInput = z.infer<typeof ReplayPlaybookDispatchRequest>;

export const ReplayPlaybookRepairRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  playbook_id: UUID,
  from_version: z.number().int().positive().optional(),
  patch: z.record(z.any()),
  note: z.string().min(1).max(1000).optional(),
  review_required: z.boolean().default(true),
  target_status: ReplayPlaybookStatus.default("draft"),
  metadata: z.record(z.any()).optional(),
});

export type ReplayPlaybookRepairInput = z.infer<typeof ReplayPlaybookRepairRequest>;

export const ReplayLearningProjectionRequest = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["rule_and_episode", "episode_only"]).optional(),
  delivery: z.enum(["sync_inline"]).optional(),
  target_rule_state: z.enum(["draft", "shadow"]).optional(),
  min_total_steps: z.number().int().min(0).max(500).optional(),
  min_success_ratio: z.number().min(0).max(1).optional(),
});

export type ReplayLearningProjectionInput = z.infer<typeof ReplayLearningProjectionRequest>;

export const ReplayPlaybookRepairReviewRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  ...ReplayConsumerIdentityFields,
  ...ReplayWriteIdentityFields,
  playbook_id: UUID,
  version: z.number().int().positive().optional(),
  action: z.enum(["approve", "reject"]),
  note: z.string().min(1).max(1000).optional(),
  auto_shadow_validate: z.boolean().default(true),
  shadow_validation_mode: z.enum(["readiness", "execute", "execute_sandbox"]).default("readiness"),
  shadow_validation_max_steps: z.number().int().positive().max(500).default(200),
  shadow_validation_params: z.record(z.any()).optional(),
  target_status_on_approve: ReplayPlaybookStatus.default("shadow"),
  auto_promote_on_pass: z.boolean().default(false),
  auto_promote_target_status: ReplayPlaybookStatus.default("active"),
  auto_promote_gate: z
    .object({
      require_shadow_pass: z.boolean().default(true),
      min_total_steps: z.number().int().min(0).max(500).default(0),
      max_failed_steps: z.number().int().min(0).max(500).default(0),
      max_blocked_steps: z.number().int().min(0).max(500).default(0),
      max_unknown_steps: z.number().int().min(0).max(500).default(0),
      min_success_ratio: z.number().min(0).max(1).default(1),
    })
    .default({}),
  learning_projection: ReplayLearningProjectionRequest.optional(),
  learning_control_review: ReplayRepairReviewLearningControlInputSchema.optional(),
  metadata: z.record(z.any()).optional(),
});

export type ReplayPlaybookRepairReviewInput = z.infer<typeof ReplayPlaybookRepairReviewRequest>;

export const SandboxSessionCreateRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  profile: z.enum(["default", "restricted"]).default("default"),
  ttl_seconds: z.number().int().positive().max(7 * 24 * 3600).optional(),
  metadata: z.record(z.any()).optional(),
});

export type SandboxSessionCreateInput = z.infer<typeof SandboxSessionCreateRequest>;

const SandboxCommandAction = z.object({
  kind: z.literal("command"),
  argv: z.array(z.string().min(1)).min(1).max(64),
});

export const SandboxExecuteRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  project_id: z.string().min(1).max(128).optional(),
  actor: z.string().min(1).optional(),
  session_id: UUID,
  planner_run_id: z.string().min(1).optional(),
  decision_id: UUID.optional(),
  mode: z.enum(["async", "sync"]).default("async"),
  timeout_ms: z.number().int().positive().max(600000).optional(),
  action: SandboxCommandAction,
  metadata: z.record(z.any()).optional(),
});

export type SandboxExecuteInput = z.infer<typeof SandboxExecuteRequest>;

export const SandboxRunGetRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  run_id: UUID,
});

export type SandboxRunGetInput = z.infer<typeof SandboxRunGetRequest>;

export const SandboxRunLogsRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  run_id: UUID,
  tail_bytes: z.number().int().positive().max(512000).default(65536),
});

export type SandboxRunLogsInput = z.infer<typeof SandboxRunLogsRequest>;

export const SandboxRunArtifactRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  run_id: UUID,
  tail_bytes: z.number().int().positive().max(512000).default(65536),
  include_action: z.boolean().default(true),
  include_output: z.boolean().default(true),
  include_result: z.boolean().default(true),
  include_metadata: z.boolean().default(true),
  bundle_inline: z.boolean().default(true),
});

export type SandboxRunArtifactInput = z.infer<typeof SandboxRunArtifactRequest>;

export const SandboxRunCancelRequest = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  run_id: UUID,
  reason: z.string().min(1).max(400).optional(),
});

export type SandboxRunCancelInput = z.infer<typeof SandboxRunCancelRequest>;
