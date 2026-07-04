import type {
  ActionPacketSummary,
  AuthorityVisibilitySummary,
  ContinuityCarrierSummary,
  DistillationSignalSummary,
  ExecutionMemorySummaryBundle,
  PatternLifecycleSummary,
  PatternMaintenanceSummary,
  PatternSignalSummary,
  PlannerPacketSummarySurface,
  PolicyLifecycleSummary,
  PolicyMaintenanceSummary,
  WorkflowLifecycleSummary,
  WorkflowMaintenanceSummary,
  WorkflowSignalSummary,
} from "./planning-summary.js";
import {
  runtimeAuthorityVisibilityFromEntry,
  summarizeRuntimeAuthorityVisibility,
} from "../memory/authority-visibility.js";
import { authorityConsumptionStateFromValue } from "../memory/authority-consumption.js";
import { safeRecordArray, uniqueStrings } from "./planning-summary-utils.js";

export function summarizePacketEntryLabels(entries: Array<Record<string, unknown>>, field: "title" | "summary", limit = 3): string[] {
  return uniqueStrings(
    entries.map((entry) => {
      const primary = typeof entry[field] === "string" ? entry[field] : "";
      const secondary = typeof entry.title === "string" ? entry.title : typeof entry.summary === "string" ? entry.summary : "";
      return (primary || secondary).trim();
    }),
    limit,
  );
}

function stringProp(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : null;
}

function collectPatternEntriesFromSurface(surface: PlannerPacketSummarySurface) {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const candidatePatterns = Array.isArray(surface.candidate_patterns)
    ? surface.candidate_patterns
    : Array.isArray(packet.candidate_patterns)
      ? packet.candidate_patterns
      : [];
  const trustedPatterns = Array.isArray(surface.trusted_patterns)
    ? surface.trusted_patterns
    : Array.isArray(packet.trusted_patterns)
      ? packet.trusted_patterns
      : [];
  const contestedPatterns = Array.isArray(surface.contested_patterns)
    ? surface.contested_patterns
    : Array.isArray(packet.contested_patterns)
      ? packet.contested_patterns
      : [];
  return { candidatePatterns, trustedPatterns, contestedPatterns };
}

function collectWorkflowEntriesFromSurface(surface: PlannerPacketSummarySurface) {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const recommendedWorkflows = Array.isArray(surface.recommended_workflows)
    ? surface.recommended_workflows
    : Array.isArray(packet.recommended_workflows)
      ? packet.recommended_workflows
      : [];
  const candidateWorkflows = Array.isArray(surface.candidate_workflows)
    ? surface.candidate_workflows
    : Array.isArray(packet.candidate_workflows)
      ? packet.candidate_workflows
      : [];
  return { recommendedWorkflows, candidateWorkflows };
}

export function isPromotionReadyWorkflowSignal(entry: Record<string, unknown>): boolean {
  if (authorityConsumptionStateFromValue(entry).blocks_promotion_readiness) return false;
  if (entry.promotion_ready === true) return true;
  const promotionState = typeof entry.promotion_state === "string" ? entry.promotion_state.trim() : "";
  const observedCount = Number(entry.observed_count ?? NaN);
  const requiredObservations = Number(entry.required_observations ?? NaN);
  return (
    promotionState === "candidate"
    && Number.isFinite(observedCount)
    && Number.isFinite(requiredObservations)
    && observedCount >= requiredObservations
  );
}

export function summarizePatternSignals(layeredContext: unknown): PatternSignalSummary {
  const layered =
    layeredContext && typeof layeredContext === "object"
      ? (layeredContext as Record<string, unknown>)
      : {};
  return summarizePatternSignalSurface({
    action_recall_packet: layered.action_recall_packet,
    pattern_signals: layered.pattern_signals,
    candidate_patterns: layered.candidate_patterns,
    trusted_patterns: layered.trusted_patterns,
    contested_patterns: layered.contested_patterns,
  });
}

export function summarizePatternSignalSurface(surface: PlannerPacketSummarySurface): PatternSignalSummary {
  const { candidatePatterns, trustedPatterns, contestedPatterns } = collectPatternEntriesFromSurface(surface);
  if (
    candidatePatterns.length > 0
    || trustedPatterns.length > 0
    || contestedPatterns.length > 0
    || !!surface.action_recall_packet
  ) {
    return {
      candidate_pattern_count: candidatePatterns.length,
      candidate_pattern_tools: uniqueStrings(candidatePatterns.map((entry) => stringProp(entry, "selected_tool"))),
      trusted_pattern_count: trustedPatterns.length,
      contested_pattern_count: contestedPatterns.length,
      trusted_pattern_tools: uniqueStrings(trustedPatterns.map((entry) => stringProp(entry, "selected_tool"))),
      contested_pattern_tools: uniqueStrings(contestedPatterns.map((entry) => stringProp(entry, "selected_tool"))),
    };
  }
  const patternSignals = Array.isArray(surface.pattern_signals) && surface.pattern_signals.length > 0
    ? surface.pattern_signals
    : null;
  if (!patternSignals) {
    return {
      candidate_pattern_count: candidatePatterns.length,
      candidate_pattern_tools: uniqueStrings(candidatePatterns.map((entry) => stringProp(entry, "selected_tool"))),
      trusted_pattern_count: trustedPatterns.length,
      contested_pattern_count: contestedPatterns.length,
      trusted_pattern_tools: uniqueStrings(trustedPatterns.map((entry) => stringProp(entry, "selected_tool"))),
      contested_pattern_tools: uniqueStrings(contestedPatterns.map((entry) => stringProp(entry, "selected_tool"))),
    };
  }
  const mergedSignals = patternSignals.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  const candidate = mergedSignals.filter(
    (entry) =>
      (entry as Record<string, unknown>).trusted !== true
      && (
        (entry as Record<string, unknown>).credibility_state === "candidate"
        || (
          (entry as Record<string, unknown>).credibility_state == null
          && (entry as Record<string, unknown>).counter_evidence_open !== true
        )
      ),
  ) as Array<Record<string, unknown>>;
  const trusted = mergedSignals.filter(
    (entry) => (entry as Record<string, unknown>).trusted === true,
  ) as Array<Record<string, unknown>>;
  const contested = mergedSignals.filter(
    (entry) =>
      (
        (entry as Record<string, unknown>).credibility_state === "contested"
        || (entry as Record<string, unknown>).counter_evidence_open === true
      ),
  ) as Array<Record<string, unknown>>;
  return {
    candidate_pattern_count: candidate.length,
    candidate_pattern_tools: uniqueStrings(candidate.map((entry) => entry.selected_tool)),
    trusted_pattern_count: trusted.length,
    contested_pattern_count: contested.length,
    trusted_pattern_tools: uniqueStrings(trusted.map((entry) => entry.selected_tool)),
    contested_pattern_tools: uniqueStrings(contested.map((entry) => entry.selected_tool)),
  };
}

export function summarizeWorkflowSignalSurface(surface: PlannerPacketSummarySurface): WorkflowSignalSummary {
  const { recommendedWorkflows, candidateWorkflows } = collectWorkflowEntriesFromSurface(surface);
  const stable = recommendedWorkflows.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  const candidate = candidateWorkflows.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  const ready = candidate.filter((entry) => isPromotionReadyWorkflowSignal(entry));
  const observing = candidate.filter((entry) => !isPromotionReadyWorkflowSignal(entry));
  return {
    stable_workflow_count: stable.length,
    promotion_ready_workflow_count: ready.length,
    observing_workflow_count: observing.length,
    stable_workflow_titles: summarizePacketEntryLabels(stable, "title", 6),
    promotion_ready_workflow_titles: summarizePacketEntryLabels(ready, "title", 6),
    observing_workflow_titles: summarizePacketEntryLabels(observing, "title", 6),
  };
}

export function summarizePatternLifecycleSurface(surface: PlannerPacketSummarySurface): PatternLifecycleSummary {
  const { candidatePatterns, trustedPatterns, contestedPatterns } = collectPatternEntriesFromSurface(surface);
  const all = [...candidatePatterns, ...trustedPatterns, ...contestedPatterns]
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  const transitionCounts = {
    candidate_observed: 0,
    promoted_to_trusted: 0,
    counter_evidence_opened: 0,
    revalidated_to_trusted: 0,
  };
  let nearPromotionCount = 0;
  let counterEvidenceOpenCount = 0;
  for (const entry of all) {
    const lastTransition = typeof entry.last_transition === "string" ? entry.last_transition.trim() : "";
    if (lastTransition === "candidate_observed") transitionCounts.candidate_observed += 1;
    else if (lastTransition === "promoted_to_trusted") transitionCounts.promoted_to_trusted += 1;
    else if (lastTransition === "counter_evidence_opened") transitionCounts.counter_evidence_opened += 1;
    else if (lastTransition === "revalidated_to_trusted") transitionCounts.revalidated_to_trusted += 1;
    if (entry.counter_evidence_open === true) counterEvidenceOpenCount += 1;
  }
  for (const rawEntry of candidatePatterns) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const distinctRunCount = Number(entry.distinct_run_count);
    const requiredDistinctRuns = Number(entry.required_distinct_runs);
    if (
      Number.isFinite(distinctRunCount)
      && Number.isFinite(requiredDistinctRuns)
      && requiredDistinctRuns > 0
      && distinctRunCount < requiredDistinctRuns
      && distinctRunCount >= (requiredDistinctRuns - 1)
    ) {
      nearPromotionCount += 1;
    }
  }
  return {
    candidate_count: candidatePatterns.length,
    trusted_count: trustedPatterns.length,
    contested_count: contestedPatterns.length,
    near_promotion_count: nearPromotionCount,
    counter_evidence_open_count: counterEvidenceOpenCount,
    transition_counts: transitionCounts,
  };
}

export function summarizePatternMaintenanceSurface(surface: PlannerPacketSummarySurface): PatternMaintenanceSummary {
  const { candidatePatterns, trustedPatterns, contestedPatterns } = collectPatternEntriesFromSurface(surface);
  const all = [...candidatePatterns, ...trustedPatterns, ...contestedPatterns]
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  let observeCount = 0;
  let retainCount = 0;
  let reviewCount = 0;
  let promoteCandidateCount = 0;
  let reviewCounterEvidenceCount = 0;
  let retainTrustedCount = 0;
  for (const entry of all) {
    const maintenanceStateRaw = typeof entry.maintenance_state === "string" ? entry.maintenance_state.trim() : "";
    const offlinePriorityRaw = typeof entry.offline_priority === "string" ? entry.offline_priority.trim() : "";
    const credibilityState = typeof entry.credibility_state === "string" ? entry.credibility_state.trim() : "";
    const maintenanceState = maintenanceStateRaw || (
      credibilityState === "trusted"
        ? "retain"
        : credibilityState === "contested"
          ? "review"
          : "observe"
    );
    const offlinePriority = offlinePriorityRaw || (
      credibilityState === "trusted"
        ? "retain_trusted"
        : credibilityState === "contested"
          ? "review_counter_evidence"
          : "none"
    );
    if (maintenanceState === "observe") observeCount += 1;
    else if (maintenanceState === "retain") retainCount += 1;
    else if (maintenanceState === "review") reviewCount += 1;
    if (offlinePriority === "promote_candidate") promoteCandidateCount += 1;
    else if (offlinePriority === "review_counter_evidence") reviewCounterEvidenceCount += 1;
    else if (offlinePriority === "retain_trusted") retainTrustedCount += 1;
  }
  return {
    model: "lazy_online_v1",
    observe_count: observeCount,
    retain_count: retainCount,
    review_count: reviewCount,
    promote_candidate_count: promoteCandidateCount,
    review_counter_evidence_count: reviewCounterEvidenceCount,
    retain_trusted_count: retainTrustedCount,
  };
}

export function summarizeWorkflowLifecycleSurface(surface: PlannerPacketSummarySurface): WorkflowLifecycleSummary {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const candidateWorkflows = Array.isArray(surface.candidate_workflows)
    ? surface.candidate_workflows
    : Array.isArray(packet.candidate_workflows)
      ? packet.candidate_workflows
      : [];
  const recommendedWorkflows = Array.isArray(surface.recommended_workflows)
    ? surface.recommended_workflows
    : Array.isArray(packet.recommended_workflows)
      ? packet.recommended_workflows
      : [];
  const workflows = [...candidateWorkflows, ...recommendedWorkflows]
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  let replaySourceCount = 0;
  let rehydrationReadyCount = 0;
  let promotionReadyCount = 0;
  const transitionCounts = {
    candidate_observed: 0,
    promoted_to_stable: 0,
    normalized_latest_stable: 0,
  };
  for (const entry of workflows) {
    const sourceKind = typeof entry.source_kind === "string" ? entry.source_kind.trim() : "";
    const defaultMode = typeof entry.rehydration_default_mode === "string" ? entry.rehydration_default_mode.trim() : "";
    const lastTransition = typeof entry.last_transition === "string" ? entry.last_transition.trim() : "";
    if (sourceKind === "playbook") replaySourceCount += 1;
    if (defaultMode === "summary_only" || defaultMode === "partial" || defaultMode === "full") rehydrationReadyCount += 1;
    if (isPromotionReadyWorkflowSignal(entry)) {
      promotionReadyCount += 1;
    }
    if (lastTransition === "candidate_observed") transitionCounts.candidate_observed += 1;
    else if (lastTransition === "promoted_to_stable") transitionCounts.promoted_to_stable += 1;
    else if (lastTransition === "normalized_latest_stable") transitionCounts.normalized_latest_stable += 1;
  }
  return {
    candidate_count: candidateWorkflows.length,
    stable_count: recommendedWorkflows.length,
    replay_source_count: replaySourceCount,
    rehydration_ready_count: rehydrationReadyCount,
    promotion_ready_count: promotionReadyCount,
    transition_counts: transitionCounts,
  };
}

export function summarizeWorkflowMaintenanceSurface(surface: PlannerPacketSummarySurface): WorkflowMaintenanceSummary {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const candidateWorkflows = Array.isArray(surface.candidate_workflows)
    ? surface.candidate_workflows
    : Array.isArray(packet.candidate_workflows)
      ? packet.candidate_workflows
      : [];
  const recommendedWorkflows = Array.isArray(surface.recommended_workflows)
    ? surface.recommended_workflows
    : Array.isArray(packet.recommended_workflows)
      ? packet.recommended_workflows
      : [];
  const workflows = [...candidateWorkflows, ...recommendedWorkflows]
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  let observeCount = 0;
  let retainCount = 0;
  let promoteCandidateCount = 0;
  let retainWorkflowCount = 0;
  for (const entry of workflows) {
    const maintenanceState = typeof entry.maintenance_state === "string" ? entry.maintenance_state.trim() : "";
    const offlinePriority = typeof entry.offline_priority === "string" ? entry.offline_priority.trim() : "";
    const promotionState = typeof entry.promotion_state === "string" ? entry.promotion_state.trim() : "";
    const authorityState = authorityConsumptionStateFromValue(entry);
    const normalizedState = maintenanceState || (promotionState === "candidate" ? "observe" : "retain");
    const normalizedPriority = offlinePriority || (promotionState === "candidate" ? "promote_candidate" : "retain_workflow");
    if (normalizedState === "observe") observeCount += 1;
    if (normalizedState === "retain") retainCount += 1;
    if (normalizedPriority === "promote_candidate" && !authorityState.blocks_promotion_readiness) promoteCandidateCount += 1;
    if (normalizedPriority === "retain_workflow") retainWorkflowCount += 1;
  }
  return {
    model: "lazy_online_v1",
    observe_count: observeCount,
    retain_count: retainCount,
    promote_candidate_count: promoteCandidateCount,
    retain_workflow_count: retainWorkflowCount,
  };
}

export function summarizeAuthorityVisibilitySurface(surface: PlannerPacketSummarySurface) {
  const { recommendedWorkflows, candidateWorkflows } = collectWorkflowEntriesFromSurface(surface);
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const supportingKnowledge = Array.isArray(surface.supporting_knowledge)
    ? surface.supporting_knowledge
    : Array.isArray(packet.supporting_knowledge)
      ? packet.supporting_knowledge
      : [];
  const explicitSummary = surface.authority_visibility_summary as Record<string, unknown> | undefined;
  if (explicitSummary?.summary_version === "runtime_authority_visibility_summary_v1") {
    return {
      summary_version: "runtime_authority_visibility_summary_v1",
      surface_count: Number(explicitSummary.surface_count ?? 0),
      sufficient_count: Number(explicitSummary.sufficient_count ?? 0),
      insufficient_count: Number(explicitSummary.insufficient_count ?? 0),
      authoritative_allowed_count: Number(explicitSummary.authoritative_allowed_count ?? 0),
      authoritative_blocked_count: Number(explicitSummary.authoritative_blocked_count ?? 0),
      stable_promotion_allowed_count: Number(explicitSummary.stable_promotion_allowed_count ?? 0),
      stable_promotion_blocked_count: Number(explicitSummary.stable_promotion_blocked_count ?? 0),
      execution_evidence_failed_count: Number(explicitSummary.execution_evidence_failed_count ?? 0),
      execution_evidence_incomplete_count: Number(explicitSummary.execution_evidence_incomplete_count ?? 0),
      false_confidence_count: Number(explicitSummary.false_confidence_count ?? 0),
      reason_counts: (
        explicitSummary.reason_counts
        && typeof explicitSummary.reason_counts === "object"
        && !Array.isArray(explicitSummary.reason_counts)
          ? explicitSummary.reason_counts
          : {}
      ) as Record<string, number>,
      top_blockers: uniqueStrings(Array.isArray(explicitSummary.top_blockers) ? explicitSummary.top_blockers : [], 8),
    } satisfies AuthorityVisibilitySummary;
  }
  return summarizeRuntimeAuthorityVisibility(
    [...safeRecordArray(recommendedWorkflows), ...safeRecordArray(candidateWorkflows), ...safeRecordArray(supportingKnowledge)]
      .map((entry) => runtimeAuthorityVisibilityFromEntry(entry)),
  );
}

export function summarizeActionRecallPacket(layeredContext: unknown): ActionPacketSummary {
  const layered =
    layeredContext && typeof layeredContext === "object"
      ? (layeredContext as Record<string, unknown>)
      : {};
  return summarizeActionRecallPacketSurface({ action_recall_packet: layered.action_recall_packet });
}

export function summarizeActionRecallPacketSurface(surface: PlannerPacketSummarySurface): ActionPacketSummary {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const recommendedWorkflows = Array.isArray(surface.recommended_workflows)
    ? surface.recommended_workflows
    : Array.isArray(packet.recommended_workflows)
      ? packet.recommended_workflows
      : [];
  const candidateWorkflows = Array.isArray(surface.candidate_workflows)
    ? surface.candidate_workflows
    : Array.isArray(packet.candidate_workflows)
      ? packet.candidate_workflows
      : [];
  const candidatePatterns = Array.isArray(surface.candidate_patterns)
    ? surface.candidate_patterns
    : Array.isArray(packet.candidate_patterns)
      ? packet.candidate_patterns
      : [];
  const trustedPatterns = Array.isArray(surface.trusted_patterns)
    ? surface.trusted_patterns
    : Array.isArray(packet.trusted_patterns)
      ? packet.trusted_patterns
      : [];
  const contestedPatterns = Array.isArray(surface.contested_patterns)
    ? surface.contested_patterns
    : Array.isArray(packet.contested_patterns)
      ? packet.contested_patterns
      : [];
  const rehydrationCandidates = Array.isArray(surface.rehydration_candidates)
    ? surface.rehydration_candidates
    : Array.isArray(packet.rehydration_candidates)
      ? packet.rehydration_candidates
      : [];
  const supportingKnowledge = Array.isArray(surface.supporting_knowledge)
    ? surface.supporting_knowledge
    : Array.isArray(packet.supporting_knowledge)
      ? packet.supporting_knowledge
      : [];
  return {
    recommended_workflow_count: recommendedWorkflows.length,
    candidate_workflow_count: candidateWorkflows.length,
    candidate_pattern_count: candidatePatterns.length,
    trusted_pattern_count: trustedPatterns.length,
    contested_pattern_count: contestedPatterns.length,
    rehydration_candidate_count: rehydrationCandidates.length,
    supporting_knowledge_count: supportingKnowledge.length,
    workflow_anchor_ids: uniqueStrings(recommendedWorkflows.map((entry) => stringProp(entry, "anchor_id"))),
    candidate_workflow_anchor_ids: uniqueStrings(candidateWorkflows.map((entry) => stringProp(entry, "anchor_id"))),
    candidate_pattern_anchor_ids: uniqueStrings(candidatePatterns.map((entry) => stringProp(entry, "anchor_id"))),
    trusted_pattern_anchor_ids: uniqueStrings(trustedPatterns.map((entry) => stringProp(entry, "anchor_id"))),
    contested_pattern_anchor_ids: uniqueStrings(contestedPatterns.map((entry) => stringProp(entry, "anchor_id"))),
    rehydration_anchor_ids: uniqueStrings(rehydrationCandidates.map((entry) => stringProp(entry, "anchor_id"))),
  };
}

export function summarizeDistillationSignalSurface(surface: PlannerPacketSummarySurface): DistillationSignalSummary {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const recommendedWorkflows = Array.isArray(surface.recommended_workflows)
    ? surface.recommended_workflows
    : Array.isArray(packet.recommended_workflows)
      ? packet.recommended_workflows
      : [];
  const candidateWorkflows = Array.isArray(surface.candidate_workflows)
    ? surface.candidate_workflows
    : Array.isArray(packet.candidate_workflows)
      ? packet.candidate_workflows
      : [];
  const supportingKnowledge = Array.isArray(surface.supporting_knowledge)
    ? surface.supporting_knowledge
    : Array.isArray(packet.supporting_knowledge)
      ? packet.supporting_knowledge
      : [];

  const evidenceEntries = safeRecordArray(supportingKnowledge).filter((entry) => entry.summary_kind === "write_distillation_evidence");
  const factEntries = safeRecordArray(supportingKnowledge).filter((entry) => entry.summary_kind === "write_distillation_fact");
  const promotedWorkflows = safeRecordArray(recommendedWorkflows).filter((entry) => {
    const origin = typeof entry.distillation_origin === "string" ? entry.distillation_origin.trim() : "";
    return origin === "execution_write_projection"
      || origin === "handoff_continuity_carrier"
      || origin === "session_event_continuity_carrier"
      || origin === "session_continuity_carrier"
      || origin === "replay_learning_episode";
  });
  const projectedCandidates = safeRecordArray(candidateWorkflows).filter((entry) => {
    const origin = typeof entry.distillation_origin === "string" ? entry.distillation_origin.trim() : "";
    return origin === "execution_write_projection"
      || origin === "handoff_continuity_carrier"
      || origin === "session_event_continuity_carrier"
      || origin === "session_continuity_carrier"
      || origin === "replay_learning_episode";
  });
  const allEntries = [...evidenceEntries, ...factEntries, ...projectedCandidates, ...promotedWorkflows];

  const originCounts: DistillationSignalSummary["origin_counts"] = {
    write_distillation_input_text: 0,
    write_distillation_event_node: 0,
    write_distillation_evidence_node: 0,
    execution_write_projection: 0,
    handoff_continuity_carrier: 0,
    session_event_continuity_carrier: 0,
    session_continuity_carrier: 0,
    replay_learning_episode: 0,
  };
  const promotionTargetCounts: DistillationSignalSummary["promotion_target_counts"] = {
    workflow: 0,
    pattern: 0,
    policy: 0,
  };

  for (const entry of allEntries) {
    const origin = typeof entry.distillation_origin === "string" ? entry.distillation_origin.trim() : "";
    if (origin in originCounts) originCounts[origin as keyof typeof originCounts] += 1;
    const target = typeof entry.preferred_promotion_target === "string" ? entry.preferred_promotion_target.trim() : "";
    if (target === "workflow" || target === "pattern" || target === "policy") {
      promotionTargetCounts[target] += 1;
    }
  }

  return {
    distilled_evidence_count: evidenceEntries.length,
    distilled_fact_count: factEntries.length,
    projected_workflow_candidate_count: projectedCandidates.length,
    origin_counts: originCounts,
    promotion_target_counts: promotionTargetCounts,
  };
}

function collectPolicyEntriesFromSurface(surface: PlannerPacketSummarySurface) {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const supportingKnowledge = Array.isArray(surface.supporting_knowledge)
    ? surface.supporting_knowledge
    : Array.isArray(packet.supporting_knowledge)
      ? packet.supporting_knowledge
      : [];
  return safeRecordArray(supportingKnowledge).filter((entry) => {
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    const summaryKind = typeof entry.summary_kind === "string" ? entry.summary_kind.trim() : "";
    return kind === "policy_memory" || summaryKind === "policy_memory";
  });
}

function collectContinuityEntriesFromSurface(surface: PlannerPacketSummarySurface) {
  const packet =
    surface.action_recall_packet && typeof surface.action_recall_packet === "object"
      ? (surface.action_recall_packet as Record<string, unknown>)
      : {};
  const supportingKnowledge = Array.isArray(surface.supporting_knowledge)
    ? surface.supporting_knowledge
    : Array.isArray(packet.supporting_knowledge)
      ? packet.supporting_knowledge
      : [];
  return safeRecordArray(supportingKnowledge).filter((entry) => {
    const executionKind = typeof entry.execution_kind === "string" ? entry.execution_kind.trim() : "";
    const summaryKind = typeof entry.summary_kind === "string" ? entry.summary_kind.trim() : "";
    return executionKind === "execution_native"
      && (summaryKind === "handoff" || summaryKind === "session_event" || summaryKind === "session");
  });
}

export function summarizePolicyLifecycleSurface(surface: PlannerPacketSummarySurface): PolicyLifecycleSummary {
  const entries = collectPolicyEntriesFromSurface(surface);
  const summary: PolicyLifecycleSummary = {
    persisted_count: 0,
    active_count: 0,
    contested_count: 0,
    retired_count: 0,
    default_mode_count: 0,
    hint_mode_count: 0,
    stable_policy_count: 0,
    transition_counts: {
      materialized: 0,
      refreshed: 0,
      contested_by_feedback: 0,
      retired_by_feedback: 0,
      retired_by_learning_control: 0,
      reactivated_by_learning_control: 0,
    },
  };
  for (const entry of entries) {
    const materializationState = typeof entry.materialization_state === "string" ? entry.materialization_state.trim() : "";
    const policyMemoryState = typeof entry.policy_memory_state === "string" ? entry.policy_memory_state.trim() : "";
    const activationMode = typeof entry.activation_mode === "string" ? entry.activation_mode.trim() : "";
    const policyState = typeof entry.policy_state === "string" ? entry.policy_state.trim() : "";
    const transition = typeof entry.last_transition === "string" ? entry.last_transition.trim() : "";
    if (materializationState === "persisted") summary.persisted_count += 1;
    if (policyMemoryState === "active") summary.active_count += 1;
    if (policyMemoryState === "contested") summary.contested_count += 1;
    if (policyMemoryState === "retired") summary.retired_count += 1;
    if (activationMode === "default") summary.default_mode_count += 1;
    if (activationMode === "hint") summary.hint_mode_count += 1;
    if (policyState === "stable") summary.stable_policy_count += 1;
    if (transition in summary.transition_counts) {
      summary.transition_counts[transition as keyof PolicyLifecycleSummary["transition_counts"]] += 1;
    }
  }
  return summary;
}

export function summarizePolicyMaintenanceSurface(surface: PlannerPacketSummarySurface): PolicyMaintenanceSummary {
  const entries = collectPolicyEntriesFromSurface(surface);
  const summary: PolicyMaintenanceSummary = {
    model: "lazy_online_v1",
    observe_count: 0,
    retain_count: 0,
    review_count: 0,
    promote_to_default_count: 0,
    retain_active_policy_count: 0,
    review_contested_policy_count: 0,
    retire_policy_count: 0,
    reactivate_policy_count: 0,
  };
  for (const entry of entries) {
    const maintenanceState = typeof entry.maintenance_state === "string" ? entry.maintenance_state.trim() : "";
    const offlinePriority = typeof entry.offline_priority === "string" ? entry.offline_priority.trim() : "";
    if (maintenanceState === "observe") summary.observe_count += 1;
    if (maintenanceState === "retain") summary.retain_count += 1;
    if (maintenanceState === "review") summary.review_count += 1;
    if (offlinePriority === "promote_to_default") summary.promote_to_default_count += 1;
    if (offlinePriority === "retain_active_policy") summary.retain_active_policy_count += 1;
    if (offlinePriority === "review_contested_policy") summary.review_contested_policy_count += 1;
    if (offlinePriority === "retire_policy") summary.retire_policy_count += 1;
    if (offlinePriority === "reactivate_policy") summary.reactivate_policy_count += 1;
  }
  return summary;
}

export function summarizeContinuityCarrierSurface(surface: PlannerPacketSummarySurface): ContinuityCarrierSummary {
  const entries = collectContinuityEntriesFromSurface(surface);
  const summary: ContinuityCarrierSummary = {
    total_count: entries.length,
    handoff_count: 0,
    session_event_count: 0,
    session_count: 0,
  };
  for (const entry of entries) {
    const summaryKind = typeof entry.summary_kind === "string" ? entry.summary_kind.trim() : "";
    if (summaryKind === "handoff") summary.handoff_count += 1;
    if (summaryKind === "session_event") summary.session_event_count += 1;
    if (summaryKind === "session") summary.session_count += 1;
  }
  return summary;
}

export function buildExecutionMemorySummaryBundle(surface: PlannerPacketSummarySurface): ExecutionMemorySummaryBundle {
  return {
    pattern_signal_summary: summarizePatternSignalSurface(surface),
    workflow_signal_summary: summarizeWorkflowSignalSurface(surface),
    workflow_lifecycle_summary: summarizeWorkflowLifecycleSurface(surface),
    workflow_maintenance_summary: summarizeWorkflowMaintenanceSurface(surface),
    authority_visibility_summary: summarizeAuthorityVisibilitySurface(surface),
    distillation_signal_summary: summarizeDistillationSignalSurface(surface),
    pattern_lifecycle_summary: summarizePatternLifecycleSurface(surface),
    pattern_maintenance_summary: summarizePatternMaintenanceSurface(surface),
    policy_lifecycle_summary: summarizePolicyLifecycleSurface(surface),
    policy_maintenance_summary: summarizePolicyMaintenanceSurface(surface),
    continuity_carrier_summary: summarizeContinuityCarrierSurface(surface),
    action_packet_summary: summarizeActionRecallPacketSurface(surface),
  };
}
