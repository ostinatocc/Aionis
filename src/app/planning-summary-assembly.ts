import { pickPreferredDelegationRecordsSummary } from "../memory/delegation-records-surface.js";
import type {
  ActionIntelligencePreActionGateSummary,
  ActionRetrievalUncertaintySummary,
  AssemblySummary,
  ContractTrust,
  ExecutionPacketAssemblySummary,
  ExecutionSummary,
  PlannerPacketSummarySurface,
  PlanningSummary,
  RuntimeEditBoundaryContext,
} from "./planning-summary.js";
import {
  RuntimeEntropyControlsV1Schema,
  RuntimeEntropyProfileV1Schema,
  type RuntimeEntropyControlsV1,
  type RuntimeEntropyProfileV1,
} from "../memory/schemas.js";
import {
  buildExecutionCollaborationSummary,
  buildExecutionContinuitySnapshotSummary,
  buildExecutionStrategySummary,
} from "./planning-summary-execution.js";
import {
  buildExecutionForgettingSummary,
  buildExecutionMaintenanceSummary,
} from "./planning-summary-forgetting.js";
import {
  buildActionRetrievalGate,
  buildFirstStepRecommendation,
  buildPlannerExplanation,
} from "./planning-summary-planner.js";
import {
  buildExecutionCollaborationRoutingSummary,
  buildExecutionDelegationRecordsSummary,
  buildExecutionInstrumentationSummary,
  buildExecutionRoutingSignalSummary,
} from "./planning-summary-routing.js";
import { buildExecutionMemorySummaryBundle } from "./planning-summary-surfaces.js";
import { authorityConsumptionStateFromValue } from "../memory/authority-consumption.js";
import { parseExecutionContract, type ExecutionContractV1 } from "../memory/execution-contract.js";

type ExperienceRecommendationProjection = {
  history_applied: boolean;
  contract_trust: ContractTrust | null;
  execution_contract_v1: ExecutionContractV1 | null;
  selected_tool: string | null;
  task_family: string | null;
  workflow_signature: string | null;
  policy_memory_id: string | null;
  path_source_kind: "recommended_workflow" | "candidate_workflow" | "none";
  file_path: string | null;
  combined_next_action: string | null;
  action_intelligence_pre_action_gate: ActionIntelligencePreActionGateSummary | null;
  runtime_entropy_profile: RuntimeEntropyProfileV1 | null;
  runtime_entropy_controls: RuntimeEntropyControlsV1 | null;
  action_retrieval_uncertainty: ActionRetrievalUncertaintySummary | null;
  authority_blocked: boolean;
  authority_primary_blocker: string | null;
};

function readActionRetrievalUncertainty(
  experienceIntelligence: unknown,
): ActionRetrievalUncertaintySummary | null {
  if (!experienceIntelligence || typeof experienceIntelligence !== "object") return null;
  const actionRetrieval = (experienceIntelligence as Record<string, unknown>).action_retrieval;
  if (!actionRetrieval || typeof actionRetrieval !== "object") return null;
  const uncertainty = (actionRetrieval as Record<string, unknown>).uncertainty;
  if (!uncertainty || typeof uncertainty !== "object") return null;
  const record = uncertainty as Record<string, unknown>;
  const level =
    record.level === "low" || record.level === "moderate" || record.level === "high"
      ? record.level
      : null;
  if (!level) return null;
  return {
    summary_version: record.summary_version === "action_retrieval_uncertainty_v1"
      ? "action_retrieval_uncertainty_v1"
      : "action_retrieval_uncertainty_v1",
    level,
    confidence: typeof record.confidence === "number" ? record.confidence : 0,
    evidence_gap_count: typeof record.evidence_gap_count === "number" ? record.evidence_gap_count : 0,
    reasons: Array.isArray(record.reasons)
      ? record.reasons.filter((entry): entry is string => typeof entry === "string")
      : [],
    recommended_actions: Array.isArray(record.recommended_actions)
      ? record.recommended_actions.filter(
          (
            entry,
          ): entry is ActionRetrievalUncertaintySummary["recommended_actions"][number] =>
            entry === "proceed"
            || entry === "widen_recall"
            || entry === "rehydrate_payload"
            || entry === "inspect_context"
            || entry === "request_operator_review",
        )
      : [],
  };
}

function readActionIntelligencePreActionGate(
  experienceIntelligence: unknown,
): ActionIntelligencePreActionGateSummary | null {
  if (!experienceIntelligence || typeof experienceIntelligence !== "object") return null;
  const runtimeContract = (experienceIntelligence as Record<string, unknown>).action_intelligence_runtime_contract;
  if (!runtimeContract || typeof runtimeContract !== "object") return null;
  const gate = (runtimeContract as Record<string, unknown>).pre_action_gate;
  if (!gate || typeof gate !== "object") return null;
  const record = gate as Record<string, unknown>;
  const uncertaintyLevel =
    record.uncertainty_level === "low" || record.uncertainty_level === "moderate" || record.uncertainty_level === "high"
      ? record.uncertainty_level
      : null;
  if (!uncertaintyLevel) return null;
  return {
    gate_version: record.gate_version === "action_intelligence_pre_action_gate_v1"
      ? "action_intelligence_pre_action_gate_v1"
      : "action_intelligence_pre_action_gate_v1",
    known_enough: record.known_enough === true,
    requires_recall: record.requires_recall === true,
    requires_rehydration: record.requires_rehydration === true,
    requires_operator_review: record.requires_operator_review === true,
    authority_blocked: record.authority_blocked === true,
    uncertainty_level: uncertaintyLevel,
    confidence: typeof record.confidence === "number" ? record.confidence : 0,
    recommended_actions: Array.isArray(record.recommended_actions)
      ? record.recommended_actions.filter(
          (
            entry,
          ): entry is ActionIntelligencePreActionGateSummary["recommended_actions"][number] =>
            entry === "proceed"
            || entry === "widen_recall"
            || entry === "rehydrate_payload"
            || entry === "inspect_context"
            || entry === "request_operator_review",
        )
      : [],
    primary_reason: typeof record.primary_reason === "string" ? record.primary_reason : null,
  };
}

function readRuntimeEntropyProfile(
  experienceIntelligence: unknown,
): RuntimeEntropyProfileV1 | null {
  if (!experienceIntelligence || typeof experienceIntelligence !== "object") return null;
  const runtimeContract = (experienceIntelligence as Record<string, unknown>).action_intelligence_runtime_contract;
  if (!runtimeContract || typeof runtimeContract !== "object") return null;
  const parsed = RuntimeEntropyProfileV1Schema.safeParse(
    (runtimeContract as Record<string, unknown>).runtime_entropy_profile,
  );
  return parsed.success ? parsed.data : null;
}

function readRuntimeEntropyControls(
  experienceIntelligence: unknown,
): RuntimeEntropyControlsV1 | null {
  if (!experienceIntelligence || typeof experienceIntelligence !== "object") return null;
  const runtimeContract = (experienceIntelligence as Record<string, unknown>).action_intelligence_runtime_contract;
  if (!runtimeContract || typeof runtimeContract !== "object") return null;
  const parsed = RuntimeEntropyControlsV1Schema.safeParse(
    (runtimeContract as Record<string, unknown>).runtime_entropy_controls,
  );
  return parsed.success ? parsed.data : null;
}

function readContractTrust(value: unknown): ContractTrust | null {
  return value === "authoritative" || value === "advisory" || value === "observational"
    ? value
    : null;
}

function buildExecutionPacketAssemblySummary(
  packetAssembly?: Partial<ExecutionPacketAssemblySummary> | null,
): ExecutionPacketAssemblySummary {
  return {
    packet_source_mode:
      packetAssembly && typeof packetAssembly.packet_source_mode === "string"
        ? packetAssembly.packet_source_mode
        : null,
    state_first_assembly:
      packetAssembly && typeof packetAssembly.state_first_assembly === "boolean"
        ? packetAssembly.state_first_assembly
        : null,
    execution_packet_v1_present:
      packetAssembly && typeof packetAssembly.execution_packet_v1_present === "boolean"
        ? packetAssembly.execution_packet_v1_present
        : null,
    execution_state_v1_present:
      packetAssembly && typeof packetAssembly.execution_state_v1_present === "boolean"
        ? packetAssembly.execution_state_v1_present
        : null,
  };
}

function buildPlanningSurface(args: {
  layeredContext: Record<string, unknown>;
  plannerSurface?: PlannerPacketSummarySurface;
}): PlannerPacketSummarySurface {
  const actionRecallPacket =
    args.layeredContext.action_recall_packet && typeof args.layeredContext.action_recall_packet === "object"
      ? (args.layeredContext.action_recall_packet as Record<string, unknown>)
      : {};
  return args.plannerSurface ?? {
    action_recall_packet: args.layeredContext.action_recall_packet,
    pattern_signals: args.layeredContext.pattern_signals,
    workflow_signals: args.layeredContext.workflow_signals,
    recommended_workflows: args.layeredContext.recommended_workflows ?? actionRecallPacket.recommended_workflows,
    candidate_workflows: args.layeredContext.candidate_workflows ?? actionRecallPacket.candidate_workflows,
    candidate_patterns: args.layeredContext.candidate_patterns ?? actionRecallPacket.candidate_patterns,
    trusted_patterns: args.layeredContext.trusted_patterns ?? actionRecallPacket.trusted_patterns,
    contested_patterns: args.layeredContext.contested_patterns ?? actionRecallPacket.contested_patterns,
    rehydration_candidates: args.layeredContext.rehydration_candidates ?? actionRecallPacket.rehydration_candidates,
    supporting_knowledge: args.layeredContext.supporting_knowledge ?? actionRecallPacket.supporting_knowledge,
    authority_visibility_summary: args.layeredContext.authority_visibility_summary ?? actionRecallPacket.authority_visibility_summary,
  };
}

export function buildExecutionSummarySurface(args: {
  planner_packet?: unknown;
  surface: PlannerPacketSummarySurface;
  packet_assembly?: Partial<ExecutionPacketAssemblySummary> | null;
  tools?: unknown;
  cost_signals?: unknown;
  execution_packet?: unknown;
  execution_artifacts?: unknown;
  execution_evidence?: unknown;
  delegation_records?: unknown;
}): ExecutionSummary {
  const summaryBundle = buildExecutionMemorySummaryBundle(args.surface);
  const strategySummary = buildExecutionStrategySummary({
    surface: args.surface,
    summaryBundle,
    tools: args.tools,
    costSignals: args.cost_signals,
  });
  const collaborationSummary = buildExecutionCollaborationSummary({
    executionPacket: args.execution_packet,
    executionArtifacts: args.execution_artifacts,
    executionEvidence: args.execution_evidence,
  });
  const routingSignalSummary = buildExecutionRoutingSignalSummary({
    surface: args.surface,
    summaryBundle,
    tools: args.tools,
  });
  const maintenanceSummary = buildExecutionMaintenanceSummary({
    surface: args.surface,
    summaryBundle,
    costSignals: args.cost_signals,
    tools: args.tools,
  });
  const forgettingSummary = buildExecutionForgettingSummary({
    surface: args.surface,
    summaryBundle,
    costSignals: args.cost_signals,
    tools: args.tools,
  });
  const collaborationRoutingSummary = buildExecutionCollaborationRoutingSummary({
    executionPacket: args.execution_packet,
    strategySummary,
    collaborationSummary,
    routingSummary: routingSignalSummary,
  });
  const delegationRecordsSummary = buildExecutionDelegationRecordsSummary({
    strategySummary,
    collaborationSummary,
    collaborationRoutingSummary,
  });
  const persistedDelegationRecordsSummary = pickPreferredDelegationRecordsSummary(args.delegation_records);
  const instrumentationSummary = buildExecutionInstrumentationSummary({
    surface: args.surface,
    summaryBundle,
    tools: args.tools,
  });
  return {
    summary_version: "execution_summary_v1",
    planner_packet: args.planner_packet ?? null,
    pattern_signals: Array.isArray(args.surface.pattern_signals) ? args.surface.pattern_signals : [],
    workflow_signals: Array.isArray(args.surface.workflow_signals) ? args.surface.workflow_signals : [],
    packet_assembly: buildExecutionPacketAssemblySummary(args.packet_assembly),
    strategy_summary: strategySummary,
    collaboration_summary: collaborationSummary,
    continuity_snapshot_summary: buildExecutionContinuitySnapshotSummary({
      strategySummary,
      collaborationSummary,
      routingSummary: routingSignalSummary,
      maintenanceSummary,
    }),
    routing_signal_summary: routingSignalSummary,
    maintenance_summary: maintenanceSummary,
    forgetting_summary: forgettingSummary,
    collaboration_routing_summary: collaborationRoutingSummary,
    delegation_records_summary: persistedDelegationRecordsSummary ?? delegationRecordsSummary,
    instrumentation_summary: instrumentationSummary,
    ...summaryBundle,
  };
}

export function buildPlanningSummary(args: {
  rules?: unknown;
  tools?: unknown;
  layered_context?: unknown;
  planner_surface?: PlannerPacketSummarySurface;
  cost_signals?: unknown;
  context_est_tokens: number;
  context_compaction_profile: "balanced" | "aggressive";
  optimization_profile: "balanced" | "aggressive" | null;
  recall_mode?: string | null;
  experience_intelligence?: unknown;
  edit_boundary_context?: RuntimeEditBoundaryContext | null;
  execution_evidence?: unknown;
}): PlanningSummary {
  const rules = args.rules && typeof args.rules === "object" ? (args.rules as Record<string, unknown>) : {};
  const tools = args.tools && typeof args.tools === "object" ? (args.tools as Record<string, unknown>) : {};
  const decision = tools.decision && typeof tools.decision === "object" ? (tools.decision as Record<string, unknown>) : {};
  const layeredContext =
    args.layered_context && typeof args.layered_context === "object"
      ? (args.layered_context as Record<string, unknown>)
      : {};
  const layeredStats =
    layeredContext.stats && typeof layeredContext.stats === "object"
      ? (layeredContext.stats as Record<string, unknown>)
      : {};
  const staticInjection =
    layeredContext.static_injection && typeof layeredContext.static_injection === "object"
      ? (layeredContext.static_injection as Record<string, unknown>)
      : {};
  const costSignals =
    args.cost_signals && typeof args.cost_signals === "object" ? (args.cost_signals as Record<string, unknown>) : {};
  const plannerSurface = buildPlanningSurface({
    layeredContext,
    plannerSurface: args.planner_surface,
  });
  const summaryBundle = buildExecutionMemorySummaryBundle(plannerSurface);
  const patternSignalSummary = summaryBundle.pattern_signal_summary;
  const workflowSignalSummary = summaryBundle.workflow_signal_summary;
  const actionPacketSummary = summaryBundle.action_packet_summary;
  const workflowLifecycleSummary = summaryBundle.workflow_lifecycle_summary;
  const workflowMaintenanceSummary = summaryBundle.workflow_maintenance_summary;
  const authorityVisibilitySummary = summaryBundle.authority_visibility_summary;
  const distillationSignalSummary = summaryBundle.distillation_signal_summary;
  const patternLifecycleSummary = summaryBundle.pattern_lifecycle_summary;
  const patternMaintenanceSummary = summaryBundle.pattern_maintenance_summary;
  const policyLifecycleSummary = summaryBundle.policy_lifecycle_summary;
  const policyMaintenanceSummary = summaryBundle.policy_maintenance_summary;
  const continuityCarrierSummary = summaryBundle.continuity_carrier_summary;
  const forgettingSummary = buildExecutionForgettingSummary({
    surface: plannerSurface,
    summaryBundle,
    costSignals,
    tools,
  });
  const experienceRecommendation =
    args.experience_intelligence && typeof args.experience_intelligence === "object"
      ? ((args.experience_intelligence as Record<string, unknown>).recommendation as Record<string, unknown> | undefined)
      : undefined;
  const experienceExecutionContract = parseExecutionContract(
    args.experience_intelligence && typeof args.experience_intelligence === "object"
      ? (args.experience_intelligence as Record<string, unknown>).execution_contract_v1
      : null,
  );
  const actionRetrievalUncertainty = readActionRetrievalUncertainty(args.experience_intelligence);
  const actionIntelligencePreActionGate = readActionIntelligencePreActionGate(args.experience_intelligence);
  const runtimeEntropyProfile = readRuntimeEntropyProfile(args.experience_intelligence);
  const runtimeEntropyControls = readRuntimeEntropyControls(args.experience_intelligence);
  const experiencePath =
    experienceRecommendation?.path && typeof experienceRecommendation.path === "object"
      ? (experienceRecommendation.path as Record<string, unknown>)
      : null;
  const experienceAuthorityState = authorityConsumptionStateFromValue(experiencePath);
  const experiencePolicyContract =
    args.experience_intelligence && typeof args.experience_intelligence === "object"
      ? ((args.experience_intelligence as Record<string, unknown>).policy_contract as Record<string, unknown> | undefined)
      : undefined;
  const experienceSummary: ExperienceRecommendationProjection | null = experienceRecommendation
    ? {
        history_applied: experienceRecommendation.history_applied === true,
        contract_trust: readContractTrust(experienceExecutionContract?.contract_trust)
          ?? readContractTrust(experiencePath?.contract_trust)
          ?? readContractTrust(experiencePolicyContract?.contract_trust)
          ?? null,
        execution_contract_v1: experienceExecutionContract,
        selected_tool: typeof experienceExecutionContract?.selected_tool === "string"
          ? experienceExecutionContract.selected_tool
          : typeof experienceRecommendation.tool === "object" && experienceRecommendation.tool && typeof (experienceRecommendation.tool as any).selected_tool === "string"
          ? (experienceRecommendation.tool as any).selected_tool
          : null,
        task_family:
          typeof experienceExecutionContract?.task_family === "string"
            ? experienceExecutionContract.task_family
            : typeof experiencePath?.task_family === "string"
            ? experiencePath.task_family
            : typeof experiencePolicyContract?.task_family === "string"
              ? experiencePolicyContract.task_family
              : null,
        workflow_signature:
          typeof experienceExecutionContract?.workflow_signature === "string"
            ? experienceExecutionContract.workflow_signature
            : typeof experiencePath?.workflow_signature === "string"
            ? experiencePath.workflow_signature
            : typeof experiencePolicyContract?.workflow_signature === "string"
              ? experiencePolicyContract.workflow_signature
              : null,
        policy_memory_id:
          typeof experienceExecutionContract?.policy_memory_id === "string"
            ? experienceExecutionContract.policy_memory_id
            : typeof experiencePolicyContract?.policy_memory_id === "string"
            ? experiencePolicyContract.policy_memory_id
            : null,
        path_source_kind:
          experiencePath?.source_kind === "recommended_workflow" || experiencePath?.source_kind === "candidate_workflow"
            ? experiencePath.source_kind
            : "none",
        file_path:
          typeof experienceExecutionContract?.file_path === "string"
            ? experienceExecutionContract.file_path
            : typeof experiencePath?.file_path === "string"
              ? experiencePath.file_path
              : null,
        combined_next_action:
          typeof experienceExecutionContract?.next_action === "string"
            ? experienceExecutionContract.next_action
            : typeof experienceRecommendation.combined_next_action === "string"
            ? experienceRecommendation.combined_next_action
            : null,
        action_intelligence_pre_action_gate: actionIntelligencePreActionGate,
        runtime_entropy_profile: runtimeEntropyProfile,
        runtime_entropy_controls: runtimeEntropyControls,
        action_retrieval_uncertainty: actionRetrievalUncertainty,
        authority_blocked: experienceAuthorityState.requires_inspection || actionIntelligencePreActionGate?.authority_blocked === true,
        authority_primary_blocker: experienceAuthorityState.primary_blocker,
      }
    : null;
  const selectedTool =
    typeof tools.selection === "object" && tools.selection && typeof (tools.selection as any).selected === "string"
      ? (tools.selection as any).selected
      : null;
  const firstStepRecommendation = buildFirstStepRecommendation({
    selectedTool,
    experienceSummary,
    editBoundaryContext: args.edit_boundary_context ?? null,
    executionEvidence: args.execution_evidence,
  });
  const actionRetrievalGate = buildActionRetrievalGate({
    firstStepRecommendation,
    plannerSurface,
    preActionGate: actionIntelligencePreActionGate,
    uncertainty: actionRetrievalUncertainty,
  });

  return {
    summary_version: "planning_summary_v1",
    first_step_recommendation: firstStepRecommendation,
    action_intelligence_pre_action_gate: actionIntelligencePreActionGate,
    runtime_entropy_profile: runtimeEntropyProfile,
    runtime_entropy_controls: runtimeEntropyControls,
    action_retrieval_uncertainty: actionRetrievalUncertainty,
    action_retrieval_gate: actionRetrievalGate,
    planner_explanation: buildPlannerExplanation({
      selectedTool,
      decision,
      patternSignalSummary,
      plannerSurface,
      actionPacketSummary,
      workflowLifecycleSummary,
      authorityVisibilitySummary,
      runtimeEntropyProfile,
      actionRetrievalUncertainty,
    }),
    selected_tool: selectedTool,
    decision_id: typeof decision.decision_id === "string" ? decision.decision_id : null,
    rules_considered: Number(rules.considered ?? 0),
    rules_matched: Number(rules.matched ?? 0),
    context_est_tokens: args.context_est_tokens,
    layered_output: Boolean(args.layered_context),
    forgotten_items: Number(costSignals.forgotten_items ?? layeredStats.forgotten_items ?? 0),
    static_blocks_selected: Number(costSignals.static_blocks_selected ?? staticInjection.selected_blocks ?? 0),
    selected_memory_layers: Array.isArray(costSignals.selected_memory_layers)
      ? costSignals.selected_memory_layers.filter((entry): entry is string => typeof entry === "string")
      : [],
    optimization_profile: args.optimization_profile,
    context_compaction_profile: args.context_compaction_profile,
    recall_mode: args.recall_mode ?? null,
    trusted_pattern_count: patternSignalSummary.trusted_pattern_count,
    contested_pattern_count: patternSignalSummary.contested_pattern_count,
    trusted_pattern_tools: patternSignalSummary.trusted_pattern_tools,
    contested_pattern_tools: patternSignalSummary.contested_pattern_tools,
    workflow_signal_summary: workflowSignalSummary,
    action_packet_summary: actionPacketSummary,
    workflow_lifecycle_summary: workflowLifecycleSummary,
    workflow_maintenance_summary: workflowMaintenanceSummary,
    authority_visibility_summary: authorityVisibilitySummary,
    distillation_signal_summary: distillationSignalSummary,
    pattern_lifecycle_summary: patternLifecycleSummary,
    pattern_maintenance_summary: patternMaintenanceSummary,
    policy_lifecycle_summary: policyLifecycleSummary,
    policy_maintenance_summary: policyMaintenanceSummary,
    continuity_carrier_summary: continuityCarrierSummary,
    forgetting_summary: forgettingSummary,
    primary_savings_levers: Array.isArray(costSignals.primary_savings_levers)
      ? costSignals.primary_savings_levers.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export function buildAssemblySummary(args: {
  rules?: unknown;
  tools?: unknown;
  layered_context?: unknown;
  planner_surface?: PlannerPacketSummarySurface;
  cost_signals?: unknown;
  context_est_tokens: number;
  context_compaction_profile: "balanced" | "aggressive";
  optimization_profile: "balanced" | "aggressive" | null;
  recall_mode?: string | null;
  include_rules: boolean;
  experience_intelligence?: unknown;
  edit_boundary_context?: RuntimeEditBoundaryContext | null;
  execution_evidence?: unknown;
}): AssemblySummary {
  const planning = buildPlanningSummary({
    rules: args.rules,
    tools: args.tools,
    layered_context: args.layered_context,
    planner_surface: args.planner_surface,
    cost_signals: args.cost_signals,
    context_est_tokens: args.context_est_tokens,
    context_compaction_profile: args.context_compaction_profile,
    optimization_profile: args.optimization_profile,
    recall_mode: args.recall_mode,
    experience_intelligence: args.experience_intelligence,
    edit_boundary_context: args.edit_boundary_context ?? null,
    execution_evidence: args.execution_evidence,
  });
  return {
    summary_version: "assembly_summary_v1",
    planner_explanation: planning.planner_explanation,
    first_step_recommendation: planning.first_step_recommendation,
    action_intelligence_pre_action_gate: planning.action_intelligence_pre_action_gate,
    runtime_entropy_profile: planning.runtime_entropy_profile,
    runtime_entropy_controls: planning.runtime_entropy_controls,
    action_retrieval_uncertainty: planning.action_retrieval_uncertainty,
    action_retrieval_gate: planning.action_retrieval_gate,
    selected_tool: planning.selected_tool,
    decision_id: planning.decision_id,
    rules_considered: planning.rules_considered,
    rules_matched: planning.rules_matched,
    include_rules: args.include_rules,
    context_est_tokens: planning.context_est_tokens,
    layered_output: planning.layered_output,
    forgotten_items: planning.forgotten_items,
    static_blocks_selected: planning.static_blocks_selected,
    selected_memory_layers: planning.selected_memory_layers,
    optimization_profile: planning.optimization_profile,
    context_compaction_profile: planning.context_compaction_profile,
    recall_mode: planning.recall_mode,
    trusted_pattern_count: planning.trusted_pattern_count,
    contested_pattern_count: planning.contested_pattern_count,
    trusted_pattern_tools: planning.trusted_pattern_tools,
    contested_pattern_tools: planning.contested_pattern_tools,
    workflow_signal_summary: planning.workflow_signal_summary,
    action_packet_summary: planning.action_packet_summary,
    workflow_lifecycle_summary: planning.workflow_lifecycle_summary,
    workflow_maintenance_summary: planning.workflow_maintenance_summary,
    authority_visibility_summary: planning.authority_visibility_summary,
    distillation_signal_summary: planning.distillation_signal_summary,
    pattern_lifecycle_summary: planning.pattern_lifecycle_summary,
    pattern_maintenance_summary: planning.pattern_maintenance_summary,
    policy_lifecycle_summary: planning.policy_lifecycle_summary,
    policy_maintenance_summary: planning.policy_maintenance_summary,
    continuity_carrier_summary: planning.continuity_carrier_summary,
    forgetting_summary: planning.forgetting_summary,
    primary_savings_levers: planning.primary_savings_levers,
  };
}
