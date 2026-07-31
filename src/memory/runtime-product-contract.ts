import { z } from "zod";

import {
  CurrentExecutionStateRenderV1Schema,
  CurrentExecutionStateV2Schema,
} from "../execution/types.js";

import {
  AionisGuidanceAuthoritySchema,
  AionisMemoryDecisionSurfaceSchema,
} from "./governance-contract.js";

export const AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD =
  "stable_promotion" + "_blocked_count";

export {
  AionisGuidanceAuthoritySchema,
  AionisMemoryDecisionSurfaceSchema,
  type AionisGuidanceAuthority,
  type AionisMemoryDecisionSurface,
} from "./governance-contract.js";

const ConfidenceSchema = z.number().min(0).max(1);

export const AionisRiskLevelSchema = z.enum(["low", "medium", "high"]);

export type AionisRiskLevel = z.infer<typeof AionisRiskLevelSchema>;

export const AionisAgentRoleSchema = z.enum(["agent", "planner", "worker", "verifier", "reviewer"]);

export type AionisAgentRole = z.infer<typeof AionisAgentRoleSchema>;

export const AionisExecutionTransitionKindSchema = z.enum([
  "resume_current_state",
  "handoff_to_actor",
  "accept_handoff",
  "inspect_before_use",
  "avoid_failed_branch",
  "request_rehydrate",
]);


export const AionisMemoryDomainSchema = z.enum(["general", "execution"]);

export type AionisMemoryDomain = z.infer<typeof AionisMemoryDomainSchema>;

export const AionisMemoryFamilySchema = z.enum(["general_cognitive", "execution", "mixed", "empty"]);

export const AionisRecallSourceKindSchema = z.enum([
  "semantic",
  "lexical",
  "structured",
  "execution_native",
  "graph",
  "associative_shadow",
  "recent",
  "exact_recovery",
  "ann",
  "substrate",
]);

export const AionisRecallSourceTraceSchema = z
  .object({
    kind: AionisRecallSourceKindSchema,
    score: ConfidenceSchema.optional(),
    reason: z.string().min(1),
    matched_fields: z.array(z.string().min(1)).default([]),
    index_name: z.string().min(1).optional(),
  })
  .strict();

export type AionisRecallSourceTrace = z.infer<typeof AionisRecallSourceTraceSchema>;

const AionisMemoryLayerSchema = z.enum(["L0", "L1", "L2", "L3", "L4", "L5"]);

const AionisMemoryContractSchema = z
  .object({
    source_trust: z.enum([
      "authoritative_runtime",
      "scoped_advisory",
      "external_or_unverified",
      "blocked_or_suppressed",
    ]),
    allowed_scope: z.enum([
      "current_scope",
      "task_or_workflow_scope",
      "supporting_evidence_only",
      "none",
    ]),
    evidence_requirement: z.enum([
      "satisfied",
      "node_evidence_only",
      "requires_more_evidence",
    ]),
    use_policy: z.enum([
      "direct_use",
      "inspect_before_use",
      "do_not_use",
      "evidence_only",
    ]),
    confirmation_required: z.boolean(),
    reasons: z.array(z.string().min(1)).default([]),
  })
  .strict();

function defaultAionisMemoryContract(): z.infer<typeof AionisMemoryContractSchema> {
  return {
    source_trust: "scoped_advisory",
    allowed_scope: "current_scope",
    evidence_requirement: "node_evidence_only",
    use_policy: "direct_use",
    confirmation_required: false,
    reasons: ["memory_contract_missing_projection_defaulted_to_existing_authority"],
  };
}

const AionisMemoryLifecycleRelationKindSchema = z.enum(["supersedes", "contradicts", "invalidates"]);

const AionisMemoryLifecycleRelationSignalsSchema = z
  .object({
    source_cues: z.array(z.string().min(1)).default([]),
    prior_cues: z.array(z.string().min(1)).default([]),
    topic_overlap: z.number().nonnegative(),
    shared_target_paths: z.number().nonnegative(),
    target_path_conflict: z.boolean(),
    same_domain: z.boolean(),
    source_newer: z.boolean(),
  })
  .strict();

const AionisMemoryLifecycleRelationGateSchema = z
  .object({
    source_admissible: z.boolean(),
    target_admissible: z.boolean(),
    source_newer: z.boolean(),
    candidate_confidence_passed: z.boolean().nullable(),
    relation_supported: z.boolean(),
    confidence_threshold_passed: z.boolean(),
    accepted: z.boolean(),
  })
  .strict();

const AionisMemoryLifecycleRelationEvidenceSchema = z
  .object({
    source_memory_id: z.string().min(1),
    target_memory_id: z.string().min(1),
    lifecycle_relation: AionisMemoryLifecycleRelationKindSchema,
    confidence: ConfidenceSchema,
    producer: z.string().min(1),
    candidate_confidence: ConfidenceSchema.nullable(),
    signals: AionisMemoryLifecycleRelationSignalsSchema,
    gate: AionisMemoryLifecycleRelationGateSchema,
    reasons: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const AionisMemoryPacketSchema = z
  .object({
    contract_version: z.literal("aionis_memory_packet_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    actor: z
      .object({
        consumer_agent_id: z.string().min(1).nullable().optional(),
        consumer_team_id: z.string().min(1).nullable().optional(),
        producer_agent_ids: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    query: z
      .object({
        source: z.enum(["embedding", "text", "unknown"]),
        intent: z.string().min(1).nullable().optional(),
        embedding_dims: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    memory_family: AionisMemoryFamilySchema,
    relevant_memories: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            title: z.string().min(1).nullable(),
            summary: z.string().min(1),
            memory_type: z.enum([
              "fact",
              "preference",
              "project_context",
              "procedure",
              "event",
              "evidence",
              "rule",
              "execution_memory",
              "unknown",
            ]),
            domain: AionisMemoryDomainSchema,
            source_layer: AionisMemoryLayerSchema.nullable(),
            authority: AionisGuidanceAuthoritySchema,
            confidence: ConfidenceSchema,
            salience: ConfidenceSchema,
            lifecycle_state: z.enum([
              "active",
              "candidate",
              "contested",
              "suppressed",
              "demoted",
              "archived",
              "rehydration_candidate",
              "unknown",
            ]),
            evidence_ids: z.array(z.string().min(1)).default([]),
            observed_at: z.string().min(1).nullable().default(null),
            target_files: z.array(z.string().min(1)).default([]),
            recall_sources: z.array(AionisRecallSourceTraceSchema).default([]),
            scope_hint: z.string().min(1).nullable().optional(),
            execution_state: z
              .object({
                summary_kind: z.string().min(1).nullable().default(null),
                execution_kind: z.string().min(1).nullable().default(null),
                task_signature: z.string().min(1).nullable().default(null),
                task_family: z.string().min(1).nullable().default(null),
                workflow_signature: z.string().min(1).nullable().default(null),
                execution_outcome_role: z.enum(["passed_solution", "failed_branch", "blocked", "unknown"]).nullable().default(null),
                next_action_hint: z.string().min(1).nullable().default(null),
                transition_kind: AionisExecutionTransitionKindSchema.nullable().default(null),
                actor_role: z.string().min(1).nullable().default(null),
                handoff_target: z.string().min(1).nullable().default(null),
                source_agent_id: z.string().min(1).nullable().default(null),
                source_team_id: z.string().min(1).nullable().default(null),
                workflow_steps: z.array(z.string().min(1).max(512)).default([]),
                acceptance_checks: z.array(z.string().min(1).max(512)).default([]),
                verification_summary: z.array(z.string().min(1).max(512)).default([]),
                artifact_hints: z.array(z.string().min(1).max(512)).default([]),
              })
              .strict()
              .optional(),
            memory_contract: AionisMemoryContractSchema.default(defaultAionisMemoryContract),
          })
          .strict(),
      )
      .default([]),
    evidence_trail: z
      .array(
        z
          .object({
            evidence_id: z.string().min(1),
            memory_id: z.string().min(1),
            source: z.enum(["node", "edge", "citation", "context_item", "action_packet"]),
            relation: z.enum(["direct_match", "derived_from", "supports", "contradicts", "rehydrates"]),
            reason: z.string().min(1),
            lifecycle_relation: AionisMemoryLifecycleRelationEvidenceSchema.optional(),
          })
          .strict(),
      )
      .default([]),
    lifecycle: z
      .object({
        used_memory_ids: z.array(z.string().min(1)).default([]),
        candidate_memory_ids: z.array(z.string().min(1)).default([]),
        suppressed_memory_ids: z.array(z.string().min(1)).default([]),
        archived_memory_ids: z.array(z.string().min(1)).default([]),
        rehydration_hints: z
          .array(
            z
              .object({
                memory_id: z.string().min(1),
                mode: z.enum(["summary_only", "partial", "full", "differential"]),
                reason: z.string().min(1),
                required: z.boolean(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
    contradiction_warnings: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            severity: AionisRiskLevelSchema,
            reason: z.string().min(1),
            suggested_action: z.enum(["keep_candidate", "inspect_before_use", "suppress", "rehydrate", "none"]),
          })
          .strict(),
      )
      .default([]),
    forgetting_state: z
      .object({
        stale_memory_count: z.number().int().nonnegative(),
        suppressed_count: z.number().int().nonnegative(),
        archived_count: z.number().int().nonnegative(),
        rehydration_candidate_count: z.number().int().nonnegative(),
      })
      .strict(),
    behavior_impact: z
      .object({
        will_shape_behavior: z.boolean(),
        changed_fields: z.array(z.string().min(1)).default([]),
        expected_effects: z
          .array(z.enum([
            "answer_style",
            "fact_recall",
            "project_context",
            "tool_or_workflow_guidance",
            "avoid_stale_memory",
            "requires_rehydration",
          ]))
          .default([]),
        explanation: z.string().min(1),
      })
      .strict(),
    risk: z
      .object({
        negative_transfer_risk: AionisRiskLevelSchema,
        contradiction_count: z.number().int().nonnegative(),
        low_confidence_count: z.number().int().nonnegative(),
        stale_memory_count: z.number().int().nonnegative(),
        reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    source_map: z
      .object({
        routes_used: z.array(z.string().min(1)).default([]),
        internal_surfaces_used: z.array(z.string().min(1)).default([]),
        omitted_internal_surfaces: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict();

export type AionisMemoryPacket = z.infer<typeof AionisMemoryPacketSchema>;

export function parseAionisMemoryPacket(value: unknown): AionisMemoryPacket {
  return AionisMemoryPacketSchema.parse(value);
}


export const AionisAgentContextSchema = z
  .object({
    contract_version: z.literal("aionis_agent_context_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    agent_role: AionisAgentRoleSchema.default("agent"),
    current_execution_state:
      CurrentExecutionStateV2Schema.nullable().optional(),
    current_execution_state_render:
      CurrentExecutionStateRenderV1Schema.nullable().optional(),
    prompt_text: z.string().min(1),
    summary: z.string().min(1),
    history_used: z.boolean(),
    actionable_history_used: z.boolean().default(false),
    recommended_posture: z.enum([
      "reuse_supported_history",
      "use_as_context",
      "inspect_before_use",
      "rehydrate_before_use",
      "ignore_history",
    ]),
    authority: AionisGuidanceAuthoritySchema,
    target_files: z.array(z.string().min(1)).default([]),
    use_now: z.array(z.string().min(1)).default([]),
    inspect_before_use: z.array(z.string().min(1)).default([]),
    do_not_use: z.array(z.string().min(1)).default([]),
    memory_ids: z.array(z.string().min(1)).default([]),
    use_now_memory_ids: z.array(z.string().min(1)).default([]),
    inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
    do_not_use_memory_ids: z.array(z.string().min(1)).default([]),
    command_posture: z
      .array(
        z
          .object({
            posture: z.enum([
              "must_not",
              "should_continue",
              "inspect_first",
              "rehydrate_first",
              "optional_context",
            ]),
            surface: z.enum([
              "current",
              "procedure",
              "use_now",
              "inspect_before_use",
              "do_not_use",
              "rehydrate",
              "context",
            ]),
            memory_id: z.string().min(1),
            instruction: z.string().min(1),
            reason: z.string().min(1),
            target_files: z.array(z.string().min(1)).default([]),
            workflow_steps: z.array(z.string().min(1).max(512)).default([]),
            acceptance_checks: z.array(z.string().min(1).max(512)).default([]),
            verification_summary: z.array(z.string().min(1).max(512)).default([]),
            artifact_hints: z.array(z.string().min(1).max(512)).default([]),
            execution_state: z
              .object({
                summary_kind: z.string().min(1).nullable().default(null),
                transition_kind: AionisExecutionTransitionKindSchema.nullable().default(null),
                actor_role: z.string().min(1).nullable().default(null),
                handoff_target: z.string().min(1).nullable().default(null),
                next_action_hint: z.string().min(1).nullable().default(null),
                execution_outcome_role: z.enum(["passed_solution", "failed_branch", "blocked", "unknown"]).nullable().default(null),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .default([]),
    prompt_aliases: z
      .array(
        z
          .object({
            alias: z.string().min(1),
            memory_id: z.string().min(1),
            surface: z.enum(["current", "procedure", "inspect", "avoid", "rehydrate", "other"]),
          })
          .strict(),
      )
      .default([]),
    rehydrate_hints: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            reason: z.string().min(1),
            required: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    risk: z
      .object({
        negative_transfer_risk: AionisRiskLevelSchema,
        blocked_authority_count: z.number().int().nonnegative(),
        stale_memory_count: z.number().int().nonnegative(),
        reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    evidence_refs: z
      .object({
        memory_ids: z.array(z.string().min(1)).default([]),
        workflow_ids: z.array(z.string().min(1)).default([]),
        evidence_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type AionisAgentContext = z.infer<typeof AionisAgentContextSchema>;

export function parseAionisAgentContext(value: unknown): AionisAgentContext {
  return AionisAgentContextSchema.parse(value);
}
