import {
  ActionRetrievalRequest,
  ActionRetrievalResponseSchema,
  type ContractTrust,
  DerivedPolicySurfaceSchema,
  PolicyContractSchema,
  type ActionRetrievalResponse,
  type DerivedPolicySurface,
  type ExecutionMemoryIntrospectionResponse,
  type ExperienceIntelligenceInput,
  type PolicyContract,
  type ToolsSelectRouteContract,
  type TrajectoryCompileResponse,
} from "./schemas.js";
import {
  buildExecutionContractFromProjection,
  deriveExecutionContractFromSlots,
  hasExecutionContractSurfaceSignal,
  mergeExecutionContractsWithActionSurface,
  parseExecutionContract,
  type ExecutionContractV1,
} from "./execution-contract.js";
import { buildExecutionMemoryIntrospectionLite } from "./execution-introspection.js";
import { augmentTrajectoryAwareRequest } from "./trajectory-compile-runtime.js";
import { selectTools } from "./tools-select.js";
import { buildOutcomeContractGate } from "./contract-trust.js";
import {
  authorityConsumptionStateFromValue,
  buildAuthorityInspectionNextAction,
  demoteContractTrustForAuthorityVisibility,
  demoteExecutionContractForAuthorityVisibility,
} from "./authority-consumption.js";
import {
  applyAdaptiveGuidanceToUncertainty,
  buildAdaptiveGuidanceOverlay,
} from "./adaptive-guidance.js";
import { buildExecutionExperienceAdaptationTrace } from "./execution-experience-adaptation.js";
import type { RuntimeAuthorityVisibilityV1 } from "./authority-visibility.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  ServiceLifecycleConstraintV1Schema,
  type ServiceLifecycleConstraintV1,
} from "../execution/types.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

export type WorkflowEntry = {
  anchor_id: string;
  contract_trust?: ContractTrust | null;
  execution_contract_v1?: ExecutionContractV1 | null;
  anchor_level?: string | null;
  promotion_state?: string | null;
  workflow_signature?: string | null;
  task_family?: string | null;
  title?: string | null;
  summary?: string | null;
  tool_set?: string[];
  target_files?: string[];
  file_path?: string | null;
  next_action?: string | null;
  workflow_steps?: string[];
  pattern_hints?: string[];
  service_lifecycle_constraints?: Array<Record<string, unknown>>;
  authority_visibility?: RuntimeAuthorityVisibilityV1 | Record<string, unknown> | null;
  confidence?: number | null;
  feedback_quality?: number | null;
  usage_count?: number | null;
  reuse_success_count?: number | null;
  reuse_failure_count?: number | null;
  execution_outcome_role?: "passed_solution" | "failed_branch" | "blocked" | "unknown" | null;
};

function continuityCarrierToWorkflowEntry(value: unknown): WorkflowEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = firstString(record.kind, record.summary_kind, record.execution_kind);
  if (kind !== "continuity_carrier" && kind !== "handoff" && kind !== "session_event" && kind !== "session") return null;
  const executionContract = parseExecutionContract(record.execution_contract_v1);
  const targetFiles = stringList(record.target_files, 24).length > 0
    ? stringList(record.target_files, 24)
    : stringList(executionContract?.target_files, 24);
  const filePath = firstString(record.file_path, executionContract?.file_path, targetFiles[0] ?? null);
  const nextAction = firstString(record.next_action, executionContract?.next_action);
  const anchorId = firstString(record.anchor_id, record.node_id, record.id, executionContract?.provenance.source_anchor);
  if (!anchorId || (!filePath && targetFiles.length === 0 && !nextAction)) return null;
  const selectedTool = firstString(executionContract?.selected_tool, record.selected_tool);
  return {
    anchor_id: anchorId,
    contract_trust: executionContract?.contract_trust ?? "advisory",
    execution_contract_v1: executionContract,
    anchor_level: "L1",
    promotion_state: "candidate",
    workflow_signature: firstString(record.workflow_signature, executionContract?.workflow_signature),
    task_family: firstString(record.task_family, executionContract?.task_family),
    title: firstString(record.title),
    summary: firstString(record.summary, record.text_summary, nextAction),
    tool_set: selectedTool ? [selectedTool] : [],
    target_files: targetFiles,
    file_path: filePath,
    next_action: nextAction,
    workflow_steps: stringList(executionContract?.workflow_steps, 24),
    pattern_hints: stringList(executionContract?.pattern_hints, 24),
    service_lifecycle_constraints: Array.isArray(executionContract?.service_lifecycle_constraints)
      ? executionContract.service_lifecycle_constraints
      : [],
    authority_visibility: asRecord(record.authority_visibility),
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 0.48,
  };
}

function mergeWorkflowEntries(...groups: WorkflowEntry[][]): WorkflowEntry[] {
  const out: WorkflowEntry[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.anchor_id)) continue;
      seen.add(entry.anchor_id);
      out.push(entry);
    }
  }
  return out;
}

const ACTION_RETRIEVAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

type RankedWorkflow = {
  kind: "recommended_workflow" | "candidate_workflow";
  workflow: WorkflowEntry;
  score: number;
  overlap: number;
  tool_aligned: boolean;
  family_match: boolean;
  relevant: boolean;
  surface_risk_reasons: string[];
};

type PathRecommendationLike = ActionRetrievalResponse["path"];

export type PolicyHintEntryLike = {
  anchor_id: string;
  contract_trust?: ContractTrust | null;
  execution_contract_v1?: ExecutionContractV1 | null;
  anchor_level?: string | null;
  summary?: string | null;
  confidence?: number | null;
  selected_tool?: string | null;
  task_family?: string | null;
  workflow_signature?: string | null;
  file_path?: string | null;
  target_files?: string[];
  mode?: string | null;
};

export type PersistedPolicyMemory = {
  node_id: string;
  score: number;
  contract: PolicyContract;
  execution_contract: ExecutionContractV1;
  derived_policy: DerivedPolicySurface | null;
};

type RankedTrustedPattern = {
  entry: PolicyHintEntryLike;
  score: number;
  overlap: number;
  tool_aligned: boolean;
  family_match: boolean;
  relevant: boolean;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringList(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = typeof item === "string" ? item.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

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

export function workflowEvidenceParts(workflow: WorkflowEntry): string[] {
  const usageCount = Math.max(0, Number(workflow.usage_count ?? 0));
  const reuseSuccessCount = Math.max(0, Number(workflow.reuse_success_count ?? 0));
  const reuseFailureCount = Math.max(0, Number(workflow.reuse_failure_count ?? 0));
  const feedbackQuality = numeric(workflow.feedback_quality);
  const authorityState = authorityConsumptionStateFromValue(workflow);
  const authorityBlocker = authorityState.requires_inspection ? authorityState.primary_blocker : null;
  return [
    usageCount > 0 ? `usage_count=${usageCount}` : null,
    reuseSuccessCount > 0 ? `reuse_success=${reuseSuccessCount}` : null,
    reuseFailureCount > 0 ? `reuse_failure=${reuseFailureCount}` : null,
    feedbackQuality != null ? `feedback_quality=${feedbackQuality.toFixed(2)}` : null,
    workflow.contract_trust ? `contract_trust=${workflow.contract_trust}` : null,
    authorityBlocker ? `authority_blocked=${authorityBlocker}` : null,
  ].filter((value): value is string => !!value);
}

export function isStableWorkflowEntry(workflow: WorkflowEntry | null | undefined): boolean {
  if (!workflow) return false;
  const promotionState = firstString(workflow.promotion_state);
  if (promotionState === "candidate") return false;
  if (promotionState === "stable") return true;
  return firstString(workflow.anchor_level) === "L2";
}

function demoteCandidateWorkflowTrust(trust: ContractTrust | null): ContractTrust {
  return trust === "observational" ? "observational" : "advisory";
}

function buildCandidateWorkflowInspectionNextAction(args: {
  selectedTool: string | null;
  filePath: string | null;
  nextAction: string | null;
}): string {
  const target = args.filePath ? ` around ${args.filePath}` : "";
  const tool = args.selectedTool ? ` with ${args.selectedTool}` : "";
  const prior = args.nextAction ? ` Candidate prior next action: ${args.nextAction}` : "";
  return `Inspect or rehydrate the candidate workflow${target}${tool} before reuse; do not treat it as a stable workflow yet.${prior}`;
}

function firstContractTrust(...values: unknown[]): ContractTrust | null {
  for (const value of values) {
    if (value === "authoritative" || value === "advisory" || value === "observational") return value;
  }
  return null;
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !ACTION_RETRIEVAL_STOPWORDS.has(part));
}

function workflowActionSurfaceRisk(workflow: WorkflowEntry): {
  penalty: number;
  reasons: string[];
} {
  const title = firstString(workflow.title) ?? "";
  const summary = firstString(workflow.summary) ?? "";
  const nextAction = firstString(workflow.next_action) ?? "";
  const joined = `${title}\n${summary}\n${nextAction}`.toLowerCase();
  const summaryText = `${title}\n${summary}`.toLowerCase();
  const nextActionText = nextAction.toLowerCase();
  const reasons: string[] = [];
  let penalty = 0;

  if (/\b(stale|obsolete|superseded|deprecated)\b/.test(joined)) {
    reasons.push("stale_or_obsolete_surface");
    penalty += 90;
  }
  if (/\b(older|previous|prior)\b.+\b(should not|do not|must not|no longer)\b/.test(joined)) {
    reasons.push("self_disclaimed_prior_surface");
    penalty += 70;
  }
  if (/\b(does not|doesn't|cannot|can't)\s+(name|identify|provide|contain)\b.+\b(target|file|path)\b/.test(summaryText)) {
    reasons.push("target_surface_disclaimed");
    penalty += 80;
  }
  if (/\b(no|missing|unknown)\s+(current\s+)?(target|file|path)\b/.test(summaryText)) {
    reasons.push("target_surface_absent");
    penalty += 60;
  }
  if (/\bonly if\b|\bunless\b|\bfallback\b|\bif\b.+\b(absent|missing|unavailable|fails|failed)\b/.test(nextActionText)) {
    reasons.push("conditional_fallback_next_action");
    penalty += 75;
  }

  return {
    penalty,
    reasons,
  };
}

function buildCueTokens(queryText: string, context: unknown): Set<string> {
  const ctx = asRecord(context);
  const executionContract = resolveContextExecutionContract(context);
  const task = asRecord(ctx?.task);
  const error = asRecord(ctx?.error);
  const serviceLifecycleHints = (executionContract?.service_lifecycle_constraints ?? []).flatMap((entry) => {
    return [
      firstString(entry.label),
      firstString(entry.endpoint),
      firstString(entry.launch_reference),
      ...stringList(entry.health_checks, 8),
      ...stringList(entry.teardown_notes, 8),
    ];
  });
  const values = [
    queryText,
    firstString(ctx?.task_kind),
    firstString(ctx?.task_family, executionContract?.task_family),
    firstString(ctx?.runtime_tool_profile),
    firstString(ctx?.runtime_preferred_tool),
    firstString(ctx?.goal),
    firstString(ctx?.objective),
    firstString(task?.signature),
    firstString(task?.family),
    firstString(task?.goal),
    firstString(task?.objective),
    firstString(error?.signature),
    firstString(error?.code),
    executionContract?.task_signature,
    executionContract?.task_family,
    executionContract?.workflow_signature,
    executionContract?.next_action,
    executionContract?.file_path,
    executionContract?.selected_tool,
    executionContract?.target_files.join(" "),
    executionContract?.workflow_steps.join(" "),
    executionContract?.pattern_hints.join(" "),
    executionContract?.outcome.acceptance_checks.join(" "),
    executionContract?.outcome.success_invariants.join(" "),
    executionContract?.outcome.dependency_requirements.join(" "),
    executionContract?.outcome.environment_assumptions.join(" "),
    executionContract?.outcome.external_visibility_requirements.join(" "),
    executionContract?.outcome.must_hold_after_exit.join(" "),
    ...serviceLifecycleHints,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return new Set(values.flatMap((value) => normalizeTokens(value)));
}

function resolveTaskFamilyFromContext(context: unknown): string | null {
  const ctx = asRecord(context);
  const executionContract = resolveContextExecutionContract(context);
  const task = asRecord(ctx?.task);
  const workflow = asRecord(ctx?.workflow);
  const execution = asRecord(ctx?.execution);
  return firstString(
    executionContract?.task_family,
    ctx?.task_family,
    task?.family,
    workflow?.task_family,
    execution?.task_family,
    ctx?.task_kind,
  );
}

function mergeExecutionContractCandidate(
  current: ExecutionContractV1 | null,
  candidate: ExecutionContractV1 | null,
  preference: "existing" | "incoming" = "incoming",
): ExecutionContractV1 | null {
  if (!candidate) return current;
  return current
    ? mergeExecutionContractsWithActionSurface({ existing: current, incoming: candidate, preference })
    : candidate;
}

function resolveContextExecutionContract(context: unknown): ExecutionContractV1 | null {
  const ctx = asRecord(context);
  if (!ctx) return null;
  if (!hasExecutionContractSurfaceSignal(ctx)) return null;
  return deriveExecutionContractFromSlots({
    slots: ctx,
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "action_retrieval_context_v1",
      notes: ["action_retrieval:context_resolution"],
    },
  });
}

function buildExecutionContractFromPersistedPolicyMemory(args: {
  nodeId: string;
  contract: PolicyContract;
  derivedPolicy: DerivedPolicySurface | null;
}): ExecutionContractV1 {
  return buildExecutionContractFromProjection({
    contract_trust: args.contract.contract_trust ?? args.derivedPolicy?.contract_trust ?? null,
    task_family: args.contract.task_family ?? args.derivedPolicy?.task_family ?? null,
    workflow_signature: args.contract.workflow_signature ?? args.derivedPolicy?.workflow_signature ?? null,
    policy_memory_id: args.nodeId,
    selected_tool: args.contract.selected_tool,
    file_path: args.contract.file_path,
    target_files: args.contract.target_files,
    next_action: args.contract.next_action,
    workflow_steps: args.contract.workflow_steps,
    pattern_hints: args.contract.pattern_hints,
    service_lifecycle_constraints: args.contract.service_lifecycle_constraints,
    acceptance_checks: args.contract.acceptance_checks,
    success_invariants: args.contract.success_invariants,
    dependency_requirements: args.contract.dependency_requirements,
    environment_assumptions: args.contract.environment_assumptions,
    must_hold_after_exit: args.contract.must_hold_after_exit,
    external_visibility_requirements: args.contract.external_visibility_requirements,
    provenance: {
      source_kind: "policy_contract",
      source_summary_version: args.contract.summary_version,
      source_anchor: args.nodeId,
      evidence_refs: args.contract.source_anchor_ids,
      notes: [args.contract.reason],
    },
  });
}

function buildExecutionContractFromWorkflowEntry(args: {
  workflow: WorkflowEntry;
  selectedTool: string | null;
  sourceKind: "workflow_projection" | "action_retrieval";
  summaryVersion: string;
  reuseBoundary?: "stable" | "candidate";
}): ExecutionContractV1 {
  const authorityState = authorityConsumptionStateFromValue(args.workflow);
  const workflowFilePath = firstString(args.workflow.file_path, args.workflow.target_files?.[0] ?? null);
  const candidateBoundary = args.reuseBoundary === "candidate" || !isStableWorkflowEntry(args.workflow);
  const rawContractTrust = demoteContractTrustForAuthorityVisibility(
    args.workflow.contract_trust ?? null,
    authorityState.visibility,
  );
  const projected = buildExecutionContractFromProjection({
    contract_trust: candidateBoundary ? demoteCandidateWorkflowTrust(rawContractTrust) : rawContractTrust,
    task_family: args.workflow.task_family ?? null,
    workflow_signature: args.workflow.workflow_signature ?? null,
    selected_tool: args.selectedTool ?? null,
    file_path: args.workflow.file_path ?? null,
    target_files: args.workflow.target_files ?? [],
    next_action: candidateBoundary
      ? buildCandidateWorkflowInspectionNextAction({
          selectedTool: args.selectedTool,
          filePath: workflowFilePath,
          nextAction: args.workflow.next_action ?? null,
        })
      : authorityState.requires_inspection
        ? buildAuthorityInspectionNextAction({
            selectedTool: args.selectedTool,
            filePath: workflowFilePath,
            nextAction: args.workflow.next_action ?? null,
            blocker: authorityState.primary_blocker,
            reuseTarget: "the learned workflow",
          })
        : args.workflow.next_action ?? null,
    workflow_steps: candidateBoundary ? [] : args.workflow.workflow_steps ?? [],
    pattern_hints: candidateBoundary ? [] : args.workflow.pattern_hints ?? [],
    service_lifecycle_constraints: candidateBoundary ? [] : args.workflow.service_lifecycle_constraints ?? [],
    provenance: {
      source_kind: args.sourceKind,
      source_summary_version: args.summaryVersion,
      source_anchor: args.workflow.anchor_id,
      evidence_refs: [args.workflow.anchor_id],
      notes: [
        candidateBoundary
          ? "candidate workflow boundary: inspect or rehydrate before reuse"
          : args.workflow.summary ?? args.workflow.title ?? "workflow memory projection",
      ],
    },
  });
  if (candidateBoundary) return projected;
  const existing = parseExecutionContract(args.workflow.execution_contract_v1);
  const merged = existing
    ? mergeExecutionContractsWithActionSurface({ existing, incoming: projected, preference: "existing" })
    : projected;
  return demoteExecutionContractForAuthorityVisibility({
    contract: merged,
    visibility: authorityState.visibility,
    selectedTool: args.selectedTool,
    filePath: workflowFilePath,
    reuseTarget: "the learned workflow",
  });
}

function buildExecutionContractFromPathRecommendation(args: {
  path: PathRecommendationLike;
  selectedTool: string | null;
}): ExecutionContractV1 | null {
  const pathRecord = args.path as Record<string, unknown>;
  const workflowSteps = Array.isArray(pathRecord.workflow_steps) ? pathRecord.workflow_steps : [];
  const patternHints = Array.isArray(pathRecord.pattern_hints) ? pathRecord.pattern_hints : [];
  const serviceLifecycleConstraints = Array.isArray(pathRecord.service_lifecycle_constraints)
    ? pathRecord.service_lifecycle_constraints
    : [];
  const taskFamily = firstString(pathRecord.task_family);
  const hasSignal = Boolean(
    args.path.anchor_id
    || taskFamily
    || args.path.workflow_signature
    || args.path.file_path
    || args.path.target_files.length > 0
    || args.path.next_action
    || workflowSteps.length > 0
    || patternHints.length > 0
    || serviceLifecycleConstraints.length > 0,
  );
  if (!hasSignal) return null;
  return buildExecutionContractFromProjection({
    contract_trust: firstContractTrust(pathRecord.contract_trust),
    task_family: taskFamily,
    workflow_signature: args.path.workflow_signature,
    selected_tool: args.selectedTool,
    file_path: args.path.file_path,
    target_files: args.path.target_files,
    next_action: args.path.next_action,
    workflow_steps: workflowSteps,
    pattern_hints: patternHints,
    service_lifecycle_constraints: serviceLifecycleConstraints,
    provenance: {
      source_kind: "action_retrieval",
      source_summary_version: "action_retrieval_v1",
      source_anchor: args.path.anchor_id,
      evidence_refs: args.path.anchor_id ? [args.path.anchor_id] : [],
      notes: [firstString(args.path.reason) ?? "path recommendation projection"],
    },
  });
}

function buildExecutionContractFromToolSelection(selectedTool: string | null): ExecutionContractV1 | null {
  if (!selectedTool) return null;
  return buildExecutionContractFromProjection({
    selected_tool: selectedTool,
    provenance: {
      source_kind: "action_retrieval",
      source_summary_version: "action_retrieval_v1",
      notes: ["tool_selection_only"],
    },
  });
}

function buildExecutionContractFromPersistedPolicyEntry(args: {
  entry: Record<string, unknown>;
  nodeId: string;
  contract: PolicyContract;
  derivedPolicy: DerivedPolicySurface | null;
}): ExecutionContractV1 {
  const projected = buildExecutionContractFromPersistedPolicyMemory({
    nodeId: args.nodeId,
    contract: args.contract,
    derivedPolicy: args.derivedPolicy,
  });
  const existing = parseExecutionContract(args.entry.execution_contract_v1);
  return existing
    ? mergeExecutionContractsWithActionSurface({ existing, incoming: projected, preference: "existing" })
    : projected;
}

function parsePersistedPolicyContract(value: unknown, nodeId: string): PolicyContract | null {
  const parsed = PolicyContractSchema.safeParse({
    ...(asRecord(value) ?? {}),
    policy_memory_state: firstString(asRecord(value)?.policy_memory_state) ?? "active",
    materialization_state: "persisted",
    policy_memory_id: nodeId,
  });
  return parsed.success ? parsed.data : null;
}

function parsePersistedDerivedPolicy(value: unknown): DerivedPolicySurface | null {
  const parsed = DerivedPolicySurfaceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readPersistedPolicyMemory(args: {
  introspection: ExecutionMemoryIntrospectionResponse;
  queryText: string;
  context: unknown;
  selectedTool: string | null;
  path: PathRecommendationLike;
  preferredPattern: PolicyHintEntryLike | null;
  selectedWorkflow: WorkflowEntry | null;
}): PersistedPolicyMemory | null {
  const supportingKnowledge = Array.isArray(args.introspection.supporting_knowledge)
    ? args.introspection.supporting_knowledge
    : [];
  if (supportingKnowledge.length === 0) return null;

  const cueTokens = buildCueTokens(args.queryText, args.context);
  const ctx = asRecord(args.context);
  const contextExecutionContract = resolveContextExecutionContract(args.context);
  const workflow = asRecord(ctx?.workflow);
  const task = asRecord(ctx?.task);
  const error = asRecord(ctx?.error);
  const currentWorkflowSignature = firstString(
    contextExecutionContract?.workflow_signature,
    args.path.workflow_signature,
    workflow?.signature,
    args.selectedWorkflow?.workflow_signature,
    args.preferredPattern?.workflow_signature,
  );
  const currentFilePath = firstString(
    contextExecutionContract?.file_path,
    args.path.file_path,
    ctx?.file_path,
    args.selectedWorkflow?.file_path,
    args.preferredPattern?.file_path,
  );
  const currentTargetFiles = new Set(
    [
      ...(contextExecutionContract?.target_files ?? []),
      ...args.path.target_files,
      ...(args.selectedWorkflow?.target_files ?? []),
      ...(args.preferredPattern?.target_files ?? []),
      ...stringList(ctx?.target_files, 24),
      contextExecutionContract?.file_path ?? "",
      currentFilePath ?? "",
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const supportingAnchorIds = new Set(
    [
      args.path.anchor_id ?? "",
      args.selectedWorkflow?.anchor_id ?? "",
      args.preferredPattern?.anchor_id ?? "",
    ].filter((value) => value.length > 0),
  );
  const currentTaskSignature = firstString(contextExecutionContract?.task_signature, ctx?.task_signature, task?.signature);
  const currentErrorSignature = firstString(ctx?.error_signature, error?.signature, error?.code);
  const currentTaskFamily = firstString(contextExecutionContract?.task_family, resolveTaskFamilyFromContext(args.context));

  let best: PersistedPolicyMemory | null = null;
  for (const rawEntry of supportingKnowledge) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    if (firstString(entry.kind, entry.summary_kind) !== "policy_memory" && !asRecord(entry.policy_contract_v1)) continue;
    const nodeId = firstString(entry.node_id, entry.anchor_id, entry.policy_memory_id);
    if (!nodeId) continue;
    const contract = parsePersistedPolicyContract(entry.policy_contract_v1, nodeId);
    if (!contract || contract.policy_memory_state !== "active") continue;
    const derivedPolicy = parsePersistedDerivedPolicy(entry.derived_policy_v1);
    const executionContract = buildExecutionContractFromPersistedPolicyEntry({
      entry,
      nodeId,
      contract,
      derivedPolicy,
    });
    if (authorityConsumptionStateFromValue(entry).requires_inspection) continue;
    const outcomeContractGate = buildOutcomeContractGate({
      executionContract,
      requestedTrust: firstContractTrust(contract.contract_trust, executionContract.contract_trust),
    });
    if (!outcomeContractGate.allows_authoritative) continue;
    const entryWorkflowSignature = firstString(executionContract.workflow_signature, entry.workflow_signature);
    const entryTaskFamily = firstString(executionContract.task_family, derivedPolicy?.task_family, entry.task_family);
    const entryFilePath = firstString(executionContract.file_path, entry.file_path);
    const entryTaskSignature = firstString(entry.task_signature);
    const entryErrorSignature = firstString(entry.error_signature);
    const entryTargetFiles = new Set(
      [
        ...executionContract.target_files,
        ...stringList(entry.target_files, 24),
        entryFilePath ?? "",
      ].filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const textValues = [
      firstString(entry.title),
      firstString(entry.summary),
      entryWorkflowSignature,
      entryFilePath,
      entryTaskSignature,
      entryErrorSignature,
      entryTaskFamily,
      ...Array.from(entryTargetFiles),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const textTokens = new Set(textValues.flatMap((value) => normalizeTokens(value)));

    let overlap = 0;
    for (const token of cueTokens) {
      if (textTokens.has(token)) overlap += 1;
    }

    let score = 0;
    if (args.selectedTool && executionContract.selected_tool === args.selectedTool) score += 90;
    else if (args.selectedTool) score -= 40;
    if (currentWorkflowSignature && entryWorkflowSignature === currentWorkflowSignature) score += 70;
    if (currentTaskFamily && entryTaskFamily === currentTaskFamily) score += 55;
    if (currentFilePath && entryFilePath === currentFilePath) score += 50;
    if (currentTaskSignature && entryTaskSignature === currentTaskSignature) score += 35;
    if (currentErrorSignature && entryErrorSignature === currentErrorSignature) score += 25;
    if (Array.from(entryTargetFiles).some((value) => currentTargetFiles.has(value))) score += 40;
    if (
      contract.source_anchor_ids.some((anchorId) => supportingAnchorIds.has(anchorId))
      || executionContract.provenance.evidence_refs.some((anchorId) => supportingAnchorIds.has(anchorId))
      || (executionContract.provenance.source_anchor != null && supportingAnchorIds.has(executionContract.provenance.source_anchor))
    ) {
      score += 30;
    }
    if (contract.activation_mode === "default") score += 20;
    if (contract.policy_state === "stable") score += 15;
    score += overlap * 10;
    score += Math.round(contract.confidence * 10);

    if (!best || score > best.score) {
      best = {
        node_id: nodeId,
        score,
        contract,
        execution_contract: executionContract,
        derived_policy: derivedPolicy,
      };
    }
  }

  if (!best || best.score < 90) return null;
  return best;
}

function scoreWorkflow(args: {
  workflow: WorkflowEntry;
  kind: "recommended_workflow" | "candidate_workflow";
  selectedTool: string | null;
  cueTokens: Set<string>;
  currentTaskFamily: string | null;
}): RankedWorkflow {
  const toolSet = Array.isArray(args.workflow.tool_set) ? args.workflow.tool_set : [];
  const targetFiles = Array.isArray(args.workflow.target_files) ? args.workflow.target_files : [];
  const textTokens = new Set(
    [
      args.workflow.title ?? "",
      args.workflow.summary ?? "",
      args.workflow.workflow_signature ?? "",
      args.workflow.task_family ?? "",
      args.workflow.file_path ?? "",
      ...(targetFiles ?? []),
      args.workflow.next_action ?? "",
      ...toolSet,
    ].flatMap((value) => normalizeTokens(value)),
  );
  let overlap = 0;
  for (const token of args.cueTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  const workflowTaskFamily = firstString(args.workflow.task_family);
  const familyMatch = !!args.currentTaskFamily && workflowTaskFamily === args.currentTaskFamily;
  const toolAligned = !!args.selectedTool && toolSet.includes(args.selectedTool);
  const usageCount = Math.max(0, Number(args.workflow.usage_count ?? 0));
  const reuseSuccessCount = Math.max(0, Number(args.workflow.reuse_success_count ?? 0));
  const reuseFailureCount = Math.max(0, Number(args.workflow.reuse_failure_count ?? 0));
  const feedbackQuality = Number.isFinite(Number(args.workflow.feedback_quality))
    ? Math.max(-1, Math.min(1, Number(args.workflow.feedback_quality)))
    : 0;
  const contractTrust = firstContractTrust(args.workflow.contract_trust);
  const authorityState = authorityConsumptionStateFromValue(args.workflow);
  const surfaceRisk = workflowActionSurfaceRisk(args.workflow);
  let score = args.kind === "recommended_workflow" ? 200 : 120;
  if (toolAligned) score += 60;
  if (familyMatch) score += 55;
  if (targetFiles.length > 0) score += 35;
  if (args.workflow.file_path) score += 20;
  if (args.workflow.next_action) score += 15;
  if (Number.isFinite(args.workflow.confidence)) score += Math.round((args.workflow.confidence ?? 0) * 10);
  score += Math.min(usageCount, 8) * 3;
  score += Math.min(reuseSuccessCount, 6) * 10;
  score -= Math.min(reuseFailureCount, 4) * 14;
  score += Math.round(feedbackQuality * 18);
  if (contractTrust === "authoritative") score += 18;
  else if (contractTrust === "advisory") score -= 10;
  else if (contractTrust === "observational") score -= 72;
  else score -= 24;
  if (authorityState.requires_inspection) score -= 95;
  score += overlap * 12;
  score -= surfaceRisk.penalty;
  return {
    kind: args.kind,
    workflow: args.workflow,
    score,
    overlap,
    tool_aligned: toolAligned,
    family_match: familyMatch,
    relevant: overlap > 0 || familyMatch,
    surface_risk_reasons: surfaceRisk.reasons,
  };
}

export function choosePathRecommendation(args: {
  queryText: string;
  context: unknown;
  selectedTool: string | null;
  recommendedWorkflows: WorkflowEntry[];
  candidateWorkflows: WorkflowEntry[];
}) {
  const cueTokens = buildCueTokens(args.queryText, args.context);
  const currentTaskFamily = resolveTaskFamilyFromContext(args.context);
  const ranked = [
    ...args.recommendedWorkflows.map((workflow) =>
      scoreWorkflow({
        workflow,
        kind: "recommended_workflow",
        selectedTool: args.selectedTool,
        cueTokens,
        currentTaskFamily,
      })),
    ...args.candidateWorkflows.map((workflow) =>
      scoreWorkflow({
        workflow,
        kind: "candidate_workflow",
        selectedTool: args.selectedTool,
        cueTokens,
        currentTaskFamily,
      })),
  ].sort((a, b) => b.score - a.score || a.workflow.anchor_id.localeCompare(b.workflow.anchor_id));

  const top = ranked.find((entry) => entry.relevant) ?? null;
  if (!top) {
    return {
      source_kind: "none" as const,
      anchor_id: null,
      contract_trust: null,
      workflow_signature: null,
      title: null,
      summary: null,
      file_path: null,
      target_files: [],
      next_action: null,
      workflow_steps: [],
      pattern_hints: [],
      service_lifecycle_constraints: [],
      confidence: null,
      tool_set: [],
      authority_visibility: null,
      authority_blocked: false,
      authority_primary_blocker: null,
      reason: null,
    };
  }

  const targetFiles = stringList(top.workflow.target_files);
  const filePath = firstString(top.workflow.file_path, targetFiles[0] ?? null);
  const summary = firstString(top.workflow.summary);
  const title = firstString(top.workflow.title);
  const authorityState = authorityConsumptionStateFromValue(top.workflow);
  const rawContractTrust = firstContractTrust(top.workflow.contract_trust);
  const demotedTrust = demoteContractTrustForAuthorityVisibility(rawContractTrust, authorityState.visibility);
  const candidateBoundary = top.kind === "candidate_workflow";
  const contractTrust = candidateBoundary ? demoteCandidateWorkflowTrust(demotedTrust) : demotedTrust;
  const rawNextAction = firstString(
    top.workflow.next_action,
    filePath && args.selectedTool ? `Use ${args.selectedTool} on ${filePath} and continue along the learned workflow.` : null,
    filePath ? `Continue with ${filePath} as the next working target.` : null,
  );
  const nextAction = candidateBoundary
    ? buildCandidateWorkflowInspectionNextAction({
        selectedTool: args.selectedTool,
        filePath,
        nextAction: rawNextAction,
      })
    : authorityState.requires_inspection
      ? buildAuthorityInspectionNextAction({
          selectedTool: args.selectedTool,
          filePath,
          nextAction: rawNextAction,
          blocker: authorityState.primary_blocker,
          reuseTarget: "the learned workflow",
        })
      : rawNextAction;

  return {
    source_kind: top.kind,
    anchor_id: top.workflow.anchor_id,
    contract_trust: contractTrust,
    task_family: firstString(top.workflow.task_family),
    workflow_signature: firstString(top.workflow.workflow_signature),
    title,
    summary,
    file_path: filePath,
    target_files: targetFiles,
    next_action: nextAction,
    workflow_steps: candidateBoundary ? [] : stringList(top.workflow.workflow_steps, 24),
    pattern_hints: candidateBoundary ? [] : stringList(top.workflow.pattern_hints, 24),
    service_lifecycle_constraints: candidateBoundary ? [] : normalizeServiceLifecycleConstraints(top.workflow.service_lifecycle_constraints),
    confidence: Number.isFinite(top.workflow.confidence) ? (top.workflow.confidence ?? null) : null,
    tool_set: stringList(top.workflow.tool_set),
    authority_visibility: authorityState.visibility,
    authority_blocked: authorityState.requires_inspection,
    authority_primary_blocker: authorityState.primary_blocker,
    reason: [
      top.kind === "recommended_workflow"
        ? "stable workflow memory matched this request"
        : "candidate workflow memory matched this request; inspect or rehydrate before reuse",
      top.tool_aligned && args.selectedTool ? `tool alignment=${args.selectedTool}` : null,
      top.family_match && currentTaskFamily ? `task_family=${currentTaskFamily}` : null,
      top.overlap > 0 ? `token_overlap=${top.overlap}` : null,
      ...workflowEvidenceParts(top.workflow),
      ...top.surface_risk_reasons.map((reason) => `surface_risk=${reason}`),
      authorityState.requires_inspection ? "requires_inspection_before_reuse" : null,
      targetFiles.length > 0 ? `targets=${targetFiles.join(", ")}` : null,
      summary ? `summary=${summary}` : null,
    ].filter(Boolean).join("; "),
  };
}

export function toPolicyHintEntry(value: unknown): PolicyHintEntryLike | null {
  const record = asRecord(value);
  const anchorId = firstString(record?.anchor_id);
  if (!anchorId) return null;
  const executionContract = parseExecutionContract(record?.execution_contract_v1);
  const targetFiles = stringList(record?.target_files, 24);
  return {
    anchor_id: anchorId,
    contract_trust: firstContractTrust(executionContract?.contract_trust, record?.contract_trust),
    execution_contract_v1: executionContract,
    anchor_level: firstString(record?.anchor_level),
    summary: firstString(record?.summary),
    confidence: Number.isFinite(Number(record?.confidence)) ? Number(record?.confidence) : null,
    selected_tool: firstString(record?.selected_tool, executionContract?.selected_tool),
    task_family: firstString(record?.task_family, executionContract?.task_family),
    workflow_signature: firstString(record?.workflow_signature, executionContract?.workflow_signature),
    file_path: firstString(record?.file_path, executionContract?.file_path),
    target_files: targetFiles.length > 0 ? targetFiles : stringList(executionContract?.target_files, 24),
    mode: firstString(record?.mode, record?.rehydration_default_mode),
  };
}

function scoreTrustedPattern(args: {
  entry: PolicyHintEntryLike;
  selectedTool: string | null;
  cueTokens: Set<string>;
  currentTaskFamily: string | null;
}): RankedTrustedPattern {
  const executionContract = parseExecutionContract(args.entry.execution_contract_v1);
  const targetFiles = args.entry.target_files && args.entry.target_files.length > 0
    ? args.entry.target_files
    : stringList(executionContract?.target_files, 24);
  const textTokens = new Set(
    [
      args.entry.summary ?? "",
      firstString(args.entry.task_family, executionContract?.task_family) ?? "",
      firstString(args.entry.workflow_signature, executionContract?.workflow_signature) ?? "",
      firstString(args.entry.file_path, executionContract?.file_path) ?? "",
      firstString(args.entry.selected_tool, executionContract?.selected_tool) ?? "",
      executionContract?.next_action ?? "",
      executionContract?.workflow_steps.join(" ") ?? "",
      executionContract?.pattern_hints.join(" ") ?? "",
      executionContract?.outcome.acceptance_checks.join(" ") ?? "",
      executionContract?.outcome.success_invariants.join(" ") ?? "",
      ...targetFiles,
    ].flatMap((value) => normalizeTokens(value)),
  );
  let overlap = 0;
  for (const token of args.cueTokens) {
    if (textTokens.has(token)) overlap += 1;
  }

  const entrySelectedTool = firstString(args.entry.selected_tool, executionContract?.selected_tool);
  const entryTaskFamily = firstString(args.entry.task_family, executionContract?.task_family);
  const toolAligned = !args.selectedTool || entrySelectedTool === args.selectedTool;
  const familyMatch = !!args.currentTaskFamily && entryTaskFamily === args.currentTaskFamily;
  const confidence = numeric(args.entry.confidence) ?? 0;
  const contractTrust = firstContractTrust(args.entry.contract_trust, executionContract?.contract_trust);
  let score = 0;
  if (args.selectedTool && toolAligned) score += 90;
  else if (args.selectedTool) score -= 100;
  if (familyMatch) score += 55;
  if (targetFiles.length > 0) score += 20;
  if (args.entry.file_path || executionContract?.file_path) score += 12;
  if (contractTrust === "authoritative") score += 16;
  else if (contractTrust === "advisory") score -= 6;
  else if (contractTrust === "observational") score -= 40;
  score += overlap * 12;
  score += Math.round(confidence * 10);

  return {
    entry: args.entry,
    score,
    overlap,
    tool_aligned: toolAligned,
    family_match: familyMatch,
    relevant: toolAligned && (overlap > 0 || familyMatch),
  };
}

export function choosePreferredTrustedPattern(args: {
  trustedPatterns: PolicyHintEntryLike[];
  selectedTool: string | null;
  queryText: string;
  context: unknown;
}): PolicyHintEntryLike | null {
  if (args.trustedPatterns.length === 0) return null;
  const cueTokens = buildCueTokens(args.queryText, args.context);
  const currentTaskFamily = resolveTaskFamilyFromContext(args.context);
  const ranked = args.trustedPatterns
    .map((entry) => scoreTrustedPattern({
      entry,
      selectedTool: args.selectedTool,
      cueTokens,
      currentTaskFamily,
    }))
    .sort((a, b) => b.score - a.score || a.entry.anchor_id.localeCompare(b.entry.anchor_id));
  return ranked.find((entry) => entry.relevant)?.entry ?? null;
}

export function findSelectedWorkflow(args: {
  introspection: ExecutionMemoryIntrospectionResponse;
  path: Pick<PathRecommendationLike, "anchor_id">;
}): WorkflowEntry | null {
  const recommendedWorkflows =
    (Array.isArray(args.introspection.recommended_workflows) ? args.introspection.recommended_workflows : []) as WorkflowEntry[];
  const candidateWorkflows =
    (Array.isArray(args.introspection.candidate_workflows) ? args.introspection.candidate_workflows : []) as WorkflowEntry[];
  return args.path.anchor_id
    ? [...recommendedWorkflows, ...candidateWorkflows].find((entry) => entry.anchor_id === args.path.anchor_id) ?? null
    : null;
}

export function workflowToolPreferenceState(args: {
  workflow: WorkflowEntry | null;
  selectedTool: string | null;
}): "none" | "candidate" | "stable" {
  const selectedTool = firstString(args.selectedTool);
  if (!selectedTool || !args.workflow) return "none";
  if (authorityConsumptionStateFromValue(args.workflow).requires_inspection) return "none";
  const toolSet = stringList(args.workflow.tool_set, 24);
  if (!toolSet.includes(selectedTool)) return "none";
  const contractTrust = firstContractTrust(args.workflow.contract_trust);
  if (contractTrust === "observational" || contractTrust === null) return "none";
  if (isStableWorkflowEntry(args.workflow)) {
    return contractTrust === "advisory" ? "candidate" : "stable";
  }
  const usageCount = Math.max(0, Number(args.workflow.usage_count ?? 0));
  const reuseSuccessCount = Math.max(0, Number(args.workflow.reuse_success_count ?? 0));
  const reuseFailureCount = Math.max(0, Number(args.workflow.reuse_failure_count ?? 0));
  const feedbackQuality = numeric(args.workflow.feedback_quality) ?? 0;
  if (reuseFailureCount > reuseSuccessCount && feedbackQuality < 0) return "none";
  if (
    reuseSuccessCount >= 2
    || (reuseSuccessCount >= 1 && feedbackQuality >= 0.35)
    || (usageCount >= 3 && feedbackQuality >= 0)
  ) {
    return "candidate";
  }
  if (reuseSuccessCount >= 1 || usageCount >= 2 || feedbackQuality > 0) {
    return "candidate";
  }
  return "none";
}

export function supportsWorkflowToolPreference(args: {
  workflow: WorkflowEntry | null;
  selectedTool: string | null;
}): boolean {
  return workflowToolPreferenceState(args) !== "none";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function buildActionRetrievalUncertainty(args: {
  selectedTool: string | null;
  path: PathRecommendationLike;
  preferredPattern: PolicyHintEntryLike | null;
  selectedWorkflow: WorkflowEntry | null;
  contestedPatterns: PolicyHintEntryLike[];
  rehydrationCandidates: PolicyHintEntryLike[];
  persistedPolicy: PersistedPolicyMemory | null;
}): ActionRetrievalResponse["uncertainty"] {
  const reasons: string[] = [];
  const recommendedActions = new Set<"proceed" | "widen_recall" | "rehydrate_payload" | "inspect_context" | "request_operator_review">();
  const contestedSelected = !!args.selectedTool
    && args.contestedPatterns.some((entry) => entry.selected_tool === args.selectedTool);
  const pathAuthorityState = authorityConsumptionStateFromValue(args.path);
  const workflowAuthorityState = authorityConsumptionStateFromValue(args.selectedWorkflow);
  const authorityState =
    pathAuthorityState.visibility || pathAuthorityState.requires_inspection
      ? pathAuthorityState
      : workflowAuthorityState;

  if (!args.selectedTool) {
    reasons.push("no tool selection was available for this request");
    recommendedActions.add("inspect_context");
  }
  if (args.path.source_kind === "none") {
    reasons.push("no learned workflow matched this request yet");
    recommendedActions.add("widen_recall");
  } else if (args.path.source_kind === "candidate_workflow") {
    reasons.push("workflow guidance is still candidate-grade and has not stabilized yet");
    recommendedActions.add("inspect_context");
  }
  if (!args.persistedPolicy && !args.preferredPattern && args.path.source_kind !== "recommended_workflow") {
    reasons.push("the recommended action is not backed by persisted policy memory or stable workflow history");
  }
  if (contestedSelected) {
    reasons.push(`selected tool ${args.selectedTool} has contested execution evidence`);
    recommendedActions.add("request_operator_review");
  }
  if (authorityState.requires_inspection) {
    reasons.push(`selected workflow authority is blocked: ${authorityState.primary_blocker ?? "unknown"}`);
    recommendedActions.add("inspect_context");
  }
  if (args.rehydrationCandidates.length > 0 && args.path.source_kind !== "recommended_workflow") {
    reasons.push("payload rehydration may be needed before taking the next step");
    recommendedActions.add("rehydrate_payload");
  }
  if (!args.path.next_action) {
    reasons.push("no concrete next action could be synthesized from the current retrieval set");
    recommendedActions.add("inspect_context");
  }

  let confidence = 0.12;
  if (args.selectedTool) confidence += 0.14;
  if (args.path.source_kind === "recommended_workflow") confidence += 0.3;
  else if (args.path.source_kind === "candidate_workflow") confidence += 0.16;
  if (args.preferredPattern?.selected_tool && args.preferredPattern.selected_tool === args.selectedTool) confidence += 0.18;
  if (args.persistedPolicy) confidence += 0.28;
  confidence += clamp01(numeric(args.path.confidence) ?? 0) * 0.12;
  if (contestedSelected) confidence -= 0.18;
  if (authorityState.requires_inspection) confidence -= 0.22;
  if (!args.selectedTool) confidence -= 0.1;
  confidence = clamp01(confidence);

  const evidenceGapCount = reasons.length;
  const level =
    confidence >= 0.78 && evidenceGapCount === 0
      ? "low"
      : confidence >= 0.48 && evidenceGapCount <= 2
        ? "moderate"
        : "high";

  if (recommendedActions.size === 0) recommendedActions.add("proceed");
  if (reasons.length === 0) {
    reasons.push("stable workflow and learned execution memory agree on the next step");
  }

  return {
    summary_version: "action_retrieval_uncertainty_v1" as const,
    level,
    confidence,
    evidence_gap_count: evidenceGapCount,
    reasons,
    recommended_actions: Array.from(recommendedActions),
  };
}

export function buildActionRetrievalResponse(args: {
  parsed: ExperienceIntelligenceInput;
  tools: ToolsSelectRouteContract;
  introspection: ExecutionMemoryIntrospectionResponse;
  trajectoryCompile?: TrajectoryCompileResponse | null;
  delegationRecommendationCount?: number;
}): ActionRetrievalResponse {
  const selectedTool = args.tools.selection.selected ?? null;
  const recommendedWorkflows = (Array.isArray(args.introspection.recommended_workflows) ? args.introspection.recommended_workflows : []) as WorkflowEntry[];
  const projectedCandidateWorkflows = (Array.isArray(args.introspection.candidate_workflows) ? args.introspection.candidate_workflows : []) as WorkflowEntry[];
  const continuityCarrierWorkflows = (Array.isArray(args.introspection.supporting_knowledge) ? args.introspection.supporting_knowledge : [])
    .map(continuityCarrierToWorkflowEntry)
    .filter((entry): entry is WorkflowEntry => entry !== null);
  const candidateWorkflows = mergeWorkflowEntries(projectedCandidateWorkflows, continuityCarrierWorkflows);
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
    queryText: args.parsed.query_text,
    context: args.parsed.context,
  });
  const path = choosePathRecommendation({
    queryText: args.parsed.query_text,
    context: args.parsed.context,
    selectedTool,
    recommendedWorkflows,
    candidateWorkflows,
  });
  const selectedWorkflow = path.anchor_id
    ? mergeWorkflowEntries(recommendedWorkflows, candidateWorkflows)
      .find((entry) => entry.anchor_id === path.anchor_id) ?? null
    : null;
  const persistedPolicy = readPersistedPolicyMemory({
    introspection: args.introspection,
    queryText: args.parsed.query_text,
    context: args.parsed.context,
    selectedTool,
    path,
    preferredPattern,
    selectedWorkflow,
  });
  const baseHistoryApplied = path.source_kind !== "none" || !!persistedPolicy || !!preferredPattern;
  const contextExecutionContract = resolveContextExecutionContract(args.parsed.context);
  const selectedWorkflowExecutionContract = selectedWorkflow
    ? buildExecutionContractFromWorkflowEntry({
        workflow: selectedWorkflow,
        selectedTool,
        sourceKind: "workflow_projection",
        summaryVersion: "action_retrieval_workflow_projection_v1",
        reuseBoundary: path.source_kind === "candidate_workflow" ? "candidate" : "stable",
      })
    : null;
  const pathExecutionContract = buildExecutionContractFromPathRecommendation({
    path,
    selectedTool,
  });
  let executionContract = contextExecutionContract;
  executionContract = mergeExecutionContractCandidate(
    executionContract,
    persistedPolicy?.execution_contract ?? null,
  );
  executionContract = mergeExecutionContractCandidate(
    executionContract,
    selectedWorkflowExecutionContract,
  );
  executionContract = mergeExecutionContractCandidate(
    executionContract,
    pathExecutionContract,
    "existing",
  );
  executionContract = mergeExecutionContractCandidate(
    executionContract,
    buildExecutionContractFromToolSelection(selectedTool),
    "existing",
  );
  const selectedWorkflowAuthorityState = authorityConsumptionStateFromValue(selectedWorkflow);
  const pathAuthorityState = authorityConsumptionStateFromValue(path);
  const effectiveWorkflowAuthorityState =
    selectedWorkflowAuthorityState.visibility || selectedWorkflowAuthorityState.requires_inspection
      ? selectedWorkflowAuthorityState
      : pathAuthorityState;
  const stableWorkflowSupportsForRetrieval = workflowToolPreferenceState({
    workflow: selectedWorkflow,
    selectedTool,
  }) === "stable";
  const workflowSupportsForRetrieval = path.source_kind === "recommended_workflow"
    && stableWorkflowSupportsForRetrieval
    && !!selectedTool
    && !effectiveWorkflowAuthorityState.requires_inspection
    && (
      stringList(selectedWorkflow?.tool_set, 24).includes(selectedTool)
      || path.tool_set.includes(selectedTool)
    );
  const patternSupports = preferredPattern?.selected_tool === selectedTool;
  const contractRecommendedFilePath = firstString(executionContract?.file_path, preferredPattern?.file_path);
  const adaptiveGuidance = buildAdaptiveGuidanceOverlay({
    parsed: args.parsed,
    introspection: args.introspection,
    selectedTool,
    selectedFilePath: contractRecommendedFilePath,
    stablePathAnchorId: path.source_kind === "recommended_workflow" ? path.anchor_id : null,
  });
  const adaptivePrimaryInstruction = firstString(
    adaptiveGuidance.adapted_instructions.find((entry) => entry.priority === "primary")?.instruction,
    adaptiveGuidance.adapted_instructions[0]?.instruction,
  );
  const adaptiveFilePath = firstString(
    adaptiveGuidance.selected_candidates[0]?.file_path,
    adaptiveGuidance.selected_candidates[0]?.target_files[0],
  );
  const recommendedFilePath = firstString(
    contractRecommendedFilePath,
    path.source_kind === "none" ? adaptiveFilePath : null,
  );
  const historyApplied = baseHistoryApplied || adaptiveGuidance.selected_candidate_count > 0;
  const adaptiveSupportsSelectedTool =
    !!selectedTool
    && adaptiveGuidance.selected_candidates.some((candidate) => candidate.selected_tool === selectedTool);
  const toolSourceKind =
    persistedPolicy
      ? "persisted_policy_memory"
      : patternSupports && workflowSupportsForRetrieval
        ? "blended"
      : patternSupports
        ? "trusted_pattern"
          : workflowSupportsForRetrieval
            ? "stable_workflow"
            : adaptiveSupportsSelectedTool
              ? "adaptive_guidance"
              : "tools_select";
  const recommendedTaskFamily = firstString(executionContract?.task_family);
  const recommendedTargetFiles = stringList(
    executionContract?.target_files && executionContract.target_files.length > 0
      ? executionContract.target_files
      : recommendedFilePath
        ? [recommendedFilePath]
        : adaptiveGuidance.selected_candidates[0]?.target_files ?? [],
    24,
  );
  const recommendedWorkflowSteps = Array.isArray(executionContract?.workflow_steps)
    && executionContract.workflow_steps.length > 0
    ? executionContract.workflow_steps
    : [];
  const recommendedPatternHints = Array.isArray(executionContract?.pattern_hints)
    && executionContract.pattern_hints.length > 0
    ? executionContract.pattern_hints
    : [];
  const recommendedServiceLifecycleConstraints = Array.isArray(executionContract?.service_lifecycle_constraints)
    && executionContract.service_lifecycle_constraints.length > 0
    ? executionContract.service_lifecycle_constraints
    : [];
  const combinedNextAction = firstString(
    executionContract?.next_action,
    path.source_kind === "none" ? adaptivePrimaryInstruction : null,
    recommendedFilePath && selectedTool ? `Use ${selectedTool} on ${recommendedFilePath} as the next learned step.` : null,
    adaptivePrimaryInstruction,
  );
  const evidenceEntries = [
    ...(persistedPolicy ? [{
      source_kind: "persisted_policy_memory" as const,
      anchor_id: persistedPolicy.node_id,
      selected_tool: persistedPolicy.execution_contract.selected_tool,
      task_family: firstString(persistedPolicy.execution_contract.task_family, persistedPolicy.derived_policy?.task_family),
      workflow_signature: persistedPolicy.execution_contract.workflow_signature,
      file_path: persistedPolicy.execution_contract.file_path,
      target_files: stringList(persistedPolicy.execution_contract.target_files, 24),
      workflow_steps: Array.isArray(persistedPolicy.execution_contract.workflow_steps)
        ? persistedPolicy.execution_contract.workflow_steps
        : [],
      pattern_hints: Array.isArray(persistedPolicy.execution_contract.pattern_hints)
        ? persistedPolicy.execution_contract.pattern_hints
        : [],
      service_lifecycle_constraints: Array.isArray(persistedPolicy.execution_contract.service_lifecycle_constraints)
        ? persistedPolicy.execution_contract.service_lifecycle_constraints
        : [],
      confidence: persistedPolicy.contract.confidence,
      reason: persistedPolicy.contract.reason,
    }] : []),
    ...(preferredPattern ? [{
      source_kind: "trusted_pattern" as const,
      anchor_id: preferredPattern.anchor_id,
      selected_tool: preferredPattern.selected_tool ?? null,
      task_family: null,
      workflow_signature: preferredPattern.workflow_signature ?? null,
      file_path: preferredPattern.file_path ?? null,
      target_files: preferredPattern.target_files ?? [],
      confidence: preferredPattern.confidence ?? null,
      reason: preferredPattern.summary ?? `trusted pattern memory supports ${preferredPattern.selected_tool ?? "the selected tool"}`,
    }] : []),
    ...(path.anchor_id ? [{
      source_kind: path.source_kind === "recommended_workflow" ? "stable_workflow" as const : "candidate_workflow" as const,
      anchor_id: path.anchor_id,
      selected_tool: pathExecutionContract?.selected_tool ?? selectedTool,
      task_family: pathExecutionContract?.task_family ?? null,
      workflow_signature: pathExecutionContract?.workflow_signature ?? null,
      file_path: pathExecutionContract?.file_path ?? null,
      target_files: pathExecutionContract?.target_files ?? [],
      workflow_steps: Array.isArray(pathExecutionContract?.workflow_steps)
        ? pathExecutionContract?.workflow_steps
        : [],
      pattern_hints: Array.isArray(pathExecutionContract?.pattern_hints)
        ? pathExecutionContract?.pattern_hints
        : [],
      service_lifecycle_constraints: Array.isArray(pathExecutionContract?.service_lifecycle_constraints)
        ? pathExecutionContract?.service_lifecycle_constraints
        : [],
      confidence: path.confidence,
      authority_visibility: path.authority_visibility,
      authority_blocked: path.authority_blocked,
      authority_primary_blocker: path.authority_primary_blocker,
      reason: firstString(path.reason) ?? "workflow memory matched this request",
    }] : []),
    ...adaptiveGuidance.selected_candidates.slice(0, 5).map((candidate) => ({
      source_kind: "adaptive_guidance_candidate" as const,
      anchor_id: candidate.source_anchor_id,
      selected_tool: candidate.selected_tool,
      task_family: candidate.task_family,
      workflow_signature: candidate.workflow_signature,
      file_path: candidate.file_path,
      target_files: candidate.target_files,
      workflow_steps: candidate.workflow_steps,
      pattern_hints: candidate.pattern_hints,
      service_lifecycle_constraints: candidate.service_lifecycle_constraints,
      confidence: candidate.score,
      reason: candidate.match_reasons.length > 0
        ? candidate.match_reasons.join("; ")
        : "adaptive guidance matched prior execution memory",
    })),
    ...contestedPatterns
      .filter((entry) => !selectedTool || entry.selected_tool === selectedTool)
      .slice(0, 1)
      .map((entry) => ({
        source_kind: "contested_pattern" as const,
        anchor_id: entry.anchor_id,
        selected_tool: entry.selected_tool ?? null,
        task_family: null,
        workflow_signature: entry.workflow_signature ?? null,
        file_path: entry.file_path ?? null,
        target_files: entry.target_files ?? [],
        confidence: entry.confidence ?? null,
        reason: entry.summary ?? `contested execution evidence is open for ${entry.selected_tool ?? "this tool"}`,
      })),
    ...rehydrationCandidates.slice(0, 1).map((entry) => ({
      source_kind: "rehydration_candidate" as const,
      anchor_id: entry.anchor_id,
      selected_tool: entry.selected_tool ?? null,
      task_family: null,
      workflow_signature: entry.workflow_signature ?? null,
      file_path: entry.file_path ?? null,
      target_files: entry.target_files ?? [],
      confidence: entry.confidence ?? null,
      reason: entry.summary ?? "rehydrate payload only if anchor memory is not enough",
    })),
  ];
  const uncertainty = applyAdaptiveGuidanceToUncertainty({
    uncertainty: buildActionRetrievalUncertainty({
      selectedTool,
      path,
      preferredPattern,
      selectedWorkflow,
      contestedPatterns,
      rehydrationCandidates,
      persistedPolicy,
    }),
    overlay: adaptiveGuidance,
    hasStableWorkflow: workflowSupportsForRetrieval,
  });
  const toolReason = firstString(args.tools.selection_summary.provenance_explanation);
  const rationaleSummary = [
    toolReason,
    firstString(path.reason),
    persistedPolicy ? `persisted_policy_memory=${persistedPolicy.node_id}` : null,
    adaptiveGuidance.selected_candidate_count > 0 ? `adaptive_guidance=${adaptiveGuidance.selected_candidate_count}` : null,
    `tool_source=${toolSourceKind}`,
    `uncertainty=${uncertainty.level}:${uncertainty.confidence.toFixed(2)}`,
  ].filter((value): value is string => !!value).join(" | ");
  const evidence = {
    stable_workflow_count: recommendedWorkflows.length,
    candidate_workflow_count: candidateWorkflows.length,
    trusted_pattern_count: trustedPatterns.length,
    contested_pattern_count: contestedPatterns.length,
    rehydration_candidate_count: rehydrationCandidates.length,
    adaptive_guidance_candidate_count: adaptiveGuidance.selected_candidate_count,
    persisted_policy_memory_id: persistedPolicy?.node_id ?? null,
    selected_path_anchor_id: path.anchor_id,
    entries: evidenceEntries,
  };
  const experienceAdaptationTrace = buildExecutionExperienceAdaptationTrace({
    parsed: args.parsed,
    introspection: args.introspection,
    trajectoryCompile: args.trajectoryCompile ?? null,
    delegationRecommendationCount: args.delegationRecommendationCount,
    retrieval: {
      selected_tool: selectedTool,
      tool_source_kind: toolSourceKind,
      path,
      evidence,
      adaptive_guidance: adaptiveGuidance,
      uncertainty,
    },
  });

  return ActionRetrievalResponseSchema.parse({
    summary_version: "action_retrieval_v1",
    tenant_id: args.tools.tenant_id,
    scope: args.tools.scope,
    query_text: args.parsed.query_text,
    history_applied: historyApplied,
    tool_source_kind: toolSourceKind,
    selected_tool: selectedTool,
    recommended_file_path: recommendedFilePath,
    recommended_next_action: combinedNextAction,
    execution_contract_v1: executionContract,
    tool: {
      selected_tool: selectedTool,
      ordered_tools: Array.isArray(args.tools.selection.ordered) ? args.tools.selection.ordered : [],
      preferred_tools: Array.isArray(args.tools.selection.preferred) ? args.tools.selection.preferred : [],
      allowed_tools: Array.isArray(args.tools.selection.allowed) ? args.tools.selection.allowed : [],
      trusted_pattern_anchor_ids: Array.isArray(args.tools.decision.pattern_summary.used_trusted_pattern_anchor_ids)
        ? args.tools.decision.pattern_summary.used_trusted_pattern_anchor_ids
        : [],
      candidate_pattern_anchor_ids: Array.isArray(args.tools.decision.pattern_summary.skipped_contested_pattern_anchor_ids)
        ? args.tools.decision.pattern_summary.skipped_contested_pattern_anchor_ids
        : [],
      suppressed_pattern_anchor_ids: Array.isArray(args.tools.decision.pattern_summary.skipped_suppressed_pattern_anchor_ids)
        ? args.tools.decision.pattern_summary.skipped_suppressed_pattern_anchor_ids
        : [],
    },
    path: {
      source_kind: path.source_kind,
      anchor_id: path.anchor_id,
      ...(firstContractTrust(
        executionContract?.contract_trust,
        pathExecutionContract?.contract_trust,
        selectedWorkflowExecutionContract?.contract_trust,
        persistedPolicy?.execution_contract.contract_trust,
      )
        ? {
            contract_trust: firstContractTrust(
              executionContract?.contract_trust,
              pathExecutionContract?.contract_trust,
              selectedWorkflowExecutionContract?.contract_trust,
              persistedPolicy?.execution_contract.contract_trust,
            ),
          }
        : {}),
      task_family: recommendedTaskFamily,
      workflow_signature: firstString(executionContract?.workflow_signature, pathExecutionContract?.workflow_signature),
      title: path.title,
      summary: path.summary,
      file_path: recommendedFilePath,
      target_files: recommendedTargetFiles,
      next_action: combinedNextAction,
      workflow_steps: recommendedWorkflowSteps,
      pattern_hints: recommendedPatternHints,
      service_lifecycle_constraints: recommendedServiceLifecycleConstraints,
      confidence: path.confidence,
      tool_set: path.tool_set,
      authority_visibility: path.authority_visibility,
      authority_blocked: path.authority_blocked,
      authority_primary_blocker: path.authority_primary_blocker,
    },
    evidence,
    adaptive_guidance: adaptiveGuidance,
    experience_adaptation_trace: experienceAdaptationTrace,
    uncertainty,
    rationale: {
      summary: rationaleSummary,
    },
  });
}

export async function buildActionRetrievalLite(args: {
  liteWriteStore: LiteWriteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId: string;
}): Promise<ActionRetrievalResponse> {
  const augmented = augmentTrajectoryAwareRequest({
    parsed: ActionRetrievalRequest.parse(args.body),
    parse: ActionRetrievalRequest.parse,
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
  const tools = await selectTools({
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

  return buildActionRetrievalResponse({
    parsed,
    tools,
    introspection,
    trajectoryCompile: augmented.compiled,
  });
}
