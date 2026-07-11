import type {
  AssemblySummary,
  PlanningSummary,
} from "../../app/planning-summary.js";
import type {
  AionisEffectReport as KernelEffectReport,
  EffectKernelComparison,
} from "../../kernel/effect-evaluator.js";
import {
  parseAionisEffectReport,
  parseAionisLearningPacket,
  type AionisEffectReport,
  type AionisLearningPacket,
  type AionisMemoryDecisionAuditReport,
  type AionisTraceDerivedSkillCandidate,
} from "../product-output-contract.js";
import {
  authorityConsumptionStablePromotionBlockedCount,
} from "../authority-consumption.js";
import { AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD } from "../product-output-contract.js";
import {
  ProductActor,
  ProductTask,
  asTask,
  compactStrings,
} from "./memory-packet.js";

type ProductImpactDirection = AionisEffectReport["history_impact"]["impact_direction"];

type TrainingCandidateType = AionisEffectReport["training_candidates"][number]["candidate_type"];

type TrainingCandidateLabel = AionisEffectReport["training_candidates"][number]["label"];

type LearningCandidate = AionisLearningPacket["candidates"][number];

type LearningPosture = AionisLearningPacket["posture"]["recommended_learning_posture"];

type LearningAuthority = AionisLearningPacket["posture"]["authority"];

export type BuildAionisEffectReportArgs = {
  tenant_id: string;
  scope: string;
  task?: ProductTask;
  report: KernelEffectReport;
  comparison?: Partial<AionisEffectReport["comparison"]>;
  evidence_ids?: string[];
  feedback_signal_review?: AionisMemoryDecisionAuditReport["feedback_signal_review"] | null;
  neighborhood_drift_review?: AionisMemoryDecisionAuditReport["neighborhood_drift_review"] | null;
  confidence_decay_review?: AionisMemoryDecisionAuditReport["confidence_decay_candidate_review"] | null;
};

export type BuildAionisLearningPacketArgs = {
  tenant_id: string;
  scope: string;
  actor?: ProductActor;
  task?: ProductTask;
  planning: PlanningSummary | AssemblySummary;
  source_map?: Partial<AionisLearningPacket["source_map"]>;
};

function learningPosture(planning: PlanningSummary | AssemblySummary): LearningPosture {
  const control = planning.history_impact_summary.learning_control;
  const forgetting = planning.forgetting_summary.semantic_action_counts;
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(control);
  if (
    control.action_start_blocked
    || control.authoritative_blocked_count > 0
    || stablePromotionBlockedCount > 0
    || planning.authority_visibility_summary.false_confidence_count > 0
  ) {
    return "constrain";
  }
  if (
    planning.pattern_lifecycle_summary.counter_evidence_open_count > 0
    || planning.policy_lifecycle_summary.contested_count > 0
    || forgetting.demote > 0
    || forgetting.archive > 0
  ) {
    return "invalidate";
  }
  if (
    control.stable_promotion_allowed_count > 0
    || planning.workflow_lifecycle_summary.promotion_ready_count > 0
    || planning.workflow_signal_summary.promotion_ready_workflow_count > 0
  ) {
    return "promotion_ready";
  }
  if (
    planning.workflow_lifecycle_summary.candidate_count > 0
    || planning.action_packet_summary.candidate_workflow_count > 0
    || planning.action_packet_summary.candidate_pattern_count > 0
  ) {
    return "candidate_only";
  }
  return "insufficient_evidence";
}

function learningAuthority(args: {
  posture: LearningPosture;
  planning: PlanningSummary | AssemblySummary;
}): LearningAuthority {
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(
    args.planning.history_impact_summary.learning_control,
  );
  if (
    args.planning.history_impact_summary.learning_control.action_start_blocked
    || stablePromotionBlockedCount > 0
    || args.planning.history_impact_summary.learning_control.authoritative_blocked_count > 0
  ) {
    return "blocked";
  }
  if (args.posture === "promotion_ready") return "advisory";
  if (args.posture === "insufficient_evidence") return "none";
  return "candidate";
}

function learningPostureReason(args: {
  posture: LearningPosture;
  planning: PlanningSummary | AssemblySummary;
}): string {
  const control = args.planning.history_impact_summary.learning_control;
  const blockers = compactStrings([
    ...control.primary_blockers,
    ...args.planning.authority_visibility_summary.top_blockers,
    args.planning.forgetting_summary.primary_forgetting_reason,
  ]);
  if (blockers.length > 0) return blockers.join("; ");
  if (args.posture === "promotion_ready") return "Existing learning evidence is promotion-ready, but product authority remains evidence-scoped.";
  if (args.posture === "candidate_only") return "Learning candidates are visible but do not have enough evidence for stable authority.";
  if (args.posture === "invalidate") return "Counter-evidence or forgetting signals indicate candidate invalidation or demotion review.";
  if (args.posture === "constrain") return "Learning-control or authority gates limit how far history can shape future behavior.";
  return "No learning evidence was strong enough to shape future behavior.";
}

function buildLearningCandidates(planning: PlanningSummary | AssemblySummary): LearningCandidate[] {
  const candidates: LearningCandidate[] = [];
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(
    planning.history_impact_summary.learning_control,
  );
  for (const workflowId of planning.action_packet_summary.candidate_workflow_anchor_ids) {
    candidates.push({
      candidate_id: workflowId,
      kind: "workflow",
      authority: stablePromotionBlockedCount > 0 ? "blocked" : "candidate",
      evidence_count: Math.max(1, planning.workflow_lifecycle_summary.candidate_count),
      promotion_state: planning.workflow_lifecycle_summary.promotion_ready_count > 0 ? "promotion_ready" : "candidate",
      source_ids: [workflowId],
      reason: "Workflow candidate is visible but must remain scoped until evidence gates admit promotion.",
    });
  }
  for (const patternId of planning.action_packet_summary.candidate_pattern_anchor_ids) {
    candidates.push({
      candidate_id: patternId,
      kind: "pattern",
      authority: "candidate",
      evidence_count: Math.max(1, planning.pattern_lifecycle_summary.candidate_count),
      promotion_state: "candidate",
      source_ids: [patternId],
      reason: "Pattern candidate has not passed stable promotion evidence.",
    });
  }
  for (const patternId of planning.action_packet_summary.contested_pattern_anchor_ids) {
    candidates.push({
      candidate_id: patternId,
      kind: "pattern",
      authority: "blocked",
      evidence_count: Math.max(1, planning.pattern_lifecycle_summary.contested_count),
      promotion_state: "contested",
      source_ids: [patternId],
      reason: "Contested pattern is visible for review, not stable reuse.",
    });
  }
  return candidates.slice(0, 32);
}

export function buildAionisLearningPacket(args: BuildAionisLearningPacketArgs): AionisLearningPacket {
  const posture = learningPosture(args.planning);
  const authority = learningAuthority({ posture, planning: args.planning });
  const control = args.planning.history_impact_summary.learning_control;
  const stablePromotionBlockedCount = authorityConsumptionStablePromotionBlockedCount(control);
  const stablePromotionAllowed = control.stable_promotion_allowed_count > 0 && stablePromotionBlockedCount === 0;
  const promotionDeniedReasons = compactStrings([
    ...control.primary_blockers,
    ...args.planning.authority_visibility_summary.top_blockers,
  ]);

  return parseAionisLearningPacket({
    contract_version: "aionis_learning_packet_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor: args.actor,
    task: asTask(args.task),
    posture: {
      recommended_learning_posture: posture,
      authority,
      source_code_change_allowed: false,
      stable_promotion_allowed: stablePromotionAllowed,
      reason: learningPostureReason({ posture, planning: args.planning }),
    },
    candidates: buildLearningCandidates(args.planning),
    learning_control: {
      contract_trust: control.contract_trust,
      action_start_blocked: control.action_start_blocked,
      authoritative_allowed_count: control.authoritative_allowed_count,
      authoritative_blocked_count: control.authoritative_blocked_count,
      stable_promotion_allowed_count: control.stable_promotion_allowed_count,
      [AUTHORITY_STABLE_PROMOTION_BLOCKED_COUNT_FIELD]: stablePromotionBlockedCount,
      blocked_reasons: promotionDeniedReasons,
    } as AionisLearningPacket["learning_control"],
    lifecycle_effect: {
      promoted_workflow_count: args.planning.workflow_lifecycle_summary.transition_counts.promoted_to_stable,
      candidate_workflow_count: args.planning.workflow_lifecycle_summary.candidate_count,
      trusted_pattern_count: args.planning.pattern_lifecycle_summary.trusted_count,
      contested_pattern_count: args.planning.pattern_lifecycle_summary.contested_count,
      active_policy_count: args.planning.policy_lifecycle_summary.active_count,
      contested_policy_count: args.planning.policy_lifecycle_summary.contested_count,
      suppressed_memory_ids: args.planning.forgetting_summary.suppressed_pattern_anchor_ids,
      demote_count: args.planning.forgetting_summary.semantic_action_counts.demote,
      archive_count: args.planning.forgetting_summary.semantic_action_counts.archive,
      review_count: args.planning.forgetting_summary.semantic_action_counts.review,
    },
    evidence: {
      workflow_anchor_ids: args.planning.action_packet_summary.workflow_anchor_ids,
      candidate_workflow_anchor_ids: args.planning.action_packet_summary.candidate_workflow_anchor_ids,
      trusted_pattern_anchor_ids: args.planning.action_packet_summary.trusted_pattern_anchor_ids,
      candidate_pattern_anchor_ids: args.planning.action_packet_summary.candidate_pattern_anchor_ids,
      contested_pattern_anchor_ids: args.planning.action_packet_summary.contested_pattern_anchor_ids,
      promotion_denied_reasons: promotionDeniedReasons,
    },
    export_readiness: {
      training_export_ready: false,
      positive_transfer_required: true,
      reason: "Route-level learning packets expose learning candidates only; export requires measured positive transfer in an EffectReport.",
    },
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? [
        "history_impact_summary.learning",
        "workflow_lifecycle_summary",
        "pattern_lifecycle_summary",
        "policy_lifecycle_summary",
        "authority_visibility_summary",
        "forgetting_summary",
      ],
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_slots",
        "raw_model_review",
        "task_specific_repair_content",
      ],
    },
  });
}

function impactDirection(args: {
  report: KernelEffectReport;
  sufficientEvidence: boolean;
}): ProductImpactDirection {
  if (!args.sufficientEvidence) return "insufficient_evidence";
  if (args.report.proof_summary.regressed_kernel_count > 0 || args.report.effect_delta < -0.05) return "negative";
  if (args.report.proof_summary.improved_kernel_count > 0 && args.report.effect_delta > 0.05) return "positive";
  return "neutral";
}

function changedFields(report: KernelEffectReport): string[] {
  return compactStrings([
    report.proof_summary.repeated_discovery_delta !== 0 ? "efficiency.repeated_discovery_delta" : null,
    report.proof_summary.continuity_guidance_improved ? "execution_experience_guidance" : null,
    report.proof_summary.workflow_reuse_improved ? "learning_effect.workflow_reuse" : null,
    report.proof_summary.context_precision_delta !== 0 ? "forgetting_effect.context_precision" : null,
    report.proof_summary.stale_memory_delta !== 0 ? "forgetting_effect.stale_memory_suppression" : null,
    report.proof_summary.weak_authority_blocked ? "learning_control.blocked_authority" : null,
    ...report.kernel_scores
      .filter((score) => score.delta !== 0)
      .map((score) => `kernel.${score.capability_id}`),
  ]);
}

function trainingTypeForKernel(score: EffectKernelComparison): TrainingCandidateType {
  if (score.capability_id === "continuity") return "handoff_distillation";
  if (score.capability_id === "learning") return "workflow_selector";
  if (score.capability_id === "forgetting") return "forgetting_suppression";
  return "authority_judgment";
}

function labelForKernel(score: EffectKernelComparison, sufficientEvidence: boolean): TrainingCandidateLabel {
  if (!sufficientEvidence) return "insufficient_evidence";
  if (score.delta > 0.05 && score.status !== "fail") return "positive";
  if (score.delta < -0.05 || score.status === "fail") return "negative";
  return "neutral";
}

function buildTrainingCandidates(args: {
  report: KernelEffectReport;
  sufficientEvidence: boolean;
  task?: ProductTask;
  evidenceIds?: string[];
}): AionisEffectReport["training_candidates"] {
  const kernelCandidates = args.report.kernel_scores
    .filter((score) => score.delta !== 0 || score.status === "fail")
    .map((score) => {
      const label = labelForKernel(score, args.sufficientEvidence);
      return {
        candidate_type: trainingTypeForKernel(score),
        source_ids: [`effect_kernel:${score.capability_id}`],
        label,
        export_ready: args.sufficientEvidence && label === "positive" && args.report.status === "pass",
        reason: compactStrings([
          ...score.signals,
          ...score.regressions,
          `${score.capability_id} delta ${score.delta}`,
        ]).join("; "),
      };
    });
  return [
    ...kernelCandidates,
    ...buildTraceDerivedSkillTrainingCandidates(args),
  ];
}

function taskApplicabilityConditions(task: ProductTask | undefined): string[] {
  return compactStrings([
    task?.task_signature ? `task_signature:${task.task_signature}` : null,
    task?.task_family ? `task_family:${task.task_family}` : null,
    task?.task_id ? `task_id:${task.task_id}` : null,
  ]);
}

function traceDerivedSkillName(score: EffectKernelComparison): string {
  if (score.capability_id === "continuity") return "Continue verified execution state across sessions";
  if (score.capability_id === "learning") return "Reuse verified workflow with feedback attribution";
  return "Apply trace-derived execution lesson through Aionis gates";
}

function traceDerivedSkillSteps(score: EffectKernelComparison): string[] {
  if (score.capability_id === "continuity") {
    return [
      "Recover the current Aionis guide before continuing the task.",
      "Continue from the verified active path instead of rediscovering prior state.",
      "Keep failed commands and abandoned branches as counter-evidence, not as routes.",
      "Run the recorded acceptance checks before treating the continuation as reusable.",
    ];
  }
  return [
    "Use the workflow only when the task matches the recorded applicability conditions.",
    "Inspect current repository state before applying the procedure.",
    "Preserve counter-evidence from failed or demoted memories.",
    "Send feedback attribution after the workflow succeeds or fails.",
  ];
}

function traceDerivedSkillDoesNotApply(score: EffectKernelComparison): string[] {
  return [
    "No validation evidence is available for the source trace.",
    "The current task is outside the recorded scope or task family.",
    "A newer memory contests, suppresses, or supersedes the source trace.",
    ...(score.regressions.length > 0 ? score.regressions.map((entry) => `regression:${entry}`) : []),
  ];
}

function buildTraceDerivedSkillPayload(args: {
  score: EffectKernelComparison;
  task?: ProductTask;
  evidenceIds?: string[];
  exportReady: boolean;
}): AionisTraceDerivedSkillCandidate {
  const sourceTraceIds = compactStrings([
    `effect_kernel:${args.score.capability_id}`,
    args.task?.run_id ? `run:${args.task.run_id}` : null,
    args.task?.task_signature ? `task_signature:${args.task.task_signature}` : null,
    ...(args.evidenceIds ?? []),
  ]);
  const appliesWhen = compactStrings([
    ...taskApplicabilityConditions(args.task),
    args.score.capability_id === "continuity" ? "future_session_needs_verified_continuation" : null,
    args.score.capability_id === "learning" ? "future_task_matches_verified_workflow_shape" : null,
    ...args.score.signals.map((entry) => `signal:${entry}`),
  ]);
  const acceptanceChecks = compactStrings([
    ...args.score.signals,
    args.score.status === "pass" ? "effect_kernel_passed" : null,
    args.exportReady ? "comparison_evidence_sufficient" : null,
  ]);
  return {
    contract_version: "aionis_trace_derived_skill_candidate_v1",
    skill_name: traceDerivedSkillName(args.score),
    source_trace_ids: sourceTraceIds.length > 0 ? sourceTraceIds : [`effect_kernel:${args.score.capability_id}`],
    source_signal_ids: args.score.signals,
    applies_when: appliesWhen.length > 0 ? appliesWhen : [`capability:${args.score.capability_id}`],
    does_not_apply_when: traceDerivedSkillDoesNotApply(args.score),
    procedure_steps: traceDerivedSkillSteps(args.score),
    target_files: [],
    acceptance_checks: acceptanceChecks,
    failure_counterexamples: args.score.regressions,
    evidence_refs: compactStrings([
      ...args.score.signals,
      ...(args.evidenceIds ?? []),
    ]),
    authority_state: "candidate",
    promotion_status: args.exportReady ? "promotion_ready" : "needs_feedback_attribution",
    export_policy: {
      agent_prompt_included: false,
      runtime_mutation: false,
      required_gate: "admission_and_promotion_gate",
    },
  };
}

function buildTraceDerivedSkillTrainingCandidates(args: {
  report: KernelEffectReport;
  sufficientEvidence: boolean;
  task?: ProductTask;
  evidenceIds?: string[];
}): AionisEffectReport["training_candidates"] {
  return args.report.kernel_scores
    .filter((score) =>
      (score.capability_id === "continuity" || score.capability_id === "learning")
      && labelForKernel(score, args.sufficientEvidence) === "positive"
    )
    .map((score) => {
      const exportReady = args.sufficientEvidence && args.report.status === "pass" && score.status !== "fail";
      const traceDerivedSkill = buildTraceDerivedSkillPayload({
        score,
        task: args.task,
        evidenceIds: args.evidenceIds,
        exportReady,
      });
      return {
        candidate_type: "trace_derived_skill",
        source_ids: traceDerivedSkill.source_trace_ids,
        label: "positive",
        export_ready: exportReady,
        reason: [
          `Trace-derived skill candidate from ${score.capability_id} effect.`,
          "Candidate is exportable only as controlled training material; direct use still requires admission and promotion gates.",
        ].join(" "),
        trace_derived_skill: traceDerivedSkill,
      };
    });
}

function buildKernelEffectHistoryContributions(report: KernelEffectReport): AionisEffectReport["history_contributions"] {
  const continuityImproved = report.kernel_scores.some((score) => score.capability_id === "continuity" && score.delta > 0);
  const workflowReuseImproved = report.proof_summary.workflow_reuse_improved;
  return {
    handoff: {
      used: continuityImproved,
      source_count: continuityImproved ? 1 : 0,
      source_ids: continuityImproved ? ["effect_kernel:continuity"] : [],
      changed_fields: continuityImproved ? ["history_impact.continuity"] : [],
      reason: continuityImproved
        ? "Continuity improvement indicates handoff-style recovered state contributed to the assisted run."
        : "No measured continuity contribution was available.",
    },
    replay: {
      used: workflowReuseImproved,
      source_count: workflowReuseImproved ? 1 : 0,
      source_ids: workflowReuseImproved ? ["effect_kernel:learning"] : [],
      changed_fields: workflowReuseImproved ? ["learning_effect.workflow_reuse"] : [],
      reason: workflowReuseImproved
        ? "Workflow reuse improvement indicates replay-style workflow evidence contributed to the assisted run."
        : "No measured replay workflow contribution was available.",
    },
  };
}

function feedbackReviewMemoryIds(
  entries: AionisMemoryDecisionAuditReport["feedback_signal_review"]["positive_attributed_memories"],
): string[] {
  return entries.map((entry) => entry.memory_id);
}

function buildEffectFeedbackSignalSummary(
  review: AionisMemoryDecisionAuditReport["feedback_signal_review"] | null | undefined,
): AionisEffectReport["feedback_signal_summary"] {
  if (!review) {
    return {
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      positive_attributed_memory_ids: [],
      weak_counter_signal_memory_ids: [],
      strong_counter_signal_memory_ids: [],
      relation_counter_signal_memory_ids: [],
      contradiction_warning_memory_ids: [],
      repeated_unattributed_memory_ids: [],
      repeated_unattributed_without_positive_memory_ids: [],
      read_only_signal_memory_ids: [],
      explanation: "No memory decision audit feedback signal review was supplied for this effect report.",
    };
  }
  return {
    present: review.present,
    source: "memory_decision_audit",
    authority_mutation: false,
    positive_attributed_memory_ids: feedbackReviewMemoryIds(review.positive_attributed_memories),
    weak_counter_signal_memory_ids: feedbackReviewMemoryIds(review.weak_counter_signal_memories),
    strong_counter_signal_memory_ids: feedbackReviewMemoryIds(review.strong_counter_signal_memories),
    relation_counter_signal_memory_ids: feedbackReviewMemoryIds(review.relation_counter_signal_memories),
    contradiction_warning_memory_ids: feedbackReviewMemoryIds(review.contradiction_warning_memories),
    repeated_unattributed_memory_ids: feedbackReviewMemoryIds(review.repeated_unattributed_memories),
    repeated_unattributed_without_positive_memory_ids: feedbackReviewMemoryIds(review.repeated_unattributed_without_positive_memories),
    read_only_signal_memory_ids: review.read_only_signal_memory_ids,
    explanation: review.present
      ? "Feedback signals were summarized from the memory decision audit for product measurement only; they do not mutate authority in the effect report."
      : review.reason,
  };
}

function buildEffectNeighborhoodDriftSummary(
  review: AionisMemoryDecisionAuditReport["neighborhood_drift_review"] | null | undefined,
): AionisEffectReport["neighborhood_drift_summary"] {
  if (!review) {
    return {
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      signal_memory_ids: [],
      candidate_count: 0,
      explanation: "No memory decision audit neighborhood drift review was supplied for this effect report.",
    };
  }
  return {
    present: review.present,
    source: "memory_decision_audit",
    authority_mutation: false,
    signal_memory_ids: review.signal_memory_ids,
    candidate_count: review.candidate_count,
    explanation: review.present
      ? "Neighborhood drift was summarized from memory decision audit for product measurement only; it does not mutate memory authority in the effect report."
      : review.reason,
  };
}

function buildEffectConfidenceDecaySummary(
  review: AionisMemoryDecisionAuditReport["confidence_decay_candidate_review"] | null | undefined,
): AionisEffectReport["confidence_decay_summary"] {
  if (!review) {
    return {
      present: false,
      source: "not_supplied",
      authority_mutation: false,
      time_decay_age_threshold_days: 0,
      decay_candidate_memory_ids: [],
      candidate_from_time_decay_memory_ids: [],
      blocked_by_positive_attribution_memory_ids: [],
      supported_by_neighborhood_drift_memory_ids: [],
      explanation: "No memory decision audit confidence decay review was supplied for this effect report.",
    };
  }
  return {
    present: review.present,
    source: "memory_decision_audit",
    authority_mutation: false,
    time_decay_age_threshold_days: review.time_decay_age_threshold_days,
    decay_candidate_memory_ids: review.decay_candidate_memory_ids,
    candidate_from_time_decay_memory_ids: review.candidate_from_time_decay_memory_ids,
    blocked_by_positive_attribution_memory_ids: review.blocked_by_positive_attribution_memory_ids,
    supported_by_neighborhood_drift_memory_ids: review.supported_by_neighborhood_drift_memory_ids,
    explanation: review.present
      ? "Confidence decay shadow candidates were summarized from memory decision audit for product measurement only; this does not mutate memory authority."
      : review.reason,
  };
}

function effectExplanation(report: KernelEffectReport, direction: ProductImpactDirection): string {
  if (direction === "insufficient_evidence") {
    return "The effect evaluator does not have enough comparison evidence to claim product impact.";
  }
  if (direction === "positive") {
    return "History improved at least one focused Runtime capability without a measured regression.";
  }
  if (direction === "negative") {
    return "History produced a measured regression or failing focused Runtime capability.";
  }
  return `Measured effect is neutral with aggregate delta ${report.effect_delta}.`;
}

export function buildAionisEffectReport(args: BuildAionisEffectReportArgs): AionisEffectReport {
  const sufficientEvidence = args.comparison?.sufficient_evidence
    ?? (args.comparison?.mode === "single_run_history_impact" ? false : true);
  const direction = impactDirection({ report: args.report, sufficientEvidence });
  const changed = sufficientEvidence ? changedFields(args.report) : [];
  const trainingCandidates = buildTrainingCandidates({
    report: args.report,
    sufficientEvidence,
    task: args.task,
    evidenceIds: args.evidence_ids,
  });

  return parseAionisEffectReport({
    contract_version: "aionis_effect_report_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    task: asTask(args.task),
    comparison: {
      mode: args.comparison?.mode ?? "baseline_vs_aionis",
      baseline_run_id: args.comparison?.baseline_run_id ?? null,
      aionis_run_id: args.comparison?.aionis_run_id ?? null,
      sufficient_evidence: sufficientEvidence,
    },
    history_impact: {
      changed_future_behavior: changed.length > 0,
      impact_direction: direction,
      changed_fields: changed,
      explanation: effectExplanation(args.report, direction),
    },
    efficiency: {
      repeated_discovery_delta: -args.report.proof_summary.repeated_discovery_delta,
      useful_continuity_delta: args.report.proof_summary.continuity_guidance_improved ? -1 : 0,
      token_delta: null,
      context_size_delta: null,
      recovery_step_delta: null,
    },
    quality: {
      verifier_outcome: args.report.status === "pass" ? "pass" : args.report.status === "fail" ? "fail" : "unknown",
      recovered_fact_accuracy: args.report.kernel_scores.find((score) => score.capability_id === "continuity")?.status === "pass"
        ? "positive"
        : "unknown",
      workflow_reuse_outcome: args.report.proof_summary.workflow_reuse_improved
        ? "success"
        : "not_used",
      negative_transfer_detected: direction === "negative",
    },
    history_contributions: buildKernelEffectHistoryContributions(args.report),
    learning_effect: {
      promoted_workflow_ids: [],
      candidate_workflow_ids: [],
      demoted_memory_ids: [],
      blocked_authority_ids: args.report.proof_summary.weak_authority_blocked
        ? ["effect_kernel:learning_control"]
        : [],
      promotion_denied_reasons: args.report.next_actions,
    },
    forgetting_effect: {
      suppressed_memory_ids: [],
      archived_memory_ids: [],
      rehydrated_memory_ids: [],
      stale_memory_filtered_count: Math.max(0, args.report.proof_summary.stale_memory_delta),
    },
    feedback_signal_summary: buildEffectFeedbackSignalSummary(args.feedback_signal_review),
    neighborhood_drift_summary: buildEffectNeighborhoodDriftSummary(args.neighborhood_drift_review),
    confidence_decay_summary: buildEffectConfidenceDecaySummary(args.confidence_decay_review),
    training_candidates: trainingCandidates,
    evidence: {
      evidence_ids: compactStrings([
        ...(args.evidence_ids ?? []),
        ...args.report.kernel_scores.map((score) => `effect_kernel:${score.capability_id}`),
      ]),
      replay_run_ids: [],
      signal_summary_ids: args.report.kernel_scores.flatMap((score) => score.signals),
      promotion_quality_summary_ids: [],
    },
  });
}
