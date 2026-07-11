export type AionisKernelCapabilityId =
  | "continuity"
  | "learning"
  | "forgetting"
  | "learning_control";

export type AionisPolicyAuthorityLevel =
  | "hard_invariant"
  | "soft_guidance"
  | "candidate_workflow"
  | "retired";

export type AionisKernelCapability = {
  id: AionisKernelCapabilityId;
  display_name: string;
  purpose: string;
  agent_effect: string;
  owns: readonly string[];
  must_not_own: readonly string[];
  primary_runtime_surfaces: readonly string[];
  success_signals: readonly string[];
};

export const AIONIS_KERNEL_BOUNDARY_VERSION = "aionis_focused_kernel_boundary_v1";

export const AIONIS_KERNEL_PRODUCT_CLAIM =
  "local_execution_memory_runtime_for_agent_continuity_learning_forgetting_and_learning_control";

export const AIONIS_KERNEL_FORBIDDEN_SURFACES = [
  "external-agent-framework-product",
  "aionis-doc",
  "docs-site",
  "inspector-product-ui",
  "playground",
  "marketing-site",
  "automation-product",
  "cloud-control-plane",
  "admin-control",
  "multi-tenant-platform-control",
] as const;

export const AIONIS_CORE_HARD_INVARIANTS = [
  "do_not_apply_unverified_authority",
  "quarantine_provider_or_protocol_failures_from_learning_promotion",
  "workflow_promotion_requires_real_outcome_evidence",
  "make_blocked_or_suppressed_authority_visible",
] as const;

export const AIONIS_KERNEL_CAPABILITIES = [
  {
    id: "continuity",
    display_name: "Execution Continuity",
    purpose: "carry execution state across task starts, handoffs, resumes, and verified next actions",
    agent_effect: "the next run starts from proven state instead of rediscovering prior work",
    owns: [
      "task_start",
      "handoff_recovery",
      "execution_packet",
      "verified_facts",
      "next_action_packet",
      "workflow_continuity",
    ],
    must_not_own: [
      "agent_framework_integration",
      "chat_transcript_storage_as_primary_value",
      "product_ui_state",
    ],
    primary_runtime_surfaces: [
      "/v1/guide",
      "/v1/handoff/store",
      "/v1/handoff/recover",
      "service:planning_context",
      "service:execution_context",
    ],
    success_signals: [
      "resume packet names the current state",
      "verified facts survive process boundaries",
      "continuity signal avoids repeated discovery",
    ],
  },
  {
    id: "learning",
    display_name: "Evidence-Gated Self-Learning",
    purpose: "turn execution evidence into reusable workflows, patterns, tool preferences, and project rules",
    agent_effect: "similar future tasks reuse proven execution paths with less trial and error",
    owns: [
      "replay_learning",
      "policy_mutation_candidates",
      "workflow_promotion",
      "pattern_promotion",
      "tool_feedback_learning",
      "policy_memory_materialization",
      "counter_evidence_demotions",
    ],
    must_not_own: [
      "metrics_only_promotion",
      "one_success_equals_truth",
      "runtime_semantic_patch_generation",
      "unverified_authoritative_reuse",
    ],
    primary_runtime_surfaces: [
      "service:replay_evidence",
      "service:replay_playbook",
      "/v1/guide",
      "/v1/feedback",
      "service:learning_kernel",
    ],
    success_signals: [
      "candidate memory stays provisional until gates pass",
      "successful repeated evidence can promote stable workflows",
      "project experience mutates scoped memory rather than source code",
      "negative feedback demotes learned patterns",
    ],
  },
  {
    id: "forgetting",
    display_name: "Controlled Forgetting",
    purpose: "reduce memory pollution through importance scoring, demotion, archive, retirement, and rehydration",
    agent_effect: "future context stays useful because stale, weak, or contradicted memory cools down",
    owns: [
      "importance_dynamics",
      "semantic_forgetting",
      "archive_relocation",
      "differential_rehydration",
      "node_activation",
      "lifecycle_summaries",
    ],
    must_not_own: [
      "blind_deletion",
      "unbounded_context_accumulation",
      "irreversible_loss_without_archive",
    ],
    primary_runtime_surfaces: [
      "/v1/forget",
      "/v1/rehydrate",
      "service:memory_lifecycle",
      "service:anchor_payload_rehydration",
    ],
    success_signals: [
      "contested memory demotes before archive",
      "retired policy memory cools out of default recall",
      "cold memory can be rehydrated when needed",
    ],
  },
  {
    id: "learning_control",
    display_name: "Learning Control",
    purpose: "control which learned memories can become trusted, authoritative, suppressed, contested, retired, or reactivated",
    agent_effect: "self-learning improves behavior without letting weak evidence become durable authority",
    owns: [
      "authority_gate",
      "self_modifying_policy_loop",
      "trust_levels",
      "promotion_admissibility",
      "suppression_overlays",
      "review_packets",
      "learning_lifecycle_control",
    ],
    must_not_own: [
      "admin_control_plane",
      "enterprise_compliance_console",
      "multi_tenant_policy_administration",
      "cloud_platform_control",
    ],
    primary_runtime_surfaces: [
      "service:learning_control_policy",
      "service:continuity_review",
      "service:evolution_review",
      "/v1/runtime/boundary-inventory",
    ],
    success_signals: [
      "authority requires explicit outcome evidence",
      "advisory memory remains advisory until promoted",
      "blocked authority is visible to the next run",
    ],
  },
] as const satisfies readonly AionisKernelCapability[];

export function aionisKernelCapabilityIds(): AionisKernelCapabilityId[] {
  return AIONIS_KERNEL_CAPABILITIES.map((capability) => capability.id);
}

export function aionisKernelCapability(id: AionisKernelCapabilityId): AionisKernelCapability {
  const capability = AIONIS_KERNEL_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) throw new Error(`Unknown Aionis kernel capability: ${id}`);
  return capability;
}
