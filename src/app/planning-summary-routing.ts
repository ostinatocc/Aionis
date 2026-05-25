import type {
  ExecutionArtifactRoutingRecord,
  ExecutionCollaborationRoutingSummary,
  ExecutionCollaborationSummary,
  ExecutionDelegationPacketRecord,
  ExecutionDelegationRecordsSummary,
  ExecutionDelegationReturnRecord,
  ExecutionInstrumentationSummary,
  ExecutionMemorySummaryBundle,
  ExecutionRoutingSignalSummary,
  ExecutionStrategySummary,
} from "./planning-summary.js";
import { dominantFamilyScope, dominantTaskFamily, familyReason } from "./planning-summary-execution.js";
import { safeRecordArray, safeStringArray, uniqueStrings } from "./planning-summary-utils.js";

type PlannerPacketSummarySurface = {
  recommended_workflows?: unknown;
  candidate_workflows?: unknown;
  rehydration_candidates?: unknown;
};

function deriveExecutionRouteIntent(args: {
  collaborationSummary: ExecutionCollaborationSummary;
  strategySummary: ExecutionStrategySummary;
  routingSummary: ExecutionRoutingSignalSummary;
}): string {
  if (args.collaborationSummary.active_role && args.collaborationSummary.active_role !== "orchestrator") {
    return args.collaborationSummary.active_role;
  }
  if (args.collaborationSummary.current_stage) {
    return args.collaborationSummary.current_stage;
  }
  if (args.collaborationSummary.review_contract_present) return "review";
  if (args.collaborationSummary.resume_anchor_present) return "resume";
  if (
    args.routingSummary.selected_tool
    || args.strategySummary.selected_validation_paths.length > 0
    || args.strategySummary.selected_working_set.length > 0
  ) {
    return "memory_guided";
  }
  return "observe";
}

export function buildExecutionCollaborationRoutingSummary(args: {
  executionPacket?: unknown;
  strategySummary: ExecutionStrategySummary;
  collaborationSummary: ExecutionCollaborationSummary;
  routingSummary: ExecutionRoutingSignalSummary;
}): ExecutionCollaborationRoutingSummary {
  const packet =
    args.executionPacket && typeof args.executionPacket === "object" && !Array.isArray(args.executionPacket)
      ? (args.executionPacket as Record<string, unknown>)
      : null;
  const reviewContract =
    packet?.review_contract && typeof packet.review_contract === "object" && !Array.isArray(packet.review_contract)
      ? (packet.review_contract as Record<string, unknown>)
      : null;
  const targetFiles = uniqueStrings([
    ...safeStringArray(packet?.target_files),
    args.collaborationSummary.resume_anchor_file_path ?? "",
  ], 8);
  const validationPaths = uniqueStrings([
    ...safeStringArray(packet?.pending_validations),
    ...args.strategySummary.selected_validation_paths,
  ], 6);
  const unresolvedBlockers = uniqueStrings(safeStringArray(packet?.unresolved_blockers), 4);
  const hardConstraints = uniqueStrings(safeStringArray(packet?.hard_constraints), 4);
  const requiredOutputs = uniqueStrings(safeStringArray(reviewContract?.required_outputs), 4);
  const acceptanceChecks = uniqueStrings(safeStringArray(reviewContract?.acceptance_checks), 6);
  const preferredArtifactRefs = uniqueStrings([
    ...args.strategySummary.preferred_artifact_refs,
    ...args.collaborationSummary.artifact_refs,
  ], 6);
  const preferredEvidenceRefs = uniqueStrings(args.collaborationSummary.evidence_refs, 6);
  return {
    summary_version: "execution_collaboration_routing_v1",
    route_mode: args.collaborationSummary.packet_present ? "packet_backed" : "memory_only",
    coordination_mode: args.collaborationSummary.coordination_mode,
    route_intent: deriveExecutionRouteIntent({
      collaborationSummary: args.collaborationSummary,
      strategySummary: args.strategySummary,
      routingSummary: args.routingSummary,
    }),
    task_brief: typeof packet?.task_brief === "string" ? packet.task_brief : null,
    current_stage: args.collaborationSummary.current_stage,
    active_role: args.collaborationSummary.active_role,
    selected_tool: args.routingSummary.selected_tool,
    task_family: args.routingSummary.task_family,
    family_scope: args.routingSummary.family_scope,
    next_action:
      args.collaborationSummary.next_action
      ?? args.strategySummary.selected_validation_paths[0]
      ?? null,
    target_files: targetFiles,
    validation_paths: validationPaths,
    unresolved_blockers: unresolvedBlockers,
    hard_constraints: hardConstraints,
    review_standard: args.collaborationSummary.review_standard,
    required_outputs: requiredOutputs,
    acceptance_checks: acceptanceChecks,
    preferred_artifact_refs: preferredArtifactRefs,
    preferred_evidence_refs: preferredEvidenceRefs,
    routing_drivers: uniqueStrings([
      args.collaborationSummary.review_contract_present ? "review_contract" : "",
      args.collaborationSummary.rollback_required ? "rollback_required" : "",
      args.collaborationSummary.resume_anchor_present ? "resume_anchor" : "",
      targetFiles.length > 0 ? "target_files" : "",
      validationPaths.length > 0 ? "validation_paths" : "",
      unresolvedBlockers.length > 0 ? "unresolved_blockers" : "",
      hardConstraints.length > 0 ? "hard_constraints" : "",
      preferredArtifactRefs.length > 0 ? "artifact_preference" : "",
      preferredEvidenceRefs.length > 0 ? "evidence_preference" : "",
      args.routingSummary.selected_tool ? `selected_tool:${args.routingSummary.selected_tool}` : "",
      args.routingSummary.task_family ? `task_family:${args.routingSummary.task_family}` : "",
      `family_scope:${args.routingSummary.family_scope}`,
      args.routingSummary.stable_workflow_anchor_ids.length > 0 ? "stable_workflow_available" : "",
      args.routingSummary.rehydration_anchor_ids.length > 0 ? "rehydration_candidate_available" : "",
    ], 12),
  };
}

function deriveExecutionRouteRole(summary: ExecutionCollaborationRoutingSummary): string {
  if (summary.active_role) return summary.active_role;
  if (summary.route_intent === "memory_guided") return "orchestrator";
  return summary.route_intent;
}

function buildExecutionDelegationMission(args: {
  routingSummary: ExecutionCollaborationRoutingSummary;
  routeRole: string;
}): string {
  const brief = args.routingSummary.task_brief?.trim() ?? "";
  const nextAction = args.routingSummary.next_action?.trim() ?? "";
  if (brief && nextAction) return `${brief} Next action: ${nextAction}`;
  if (brief) return brief;
  if (nextAction) return nextAction;
  return `Advance the ${args.routeRole} route for the current execution slice.`;
}

function buildExecutionDelegationOutputContract(args: {
  routingSummary: ExecutionCollaborationRoutingSummary;
  routeRole: string;
}): string {
  if (args.routingSummary.review_standard) {
    return `Satisfy ${args.routingSummary.review_standard} and return the required outputs with exact validation status.`;
  }
  if (args.routingSummary.route_intent === "resume") {
    return "Return resumed working set, current blockers, and the next validation step.";
  }
  if (args.routingSummary.route_intent === "review") {
    return "Return review findings, exact checks run, and any blocking risks before acceptance.";
  }
  if (args.routingSummary.selected_tool) {
    return `Return progress on the ${args.routingSummary.selected_tool} slice, touched files, and the next narrow validation step.`;
  }
  return `Return progress, routed artifacts, and the next step for the ${args.routeRole} route.`;
}

function buildExecutionDelegationPacketRecord(args: {
  routingSummary: ExecutionCollaborationRoutingSummary;
  strategySummary: ExecutionStrategySummary;
}): ExecutionDelegationPacketRecord {
  const routeRole = deriveExecutionRouteRole(args.routingSummary);
  return {
    version: 1,
    role: routeRole,
    mission: buildExecutionDelegationMission({
      routingSummary: args.routingSummary,
      routeRole,
    }),
    working_set: uniqueStrings([
      ...args.routingSummary.target_files,
      ...args.strategySummary.selected_working_set,
    ], 8),
    acceptance_checks: uniqueStrings([
      ...args.routingSummary.acceptance_checks,
      ...args.routingSummary.validation_paths,
    ], 6),
    output_contract: buildExecutionDelegationOutputContract({
      routingSummary: args.routingSummary,
      routeRole,
    }),
    preferred_artifact_refs: uniqueStrings(args.routingSummary.preferred_artifact_refs, 6),
    inherited_evidence: uniqueStrings(args.routingSummary.preferred_evidence_refs, 6),
    routing_reason: args.routingSummary.routing_drivers.slice(0, 4).join("; ") || "current execution route",
    task_family: args.routingSummary.task_family,
    family_scope: args.routingSummary.family_scope,
    source_mode: args.routingSummary.route_mode,
  };
}

function buildExecutionArtifactRoutingRecords(args: {
  routingSummary: ExecutionCollaborationRoutingSummary;
  strategySummary: ExecutionStrategySummary;
  collaborationSummary: ExecutionCollaborationSummary;
}): ExecutionArtifactRoutingRecord[] {
  const routeRole = deriveExecutionRouteRole(args.routingSummary);
  const records: ExecutionArtifactRoutingRecord[] = [];
  for (const ref of args.routingSummary.preferred_artifact_refs) {
    const source: ExecutionArtifactRoutingRecord["source"] = args.collaborationSummary.artifact_refs.includes(ref)
      ? "execution_packet"
      : args.strategySummary.preferred_artifact_refs.includes(ref)
        ? "strategy_summary"
        : "collaboration_summary";
    records.push({
      version: 1,
      ref,
      ref_kind: "artifact",
      route_role: routeRole,
      route_intent: args.routingSummary.route_intent,
      route_mode: args.routingSummary.route_mode,
      task_family: args.routingSummary.task_family,
      family_scope: args.routingSummary.family_scope,
      routing_reason:
        source === "execution_packet"
          ? "artifact routed from the active execution packet"
          : "artifact preferred by the current execution strategy",
      source,
    });
  }
  for (const ref of args.routingSummary.preferred_evidence_refs) {
    records.push({
      version: 1,
      ref,
      ref_kind: "evidence",
      route_role: routeRole,
      route_intent: args.routingSummary.route_intent,
      route_mode: args.routingSummary.route_mode,
      task_family: args.routingSummary.task_family,
      family_scope: args.routingSummary.family_scope,
      routing_reason: "evidence inherited from the active execution packet",
      source: "execution_packet",
    });
  }
  return records;
}

export function buildExecutionDelegationRecordsSummary(args: {
  strategySummary: ExecutionStrategySummary;
  collaborationSummary: ExecutionCollaborationSummary;
  collaborationRoutingSummary: ExecutionCollaborationRoutingSummary;
}): ExecutionDelegationRecordsSummary {
  const delegationPackets = [buildExecutionDelegationPacketRecord({
    routingSummary: args.collaborationRoutingSummary,
    strategySummary: args.strategySummary,
  })];
  const delegationReturns: ExecutionDelegationReturnRecord[] = [];
  const artifactRoutingRecords = buildExecutionArtifactRoutingRecords({
    routingSummary: args.collaborationRoutingSummary,
    strategySummary: args.strategySummary,
    collaborationSummary: args.collaborationSummary,
  });
  return {
    summary_version: "execution_delegation_records_v1",
    record_mode: args.collaborationRoutingSummary.route_mode,
    route_role: deriveExecutionRouteRole(args.collaborationRoutingSummary),
    packet_count: delegationPackets.length,
    return_count: delegationReturns.length,
    artifact_routing_count: artifactRoutingRecords.length,
    missing_record_types: ["delegation_returns"],
    delegation_packets: delegationPackets,
    delegation_returns: delegationReturns,
    artifact_routing_records: artifactRoutingRecords,
  };
}

function rehydrationFamilyBuckets(args: {
  surface: PlannerPacketSummarySurface;
  taskFamily: string | null;
}) {
  const entries = safeRecordArray(args.surface.rehydration_candidates);
  const sameFamily: string[] = [];
  const otherFamily: string[] = [];
  const unknownFamily: string[] = [];
  for (const entry of entries) {
    const anchorId = typeof entry.anchor_id === "string" ? entry.anchor_id.trim() : "";
    if (!anchorId) continue;
    const entryTaskFamily = typeof entry.task_family === "string" ? entry.task_family.trim() : "";
    if (!entryTaskFamily) {
      unknownFamily.push(anchorId);
      continue;
    }
    if (args.taskFamily && entryTaskFamily === args.taskFamily) {
      sameFamily.push(anchorId);
    } else {
      otherFamily.push(anchorId);
    }
  }
  return { sameFamily, otherFamily, unknownFamily };
}

export function buildExecutionRoutingSignalSummary(args: {
  surface: PlannerPacketSummarySurface;
  summaryBundle: ExecutionMemorySummaryBundle;
  tools?: unknown;
}): ExecutionRoutingSignalSummary {
  const taskFamily = dominantTaskFamily(args.surface);
  const familyScope = dominantFamilyScope({ tools: args.tools, surface: args.surface });
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const selection = tools.selection && typeof tools.selection === "object" ? (tools.selection as Record<string, unknown>) : {};
  const selectedTool = typeof selection.selected === "string" ? selection.selected : null;
  const recommended = safeRecordArray(args.surface.recommended_workflows);
  const candidate = safeRecordArray(args.surface.candidate_workflows);
  const workflowSourceKinds = uniqueStrings([
    ...recommended.map((entry) => entry.source_kind),
    ...candidate.map((entry) => entry.source_kind),
  ]);
  const buckets = rehydrationFamilyBuckets({ surface: args.surface, taskFamily });
  return {
    summary_version: "execution_routing_summary_v1",
    selected_tool: selectedTool,
    task_family: taskFamily,
    family_scope: familyScope,
    stable_workflow_anchor_ids: args.summaryBundle.action_packet_summary.workflow_anchor_ids,
    candidate_workflow_anchor_ids: args.summaryBundle.action_packet_summary.candidate_workflow_anchor_ids,
    rehydration_anchor_ids: args.summaryBundle.action_packet_summary.rehydration_anchor_ids,
    workflow_source_kinds: workflowSourceKinds,
    same_family_rehydration_anchor_ids: buckets.sameFamily,
    other_family_rehydration_anchor_ids: buckets.otherFamily,
    unknown_family_rehydration_anchor_ids: buckets.unknownFamily,
  };
}

export function buildExecutionInstrumentationSummary(args: {
  surface: PlannerPacketSummarySurface;
  summaryBundle: ExecutionMemorySummaryBundle;
  tools?: unknown;
}): ExecutionInstrumentationSummary {
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const decision = tools.decision && typeof tools.decision === "object" ? (tools.decision as Record<string, unknown>) : {};
  const patternSummary =
    decision.pattern_summary && typeof decision.pattern_summary === "object"
      ? (decision.pattern_summary as Record<string, unknown>)
      : {};
  const familyScope = dominantFamilyScope({ tools: args.tools, surface: args.surface });
  const taskFamily = dominantTaskFamily(args.surface);
  const usedTrustedPatternAnchorIds = safeStringArray(patternSummary.used_trusted_pattern_anchor_ids);
  const skippedContestedPatternAnchorIds = safeStringArray(patternSummary.skipped_contested_pattern_anchor_ids);
  const skippedSuppressedPatternAnchorIds = safeStringArray(patternSummary.skipped_suppressed_pattern_anchor_ids);
  const buckets = rehydrationFamilyBuckets({ surface: args.surface, taskFamily });
  const knownCount = buckets.sameFamily.length + buckets.otherFamily.length;
  const totalRehydration = args.summaryBundle.action_packet_summary.rehydration_candidate_count;
  return {
    summary_version: "execution_instrumentation_summary_v1",
    task_family: taskFamily,
    family_scope: familyScope,
    family_hit: familyScope !== "broader_similarity" || usedTrustedPatternAnchorIds.length > 0,
    family_reason: familyReason(familyScope),
    selected_pattern_hit_count: usedTrustedPatternAnchorIds.length,
    selected_pattern_miss_count: skippedContestedPatternAnchorIds.length + skippedSuppressedPatternAnchorIds.length,
    rehydration_candidate_count: totalRehydration,
    known_family_rehydration_count: knownCount,
    same_family_rehydration_count: buckets.sameFamily.length,
    other_family_rehydration_count: buckets.otherFamily.length,
    unknown_family_rehydration_count: buckets.unknownFamily.length,
    rehydration_family_hit_rate: totalRehydration > 0 ? buckets.sameFamily.length / totalRehydration : 0,
    same_family_rehydration_anchor_ids: buckets.sameFamily,
    other_family_rehydration_anchor_ids: buckets.otherFamily,
  };
}
