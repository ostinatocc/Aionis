import { z } from "zod";
import { AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD } from "./authority-consumption.js";

const ConfidenceSchema = z.number().min(0).max(1);

export const AionisGuidanceAuthoritySchema = z.enum(["trusted", "advisory", "candidate", "blocked", "none"]);
export type AionisGuidanceAuthority = z.infer<typeof AionisGuidanceAuthoritySchema>;

export const AionisRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type AionisRiskLevel = z.infer<typeof AionisRiskLevelSchema>;

export const AionisAgentRoleSchema = z.enum(["agent", "planner", "worker", "verifier", "reviewer"]);
export type AionisAgentRole = z.infer<typeof AionisAgentRoleSchema>;

export const AionisTaskContextProfileSchema = z.enum([
  "general",
  "coding_verifier",
  "document_integrity",
  "long_qa",
  "multi_agent_handoff",
  "loop_engineering",
]);
export type AionisTaskContextProfile = z.infer<typeof AionisTaskContextProfileSchema>;

export const AionisExecutionTransitionKindSchema = z.enum([
  "resume_current_state",
  "handoff_to_actor",
  "accept_handoff",
  "inspect_before_use",
  "avoid_failed_branch",
  "request_rehydrate",
]);
export type AionisExecutionTransitionKind = z.infer<typeof AionisExecutionTransitionKindSchema>;

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
export type AionisRecallSourceKind = z.infer<typeof AionisRecallSourceKindSchema>;

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

export const AionisExternalMemoryAuthoritySchema = z
  .object({
    source_trust: z.enum(["trusted", "known", "untrusted", "unknown"]).default("unknown"),
    scope: z.enum(["user", "project", "team", "org", "global", "unknown"]).default("unknown"),
    evidence_requirement: z.enum(["none", "inspect_before_use", "rehydrate_before_use", "blocked"])
      .default("inspect_before_use"),
  })
  .strict()
  .default({
    source_trust: "unknown",
    scope: "unknown",
    evidence_requirement: "inspect_before_use",
  });
export type AionisExternalMemoryAuthority = z.infer<typeof AionisExternalMemoryAuthoritySchema>;

export const AionisExternalMemoryLifecycleHintSchema = z.enum([
  "current",
  "procedure",
  "failed",
  "stale",
  "contested",
  "suppressed",
  "archived",
  "unknown",
]);
export type AionisExternalMemoryLifecycleHint = z.infer<typeof AionisExternalMemoryLifecycleHintSchema>;

export const AionisExternalMemoryCandidateSchema = z
  .object({
    external_memory_id: z.string().min(1),
    source_backend: z.string().min(1),
    text: z.string().min(1).max(200000),
    metadata: z.record(z.unknown()).default({}),
    authority: AionisExternalMemoryAuthoritySchema,
    lifecycle_hint: AionisExternalMemoryLifecycleHintSchema.default("unknown"),
    evidence_refs: z.array(z.string().min(1)).max(256).default([]),
  })
  .strict();
export type AionisExternalMemoryCandidate = z.infer<typeof AionisExternalMemoryCandidateSchema>;

export function parseAionisExternalMemoryCandidate(value: unknown): AionisExternalMemoryCandidate {
  return AionisExternalMemoryCandidateSchema.parse(value);
}

export const AionisMemoryFirewallSummarySchema = z
  .object({
    contract_version: z.literal("aionis_memory_firewall_summary_v1"),
    intended_use: z.literal("memory_firewall_audit"),
    mode: z.literal("firewall"),
    candidate_count: z.number().int().nonnegative(),
    direct_use_count: z.number().int().nonnegative(),
    inspect_count: z.number().int().nonnegative(),
    blocked_count: z.number().int().nonnegative(),
    rehydrate_count: z.number().int().nonnegative(),
    unsafe_candidate_count: z.number().int().nonnegative(),
    unsafe_direct_use_count: z.number().int().nonnegative(),
    runtime_mutation: z.literal(false),
    agent_prompt_included: z.literal(false),
    risk_flags: z.array(z.string().min(1)).default([]),
    claims: z
      .array(
        z
          .object({
            claim: z.string().min(1),
            status: z.enum(["pass", "warn", "fail"]),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    summary: z.string().min(1),
  })
  .strict();
export type AionisMemoryFirewallSummary = z.infer<typeof AionisMemoryFirewallSummarySchema>;

export function parseAionisMemoryFirewallSummary(value: unknown): AionisMemoryFirewallSummary {
  return AionisMemoryFirewallSummarySchema.parse(value);
}

export const AionisClaimLedgerProjectionSurfaceSchema = z.enum([
  "use_now",
  "inspect_before_use",
  "do_not_use",
  "audit_only",
]);
export type AionisClaimLedgerProjectionSurface = z.infer<typeof AionisClaimLedgerProjectionSurfaceSchema>;

export const AionisClaimLedgerProjectionItemSchema = z
  .object({
    claim_id: z.string().min(1),
    slot_key: z.string().min(1).nullable(),
    subject_key: z.string().min(1),
    predicate: z.string().min(1),
    surface: AionisClaimLedgerProjectionSurfaceSchema,
    reason_code: z.string().min(1),
    value_text: z.string().min(1),
    authority: z.enum(["evidence_only", "advisory", "trusted", "blocked"]),
    status: z.enum(["active", "contested", "superseded", "retired", "redacted"]),
    confidence: ConfidenceSchema,
    evidence_refs: z.array(z.string().min(1)).max(32).default([]),
    source_memory_id: z.string().min(1).nullable(),
    valid_from: z.string().min(1),
    valid_until: z.string().min(1).nullable(),
    superseded_by_claim_id: z.string().min(1).nullable(),
  })
  .strict();
export type AionisClaimLedgerProjectionItem = z.infer<typeof AionisClaimLedgerProjectionItemSchema>;

export const AionisClaimLedgerProjectionSchema = z
  .object({
    contract_version: z.literal("aionis_claim_ledger_projection_v1"),
    use_now: z.array(AionisClaimLedgerProjectionItemSchema).default([]),
    inspect_before_use: z.array(AionisClaimLedgerProjectionItemSchema).default([]),
    do_not_use: z.array(AionisClaimLedgerProjectionItemSchema).default([]),
    audit_only: z.array(AionisClaimLedgerProjectionItemSchema).default([]),
    blocked_superseded_count: z.number().int().nonnegative(),
    live_claim_count: z.number().int().nonnegative(),
    contested_claim_count: z.number().int().nonnegative(),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
  })
  .strict();
export type AionisClaimLedgerProjection = z.infer<typeof AionisClaimLedgerProjectionSchema>;

export const AionisLifecycleCandidateSignalSchema = z
  .object({
    memory_id: z.string().min(1),
    signal_type: z.enum(["current", "procedure", "negative", "stale", "contested", "rehydrate"]),
    confidence: ConfidenceSchema,
    evidence_span: z
      .object({
        source_field: z.enum(["title", "text_summary", "slots", "query"]),
        quote: z.string().min(1),
      })
      .strict(),
    producer: z.enum(["rule_v1", "target_cluster_v1", "semantic_shadow_v1", "llm_shadow_v1"]),
    reason: z.string().min(1),
  })
  .strict();
export type AionisLifecycleCandidateSignal = z.infer<typeof AionisLifecycleCandidateSignalSchema>;

const AionisLifecycleCandidateSummarySchema = z
  .object({
    present: z.boolean(),
    contract_version: z.literal("aionis_lifecycle_candidate_summary_v1").nullable(),
    mode: z.enum(["rule_shadow", "rule_gated"]).nullable(),
    authority_mutation: z.literal(false),
    agent_prompt_included: z.literal(false),
    signal_payload_prompt_included: z.literal(false).default(false),
    surface_effect_prompt_included: z.boolean().default(false),
    candidate_count: z.number().int().nonnegative(),
    gated_count: z.number().int().nonnegative(),
    shadow_only_count: z.number().int().nonnegative(),
    candidate_memory_ids: z.array(z.string().min(1)).default([]),
    gated_memory_ids: z.array(z.string().min(1)).default([]),
    shadow_only_memory_ids: z.array(z.string().min(1)).default([]),
    signals: z.array(AionisLifecycleCandidateSignalSchema).default([]),
    reason: z.string().min(1),
  })
  .strict();

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
                next_action_hint: z.string().min(1).nullable().default(null),
                transition_kind: AionisExecutionTransitionKindSchema.nullable().default(null),
                actor_role: z.string().min(1).nullable().default(null),
                handoff_target: z.string().min(1).nullable().default(null),
                source_agent_id: z.string().min(1).nullable().default(null),
                source_team_id: z.string().min(1).nullable().default(null),
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
    guide_brief: z
      .object({
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
        use_now: z.array(z.string().min(1)).default([]),
        inspect_before_use: z.array(z.string().min(1)).default([]),
        do_not_use: z.array(z.string().min(1)).default([]),
        rehydrate: z
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
        expected_product_effects: z
          .object({
            reduces_repeated_discovery: z.boolean(),
            reduces_context_replay: z.boolean(),
            controls_negative_transfer: z.boolean(),
            reason: z.string().min(1),
          })
          .strict(),
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

const AionisRouteContractTargetSchema = z
  .object({
    target: z.string().min(1),
    source_memory_id: z.string().min(1).optional(),
    source: z.enum(["target_files", "should_continue", "inspect_first", "must_not"]),
    reason: z.string().min(1).optional(),
  })
  .strict();

const AionisRouteContractEvidenceSourceSchema = AionisRouteContractTargetSchema.extend({
  evidence_use: z.literal("reference_only").default("reference_only"),
  direction_policy: z.literal("must_not_be_primary_route").default("must_not_be_primary_route"),
}).strict();

const AionisRouteContractBlockedRouteSchema = AionisRouteContractTargetSchema.extend({
  direction_policy: z.literal("blocked_route").default("blocked_route"),
  evidence_use: z.literal("counter_evidence_only").default("counter_evidence_only"),
}).strict();

const AionisRouteContractMissingActiveActionSchema = z.enum(["create", "restore", "rehydrate", "report_conflict"]);
const AionisRouteContractMissingActiveActionOrder = ["create", "restore", "rehydrate", "report_conflict"] as const;
const AionisRouteContractActionPolicySchema = z
  .object({
    missing_active_target_preferred_order: z
      .array(AionisRouteContractMissingActiveActionSchema)
      .default([...AionisRouteContractMissingActiveActionOrder]),
    terminal_inspect_allowed: z.literal(false).default(false),
    reference_fallback_requires: z
      .literal("explicit_raw_evidence_or_operator_confirmation")
      .default("explicit_raw_evidence_or_operator_confirmation"),
    executable_evidence_policy: z
      .literal("route_safe_but_patch_may_require_rehydrate")
      .default("route_safe_but_patch_may_require_rehydrate"),
    after_rehydrate_policy: z
      .literal("continue_allowed_action_if_task_consistent")
      .default("continue_allowed_action_if_task_consistent"),
    report_conflict_requires: z
      .literal("rehydrate_unavailable_or_evidence_conflict")
      .default("rehydrate_unavailable_or_evidence_conflict"),
  })
  .strict()
  .default({
    missing_active_target_preferred_order: [...AionisRouteContractMissingActiveActionOrder],
    terminal_inspect_allowed: false,
    reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
    executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
    after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
    report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
  });

const AionisRouteContractSchema = z
  .object({
    active_targets: z
      .array(
        AionisRouteContractTargetSchema.extend({
          artifact_status: z.enum(["unknown", "may_be_absent"]).default("unknown"),
          missing_policy: z
            .literal("restore_or_create_if_task_consistent_or_rehydrate")
            .default("restore_or_create_if_task_consistent_or_rehydrate"),
        }).strict(),
      )
      .default([]),
    pending_artifacts: z
      .array(
        AionisRouteContractTargetSchema.extend({
          status: z.literal("unknown_until_host_observation").default("unknown_until_host_observation"),
          when: z.literal("if_active_target_is_missing").default("if_active_target_is_missing"),
          allowed_actions: z
            .array(AionisRouteContractMissingActiveActionSchema)
            .default([...AionisRouteContractMissingActiveActionOrder]),
          preferred_action_order: z
            .array(AionisRouteContractMissingActiveActionSchema)
            .default([...AionisRouteContractMissingActiveActionOrder]),
          terminal_inspect_allowed: z.literal(false).default(false),
          executable_evidence_policy: z
            .literal("route_safe_but_patch_may_require_rehydrate")
            .default("route_safe_but_patch_may_require_rehydrate"),
          after_rehydrate_policy: z
            .literal("continue_allowed_action_if_task_consistent")
            .default("continue_allowed_action_if_task_consistent"),
          report_conflict_requires: z
            .literal("rehydrate_unavailable_or_evidence_conflict")
            .default("rehydrate_unavailable_or_evidence_conflict"),
        }).strict(),
      )
      .default([]),
    reference_only_targets: z.array(AionisRouteContractTargetSchema).default([]),
    blocked_direction_targets: z.array(AionisRouteContractTargetSchema).default([]),
    evidence_sources: z.array(AionisRouteContractEvidenceSourceSchema).default([]),
    blocked_routes: z.array(AionisRouteContractBlockedRouteSchema).default([]),
    conflict_policy: z
      .literal("do_not_treat_missing_active_target_as_superseded")
      .default("do_not_treat_missing_active_target_as_superseded"),
    fallback_policy: z
      .literal("do_not_promote_reference_or_blocked_targets")
      .default("do_not_promote_reference_or_blocked_targets"),
    action_policy: AionisRouteContractActionPolicySchema,
  })
  .strict()
  .default({
    active_targets: [],
    pending_artifacts: [],
    reference_only_targets: [],
    blocked_direction_targets: [],
    evidence_sources: [],
    blocked_routes: [],
    conflict_policy: "do_not_treat_missing_active_target_as_superseded",
    fallback_policy: "do_not_promote_reference_or_blocked_targets",
    action_policy: {
      missing_active_target_preferred_order: [...AionisRouteContractMissingActiveActionOrder],
      terminal_inspect_allowed: false,
      reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
    },
  });

export const AionisAgentContextSchema = z
  .object({
    contract_version: z.literal("aionis_agent_context_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    agent_role: AionisAgentRoleSchema.default("agent"),
    agent_context_mode: z.enum(["standard", "compact_agent"]).default("standard"),
    task_context_profile: AionisTaskContextProfileSchema.default("general"),
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
          })
          .strict(),
      )
      .default([]),
    route_contract: AionisRouteContractSchema,
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

export const AionisMemoryDecisionSurfaceSchema = z.enum([
  "use_now",
  "inspect_before_use",
  "do_not_use",
  "rehydrate",
  "not_agent_facing",
]);
export type AionisMemoryDecisionSurface = z.infer<typeof AionisMemoryDecisionSurfaceSchema>;

const AionisMemoryDecisionKindSchema = z.enum([
  "used",
  "downgraded",
  "blocked",
  "rehydrate",
  "not_agent_facing",
]);

const AionisFeedbackOutcomeSchema = z.enum(["positive", "negative", "neutral"]);
const AionisFeedbackUsedSurfaceSchema = z.enum(["use_now", "inspect_before_use", "do_not_use", "explicit_host_assertion"]);
const AionisFeedbackVerifierStatusSchema = z.enum(["passed", "failed", "not_run", "unknown"]);
const AionisFeedbackToolStatusSchema = z.enum(["succeeded", "failed", "not_run", "unknown"]);
const AionisFeedbackAttributionStrengthSchema = z.enum([
  "observed_feedback",
  "positive_attribution",
  "weak_counter_signal",
  "strong_counter_signal",
]);
const AionisFeedbackThresholdStateSchema = z.enum([
  "none",
  "observed_feedback_only",
  "positive_attribution",
  "weak_below_threshold",
  "repeated_weak_threshold_met",
  "strong_signal_threshold_met",
]);

const AionisUnusedExposureObservationSchema = z
  .object({
    present: z.boolean(),
    contract_version: z.literal("aionis_unused_exposure_observation_v1").nullable(),
    mode: z.literal("read_only_measure").nullable(),
    exposure_threshold: z.number().int().nonnegative(),
    guide_trace_count: z.number().int().nonnegative(),
    tracked_memory_count: z.number().int().nonnegative(),
    repeated_unattributed_memory_ids: z.array(z.string().min(1)).default([]),
    repeated_unattributed_without_positive_memory_ids: z.array(z.string().min(1)).default([]),
    memory_stats: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            current_unattributed: z.boolean(),
            exposure_count: z.number().int().nonnegative(),
            use_now_exposure_count: z.number().int().nonnegative(),
            inspect_before_use_exposure_count: z.number().int().nonnegative(),
            do_not_use_exposure_count: z.number().int().nonnegative(),
            rehydrate_exposure_count: z.number().int().nonnegative(),
            positive_attributed_use_count: z.number().int().nonnegative(),
            feedback_positive_count: z.number().int().nonnegative(),
            feedback_negative_count: z.number().int().nonnegative(),
            repeated_without_positive_attribution: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    reason: z.string().min(1),
  })
  .strict();

const AionisCandidateLearningControlSummarySchema = z
  .object({
    present: z.boolean(),
    contract_version: z.literal("aionis_candidate_learning_control_summary_v1").nullable(),
    mode: z.literal("candidate_only").nullable(),
    authority_mutation: z.literal(false),
    candidate_inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_from_threshold_met_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_from_repeated_unused_without_positive_memory_ids: z.array(z.string().min(1)).default([]),
    blocked_by_positive_attribution_memory_ids: z.array(z.string().min(1)).default([]),
    reason: z.string().min(1),
  })
  .strict();

const AionisConfidenceDecayCandidateSummarySchema = z
  .object({
    present: z.boolean(),
    contract_version: z.literal("aionis_confidence_decay_candidate_summary_v1").nullable(),
    mode: z.literal("shadow_candidate").nullable(),
    authority_mutation: z.literal(false),
    agent_prompt_included: z.literal(false),
    time_decay_age_threshold_days: z.number().int().nonnegative(),
    decay_candidate_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_from_learning_control_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_from_time_decay_memory_ids: z.array(z.string().min(1)).default([]),
    supported_by_neighborhood_drift_memory_ids: z.array(z.string().min(1)).default([]),
    drift_only_observation_memory_ids: z.array(z.string().min(1)).default([]),
    blocked_by_positive_attribution_memory_ids: z.array(z.string().min(1)).default([]),
    blocked_by_recent_validation_memory_ids: z.array(z.string().min(1)).default([]),
    time_decay_candidate_details: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            observed_at: z.string().min(1),
            reference_observed_at: z.string().min(1),
            age_days: z.number().int().nonnegative(),
            threshold_days: z.number().int().nonnegative(),
            agent_surface: AionisMemoryDecisionSurfaceSchema,
            authority: AionisGuidanceAuthoritySchema,
            blocked_by_positive_attribution: z.boolean(),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    reason: z.string().min(1),
  })
  .strict();

const AionisInspectBeforeUseShadowDeltaSourceSchema = z.enum(["learning_control", "time_decay"]);

const AionisInspectBeforeUseShadowDeltaSchema = z
  .object({
    present: z.boolean(),
    contract_version: z.literal("aionis_inspect_before_use_shadow_delta_v1").nullable(),
    mode: z.literal("disabled_preview").nullable(),
    enabled: z.literal(false),
    authority_mutation: z.literal(false),
    agent_prompt_included: z.literal(false),
    simulated_surface: z.literal("inspect_before_use"),
    candidate_memory_ids: z.array(z.string().min(1)).default([]),
    would_move_to_inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
    already_inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
    blocked_by_positive_attribution_memory_ids: z.array(z.string().min(1)).default([]),
    blocked_by_recent_validation_memory_ids: z.array(z.string().min(1)).default([]),
    drift_only_observation_memory_ids: z.array(z.string().min(1)).default([]),
    entries: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            title: z.string().min(1).nullable(),
            current_surface: AionisMemoryDecisionSurfaceSchema,
            proposed_surface: z.literal("inspect_before_use"),
            would_change_surface: z.boolean(),
            authority: AionisGuidanceAuthoritySchema,
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
            sources: z.array(AionisInspectBeforeUseShadowDeltaSourceSchema).default([]),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    reason: z.string().min(1),
  })
  .strict();

const AionisSparseFeedbackSignalSummarySchema = z
  .object({
    present: z.boolean(),
    mode: z.literal("read_only_measure").nullable(),
    authority_mutation: z.literal(false),
    positive_attributed_memory_ids: z.array(z.string().min(1)).default([]),
    weak_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
    strong_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
    relation_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
    contradiction_warning_memory_ids: z.array(z.string().min(1)).default([]),
    repeated_unattributed_memory_ids: z.array(z.string().min(1)).default([]),
    repeated_unattributed_without_positive_memory_ids: z.array(z.string().min(1)).default([]),
    read_only_signal_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_learning_control_summary: AionisCandidateLearningControlSummarySchema.default({
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      candidate_inspect_before_use_memory_ids: [],
      candidate_from_threshold_met_memory_ids: [],
      candidate_from_repeated_unused_without_positive_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      reason: "No sparse feedback signal crossed the candidate learning-control gate.",
    }),
    reason: z.string().min(1),
  })
  .strict();

const AionisFeedbackAttributionDetailSchema = z
  .object({
    run_id: z.string().min(1).nullable(),
    outcome: AionisFeedbackOutcomeSchema.nullable(),
    used_surface: AionisFeedbackUsedSurfaceSchema.nullable(),
    verifier_status: AionisFeedbackVerifierStatusSchema.nullable(),
    tool_status: AionisFeedbackToolStatusSchema.nullable(),
    runtime_signal_refs: z.array(z.string().min(1)).default([]),
    attribution_strength: AionisFeedbackAttributionStrengthSchema.nullable(),
    weak_counter_signal_count: z.number().int().nonnegative(),
    strong_counter_signal_count: z.number().int().nonnegative(),
    threshold_state: AionisFeedbackThresholdStateSchema,
    threshold_met: z.boolean(),
    host_marked_used: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();

const AionisJudgmentCalibrationBucketSchema = z
  .object({
    bucket: z.string().min(1),
    record_count: z.number().int().nonnegative(),
    supported_count: z.number().int().nonnegative(),
    contradicted_count: z.number().int().nonnegative(),
    weak_count: z.number().int().nonnegative(),
    unused_count: z.number().int().nonnegative(),
    inconclusive_count: z.number().int().nonnegative(),
    memory_ids: z.array(z.string().min(1)).default([]),
    recommended_adjustment: z.enum([
      "keep",
      "rank_up",
      "rank_down",
      "inspect_first",
      "needs_more_evidence",
    ]),
    authority: z.literal("read_only"),
    reason: z.string().min(1),
  })
  .strict();

export const AionisJudgmentCalibrationSummarySchema = z
  .object({
    contract_version: z.literal("aionis_judgment_calibration_summary_v1"),
    intended_use: z.literal("judgment_calibration_audit"),
    source: z.literal("memory_decision_trace"),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    authority: z.literal("read_only"),
    window: z
      .object({
        record_count: z.number().int().nonnegative(),
        anchored_count: z.number().int().nonnegative(),
        weak_count: z.number().int().nonnegative(),
        unused_count: z.number().int().nonnegative(),
        inconclusive_count: z.number().int().nonnegative(),
      })
      .strict(),
    supported_memory_ids: z.array(z.string().min(1)).default([]),
    contradicted_memory_ids: z.array(z.string().min(1)).default([]),
    weak_memory_ids: z.array(z.string().min(1)).default([]),
    unused_memory_ids: z.array(z.string().min(1)).default([]),
    inconclusive_memory_ids: z.array(z.string().min(1)).default([]),
    buckets: z.array(AionisJudgmentCalibrationBucketSchema).default([]),
    reason: z.string().min(1),
  })
  .strict();

export type AionisJudgmentCalibrationSummary = z.infer<typeof AionisJudgmentCalibrationSummarySchema>;

const DEFAULT_AIONIS_JUDGMENT_CALIBRATION_SUMMARY: AionisJudgmentCalibrationSummary = {
  contract_version: "aionis_judgment_calibration_summary_v1",
  intended_use: "judgment_calibration_audit",
  source: "memory_decision_trace",
  agent_prompt_included: false,
  runtime_mutation: false,
  authority: "read_only",
  window: {
    record_count: 0,
    anchored_count: 0,
    weak_count: 0,
    unused_count: 0,
    inconclusive_count: 0,
  },
  supported_memory_ids: [],
  contradicted_memory_ids: [],
  weak_memory_ids: [],
  unused_memory_ids: [],
  inconclusive_memory_ids: [],
  buckets: [],
  reason: "No memory judgment decisions were available for calibration.",
};

const AionisAuditFeedbackSignalMemorySchema = z
  .object({
    memory_id: z.string().min(1),
    title: z.string().min(1).nullable(),
    reason: z.string().min(1),
  })
  .strict();

const AionisNeighborhoodDriftCandidateSchema = z
  .object({
    memory_id: z.string().min(1),
    title: z.string().min(1).nullable(),
    signal_present: z.boolean(),
    neighborhood_growth_count: z.number().int().nonnegative(),
    newer_related_memory_count: z.number().int().nonnegative(),
    directional_drift_count: z.number().int().nonnegative(),
    same_direction_growth_count: z.number().int().nonnegative(),
    isolation_score: z.number().int().nonnegative(),
    related_memory_ids: z.array(z.string().min(1)).default([]),
    directional_drift_memory_ids: z.array(z.string().min(1)).default([]),
    same_direction_memory_ids: z.array(z.string().min(1)).default([]),
    reason: z.string().min(1),
  })
  .strict();

const AionisNeighborhoodDriftObservationSchema = z
  .object({
    present: z.boolean(),
    contract_version: z.literal("aionis_neighborhood_drift_observation_v1").nullable(),
    mode: z.literal("read_only_measure").nullable(),
    authority_mutation: z.literal(false),
    growth_threshold: z.number().int().nonnegative(),
    directional_drift_threshold: z.number().int().nonnegative(),
    isolation_threshold: z.number().int().nonnegative(),
    signal_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_count: z.number().int().nonnegative(),
    candidates: z.array(AionisNeighborhoodDriftCandidateSchema).default([]),
    reason: z.string().min(1),
  })
  .strict();

const AionisEffectNeighborhoodDriftSummarySchema = z
  .object({
    present: z.boolean(),
    source: z.enum(["memory_decision_audit", "not_supplied"]),
    authority_mutation: z.literal(false),
    signal_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_count: z.number().int().nonnegative(),
    explanation: z.string().min(1),
  })
  .strict();

const AionisEffectConfidenceDecaySummarySchema = z
  .object({
    present: z.boolean(),
    source: z.enum(["memory_decision_audit", "not_supplied"]),
    authority_mutation: z.literal(false),
    time_decay_age_threshold_days: z.number().int().nonnegative(),
    decay_candidate_memory_ids: z.array(z.string().min(1)).default([]),
    candidate_from_time_decay_memory_ids: z.array(z.string().min(1)).default([]),
    blocked_by_positive_attribution_memory_ids: z.array(z.string().min(1)).default([]),
    supported_by_neighborhood_drift_memory_ids: z.array(z.string().min(1)).default([]),
    explanation: z.string().min(1),
  })
  .strict();

export const AionisMemoryUseReceiptSchema = z
  .object({
    contract_version: z.literal("aionis_memory_use_receipt_v1"),
    intended_use: z.literal("memory_use_audit"),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    guide_trace_id: z.string().min(1).nullable(),
    history_used: z.boolean(),
    actionable_history_used: z.boolean().default(false),
    prompt_char_count: z.number().int().nonnegative(),
    exposed_memory_ids: z.array(z.string().min(1)).default([]),
    use_now_memory_ids: z.array(z.string().min(1)).default([]),
    inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
    do_not_use_memory_ids: z.array(z.string().min(1)).default([]),
    rehydrate_memory_ids: z.array(z.string().min(1)).default([]),
    attributed_memory_ids: z.array(z.string().min(1)).default([]),
    unattributed_recalled_memory_ids: z.array(z.string().min(1)).default([]),
    read_only_signal_memory_ids: z.array(z.string().min(1)).default([]),
    decision_summaries: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            agent_surface: AionisMemoryDecisionSurfaceSchema,
            decision_kind: AionisMemoryDecisionKindSchema,
            actionable: z.boolean(),
            reason_codes: z.array(z.string().min(1)).default([]),
            recall_sources: z.array(AionisRecallSourceTraceSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    risk_flags: z.array(z.string().min(1)).default([]),
    summary: z.string().min(1),
  })
  .strict();

export type AionisMemoryUseReceipt = z.infer<typeof AionisMemoryUseReceiptSchema>;

export function parseAionisMemoryUseReceipt(value: unknown): AionisMemoryUseReceipt {
  return AionisMemoryUseReceiptSchema.parse(value);
}

export const AionisMemoryAdmissionClosedLoopEffectStateSchema = z.enum([
  "no_prior",
  "supported",
  "contradicted",
  "mixed",
  "rehydrate_requested",
]);
export type AionisMemoryAdmissionClosedLoopEffectState = z.infer<
  typeof AionisMemoryAdmissionClosedLoopEffectStateSchema
>;

export const AionisMemoryAdmissionShadowPolicyReportSchema = z
  .object({
    contract_version: z.literal("aionis_memory_admission_shadow_policy_report_v1"),
    intended_use: z.literal("admission_policy_shadow_audit"),
    policy_id: z.literal("candidate_project_context_closed_loop_inspect"),
    policy_version: z.string().min(1),
    mode: z.literal("shadow_only"),
    source: z.enum(["memory_admission_record", "memory_decision_trace", "external_candidate_admission"]),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    hard_boundary_policy: z.literal("preserve_recorded_non_use_now"),
    decision_count: z.number().int().nonnegative(),
    changed_count: z.number().int().nonnegative(),
    would_downgrade_use_now_count: z.number().int().nonnegative(),
    hard_boundary_upgrade_count: z.number().int().nonnegative(),
    direct_use_recorded_count: z.number().int().nonnegative(),
    direct_use_shadow_count: z.number().int().nonnegative(),
    policy_changed_memory_ids: z.array(z.string().min(1)).default([]),
    downgraded_memory_ids: z.array(z.string().min(1)).default([]),
    hard_boundary_preserved_memory_ids: z.array(z.string().min(1)).default([]),
    decisions: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            title: z.string().min(1).nullable(),
            recorded_action: AionisMemoryDecisionSurfaceSchema,
            shadow_action: AionisMemoryDecisionSurfaceSchema,
            would_change_action: z.boolean(),
            memory_origin: z.enum(["aionis", "external"]),
            source_backend: z.string().min(1),
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
            closed_loop_effect_state: AionisMemoryAdmissionClosedLoopEffectStateSchema,
            repeated_negative_posture: z.boolean(),
            prior_state_available: z.boolean(),
            used_fields: z.array(z.string().min(1)).default([]),
            reason_codes: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
    summary: z.string().min(1),
  })
  .strict();

export type AionisMemoryAdmissionShadowPolicyReport = z.infer<
  typeof AionisMemoryAdmissionShadowPolicyReportSchema
>;

export function parseAionisMemoryAdmissionShadowPolicyReport(
  value: unknown,
): AionisMemoryAdmissionShadowPolicyReport {
  return AionisMemoryAdmissionShadowPolicyReportSchema.parse(value);
}

export const AionisMemoryAdmissionRecordSchema = z
  .object({
    contract_version: z.literal("aionis_memory_admission_record_v1"),
    intended_use: z.literal("memory_admission_audit_dataset"),
    source: z.enum(["memory_decision_trace", "external_candidate_admission"]),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    guide_trace_id: z.string().min(1).nullable(),
    prompt_char_count: z.number().int().nonnegative(),
    history_used: z.boolean(),
    actionable_history_used: z.boolean(),
    candidate_memory_count: z.number().int().nonnegative(),
    prompt_included_memory_count: z.number().int().nonnegative(),
    agent_used_memory_count: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            title: z.string().min(1).nullable(),
            memory_origin: z.enum(["aionis", "external"]).default("aionis"),
            source_backend: z.string().min(1).default("aionis"),
            domain: AionisMemoryDomainSchema,
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
            authority: AionisGuidanceAuthoritySchema,
            admission_action: AionisMemoryDecisionSurfaceSchema,
            decision_kind: AionisMemoryDecisionKindSchema,
            actionable: z.boolean(),
            prompt_included: z.boolean(),
            agent_used: z.boolean(),
            feedback_outcome: AionisFeedbackOutcomeSchema.nullable(),
            attribution_strength: AionisFeedbackAttributionStrengthSchema.nullable(),
            reason_codes: z.array(z.string().min(1)).default([]),
            evidence_ids: z.array(z.string().min(1)).default([]),
            recall_sources: z.array(AionisRecallSourceTraceSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    shadow_policy_report: AionisMemoryAdmissionShadowPolicyReportSchema.optional(),
    summary: z.string().min(1),
  })
  .strict();

export type AionisMemoryAdmissionRecord = z.infer<typeof AionisMemoryAdmissionRecordSchema>;

export function parseAionisMemoryAdmissionRecord(value: unknown): AionisMemoryAdmissionRecord {
  return AionisMemoryAdmissionRecordSchema.parse(value);
}

export const AionisMemoryDecisionTraceSchema = z
  .object({
    contract_version: z.literal("aionis_memory_decision_trace_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    intended_use: z.literal("measure_debug_audit"),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    input: z
      .object({
        before_guide_present: z.boolean(),
        after_guide_present: z.boolean(),
        memory_packet_present: z.boolean(),
        guide_packet_present: z.boolean(),
        agent_context_present: z.boolean(),
        forget_result_present: z.boolean(),
      })
      .strict(),
    summary: z
      .object({
        total_memory_count: z.number().int().nonnegative(),
        direct_use_count: z.number().int().nonnegative(),
        inspect_before_use_count: z.number().int().nonnegative(),
        do_not_use_count: z.number().int().nonnegative(),
        rehydrate_count: z.number().int().nonnegative(),
        relation_count: z.number().int().nonnegative(),
        contradiction_warning_count: z.number().int().nonnegative(),
        feedback_attribution_count: z.number().int().nonnegative(),
        feedback_threshold_met_count: z.number().int().nonnegative(),
        unattributed_recalled_memory_count: z.number().int().nonnegative(),
        prompt_char_count: z.number().int().nonnegative(),
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
        negative_transfer_risk: AionisRiskLevelSchema,
        learning_control_visible: z.boolean(),
      })
      .strict(),
    memory_decisions: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            title: z.string().min(1).nullable(),
            domain: AionisMemoryDomainSchema,
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
            authority: AionisGuidanceAuthoritySchema,
            agent_surface: AionisMemoryDecisionSurfaceSchema,
            decision_kind: AionisMemoryDecisionKindSchema,
            reason_codes: z.array(z.string().min(1)).default([]),
            evidence_ids: z.array(z.string().min(1)).default([]),
            recall_sources: z.array(AionisRecallSourceTraceSchema).default([]),
            used_detail: z
              .object({
                authority: AionisGuidanceAuthoritySchema,
                confidence: ConfidenceSchema,
                salience: ConfidenceSchema,
                source_layer: AionisMemoryLayerSchema.nullable(),
                not_superseded: z.boolean(),
              })
              .strict()
              .nullable(),
            downgraded_detail: z
              .object({
                by_memory_id: z.string().min(1),
                evidence_id: z.string().min(1),
                relation: AionisMemoryLifecycleRelationEvidenceSchema,
              })
              .strict()
              .nullable(),
            blocked_detail: z
              .object({
                blocked_by: z.enum([
                  "scope_mismatch",
                  "suppressed_lifecycle",
                  "archived_lifecycle",
                  "blocked_authority",
                  "low_authority",
                  "agent_surface_projection",
                  "unknown",
                ]),
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
                authority: AionisGuidanceAuthoritySchema,
                reason: z.string().min(1),
              })
              .strict()
              .nullable(),
            feedback_detail: AionisFeedbackAttributionDetailSchema.nullable(),
            rehydrate_detail: z
              .object({
                mode: z.enum(["summary_only", "partial", "full", "differential"]),
                reason: z.string().min(1),
                required: z.boolean(),
                payload_status: z.enum(["cold_payload", "summary_only", "unknown"]),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .default([]),
    relation_decisions: z
      .array(
        z
          .object({
            evidence_id: z.string().min(1),
            memory_id: z.string().min(1),
            relation: z.enum(["direct_match", "derived_from", "supports", "contradicts", "rehydrates"]),
            source_memory_id: z.string().min(1),
            target_memory_id: z.string().min(1),
            lifecycle_relation: AionisMemoryLifecycleRelationKindSchema,
            confidence: ConfidenceSchema,
            producer: z.string().min(1),
            candidate_confidence: ConfidenceSchema.nullable(),
            signals: AionisMemoryLifecycleRelationSignalsSchema,
            gate: AionisMemoryLifecycleRelationGateSchema,
            reason: z.string().min(1),
            reasons: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
    lifecycle_candidate_summary: AionisLifecycleCandidateSummarySchema.default({
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      agent_prompt_included: false,
      signal_payload_prompt_included: false,
      surface_effect_prompt_included: false,
      candidate_count: 0,
      gated_count: 0,
      shadow_only_count: 0,
      candidate_memory_ids: [],
      gated_memory_ids: [],
      shadow_only_memory_ids: [],
      signals: [],
      reason: "No lifecycle candidate signals were supplied for this trace.",
    }),
    feedback_attribution: z
      .object({
        present: z.boolean(),
        guide_trace_id: z.string().min(1).nullable(),
        run_id: z.string().min(1).nullable(),
        outcome: AionisFeedbackOutcomeSchema.nullable(),
        used_surface: AionisFeedbackUsedSurfaceSchema.nullable(),
        verifier_status: AionisFeedbackVerifierStatusSchema.nullable(),
        tool_status: AionisFeedbackToolStatusSchema.nullable(),
        runtime_signal_refs: z.array(z.string().min(1)).default([]),
        affected_memory_ids: z.array(z.string().min(1)).default([]),
        exposed_memory_count: z.number().int().nonnegative().default(0),
        attributed_memory_count: z.number().int().nonnegative().default(0),
        unattributed_recalled_memory_count: z.number().int().nonnegative().default(0),
        attributed_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_recalled_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_use_now_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_do_not_use_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_rehydrate_memory_ids: z.array(z.string().min(1)).default([]),
        unused_exposure_observation: AionisUnusedExposureObservationSchema.default({
          present: false,
          contract_version: null,
          mode: null,
          exposure_threshold: 0,
          guide_trace_count: 0,
          tracked_memory_count: 0,
          repeated_unattributed_memory_ids: [],
          repeated_unattributed_without_positive_memory_ids: [],
          memory_stats: [],
          reason: "No guide exposure observation was supplied for this trace.",
        }),
        sparse_feedback_signal_summary: AionisSparseFeedbackSignalSummarySchema.default({
          present: false,
          mode: null,
          authority_mutation: false,
          positive_attributed_memory_ids: [],
          weak_counter_signal_memory_ids: [],
          strong_counter_signal_memory_ids: [],
          relation_counter_signal_memory_ids: [],
          contradiction_warning_memory_ids: [],
          repeated_unattributed_memory_ids: [],
          repeated_unattributed_without_positive_memory_ids: [],
          read_only_signal_memory_ids: [],
          candidate_learning_control_summary: {
            present: false,
            contract_version: null,
            mode: null,
            authority_mutation: false,
            candidate_inspect_before_use_memory_ids: [],
            candidate_from_threshold_met_memory_ids: [],
            candidate_from_repeated_unused_without_positive_memory_ids: [],
            blocked_by_positive_attribution_memory_ids: [],
            reason: "No sparse feedback signal crossed the candidate learning-control gate.",
          },
          reason: "No activate feedback or unused exposure signal was supplied for this trace.",
        }),
        weak_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
        strong_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
        threshold_met_memory_ids: z.array(z.string().min(1)).default([]),
        reason: z.string().min(1),
      })
      .strict(),
    judgment_calibration_summary: AionisJudgmentCalibrationSummarySchema.default(DEFAULT_AIONIS_JUDGMENT_CALIBRATION_SUMMARY),
    neighborhood_drift_observation: AionisNeighborhoodDriftObservationSchema.default({
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      growth_threshold: 0,
      directional_drift_threshold: 0,
      isolation_threshold: 0,
      signal_memory_ids: [],
      candidate_count: 0,
      candidates: [],
      reason: "No neighborhood drift observation was supplied for this trace.",
    }),
    confidence_decay_candidate_summary: AionisConfidenceDecayCandidateSummarySchema.default({
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      agent_prompt_included: false,
      time_decay_age_threshold_days: 0,
      decay_candidate_memory_ids: [],
      candidate_from_learning_control_memory_ids: [],
      candidate_from_time_decay_memory_ids: [],
      supported_by_neighborhood_drift_memory_ids: [],
      drift_only_observation_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      blocked_by_recent_validation_memory_ids: [],
      time_decay_candidate_details: [],
      reason: "No confidence decay shadow candidate crossed the read-only gate.",
    }),
    inspect_before_use_shadow_delta: AionisInspectBeforeUseShadowDeltaSchema.default({
      present: false,
      contract_version: null,
      mode: null,
      enabled: false,
      authority_mutation: false,
      agent_prompt_included: false,
      simulated_surface: "inspect_before_use",
      candidate_memory_ids: [],
      would_move_to_inspect_before_use_memory_ids: [],
      already_inspect_before_use_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      blocked_by_recent_validation_memory_ids: [],
      drift_only_observation_memory_ids: [],
      entries: [],
      reason: "Inspect-before-use shadow delta is disabled and no confidence-decay candidates were supplied.",
    }),
    context_decision: z
      .object({
        prompt_char_count: z.number().int().nonnegative(),
        target_files: z.array(z.string().min(1)).default([]),
        use_now_count: z.number().int().nonnegative(),
        inspect_before_use_count: z.number().int().nonnegative(),
        do_not_use_count: z.number().int().nonnegative(),
        rehydrate_hint_count: z.number().int().nonnegative(),
        actionable_history_used: z.boolean().default(false),
        memory_ids: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    memory_use_receipt: AionisMemoryUseReceiptSchema.optional(),
    admission_record: AionisMemoryAdmissionRecordSchema.optional(),
    forget_decisions: z
      .array(
        z
          .object({
            action: z.enum(["suppress", "unsuppress", "rehydrate", "activate"]),
            target: z.enum(["pattern", "archive", "payload", "memory"]).nullable(),
            changed_count: z.number().nonnegative(),
            affected_memory_ids: z.array(z.string().min(1)).default([]),
            reason: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .default([]),
    source_map: z
      .object({
        routes_used: z.array(z.string().min(1)).default([]),
        internal_surfaces_used: z.array(z.string().min(1)).default([]),
        omitted_internal_surfaces: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict();

export type AionisMemoryDecisionTrace = z.infer<typeof AionisMemoryDecisionTraceSchema>;

export function parseAionisMemoryDecisionTrace(value: unknown): AionisMemoryDecisionTrace {
  return AionisMemoryDecisionTraceSchema.parse(value);
}

export const AionisMemoryDecisionAuditReportSchema = z
  .object({
    contract_version: z.literal("aionis_memory_decision_audit_report_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    intended_use: z.literal("operator_audit"),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    verdict: z.enum(["learning_control_visible", "no_history", "insufficient_trace"]),
    claims: z
      .array(
        z
          .object({
            claim: z.enum([
              "agent_prompt_excluded",
              "runtime_state_unchanged",
              "memory_lifecycle_visible",
              "negative_transfer_control_visible",
              "feedback_attribution_visible",
              "history_surface_compact",
            ]),
            status: z.enum(["pass", "fail", "not_applicable"]),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    counters: z
      .object({
        total_memory_count: z.number().int().nonnegative(),
        controlled_memory_count: z.number().int().nonnegative(),
        relation_count: z.number().int().nonnegative(),
        feedback_attribution_count: z.number().int().nonnegative(),
        feedback_threshold_met_count: z.number().int().nonnegative(),
        prompt_char_count: z.number().int().nonnegative(),
      })
      .strict(),
    risks: z
      .object({
        negative_transfer_risk: AionisRiskLevelSchema,
        unresolved_inspection_count: z.number().int().nonnegative(),
        blocked_or_suppressed_count: z.number().int().nonnegative(),
        reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    feedback_signal_review: z
      .object({
        present: z.boolean(),
        mode: z.literal("read_only_measure").nullable(),
        authority_mutation: z.literal(false),
        positive_attributed_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        weak_counter_signal_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        strong_counter_signal_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        relation_counter_signal_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        contradiction_warning_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        repeated_unattributed_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        repeated_unattributed_without_positive_memories: z.array(AionisAuditFeedbackSignalMemorySchema).default([]),
        read_only_signal_memory_ids: z.array(z.string().min(1)).default([]),
        candidate_learning_control_summary: AionisCandidateLearningControlSummarySchema.default({
          present: false,
          contract_version: null,
          mode: null,
          authority_mutation: false,
          candidate_inspect_before_use_memory_ids: [],
          candidate_from_threshold_met_memory_ids: [],
          candidate_from_repeated_unused_without_positive_memory_ids: [],
          blocked_by_positive_attribution_memory_ids: [],
          reason: "No sparse feedback signal crossed the candidate learning-control gate.",
        }),
        reason: z.string().min(1),
      })
      .strict(),
    judgment_calibration_review: AionisJudgmentCalibrationSummarySchema.default(DEFAULT_AIONIS_JUDGMENT_CALIBRATION_SUMMARY),
    neighborhood_drift_review: AionisNeighborhoodDriftObservationSchema.default({
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      growth_threshold: 0,
      directional_drift_threshold: 0,
      isolation_threshold: 0,
      signal_memory_ids: [],
      candidate_count: 0,
      candidates: [],
      reason: "No neighborhood drift observation was supplied for this audit report.",
    }),
    confidence_decay_candidate_review: AionisConfidenceDecayCandidateSummarySchema.default({
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      agent_prompt_included: false,
      time_decay_age_threshold_days: 0,
      decay_candidate_memory_ids: [],
      candidate_from_learning_control_memory_ids: [],
      candidate_from_time_decay_memory_ids: [],
      supported_by_neighborhood_drift_memory_ids: [],
      drift_only_observation_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      blocked_by_recent_validation_memory_ids: [],
      time_decay_candidate_details: [],
      reason: "No confidence decay shadow candidate crossed the read-only gate.",
    }),
    inspect_before_use_shadow_delta_review: AionisInspectBeforeUseShadowDeltaSchema.default({
      present: false,
      contract_version: null,
      mode: null,
      enabled: false,
      authority_mutation: false,
      agent_prompt_included: false,
      simulated_surface: "inspect_before_use",
      candidate_memory_ids: [],
      would_move_to_inspect_before_use_memory_ids: [],
      already_inspect_before_use_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      blocked_by_recent_validation_memory_ids: [],
      drift_only_observation_memory_ids: [],
      entries: [],
      reason: "Inspect-before-use shadow delta is disabled and no confidence-decay candidates were supplied.",
    }),
    decision_reviews: z
      .object({
        used_memories: z
          .array(
            z
              .object({
                memory_id: z.string().min(1),
                title: z.string().min(1).nullable(),
                authority: AionisGuidanceAuthoritySchema,
                confidence: ConfidenceSchema,
                salience: ConfidenceSchema,
                source_layer: AionisMemoryLayerSchema.nullable(),
                evidence_ids: z.array(z.string().min(1)).default([]),
                reason: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        downgraded_memories: z
          .array(
            z
              .object({
                memory_id: z.string().min(1),
                title: z.string().min(1).nullable(),
                by_memory_id: z.string().min(1),
                evidence_id: z.string().min(1),
                lifecycle_relation: AionisMemoryLifecycleRelationKindSchema,
                relation_confidence: ConfidenceSchema,
                producer: z.string().min(1),
                candidate_confidence: ConfidenceSchema.nullable(),
                signals: AionisMemoryLifecycleRelationSignalsSchema,
                gate: AionisMemoryLifecycleRelationGateSchema,
                reasons: z.array(z.string().min(1)).default([]),
              })
              .strict(),
          )
          .default([]),
        blocked_memories: z
          .array(
            z
              .object({
                memory_id: z.string().min(1),
                title: z.string().min(1).nullable(),
                blocked_by: z.enum([
                  "scope_mismatch",
                  "suppressed_lifecycle",
                  "archived_lifecycle",
                  "blocked_authority",
                  "low_authority",
                  "agent_surface_projection",
                  "unknown",
                ]),
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
                authority: AionisGuidanceAuthoritySchema,
                reason: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        rehydrate_memories: z
          .array(
            z
              .object({
                memory_id: z.string().min(1),
                title: z.string().min(1).nullable(),
                mode: z.enum(["summary_only", "partial", "full", "differential"]),
                required: z.boolean(),
                payload_status: z.enum(["cold_payload", "summary_only", "unknown"]),
                reason: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
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

export type AionisMemoryDecisionAuditReport = z.infer<typeof AionisMemoryDecisionAuditReportSchema>;

export function parseAionisMemoryDecisionAuditReport(value: unknown): AionisMemoryDecisionAuditReport {
  return AionisMemoryDecisionAuditReportSchema.parse(value);
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
        [AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD]: z.number().int().nonnegative(),
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
  "trace_derived_skill",
]);
export type AionisTrainingCandidateType = z.infer<typeof AionisTrainingCandidateTypeSchema>;

export const AionisTraceDerivedSkillCandidateSchema = z
  .object({
    contract_version: z.literal("aionis_trace_derived_skill_candidate_v1"),
    skill_name: z.string().min(1).max(160),
    source_trace_ids: z.array(z.string().min(1).max(256)).min(1).max(64),
    source_signal_ids: z.array(z.string().min(1).max(256)).default([]),
    applies_when: z.array(z.string().min(1).max(512)).min(1).max(16),
    does_not_apply_when: z.array(z.string().min(1).max(512)).default([]),
    procedure_steps: z.array(z.string().min(1).max(1024)).min(1).max(16),
    target_files: z.array(z.string().min(1).max(512)).default([]),
    acceptance_checks: z.array(z.string().min(1).max(512)).default([]),
    failure_counterexamples: z.array(z.string().min(1).max(512)).default([]),
    evidence_refs: z.array(z.string().min(1).max(256)).default([]),
    authority_state: z.literal("candidate"),
    promotion_status: z.enum(["candidate_only", "needs_feedback_attribution", "promotion_ready"]),
    export_policy: z
      .object({
        agent_prompt_included: z.literal(false),
        runtime_mutation: z.literal(false),
        required_gate: z.literal("admission_and_promotion_gate"),
      })
      .strict(),
  })
  .strict();

export type AionisTraceDerivedSkillCandidate = z.infer<typeof AionisTraceDerivedSkillCandidateSchema>;

export const AionisProcedureMemoryDraftV1Schema = z
  .object({
    contract_version: z.literal("aionis_procedure_memory_draft_v1"),
    source_candidate_id: z.string().min(1).max(256),
    source: z.literal("trace_derived_skill"),
    memory_kind: z.literal("procedure"),
    authority_state: z.literal("reviewed_candidate"),
    skill_name: z.string().min(1).max(160),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4096),
    source_trace_ids: z.array(z.string().min(1).max(256)).min(1).max(64),
    source_signal_ids: z.array(z.string().min(1).max(256)).default([]),
    applies_when: z.array(z.string().min(1).max(512)).min(1).max(16),
    does_not_apply_when: z.array(z.string().min(1).max(512)).default([]),
    procedure_steps: z.array(z.string().min(1).max(1024)).min(1).max(16),
    target_files: z.array(z.string().min(1).max(512)).default([]),
    acceptance_checks: z.array(z.string().min(1).max(512)).default([]),
    failure_counterexamples: z.array(z.string().min(1).max(512)).default([]),
    evidence_refs: z.array(z.string().min(1).max(256)).default([]),
    review: z
      .object({
        review_status: z.literal("promoted"),
        reviewer_id: z.string().min(1).max(256).nullable(),
        review_reason: z.string().min(1).max(2048).nullable(),
        reviewed_at: z.string().datetime().nullable(),
        candidate_reason: z.string().min(1).max(2048),
        label: z.enum(["positive", "negative", "neutral", "blocked", "insufficient_evidence"]),
        promotion_status: z.literal("promotion_ready"),
        export_ready: z.literal(true),
      })
      .strict(),
    write_policy: z
      .object({
        requires_observe_commit: z.literal(true),
        agent_prompt_included: z.literal(false),
        runtime_mutation: z.literal(false),
        required_gate: z.literal("observe_commit_and_admission_gate"),
      })
      .strict(),
  })
  .strict();

export type AionisProcedureMemoryDraftV1 = z.infer<typeof AionisProcedureMemoryDraftV1Schema>;

const AionisTrainingCandidateSchema = z
  .object({
    candidate_type: AionisTrainingCandidateTypeSchema,
    source_ids: z.array(z.string().min(1)).min(1),
    label: z.enum(["positive", "negative", "neutral", "blocked", "insufficient_evidence"]),
    export_ready: z.boolean(),
    reason: z.string().min(1),
    trace_derived_skill: AionisTraceDerivedSkillCandidateSchema.optional(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.candidate_type === "trace_derived_skill" && !candidate.trace_derived_skill) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trace_derived_skill"],
        message: "trace_derived_skill payload is required for trace_derived_skill candidates",
      });
    }
    if (candidate.candidate_type !== "trace_derived_skill" && candidate.trace_derived_skill) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trace_derived_skill"],
        message: "trace_derived_skill payload is only allowed for trace_derived_skill candidates",
      });
    }
  });

const AionisEffectFeedbackSignalSummarySchema = z
  .object({
    present: z.boolean(),
    source: z.enum(["memory_decision_audit", "not_supplied"]),
    authority_mutation: z.literal(false),
    positive_attributed_memory_ids: z.array(z.string().min(1)).default([]),
    weak_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
    strong_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
    relation_counter_signal_memory_ids: z.array(z.string().min(1)).default([]),
    contradiction_warning_memory_ids: z.array(z.string().min(1)).default([]),
    repeated_unattributed_memory_ids: z.array(z.string().min(1)).default([]),
    repeated_unattributed_without_positive_memory_ids: z.array(z.string().min(1)).default([]),
    read_only_signal_memory_ids: z.array(z.string().min(1)).default([]),
    explanation: z.string().min(1),
  })
  .strict();

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
        useful_continuity_delta: z.number().nullable().optional(),
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
    feedback_signal_summary: AionisEffectFeedbackSignalSummarySchema,
    neighborhood_drift_summary: AionisEffectNeighborhoodDriftSummarySchema.default({
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      signal_memory_ids: [],
      candidate_count: 0,
      explanation: "No memory decision audit neighborhood drift review was supplied for this effect report.",
    }),
    confidence_decay_summary: AionisEffectConfidenceDecaySummarySchema.default({
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      time_decay_age_threshold_days: 0,
      decay_candidate_memory_ids: [],
      candidate_from_time_decay_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      supported_by_neighborhood_drift_memory_ids: [],
      explanation: "No memory decision audit confidence decay review was supplied for this effect report.",
    }),
    training_candidates: z
      .array(AionisTrainingCandidateSchema)
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

const AionisOperatorSnapshotClaimStatusSchema = z.enum(["pass", "fail", "warning", "not_applicable"]);

const AionisOperatorSnapshotEntrySchema = z
  .object({
    entry_id: z.string().min(1),
    title: z.string().min(1).nullable(),
    summary: z.string().min(1),
    source: z.enum(["agent_context", "execution_context", "guide_packet", "memory_decision_trace", "memory_decision_audit", "effect_report", "unknown"]),
    memory_ids: z.array(z.string().min(1)).default([]),
    evidence_refs: z.array(z.string().min(1)).default([]),
  })
  .strict();

const AionisTraceToProcedureSourceSurfaceSchema = z.enum([
  "execution_tree",
  "workflow_projection",
  "replay_playbook",
  "execution_contract",
  "memory_decision_trace",
  "promotion_evidence",
]);

const AionisTraceToProcedurePromotionStatusSchema = z.enum([
  "stable_ready",
  "candidate_only",
  "blocked",
  "insufficient_evidence",
  "not_applicable",
]);

export const AionisOperatorSnapshotSchema = z
  .object({
    contract_version: z.literal("aionis_operator_snapshot_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    intended_use: z.literal("operator_snapshot"),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    task: z
      .object({
        run_id: z.string().min(1).nullable(),
        task_signature: z.string().min(1).nullable(),
        task_family: z.string().min(1).nullable(),
        workflow_signature: z.string().min(1).nullable(),
        agent_role: AionisAgentRoleSchema,
      })
      .strict(),
    execution_state: z
      .object({
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
        active_path: z
          .object({
            count: z.number().int().nonnegative(),
            entries: z.array(AionisOperatorSnapshotEntrySchema).default([]),
          })
          .strict(),
        passed_solutions: z
          .object({
            count: z.number().int().nonnegative(),
            entries: z.array(AionisOperatorSnapshotEntrySchema).default([]),
          })
          .strict(),
        failed_branches: z
          .object({
            count: z.number().int().nonnegative(),
            entries: z.array(AionisOperatorSnapshotEntrySchema).default([]),
          })
          .strict(),
        branch_isolation: z
          .object({
            active_path_visible: z.boolean(),
            passed_solution_visible: z.boolean(),
            failed_branch_visible_in_do_not_use: z.boolean(),
            failed_branch_leaked_to_use_now: z.boolean(),
            status: z.enum(["pass", "fail", "not_applicable"]),
            reason: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    trace_to_procedure: z
      .object({
        present: z.boolean(),
        runtime_mutation: z.literal(false),
        source_surfaces: z.array(AionisTraceToProcedureSourceSurfaceSchema).default([]),
        procedure_memory_ids: z.array(z.string().min(1)).default([]),
        workflow_ids: z.array(z.string().min(1)).default([]),
        evidence_refs: z.array(z.string().min(1)).default([]),
        candidate_visible: z.boolean(),
        stable_reuse_visible: z.boolean(),
        promotion_status: AionisTraceToProcedurePromotionStatusSchema,
        promotion_blocked_count: z.number().int().nonnegative(),
        reason: z.string().min(1),
      })
      .strict(),
    guide_trace: z
      .object({
        present: z.boolean(),
        guide_trace_id: z.string().min(1).nullable(),
        exposed_memory_ids: z.array(z.string().min(1)).default([]),
        use_now_memory_ids: z.array(z.string().min(1)).default([]),
        inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
        do_not_use_memory_ids: z.array(z.string().min(1)).default([]),
        attributed_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_memory_ids: z.array(z.string().min(1)).default([]),
        feedback_attribution_present: z.boolean(),
        feedback_outcome: z.enum(["positive", "negative", "neutral"]).nullable(),
        reason: z.string().min(1),
      })
      .strict(),
    judgment_calibration: AionisJudgmentCalibrationSummarySchema.default(DEFAULT_AIONIS_JUDGMENT_CALIBRATION_SUMMARY),
    memory_use_receipt: AionisMemoryUseReceiptSchema,
    memory_admission_record: AionisMemoryAdmissionRecordSchema.optional(),
    claim_ledger_projection: AionisClaimLedgerProjectionSchema.optional(),
    memory_lifecycle: z
      .object({
        used_count: z.number().int().nonnegative(),
        inspect_before_use_count: z.number().int().nonnegative(),
        do_not_use_count: z.number().int().nonnegative(),
        rehydrate_count: z.number().int().nonnegative(),
        controlled_memory_count: z.number().int().nonnegative(),
        blocked_or_suppressed_count: z.number().int().nonnegative(),
        stale_memory_count: z.number().int().nonnegative(),
        learning_control_visible: z.boolean(),
        consolidation_guard: z
          .object({
            supporting_only_count: z.number().int().nonnegative(),
            candidate_only_count: z.number().int().nonnegative(),
            promotion_blocked_count: z.number().int().nonnegative(),
            reason: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    learning_control: z
      .object({
        visible: z.boolean(),
        runtime_mutation: z.literal(false),
        stable_promotion_allowed: z.boolean().nullable(),
        candidate_count: z.number().int().nonnegative(),
        blocked_authority_count: z.number().int().nonnegative(),
        promotion_denied_reasons: z.array(z.string().min(1)).default([]),
        reason: z.string().min(1),
      })
      .strict(),
    effect: z
      .object({
        present: z.boolean(),
        impact_direction: AionisEffectImpactDirectionSchema.nullable(),
        changed_future_behavior: z.boolean().nullable(),
        token_delta: z.number().nullable(),
        context_size_delta: z.number().nullable(),
        repeated_discovery_delta: z.number().nullable(),
        reason: z.string().min(1),
      })
      .strict(),
    claims: z
      .array(
        z
          .object({
            claim: z.enum([
              "active_path_visible",
              "failed_branch_isolated",
              "feedback_attribution_visible",
              "learning_control_visible",
              "memory_use_receipt_visible",
              "judgment_calibration_visible",
              "trace_to_procedure_visible",
              "claim_ledger_projection_visible",
              "runtime_read_only",
              "effect_measured",
            ]),
            status: AionisOperatorSnapshotClaimStatusSchema,
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    risks: z
      .object({
        negative_transfer_risk: AionisRiskLevelSchema,
        blocked_or_suppressed_count: z.number().int().nonnegative(),
        unresolved_inspection_count: z.number().int().nonnegative(),
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

export type AionisOperatorSnapshot = z.infer<typeof AionisOperatorSnapshotSchema>;

export function parseAionisOperatorSnapshot(value: unknown): AionisOperatorSnapshot {
  return AionisOperatorSnapshotSchema.parse(value);
}

export const AionisAgentFlightRecorderReportSchema = z
  .object({
    contract_version: z.literal("aionis_agent_flight_recorder_report_v1"),
    tenant_id: z.string().min(1),
    scope: z.string().min(1),
    intended_use: z.literal("incident_replay_audit"),
    agent_prompt_included: z.literal(false),
    runtime_mutation: z.literal(false),
    guide_trace_id: z.string().min(1).nullable(),
    run_id: z.string().min(1).nullable(),
    decision_time: z.string().datetime(),
    agent_view: z
      .object({
        history_used: z.boolean(),
        actionable_history_used: z.boolean(),
        recommended_posture: z.enum([
          "reuse_supported_history",
          "use_as_context",
          "inspect_before_use",
          "rehydrate_before_use",
          "ignore_history",
        ]),
        authority: AionisGuidanceAuthoritySchema,
        prompt_char_count: z.number().int().nonnegative(),
        prompt_text_included: z.literal(false),
        exposed_memory_ids: z.array(z.string().min(1)).default([]),
        use_now_memory_ids: z.array(z.string().min(1)).default([]),
        inspect_before_use_memory_ids: z.array(z.string().min(1)).default([]),
        do_not_use_memory_ids: z.array(z.string().min(1)).default([]),
        rehydrate_memory_ids: z.array(z.string().min(1)).default([]),
        target_files: z.array(z.string().min(1)).default([]),
        recall_sources_by_memory_id: z
          .array(
            z
              .object({
                memory_id: z.string().min(1),
                recall_sources: z.array(AionisRecallSourceTraceSchema).default([]),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
    blocked_or_suppressed: z
      .array(
        z
          .object({
            memory_id: z.string().min(1),
            title: z.string().min(1).nullable(),
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
            authority: AionisGuidanceAuthoritySchema,
            agent_surface: AionisMemoryDecisionSurfaceSchema,
            reason_codes: z.array(z.string().min(1)).default([]),
            recall_sources: z.array(AionisRecallSourceTraceSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    claim_ledger_projection: AionisClaimLedgerProjectionSchema.optional(),
    attribution: z
      .object({
        present: z.boolean(),
        outcome: AionisFeedbackOutcomeSchema.nullable(),
        used_memory_ids: z.array(z.string().min(1)).default([]),
        attributed_memory_ids: z.array(z.string().min(1)).default([]),
        unattributed_memory_ids: z.array(z.string().min(1)).default([]),
        supported_memory_ids: z.array(z.string().min(1)).default([]),
        contradicted_memory_ids: z.array(z.string().min(1)).default([]),
        reason: z.string().min(1),
      })
      .strict(),
    replay_sources: z
      .object({
        has_agent_context: z.boolean(),
        has_memory_decision_trace: z.boolean(),
        has_memory_use_receipt: z.boolean(),
        has_memory_admission_record: z.boolean(),
        has_operator_snapshot: z.boolean(),
        has_feedback_result: z.boolean(),
      })
      .strict(),
    claims: z
      .array(
        z
          .object({
            claim: z.enum([
              "agent_view_reconstructable",
              "prompt_payload_excluded",
              "blocked_memory_visible",
              "claim_ledger_projection_replayable",
              "feedback_attribution_replayable",
              "runtime_read_only",
            ]),
            status: z.enum(["pass", "warn", "fail"]),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    source_map: z
      .object({
        routes_used: z.array(z.string().min(1)).default([]),
        internal_surfaces_used: z.array(z.string().min(1)).default([]),
        omitted_internal_surfaces: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    summary: z.string().min(1),
  })
  .strict();

export type AionisAgentFlightRecorderReport = z.infer<typeof AionisAgentFlightRecorderReportSchema>;

export function parseAionisAgentFlightRecorderReport(value: unknown): AionisAgentFlightRecorderReport {
  return AionisAgentFlightRecorderReportSchema.parse(value);
}
