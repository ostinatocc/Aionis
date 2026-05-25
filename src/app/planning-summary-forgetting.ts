import type {
  ExecutionForgettingSummary,
  ExecutionMaintenanceSummary,
  ExecutionMemorySummaryBundle,
} from "./planning-summary.js";
import { countKnownValue, safeRecordArray, safeStringArray, uniqueStrings } from "./planning-summary-utils.js";

type PlannerPacketSummarySurface = {
  trusted_patterns?: unknown;
  candidate_patterns?: unknown;
  contested_patterns?: unknown;
  recommended_workflows?: unknown;
  candidate_workflows?: unknown;
  rehydration_candidates?: unknown;
  supporting_knowledge?: unknown;
};

function zeroSemanticActionCounts(): ExecutionForgettingSummary["semantic_action_counts"] {
  return { retain: 0, demote: 0, archive: 0, review: 0 };
}

function zeroLifecycleStateCounts(): ExecutionForgettingSummary["lifecycle_state_counts"] {
  return { active: 0, contested: 0, retired: 0, archived: 0 };
}

function zeroArchiveRelocationStateCounts(): ExecutionForgettingSummary["archive_relocation_state_counts"] {
  return { none: 0, candidate: 0, cold_archive: 0 };
}

function zeroArchiveRelocationTargetCounts(): ExecutionForgettingSummary["archive_relocation_target_counts"] {
  return { none: 0, local_cold_store: 0, external_object_store: 0 };
}

function zeroArchivePayloadScopeCounts(): ExecutionForgettingSummary["archive_payload_scope_counts"] {
  return { none: 0, anchor_payload: 0, node: 0 };
}

function zeroRehydrationModeCounts(): ExecutionForgettingSummary["rehydration_mode_counts"] {
  return { summary_only: 0, partial: 0, full: 0, differential: 0 };
}

function normalizeForgettingSignals(costSignals: unknown) {
  const signals = costSignals && typeof costSignals === "object" ? (costSignals as Record<string, unknown>) : {};
  const forgottenItems = Number.isFinite(Number(signals.forgotten_items))
    ? Math.max(0, Math.trunc(Number(signals.forgotten_items)))
    : 0;
  const forgottenByReason: Record<string, number> =
    signals.forgotten_by_reason && typeof signals.forgotten_by_reason === "object" && !Array.isArray(signals.forgotten_by_reason)
      ? Object.fromEntries(
          Object.entries(signals.forgotten_by_reason as Record<string, unknown>)
            .map(([key, value]) => [key, Number(value)])
            .filter(([, value]) => Number.isFinite(value) && Number(value) > 0),
        )
      : {};
  return {
    forgottenItems,
    forgottenByReason,
    primaryForgettingReason:
      Object.entries(forgottenByReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
    selectedMemoryLayers: safeStringArray(signals.selected_memory_layers),
    primarySavingsLevers: safeStringArray(signals.primary_savings_levers),
  };
}

function collectSuppressedPatternSignals(args: {
  surface: PlannerPacketSummarySurface;
  tools?: unknown;
}) {
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const decision = tools.decision && typeof tools.decision === "object" ? (tools.decision as Record<string, unknown>) : {};
  const patternSummary =
    decision.pattern_summary && typeof decision.pattern_summary === "object"
      ? (decision.pattern_summary as Record<string, unknown>)
      : {};
  const suppressedPatternAnchorIdsFromTools = safeStringArray(patternSummary.skipped_suppressed_pattern_anchor_ids);
  const suppressedPatternAnchorIdsFromSurface: string[] = [];
  const suppressedPatternSources: string[] = [];
  let suppressedEntryCount = 0;
  for (const [source, entries] of [
    ["trusted_patterns", safeRecordArray(args.surface.trusted_patterns)],
    ["candidate_patterns", safeRecordArray(args.surface.candidate_patterns)],
    ["contested_patterns", safeRecordArray(args.surface.contested_patterns)],
  ] as const) {
    for (const entry of entries) {
      if (entry.suppressed !== true) continue;
      suppressedEntryCount += 1;
      suppressedPatternSources.push(source);
      if (typeof entry.anchor_id === "string" && entry.anchor_id.trim()) {
        suppressedPatternAnchorIdsFromSurface.push(entry.anchor_id.trim());
      }
    }
  }
  const suppressedPatternAnchorIds = uniqueStrings([
    ...suppressedPatternAnchorIdsFromSurface,
    ...suppressedPatternAnchorIdsFromTools,
  ], 8);
  return {
    suppressedPatternCount: Math.max(
      suppressedEntryCount,
      suppressedPatternAnchorIds.length,
      suppressedPatternAnchorIdsFromTools.length,
    ),
    suppressedPatternAnchorIds,
    suppressedPatternSources: uniqueStrings([
      ...suppressedPatternSources,
      suppressedPatternAnchorIdsFromTools.length > 0 ? "tool_decision" : "",
    ], 4),
  };
}

function collectForgettingSurfaceSignals(surface: PlannerPacketSummarySurface) {
  const semanticActionCounts = zeroSemanticActionCounts();
  const lifecycleStateCounts = zeroLifecycleStateCounts();
  const archiveRelocationStateCounts = zeroArchiveRelocationStateCounts();
  const archiveRelocationTargetCounts = zeroArchiveRelocationTargetCounts();
  const archivePayloadScopeCounts = zeroArchivePayloadScopeCounts();
  const rehydrationModeCounts = zeroRehydrationModeCounts();

  for (const entry of [
    ...safeRecordArray(surface.recommended_workflows),
    ...safeRecordArray(surface.candidate_workflows),
  ]) {
    countKnownValue(
      semanticActionCounts,
      typeof entry.semantic_forgetting_action === "string" ? entry.semantic_forgetting_action.trim() : null,
    );
    countKnownValue(lifecycleStateCounts, typeof entry.lifecycle_state === "string" ? entry.lifecycle_state.trim() : null);
    countKnownValue(
      archiveRelocationStateCounts,
      typeof entry.archive_relocation_state === "string" ? entry.archive_relocation_state.trim() : null,
    );
    countKnownValue(
      archiveRelocationTargetCounts,
      typeof entry.archive_relocation_target === "string" ? entry.archive_relocation_target.trim() : null,
    );
    countKnownValue(
      archivePayloadScopeCounts,
      typeof entry.archive_payload_scope === "string" ? entry.archive_payload_scope.trim() : null,
    );
    countKnownValue(
      rehydrationModeCounts,
      typeof entry.rehydration_default_mode === "string" ? entry.rehydration_default_mode.trim() : null,
    );
  }

  for (const entry of safeRecordArray(surface.supporting_knowledge)) {
    countKnownValue(
      semanticActionCounts,
      typeof entry.semantic_forgetting_action === "string" ? entry.semantic_forgetting_action.trim() : null,
    );
    countKnownValue(lifecycleStateCounts, typeof entry.lifecycle_state === "string" ? entry.lifecycle_state.trim() : null);
    countKnownValue(
      archiveRelocationStateCounts,
      typeof entry.archive_relocation_state === "string" ? entry.archive_relocation_state.trim() : null,
    );
    countKnownValue(
      archiveRelocationTargetCounts,
      typeof entry.archive_relocation_target === "string" ? entry.archive_relocation_target.trim() : null,
    );
    countKnownValue(
      archivePayloadScopeCounts,
      typeof entry.archive_payload_scope === "string" ? entry.archive_payload_scope.trim() : null,
    );
    countKnownValue(
      rehydrationModeCounts,
      typeof entry.rehydration_default_mode === "string" ? entry.rehydration_default_mode.trim() : null,
    );
  }

  for (const entry of safeRecordArray(surface.rehydration_candidates)) {
    countKnownValue(rehydrationModeCounts, typeof entry.mode === "string" ? entry.mode.trim() : null);
  }

  return {
    semanticActionCounts,
    lifecycleStateCounts,
    archiveRelocationStateCounts,
    archiveRelocationTargetCounts,
    archivePayloadScopeCounts,
    rehydrationModeCounts,
    differentialRehydrationCandidateCount: rehydrationModeCounts.differential,
  };
}

function deriveExecutionMaintenanceAction(args: {
  forgottenItems: number;
  suppressedPatternCount: number;
  archiveCount: number;
  demoteCount: number;
  reviewCount: number;
  differentialRehydrationCandidateCount: number;
  summaryBundle: ExecutionMemorySummaryBundle;
}): string {
  let recommendedAction = "continue observing new executions and keep the current context shape stable";
  if (args.archiveCount > 0) {
    recommendedAction = "rehydrate archived execution memory only when the task proves it still needs the colder payload";
  } else if (args.demoteCount > 0 || args.reviewCount > 0) {
    recommendedAction = "reuse hotter workflow memory first and only widen recall when demoted or review-needed memory becomes necessary";
  } else if (args.differentialRehydrationCandidateCount > 0) {
    recommendedAction = "prefer differential rehydration before paying for a full payload restore";
  } else if (args.forgottenItems > 0) {
    recommendedAction = "avoid reseeding forgotten context and keep the working set narrow";
  } else if (args.summaryBundle.policy_lifecycle_summary.retired_count > 0) {
    recommendedAction = "refresh or replace retired policy memory before trusting default tool selection";
  } else if (args.summaryBundle.policy_lifecycle_summary.contested_count > 0) {
    recommendedAction = "re-validate contested policy memory before defaulting to the prior tool path";
  } else if (args.suppressedPatternCount > 0) {
    recommendedAction = "prefer trusted workflows before reintroducing suppressed patterns";
  } else if (args.summaryBundle.workflow_signal_summary.promotion_ready_workflow_count > 0) {
    recommendedAction = "promote or reuse promotion-ready workflows before widening recall";
  } else if (args.summaryBundle.workflow_signal_summary.stable_workflow_count > 0) {
    recommendedAction = "reuse stable workflows before broader exploration";
  } else if (args.summaryBundle.pattern_signal_summary.trusted_pattern_count > 0) {
    recommendedAction = "reuse trusted patterns before broad tool exploration";
  }
  return recommendedAction;
}

export function buildExecutionMaintenanceSummary(args: {
  surface: PlannerPacketSummarySurface;
  summaryBundle: ExecutionMemorySummaryBundle;
  costSignals?: unknown;
  tools?: unknown;
}): ExecutionMaintenanceSummary {
  const forgettingSignals = normalizeForgettingSignals(args.costSignals);
  const suppressedPatternSignals = collectSuppressedPatternSignals({
    surface: args.surface,
    tools: args.tools,
  });
  const forgettingSurfaceSignals = collectForgettingSurfaceSignals(args.surface);
  const recommendedAction = deriveExecutionMaintenanceAction({
    forgottenItems: forgettingSignals.forgottenItems,
    suppressedPatternCount: suppressedPatternSignals.suppressedPatternCount,
    archiveCount: forgettingSurfaceSignals.semanticActionCounts.archive,
    demoteCount: forgettingSurfaceSignals.semanticActionCounts.demote,
    reviewCount: forgettingSurfaceSignals.semanticActionCounts.review,
    differentialRehydrationCandidateCount: forgettingSurfaceSignals.differentialRehydrationCandidateCount,
    summaryBundle: args.summaryBundle,
  });
  return {
    summary_version: "execution_maintenance_summary_v1",
    forgotten_items: forgettingSignals.forgottenItems,
    forgotten_by_reason: forgettingSignals.forgottenByReason,
    suppressed_pattern_count: suppressedPatternSignals.suppressedPatternCount,
    stable_workflow_count: args.summaryBundle.workflow_signal_summary.stable_workflow_count,
    promotion_ready_workflow_count: args.summaryBundle.workflow_signal_summary.promotion_ready_workflow_count,
    selected_memory_layers: forgettingSignals.selectedMemoryLayers,
    primary_savings_levers: forgettingSignals.primarySavingsLevers,
    recommended_action: recommendedAction,
  };
}

export function buildExecutionForgettingSummary(args: {
  surface: PlannerPacketSummarySurface;
  summaryBundle: ExecutionMemorySummaryBundle;
  costSignals?: unknown;
  tools?: unknown;
}): ExecutionForgettingSummary {
  const forgettingSignals = normalizeForgettingSignals(args.costSignals);
  const suppressedPatternSignals = collectSuppressedPatternSignals({
    surface: args.surface,
    tools: args.tools,
  });
  const forgettingSurfaceSignals = collectForgettingSurfaceSignals(args.surface);
  return {
    summary_version: "execution_forgetting_summary_v1",
    substrate_mode:
      forgettingSignals.forgottenItems > 0
        ? "forgetting_active"
        : suppressedPatternSignals.suppressedPatternCount > 0
          ? "suppression_present"
          : "stable",
    forgotten_items: forgettingSignals.forgottenItems,
    forgotten_by_reason: forgettingSignals.forgottenByReason,
    primary_forgetting_reason: forgettingSignals.primaryForgettingReason,
    suppressed_pattern_count: suppressedPatternSignals.suppressedPatternCount,
    suppressed_pattern_anchor_ids: suppressedPatternSignals.suppressedPatternAnchorIds,
    suppressed_pattern_sources: suppressedPatternSignals.suppressedPatternSources,
    selected_memory_layers: forgettingSignals.selectedMemoryLayers,
    semantic_action_counts: forgettingSurfaceSignals.semanticActionCounts,
    lifecycle_state_counts: forgettingSurfaceSignals.lifecycleStateCounts,
    archive_relocation_state_counts: forgettingSurfaceSignals.archiveRelocationStateCounts,
    archive_relocation_target_counts: forgettingSurfaceSignals.archiveRelocationTargetCounts,
    archive_payload_scope_counts: forgettingSurfaceSignals.archivePayloadScopeCounts,
    rehydration_mode_counts: forgettingSurfaceSignals.rehydrationModeCounts,
    differential_rehydration_candidate_count: forgettingSurfaceSignals.differentialRehydrationCandidateCount,
    primary_savings_levers: forgettingSignals.primarySavingsLevers,
    stale_signal_count:
      forgettingSignals.forgottenItems
      + suppressedPatternSignals.suppressedPatternCount,
    recommended_action: deriveExecutionMaintenanceAction({
      forgottenItems: forgettingSignals.forgottenItems,
      suppressedPatternCount: suppressedPatternSignals.suppressedPatternCount,
      archiveCount: forgettingSurfaceSignals.semanticActionCounts.archive,
      demoteCount: forgettingSurfaceSignals.semanticActionCounts.demote,
      reviewCount: forgettingSurfaceSignals.semanticActionCounts.review,
      differentialRehydrationCandidateCount: forgettingSurfaceSignals.differentialRehydrationCandidateCount,
      summaryBundle: args.summaryBundle,
    }),
  };
}
