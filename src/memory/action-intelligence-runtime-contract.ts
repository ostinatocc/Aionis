import {
  ActionIntelligenceRuntimeContractV1Schema,
  type ActionIntelligenceRuntimeEvidenceSummary,
  type ActionIntelligenceRuntimeGate,
  type ActionIntelligenceRuntimeLifecycle,
  type ActionIntelligenceRuntimeContractV1,
  type ActionIntelligenceRuntimeStage,
  type ActionIntelligenceRuntimeStageName,
  type ActionIntelligenceRuntimeStageStatus,
  type ActionRetrievalResponse,
  type DerivedPolicySurface,
  type ExecutionMemoryIntrospectionResponse,
  type ExperienceIntelligenceInput,
  type PolicyContract,
  PromotionQualitySummaryV1Schema,
  RuntimeEffectSummaryV1Schema,
  RuntimeSignalTrendSummaryV1Schema,
  type PromotionQualitySummaryV1,
  type RuntimeEffectSummaryV1,
  type RuntimeSignalTrendSummaryV1,
} from "./schemas.js";
import { parseExecutionContract } from "./execution-contract.js";
import { firstString, stringList } from "./action-retrieval.js";
import { buildRuntimeSignalLedgerFromSlots } from "./runtime-signal-ledger.js";
import { buildRuntimeEntropyProfileV1 } from "./runtime-entropy-profile.js";
import { buildRuntimeEntropyControlsV1 } from "./runtime-entropy-controls.js";

type DelegationLearningLike = {
  recommendation_count: number;
  learning_recommendations: Array<Record<string, unknown>>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function uniqueStrings(values: unknown[], limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function collectRefsFromRecord(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  return uniqueStrings([
    record.ref,
    record.uri,
    record.id,
    record.node_id,
    record.anchor_id,
    record.evidence_ref,
    record.artifact_ref,
    record.run_id,
  ], 16);
}

function collectExecutionRefs(parsed: ExperienceIntelligenceInput): string[] {
  return uniqueStrings([
    ...collectRefsFromRecord(asRecord(parsed.execution_result_summary)),
    ...recordArray(parsed.execution_artifacts).flatMap(collectRefsFromRecord),
    ...recordArray(parsed.execution_evidence).flatMap(collectRefsFromRecord),
  ], 128);
}

function readRuntimeSignalTrendSummary(parsed: ExperienceIntelligenceInput): RuntimeSignalTrendSummaryV1 | null {
  const context = asRecord(parsed.context) ?? {};
  const executionResult = asRecord(parsed.execution_result_summary);
  const maintenanceRun = asRecord(context.runtime_maintenance_run);
  const maintenanceAfter = asRecord(maintenanceRun?.after);
  const maintenanceBefore = asRecord(maintenanceRun?.before);
  const candidates = [
    context.runtime_signal_trend_summary_v1,
    context.runtime_signal_trend_summary,
    asRecord(context.runtime_maintenance_snapshot_v1)?.runtime_signal_trend_summary,
    asRecord(context.runtime_maintenance_snapshot)?.runtime_signal_trend_summary,
    asRecord(context.runtime_maintenance_after_snapshot)?.runtime_signal_trend_summary,
    maintenanceAfter?.runtime_signal_trend_summary,
    maintenanceBefore?.runtime_signal_trend_summary,
    executionResult?.runtime_signal_trend_summary_v1,
    executionResult?.runtime_signal_trend_summary,
  ];
  for (const candidate of candidates) {
    const parsedTrend = RuntimeSignalTrendSummaryV1Schema.safeParse(candidate);
    if (parsedTrend.success) return parsedTrend.data;
  }
  return null;
}

function readPromotionQualitySummary(parsed: ExperienceIntelligenceInput): PromotionQualitySummaryV1 | null {
  const context = asRecord(parsed.context) ?? {};
  const executionResult = asRecord(parsed.execution_result_summary);
  const maintenanceRun = asRecord(context.runtime_maintenance_run);
  const maintenanceAfter = asRecord(maintenanceRun?.after);
  const maintenanceBefore = asRecord(maintenanceRun?.before);
  const candidates = [
    context.promotion_quality_summary_v1,
    context.promotion_quality_summary,
    asRecord(context.runtime_maintenance_snapshot_v1)?.promotion_quality_summary,
    asRecord(context.runtime_maintenance_snapshot)?.promotion_quality_summary,
    asRecord(context.runtime_maintenance_after_snapshot)?.promotion_quality_summary,
    maintenanceAfter?.promotion_quality_summary,
    maintenanceBefore?.promotion_quality_summary,
    executionResult?.promotion_quality_summary_v1,
    executionResult?.promotion_quality_summary,
  ];
  for (const candidate of candidates) {
    const parsedSummary = PromotionQualitySummaryV1Schema.safeParse(candidate);
    if (parsedSummary.success) return parsedSummary.data;
  }
  return null;
}

function readRuntimeEffectSummary(parsed: ExperienceIntelligenceInput): RuntimeEffectSummaryV1 | null {
  const context = asRecord(parsed.context) ?? {};
  const executionResult = asRecord(parsed.execution_result_summary);
  const maintenanceRun = asRecord(context.runtime_maintenance_run);
  const maintenanceAfter = asRecord(maintenanceRun?.after);
  const maintenanceBefore = asRecord(maintenanceRun?.before);
  const candidates = [
    context.runtime_effect_summary_v1,
    context.runtime_effect_summary,
    asRecord(context.runtime_maintenance_snapshot_v1)?.runtime_effect_summary,
    asRecord(context.runtime_maintenance_snapshot)?.runtime_effect_summary,
    asRecord(context.runtime_maintenance_after_snapshot)?.runtime_effect_summary,
    maintenanceAfter?.runtime_effect_summary,
    maintenanceBefore?.runtime_effect_summary,
    executionResult?.runtime_effect_summary_v1,
    executionResult?.runtime_effect_summary,
  ];
  for (const candidate of candidates) {
    const parsedSummary = RuntimeEffectSummaryV1Schema.safeParse(candidate);
    if (parsedSummary.success) return parsedSummary.data;
  }
  return null;
}

function countVerifierEvidence(parsed: ExperienceIntelligenceInput): number {
  const entries = [
    asRecord(parsed.execution_result_summary),
    ...recordArray(parsed.execution_evidence),
  ].filter((entry): entry is Record<string, unknown> => entry !== null);
  return entries.filter((entry) => {
    const haystack = Object.entries(entry)
      .map(([key, value]) => `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ")
      .toLowerCase();
    return haystack.includes("verifier")
      || haystack.includes("verification")
      || haystack.includes("test")
      || haystack.includes("lint")
      || haystack.includes("typecheck");
  }).length;
}

function stage(args: {
  stage: ActionIntelligenceRuntimeStageName;
  status: ActionIntelligenceRuntimeStageStatus;
  summary: string;
  source_refs?: unknown[];
  evidence_refs?: unknown[];
  required_next?: string | null;
}): ActionIntelligenceRuntimeStage {
  return {
    stage: args.stage,
    status: args.status,
    summary: args.summary,
    source_refs: uniqueStrings(args.source_refs ?? [], 64),
    evidence_refs: uniqueStrings(args.evidence_refs ?? [], 64),
    required_next: args.required_next ?? null,
  };
}

function hasRecommendedAction(actionRetrieval: ActionRetrievalResponse, action: string): boolean {
  return actionRetrieval.uncertainty.recommended_actions.includes(action as never);
}

function authorityBlockedCount(args: {
  actionRetrieval: ActionRetrievalResponse;
  introspection: ExecutionMemoryIntrospectionResponse;
}): number {
  const evidenceBlocked = args.actionRetrieval.evidence.entries
    .filter((entry) => entry.authority_blocked === true)
    .length;
  const pathBlocked = args.actionRetrieval.path.authority_blocked === true ? 1 : 0;
  const visibility = args.introspection.authority_visibility_summary;
  return evidenceBlocked
    + pathBlocked
    + visibility.authoritative_blocked_count
    + visibility.stable_promotion_blocked_count;
}

function resolveTargetFiles(args: {
  parsed: ExperienceIntelligenceInput;
  actionRetrieval: ActionRetrievalResponse;
}): string[] {
  const executionContract = parseExecutionContract(args.actionRetrieval.execution_contract_v1);
  return uniqueStrings([
    ...stringList(executionContract?.target_files, 64),
    ...stringList(args.actionRetrieval.path.target_files, 64),
    args.actionRetrieval.recommended_file_path,
    firstString(asRecord(args.parsed.context)?.file_path),
  ], 64);
}

export function buildActionIntelligenceRuntimeContractV1(args: {
  parsed: ExperienceIntelligenceInput;
  actionRetrieval: ActionRetrievalResponse;
  introspection: ExecutionMemoryIntrospectionResponse;
  derivedPolicy: DerivedPolicySurface | null;
  policyContract: PolicyContract | null;
  delegationLearning?: DelegationLearningLike | null;
}): ActionIntelligenceRuntimeContractV1 {
  const executionContract = parseExecutionContract(args.actionRetrieval.execution_contract_v1);
  const artifactCount = recordArray(args.parsed.execution_artifacts).length;
  const executionEvidenceCount = recordArray(args.parsed.execution_evidence).length;
  const hasExecutionResult = !!asRecord(args.parsed.execution_result_summary);
  const postActionMaterialPresent = hasExecutionResult || artifactCount > 0 || executionEvidenceCount > 0;
  const executionRefs = collectExecutionRefs(args.parsed);
  const actionEvidenceRefs = uniqueStrings([
    args.actionRetrieval.evidence.selected_path_anchor_id,
    args.actionRetrieval.evidence.persisted_policy_memory_id,
    ...args.actionRetrieval.evidence.entries.map((entry) => entry.anchor_id),
  ], 128);
  const allEvidenceRefs = uniqueStrings([...actionEvidenceRefs, ...executionRefs], 128);
  const authorityBlocked = authorityBlockedCount({
    actionRetrieval: args.actionRetrieval,
    introspection: args.introspection,
  });
  const requiresRecall = hasRecommendedAction(args.actionRetrieval, "widen_recall");
  const requiresRehydration = hasRecommendedAction(args.actionRetrieval, "rehydrate_payload");
  const requiresOperatorReview = hasRecommendedAction(args.actionRetrieval, "request_operator_review");
  const requiresInspection = hasRecommendedAction(args.actionRetrieval, "inspect_context");
  const hasConcreteAction = !!args.actionRetrieval.selected_tool && !!args.actionRetrieval.recommended_next_action;
  const knownEnough = authorityBlocked === 0
    && !requiresRecall
    && !requiresRehydration
    && !requiresOperatorReview
    && args.actionRetrieval.uncertainty.level !== "high"
    && hasConcreteAction;
  const policyCandidateAvailable = !!args.derivedPolicy || !!args.policyContract;
  const workflowCandidateAvailable =
    args.actionRetrieval.evidence.candidate_workflow_count > 0
    || args.introspection.distillation_signal_summary.projected_workflow_candidate_count > 0;
  const adaptiveGuidanceCandidateAvailable =
    (args.actionRetrieval.adaptive_guidance?.selected_candidate_count ?? 0) > 0
    || args.actionRetrieval.evidence.adaptive_guidance_candidate_count > 0;
  const mutationCandidateAvailable =
    policyCandidateAvailable
    || workflowCandidateAvailable
    || (postActionMaterialPresent && adaptiveGuidanceCandidateAvailable)
    || (args.delegationLearning?.recommendation_count ?? 0) > 0;
  const distillationReady = postActionMaterialPresent;
  const maintenanceReady = postActionMaterialPresent || mutationCandidateAvailable;
  const targetFiles = resolveTargetFiles({
    parsed: args.parsed,
    actionRetrieval: args.actionRetrieval,
  });
  const context = asRecord(args.parsed.context) ?? {};
  const promotionQualitySummary = readPromotionQualitySummary(args.parsed);
  const runtimeEffectSummary = readRuntimeEffectSummary(args.parsed);
  const promotionQualityReviewNeeded =
    promotionQualitySummary?.recommended_learning_posture === "constrain"
    || promotionQualitySummary?.recommended_learning_posture === "invalidate";
  const runtimeEffectReviewNeeded =
    runtimeEffectSummary?.measurable_effect_posture === "constrained"
    || runtimeEffectSummary?.measurable_effect_posture === "blocked";
  const effectiveMutationCandidateAvailable = mutationCandidateAvailable || promotionQualityReviewNeeded;
  const effectiveMaintenanceReady = maintenanceReady || promotionQualityReviewNeeded || runtimeEffectReviewNeeded;
  const actionBlocked = authorityBlocked > 0 || requiresOperatorReview;
  const retrieveReady = hasConcreteAction && !actionBlocked;
  const selectedWorkflowAnchorId = args.actionRetrieval.evidence.selected_path_anchor_id ?? args.actionRetrieval.path.anchor_id;
  const policyMemoryId =
    args.policyContract?.policy_memory_id
    ?? args.actionRetrieval.evidence.persisted_policy_memory_id
    ?? null;
  const preActionGate: ActionIntelligenceRuntimeGate = {
    gate_version: "action_intelligence_pre_action_gate_v1",
    known_enough: knownEnough,
    requires_recall: requiresRecall,
    requires_rehydration: requiresRehydration,
    requires_operator_review: requiresOperatorReview,
    authority_blocked: authorityBlocked > 0,
    uncertainty_level: args.actionRetrieval.uncertainty.level,
    confidence: args.actionRetrieval.uncertainty.confidence,
    recommended_actions: args.actionRetrieval.uncertainty.recommended_actions,
    primary_reason: args.actionRetrieval.uncertainty.reasons[0] ?? null,
  };
  const evidenceSummary: ActionIntelligenceRuntimeEvidenceSummary = {
    summary_version: "action_intelligence_evidence_summary_v1",
    stable_workflow_count: args.actionRetrieval.evidence.stable_workflow_count,
    candidate_workflow_count: args.actionRetrieval.evidence.candidate_workflow_count,
    trusted_pattern_count: args.actionRetrieval.evidence.trusted_pattern_count,
    contested_pattern_count: args.actionRetrieval.evidence.contested_pattern_count,
    rehydration_candidate_count: args.actionRetrieval.evidence.rehydration_candidate_count,
    adaptive_guidance_candidate_count: args.actionRetrieval.evidence.adaptive_guidance_candidate_count,
    persisted_policy_memory_id: args.actionRetrieval.evidence.persisted_policy_memory_id,
    execution_artifact_count: artifactCount,
    execution_evidence_count: executionEvidenceCount,
    verifier_evidence_count: countVerifierEvidence(args.parsed),
    distilled_evidence_count: args.introspection.distillation_signal_summary.distilled_evidence_count,
    distilled_fact_count: args.introspection.distillation_signal_summary.distilled_fact_count,
    projected_workflow_candidate_count: args.introspection.distillation_signal_summary.projected_workflow_candidate_count,
    authority_blocked_count: authorityBlocked,
    evidence_refs: allEvidenceRefs,
  };
  const lifecycle: ActionIntelligenceRuntimeLifecycle = {
    lifecycle_version: "action_intelligence_lifecycle_v1",
    history_applied: args.actionRetrieval.history_applied,
    post_action_material_present: postActionMaterialPresent,
    distillation_ready: distillationReady,
    workflow_candidate_available: workflowCandidateAvailable,
    policy_candidate_available: policyCandidateAvailable,
    mutation_candidate_available: effectiveMutationCandidateAvailable,
    maintenance_ready: effectiveMaintenanceReady,
    recommended_maintenance_profile: postActionMaterialPresent
      ? "immediate"
      : promotionQualityReviewNeeded || runtimeEffectReviewNeeded
        ? "long_horizon"
        : "daily",
  };
  const runtimeSignalLedger = buildRuntimeSignalLedgerFromSlots({
    slots: {
      ...context,
      execution_result_summary: args.parsed.execution_result_summary,
      execution_evidence: args.parsed.execution_evidence,
    },
  });
  const runtimeSignalTrendSummary = readRuntimeSignalTrendSummary(args.parsed);
  const runtimeEntropyProfile = buildRuntimeEntropyProfileV1({
    actionRetrieval: args.actionRetrieval,
    preActionGate,
    evidenceSummary,
    lifecycle,
    runtimeSignalLedger,
    runtimeSignalTrendSummary,
  });
  const runtimeEntropyControls = buildRuntimeEntropyControlsV1({
    profile: runtimeEntropyProfile,
    lifecycle,
  });

  return ActionIntelligenceRuntimeContractV1Schema.parse({
    contract_version: "action_intelligence_runtime_contract_v1",
    loop_version: "action_intelligence_loop_v1",
    tenant_id: args.actionRetrieval.tenant_id,
    scope: args.actionRetrieval.scope,
    run_id: args.parsed.run_id ?? null,
    query_text: args.actionRetrieval.query_text,
    source_code_change_allowed: false,
    selected_tool: args.actionRetrieval.selected_tool,
    recommended_next_action: args.actionRetrieval.recommended_next_action,
    target_files: targetFiles,
    workflow_anchor_id: selectedWorkflowAnchorId,
    policy_memory_id: policyMemoryId,
    execution_contract_v1: executionContract,
    pre_action_gate: preActionGate,
    runtime_entropy_profile: runtimeEntropyProfile,
    runtime_entropy_controls: runtimeEntropyControls,
    runtime_signal_trend_summary: runtimeSignalTrendSummary,
    promotion_quality_summary: promotionQualitySummary,
    runtime_effect_summary: runtimeEffectSummary,
    loop: {
      recall: stage({
        stage: "recall",
        status: "observed",
        summary: args.actionRetrieval.history_applied
          ? "Runtime recalled execution memory for this request."
          : "Runtime recall ran, but no reusable execution memory was trusted for this request.",
        source_refs: actionEvidenceRefs,
        evidence_refs: actionEvidenceRefs,
        required_next: null,
      }),
      assess: stage({
        stage: "assess",
        status: authorityBlocked > 0 || requiresOperatorReview ? "blocked" : "observed",
        summary: `uncertainty=${args.actionRetrieval.uncertainty.level}; confidence=${args.actionRetrieval.uncertainty.confidence.toFixed(2)}`,
        source_refs: ["action_retrieval_uncertainty_v1"],
        evidence_refs: actionEvidenceRefs,
        required_next: authorityBlocked > 0
          ? "Inspect blocked authority before applying learned guidance."
          : requiresInspection
            ? "Inspect current context before executing the recommended action."
            : null,
      }),
      retrieve: stage({
        stage: "retrieve",
        status: retrieveReady ? "ready" : actionBlocked ? "blocked" : "pending",
        summary: args.actionRetrieval.recommended_next_action ?? "No concrete action was retrieved yet.",
        source_refs: [
          selectedWorkflowAnchorId,
          policyMemoryId,
          args.actionRetrieval.tool_source_kind,
        ],
        evidence_refs: actionEvidenceRefs,
        required_next: retrieveReady ? args.actionRetrieval.recommended_next_action : "Resolve recall, rehydration, or authority gaps first.",
      }),
      act: stage({
        stage: "act",
        status: postActionMaterialPresent ? "observed" : actionBlocked ? "blocked" : "pending",
        summary: postActionMaterialPresent
          ? "Execution side outputs are present for evaluation and distillation."
          : "Agent action has not been observed by this contract yet.",
        source_refs: ["execution_result_summary", "execution_artifacts", "execution_evidence"],
        evidence_refs: executionRefs,
        required_next: postActionMaterialPresent ? null : args.actionRetrieval.recommended_next_action,
      }),
      distill: stage({
        stage: "distill",
        status: distillationReady ? "ready" : "pending",
        summary: distillationReady
          ? "Post-action material is ready for L0/L1 distillation."
          : "Distillation waits for real execution material.",
        source_refs: ["write_distillation", "execution_native"],
        evidence_refs: executionRefs,
        required_next: distillationReady ? "Distill execution material into evidence, facts, and workflow candidates." : null,
      }),
      evaluate: stage({
        stage: "evaluate",
        status: hasExecutionResult || executionEvidenceCount > 0 ? "observed" : "pending",
        summary: hasExecutionResult || executionEvidenceCount > 0
          ? "Execution outcome evidence is available for grading."
          : "Outcome evaluation is pending real execution evidence.",
        source_refs: ["execution_result_summary", "execution_evidence"],
        evidence_refs: executionRefs,
        required_next: hasExecutionResult || executionEvidenceCount > 0 ? null : "Capture real execution result or verifier evidence.",
      }),
      attribute: stage({
        stage: "attribute",
        status: postActionMaterialPresent || policyCandidateAvailable ? "ready" : "pending",
        summary: postActionMaterialPresent || policyCandidateAvailable
          ? "Outcome and retrieved memory can be attributed to workflow, pattern, or policy surfaces."
          : "Attribution waits for outcome evidence or learning candidates.",
        source_refs: [selectedWorkflowAnchorId, policyMemoryId, "policy_contract_v1"],
        evidence_refs: allEvidenceRefs,
        required_next: postActionMaterialPresent ? "Attribute outcome to the retrieved workflow, policy, or counter-evidence surface." : null,
      }),
      mutate: stage({
        stage: "mutate",
        status: effectiveMutationCandidateAvailable ? "ready" : "pending",
        summary: effectiveMutationCandidateAvailable
          ? "Scoped learning candidates or promotion-quality review signals are available for learning-control adjudication."
          : "No mutation candidate is ready without more evidence.",
        source_refs: [policyMemoryId, "policy_mutation_loop", "learning_control", promotionQualitySummary?.summary_version],
        evidence_refs: allEvidenceRefs,
        required_next: effectiveMutationCandidateAvailable ? "Route candidates and promotion-quality signals through learning-control before promotion." : null,
      }),
      maintain: stage({
        stage: "maintain",
        status: effectiveMaintenanceReady ? "ready" : "pending",
        summary: effectiveMaintenanceReady
          ? "Runtime maintenance can preserve fresh continuity while recording forgetting signals."
          : "Maintenance waits for post-action evidence or mutation candidates.",
        source_refs: [
          "runtime_maintenance",
          "semantic_forgetting",
          promotionQualitySummary?.summary_version,
          runtimeEffectSummary?.summary_version,
        ],
        evidence_refs: allEvidenceRefs,
        required_next: effectiveMaintenanceReady ? "Run runtime maintenance after the task phase completes." : null,
      }),
      reuse: stage({
        stage: "reuse",
        status: args.actionRetrieval.history_applied || policyCandidateAvailable || workflowCandidateAvailable ? "ready" : "pending",
        summary: args.actionRetrieval.history_applied
          ? "Future execution can reuse learning-controlled action memory from this contract."
          : "Future reuse requires successful evidence and promotion.",
        source_refs: [selectedWorkflowAnchorId, policyMemoryId],
        evidence_refs: allEvidenceRefs,
        required_next: null,
      }),
    },
    evidence_summary: evidenceSummary,
    lifecycle,
    rationale: {
      summary: [
        `loop=recall_assess_retrieve_act_distill_evaluate_attribute_mutate_maintain_reuse`,
        `known_enough=${knownEnough ? "true" : "false"}`,
        `history_applied=${args.actionRetrieval.history_applied ? "true" : "false"}`,
        `post_action_material=${postActionMaterialPresent ? "true" : "false"}`,
      ].join("; "),
    },
  });
}
