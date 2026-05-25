import {
  asRecord,
  buildActionRetrievalResponse,
  choosePreferredTrustedPattern,
  findSelectedWorkflow,
  firstString,
  isStableWorkflowEntry,
  numeric,
  readPersistedPolicyMemory,
  stringList,
  toPolicyHintEntry,
  workflowEvidenceParts,
  workflowToolPreferenceState,
  type PersistedPolicyMemory,
  type PolicyHintEntryLike,
} from "./action-retrieval.js";
import {
  DerivedPolicySurfaceSchema,
  PolicyContractSchema,
  type ActionRetrievalResponse,
  type ContractTrust,
  type DerivedPolicySurface,
  type ExecutionMemoryIntrospectionResponse,
  type ExperienceIntelligenceInput,
  type PolicyContract,
  type PolicyHintEntry,
  type PolicyHintPack,
  type ToolsSelectRouteContract,
} from "./schemas.js";
import {
  parseExecutionContract,
  type ExecutionContractV1,
} from "./execution-contract.js";
import { resolveContractTrustForSteering } from "./contract-trust.js";
import { resolveNodeExecutionEvidence } from "./node-execution-surface.js";
import {
  ServiceLifecycleConstraintV1Schema,
  type ServiceLifecycleConstraintV1,
} from "../execution/types.js";

type ActionRetrievalPath = ActionRetrievalResponse["path"];

function normalizeServiceLifecycleConstraints(value: unknown, limit = 16): ServiceLifecycleConstraintV1[] {
  if (!Array.isArray(value)) return [];
  const out: ServiceLifecycleConstraintV1[] = [];
  for (const entry of value) {
    const parsed = ServiceLifecycleConstraintV1Schema.safeParse(entry);
    if (!parsed.success) continue;
    out.push(parsed.data);
    if (out.length >= limit) break;
  }
  return out;
}

function workflowReuseReason(path: ActionRetrievalPath): string {
  const record = path as unknown as Record<string, unknown>;
  return firstString(record.reason, record.summary, record.next_action)
    ?? "Reuse the most relevant learned workflow first.";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function firstContractTrust(...values: unknown[]): ContractTrust | null {
  for (const value of values) {
    if (value === "authoritative" || value === "advisory" || value === "observational") return value;
  }
  return null;
}

function outcomeFieldsFromContract(contract: ExecutionContractV1 | null | undefined): Record<string, string[]> {
  if (!contract) return {};
  return {
    ...(contract.outcome.acceptance_checks.length > 0 ? { acceptance_checks: contract.outcome.acceptance_checks } : {}),
    ...(contract.outcome.success_invariants.length > 0 ? { success_invariants: contract.outcome.success_invariants } : {}),
    ...(contract.outcome.dependency_requirements.length > 0 ? { dependency_requirements: contract.outcome.dependency_requirements } : {}),
    ...(contract.outcome.environment_assumptions.length > 0 ? { environment_assumptions: contract.outcome.environment_assumptions } : {}),
    ...(contract.outcome.must_hold_after_exit.length > 0 ? { must_hold_after_exit: contract.outcome.must_hold_after_exit } : {}),
    ...(contract.outcome.external_visibility_requirements.length > 0
      ? { external_visibility_requirements: contract.outcome.external_visibility_requirements }
      : {}),
  };
}

function outcomeFieldsFromPolicy(policy: DerivedPolicySurface | PolicyContract | null | undefined): Record<string, string[]> {
  if (!policy) return {};
  const acceptanceChecks = stringList((policy as Record<string, unknown>).acceptance_checks, 24);
  const successInvariants = stringList((policy as Record<string, unknown>).success_invariants, 24);
  const dependencyRequirements = stringList((policy as Record<string, unknown>).dependency_requirements, 24);
  const environmentAssumptions = stringList((policy as Record<string, unknown>).environment_assumptions, 24);
  const mustHoldAfterExit = stringList((policy as Record<string, unknown>).must_hold_after_exit, 24);
  const externalVisibilityRequirements = stringList((policy as Record<string, unknown>).external_visibility_requirements, 24);
  return {
    ...(acceptanceChecks.length > 0 ? { acceptance_checks: acceptanceChecks } : {}),
    ...(successInvariants.length > 0 ? { success_invariants: successInvariants } : {}),
    ...(dependencyRequirements.length > 0 ? { dependency_requirements: dependencyRequirements } : {}),
    ...(environmentAssumptions.length > 0 ? { environment_assumptions: environmentAssumptions } : {}),
    ...(mustHoldAfterExit.length > 0 ? { must_hold_after_exit: mustHoldAfterExit } : {}),
    ...(externalVisibilityRequirements.length > 0 ? { external_visibility_requirements: externalVisibilityRequirements } : {}),
  };
}

export function buildDerivedPolicySurface(args: {
  tools: ToolsSelectRouteContract;
  introspection: ExecutionMemoryIntrospectionResponse;
  path: ActionRetrievalPath;
  queryText: string;
  context: unknown;
  executionContract: ExecutionContractV1 | null;
}): DerivedPolicySurface | null {
  const selectedTool = firstString(args.tools.selection?.selected);
  if (!selectedTool) return null;

  const trustedPatterns = (Array.isArray(args.introspection.trusted_patterns) ? args.introspection.trusted_patterns : [])
    .map(toPolicyHintEntry)
    .filter((entry): entry is PolicyHintEntryLike => entry !== null);
  const preferredPattern = choosePreferredTrustedPattern({
    trustedPatterns,
    selectedTool,
    queryText: args.queryText,
    context: args.context,
  });
  const patternSupports = preferredPattern?.selected_tool === selectedTool;
  const selectedWorkflow = findSelectedWorkflow({
    introspection: args.introspection,
    path: args.path,
  });
  const workflowPolicyState = workflowToolPreferenceState({
    workflow: selectedWorkflow,
    selectedTool,
  });
  const workflowSupports = args.path.source_kind === "recommended_workflow"
    && isStableWorkflowEntry(selectedWorkflow)
    && workflowPolicyState !== "none";
  const authoritativeWorkflowSupports = workflowSupports && workflowPolicyState === "stable";
  const authoritativeExecutionContractSupports = args.executionContract?.contract_trust === "authoritative";
  const authoritativePolicySupports = authoritativeWorkflowSupports || authoritativeExecutionContractSupports;
  if (!patternSupports && !workflowSupports) return null;

  const sourceKind =
    patternSupports && workflowSupports
      ? "blended"
      : patternSupports
        ? "trusted_pattern"
        : "stable_workflow";
  const workflowContractTrust = firstContractTrust(
    (args.path as Record<string, unknown>).contract_trust,
    parseExecutionContract(selectedWorkflow?.execution_contract_v1)?.contract_trust,
    selectedWorkflow?.contract_trust,
  );
  const selectedWorkflowExecutionContract = parseExecutionContract(selectedWorkflow?.execution_contract_v1);
  const preferredPatternExecutionContract = parseExecutionContract(preferredPattern?.execution_contract_v1);
  const steeringExecutionContract = args.executionContract
    ?? selectedWorkflowExecutionContract
    ?? preferredPatternExecutionContract
    ?? null;
  const policyContractTrust = resolveContractTrustForSteering({
    computedTrust: authoritativePolicySupports ? "authoritative" : "advisory",
    explicitTrust: firstContractTrust(
      args.executionContract?.contract_trust,
      preferredPattern?.contract_trust,
      preferredPatternExecutionContract?.contract_trust,
      workflowContractTrust,
    ),
    executionContract: steeringExecutionContract,
  });
  const policyState =
    authoritativePolicySupports && policyContractTrust === "authoritative"
      ? "stable"
      : "candidate";
  const patternConfidence = patternSupports ? (preferredPattern?.confidence ?? 0.82) : 0;
  const workflowConfidence = workflowSupports ? (selectedWorkflow?.confidence ?? 0.72) : 0;
  const confidence =
    sourceKind === "blended"
      ? clamp01(Math.max(patternConfidence, workflowConfidence) + 0.08)
      : clamp01(Math.max(patternConfidence, workflowConfidence));
  const supportingAnchorIds = [
    ...(patternSupports && preferredPattern ? [preferredPattern.anchor_id] : []),
    ...(workflowSupports && selectedWorkflow ? [selectedWorkflow.anchor_id] : []),
  ];
  const usageCount = Math.max(0, Number(selectedWorkflow?.usage_count ?? 0));
  const reuseSuccessCount = Math.max(0, Number(selectedWorkflow?.reuse_success_count ?? 0));
  const reuseFailureCount = Math.max(0, Number(selectedWorkflow?.reuse_failure_count ?? 0));
  const feedbackQuality = numeric(selectedWorkflow?.feedback_quality);
  const reason = [
    patternSupports ? `trusted pattern supports ${selectedTool}` : null,
    workflowSupports ? `stable workflow supports ${selectedTool}` : null,
    authoritativeExecutionContractSupports ? "authoritative execution contract supports policy materialization" : null,
    workflowSupports && selectedWorkflow ? workflowEvidenceParts(selectedWorkflow).join("; ") : null,
  ].filter((value): value is string => !!value).join("; ");
  const workflowSteps = stringList(
    workflowSupports && selectedWorkflow?.workflow_steps && selectedWorkflow.workflow_steps.length > 0
      ? selectedWorkflow.workflow_steps
      : args.executionContract?.workflow_steps,
    24,
  );
  const patternHints = stringList(
    workflowSupports && selectedWorkflow?.pattern_hints && selectedWorkflow.pattern_hints.length > 0
      ? selectedWorkflow.pattern_hints
      : args.executionContract?.pattern_hints,
    24,
  );
  const workflowServiceLifecycleConstraints = workflowSupports
    ? normalizeServiceLifecycleConstraints(selectedWorkflow?.service_lifecycle_constraints)
    : [];
  const executionServiceLifecycleConstraints = normalizeServiceLifecycleConstraints(args.executionContract?.service_lifecycle_constraints);
  const serviceLifecycleConstraints = workflowServiceLifecycleConstraints.length > 0
    ? workflowServiceLifecycleConstraints
    : executionServiceLifecycleConstraints;
  const targetFiles = stringList(
    workflowSupports && selectedWorkflow?.target_files && selectedWorkflow.target_files.length > 0
      ? selectedWorkflow.target_files
      : args.executionContract?.target_files && args.executionContract.target_files.length > 0
        ? args.executionContract.target_files
        : preferredPattern?.target_files,
    24,
  );
  const outcomeFields = outcomeFieldsFromContract(steeringExecutionContract);

  return DerivedPolicySurfaceSchema.parse({
    summary_version: "derived_policy_v1",
    policy_kind: "tool_preference",
    source_kind: sourceKind,
    policy_state: policyState,
    contract_trust: policyContractTrust,
    selected_tool: selectedTool,
    task_family: firstString(
      (args.path as Record<string, unknown>).task_family,
      selectedWorkflow?.task_family,
      preferredPattern?.task_family,
      args.executionContract?.task_family,
    ),
    workflow_signature: firstString(selectedWorkflow?.workflow_signature, args.executionContract?.workflow_signature),
    file_path: firstString(selectedWorkflow?.file_path, preferredPattern?.file_path, args.executionContract?.file_path),
    target_files: targetFiles,
    ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
    ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
    ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    ...outcomeFields,
    confidence,
    supporting_anchor_ids: supportingAnchorIds,
    reason,
    evidence: {
      trusted_pattern_count: patternSupports ? 1 : 0,
      stable_workflow_count: workflowSupports ? 1 : 0,
      usage_count: usageCount,
      reuse_success_count: reuseSuccessCount,
      reuse_failure_count: reuseFailureCount,
      feedback_quality: feedbackQuality,
    },
  });
}

export function buildPolicyHintPack(args: {
  tools: ToolsSelectRouteContract;
  introspection: ExecutionMemoryIntrospectionResponse;
  path: ActionRetrievalPath;
  queryText: string;
  context: unknown;
}): PolicyHintPack {
  const hints: PolicyHintEntry[] = [];
  const selectedTool = firstString(args.tools.selection?.selected);
  const trustedPatterns = (Array.isArray(args.introspection.trusted_patterns) ? args.introspection.trusted_patterns : [])
    .map(toPolicyHintEntry)
    .filter((entry): entry is PolicyHintEntryLike => entry !== null);
  const contestedPatterns = (Array.isArray(args.introspection.contested_patterns) ? args.introspection.contested_patterns : [])
    .map(toPolicyHintEntry)
    .filter((entry): entry is PolicyHintEntryLike => entry !== null);
  const rehydrationCandidates = (Array.isArray(args.introspection.rehydration_candidates) ? args.introspection.rehydration_candidates : [])
    .map(toPolicyHintEntry)
    .filter((entry): entry is PolicyHintEntryLike => entry !== null);

  const preferredPattern = choosePreferredTrustedPattern({
    trustedPatterns,
    selectedTool,
    queryText: args.queryText,
    context: args.context,
  });
  if (preferredPattern && preferredPattern.selected_tool) {
    hints.push({
      hint_id: `tool_preference:${preferredPattern.anchor_id}:${preferredPattern.selected_tool}`,
      source_kind: "trusted_pattern",
      hint_kind: "tool_preference",
      action: "prefer",
      source_anchor_id: preferredPattern.anchor_id,
      source_anchor_level: preferredPattern.anchor_level ?? null,
      selected_tool: preferredPattern.selected_tool,
      task_family: preferredPattern.task_family ?? null,
      workflow_signature: null,
      file_path: preferredPattern.file_path ?? null,
      target_files: preferredPattern.target_files ?? [],
      rehydration_mode: null,
      confidence: preferredPattern.confidence ?? null,
      priority: 100,
      reason: preferredPattern.summary ?? `Prefer ${preferredPattern.selected_tool} from trusted pattern memory.`,
    });
  }

  const selectedWorkflow = findSelectedWorkflow({
    introspection: args.introspection,
    path: args.path,
  });
  const workflowPolicyState = workflowToolPreferenceState({
    workflow: selectedWorkflow,
    selectedTool,
  });
  if (
    args.path.source_kind === "recommended_workflow"
    && isStableWorkflowEntry(selectedWorkflow)
    && workflowPolicyState !== "none"
  ) {
    hints.push({
      hint_id: `tool_preference:${selectedWorkflow!.anchor_id}:${selectedTool}:workflow`,
      source_kind: "stable_workflow",
      hint_kind: "tool_preference",
      action: "prefer",
      source_anchor_id: selectedWorkflow!.anchor_id,
      source_anchor_level: firstString(selectedWorkflow!.anchor_level, "L2"),
      selected_tool: selectedTool,
      task_family: firstString(selectedWorkflow!.task_family),
      workflow_signature: firstString(selectedWorkflow!.workflow_signature),
      file_path: firstString(selectedWorkflow!.file_path),
      target_files: stringList(selectedWorkflow!.target_files, 24),
      workflow_steps: stringList(selectedWorkflow!.workflow_steps, 24),
      pattern_hints: stringList(selectedWorkflow!.pattern_hints, 24),
      service_lifecycle_constraints: normalizeServiceLifecycleConstraints(selectedWorkflow!.service_lifecycle_constraints),
      rehydration_mode: null,
      confidence: Number.isFinite(selectedWorkflow!.confidence ?? Number.NaN) ? (selectedWorkflow!.confidence ?? null) : null,
      priority: preferredPattern?.selected_tool === selectedTool ? 85 : 95,
      reason: `Prefer ${selectedTool} because stable workflow evidence supports reuse; ${workflowEvidenceParts(selectedWorkflow!).join("; ")}`,
    });
  }

  for (const entry of contestedPatterns.slice(0, 2)) {
    if (!entry.selected_tool) continue;
    hints.push({
      hint_id: `tool_avoidance:${entry.anchor_id}:${entry.selected_tool}`,
      source_kind: "contested_pattern",
      hint_kind: "tool_avoidance",
      action: "avoid",
      source_anchor_id: entry.anchor_id,
      source_anchor_level: entry.anchor_level ?? null,
      selected_tool: entry.selected_tool,
      task_family: entry.task_family ?? null,
      workflow_signature: null,
      file_path: entry.file_path ?? null,
      target_files: entry.target_files ?? [],
      rehydration_mode: null,
      confidence: entry.confidence ?? null,
      priority: 80,
      reason: entry.summary ?? `Avoid ${entry.selected_tool} until contested pattern evidence is resolved.`,
    });
  }

  if (args.path.anchor_id && args.path.source_kind === "recommended_workflow") {
    const workflowSteps = Array.isArray(args.path.workflow_steps) && args.path.workflow_steps.length > 0
      ? args.path.workflow_steps
      : stringList(selectedWorkflow?.workflow_steps, 24);
    const patternHints = Array.isArray(args.path.pattern_hints) && args.path.pattern_hints.length > 0
      ? args.path.pattern_hints
      : stringList(selectedWorkflow?.pattern_hints, 24);
    const pathServiceLifecycleConstraints = normalizeServiceLifecycleConstraints(args.path.service_lifecycle_constraints);
    const workflowServiceLifecycleConstraints = normalizeServiceLifecycleConstraints(selectedWorkflow?.service_lifecycle_constraints);
    const serviceLifecycleConstraints = pathServiceLifecycleConstraints.length > 0
      ? pathServiceLifecycleConstraints
      : workflowServiceLifecycleConstraints;
    hints.push({
      hint_id: `workflow_reuse:${args.path.anchor_id}`,
      source_kind: "stable_workflow",
      hint_kind: "workflow_reuse",
      action: "reuse",
      source_anchor_id: args.path.anchor_id,
      source_anchor_level: "L2",
      selected_tool: selectedTool,
      task_family: firstString((args.path as Record<string, unknown>).task_family, selectedWorkflow?.task_family),
      workflow_signature: args.path.workflow_signature,
      file_path: args.path.file_path,
      target_files: args.path.target_files,
      workflow_steps: workflowSteps,
      pattern_hints: patternHints,
      service_lifecycle_constraints: serviceLifecycleConstraints,
      rehydration_mode: null,
      confidence: args.path.confidence,
      priority: 90,
      reason: workflowReuseReason(args.path),
    });
  }

  const rehydrationHint = rehydrationCandidates[0] ?? null;
  if (rehydrationHint) {
    hints.push({
      hint_id: `payload_rehydration:${rehydrationHint.anchor_id}`,
      source_kind: "rehydration_candidate",
      hint_kind: "payload_rehydration",
      action: "rehydrate",
      source_anchor_id: rehydrationHint.anchor_id,
      source_anchor_level: rehydrationHint.anchor_level ?? null,
      selected_tool: rehydrationHint.selected_tool ?? null,
      task_family: rehydrationHint.task_family ?? null,
      workflow_signature: rehydrationHint.workflow_signature ?? null,
      file_path: rehydrationHint.file_path ?? null,
      target_files: rehydrationHint.target_files ?? [],
      rehydration_mode: rehydrationHint.mode ?? "partial",
      confidence: rehydrationHint.confidence ?? null,
      priority: 60,
      reason: rehydrationHint.summary ?? "Rehydrate payload only if anchor-level memory is not enough.",
    });
  }

  return {
    summary_version: "policy_hint_pack_v1",
    total_hints: hints.length,
    tool_preference_count: hints.filter((entry) => entry.hint_kind === "tool_preference").length,
    tool_avoidance_count: hints.filter((entry) => entry.hint_kind === "tool_avoidance").length,
    workflow_reuse_count: hints.filter((entry) => entry.hint_kind === "workflow_reuse").length,
    payload_rehydration_count: hints.filter((entry) => entry.hint_kind === "payload_rehydration").length,
    hints,
  };
}

export function buildPolicyContract(args: {
  historyApplied: boolean;
  derivedPolicy: DerivedPolicySurface | null;
  policyHints: PolicyHintPack;
  path: ActionRetrievalPath;
  nextAction: string | null;
  executionContract: ExecutionContractV1 | null;
}): PolicyContract | null {
  if (!args.derivedPolicy) return null;
  const avoidTools = Array.from(new Set(
    args.policyHints.hints
      .filter((entry) => entry.hint_kind === "tool_avoidance" && entry.action === "avoid" && typeof entry.selected_tool === "string")
      .map((entry) => entry.selected_tool as string),
  ));
  const rehydrationMode =
    args.policyHints.hints.find((entry) => entry.hint_kind === "payload_rehydration" && entry.action === "rehydrate")?.rehydration_mode
    ?? null;
  const targetFiles = Array.isArray(args.executionContract?.target_files) && args.executionContract.target_files.length > 0
    ? args.executionContract.target_files
    : args.path.target_files.length > 0
    ? args.path.target_files
    : args.derivedPolicy.target_files.length > 0
      ? args.derivedPolicy.target_files
      : args.derivedPolicy.file_path
        ? [args.derivedPolicy.file_path]
        : [];
  const activationMode =
    args.derivedPolicy.policy_state === "stable"
      && args.historyApplied
      && args.derivedPolicy.contract_trust === "authoritative"
      ? "default"
      : "hint";
  const pathWorkflowSteps = Array.isArray(args.path.workflow_steps) ? args.path.workflow_steps : [];
  const pathServiceLifecycleConstraints = normalizeServiceLifecycleConstraints(args.path.service_lifecycle_constraints);
  const workflowSteps = Array.isArray(args.executionContract?.workflow_steps) && args.executionContract.workflow_steps.length > 0
    ? args.executionContract.workflow_steps
    : pathWorkflowSteps.length > 0
    ? pathWorkflowSteps
    : Array.isArray(args.derivedPolicy.workflow_steps)
      ? args.derivedPolicy.workflow_steps
      : [];
  const patternHints = Array.isArray(args.executionContract?.pattern_hints) && args.executionContract.pattern_hints.length > 0
    ? args.executionContract.pattern_hints
    : Array.isArray(args.derivedPolicy.pattern_hints)
    ? args.derivedPolicy.pattern_hints
    : [];
  const executionServiceLifecycleConstraints = normalizeServiceLifecycleConstraints(args.executionContract?.service_lifecycle_constraints);
  const derivedPolicyServiceLifecycleConstraints = normalizeServiceLifecycleConstraints(args.derivedPolicy.service_lifecycle_constraints);
  const serviceLifecycleConstraints = executionServiceLifecycleConstraints.length > 0
    ? executionServiceLifecycleConstraints
    : pathServiceLifecycleConstraints.length > 0
    ? pathServiceLifecycleConstraints
    : derivedPolicyServiceLifecycleConstraints;
  const reason = [
    args.derivedPolicy.reason,
    avoidTools.length > 0 ? `avoid=${avoidTools.join(", ")}` : null,
    rehydrationMode ? `rehydration=${rehydrationMode}` : null,
  ].filter((value): value is string => !!value).join("; ");
  const outcomeFields = {
    ...outcomeFieldsFromPolicy(args.derivedPolicy),
    ...outcomeFieldsFromContract(args.executionContract),
  };

  return PolicyContractSchema.parse({
    summary_version: "policy_contract_v1",
    policy_kind: "tool_preference",
    source_kind: args.derivedPolicy.source_kind,
    policy_state: args.derivedPolicy.policy_state,
    contract_trust: args.derivedPolicy.contract_trust ?? "authoritative",
    policy_memory_state: "active",
    activation_mode: activationMode,
    materialization_state: "computed",
    history_applied: args.historyApplied,
    selected_tool: args.derivedPolicy.selected_tool,
    avoid_tools: avoidTools,
    task_family: firstString(args.executionContract?.task_family, (args.path as Record<string, unknown>).task_family, args.derivedPolicy.task_family),
    workflow_signature: firstString(args.executionContract?.workflow_signature, args.path.workflow_signature, args.derivedPolicy.workflow_signature),
    file_path: firstString(args.executionContract?.file_path, args.path.file_path, args.derivedPolicy.file_path),
    target_files: targetFiles,
    next_action: firstString(args.executionContract?.next_action, args.nextAction, args.path.next_action),
    ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
    ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
    ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    ...outcomeFields,
    rehydration_mode: rehydrationMode,
    confidence: args.derivedPolicy.confidence,
    source_anchor_ids: args.derivedPolicy.supporting_anchor_ids,
    policy_memory_id: null,
    reason,
  });
}

export type PolicyMaterializationSurface = {
  actionRetrieval: ActionRetrievalResponse;
  executionContract: ExecutionContractV1 | null;
  path: ActionRetrievalPath;
  liveDerivedPolicy: DerivedPolicySurface | null;
  persistedPolicyMemory: PersistedPolicyMemory | null;
  derivedPolicy: DerivedPolicySurface | null;
  policyHints: PolicyHintPack;
  historyApplied: boolean;
  policyContract: PolicyContract | null;
};

export function buildPolicyMaterializationSurface(args: {
  parsed: ExperienceIntelligenceInput;
  tools: ToolsSelectRouteContract;
  introspection: ExecutionMemoryIntrospectionResponse;
  includePersistedPolicy?: boolean;
}): PolicyMaterializationSurface {
  const actionRetrieval = buildActionRetrievalResponse({
    parsed: args.parsed,
    tools: args.tools,
    introspection: args.introspection,
  });
  const executionContract = parseExecutionContract(actionRetrieval.execution_contract_v1);
  const path = actionRetrieval.path;
  const selectedTool = actionRetrieval.selected_tool;
  const trustedPatterns = (Array.isArray(args.introspection.trusted_patterns) ? args.introspection.trusted_patterns : [])
    .map(toPolicyHintEntry)
    .filter((entry): entry is PolicyHintEntryLike => entry !== null);
  const preferredPattern = choosePreferredTrustedPattern({
    trustedPatterns,
    selectedTool,
    queryText: args.parsed.query_text,
    context: args.parsed.context,
  });
  const selectedWorkflow = findSelectedWorkflow({
    introspection: args.introspection,
    path,
  });
  const liveDerivedPolicy = buildDerivedPolicySurface({
    tools: args.tools,
    introspection: args.introspection,
    path,
    queryText: args.parsed.query_text,
    context: args.parsed.context,
    executionContract,
  });
  const policyHints = buildPolicyHintPack({
    tools: args.tools,
    introspection: args.introspection,
    path,
    queryText: args.parsed.query_text,
    context: args.parsed.context,
  });
  const persistedPolicyMemory = args.includePersistedPolicy === false
    ? null
    : readPersistedPolicyMemory({
        introspection: args.introspection,
        queryText: args.parsed.query_text,
        context: args.parsed.context,
        selectedTool,
        path,
        preferredPattern,
        selectedWorkflow,
      });
  const historyApplied = actionRetrieval.history_applied || !!persistedPolicyMemory;
  const derivedPolicy = persistedPolicyMemory?.derived_policy ?? liveDerivedPolicy;
  const policyContract = persistedPolicyMemory
    ? PolicyContractSchema.parse({
        ...persistedPolicyMemory.contract,
        history_applied: historyApplied,
        materialization_state: "persisted",
        policy_memory_id: persistedPolicyMemory.node_id,
      })
    : buildPolicyContract({
        historyApplied,
        derivedPolicy,
        policyHints,
        path,
        nextAction: actionRetrieval.recommended_next_action,
        executionContract,
      });
  const liveExecutionEvidence = resolveNodeExecutionEvidence({
    slots: {
      ...(asRecord(args.parsed.context) ?? {}),
      ...(args.parsed.execution_result_summary ? { execution_result_summary: args.parsed.execution_result_summary } : {}),
      ...(args.parsed.execution_evidence ? { execution_evidence: args.parsed.execution_evidence } : {}),
    },
  });
  const policyContractWithEvidence = policyContract && liveExecutionEvidence
    ? PolicyContractSchema.parse({
        ...policyContract,
        execution_evidence_v1: liveExecutionEvidence,
      })
    : policyContract;

  return {
    actionRetrieval,
    executionContract,
    path,
    liveDerivedPolicy,
    persistedPolicyMemory,
    derivedPolicy,
    policyHints,
    historyApplied,
    policyContract: policyContractWithEvidence,
  };
}
