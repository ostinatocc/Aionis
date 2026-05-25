import type {
  ExecutionCollaborationSummary,
  ExecutionContinuitySnapshotSummary,
  ExecutionMaintenanceSummary,
  ExecutionMemorySummaryBundle,
  ExecutionRoutingSignalSummary,
  ExecutionStrategySummary,
} from "./planning-summary.js";
import { safeRecordArray, safeStringArray, uniqueStrings } from "./planning-summary-utils.js";

type PlannerPacketSummarySurface = {
  trusted_patterns?: unknown;
  candidate_patterns?: unknown;
  contested_patterns?: unknown;
  recommended_workflows?: unknown;
  candidate_workflows?: unknown;
  rehydration_candidates?: unknown;
};

function collectTaskFamilyCounts(surface: PlannerPacketSummarySurface): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of [
    safeRecordArray(surface.trusted_patterns),
    safeRecordArray(surface.candidate_patterns),
    safeRecordArray(surface.contested_patterns),
    safeRecordArray(surface.recommended_workflows),
    safeRecordArray(surface.candidate_workflows),
    safeRecordArray(surface.rehydration_candidates),
  ]) {
    for (const entry of source) {
      const taskFamily = typeof entry.task_family === "string" ? entry.task_family.trim() : "";
      if (!taskFamily) continue;
      counts.set(taskFamily, (counts.get(taskFamily) ?? 0) + 1);
    }
  }
  return counts;
}

export function dominantTaskFamily(surface: PlannerPacketSummarySurface): string | null {
  const counts = collectTaskFamilyCounts(surface);
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

function affinityRank(value: string): number {
  if (value === "exact_task_signature") return 4;
  if (value === "same_task_family") return 3;
  if (value === "same_error_family") return 2;
  if (value === "broader_similarity") return 1;
  return 0;
}

export function familyReason(scope: string): string {
  if (scope === "exact_task_signature") return "exact task signature matched prior successful work";
  if (scope === "same_task_family") return "same task family matched prior successful work";
  if (scope === "same_error_family") return "same error family matched prior recovery or validation work";
  return "broader similarity was the strongest reusable provenance signal";
}

function familyCandidateCount(surface: PlannerPacketSummarySurface, taskFamily: string | null): number {
  if (!taskFamily) return 0;
  return collectTaskFamilyCounts(surface).get(taskFamily) ?? 0;
}

function summarizeStrategyPatternSelections(args: {
  surface: PlannerPacketSummarySurface;
  tools?: unknown;
}): string[] {
  const trustedPatterns = safeRecordArray(args.surface.trusted_patterns);
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const decision = tools.decision && typeof tools.decision === "object" ? (tools.decision as Record<string, unknown>) : {};
  const patternSummary =
    decision.pattern_summary && typeof decision.pattern_summary === "object"
      ? (decision.pattern_summary as Record<string, unknown>)
      : {};
  const selectedAnchorIds = new Set(safeStringArray(patternSummary.used_trusted_pattern_anchor_ids));
  const preferredTrustedPatterns =
    selectedAnchorIds.size > 0
      ? trustedPatterns.filter((entry) => typeof entry.anchor_id === "string" && selectedAnchorIds.has(entry.anchor_id))
      : trustedPatterns;
  return uniqueStrings(
    preferredTrustedPatterns.map((entry) => {
      const selectedTool = typeof entry.selected_tool === "string" ? entry.selected_tool.trim() : "";
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (selectedTool && summary) return `[${selectedTool}] ${summary}`;
      return summary || selectedTool || (typeof entry.anchor_id === "string" ? entry.anchor_id : "");
    }),
    4,
  );
}

function collectStrategyPreferredArtifactRefs(surface: PlannerPacketSummarySurface): string[] {
  return uniqueStrings([
    ...safeRecordArray(surface.recommended_workflows).map((entry) => {
      if (typeof entry.anchor_uri === "string" && entry.anchor_uri.trim()) return entry.anchor_uri.trim();
      if (typeof entry.uri === "string" && entry.uri.trim()) return entry.uri.trim();
      if (typeof entry.anchor_id === "string" && entry.anchor_id.trim()) return `anchor:${entry.anchor_id.trim()}`;
      return "";
    }),
    ...safeRecordArray(surface.rehydration_candidates).map((entry) => {
      if (typeof entry.anchor_uri === "string" && entry.anchor_uri.trim()) return entry.anchor_uri.trim();
      if (typeof entry.anchor_id === "string" && entry.anchor_id.trim()) return `anchor:${entry.anchor_id.trim()}`;
      return "";
    }),
  ], 6);
}

function buildStrategyWorkingSet(args: {
  summaryBundle: ExecutionMemorySummaryBundle;
  tools?: unknown;
  costSignals?: unknown;
}): string[] {
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const selection = tools.selection && typeof tools.selection === "object" ? (tools.selection as Record<string, unknown>) : {};
  const selectedTool = typeof selection.selected === "string" ? selection.selected.trim() : "";
  const costSignals = args.costSignals && typeof args.costSignals === "object" ? (args.costSignals as Record<string, unknown>) : {};
  return uniqueStrings([
    selectedTool ? `tool:${selectedTool}` : "",
    ...safeStringArray(costSignals.selected_memory_layers).map((layer) => `memory:${layer}`),
    ...args.summaryBundle.workflow_signal_summary.stable_workflow_titles.map((title) => `workflow:${title}`),
    ...args.summaryBundle.workflow_signal_summary.promotion_ready_workflow_titles.map((title) => `candidate:${title}`),
    ...args.summaryBundle.pattern_signal_summary.trusted_pattern_tools.map((tool) => `pattern:${tool}`),
  ], 8);
}

function buildStrategyValidationPaths(args: {
  summaryBundle: ExecutionMemorySummaryBundle;
  tools?: unknown;
}): string[] {
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const selection = tools.selection && typeof tools.selection === "object" ? (tools.selection as Record<string, unknown>) : {};
  const selectedTool = typeof selection.selected === "string" ? selection.selected.trim() : "";
  const out: string[] = [];
  if (args.summaryBundle.action_packet_summary.rehydration_candidate_count > 0) {
    out.push("rehydrate a stable workflow before widening recall");
  }
  if (args.summaryBundle.workflow_signal_summary.promotion_ready_workflow_count > 0) {
    out.push("validate promotion-ready workflows before promoting broader reuse");
  }
  if (args.summaryBundle.pattern_signal_summary.contested_pattern_count > 0) {
    out.push("review contested patterns before broader tool exploration");
  }
  if (selectedTool) {
    out.push(`confirm ${selectedTool} on a narrow slice before expanding scope`);
  } else if (args.summaryBundle.pattern_signal_summary.trusted_pattern_count > 0) {
    out.push("reuse trusted patterns on the current slice before expanding scope");
  }
  if (out.length === 0) {
    out.push("probe a narrow task slice, then expand only after the first success signal");
  }
  return uniqueStrings(out, 4);
}

function buildExecutionStrategyProfile(args: {
  summaryBundle: ExecutionMemorySummaryBundle;
  familyScope: string;
}): string {
  if (
    args.summaryBundle.workflow_signal_summary.stable_workflow_count > 0
    && args.summaryBundle.action_packet_summary.rehydration_candidate_count > 0
  ) {
    return "rehydration_first";
  }
  if (args.summaryBundle.workflow_signal_summary.stable_workflow_count > 0) {
    return "workflow_reuse_first";
  }
  if (args.summaryBundle.pattern_signal_summary.trusted_pattern_count > 0) {
    return "pattern_reuse_first";
  }
  if (args.familyScope !== "broader_similarity") {
    return "guided_reuse";
  }
  return "broad_discovery";
}

function buildExecutionValidationStyle(summaryBundle: ExecutionMemorySummaryBundle): string {
  if (summaryBundle.pattern_signal_summary.contested_pattern_count > 0) {
    return "validate_before_expansion";
  }
  if (summaryBundle.workflow_signal_summary.promotion_ready_workflow_count > 0) {
    return "candidate_promotion_validation";
  }
  if (
    summaryBundle.workflow_signal_summary.stable_workflow_count > 0
    || summaryBundle.pattern_signal_summary.trusted_pattern_count > 0
  ) {
    return "reuse_then_validate";
  }
  return "targeted_then_expand";
}

function buildExecutionStrategyExplanation(args: {
  taskFamily: string | null;
  familyScope: string;
  strategyProfile: string;
  validationStyle: string;
  familyCandidateCount: number;
}): string {
  const profileExplanation =
    args.strategyProfile === "rehydration_first"
      ? "stable workflow rehydration should happen before broader recall"
      : args.strategyProfile === "workflow_reuse_first"
        ? "stable workflows are strong enough to lead the next execution"
        : args.strategyProfile === "pattern_reuse_first"
          ? "trusted tool-selection patterns are the strongest reusable signal"
          : args.strategyProfile === "guided_reuse"
            ? "family-level provenance is strong enough to scope the next attempt"
            : "no strong reuse signal is available, so discovery stays broad";
  const validationExplanation =
    args.validationStyle === "validate_before_expansion"
      ? "contested signals should be checked before widening scope"
      : args.validationStyle === "candidate_promotion_validation"
        ? "promotion-ready workflows should be validated before broadening reuse"
        : args.validationStyle === "reuse_then_validate"
          ? "trusted reusable guidance should be applied first, then validated on-slice"
          : "the first narrow success should define whether to widen recall";
  const familyDetail =
    args.taskFamily && args.familyCandidateCount > 0
      ? ` ${args.familyCandidateCount} surfaced anchors matched ${args.taskFamily}.`
      : "";
  return `Selected because ${familyReason(args.familyScope)}. ${profileExplanation}; ${validationExplanation}.${familyDetail}`.trim();
}

export function dominantFamilyScope(args: {
  tools?: unknown;
  surface: PlannerPacketSummarySurface;
}): string {
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const decision = tools.decision && typeof tools.decision === "object" ? (tools.decision as Record<string, unknown>) : {};
  const patternSummary =
    decision.pattern_summary && typeof decision.pattern_summary === "object"
      ? (decision.pattern_summary as Record<string, unknown>)
      : {};
  const candidates = [
    ...safeStringArray(patternSummary.used_trusted_pattern_affinity_levels),
    ...safeStringArray(patternSummary.skipped_contested_pattern_affinity_levels),
    ...safeStringArray(patternSummary.skipped_suppressed_pattern_affinity_levels),
    ...safeRecordArray(tools.pattern_matches && typeof tools.pattern_matches === "object" ? (tools.pattern_matches as Record<string, unknown>).anchors : [])
      .map((entry) => (typeof entry.affinity_level === "string" ? entry.affinity_level.trim() : ""))
      .filter(Boolean),
  ];
  return candidates.sort((a, b) => affinityRank(b) - affinityRank(a))[0] ?? "broader_similarity";
}

export function buildExecutionStrategySummary(args: {
  surface: PlannerPacketSummarySurface;
  summaryBundle: ExecutionMemorySummaryBundle;
  tools?: unknown;
  costSignals?: unknown;
}): ExecutionStrategySummary {
  const taskFamily = dominantTaskFamily(args.surface);
  const familyScope = dominantFamilyScope({ tools: args.tools, surface: args.surface });
  const strategyProfile = buildExecutionStrategyProfile({
    summaryBundle: args.summaryBundle,
    familyScope,
  });
  const validationStyle = buildExecutionValidationStyle(args.summaryBundle);
  const candidateCount = familyCandidateCount(args.surface, taskFamily);
  return {
    summary_version: "execution_strategy_summary_v1",
    trust_signal: familyScope,
    strategy_profile: strategyProfile,
    validation_style: validationStyle,
    task_family: taskFamily,
    family_scope: familyScope,
    family_candidate_count: candidateCount,
    selected_working_set: buildStrategyWorkingSet({
      summaryBundle: args.summaryBundle,
      tools: args.tools,
      costSignals: args.costSignals,
    }),
    selected_validation_paths: buildStrategyValidationPaths({
      summaryBundle: args.summaryBundle,
      tools: args.tools,
    }),
    selected_pattern_summaries: summarizeStrategyPatternSelections({
      surface: args.surface,
      tools: args.tools,
    }),
    preferred_artifact_refs: collectStrategyPreferredArtifactRefs(args.surface),
    explanation: buildExecutionStrategyExplanation({
      taskFamily,
      familyScope,
      strategyProfile,
      validationStyle,
      familyCandidateCount: candidateCount,
    }),
  };
}

function buildExecutionCollaborationMode(args: {
  packetPresent: boolean;
  reviewContractPresent: boolean;
  resumeAnchorPresent: boolean;
  artifactRefCount: number;
  evidenceRefCount: number;
  sideOutputArtifactCount: number;
  sideOutputEvidenceCount: number;
}): string {
  if (args.reviewContractPresent) return "reviewer_ready";
  if (
    args.resumeAnchorPresent
    && (args.artifactRefCount > 0 || args.evidenceRefCount > 0 || args.sideOutputArtifactCount > 0 || args.sideOutputEvidenceCount > 0)
  ) {
    return "resume_with_artifacts";
  }
  if (args.resumeAnchorPresent) return "resume_ready";
  if (args.artifactRefCount > 0 || args.evidenceRefCount > 0 || args.sideOutputArtifactCount > 0 || args.sideOutputEvidenceCount > 0) {
    return "artifact_backed";
  }
  if (args.packetPresent) return "solo_packet";
  return "memory_only";
}

export function buildExecutionCollaborationSummary(args: {
  executionPacket?: unknown;
  executionArtifacts?: unknown;
  executionEvidence?: unknown;
}): ExecutionCollaborationSummary {
  const packet =
    args.executionPacket && typeof args.executionPacket === "object" && !Array.isArray(args.executionPacket)
      ? (args.executionPacket as Record<string, unknown>)
      : null;
  const reviewContract =
    packet?.review_contract && typeof packet.review_contract === "object" && !Array.isArray(packet.review_contract)
      ? (packet.review_contract as Record<string, unknown>)
      : null;
  const resumeAnchor =
    packet?.resume_anchor && typeof packet.resume_anchor === "object" && !Array.isArray(packet.resume_anchor)
      ? (packet.resume_anchor as Record<string, unknown>)
      : null;
  const artifactRefs = safeStringArray(packet?.artifact_refs);
  const evidenceRefs = safeStringArray(packet?.evidence_refs);
  const sideOutputArtifacts = safeRecordArray(args.executionArtifacts);
  const sideOutputEvidence = safeRecordArray(args.executionEvidence);
  const packetPresent = !!packet;
  const reviewContractPresent = !!reviewContract;
  const resumeAnchorPresent = !!resumeAnchor;
  return {
    summary_version: "execution_collaboration_summary_v1",
    packet_present: packetPresent,
    coordination_mode: buildExecutionCollaborationMode({
      packetPresent,
      reviewContractPresent,
      resumeAnchorPresent,
      artifactRefCount: artifactRefs.length,
      evidenceRefCount: evidenceRefs.length,
      sideOutputArtifactCount: sideOutputArtifacts.length,
      sideOutputEvidenceCount: sideOutputEvidence.length,
    }),
    current_stage: typeof packet?.current_stage === "string" ? packet.current_stage : null,
    active_role: typeof packet?.active_role === "string" ? packet.active_role : null,
    next_action: typeof packet?.next_action === "string" ? packet.next_action : null,
    target_file_count: safeStringArray(packet?.target_files).length,
    pending_validation_count: safeStringArray(packet?.pending_validations).length,
    unresolved_blocker_count: safeStringArray(packet?.unresolved_blockers).length,
    review_contract_present: reviewContractPresent,
    review_standard: typeof reviewContract?.standard === "string" ? reviewContract.standard : null,
    acceptance_check_count: safeStringArray(reviewContract?.acceptance_checks).length,
    rollback_required: reviewContract?.rollback_required === true,
    resume_anchor_present: resumeAnchorPresent,
    resume_anchor_file_path: typeof resumeAnchor?.file_path === "string" ? resumeAnchor.file_path : null,
    resume_anchor_symbol: typeof resumeAnchor?.symbol === "string" ? resumeAnchor.symbol : null,
    artifact_ref_count: artifactRefs.length,
    evidence_ref_count: evidenceRefs.length,
    side_output_artifact_count: sideOutputArtifacts.length,
    side_output_evidence_count: sideOutputEvidence.length,
    artifact_refs: artifactRefs.slice(0, 6),
    evidence_refs: evidenceRefs.slice(0, 6),
  };
}

export function buildExecutionContinuitySnapshotSummary(args: {
  strategySummary: ExecutionStrategySummary;
  collaborationSummary: ExecutionCollaborationSummary;
  routingSummary: ExecutionRoutingSignalSummary;
  maintenanceSummary: ExecutionMaintenanceSummary;
}): ExecutionContinuitySnapshotSummary {
  const nextAction =
    args.collaborationSummary.next_action
    ?? args.strategySummary.selected_validation_paths[0]
    ?? (args.routingSummary.selected_tool ? `Start with ${args.routingSummary.selected_tool} as the next step.` : null);
  return {
    summary_version: "execution_continuity_snapshot_v1",
    snapshot_mode: args.collaborationSummary.packet_present ? "packet_backed" : "memory_only",
    coordination_mode: args.collaborationSummary.coordination_mode,
    trust_signal: args.strategySummary.trust_signal,
    strategy_profile: args.strategySummary.strategy_profile,
    validation_style: args.strategySummary.validation_style,
    task_family: args.strategySummary.task_family,
    family_scope: args.strategySummary.family_scope,
    selected_tool: args.routingSummary.selected_tool,
    current_stage: args.collaborationSummary.current_stage,
    active_role: args.collaborationSummary.active_role,
    next_action: nextAction,
    working_set: uniqueStrings([
      ...args.strategySummary.selected_working_set,
      args.collaborationSummary.resume_anchor_file_path ? `resume:${args.collaborationSummary.resume_anchor_file_path}` : "",
    ], 8),
    validation_paths: uniqueStrings(args.strategySummary.selected_validation_paths, 4),
    selected_pattern_summaries: uniqueStrings(args.strategySummary.selected_pattern_summaries, 4),
    preferred_artifact_refs: uniqueStrings([
      ...args.strategySummary.preferred_artifact_refs,
      ...args.collaborationSummary.artifact_refs,
    ], 6),
    preferred_evidence_refs: uniqueStrings(args.collaborationSummary.evidence_refs, 6),
    reviewer_ready: args.collaborationSummary.review_contract_present,
    resume_anchor_file_path: args.collaborationSummary.resume_anchor_file_path,
    selected_memory_layers: uniqueStrings(args.maintenanceSummary.selected_memory_layers, 6),
    recommended_action: args.maintenanceSummary.recommended_action,
  };
}
