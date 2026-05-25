import type { MemoryLayerId } from "./layer-policy.js";
import { z } from "zod";
import {
  deriveExecutionContractFromSlots,
  type ExecutionContractV1,
} from "./execution-contract.js";
import {
  extractExecutionEvidenceFromSlots,
  type ExecutionEvidenceV1,
} from "./execution-evidence.js";
import type { ContractTrust } from "./schemas.js";
import { ServiceLifecycleConstraintV1Schema } from "../execution/types.js";

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

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const next = Number(value);
    if (Number.isFinite(next)) return next;
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function uniqueStrings(values: unknown[], limit = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value);
}

function firstNonEmptyStringList(...values: unknown[]): string[] {
  for (const value of values) {
    const next = stringList(value);
    if (next.length > 0) return next;
  }
  return [];
}

function uniqueLifecycleConstraints(
  values: unknown[],
  limit = 16,
): Array<z.infer<typeof ServiceLifecycleConstraintV1Schema>> {
  const out: Array<z.infer<typeof ServiceLifecycleConstraintV1Schema>> = [];
  const seen = new Set<string>();
  for (const value of values) {
    const parsed = ServiceLifecycleConstraintV1Schema.safeParse(value);
    if (!parsed.success) continue;
    const key = [
      parsed.data.label,
      parsed.data.endpoint ?? "",
      parsed.data.launch_reference ?? "",
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= limit) break;
  }
  return out;
}

function lifecycleConstraintList(value: unknown): Array<z.infer<typeof ServiceLifecycleConstraintV1Schema>> {
  return uniqueLifecycleConstraints(Array.isArray(value) ? value : [], 16);
}

function firstNonEmptyLifecycleConstraintList(
  ...values: unknown[]
): Array<z.infer<typeof ServiceLifecycleConstraintV1Schema>> {
  for (const value of values) {
    const next = lifecycleConstraintList(value);
    if (next.length > 0) return next;
  }
  return [];
}

function toLayerId(value: string | null): MemoryLayerId | null {
  return value === "L0" || value === "L1" || value === "L2" || value === "L3" || value === "L4" || value === "L5"
    ? value
    : null;
}

function mapExecutionKindToAnchorKind(executionKind: string | null): string | null {
  if (executionKind === "workflow_anchor") return "workflow";
  if (executionKind === "pattern_anchor") return "pattern";
  return null;
}

export function parseNodeExecutionNative(slots: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return asRecord(slots?.execution_native_v1);
}

export function resolveNodeNativeExecutionSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return parseNodeExecutionNative(slots);
}

export function parseNodeAnchor(slots: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return asRecord(slots?.anchor_v1);
}

export function resolveNodeAnchorPayloadRefs(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeAnchor(slots)?.payload_refs);
}

function hasNodeAnchorPayload(slots: Record<string, unknown> | null | undefined): boolean {
  return parseNodeAnchor(slots) !== null;
}

export function resolveNodeExecutionContract(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): ExecutionContractV1 | null {
  return deriveExecutionContractFromSlots({
    slots: args.slots ?? null,
  });
}

export function resolveNodeExecutionContractTrust(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): ContractTrust | null {
  const trust = resolveNodeExecutionContract(args)?.contract_trust;
  return trust === "authoritative" || trust === "advisory" || trust === "observational" ? trust : null;
}

export function resolveNodeExecutionEvidence(args: {
  slots: Record<string, unknown> | null | undefined;
  metrics?: unknown;
}): ExecutionEvidenceV1 | null {
  return extractExecutionEvidenceFromSlots({
    slots: args.slots ?? null,
    metrics: args.metrics,
  });
}

export function resolveNodeExecutionKind(slots: Record<string, unknown> | null | undefined): string | null {
  return firstString(parseNodeExecutionNative(slots)?.execution_kind);
}

export function resolveNodeTaskSignature(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string | null {
  const contract = resolveNodeExecutionContract(args);
  return firstString(
    contract?.task_signature,
    parseNodeExecutionNative(args.slots)?.task_signature,
    args.slots?.task_signature,
  );
}

export function resolveNodeTaskFamily(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string | null {
  const slots = args.slots ?? null;
  const contract = resolveNodeExecutionContract(args);
  const executionResultSummary = asRecord(args.executionResultSummary) ?? asRecord(slots?.execution_result_summary);
  const trajectoryCompileSummary = asRecord(executionResultSummary?.trajectory_compile_v1);
  return firstString(
    contract?.task_family,
    slots?.task_family,
    parseNodeExecutionNative(slots)?.task_family,
    trajectoryCompileSummary?.task_family,
    slots?.task_kind,
  );
}

export function resolveNodeWorkflowSignature(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string | null {
  const contract = resolveNodeExecutionContract(args);
  return firstString(
    contract?.workflow_signature,
    parseNodeExecutionNative(args.slots)?.workflow_signature,
    args.slots?.workflow_signature,
  );
}

export function resolveNodePatternSignature(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  return firstString(
    parseNodeExecutionNative(slots)?.pattern_signature,
    parseNodeAnchor(slots)?.pattern_signature,
  );
}

export function resolveNodeErrorSignature(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  return firstString(
    slots?.error_signature,
    parseNodeExecutionNative(slots)?.error_signature,
    parseNodeAnchor(slots)?.error_signature,
  );
}

export function resolveNodeErrorFamily(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  return firstString(
    slots?.error_family,
    parseNodeExecutionNative(slots)?.error_family,
    parseNodeAnchor(slots)?.error_family,
  );
}

export function resolveNodeAnchorSummary(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  return firstString(parseNodeAnchor(slots)?.summary);
}

export function resolveNodeAnchorMetricsSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeAnchor(slots)?.metrics) ?? asRecord(slots?.metrics);
}

export function resolveNodeOutcomeSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeExecutionNative(slots)?.outcome)
    ?? asRecord(parseNodeAnchor(slots)?.outcome);
}

export function resolveNodeAnchorConfidence(
  slots: Record<string, unknown> | null | undefined,
): number | null {
  return firstFinite(
    parseNodeExecutionNative(slots)?.anchor_confidence,
    parseNodeAnchor(slots)?.anchor_confidence,
  );
}

export function resolveNodeFilePath(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string | null {
  const contract = resolveNodeExecutionContract(args);
  return firstString(
    contract?.file_path,
    args.slots?.file_path,
    parseNodeExecutionNative(args.slots)?.file_path,
    parseNodeAnchor(args.slots)?.file_path,
  );
}

export function resolveNodeTargetFiles(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string[] {
  const contract = resolveNodeExecutionContract(args);
  const execution = parseNodeExecutionNative(args.slots);
  const anchor = parseNodeAnchor(args.slots);
  return firstNonEmptyStringList(
    contract?.target_files,
    args.slots?.target_files,
    execution?.target_files,
    anchor?.target_files,
  );
}

export function resolveNodeNextAction(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string | null {
  const contract = resolveNodeExecutionContract(args);
  return firstString(
    contract?.next_action,
    args.slots?.next_action,
    parseNodeExecutionNative(args.slots)?.next_action,
    parseNodeAnchor(args.slots)?.next_action,
  );
}

export function resolveNodeAcceptanceChecks(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string[] {
  const contract = resolveNodeExecutionContract(args);
  const execution = parseNodeExecutionNative(args.slots);
  const anchor = parseNodeAnchor(args.slots);
  return firstNonEmptyStringList(
    contract?.outcome.acceptance_checks,
    args.slots?.acceptance_checks,
    asRecord(execution?.outcome)?.acceptance_checks,
    asRecord(anchor?.outcome)?.acceptance_checks,
  );
}

export function resolveNodeWorkflowSteps(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string[] {
  const contract = resolveNodeExecutionContract(args);
  const execution = parseNodeExecutionNative(args.slots);
  const anchor = parseNodeAnchor(args.slots);
  return firstNonEmptyStringList(
    contract?.workflow_steps,
    args.slots?.workflow_steps,
    execution?.workflow_steps,
    anchor?.key_steps,
  );
}

export function resolveNodePatternHints(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string[] {
  const contract = resolveNodeExecutionContract(args);
  const execution = parseNodeExecutionNative(args.slots);
  const anchor = parseNodeAnchor(args.slots);
  return firstNonEmptyStringList(
    contract?.pattern_hints,
    args.slots?.pattern_hints,
    execution?.pattern_hints,
    anchor?.pattern_hints,
  );
}

export function resolveNodeServiceLifecycleConstraints(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): Array<z.infer<typeof ServiceLifecycleConstraintV1Schema>> {
  const contract = resolveNodeExecutionContract(args);
  const execution = parseNodeExecutionNative(args.slots);
  const anchor = parseNodeAnchor(args.slots);
  return firstNonEmptyLifecycleConstraintList(
    contract?.service_lifecycle_constraints,
    args.slots?.service_lifecycle_constraints,
    execution?.service_lifecycle_constraints,
    anchor?.service_lifecycle_constraints,
  );
}

export function resolveNodeAnchorKind(slots: Record<string, unknown> | null | undefined): string | null {
  return firstString(
    parseNodeExecutionNative(slots)?.anchor_kind,
    mapExecutionKindToAnchorKind(resolveNodeExecutionKind(slots)),
    parseNodeAnchor(slots)?.anchor_kind,
  );
}

export function hasNodeWorkflowAnchorSurface(slots: Record<string, unknown> | null | undefined): boolean {
  return hasNodeAnchorPayload(slots) || resolveNodeExecutionKind(slots) === "workflow_anchor";
}

export function resolveNodeAnchorLevel(
  slots: Record<string, unknown> | null | undefined,
): MemoryLayerId | null {
  return toLayerId(firstString(
    parseNodeExecutionNative(slots)?.anchor_level,
    parseNodeAnchor(slots)?.anchor_level,
  ));
}

export function resolveNodeSelectedTool(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string | null {
  const contract = resolveNodeExecutionContract(args);
  return firstString(
    contract?.selected_tool,
    parseNodeExecutionNative(args.slots)?.selected_tool,
    parseNodeAnchor(args.slots)?.selected_tool,
  );
}

export function resolveNodeToolSet(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): string[] {
  const selectedTool = resolveNodeSelectedTool(args);
  return firstNonEmptyStringList(
    parseNodeExecutionNative(args.slots)?.tool_set,
    parseNodeAnchor(args.slots)?.tool_set,
    selectedTool ? [selectedTool] : [],
  );
}

export function resolveNodeMaintenanceSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeExecutionNative(slots)?.maintenance)
    ?? asRecord(parseNodeAnchor(slots)?.maintenance);
}

export function resolveNodeWorkflowPromotionSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeExecutionNative(slots)?.workflow_promotion)
    ?? asRecord(parseNodeAnchor(slots)?.workflow_promotion);
}

export function resolveNodeDistillationSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeExecutionNative(slots)?.distillation)
    ?? asRecord(parseNodeAnchor(slots)?.distillation);
}

export function resolveNodeRehydrationSurface(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const explicit = asRecord(parseNodeExecutionNative(slots)?.rehydration)
    ?? asRecord(parseNodeAnchor(slots)?.rehydration);
  if (explicit) return explicit;
  const defaultMode = resolveNodeRehydrationDefaultMode(slots);
  return defaultMode ? { default_mode: defaultMode } : null;
}

export function resolveNodeLifecycleState(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  return firstString(slots?.lifecycle_state);
}

export type NodeSemanticForgettingSurface = {
  action: "retain" | "demote" | "archive" | "review" | null;
};

export function resolveNodeSemanticForgettingSurface(
  slots: Record<string, unknown> | null | undefined,
): NodeSemanticForgettingSurface {
  const semanticForgetting = asRecord(slots?.semantic_forgetting_v1);
  const action = firstString(semanticForgetting?.action);
  return {
    action: action === "retain" || action === "demote" || action === "archive" || action === "review"
      ? action
      : null,
  };
}

export type NodeArchiveRelocationSurface = {
  relocation_state: "none" | "candidate" | "cold_archive" | null;
  relocation_target: "none" | "local_cold_store" | "external_object_store" | null;
  payload_scope: "none" | "anchor_payload" | "node" | null;
};

export function resolveNodeArchiveRelocationSurface(
  slots: Record<string, unknown> | null | undefined,
): NodeArchiveRelocationSurface {
  const archiveRelocation = asRecord(slots?.archive_relocation_v1);
  const relocationState = firstString(archiveRelocation?.relocation_state);
  const relocationTarget = firstString(archiveRelocation?.relocation_target);
  const payloadScope = firstString(archiveRelocation?.payload_scope);
  return {
    relocation_state:
      relocationState === "none" || relocationState === "candidate" || relocationState === "cold_archive"
        ? relocationState
        : null,
    relocation_target:
      relocationTarget === "none"
      || relocationTarget === "local_cold_store"
      || relocationTarget === "external_object_store"
        ? relocationTarget
        : null,
    payload_scope:
      payloadScope === "none" || payloadScope === "anchor_payload" || payloadScope === "node"
        ? payloadScope
        : null,
  };
}

export function resolveNodeWorkflowSourceKind(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  const anchor = parseNodeAnchor(slots);
  const explicitSourceKind = firstString(asRecord(anchor?.source)?.source_kind);
  if (explicitSourceKind) return explicitSourceKind;
  const workflowPromotion = resolveNodeWorkflowPromotionSurface(slots);
  const promotionOrigin = firstString(workflowPromotion?.promotion_origin);
  const executionKind = resolveNodeExecutionKind(slots);
  if (
    promotionOrigin === "replay_compile_from_run"
    || promotionOrigin === "replay_promote"
    || promotionOrigin === "replay_stable_normalization"
    || promotionOrigin === "replay_learning_episode"
    || promotionOrigin === "replay_learning_auto_promotion"
    || executionKind === "workflow_candidate"
    || executionKind === "workflow_anchor"
  ) {
    return "playbook";
  }
  return null;
}

export function resolveNodePatternState(
  slots: Record<string, unknown> | null | undefined,
): string | null {
  return firstString(
    parseNodeExecutionNative(slots)?.pattern_state,
    parseNodeAnchor(slots)?.pattern_state,
  );
}

export function resolveNodeSummaryKind(slots: Record<string, unknown> | null | undefined): string | null {
  return firstString(parseNodeExecutionNative(slots)?.summary_kind, slots?.summary_kind);
}

export function resolveNodeCompressionLayer(args: {
  type: string;
  slots: Record<string, unknown> | null | undefined;
}): MemoryLayerId | null {
  const slots = args.slots ?? null;
  const executionLayer = toLayerId(firstString(parseNodeExecutionNative(slots)?.compression_layer));
  if (executionLayer) return executionLayer;

  const anchorLevel = toLayerId(firstString(
    parseNodeExecutionNative(slots)?.anchor_level,
    parseNodeAnchor(slots)?.anchor_level,
  ));
  if (anchorLevel) return anchorLevel;

  if (args.type === "event") return "L0";
  if (args.type === "evidence") {
    if (resolveNodeSummaryKind(slots) === "write_distillation_evidence") return "L1";
    return "L0";
  }
  if (args.type === "topic") return "L2";
  if (args.type === "concept") {
    const slotLayer = toLayerId(firstString(slots?.compression_layer));
    if (slotLayer) return slotLayer;
    if (resolveNodeSummaryKind(slots) === "write_distillation_fact") return "L1";
    if (resolveNodeSummaryKind(slots) === "compression_rollup") return "L3";
  }
  return null;
}

export function resolveNodeRehydrationDefaultMode(
  slots: Record<string, unknown> | null | undefined,
): "summary_only" | "partial" | "full" | "differential" | null {
  const mode = firstString(
    parseNodeExecutionNative(slots)?.rehydration_default_mode,
    asRecord(parseNodeAnchor(slots)?.rehydration)?.default_mode,
  );
  return mode === "summary_only" || mode === "partial" || mode === "full" || mode === "differential"
    ? mode
    : null;
}

export function resolveNodeCredibilityState(
  slots: Record<string, unknown> | null | undefined,
): "candidate" | "trusted" | "contested" | null {
  const anchor = parseNodeAnchor(slots);
  const execution = parseNodeExecutionNative(slots);
  const promotion = asRecord(execution?.promotion) ?? asRecord(anchor?.promotion);
  const patternState = resolveNodePatternState(slots);
  const state = firstString(
    execution?.credibility_state,
    anchor?.credibility_state,
    promotion?.credibility_state,
    patternState === "stable" ? "trusted" : null,
  );
  return state === "candidate" || state === "trusted" || state === "contested" ? state : null;
}

export function resolveNodePatternMaintenance(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return resolveNodeMaintenanceSurface(slots);
}

export function resolveNodePatternTrustHardening(
  slots: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(parseNodeExecutionNative(slots)?.trust_hardening)
    ?? asRecord(parseNodeAnchor(slots)?.trust_hardening);
}

export type NodePatternPromotionSurface = {
  distinct_run_count: number | null;
  required_distinct_runs: number | null;
  counter_evidence_count: number | null;
  counter_evidence_open: boolean;
  last_transition: string | null;
};

export function resolveNodePatternPromotionSurface(
  slots: Record<string, unknown> | null | undefined,
): NodePatternPromotionSurface {
  const execution = parseNodeExecutionNative(slots);
  const anchor = parseNodeAnchor(slots);
  const promotion = asRecord(execution?.promotion) ?? asRecord(anchor?.promotion);
  const metrics = asRecord(anchor?.metrics);
  return {
    distinct_run_count: firstFinite(promotion?.distinct_run_count, metrics?.distinct_run_count),
    required_distinct_runs: firstFinite(promotion?.required_distinct_runs),
    counter_evidence_count: firstFinite(promotion?.counter_evidence_count),
    counter_evidence_open: firstBoolean(promotion?.counter_evidence_open) === true,
    last_transition: firstString(promotion?.last_transition),
  };
}

export type NodePatternExecutionSurface = {
  anchor_kind: string | null;
  anchor_level: MemoryLayerId | null;
  selected_tool: string | null;
  task_signature: string | null;
  task_family: string | null;
  error_family: string | null;
  tool_set: string[];
  pattern_state: string | null;
  credibility_state: "candidate" | "trusted" | "contested" | null;
  contract_trust: ContractTrust | null;
  promotion: NodePatternPromotionSurface;
  maintenance: Record<string, unknown> | null;
  trust_hardening: Record<string, unknown> | null;
};

export function resolveNodePatternExecutionSurface(args: {
  slots: Record<string, unknown> | null | undefined;
  executionResultSummary?: Record<string, unknown> | null;
}): NodePatternExecutionSurface {
  return {
    anchor_kind: resolveNodeAnchorKind(args.slots),
    anchor_level: resolveNodeAnchorLevel(args.slots),
    selected_tool: resolveNodeSelectedTool(args),
    task_signature: resolveNodeTaskSignature(args),
    task_family: resolveNodeTaskFamily(args),
    error_family: resolveNodeErrorFamily(args.slots),
    tool_set: resolveNodeToolSet(args),
    pattern_state: resolveNodePatternState(args.slots),
    credibility_state: resolveNodeCredibilityState(args.slots),
    contract_trust: resolveNodeExecutionContractTrust(args),
    promotion: resolveNodePatternPromotionSurface(args.slots),
    maintenance: resolveNodePatternMaintenance(args.slots),
    trust_hardening: resolveNodePatternTrustHardening(args.slots),
  };
}

export function resolveNodePolicyMemoryState(
  slots: Record<string, unknown> | null | undefined,
): "active" | "contested" | "retired" | null {
  const state = resolveNodePolicyMemorySurface(slots).policy_memory_state;
  return state === "active" || state === "contested" || state === "retired" ? state : null;
}

export type NodePolicyMemorySurface = {
  policy_memory_state: "active" | "contested" | "retired" | null;
  policy_state: string | null;
  policy_source_kind: string | null;
  activation_mode: string | null;
  materialization_state: string | null;
  last_transition: string | null;
};

export function resolveNodePolicyMemorySurface(
  slots: Record<string, unknown> | null | undefined,
): NodePolicyMemorySurface {
  const execution = parseNodeExecutionNative(slots);
  const policyEvolution = asRecord(execution?.policy_evolution);
  const policyContract = asRecord(slots?.policy_contract_v1) ?? asRecord(slots?.policy_contract);
  const derivedPolicy = asRecord(slots?.derived_policy_v1);
  const rawPolicyMemoryState = firstString(
    slots?.policy_memory_state,
    policyEvolution?.policy_memory_state,
    policyContract?.policy_memory_state,
    derivedPolicy?.policy_memory_state,
  );
  const policyMemoryState =
    rawPolicyMemoryState === "active" || rawPolicyMemoryState === "contested" || rawPolicyMemoryState === "retired"
      ? rawPolicyMemoryState
      : null;
  return {
    policy_memory_state: policyMemoryState,
    policy_state: firstString(policyEvolution?.policy_state, policyContract?.policy_state, derivedPolicy?.policy_state),
    policy_source_kind: firstString(
      policyEvolution?.policy_source_kind,
      policyContract?.source_kind,
      derivedPolicy?.source_kind,
    ),
    activation_mode: firstString(
      policyEvolution?.activation_mode,
      policyContract?.activation_mode,
      derivedPolicy?.activation_mode,
    ),
    materialization_state: firstString(
      policyEvolution?.materialization_state,
      slots?.materialization_state,
      policyContract?.materialization_state,
      derivedPolicy?.materialization_state,
    ),
    last_transition: firstString(
      policyEvolution?.last_transition,
      policyContract?.last_transition,
      derivedPolicy?.last_transition,
    ),
  };
}
