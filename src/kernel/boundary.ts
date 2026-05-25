export type AionisKernelCapabilityId =
  | "continuity"
  | "learning"
  | "forgetting"
  | "learning_control";

export type AionisRuntimeLayerId =
  | "core_runtime"
  | "real_eval_harness"
  | "experimental_policy";

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

export type AionisRuntimeLayerBoundary = {
  id: AionisRuntimeLayerId;
  display_name: string;
  owns: readonly string[];
  may_produce: readonly string[];
  must_not_own: readonly string[];
  promotion_rule: string;
};

export type AionisExperimentalPolicySurface = {
  id: string;
  layer: "experimental_policy";
  default_authority: Exclude<AionisPolicyAuthorityLevel, "hard_invariant">;
  owns: readonly string[];
  must_not_do: readonly string[];
  promotion_rule: string;
};

export const AIONIS_KERNEL_BOUNDARY_VERSION = "aionis_focused_kernel_boundary_v1";

export const AIONIS_KERNEL_PRODUCT_CLAIM =
  "local_execution_memory_runtime_for_agent_continuity_learning_forgetting_and_learning_control";

export const AIONIS_KERNEL_FORBIDDEN_SURFACES = [
  "host-specific-agent-adapter",
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

export const AIONIS_RUNTIME_LAYER_BOUNDARY_VERSION = "aionis_runtime_layer_boundary_v1";

export const AIONIS_RUNTIME_LAYER_BOUNDARIES = [
  {
    id: "core_runtime",
    display_name: "Core Runtime",
    owns: [
      "execution_continuity",
      "evidence_grading",
      "persistent_cognitive_structure",
      "context_packet_assembly",
      "learning_candidate_lifecycle",
      "workflow_promotion",
      "controlled_forgetting",
    ],
    may_produce: [
      "runtime_context_packet",
      "cognitive_structure",
      "evidence_report",
      "learning_candidate",
      "workflow_lifecycle_decision",
      "forgetting_decision",
    ],
    must_not_own: [
      "external_project_verifier_logic",
      "llm_provider_benchmarking",
      "task_specific_repair_rules",
      "eval_runner_tool_policy",
      "testing_method_preference",
    ],
    promotion_rule:
      "Core Runtime may promote memory only from scoped execution evidence and learning-control gates, never from a single eval heuristic.",
  },
  {
    id: "real_eval_harness",
    display_name: "Real Eval Harness",
    owns: [
      "real_llm_provider_calls",
      "isolated_workspace_setup",
      "baseline_vs_aionis_comparison",
      "external_project_verifier_execution",
      "effect_gate_reporting",
    ],
    may_produce: [
      "real_eval_report",
      "effect_gate_result",
      "provider_health_result",
      "holdout_regression_evidence",
    ],
    must_not_own: [
      "runtime_memory_promotion",
      "core_context_packet_contract",
      "product_default_policy",
      "persistent_user_task_rule",
    ],
    promotion_rule:
      "Real eval evidence can support promotion, but the harness itself cannot become Core Runtime policy.",
  },
  {
    id: "experimental_policy",
    display_name: "Experimental Policy",
    owns: [
      "verifier_phase_classification",
      "edit_boundary_experiments",
      "tool_recovery_hints",
      "repair_plan_candidates",
      "task_family_hypotheses",
    ],
    may_produce: [
      "soft_guidance",
      "repair_candidate",
      "counter_evidence",
      "promotion_candidate",
    ],
    must_not_own: [
      "global_hard_rule",
      "unscoped_workflow_promotion",
      "cross_project_authority",
      "core_runtime_identity",
    ],
    promotion_rule:
      "Experimental policy must stay scoped and advisory until repeated real runs plus holdout/regression evidence promote it.",
  },
] as const satisfies readonly AionisRuntimeLayerBoundary[];

export const AIONIS_CORE_HARD_INVARIANTS = [
  "do_not_apply_unverified_authority",
  "quarantine_provider_or_protocol_failures_from_learning_promotion",
  "workflow_promotion_requires_real_outcome_evidence",
  "make_blocked_or_suppressed_authority_visible",
] as const;

export const AIONIS_EXPERIMENTAL_POLICY_SURFACES = [
  {
    id: "verifier_phase_classifier",
    layer: "experimental_policy",
    default_authority: "soft_guidance",
    owns: [
      "failure_phase_summary",
      "primary_file_hint",
      "line_hint",
      "next_action_candidate",
    ],
    must_not_do: [
      "promote_without_verifier_success",
      "override_core_evidence_grade",
      "become_global_without_holdout",
    ],
    promotion_rule:
      "May become candidate_workflow only after the scoped task passes a real verifier and a holdout run shows no regression.",
  },
  {
    id: "edit_boundary_and_tool_recovery",
    layer: "experimental_policy",
    default_authority: "soft_guidance",
    owns: [
      "allowed_file_hint",
      "stale_anchor_recovery",
      "tool_payload_shape_hint",
      "repeated_edit_failure_counter_evidence",
    ],
    must_not_do: [
      "block_core_runtime_memory",
      "turn_project_specific_paths_into_global_rules",
      "hide_llm_exploration_without_evidence",
    ],
    promotion_rule:
      "May stay hard only inside a real eval task sandbox; product Runtime should receive it as scoped guidance unless promoted by real verifier success plus holdout evidence.",
  },
  {
    id: "repair_plan_classifier",
    layer: "experimental_policy",
    default_authority: "candidate_workflow",
    owns: [
      "semantic_repair_hypothesis",
      "typed_repair_plan_candidate",
      "escape_condition",
      "counter_evidence_capture",
    ],
    must_not_do: [
      "claim_success_without_verifier",
      "persist_as_authority_from_failed_runs",
      "replace_llm_semantic_reasoning_with_unscoped_rules",
    ],
    promotion_rule:
      "Only successful real verifier evidence can promote a repair plan; failed runs produce candidates or counter-evidence only.",
  },
] as const satisfies readonly AionisExperimentalPolicySurface[];

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
      "adapter_installation",
      "chat_transcript_storage_as_primary_value",
      "product_ui_state",
    ],
    primary_runtime_surfaces: [
      "/v1/memory/planning/context",
      "/v1/memory/context/assemble",
      "/v1/handoff/store",
      "/v1/handoff/recover",
      "/v1/memory/execution/introspect",
    ],
    success_signals: [
      "resume packet names the current state",
      "verified facts survive process boundaries",
      "first action avoids repeated discovery",
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
      "unverified_authoritative_reuse",
    ],
    primary_runtime_surfaces: [
      "/v1/memory/replay/run/*",
      "/v1/memory/replay/playbooks/*",
      "/v1/memory/tools/feedback",
      "/v1/memory/tools/select",
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
      "/v1/memory/archive/rehydrate",
      "/v1/memory/nodes/activate",
      "/v1/memory/anchors/rehydrate-payload",
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
      "/v1/memory/policies/learning-control/apply",
      "/v1/memory/continuity/review-pack",
      "/v1/memory/evolution/review-pack",
      "/v1/runtime/boundary/inventory",
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

export function aionisRuntimeLayerIds(): AionisRuntimeLayerId[] {
  return AIONIS_RUNTIME_LAYER_BOUNDARIES.map((layer) => layer.id);
}
