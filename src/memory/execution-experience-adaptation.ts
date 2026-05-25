import {
  ExecutionExperienceAdaptationTraceV1Schema,
  type ActionRetrievalEvidence,
  type ActionRetrievalResponse,
  type ActionRetrievalUncertainty,
  type AdaptiveGuidanceOverlayV1,
  type ExecutionExperienceAdaptationTraceV1,
  type ExecutionMemoryIntrospectionResponse,
  type ExperienceIntelligenceInput,
  type TrajectoryCompileResponse,
} from "./schemas.js";

type RetrievalTraceInput = {
  selected_tool: string | null;
  tool_source_kind: ActionRetrievalResponse["tool_source_kind"];
  path: ActionRetrievalResponse["path"];
  evidence: ActionRetrievalEvidence;
  adaptive_guidance: AdaptiveGuidanceOverlayV1;
  uncertainty: ActionRetrievalUncertainty;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(value: unknown, limit = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (next: unknown) => {
    if (out.length >= limit) return;
    if (Array.isArray(next)) {
      for (const entry of next) visit(entry);
      return;
    }
    const text = stringField(next);
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };
  visit(value);
  return out;
}

function nonNegativeInt(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function readTrajectorySummary(args: {
  parsed: ExperienceIntelligenceInput;
  trajectoryCompile?: TrajectoryCompileResponse | null;
}) {
  const executionResultSummary = asRecord(args.parsed.execution_result_summary);
  const compactSummary = asRecord(executionResultSummary?.trajectory_compile_v1);
  const compiled = args.trajectoryCompile ?? null;
  const present = !!args.parsed.trajectory || !!compactSummary || !!compiled;
  return {
    present,
    compiled: !!compiled || !!compactSummary,
    task_family: stringField(compiled?.task_family) ?? stringField(compactSummary?.task_family),
    task_signature: stringField(compiled?.task_signature) ?? stringField(compactSummary?.task_signature),
    workflow_signature: stringField(compiled?.workflow_signature) ?? stringField(compactSummary?.workflow_signature),
    target_file_count: compiled ? compiled.contract.target_files.length : nonNegativeInt(compactSummary?.target_file_count),
    acceptance_check_count: compiled ? compiled.contract.acceptance_checks.length : nonNegativeInt(compactSummary?.acceptance_check_count),
    service_constraint_count: compiled ? compiled.contract.service_lifecycle_constraints.length : nonNegativeInt(compactSummary?.service_constraint_count),
    likely_tool: stringField(compiled?.contract.likely_tool) ?? stringField(compactSummary?.likely_tool),
  };
}

function stage(args: {
  stage: ExecutionExperienceAdaptationTraceV1["stages"][number]["stage"];
  status: ExecutionExperienceAdaptationTraceV1["stages"][number]["status"];
  summary: string;
  sourceRefs?: unknown[];
  evidenceRefs?: unknown[];
}): ExecutionExperienceAdaptationTraceV1["stages"][number] {
  return {
    stage: args.stage,
    status: args.status,
    summary: args.summary,
    source_refs: stringList(args.sourceRefs ?? [], 32),
    evidence_refs: stringList(args.evidenceRefs ?? [], 32),
  };
}

export function buildExecutionExperienceAdaptationTrace(args: {
  parsed: ExperienceIntelligenceInput;
  introspection: ExecutionMemoryIntrospectionResponse;
  retrieval: RetrievalTraceInput;
  trajectoryCompile?: TrajectoryCompileResponse | null;
  delegationRecommendationCount?: number;
}): ExecutionExperienceAdaptationTraceV1 {
  const trajectory = readTrajectorySummary({
    parsed: args.parsed,
    trajectoryCompile: args.trajectoryCompile ?? null,
  });
  const adaptiveGuidance = args.retrieval.adaptive_guidance;
  const selectedCandidateIds = adaptiveGuidance.selected_candidates.map((candidate) => candidate.candidate_id);
  const primaryInstruction =
    adaptiveGuidance.adapted_instructions.find((entry) => entry.priority === "primary")?.instruction
    ?? adaptiveGuidance.adapted_instructions[0]?.instruction
    ?? null;
  const experienceSources = {
    stable_workflow_count: Array.isArray(args.introspection.recommended_workflows) ? args.introspection.recommended_workflows.length : 0,
    candidate_workflow_count: Array.isArray(args.introspection.candidate_workflows) ? args.introspection.candidate_workflows.length : 0,
    trusted_pattern_count: Array.isArray(args.introspection.trusted_patterns) ? args.introspection.trusted_patterns.length : 0,
    contested_pattern_count: Array.isArray(args.introspection.contested_patterns) ? args.introspection.contested_patterns.length : 0,
    rehydration_candidate_count: Array.isArray(args.introspection.rehydration_candidates) ? args.introspection.rehydration_candidates.length : 0,
    supporting_knowledge_count: Array.isArray(args.introspection.supporting_knowledge) ? args.introspection.supporting_knowledge.length : 0,
    adaptive_guidance_candidate_count: adaptiveGuidance.selected_candidate_count,
    delegation_recommendation_count: Math.max(0, args.delegationRecommendationCount ?? 0),
  };
  const hasExperienceSource =
    experienceSources.stable_workflow_count
    + experienceSources.candidate_workflow_count
    + experienceSources.trusted_pattern_count
    + experienceSources.contested_pattern_count
    + experienceSources.rehydration_candidate_count
    + experienceSources.supporting_knowledge_count
    + experienceSources.adaptive_guidance_candidate_count
    + experienceSources.delegation_recommendation_count > 0;
  const activationState =
    adaptiveGuidance.activation_state === "active"
      ? "active"
      : hasExperienceSource
        ? "blocked"
        : "empty";

  return ExecutionExperienceAdaptationTraceV1Schema.parse({
    summary_version: "execution_experience_adaptation_trace_v1",
    activation_state: activationState,
    trajectory,
    experience_sources: experienceSources,
    task_decomposition: adaptiveGuidance.decomposition,
    retrieval: {
      selected_tool: args.retrieval.selected_tool,
      tool_source_kind: args.retrieval.tool_source_kind,
      path_source_kind: args.retrieval.path.source_kind,
      selected_path_anchor_id: args.retrieval.evidence.selected_path_anchor_id,
      evidence_entry_count: args.retrieval.evidence.entries.length,
      uncertainty_level: args.retrieval.uncertainty.level,
      confidence: args.retrieval.uncertainty.confidence,
    },
    adaptation: {
      activation_state: adaptiveGuidance.activation_state,
      selected_candidate_ids: selectedCandidateIds,
      adapted_instruction_count: adaptiveGuidance.adapted_instructions.length,
      primary_instruction: primaryInstruction,
      recommended_actions: adaptiveGuidance.uncertainty_adjustment.recommended_actions,
      confidence_delta: adaptiveGuidance.uncertainty_adjustment.confidence_delta,
      feedback_slots: adaptiveGuidance.attribution_plan.feedback_slots,
      expected_signal_kind: adaptiveGuidance.attribution_plan.expected_signal_kind,
      promotion_requires_candidate_binding: true,
    },
    authority: {
      contract_trust: "observational",
      may_promote_directly: false,
      required_promotion_path: "runtime_signal_attribution_and_learning_control_gate",
      source_code_change_allowed: false,
    },
    stages: [
      stage({
        stage: "trajectory_compile",
        status: trajectory.compiled ? "ready" : trajectory.present ? "blocked" : "empty",
        summary: trajectory.compiled ? "trajectory compiled into execution summary" : trajectory.present ? "trajectory input has not been compiled" : "no trajectory input present",
        sourceRefs: [trajectory.task_signature, trajectory.workflow_signature],
      }),
      stage({
        stage: "experience_intelligence",
        status: hasExperienceSource ? "observed" : "empty",
        summary: hasExperienceSource ? "execution experience sources available for retrieval" : "no execution experience sources matched",
        sourceRefs: [
          ...stringList(args.introspection.recommended_workflows?.map((entry) => asRecord(entry)?.anchor_id), 16),
          ...stringList(args.introspection.candidate_workflows?.map((entry) => asRecord(entry)?.anchor_id), 16),
        ],
      }),
      stage({
        stage: "task_decomposition",
        status: adaptiveGuidance.decomposition.subtasks.length > 0 ? "ready" : "blocked",
        summary: `task decomposition produced ${adaptiveGuidance.decomposition.subtasks.length} subtasks`,
        sourceRefs: adaptiveGuidance.decomposition.subtasks.map((entry) => entry.subtask_id),
      }),
      stage({
        stage: "action_retrieval",
        status: args.retrieval.evidence.entries.length > 0 ? "ready" : "empty",
        summary: `action retrieval selected ${args.retrieval.tool_source_kind}`,
        sourceRefs: [args.retrieval.path.anchor_id],
      }),
      stage({
        stage: "adaptive_guidance",
        status: adaptiveGuidance.activation_state === "active" ? "active" : adaptiveGuidance.activation_state,
        summary: `adaptive guidance selected ${selectedCandidateIds.length} candidates`,
        sourceRefs: selectedCandidateIds,
        evidenceRefs: adaptiveGuidance.selected_candidates.flatMap((candidate) => candidate.evidence_refs),
      }),
      stage({
        stage: "feedback_attribution",
        status: selectedCandidateIds.length > 0 ? "ready" : "empty",
        summary: "feedback attribution requires selected candidate binding before promotion",
        sourceRefs: adaptiveGuidance.attribution_plan.feedback_slots,
      }),
    ],
    source_code_change_allowed: false,
  });
}
