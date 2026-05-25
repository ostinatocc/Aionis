import type { EmbeddingProvider } from "../embeddings/types.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { buildDelegationLearningSliceLite } from "./delegation-learning.js";
import { buildExecutionMemoryIntrospectionLite } from "./execution-introspection.js";
import {
  buildExecutionContractFromProjection,
  mergeExecutionContractsWithActionSurface,
  parseExecutionContract,
  type ExecutionContractV1,
} from "./execution-contract.js";
import { applyPolicyMemoryLearningControlLite } from "./policy-memory.js";
import { normalizeContractTrust } from "./contract-trust.js";
import {
  EvolutionInspectRequest,
  EvolutionInspectResponseSchema,
  KickoffRecommendationResponseSchema,
  PolicyLearningControlApplyPayloadSchema,
  PolicyLearningControlApplyResultSchema,
  PolicyLearningControlContractSchema,
  PolicyReviewSummarySchema,
  type EvolutionInspectInput,
  type EvolutionInspectResponse,
  type KickoffRecommendationResponse,
  type PolicyContract,
  type PolicyLearningControlApplyPayload,
  type PolicyLearningControlApplyResult,
  type PolicyLearningControlContract,
  type PolicyReviewSummary,
} from "./schemas.js";
import {
  buildExperienceIntelligenceResponse,
  buildKickoffRecommendationResponseFromExperience,
} from "./experience-intelligence.js";
import { selectTools } from "./tools-select.js";

type EvolutionInspectArtifacts = {
  parsed: EvolutionInspectInput;
  introspection: Awaited<ReturnType<typeof buildExecutionMemoryIntrospectionLite>>;
  tools: Awaited<ReturnType<typeof selectTools>>;
  experience: ReturnType<typeof buildExperienceIntelligenceResponse>;
  kickoff: KickoffRecommendationResponse;
};

type EvolutionInspectComputed = {
  policyReview: PolicyReviewSummary;
  policyLearningControlContract: PolicyLearningControlContract;
  policyLearningControlApplyPayload: PolicyLearningControlApplyPayload | null;
  policyLearningControlApplyResult: PolicyLearningControlApplyResult | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function buildExecutionContractFromPolicyContractSurface(policyContract: PolicyContract | null): ExecutionContractV1 | null {
  if (!policyContract) return null;
  return buildExecutionContractFromProjection({
    contract_trust: policyContract.contract_trust ?? null,
    task_family: policyContract.task_family ?? null,
    workflow_signature: policyContract.workflow_signature ?? null,
    policy_memory_id: policyContract.policy_memory_id ?? null,
    selected_tool: policyContract.selected_tool,
    file_path: policyContract.file_path,
    target_files: policyContract.target_files,
    next_action: policyContract.next_action,
    workflow_steps: policyContract.workflow_steps ?? [],
    pattern_hints: policyContract.pattern_hints ?? [],
    service_lifecycle_constraints: policyContract.service_lifecycle_constraints ?? [],
    provenance: {
      source_kind: "policy_contract",
      source_summary_version: policyContract.summary_version,
      source_anchor: policyContract.policy_memory_id ?? null,
      notes: ["evolution_policy_contract_surface"],
    },
  });
}

function buildExecutionContractFromDerivedPolicySurface(derivedPolicy: Record<string, unknown> | null): ExecutionContractV1 | null {
  if (!derivedPolicy) return null;
  return buildExecutionContractFromProjection({
    contract_trust: normalizeContractTrust(derivedPolicy.contract_trust),
    task_family: firstString(derivedPolicy.task_family),
    workflow_signature: firstString(derivedPolicy.workflow_signature),
    policy_memory_id: firstString(derivedPolicy.policy_memory_id),
    selected_tool: firstString(derivedPolicy.selected_tool),
    file_path: firstString(derivedPolicy.file_path),
    target_files: Array.isArray(derivedPolicy.target_files) ? derivedPolicy.target_files : [],
    workflow_steps: Array.isArray(derivedPolicy.workflow_steps) ? derivedPolicy.workflow_steps : [],
    pattern_hints: Array.isArray(derivedPolicy.pattern_hints) ? derivedPolicy.pattern_hints : [],
    service_lifecycle_constraints: Array.isArray(derivedPolicy.service_lifecycle_constraints)
      ? derivedPolicy.service_lifecycle_constraints
      : [],
    provenance: {
      source_kind: "derived_policy",
      source_anchor: firstString(derivedPolicy.policy_memory_id),
      notes: ["evolution_derived_policy_surface"],
    },
  });
}

function mergeContractsInOrder(contracts: Array<ExecutionContractV1 | null>): ExecutionContractV1 | null {
  let current: ExecutionContractV1 | null = null;
  for (const contract of contracts) {
    if (!contract) continue;
    current = current
      ? mergeExecutionContractsWithActionSurface({
          existing: current,
          incoming: contract,
          preference: "incoming",
        })
      : contract;
  }
  return current;
}

function normalizeAutoApplyError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code: error.name || "policy_learning_control_apply_failed",
      message: error.message || "policy learning_control auto-apply failed",
    };
  }
  return {
    code: "policy_learning_control_apply_failed",
    message: "policy learning_control auto-apply failed",
  };
}

function buildPolicyReviewReason(entry: Record<string, unknown>, policyMemoryState: "active" | "contested" | "retired"): string {
  const feedbackQuality = numeric(entry.feedback_quality);
  if (policyMemoryState === "retired") {
    return feedbackQuality != null && feedbackQuality < 0
      ? "retired_after_sustained_negative_feedback"
      : "retired_due_to_policy_maintenance";
  }
  if (policyMemoryState === "contested") {
    return feedbackQuality != null && feedbackQuality < 0
      ? "contested_by_negative_feedback"
      : "contested_requires_review";
  }
  return "active_policy_memory";
}

export function buildPolicyReviewSummary(args: {
  introspection: EvolutionInspectArtifacts["introspection"];
  policyContract: PolicyContract | null;
}): PolicyReviewSummary {
  const supportingKnowledge = Array.isArray(args.introspection.supporting_knowledge)
    ? args.introspection.supporting_knowledge
    : [];
  const policyEntries = supportingKnowledge
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry && firstString(entry.kind, entry.summary_kind) === "policy_memory");
  const activeEntries = policyEntries.filter((entry) => firstString(entry.policy_memory_state) !== "contested" && firstString(entry.policy_memory_state) !== "retired");
  const contestedEntries = policyEntries.filter((entry) => firstString(entry.policy_memory_state) === "contested");
  const retiredEntries = policyEntries.filter((entry) => firstString(entry.policy_memory_state) === "retired");
  const selectedPolicyMemoryId =
    args.policyContract?.materialization_state === "persisted"
      ? args.policyContract.policy_memory_id
      : null;
  const selectedPolicyMemoryState =
    selectedPolicyMemoryId
      ? (
          policyEntries.find((entry) => firstString(entry.node_id, entry.anchor_id) === selectedPolicyMemoryId)?.policy_memory_state
          ?? args.policyContract?.policy_memory_state
          ?? null
        )
      : null;

  const attentionEntry = [...retiredEntries, ...contestedEntries]
    .sort((left, right) => {
      const leftState = firstString(left.policy_memory_state) === "retired" ? 2 : 1;
      const rightState = firstString(right.policy_memory_state) === "retired" ? 2 : 1;
      if (leftState !== rightState) return rightState - leftState;
      const leftQuality = numeric(left.feedback_quality) ?? 0;
      const rightQuality = numeric(right.feedback_quality) ?? 0;
      if (leftQuality !== rightQuality) return leftQuality - rightQuality;
      return (numeric(right.feedback_negative) ?? 0) - (numeric(left.feedback_negative) ?? 0);
    })[0] ?? null;
  const attentionStateRaw = firstString(attentionEntry?.policy_memory_state);
  const attentionState =
    attentionStateRaw === "contested" || attentionStateRaw === "retired" ? attentionStateRaw : null;

  return PolicyReviewSummarySchema.parse({
    summary_version: "policy_review_summary_v1",
    persisted_policy_count: policyEntries.length,
    active_policy_count: activeEntries.length,
    contested_policy_count: contestedEntries.length,
    retired_policy_count: retiredEntries.length,
    review_recommended: !!attentionEntry,
    selected_policy_memory_id: selectedPolicyMemoryId,
    selected_policy_memory_state:
      selectedPolicyMemoryState === "active" || selectedPolicyMemoryState === "contested" || selectedPolicyMemoryState === "retired"
        ? selectedPolicyMemoryState
        : null,
    attention_policy: attentionEntry && attentionState
      ? {
          node_id: firstString(attentionEntry.node_id, attentionEntry.anchor_id) ?? "",
          policy_memory_state: attentionState,
          execution_contract_v1: mergeContractsInOrder([
            parseExecutionContract(attentionEntry.execution_contract_v1),
            buildExecutionContractFromPolicyContractSurface(args.policyContract),
          ]),
          selected_tool: firstString(attentionEntry.selected_tool),
          file_path: firstString(attentionEntry.file_path),
          workflow_signature: firstString(attentionEntry.workflow_signature),
          summary: firstString(attentionEntry.summary),
          feedback_quality: numeric(attentionEntry.feedback_quality),
          last_feedback_at: firstString(attentionEntry.last_feedback_at),
          last_materialized_at: firstString(attentionEntry.last_materialized_at),
          review_reason: buildPolicyReviewReason(attentionEntry, attentionState),
        }
      : null,
  });
}

export function buildPolicyLearningControlContract(args: {
  policyReview: PolicyReviewSummary;
  policyContract: PolicyContract | null;
  experienceExecutionContract?: ExecutionContractV1 | null;
  derivedPolicy?: Record<string, unknown> | null;
}): PolicyLearningControlContract {
  const attention = args.policyReview.attention_policy;
  const selected = args.policyContract;
  const selectedExecutionContract = mergeContractsInOrder([
    args.experienceExecutionContract ?? null,
    buildExecutionContractFromPolicyContractSurface(selected),
    buildExecutionContractFromDerivedPolicySurface(args.derivedPolicy ?? null),
  ]);
  const attentionExecutionContract = mergeContractsInOrder([
    parseExecutionContract(attention?.execution_contract_v1),
    buildExecutionContractFromPolicyContractSurface(selected),
  ]);

  if (!attention && selected?.materialization_state === "persisted") {
    return PolicyLearningControlContractSchema.parse({
      contract_version: "policy_learning_control_contract_v1",
      action: "monitor",
      applies: true,
      review_required: false,
      policy_memory_id: selected.policy_memory_id,
      current_state: selected.policy_memory_state,
      target_state: selected.policy_memory_state,
      execution_contract_v1: selectedExecutionContract,
      selected_tool: firstString(selectedExecutionContract?.selected_tool, selected.selected_tool),
      file_path: firstString(selectedExecutionContract?.file_path, selected.file_path),
      workflow_signature: firstString(selectedExecutionContract?.workflow_signature, selected.workflow_signature),
      rationale: "persisted_policy_memory_active_and_selected",
      next_action: firstString(selectedExecutionContract?.next_action),
    });
  }

  if (attention?.policy_memory_state === "retired") {
    return PolicyLearningControlContractSchema.parse({
      contract_version: "policy_learning_control_contract_v1",
      action: "retire",
      applies: true,
      review_required: true,
      policy_memory_id: attention.node_id,
      current_state: "retired",
      target_state: "retired",
      execution_contract_v1: attentionExecutionContract,
      selected_tool: firstString(attentionExecutionContract?.selected_tool, attention.selected_tool),
      file_path: firstString(attentionExecutionContract?.file_path, attention.file_path),
      workflow_signature: firstString(attentionExecutionContract?.workflow_signature, attention.workflow_signature),
      rationale: attention.review_reason,
      next_action:
        firstString(attentionExecutionContract?.selected_tool, attention.selected_tool)
          ? `Do not reuse persisted ${firstString(attentionExecutionContract?.selected_tool, attention.selected_tool)}; collect fresh evidence before creating a replacement policy memory.`
          : "Do not reuse this retired policy memory; collect fresh evidence before creating a replacement.",
    });
  }

  if (attention?.policy_memory_state === "contested") {
    const canReactivate =
      selected?.materialization_state === "computed"
      && !!selected.selected_tool
      && !!attention.selected_tool
      && selected.selected_tool === attention.selected_tool
      && (selected.policy_state === "stable" || selected.activation_mode === "default");
    const contestedExecutionContract = canReactivate
      ? mergeContractsInOrder([attentionExecutionContract, selectedExecutionContract])
      : attentionExecutionContract;
    return PolicyLearningControlContractSchema.parse({
      contract_version: "policy_learning_control_contract_v1",
      action: canReactivate ? "reactivate" : "refresh",
      applies: true,
      review_required: true,
      policy_memory_id: attention.node_id,
      current_state: "contested",
      target_state: canReactivate ? "active" : "contested",
      execution_contract_v1: contestedExecutionContract,
      selected_tool: firstString(contestedExecutionContract?.selected_tool, attention.selected_tool),
      file_path: firstString(contestedExecutionContract?.file_path, attention.file_path),
      workflow_signature: firstString(contestedExecutionContract?.workflow_signature, attention.workflow_signature),
      rationale: canReactivate
        ? `${attention.review_reason}; live_policy_still_prefers_same_tool`
        : attention.review_reason,
      next_action: canReactivate
        ? `Re-validate ${attention.selected_tool ?? "the selected tool"} on the current task and re-materialize the contested policy memory if the run succeeds.`
        : `Refresh evidence for ${attention.selected_tool ?? "the contested policy"} before allowing persisted reuse again.`,
    });
  }

  return PolicyLearningControlContractSchema.parse({
    contract_version: "policy_learning_control_contract_v1",
    action: "none",
    applies: false,
    review_required: false,
    policy_memory_id: null,
    current_state: null,
    target_state: null,
    execution_contract_v1: selectedExecutionContract,
    selected_tool: firstString(selectedExecutionContract?.selected_tool, selected?.selected_tool),
    file_path: firstString(selectedExecutionContract?.file_path, selected?.file_path),
    workflow_signature: firstString(selectedExecutionContract?.workflow_signature, selected?.workflow_signature),
    rationale: "no_policy_learning_control_action_required",
    next_action: firstString(selectedExecutionContract?.next_action),
  });
}

export function buildPolicyLearningControlApplyPayload(args: {
  parsed: EvolutionInspectInput;
  policyLearningControlContract: PolicyLearningControlContract;
}): PolicyLearningControlApplyPayload | null {
  const contract = args.policyLearningControlContract;
  if (
    contract.action === "none"
    || contract.action === "monitor"
    || contract.applies !== true
    || typeof contract.policy_memory_id !== "string"
    || contract.policy_memory_id.trim().length === 0
  ) {
    return null;
  }
  const requiresLiveContext = contract.action === "refresh" || contract.action === "reactivate";
  const requestBody: Record<string, unknown> = {
    ...(typeof args.parsed.tenant_id === "string" ? { tenant_id: args.parsed.tenant_id } : {}),
    ...(typeof args.parsed.scope === "string" ? { scope: args.parsed.scope } : {}),
    action: contract.action,
    policy_memory_id: contract.policy_memory_id,
  };
  if (requiresLiveContext) {
    requestBody.query_text = args.parsed.query_text;
    requestBody.context = args.parsed.context;
    requestBody.candidates = args.parsed.candidates;
    requestBody.include_shadow = args.parsed.include_shadow;
    requestBody.rules_limit = args.parsed.rules_limit;
    requestBody.strict = args.parsed.strict;
    requestBody.reorder_candidates = args.parsed.reorder_candidates;
    requestBody.workflow_limit = args.parsed.workflow_limit;
    if (typeof args.parsed.run_id === "string" && args.parsed.run_id.trim().length > 0) {
      requestBody.run_id = args.parsed.run_id;
    }
    if (args.parsed.execution_result_summary) requestBody.execution_result_summary = args.parsed.execution_result_summary;
    if (args.parsed.execution_artifacts) requestBody.execution_artifacts = args.parsed.execution_artifacts;
    if (args.parsed.execution_evidence) requestBody.execution_evidence = args.parsed.execution_evidence;
    if (args.parsed.execution_state_v1) requestBody.execution_state_v1 = args.parsed.execution_state_v1;
    if (typeof args.parsed.consumer_agent_id === "string" && args.parsed.consumer_agent_id.trim().length > 0) {
      requestBody.consumer_agent_id = args.parsed.consumer_agent_id;
    }
    if (typeof args.parsed.consumer_team_id === "string" && args.parsed.consumer_team_id.trim().length > 0) {
      requestBody.consumer_team_id = args.parsed.consumer_team_id;
    }
  }
  return PolicyLearningControlApplyPayloadSchema.parse({
    payload_version: "policy_learning_control_apply_payload_v1",
    route: "/v1/memory/policies/learning-control/apply",
    method: "POST",
    action: contract.action,
    policy_memory_id: contract.policy_memory_id,
    selected_tool: contract.selected_tool,
    current_state: contract.current_state,
    target_state: contract.target_state,
    requires_live_context: requiresLiveContext,
    request_body: requestBody,
    rationale: contract.rationale,
  });
}

function buildEvolutionInspectComputed(
  artifacts: EvolutionInspectArtifacts,
  policyLearningControlApplyResult: PolicyLearningControlApplyResult | null = null,
): EvolutionInspectComputed {
  const policyReview = buildPolicyReviewSummary({
    introspection: artifacts.introspection,
    policyContract: artifacts.experience.policy_contract ?? null,
  });
  const policyLearningControlContract = buildPolicyLearningControlContract({
    policyReview,
    policyContract: artifacts.experience.policy_contract ?? null,
    experienceExecutionContract: parseExecutionContract(artifacts.experience.execution_contract_v1),
    derivedPolicy: asRecord(artifacts.experience.derived_policy),
  });
  const policyLearningControlApplyPayload = buildPolicyLearningControlApplyPayload({
    parsed: artifacts.parsed,
    policyLearningControlContract,
  });
  return {
    policyReview,
    policyLearningControlContract,
    policyLearningControlApplyPayload,
    policyLearningControlApplyResult,
  };
}

async function buildEvolutionInspectArtifacts(args: {
  liteWriteStore: LiteWriteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId?: string | null;
}): Promise<EvolutionInspectArtifacts> {
  const parsed = EvolutionInspectRequest.parse(args.body) as EvolutionInspectInput;
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
    args.defaultActorId ?? "local",
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
      persistDecision: false,
    },
  );

  const experience = buildExperienceIntelligenceResponse({
    parsed,
    tools,
    introspection,
    delegationLearning: await buildDelegationLearningSliceLite({
      liteWriteStore: args.liteWriteStore,
      body: parsed,
      tenantId: parsed.tenant_id ?? args.defaultTenantId,
      scope: parsed.scope ?? args.defaultScope,
      defaultScope: args.defaultScope,
      defaultTenantId: args.defaultTenantId,
      defaultActorId: args.defaultActorId ?? null,
      taskFamilies: [
        ...((Array.isArray(introspection.recommended_workflows) ? introspection.recommended_workflows : []).map((entry) => asRecord(entry)?.task_family)),
        ...((Array.isArray(introspection.candidate_workflows) ? introspection.candidate_workflows : []).map((entry) => asRecord(entry)?.task_family)),
        ...((Array.isArray(introspection.trusted_patterns) ? introspection.trusted_patterns : []).map((entry) => asRecord(entry)?.task_family)),
        ...((Array.isArray(introspection.contested_patterns) ? introspection.contested_patterns : []).map((entry) => asRecord(entry)?.task_family)),
        asRecord(parsed.context)?.task_kind,
      ],
      limitCandidates: [parsed.workflow_limit],
    }),
  });
  const kickoff = buildKickoffRecommendationResponseFromExperience(experience);
  return { parsed, introspection, tools, experience, kickoff };
}

async function rebuildEvolutionInspectArtifactsLite(args: {
  liteWriteStore: LiteWriteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId?: string | null;
  parsed: EvolutionInspectInput;
  tools: Awaited<ReturnType<typeof selectTools>>;
}): Promise<EvolutionInspectArtifacts> {
  const introspection = await buildExecutionMemoryIntrospectionLite(
    args.liteWriteStore,
    {
      tenant_id: args.parsed.tenant_id,
      scope: args.parsed.scope,
      consumer_agent_id: args.parsed.consumer_agent_id,
      consumer_team_id: args.parsed.consumer_team_id,
      limit: args.parsed.workflow_limit,
    },
    args.defaultScope,
    args.defaultTenantId,
    args.defaultActorId ?? "local",
  );
  const experience = buildExperienceIntelligenceResponse({
    parsed: args.parsed,
    tools: args.tools,
    introspection,
    delegationLearning: await buildDelegationLearningSliceLite({
      liteWriteStore: args.liteWriteStore,
      body: args.parsed,
      tenantId: args.parsed.tenant_id ?? args.defaultTenantId,
      scope: args.parsed.scope ?? args.defaultScope,
      defaultScope: args.defaultScope,
      defaultTenantId: args.defaultTenantId,
      defaultActorId: args.defaultActorId ?? null,
      taskFamilies: [
        ...((Array.isArray(introspection.recommended_workflows) ? introspection.recommended_workflows : []).map((entry) => asRecord(entry)?.task_family)),
        ...((Array.isArray(introspection.candidate_workflows) ? introspection.candidate_workflows : []).map((entry) => asRecord(entry)?.task_family)),
        ...((Array.isArray(introspection.trusted_patterns) ? introspection.trusted_patterns : []).map((entry) => asRecord(entry)?.task_family)),
        ...((Array.isArray(introspection.contested_patterns) ? introspection.contested_patterns : []).map((entry) => asRecord(entry)?.task_family)),
        asRecord(args.parsed.context)?.task_kind,
      ],
      limitCandidates: [args.parsed.workflow_limit],
    }),
  });
  const kickoff = buildKickoffRecommendationResponseFromExperience(experience);
  return {
    parsed: args.parsed,
    introspection,
    tools: args.tools,
    experience,
    kickoff,
  };
}

export async function buildEvolutionInspectStateLite(args: {
  liteWriteStore: LiteWriteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId?: string | null;
  surface: string;
}): Promise<{ artifacts: EvolutionInspectArtifacts; computed: EvolutionInspectComputed; evolutionInspect: EvolutionInspectResponse }> {
  let artifacts = await buildEvolutionInspectArtifacts(args);
  let computed = buildEvolutionInspectComputed(artifacts);

  if (
    artifacts.parsed.policy_learning_control_apply_mode === "auto_apply"
    && computed.policyLearningControlApplyPayload
  ) {
    const applyPayload = computed.policyLearningControlApplyPayload;
    try {
      const applied = await applyPolicyMemoryLearningControlLite(args.liteWriteStore, {
        tenant_id: artifacts.experience.tenant_id,
        scope: artifacts.experience.scope,
        actor:
          firstString(
            artifacts.parsed.consumer_agent_id,
            artifacts.parsed.consumer_team_id,
            args.defaultActorId,
          )
          ?? "evolution_auto_apply",
        reason: `evolution_auto_apply:${args.surface}`,
        policy_memory_id: applyPayload.policy_memory_id,
        action: applyPayload.action,
        learning_control_contract: computed.policyLearningControlContract,
        live_policy_contract: artifacts.experience.policy_contract ?? null,
        live_derived_policy: artifacts.experience.derived_policy ?? null,
      });
      const policyLearningControlApplyResult = PolicyLearningControlApplyResultSchema.parse({
        ok: true,
        auto_applied: true,
        attempted: true,
        trigger: "evolution_auto_apply",
        surface: args.surface,
        action: applyPayload.action,
        policy_memory_id: applyPayload.policy_memory_id,
        previous_state: applied.previous_state,
        next_state: applied.next_state,
        policy_memory: applied.policy_memory,
        error: null,
      });
      artifacts = await rebuildEvolutionInspectArtifactsLite({
        liteWriteStore: args.liteWriteStore,
        liteRecallAccess: args.liteRecallAccess,
        embedder: args.embedder,
        defaultScope: args.defaultScope,
        defaultTenantId: args.defaultTenantId,
        defaultActorId: args.defaultActorId,
        parsed: artifacts.parsed,
        tools: artifacts.tools,
      });
      computed = buildEvolutionInspectComputed(artifacts, policyLearningControlApplyResult);
    } catch (error) {
      computed = buildEvolutionInspectComputed(
        artifacts,
        PolicyLearningControlApplyResultSchema.parse({
          ok: false,
          auto_applied: false,
          attempted: true,
          trigger: "evolution_auto_apply",
          surface: args.surface,
          action: applyPayload.action,
          policy_memory_id: applyPayload.policy_memory_id,
          error: normalizeAutoApplyError(error),
        }),
      );
    }
  }

  return {
    artifacts,
    computed,
    evolutionInspect: buildEvolutionInspectResponse(artifacts, computed),
  };
}

function buildEvolutionInspectResponse(
  artifacts: EvolutionInspectArtifacts,
  computed: EvolutionInspectComputed = buildEvolutionInspectComputed(artifacts),
): EvolutionInspectResponse {
  const { parsed, introspection, experience, kickoff } = artifacts;
  return EvolutionInspectResponseSchema.parse({
    summary_version: "evolution_inspect_v1",
    tenant_id: experience.tenant_id,
    scope: experience.scope,
    query_text: parsed.query_text,
    experience_intelligence: experience,
    policy_hints: experience.policy_hints,
    derived_policy: experience.derived_policy ?? null,
    policy_contract: experience.policy_contract ?? null,
    policy_review: computed.policyReview,
    policy_learning_control_contract: computed.policyLearningControlContract,
    policy_learning_control_apply_payload: computed.policyLearningControlApplyPayload,
    policy_learning_control_apply_result: computed.policyLearningControlApplyResult,
    kickoff_recommendation: kickoff,
    execution_introspection: introspection,
    evolution_summary: {
      summary_version: "evolution_inspect_summary_v1",
      history_applied: experience.recommendation.history_applied,
      selected_tool: experience.recommendation.tool.selected_tool,
      recommended_file_path: experience.recommendation.path.file_path,
      recommended_next_action: experience.recommendation.combined_next_action,
      stable_workflow_count: introspection.workflow_signal_summary.stable_workflow_count,
      promotion_ready_workflow_count: introspection.workflow_signal_summary.promotion_ready_workflow_count,
      trusted_pattern_count: introspection.pattern_signal_summary.trusted_pattern_count,
      contested_pattern_count: introspection.pattern_signal_summary.contested_pattern_count,
      suppressed_pattern_count: experience.recommendation.tool.suppressed_pattern_anchor_ids.length,
      distilled_evidence_count: introspection.inventory.raw_distilled_evidence_count,
      distilled_fact_count: introspection.inventory.raw_distilled_fact_count,
      persisted_policy_count: computed.policyReview.persisted_policy_count,
      active_policy_count: computed.policyReview.active_policy_count,
      contested_policy_count: computed.policyReview.contested_policy_count,
      retired_policy_count: computed.policyReview.retired_policy_count,
    },
  });
}

export async function buildEvolutionInspectLite(args: {
  liteWriteStore: LiteWriteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId?: string | null;
}): Promise<EvolutionInspectResponse> {
  const state = await buildEvolutionInspectStateLite({
    ...args,
    surface: "evolution_inspect",
  });
  return state.evolutionInspect;
}
