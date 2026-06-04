import { z } from "zod";

const ConfidenceSchema = z.number().min(0).max(1);

export const AionisGuidanceAuthoritySchema = z.enum(["trusted", "advisory", "candidate", "blocked", "none"]);
export type AionisGuidanceAuthority = z.infer<typeof AionisGuidanceAuthoritySchema>;

export const AionisRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type AionisRiskLevel = z.infer<typeof AionisRiskLevelSchema>;

const AionisHistoryContributionSchema = z
  .object({
    used: z.boolean(),
    source_count: z.number().int().nonnegative(),
    source_ids: z.array(z.string().min(1)).default([]),
    changed_fields: z.array(z.string().min(1)).default([]),
    reason: z.string().min(1).nullable(),
  })
  .strict();

const AionisHistoryContributionsSchema = z
  .object({
    handoff: AionisHistoryContributionSchema,
    replay: AionisHistoryContributionSchema,
  })
  .strict();

export const AionisMemoryDomainSchema = z.enum(["general", "execution"]);
export type AionisMemoryDomain = z.infer<typeof AionisMemoryDomainSchema>;

export const AionisMemoryFamilySchema = z.enum(["general_cognitive", "execution", "mixed", "empty"]);
export type AionisMemoryFamily = z.infer<typeof AionisMemoryFamilySchema>;

const AionisMemoryLayerSchema = z.enum(["L0", "L1", "L2", "L3", "L4", "L5"]);

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
            scope_hint: z.string().min(1).nullable().optional(),
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

export const AionisGuidePacketSchema = z
  .object({
    contract_version: z.literal("aionis_guide_packet_v1"),
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
    task: z
      .object({
        task_id: z.string().min(1).nullable().optional(),
        run_id: z.string().min(1).nullable().optional(),
        task_signature: z.string().min(1).nullable().optional(),
        task_family: z.string().min(1).nullable().optional(),
      })
      .strict(),
    recovered_state: z
      .object({
        state_summary: z.string().min(1).nullable(),
        resumable: z.boolean(),
        handoff_ids: z.array(z.string().min(1)).default([]),
        execution_state_revision: z.number().int().nonnegative().nullable().optional(),
        target_files: z.array(z.string().min(1)).default([]),
        acceptance_checks: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    proven_facts: z
      .array(
        z
          .object({
            fact: z.string().min(1),
            source: z.enum(["execution_packet", "handoff", "replay", "verifier", "memory", "delegation"]),
            evidence_id: z.string().min(1).nullable().optional(),
            confidence: ConfidenceSchema,
          })
          .strict(),
      )
      .default([]),
    guidance: z
      .object({
        first_action: z
          .object({
            action: z.string().min(1).nullable(),
            reason: z.string().min(1).nullable(),
            authority: AionisGuidanceAuthoritySchema,
            uncertainty: AionisRiskLevelSchema,
          })
          .strict(),
        workflow_candidates: z
          .array(
            z
              .object({
                workflow_id: z.string().min(1),
                title: z.string().min(1),
                authority: z.enum(["trusted", "advisory", "candidate", "blocked"]),
                evidence_count: z.number().int().nonnegative(),
                last_outcome: z.enum(["success", "failure", "mixed", "unknown"]).optional(),
                reuse_reason: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        tool_preferences: z
          .array(
            z
              .object({
                tool: z.string().min(1),
                preference: z.enum(["prefer", "avoid", "inspect_first"]),
                authority: z.enum(["trusted", "advisory", "candidate", "blocked"]),
                reason: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
    history_contributions: AionisHistoryContributionsSchema,
    memory_lifecycle: z
      .object({
        used_memory_ids: z.array(z.string().min(1)).default([]),
        suppressed_memory_ids: z.array(z.string().min(1)).default([]),
        archived_memory_ids: z.array(z.string().min(1)).default([]),
        rehydration_hints: z
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
      })
      .strict(),
    risk: z
      .object({
        negative_transfer_risk: AionisRiskLevelSchema,
        blocked_authority_count: z.number().int().nonnegative(),
        stale_memory_count: z.number().int().nonnegative(),
        provider_or_protocol_quarantine: z.boolean().optional(),
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

export type AionisGuidePacket = z.infer<typeof AionisGuidePacketSchema>;

export function parseAionisGuidePacket(value: unknown): AionisGuidePacket {
  return AionisGuidePacketSchema.parse(value);
}

export const AionisLearningPostureSchema = z.enum([
  "promotion_ready",
  "candidate_only",
  "constrain",
  "invalidate",
  "insufficient_evidence",
]);
export type AionisLearningPosture = z.infer<typeof AionisLearningPostureSchema>;

export const AionisLearningCandidateKindSchema = z.enum([
  "workflow",
  "pattern",
  "policy",
  "memory",
]);
export type AionisLearningCandidateKind = z.infer<typeof AionisLearningCandidateKindSchema>;

export const AionisLearningPacketSchema = z
  .object({
    contract_version: z.literal("aionis_learning_packet_v1"),
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
    task: z
      .object({
        task_id: z.string().min(1).nullable().optional(),
        run_id: z.string().min(1).nullable().optional(),
        task_signature: z.string().min(1).nullable().optional(),
        task_family: z.string().min(1).nullable().optional(),
      })
      .strict(),
    posture: z
      .object({
        recommended_learning_posture: AionisLearningPostureSchema,
        authority: z.enum(["advisory", "candidate", "blocked", "none"]),
        source_code_change_allowed: z.literal(false),
        stable_promotion_allowed: z.boolean(),
        reason: z.string().min(1),
      })
      .strict(),
    candidates: z
      .array(
        z
          .object({
            candidate_id: z.string().min(1),
            kind: AionisLearningCandidateKindSchema,
            authority: z.enum(["advisory", "candidate", "blocked"]),
            evidence_count: z.number().int().nonnegative(),
            promotion_state: z.enum(["candidate", "promotion_ready", "stable", "contested", "retired", "unknown"]),
            source_ids: z.array(z.string().min(1)).default([]),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    learning_control: z
      .object({
        contract_trust: z.enum(["authoritative", "advisory", "observational"]).nullable(),
        action_start_blocked: z.boolean(),
        authoritative_allowed_count: z.number().int().nonnegative(),
        authoritative_blocked_count: z.number().int().nonnegative(),
        stable_promotion_allowed_count: z.number().int().nonnegative(),
        stable_promotion_blocked_count: z.number().int().nonnegative(),
        blocked_reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    lifecycle_effect: z
      .object({
        promoted_workflow_count: z.number().int().nonnegative(),
        candidate_workflow_count: z.number().int().nonnegative(),
        trusted_pattern_count: z.number().int().nonnegative(),
        contested_pattern_count: z.number().int().nonnegative(),
        active_policy_count: z.number().int().nonnegative(),
        contested_policy_count: z.number().int().nonnegative(),
        suppressed_memory_ids: z.array(z.string().min(1)).default([]),
        demote_count: z.number().int().nonnegative(),
        archive_count: z.number().int().nonnegative(),
        review_count: z.number().int().nonnegative(),
      })
      .strict(),
    evidence: z
      .object({
        workflow_anchor_ids: z.array(z.string().min(1)).default([]),
        candidate_workflow_anchor_ids: z.array(z.string().min(1)).default([]),
        trusted_pattern_anchor_ids: z.array(z.string().min(1)).default([]),
        candidate_pattern_anchor_ids: z.array(z.string().min(1)).default([]),
        contested_pattern_anchor_ids: z.array(z.string().min(1)).default([]),
        promotion_denied_reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    export_readiness: z
      .object({
        training_export_ready: z.boolean(),
        positive_transfer_required: z.boolean(),
        reason: z.string().min(1),
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

export type AionisLearningPacket = z.infer<typeof AionisLearningPacketSchema>;

export function parseAionisLearningPacket(value: unknown): AionisLearningPacket {
  return AionisLearningPacketSchema.parse(value);
}

export const AionisEffectImpactDirectionSchema = z.enum([
  "positive",
  "negative",
  "neutral",
  "insufficient_evidence",
]);
export type AionisEffectImpactDirection = z.infer<typeof AionisEffectImpactDirectionSchema>;

export const AionisTrainingCandidateTypeSchema = z.enum([
  "handoff_distillation",
  "transfer_judge",
  "workflow_selector",
  "forgetting_suppression",
  "authority_judgment",
]);
export type AionisTrainingCandidateType = z.infer<typeof AionisTrainingCandidateTypeSchema>;

export const AionisEffectReportSchema = z
  .object({
    contract_version: z.literal("aionis_effect_report_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    task: z
      .object({
        task_id: z.string().min(1).nullable().optional(),
        run_id: z.string().min(1).nullable().optional(),
        task_signature: z.string().min(1).nullable().optional(),
        task_family: z.string().min(1).nullable().optional(),
      })
      .strict(),
    comparison: z
      .object({
        mode: z.enum(["baseline_vs_aionis", "observe_only_vs_active", "single_run_history_impact"]),
        baseline_run_id: z.string().min(1).nullable().optional(),
        aionis_run_id: z.string().min(1).nullable().optional(),
        sufficient_evidence: z.boolean(),
      })
      .strict(),
    history_impact: z
      .object({
        changed_future_behavior: z.boolean(),
        impact_direction: AionisEffectImpactDirectionSchema,
        changed_fields: z.array(z.string().min(1)).default([]),
        explanation: z.string().min(1),
      })
      .strict(),
    efficiency: z
      .object({
        repeated_discovery_delta: z.number().nullable().optional(),
        first_useful_action_delta: z.number().nullable().optional(),
        token_delta: z.number().nullable().optional(),
        context_size_delta: z.number().nullable().optional(),
        recovery_step_delta: z.number().nullable().optional(),
      })
      .strict(),
    quality: z
      .object({
        verifier_outcome: z.enum(["pass", "fail", "not_run", "unknown"]).optional(),
        recovered_fact_accuracy: z.enum(["positive", "negative", "mixed", "unknown"]).optional(),
        workflow_reuse_outcome: z.enum(["success", "failure", "mixed", "not_used"]).optional(),
        negative_transfer_detected: z.boolean(),
      })
      .strict(),
    history_contributions: AionisHistoryContributionsSchema,
    learning_effect: z
      .object({
        promoted_workflow_ids: z.array(z.string().min(1)).default([]),
        candidate_workflow_ids: z.array(z.string().min(1)).default([]),
        demoted_memory_ids: z.array(z.string().min(1)).default([]),
        blocked_authority_ids: z.array(z.string().min(1)).default([]),
        promotion_denied_reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    forgetting_effect: z
      .object({
        suppressed_memory_ids: z.array(z.string().min(1)).default([]),
        archived_memory_ids: z.array(z.string().min(1)).default([]),
        rehydrated_memory_ids: z.array(z.string().min(1)).default([]),
        stale_memory_filtered_count: z.number().int().nonnegative(),
      })
      .strict(),
    training_candidates: z
      .array(
        z
          .object({
            candidate_type: AionisTrainingCandidateTypeSchema,
            source_ids: z.array(z.string().min(1)).min(1),
            label: z.enum(["positive", "negative", "neutral", "blocked", "insufficient_evidence"]),
            export_ready: z.boolean(),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    evidence: z
      .object({
        evidence_ids: z.array(z.string().min(1)).default([]),
        replay_run_ids: z.array(z.string().min(1)).default([]),
        signal_summary_ids: z.array(z.string().min(1)).default([]),
        promotion_quality_summary_ids: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict();

export type AionisEffectReport = z.infer<typeof AionisEffectReportSchema>;

export function parseAionisEffectReport(value: unknown): AionisEffectReport {
  return AionisEffectReportSchema.parse(value);
}
