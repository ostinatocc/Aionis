import { buildExecutionMemoryIntrospectionLite } from "./execution-introspection.js";
import { buildDelegationLearningSliceLite } from "./delegation-learning.js";
import {
  asRecord,
  firstString,
} from "./action-retrieval.js";
import { buildActionIntelligenceRuntimeContractV1 } from "./action-intelligence-runtime-contract.js";
import {
  ExperienceIntelligenceRequest,
  ExperienceIntelligenceResponseSchema,
  KickoffRecommendationResponseSchema,
  type ExperienceIntelligenceResponse,
  type ExperienceIntelligenceInput,
  type ExecutionMemoryIntrospectionResponse,
  type KickoffRecommendationResponse,
  type RuntimeEditBoundaryContextInput,
  type ToolsSelectRouteContract,
  type TrajectoryCompileResponse,
} from "./schemas.js";
import { parseExecutionContract } from "./execution-contract.js";
import { buildPolicyMaterializationSurface } from "./policy-materialization-surface.js";
import { selectTools } from "./tools-select.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { buildKickoffRecommendationFromExperience } from "../app/planning-summary.js";
import { augmentTrajectoryAwareRequest } from "./trajectory-compile-runtime.js";

type ExperienceLiteStore = LiteWriteStore;

export function buildExperienceIntelligenceResponse(args: {
  parsed: ExperienceIntelligenceInput;
  tools: ToolsSelectRouteContract;
  introspection: ExecutionMemoryIntrospectionResponse;
  delegationLearning?: {
    task_family: string | null;
    matched_records: number;
    truncated: boolean;
    route_role_counts: Record<string, number>;
    record_outcome_counts: Record<string, number>;
    recommendation_count: number;
    learning_recommendations: Array<Record<string, unknown>>;
  };
  trajectoryCompile?: TrajectoryCompileResponse | null;
}): ExperienceIntelligenceResponse {
  const delegationLearning = args.delegationLearning ?? {
    task_family: null,
    matched_records: 0,
    truncated: false,
    route_role_counts: {},
    record_outcome_counts: {},
    recommendation_count: 0,
    learning_recommendations: [],
  };
  const materialization = buildPolicyMaterializationSurface({
    parsed: args.parsed,
    tools: args.tools,
    introspection: args.introspection,
    trajectoryCompile: args.trajectoryCompile ?? null,
    delegationRecommendationCount: delegationLearning.recommendation_count,
  });
  const actionRetrieval = materialization.actionRetrieval;
  const executionContract = parseExecutionContract(actionRetrieval.execution_contract_v1);
  const path = actionRetrieval.path;
  const learningReason = [
    args.introspection.pattern_signal_summary.trusted_pattern_count > 0
      ? `trusted_patterns=${args.introspection.pattern_signal_summary.trusted_pattern_count}`
      : null,
    args.introspection.workflow_signal_summary.stable_workflow_count > 0
      ? `stable_workflows=${args.introspection.workflow_signal_summary.stable_workflow_count}`
      : null,
    firstString(actionRetrieval.rationale.summary),
    actionRetrieval.adaptive_guidance?.selected_candidate_count
      ? `adaptive_guidance=${actionRetrieval.adaptive_guidance.selected_candidate_count}`
      : null,
    actionRetrieval.history_applied ? "history_applied=true" : "history_applied=false",
  ].filter(Boolean).join("; ");
  const combinedNextAction = actionRetrieval.recommended_next_action;
  const historyApplied = materialization.historyApplied;
  const policyHints = materialization.policyHints;
  const derivedPolicy = materialization.derivedPolicy;
  const policyContractWithEvidence = materialization.policyContract;
  const persistedPolicy = materialization.persistedPolicyMemory;
  const actionIntelligenceRuntimeContract = buildActionIntelligenceRuntimeContractV1({
    parsed: args.parsed,
    actionRetrieval,
    introspection: args.introspection,
    derivedPolicy,
    policyContract: policyContractWithEvidence,
    delegationLearning,
  });

  return ExperienceIntelligenceResponseSchema.parse({
    summary_version: "experience_intelligence_v1",
    tenant_id: args.tools.tenant_id,
    scope: args.tools.scope,
    query_text: args.parsed.query_text,
    action_retrieval: actionRetrieval,
    action_intelligence_runtime_contract: actionIntelligenceRuntimeContract,
    execution_contract_v1: executionContract,
    recommendation: {
      history_applied: historyApplied,
      tool: actionRetrieval.tool,
      path: actionRetrieval.path,
      combined_next_action: combinedNextAction,
    },
    policy_hints: policyHints,
    derived_policy: derivedPolicy,
    policy_contract: policyContractWithEvidence,
    learning_summary: {
      task_family: delegationLearning.task_family,
      matched_records: delegationLearning.matched_records,
      truncated: delegationLearning.truncated,
      route_role_counts: delegationLearning.route_role_counts,
      record_outcome_counts: delegationLearning.record_outcome_counts,
      recommendation_count: delegationLearning.recommendation_count,
    },
    learning_recommendations: delegationLearning.learning_recommendations,
    experience_adaptation_trace: actionRetrieval.experience_adaptation_trace,
    rationale: {
      summary: [
        actionRetrieval.rationale.summary,
        derivedPolicy ? `derived_policy=${derivedPolicy.source_kind}:${derivedPolicy.selected_tool}` : null,
        policyContractWithEvidence ? `policy_contract=${policyContractWithEvidence.activation_mode}:${policyContractWithEvidence.selected_tool}` : null,
        persistedPolicy ? `persisted_policy_memory=${persistedPolicy.node_id}` : null,
        learningReason,
      ].filter(Boolean).join(" | "),
    },
  });
}

export async function buildExperienceIntelligenceLite(args: {
  liteWriteStore: ExperienceLiteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId: string;
}): Promise<ExperienceIntelligenceResponse> {
  const augmented = augmentTrajectoryAwareRequest({
    parsed: ExperienceIntelligenceRequest.parse(args.body),
    parse: ExperienceIntelligenceRequest.parse,
    defaultScope: args.defaultScope,
    defaultTenantId: args.defaultTenantId,
  });
  const parsed = augmented.parsed;
  const introspection = await buildExecutionMemoryIntrospectionLite(
    args.liteWriteStore,
    {
      tenant_id: parsed.tenant_id,
      scope: parsed.scope,
      consumer_agent_id: parsed.consumer_agent_id,
      consumer_team_id: parsed.consumer_team_id,
      limit: parsed.workflow_limit,
    },
    args.defaultScope,
    args.defaultTenantId,
    args.defaultActorId,
  );

  const tools = await selectTools(
    null,
    {
      tenant_id: parsed.tenant_id,
      scope: parsed.scope,
      run_id: parsed.run_id,
      context: parsed.context,
      candidates: parsed.candidates,
      include_shadow: parsed.include_shadow,
      rules_limit: parsed.rules_limit,
      strict: parsed.strict,
      reorder_candidates: parsed.reorder_candidates,
      execution_result_summary: parsed.execution_result_summary,
      execution_artifacts: parsed.execution_artifacts,
      execution_evidence: parsed.execution_evidence,
      execution_state_v1: parsed.execution_state_v1,
    },
    args.defaultScope,
    args.defaultTenantId,
    {
      liteWriteStore: args.liteWriteStore,
      recallAccess: args.liteRecallAccess,
      embedder: args.embedder,
    },
  );
  const recommendedWorkflows = Array.isArray(introspection.recommended_workflows) ? introspection.recommended_workflows : [];
  const candidateWorkflows = Array.isArray(introspection.candidate_workflows) ? introspection.candidate_workflows : [];
  const trustedPatterns = Array.isArray(introspection.trusted_patterns) ? introspection.trusted_patterns : [];
  const contestedPatterns = Array.isArray(introspection.contested_patterns) ? introspection.contested_patterns : [];
  const context = asRecord(parsed.context);
  const delegationLearning = await buildDelegationLearningSliceLite({
    liteWriteStore: args.liteWriteStore,
    body: parsed,
    tenantId: parsed.tenant_id ?? args.defaultTenantId,
    scope: parsed.scope ?? args.defaultScope,
    defaultScope: args.defaultScope,
    defaultTenantId: args.defaultTenantId,
    defaultActorId: args.defaultActorId,
    taskFamilies: [
      ...recommendedWorkflows.map((entry) => asRecord(entry)?.task_family),
      ...candidateWorkflows.map((entry) => asRecord(entry)?.task_family),
      ...trustedPatterns.map((entry) => asRecord(entry)?.task_family),
      ...contestedPatterns.map((entry) => asRecord(entry)?.task_family),
      context?.task_family,
      context?.task_kind,
    ],
    limitCandidates: [parsed.workflow_limit],
  });
  return buildExperienceIntelligenceResponse({
    parsed,
    tools,
    introspection,
    delegationLearning,
    trajectoryCompile: augmented.compiled,
  });
}

export function buildKickoffRecommendationResponseFromExperience(
  experience: ExperienceIntelligenceResponse,
  options?: {
    editBoundaryContext?: RuntimeEditBoundaryContextInput | null;
    executionEvidence?: unknown;
  },
): KickoffRecommendationResponse {
  const actionRetrieval = asRecord(experience.action_retrieval);
  const executionContract = parseExecutionContract(
    asRecord(experience)?.execution_contract_v1 ?? actionRetrieval?.execution_contract_v1,
  );
  const tool = asRecord(actionRetrieval?.tool ?? experience.recommendation?.tool);
  const path = asRecord(actionRetrieval?.path ?? experience.recommendation?.path);
  const policyContract = asRecord(experience.policy_contract);
  const pathTargetFiles = Array.isArray(path?.target_files) ? path.target_files : [];
  const policyTargetFiles = Array.isArray(policyContract?.target_files) ? policyContract.target_files : [];
  const kickoffRecommendation = buildKickoffRecommendationFromExperience({
    historyApplied: (
      (typeof actionRetrieval?.history_applied === "boolean" ? actionRetrieval.history_applied : undefined)
      ?? experience.recommendation?.history_applied
    ) === true,
    contractTrustHint:
      actionRetrieval?.contract_trust === "authoritative"
      || actionRetrieval?.contract_trust === "advisory"
      || actionRetrieval?.contract_trust === "observational"
        ? actionRetrieval.contract_trust
        : executionContract?.contract_trust
          ? executionContract.contract_trust
        : path?.contract_trust === "authoritative"
          || path?.contract_trust === "advisory"
          || path?.contract_trust === "observational"
          ? path.contract_trust
          : policyContract?.contract_trust === "authoritative"
            || policyContract?.contract_trust === "advisory"
            || policyContract?.contract_trust === "observational"
            ? policyContract.contract_trust
            : null,
    selectedTool: firstString(executionContract?.selected_tool, actionRetrieval?.selected_tool, tool?.selected_tool),
    taskFamily: firstString(executionContract?.task_family, path?.task_family, policyContract?.task_family),
    workflowSignature: firstString(executionContract?.workflow_signature, path?.workflow_signature, policyContract?.workflow_signature),
    policyMemoryId: firstString(executionContract?.policy_memory_id, policyContract?.policy_memory_id),
    filePath: firstString(
      executionContract?.file_path,
      actionRetrieval?.recommended_file_path,
      path?.file_path,
      policyContract?.file_path,
      typeof pathTargetFiles[0] === "string" ? pathTargetFiles[0] : null,
      typeof policyTargetFiles[0] === "string" ? policyTargetFiles[0] : null,
    ),
    nextAction: firstString(
      executionContract?.next_action,
      actionRetrieval?.recommended_next_action,
      experience.recommendation?.combined_next_action,
      policyContract?.next_action,
    ),
    executionContract,
    uncertainty:
      actionRetrieval?.uncertainty && typeof actionRetrieval.uncertainty === "object"
        ? (actionRetrieval.uncertainty as any)
        : null,
    editBoundaryContext: options?.editBoundaryContext ?? null,
    executionEvidence: options?.executionEvidence,
  });

  return KickoffRecommendationResponseSchema.parse({
    summary_version: "kickoff_recommendation_v1",
    tenant_id: experience.tenant_id,
    scope: experience.scope,
    query_text: experience.query_text,
    kickoff_recommendation: kickoffRecommendation,
    action_retrieval_uncertainty:
      actionRetrieval?.uncertainty && typeof actionRetrieval.uncertainty === "object"
        ? actionRetrieval.uncertainty
        : null,
    policy_contract: experience.policy_contract ?? null,
    rationale: {
      summary:
        typeof experience.rationale?.summary === "string"
          ? experience.rationale.summary
          : "",
    },
  });
}
