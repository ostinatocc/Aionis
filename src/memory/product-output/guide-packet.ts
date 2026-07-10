import type {
  AssemblySummary,
  ContractTrust,
  ExecutionSummary,
  ContinuityGuidance,
  PlanningSummary,
} from "../../app/planning-summary.js";
import {
  parseAionisGuidePacket,
  type AionisGuidePacket,
} from "../product-output-contract.js";
import type { AionisGuidanceAuthority } from "../governance-contract.js";
import {
  authorityConsumptionStablePromotionBlockedCount,
} from "../authority-consumption.js";
import {
  ProductActor,
  ProductTask,
  asTask,
  compactStrings,
} from "./memory-packet.js";

type GuideAuthority = AionisGuidanceAuthority;

type WorkflowAuthority = AionisGuidePacket["guidance"]["workflow_candidates"][number]["authority"];

type WorkflowLastOutcome = NonNullable<AionisGuidePacket["guidance"]["workflow_candidates"][number]["last_outcome"]>;

function negativeTransferRisk(
  planning: PlanningSummary | AssemblySummary,
): AionisGuidePacket["risk"]["negative_transfer_risk"] {
  if (
    planning.authority_visibility_summary.authoritative_blocked_count > 0
    || planning.authority_visibility_summary.false_confidence_count > 0
    || planning.forgetting_summary.stale_signal_count > 2
  ) {
    return "high";
  }
  if (
    planning.contested_pattern_count > 0
    || planning.policy_lifecycle_summary.contested_count > 0
    || planning.workflow_signal_summary.observing_workflow_count > 0
    || planning.forgetting_summary.stale_signal_count > 0
  ) {
    return "medium";
  }
  return "low";
}

export type BuildAionisGuidePacketArgs = {
  tenant_id: string;
  scope: string;
  actor?: ProductActor;
  task?: ProductTask;
  planning: PlanningSummary | AssemblySummary;
  execution_summary?: ExecutionSummary | null;
  source_map?: Partial<AionisGuidePacket["source_map"]>;
};

function mapAuthority(trust: ContractTrust | null | undefined, blocked: boolean): GuideAuthority {
  if (blocked) return "blocked";
  if (trust === "authoritative") return "trusted";
  if (trust === "advisory") return "advisory";
  if (trust === "observational") return "candidate";
  return "none";
}

function workflowAuthority(trust: ContractTrust | null | undefined, fallback: WorkflowAuthority): WorkflowAuthority {
  if (trust === "authoritative") return "trusted";
  if (trust === "advisory") return "advisory";
  if (trust === "observational") return "candidate";
  return fallback;
}

function recoverTargetFiles(args: {
  firstStep: ContinuityGuidance | null;
  executionSummary: ExecutionSummary | null | undefined;
}): string[] {
  return compactStrings([
    ...(args.firstStep?.continuity_signal_v1?.target_files ?? []),
    args.firstStep?.continuity_signal_v1?.file_path ?? null,
    args.firstStep?.file_path ?? null,
    ...(args.firstStep?.edit_boundary_v1?.allowed_edit_files ?? []),
    ...(args.executionSummary?.collaboration_routing_summary.target_files ?? []),
    ...(args.executionSummary?.continuity_snapshot_summary.working_set ?? []),
  ]);
}

function recoverAcceptanceChecks(args: {
  firstStep: ContinuityGuidance | null;
  executionSummary: ExecutionSummary | null | undefined;
}): string[] {
  return compactStrings([
    ...(args.firstStep?.edit_boundary_v1?.required_verifiers ?? []),
    ...(args.firstStep?.verification_repair_v1?.failed_commands ?? []),
    ...(args.executionSummary?.collaboration_routing_summary.acceptance_checks ?? []),
    ...(args.executionSummary?.continuity_snapshot_summary.validation_paths ?? []),
  ]);
}

function buildWorkflowCandidates(
  planning: PlanningSummary | AssemblySummary,
): AionisGuidePacket["guidance"]["workflow_candidates"] {
  const candidates: AionisGuidePacket["guidance"]["workflow_candidates"] = [];
  const stableIds = planning.action_packet_summary.workflow_anchor_ids;
  const stableTitles = planning.workflow_signal_summary.stable_workflow_titles;
  const stableOutcomes = planning.action_packet_summary.workflow_anchor_last_outcomes ?? [];
  for (let index = 0; index < stableIds.length; index += 1) {
    const workflowId = stableIds[index];
    if (!workflowId) continue;
    const outcome = workflowCandidateOutcomeAt(stableOutcomes, index, "success");
    const authority = workflowCandidateAuthorityForOutcome({
      outcome,
      stable: true,
      fallback: "trusted",
    });
    mergeWorkflowCandidate(candidates, {
      workflow_id: workflowId,
      title: stableTitles[index] ?? workflowId,
      authority,
      evidence_count: Math.max(1, planning.workflow_lifecycle_summary.stable_count),
      last_outcome: outcome,
      reuse_reason: workflowCandidateReuseReason({ outcome, stable: true }),
    });
  }

  const candidateIds = planning.action_packet_summary.candidate_workflow_anchor_ids;
  const candidateTitles = [
    ...planning.workflow_signal_summary.promotion_ready_workflow_titles,
    ...planning.workflow_signal_summary.observing_workflow_titles,
  ];
  const candidateOutcomes = planning.action_packet_summary.candidate_workflow_anchor_last_outcomes ?? [];
  for (let index = 0; index < candidateIds.length; index += 1) {
    const workflowId = candidateIds[index];
    if (!workflowId) continue;
    const outcome = workflowCandidateOutcomeAt(candidateOutcomes, index, "unknown");
    const fallbackAuthority = workflowAuthority(planning.continuity_guidance?.contract_trust, "candidate");
    mergeWorkflowCandidate(candidates, {
      workflow_id: workflowId,
      title: candidateTitles[index] ?? workflowId,
      authority: workflowCandidateAuthorityForOutcome({
        outcome,
        stable: false,
        fallback: fallbackAuthority,
      }),
      evidence_count: Math.max(1, planning.workflow_lifecycle_summary.candidate_count),
      last_outcome: outcome,
      reuse_reason: workflowCandidateReuseReason({ outcome, stable: false }),
    });
  }

  return candidates.slice(0, 12);
}

function workflowOutcomePrecedence(outcome: WorkflowLastOutcome): number {
  if (outcome === "failure") return 4;
  if (outcome === "mixed") return 3;
  if (outcome === "success") return 2;
  return 1;
}

function workflowAuthorityPrecedence(authority: WorkflowAuthority): number {
  if (authority === "blocked") return 4;
  if (authority === "advisory") return 3;
  if (authority === "candidate") return 2;
  return 1;
}

function mergeWorkflowCandidate(
  candidates: AionisGuidePacket["guidance"]["workflow_candidates"],
  incoming: AionisGuidePacket["guidance"]["workflow_candidates"][number],
): void {
  const existing = candidates.find((entry) => entry.workflow_id === incoming.workflow_id);
  if (!existing) {
    candidates.push(incoming);
    return;
  }

  const existingOutcome = existing.last_outcome ?? "unknown";
  const incomingOutcome = incoming.last_outcome ?? "unknown";
  const mergedOutcome = workflowOutcomePrecedence(incomingOutcome) > workflowOutcomePrecedence(existingOutcome)
    ? incomingOutcome
    : existingOutcome;
  const mergedAuthority = workflowAuthorityPrecedence(incoming.authority) > workflowAuthorityPrecedence(existing.authority)
    ? incoming.authority
    : existing.authority;
  existing.authority = mergedAuthority;
  existing.last_outcome = mergedOutcome;
  existing.evidence_count = Math.max(existing.evidence_count, incoming.evidence_count);
  existing.title = existing.title === existing.workflow_id ? incoming.title : existing.title;
  if (mergedOutcome === incoming.last_outcome || mergedAuthority === incoming.authority) {
    existing.reuse_reason = incoming.reuse_reason;
  }
}

function workflowCandidateOutcomeAt(
  outcomes: readonly string[],
  index: number,
  fallback: WorkflowLastOutcome,
): WorkflowLastOutcome {
  const value = outcomes[index];
  if (value === "success" || value === "failure" || value === "mixed" || value === "unknown") return value;
  return fallback;
}

function workflowCandidateAuthorityForOutcome(args: {
  outcome: WorkflowLastOutcome;
  stable: boolean;
  fallback: WorkflowAuthority;
}): WorkflowAuthority {
  if (args.outcome === "failure") return "blocked";
  if (args.outcome === "mixed") return args.stable ? "advisory" : "candidate";
  if (args.outcome === "unknown") return args.stable ? args.fallback : "candidate";
  return args.fallback;
}

function workflowCandidateReuseReason(args: {
  outcome: WorkflowLastOutcome;
  stable: boolean;
}): string {
  if (args.outcome === "failure") {
    return "Previous workflow outcome failed or was blocked; keep as counter-evidence, not a reusable route.";
  }
  if (args.outcome === "mixed") {
    return "Workflow has mixed outcome evidence; inspect before relying on it.";
  }
  if (args.outcome === "unknown") {
    return args.stable
      ? "Stable workflow memory is available, but its explicit outcome was not exposed by the planning surface."
      : "Candidate workflow evidence is visible but not product-authoritative.";
  }
  return args.stable
    ? "Stable workflow memory is available for this scope."
    : "Candidate workflow has successful outcome evidence but is not yet product-authoritative.";
}

function buildToolPreferences(
  planning: PlanningSummary | AssemblySummary,
  continuitySignalAuthority: GuideAuthority,
): AionisGuidePacket["guidance"]["tool_preferences"] {
  const preferences: AionisGuidePacket["guidance"]["tool_preferences"] = [];
  const selectedTool = planning.selected_tool ?? planning.continuity_guidance?.selected_tool ?? null;
  if (selectedTool) {
    preferences.push({
      tool: selectedTool,
      preference: continuitySignalAuthority === "blocked" || continuitySignalAuthority === "candidate"
        ? "inspect_first"
        : "prefer",
      authority: continuitySignalAuthority === "none" ? "candidate" : continuitySignalAuthority,
      reason: "Selected by the current execution-memory planning summary.",
    });
  }
  for (const tool of planning.trusted_pattern_tools) {
    preferences.push({
      tool,
      preference: "prefer",
      authority: "trusted",
      reason: "Trusted pattern memory supports this tool.",
    });
  }
  for (const tool of planning.contested_pattern_tools) {
    preferences.push({
      tool,
      preference: "inspect_first",
      authority: "candidate",
      reason: "Contested pattern memory is visible but not trusted.",
    });
  }

  const seen = new Set<string>();
  return preferences.filter((entry) => {
    const key = `${entry.tool}:${entry.preference}:${entry.authority}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function buildRiskReasons(
  planning: PlanningSummary | AssemblySummary,
  executionSummary: ExecutionSummary | null | undefined,
): string[] {
  return compactStrings([
    ...planning.authority_visibility_summary.top_blockers,
    planning.action_intelligence_pre_action_gate?.primary_reason ?? null,
    planning.action_retrieval_gate?.primary_reason ?? null,
    planning.forgetting_summary.primary_forgetting_reason,
    executionSummary?.collaboration_summary.rollback_required
      ? "execution packet marks rollback as required"
      : null,
  ]).slice(0, 12);
}

function buildGuideHistoryContributions(
  planning: PlanningSummary | AssemblySummary,
): AionisGuidePacket["history_contributions"] {
  const handoffSourceCount =
    planning.continuity_carrier_summary.handoff_count
    + planning.distillation_signal_summary.origin_counts.handoff_continuity_carrier;
  const replaySourceCount =
    planning.workflow_lifecycle_summary.replay_source_count
    + planning.distillation_signal_summary.origin_counts.replay_learning_episode;
  const replayWorkflowIds = replaySourceCount > 0
    ? compactStrings([
        ...planning.action_packet_summary.workflow_anchor_ids,
        ...planning.action_packet_summary.candidate_workflow_anchor_ids,
      ])
    : [];

  return {
    handoff: {
      used: handoffSourceCount > 0,
      source_count: handoffSourceCount,
      source_ids: [],
      changed_fields: handoffSourceCount > 0
        ? compactStrings(["recovered_state", "history_impact.continuity"])
        : [],
      reason: handoffSourceCount > 0
        ? "Handoff continuity carriers contributed to recovered state or next-run continuity."
        : "No handoff continuity carrier contributed to this packet.",
    },
    replay: {
      used: replaySourceCount > 0,
      source_count: replaySourceCount,
      source_ids: replayWorkflowIds,
      changed_fields: replaySourceCount > 0
        ? compactStrings(["guidance.workflow_candidates", "history_impact.learning"])
        : [],
      reason: replaySourceCount > 0
        ? "Replay-derived workflow evidence contributed to workflow reuse guidance."
        : "No replay-derived workflow evidence contributed to this packet.",
    },
  };
}

function guideBriefAuthority(args: {
  actionableHistoryUsed: boolean;
  workflowCandidates: AionisGuidePacket["guidance"]["workflow_candidates"];
  toolPreferences: AionisGuidePacket["guidance"]["tool_preferences"];
  blockedAuthorityCount: number;
}): GuideAuthority {
  if (!args.actionableHistoryUsed) return "none";
  const authorities = [
    ...args.workflowCandidates.map((entry) => entry.authority),
    ...args.toolPreferences.map((entry) => entry.authority),
  ];
  if (authorities.includes("trusted")) return "trusted";
  if (authorities.includes("advisory")) return "advisory";
  if (authorities.includes("candidate")) return "candidate";
  if (args.blockedAuthorityCount > 0 || authorities.includes("blocked")) return "blocked";
  return "candidate";
}

function guideBriefPosture(args: {
  actionableHistoryUsed: boolean;
  requiredRehydrationCount: number;
  negativeTransferRisk: AionisGuidePacket["risk"]["negative_transfer_risk"];
  blockedAuthorityCount: number;
  authority: GuideAuthority;
}): AionisGuidePacket["guide_brief"]["recommended_posture"] {
  if (!args.actionableHistoryUsed) return "ignore_history";
  if (args.requiredRehydrationCount > 0) return "rehydrate_before_use";
  if (args.negativeTransferRisk === "high" || args.blockedAuthorityCount > 0 || args.authority === "blocked") return "inspect_before_use";
  if (args.authority === "trusted" || args.authority === "advisory") return "reuse_supported_history";
  return "use_as_context";
}

function guideBriefSummary(args: {
  posture: AionisGuidePacket["guide_brief"]["recommended_posture"];
  authority: GuideAuthority;
}): string {
  if (args.posture === "ignore_history") {
    return "No usable history was recovered for this query.";
  }
  if (args.posture === "rehydrate_before_use") {
    return "Relevant history exists, but compact payload rehydration is required before reuse.";
  }
  if (args.posture === "inspect_before_use") {
    return "Relevant history exists, but authority, stale-memory, or contradiction risk requires inspection before reuse.";
  }
  if (args.posture === "reuse_supported_history") {
    return args.authority === "trusted"
      ? "Trusted history can be reused to reduce repeated discovery and context replay."
      : "Advisory history can guide the run while leaving final reasoning to the Agent.";
  }
  return "History is available as context, but it is not strong enough to drive behavior directly.";
}

export function buildAionisGuideBrief(args: {
  stateSummary: string | null;
  resumable: boolean;
  targetFiles: string[];
  acceptanceChecks: string[];
  workflowCandidates: AionisGuidePacket["guidance"]["workflow_candidates"];
  toolPreferences: AionisGuidePacket["guidance"]["tool_preferences"];
  historyContributions: AionisGuidePacket["history_contributions"];
  memoryLifecycle: AionisGuidePacket["memory_lifecycle"];
  negativeTransferRisk: AionisGuidePacket["risk"]["negative_transfer_risk"];
  blockedAuthorityCount: number;
  staleMemoryCount: number;
  riskReasons: string[];
}): AionisGuidePacket["guide_brief"] {
  const trustedOrAdvisoryWorkflows = args.workflowCandidates
    .filter((entry) => entry.authority === "trusted" || entry.authority === "advisory")
    .map((entry) => `Workflow ${entry.authority}: ${entry.title}`);
  const trustedOrAdvisoryTools = args.toolPreferences
    .filter((entry) => entry.authority === "trusted" || entry.authority === "advisory")
    .map((entry) => `Tool ${entry.preference}: ${entry.tool}`);
  const candidateSurfaces = [
    ...args.workflowCandidates
      .filter((entry) => entry.authority === "candidate")
      .map((entry) => `Candidate workflow: ${entry.title}`),
    ...args.toolPreferences
      .filter((entry) => entry.authority === "candidate")
      .map((entry) => `Candidate tool preference: ${entry.tool}`),
    ...args.acceptanceChecks.map((entry) => `Verify before relying on history: ${entry}`),
  ];
  const blockedSurfaces = [
    ...args.workflowCandidates
      .filter((entry) => entry.authority === "blocked")
      .map((entry) => `Blocked workflow authority: ${entry.title}`),
    ...args.toolPreferences
      .filter((entry) => entry.authority === "blocked")
      .map((entry) => `Blocked tool preference: ${entry.tool}`),
    ...args.memoryLifecycle.suppressed_memory_ids.map((memoryId) => `Suppressed memory: ${memoryId}`),
  ];
  const historyUsed =
    args.resumable
    || args.historyContributions.handoff.used
    || args.historyContributions.replay.used
    || args.workflowCandidates.length > 0
    || args.toolPreferences.length > 0
    || args.targetFiles.length > 0;
  const actionableHistoryUsed =
    args.resumable
    || args.historyContributions.handoff.used
    || args.historyContributions.replay.used
    || trustedOrAdvisoryWorkflows.length > 0
    || trustedOrAdvisoryTools.length > 0
    || candidateSurfaces.length > 0
    || blockedSurfaces.length > 0
    || args.memoryLifecycle.rehydration_hints.length > 0
    || args.targetFiles.length > 0;
  const requiredRehydrationCount = args.memoryLifecycle.rehydration_hints
    .filter((entry) => entry.required).length;
  const authority = guideBriefAuthority({
    actionableHistoryUsed,
    workflowCandidates: args.workflowCandidates,
    toolPreferences: args.toolPreferences,
    blockedAuthorityCount: args.blockedAuthorityCount,
  });
  const posture = guideBriefPosture({
    actionableHistoryUsed,
    requiredRehydrationCount,
    negativeTransferRisk: args.negativeTransferRisk,
    blockedAuthorityCount: args.blockedAuthorityCount,
    authority,
  });
  const reducesRepeatedDiscovery =
    args.targetFiles.length > 0
    || args.workflowCandidates.length > 0
    || args.historyContributions.replay.used;
  const reducesContextReplay =
    args.resumable
    || args.historyContributions.handoff.used
    || args.memoryLifecycle.rehydration_hints.length > 0;
  const controlsNegativeTransfer =
    args.negativeTransferRisk !== "low"
    || args.blockedAuthorityCount > 0
    || args.staleMemoryCount > 0
    || blockedSurfaces.length > 0;

  return {
    summary: guideBriefSummary({ posture, authority }),
    history_used: historyUsed,
    actionable_history_used: actionableHistoryUsed,
    recommended_posture: posture,
    authority,
    use_now: compactStrings([
      args.stateSummary ? `Recovered state: ${args.stateSummary}` : null,
      args.targetFiles.length > 0 ? `Relevant target files: ${args.targetFiles.slice(0, 6).join(", ")}` : null,
      ...trustedOrAdvisoryWorkflows,
      ...trustedOrAdvisoryTools,
    ]).slice(0, 8),
    inspect_before_use: compactStrings([
      ...candidateSurfaces,
      ...args.riskReasons,
    ]).slice(0, 8),
    do_not_use: compactStrings(blockedSurfaces).slice(0, 8),
    rehydrate: args.memoryLifecycle.rehydration_hints.slice(0, 8),
    expected_product_effects: {
      reduces_repeated_discovery: reducesRepeatedDiscovery,
      reduces_context_replay: reducesContextReplay,
      controls_negative_transfer: controlsNegativeTransfer,
      reason: compactStrings([
        reducesRepeatedDiscovery ? "Guide includes recovered targets or workflow evidence that can reduce repeated discovery." : null,
        reducesContextReplay ? "Guide includes resumable continuity or differential rehydration instead of full history replay." : null,
        controlsNegativeTransfer ? "Guide exposes stale, blocked, or candidate history instead of silently applying it." : null,
        !reducesRepeatedDiscovery && !reducesContextReplay && !controlsNegativeTransfer
          ? "No measurable product effect is visible in this guide packet."
          : null,
      ]).join(" "),
    },
  };
}

export function buildAionisGuidePacket(args: BuildAionisGuidePacketArgs): AionisGuidePacket {
  const firstStep = args.planning.continuity_guidance;
  const authority = mapAuthority(
    firstStep?.contract_trust ?? args.planning.history_impact_summary.learning_control.contract_trust,
    args.planning.action_intelligence_pre_action_gate?.authority_blocked === true,
  );
  const authorityVisibilityStableBlockedCount = authorityConsumptionStablePromotionBlockedCount(
    args.planning.authority_visibility_summary,
  );
  const targetFiles = recoverTargetFiles({
    firstStep,
    executionSummary: args.execution_summary,
  });
  const acceptanceChecks = recoverAcceptanceChecks({
    firstStep,
    executionSummary: args.execution_summary,
  });
  const usedMemoryIds = compactStrings([
    ...args.planning.action_packet_summary.workflow_anchor_ids,
    ...args.planning.action_packet_summary.candidate_workflow_anchor_ids,
    ...args.planning.action_packet_summary.trusted_pattern_anchor_ids,
    ...args.planning.action_packet_summary.candidate_pattern_anchor_ids,
  ]);
  const rehydrationIds = compactStrings(args.planning.action_packet_summary.rehydration_anchor_ids);
  const stateSummary =
    args.execution_summary?.continuity_snapshot_summary.recommended_action
    ?? args.execution_summary?.collaboration_summary.next_action
    ?? args.planning.history_impact_summary.primary_reason
    ?? null;
  const resumable =
    args.planning.continuity_carrier_summary.total_count > 0
    || args.execution_summary?.continuity_snapshot_summary.snapshot_mode === "packet_backed";
  const workflowCandidates = buildWorkflowCandidates(args.planning);
  const toolPreferences = buildToolPreferences(args.planning, authority);
  const historyContributions = buildGuideHistoryContributions(args.planning);
  const memoryLifecycle: AionisGuidePacket["memory_lifecycle"] = {
    used_memory_ids: usedMemoryIds,
    suppressed_memory_ids: args.planning.forgetting_summary.suppressed_pattern_anchor_ids,
    archived_memory_ids: [],
    rehydration_hints: rehydrationIds.map((memoryId) => ({
      memory_id: memoryId,
      reason: "Differential rehydration candidate from the planning summary.",
      required: args.planning.action_intelligence_pre_action_gate?.requires_rehydration === true,
    })),
  };
  const negativeTransferRiskValue = negativeTransferRisk(args.planning);
  const blockedAuthorityCount =
    args.planning.authority_visibility_summary.authoritative_blocked_count
    + authorityVisibilityStableBlockedCount;
  const staleMemoryCount = args.planning.forgetting_summary.stale_signal_count;
  const riskReasons = buildRiskReasons(args.planning, args.execution_summary);

  return parseAionisGuidePacket({
    contract_version: "aionis_guide_packet_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor: args.actor,
    task: asTask(args.task),
    guide_brief: buildAionisGuideBrief({
      stateSummary,
      resumable,
      targetFiles,
      acceptanceChecks,
      workflowCandidates,
      toolPreferences,
      historyContributions,
      memoryLifecycle,
      negativeTransferRisk: negativeTransferRiskValue,
      blockedAuthorityCount,
      staleMemoryCount,
      riskReasons,
    }),
    recovered_state: {
      state_summary: stateSummary,
      resumable,
      handoff_ids: [],
      execution_state_revision: null,
      target_files: targetFiles,
      acceptance_checks: acceptanceChecks,
    },
    proven_facts: [],
    guidance: {
      workflow_candidates: workflowCandidates,
      tool_preferences: toolPreferences,
    },
    history_contributions: historyContributions,
    memory_lifecycle: memoryLifecycle,
    risk: {
      negative_transfer_risk: negativeTransferRiskValue,
      blocked_authority_count: blockedAuthorityCount,
      stale_memory_count: staleMemoryCount,
      provider_or_protocol_quarantine: false,
      reasons: riskReasons,
    },
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? [
        "planning_summary",
        "history_impact_summary",
        "action_packet_summary",
        "forgetting_summary",
      ],
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_find_resolve",
        "rules_state_evaluate",
        "replay_repair_dispatch",
        "sandbox_executor",
      ],
    },
  });
}
