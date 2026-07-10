import {
  buildExecutionSummarySurface,
} from "../app/planning-summary-assembly.js";
import {
  buildExecutionMemorySummaryBundle,
  summarizePatternSignalSurface,
  summarizeWorkflowMaintenanceSurface,
  summarizeWorkflowSignalSurface,
  summarizePatternMaintenanceSurface,
} from "../app/planning-summary-surfaces.js";
import { buildCognitiveStructureV1 } from "../kernel/cognitive-structure.js";
import {
  PolicyMutationV1Schema,
  type PolicyMutationV1,
} from "../kernel/policy-mutation-loop.js";
import { listRecentDelegationRecordNodeRowsLite } from "./delegation-records-surface.js";
import {
  ExecutionMemoryIntrospectionRequest,
  ExecutionSummaryV1Schema,
  type ExecutionMemoryIntrospectionResponse,
} from "./schemas.js";
import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import { dedupeWorkflowCandidatesBySignature } from "./workflow-candidate-aggregation.js";
import { explainWorkflowProjectionForSourceNode } from "./workflow-write-projection.js";
import {
  isAnchorSuppressed,
  isPatternSuppressed,
  readAnchorOperatorOverride,
  readPatternOperatorOverride,
} from "./pattern-operator-override.js";
import { buildOutcomeContractGate, type OutcomeContractGate } from "./contract-trust.js";
import { buildRuntimeAuthorityVisibilityFromSlots } from "./authority-visibility.js";
import { authorityConsumptionStateFromValue } from "./authority-consumption.js";
import {
  buildRuntimeAuthorityDecisionReport,
  buildRuntimeAuthorityDecisionReportFromGates,
  type RuntimeAuthorityDecisionReportV1,
} from "./authority-decision-report.js";
import type { ExecutionEvidenceAssessmentV1 } from "./execution-evidence.js";
import { resolveTenantScope } from "./tenant.js";
import {
  resolveNodeAnchorSummary,
  resolveNodeAnchorLevel,
  resolveNodeCompressionLayer,
  resolveNodeDistillationSurface,
  executionOutcomeRoleBlocksDirectUse,
  resolveNodeExecutionContract,
  resolveNodeExecutionContractTrust,
  resolveNodeExecutionKind,
  resolveNodeExecutionOutcomeRole,
  resolveNodeErrorFamily,
  resolveNodeErrorSignature,
  resolveNodeFilePath,
  resolveNodeMaintenanceSurface,
  resolveNodeNextAction,
  resolveNodePatternExecutionSurface,
  resolveNodePatternHints,
  resolveNodePolicyMemorySurface,
  resolveNodeRehydrationSurface,
  resolveNodeRehydrationDefaultMode,
  resolveNodeSelectedTool,
  resolveNodeServiceLifecycleConstraints,
  resolveNodeSummaryKind,
  resolveNodeTargetFiles,
  resolveNodeTaskFamily,
  resolveNodeTaskSignature,
  resolveNodeToolSet,
  resolveNodeWorkflowPromotionSurface,
  resolveNodeWorkflowSignature,
  resolveNodeWorkflowSourceKind,
  resolveNodeWorkflowSteps,
} from "./node-execution-surface.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type RowWithSlots = {
  id: string;
  slots?: unknown;
};

function collectPolicyMutationFromValue(value: unknown): PolicyMutationV1 | null {
  const parsed = PolicyMutationV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function collectPolicyMutationsFromSlots(slots: Record<string, unknown>): PolicyMutationV1[] {
  const out: PolicyMutationV1[] = [];
  const direct = collectPolicyMutationFromValue(slots.policy_mutation_v1);
  if (direct) out.push(direct);
  const workflowProjection = optionalRecord(slots.workflow_write_projection);
  const workflowProjectionMutation = collectPolicyMutationFromValue(workflowProjection?.policy_mutation_v1);
  if (workflowProjectionMutation) out.push(workflowProjectionMutation);
  const replayLearning = optionalRecord(slots.replay_learning);
  const replayLearningMutation = collectPolicyMutationFromValue(replayLearning?.policy_mutation_v1);
  if (replayLearningMutation) out.push(replayLearningMutation);
  return out;
}

function collectPolicyMutationsFromRows(rows: RowWithSlots[]): PolicyMutationV1[] {
  const out: PolicyMutationV1[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const mutation of collectPolicyMutationsFromSlots(asRecord(row.slots))) {
      if (seen.has(mutation.mutation_id)) continue;
      seen.add(mutation.mutation_id);
      out.push(mutation);
      if (out.length >= 128) return out;
    }
  }
  return out;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (next) return next;
  }
  return null;
}

function toNodeUri(tenantId: string, scope: string, type: string, id: string): string {
  return `aionis://${tenantId}/${scope}/${type}/${id}`;
}

function dedupeByAnchorId<T extends { anchor_id?: string | null }>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const anchorId = typeof item.anchor_id === "string" ? item.anchor_id.trim() : "";
    if (!anchorId || seen.has(anchorId)) continue;
    seen.add(anchorId);
    out.push(item);
  }
  return out;
}

function hasWorkflowProjectionMarker(slots: Record<string, unknown>): boolean {
  const projection = asRecord(slots.workflow_write_projection);
  return firstString(projection.generated_by) !== null;
}

function stringList(value: unknown, limit = 16): string[] {
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

type ContractTrustForReport = OutcomeContractGate["requested_trust"];
type AuthorityVisibilityForReport = ReturnType<typeof buildRuntimeAuthorityVisibilityFromSlots>;

function normalizeContractTrustForReport(value: unknown): ContractTrustForReport {
  return value === "authoritative" || value === "advisory" || value === "observational" ? value : null;
}

function normalizeEvidenceStatusForReport(value: unknown): ExecutionEvidenceAssessmentV1["status"] {
  return value === "succeeded" || value === "failed" || value === "incomplete" || value === "unknown"
    ? value
    : "unknown";
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function requiresAfterExitFromGate(gate: OutcomeContractGate): boolean {
  return gate.decisive_fields.must_hold_after_exit_count > 0
    || gate.decisive_fields.service_must_survive_agent_exit_count > 0;
}

function requiresFreshShellFromGate(gate: OutcomeContractGate): boolean {
  return gate.decisive_fields.external_visibility_requirement_count > 0
    || gate.decisive_fields.service_revalidate_from_fresh_shell_count > 0;
}

function executionValidationBoundaryForReport(value: unknown): ExecutionEvidenceAssessmentV1["decisive_fields"]["validation_boundary"] {
  return value === "agent_self"
    || value === "runtime_orchestrator"
    || value === "external_verifier"
    ? value
    : "unknown";
}

function normalizeExecutionEvidenceAssessmentForReport(args: {
  value: unknown;
  requestedTrust: ContractTrustForReport;
  outcomeContractGate: OutcomeContractGate;
  authorityVisibility: AuthorityVisibilityForReport;
}): ExecutionEvidenceAssessmentV1 {
  const record = optionalRecord(args.value);
  if (record?.schema_version === "execution_evidence_assessment_v1") {
    const decisiveFields = asRecord(record.decisive_fields);
    const requestedTrust = normalizeContractTrustForReport(record.requested_trust) ?? args.requestedTrust;
    const allowsAuthoritative = record.allows_authoritative === true;
    return {
      schema_version: "execution_evidence_assessment_v1",
      status: normalizeEvidenceStatusForReport(record.status),
      allows_authoritative: allowsAuthoritative,
      allows_stable_promotion: record.allows_stable_promotion === true,
      requested_trust: requestedTrust,
      effective_trust: normalizeContractTrustForReport(record.effective_trust)
        ?? (requestedTrust === "authoritative" && !allowsAuthoritative ? "advisory" : requestedTrust),
      reasons: stringList(record.reasons, 16),
      decisive_fields: {
        validation_passed: nullableBoolean(decisiveFields.validation_passed),
        after_exit_revalidated: nullableBoolean(decisiveFields.after_exit_revalidated),
        fresh_shell_probe_passed: nullableBoolean(decisiveFields.fresh_shell_probe_passed),
        validation_boundary: executionValidationBoundaryForReport(decisiveFields.validation_boundary),
        false_confidence_detected: decisiveFields.false_confidence_detected === true,
        failure_reason_present: decisiveFields.failure_reason_present === true,
        requires_after_exit_revalidation: decisiveFields.requires_after_exit_revalidation === true
          || requiresAfterExitFromGate(args.outcomeContractGate),
        requires_fresh_shell_probe: decisiveFields.requires_fresh_shell_probe === true
          || requiresFreshShellFromGate(args.outcomeContractGate),
        requires_external_validation_boundary: decisiveFields.requires_external_validation_boundary === true
          || requiresAfterExitFromGate(args.outcomeContractGate)
          || requiresFreshShellFromGate(args.outcomeContractGate),
      },
    };
  }

  const reasons = args.authorityVisibility?.execution_evidence_reasons.length
    ? args.authorityVisibility.execution_evidence_reasons
    : ["missing_execution_evidence_assessment"];
  return {
    schema_version: "execution_evidence_assessment_v1",
    status: "unknown",
    allows_authoritative: false,
    allows_stable_promotion: false,
    requested_trust: args.requestedTrust,
    effective_trust: args.requestedTrust === "authoritative" ? "advisory" : args.requestedTrust,
    reasons: reasons.slice(0, 16),
    decisive_fields: {
      validation_passed: null,
      after_exit_revalidated: null,
      fresh_shell_probe_passed: null,
      validation_boundary: "unknown",
      false_confidence_detected: args.authorityVisibility?.false_confidence_detected === true,
      failure_reason_present: false,
      requires_after_exit_revalidation: requiresAfterExitFromGate(args.outcomeContractGate),
      requires_fresh_shell_probe: requiresFreshShellFromGate(args.outcomeContractGate),
      requires_external_validation_boundary: requiresAfterExitFromGate(args.outcomeContractGate)
        || requiresFreshShellFromGate(args.outcomeContractGate),
    },
  };
}

function buildEntryAuthorityDecisionReport(args: {
  subject: string;
  outcomeContractGate: OutcomeContractGate;
  executionEvidenceAssessment?: unknown;
  authorityVisibility: AuthorityVisibilityForReport;
  candidateWorkflowVisible?: boolean;
  trustedPatternOnlyVisible?: boolean;
  policyDefaultAttempted?: boolean;
  stablePromotionAllowedOverride?: boolean;
}): RuntimeAuthorityDecisionReportV1 {
  const executionEvidenceAssessment = normalizeExecutionEvidenceAssessmentForReport({
    value: args.executionEvidenceAssessment,
    requestedTrust: args.outcomeContractGate.requested_trust,
    outcomeContractGate: args.outcomeContractGate,
    authorityVisibility: args.authorityVisibility,
  });
  const falseConfidenceDetected =
    args.authorityVisibility?.false_confidence_detected === true
    || executionEvidenceAssessment.decisive_fields.false_confidence_detected;
  const stablePromotionAllowed = args.stablePromotionAllowedOverride ?? (
    args.outcomeContractGate.allows_authoritative
    && executionEvidenceAssessment.allows_stable_promotion
    && args.authorityVisibility?.allows_stable_promotion !== false
    && !falseConfidenceDetected
  );
  return buildRuntimeAuthorityDecisionReportFromGates({
    subject: args.subject,
    outcomeContractGate: args.outcomeContractGate,
    executionEvidenceAssessment,
    stablePromotionAllowed,
    falseConfidenceDetected,
    candidateWorkflowVisible: args.candidateWorkflowVisible,
    trustedPatternOnlyVisible: args.trustedPatternOnlyVisible,
    policyDefaultAttempted: args.policyDefaultAttempted,
  });
}

function combineAuthorityDecisionReports(reports: RuntimeAuthorityDecisionReportV1[]): RuntimeAuthorityDecisionReportV1 {
  return buildRuntimeAuthorityDecisionReport(reports.flatMap((report) => report.decisions));
}

function deriveWorkflowProjectionMeta(slots: Record<string, unknown>) {
  const projection = asRecord(slots.workflow_write_projection);
  const generatedBy = firstString(projection.generated_by);
  if (!generatedBy) return null;
  return {
    generated_by: generatedBy,
    source_node_id: firstString(projection.source_node_id),
    source_client_id: firstString(projection.source_client_id),
    generated_at: firstString(projection.generated_at),
    auto_promoted: projection.auto_promoted === true,
  };
}

function toWorkflowEntry(row: LiteExecutionNativeNodeRow, tenantId: string, scope: string) {
  const slots = asRecord(row.slots);
  const executionContract = resolveNodeExecutionContract({ slots });
  const contractTrust = resolveNodeExecutionContractTrust({ slots });
  const outcomeContractGate = buildOutcomeContractGate({
    executionContract,
    requestedTrust: contractTrust,
  });
  const title = firstString(row.title);
  const summary = firstString(row.text_summary, resolveNodeAnchorSummary(slots));
  const authorityVisibility = buildRuntimeAuthorityVisibilityFromSlots({
    nodeId: row.id,
    nodeKind: "workflow",
    title: title ?? summary,
    slots,
  });
  const authorityState = authorityConsumptionStateFromValue({ authority_visibility: authorityVisibility });
  const semanticForgetting = asRecord(slots.semantic_forgetting_v1);
  const archiveRelocation = asRecord(slots.archive_relocation_v1);
  const workflowPromotion = resolveNodeWorkflowPromotionSurface(slots) ?? {};
  const maintenance = resolveNodeMaintenanceSurface(slots) ?? {};
  const rehydration = resolveNodeRehydrationSurface(slots) ?? {};
  const distillation = resolveNodeDistillationSurface(slots) ?? {};
  const projectionMeta = deriveWorkflowProjectionMeta(slots);
  const targetFiles = resolveNodeTargetFiles({ slots });
  const filePath = resolveNodeFilePath({ slots });
  const nextAction = resolveNodeNextAction({ slots });
  const workflowSteps = resolveNodeWorkflowSteps({ slots });
  const patternHints = resolveNodePatternHints({ slots });
  const serviceLifecycleConstraints = resolveNodeServiceLifecycleConstraints({ slots });
  const executionOutcomeRole = resolveNodeExecutionOutcomeRole(slots);
  const outcomeBlocksDirectUse = executionOutcomeRoleBlocksDirectUse(executionOutcomeRole);
  const operatorOverride = readAnchorOperatorOverride(slots);
  const suppressed = isAnchorSuppressed(operatorOverride);
  const observedCount = Number(workflowPromotion.observed_count ?? Number.NaN);
  const requiredObservations = Number(workflowPromotion.required_observations ?? Number.NaN);
  const promotionState = firstString(workflowPromotion.promotion_state);
  const executionEvidenceAssessment = optionalRecord(slots.execution_evidence_assessment);
  const promotionReady =
    promotionState === "candidate"
    && Number.isFinite(observedCount)
    && Number.isFinite(requiredObservations)
    && requiredObservations > 0
    && observedCount >= requiredObservations
    && !authorityState.blocks_promotion_readiness
    && !outcomeBlocksDirectUse;
  const authorityDecisionReport = buildEntryAuthorityDecisionReport({
    subject: `workflow:${row.id}`,
    outcomeContractGate,
    executionEvidenceAssessment,
    authorityVisibility,
    candidateWorkflowVisible: promotionState === "candidate",
    policyDefaultAttempted: promotionState === "stable",
  });
  return {
    anchor_id: row.id,
    uri: toNodeUri(tenantId, scope, row.type, row.id),
    type: row.type,
    title,
    summary,
    anchor_level: resolveNodeAnchorLevel(slots),
    execution_contract_v1: executionContract,
    source_kind: resolveNodeWorkflowSourceKind(slots),
    promotion_origin: firstString(workflowPromotion.promotion_origin),
    promotion_state: promotionState,
    contract_trust: contractTrust,
    execution_outcome_role: executionOutcomeRole,
    outcome_contract_gate: outcomeContractGate,
    ...(optionalRecord(slots.authority_gate_v1) ? { authority_gate_v1: optionalRecord(slots.authority_gate_v1) } : {}),
    ...(executionEvidenceAssessment ? { execution_evidence_assessment: executionEvidenceAssessment } : {}),
    authority_visibility: authorityVisibility,
    authority_decision_report: authorityDecisionReport,
    task_family: resolveNodeTaskFamily({ slots }),
    observed_count: Number.isFinite(observedCount) ? observedCount : null,
    required_observations: Number.isFinite(requiredObservations) ? requiredObservations : null,
    promotion_ready: promotionReady,
    last_transition: firstString(workflowPromotion.last_transition),
    last_transition_at: firstString(workflowPromotion.last_transition_at),
    lifecycle_state: firstString(semanticForgetting.lifecycle_state, slots.lifecycle_state),
    semantic_forgetting_action: firstString(semanticForgetting.action),
    archive_relocation_state: firstString(archiveRelocation.relocation_state),
    archive_relocation_target: firstString(archiveRelocation.relocation_target),
    archive_payload_scope: firstString(archiveRelocation.payload_scope),
    rehydration_default_mode: resolveNodeRehydrationDefaultMode(slots) ?? firstString(rehydration.default_mode),
    tool_set: resolveNodeToolSet({ slots }).slice(0, 16),
    maintenance_state: firstString(maintenance.maintenance_state),
    offline_priority: firstString(maintenance.offline_priority),
    last_maintenance_at: firstString(maintenance.last_maintenance_at),
    workflow_signature: resolveNodeWorkflowSignature({ slots }),
    task_signature: resolveNodeTaskSignature({ slots }),
    file_path: filePath,
    target_files: targetFiles,
    next_action: nextAction,
    workflow_steps: workflowSteps,
    pattern_hints: patternHints,
    service_lifecycle_constraints: serviceLifecycleConstraints,
    operator_override_present: operatorOverride !== null,
    suppressed,
    suppression_mode: operatorOverride?.mode ?? null,
    suppression_reason: operatorOverride?.reason ?? null,
    suppressed_until: operatorOverride?.until ?? null,
    suppressed_by: operatorOverride?.updated_by ?? null,
    suppressed_at: operatorOverride?.updated_at ?? null,
    projection_generated_by: projectionMeta?.generated_by ?? null,
    projection_source_node_id: projectionMeta?.source_node_id ?? null,
    projection_source_client_id: projectionMeta?.source_client_id ?? null,
    projection_generated_at: projectionMeta?.generated_at ?? null,
    projection_auto_promoted: projectionMeta?.auto_promoted ?? false,
    distillation_origin: firstString(distillation.distillation_origin),
    preferred_promotion_target: firstString(distillation.preferred_promotion_target),
    confidence: row.confidence,
  };
}

function toPatternEntry(row: LiteExecutionNativeNodeRow, tenantId: string, scope: string) {
  const slots = asRecord(row.slots);
  const patternSurface = resolveNodePatternExecutionSurface({ slots });
  const executionContract = resolveNodeExecutionContract({ slots });
  const outcomeContractGate = buildOutcomeContractGate({
    executionContract,
    requestedTrust: patternSurface.contract_trust,
  });
  const trustHardening = patternSurface.trust_hardening ?? {};
  const maintenance = patternSurface.maintenance ?? {};
  const operatorOverride = readPatternOperatorOverride(slots);
  const suppressed = isPatternSuppressed(operatorOverride);
  const credibilityState = patternSurface.credibility_state ?? "candidate";
  const title = firstString(row.title);
  const summary = firstString(row.text_summary, resolveNodeAnchorSummary(slots));
  const authorityVisibility = buildRuntimeAuthorityVisibilityFromSlots({
    nodeId: row.id,
    nodeKind: "pattern",
    title: title ?? summary,
    slots,
  });
  const executionEvidenceAssessment = optionalRecord(slots.execution_evidence_assessment);
  const authorityDecisionReport = buildEntryAuthorityDecisionReport({
    subject: `pattern:${row.id}`,
    outcomeContractGate,
    executionEvidenceAssessment,
    authorityVisibility,
    trustedPatternOnlyVisible: credibilityState === "trusted",
    policyDefaultAttempted: credibilityState === "trusted",
    stablePromotionAllowedOverride: false,
  });
  const distinctRunCount = Number(patternSurface.promotion.distinct_run_count ?? Number.NaN);
  const requiredDistinctRuns = Number(patternSurface.promotion.required_distinct_runs ?? Number.NaN);
  const counterEvidenceCount = Number(patternSurface.promotion.counter_evidence_count ?? Number.NaN);
  const counterEvidenceOpen = patternSurface.promotion.counter_evidence_open;
  return {
    anchor_id: row.id,
    uri: toNodeUri(tenantId, scope, row.type, row.id),
    type: row.type,
    title,
    summary,
    anchor_level: patternSurface.anchor_level,
    execution_contract_v1: executionContract,
    contract_trust: patternSurface.contract_trust,
    outcome_contract_gate: outcomeContractGate,
    ...(executionEvidenceAssessment ? { execution_evidence_assessment: executionEvidenceAssessment } : {}),
    authority_visibility: authorityVisibility,
    authority_decision_report: authorityDecisionReport,
    selected_tool: patternSurface.selected_tool,
    task_family: patternSurface.task_family,
    error_family: patternSurface.error_family ?? resolveNodeErrorFamily(slots),
    pattern_state: patternSurface.pattern_state ?? "provisional",
    credibility_state: credibilityState,
    trusted: credibilityState === "trusted",
    operator_override_present: operatorOverride !== null,
    suppressed,
    suppression_mode: operatorOverride?.mode ?? null,
    suppression_reason: operatorOverride?.reason ?? null,
    suppressed_until: operatorOverride?.until ?? null,
    suppressed_by: operatorOverride?.updated_by ?? null,
    suppressed_at: operatorOverride?.updated_at ?? null,
    distinct_run_count: Number.isFinite(distinctRunCount) ? distinctRunCount : null,
    required_distinct_runs: Number.isFinite(requiredDistinctRuns) ? requiredDistinctRuns : null,
    trust_hardening: Object.keys(trustHardening).length > 0 ? trustHardening : null,
    counter_evidence_count: Number.isFinite(counterEvidenceCount) ? counterEvidenceCount : null,
    counter_evidence_open: counterEvidenceOpen,
    last_transition: patternSurface.promotion.last_transition,
    maintenance_state: firstString(maintenance.maintenance_state),
    offline_priority: firstString(maintenance.offline_priority),
    last_maintenance_at: firstString(maintenance.last_maintenance_at),
    confidence: row.confidence,
  };
}

function toPatternSignal(entry: ReturnType<typeof toPatternEntry>) {
  return {
    anchor_id: entry.anchor_id,
    anchor_level: entry.anchor_level,
    selected_tool: entry.selected_tool,
    task_family: entry.task_family,
    error_family: entry.error_family,
    pattern_state: entry.pattern_state,
    credibility_state: entry.credibility_state,
    trusted: entry.trusted,
    suppressed: entry.suppressed,
    suppression_mode: entry.suppression_mode,
    suppression_reason: entry.suppression_reason,
    suppressed_until: entry.suppressed_until,
    distinct_run_count: entry.distinct_run_count,
    required_distinct_runs: entry.required_distinct_runs,
    trust_hardening: entry.trust_hardening,
    counter_evidence_count: entry.counter_evidence_count,
    counter_evidence_open: entry.counter_evidence_open,
    last_transition: entry.last_transition,
    summary: entry.summary,
  };
}

function toWorkflowSignal(entry: ReturnType<typeof toWorkflowEntry>) {
  return {
    anchor_id: entry.anchor_id,
    anchor_level: entry.anchor_level,
    title: entry.title,
    summary: entry.summary,
    promotion_state: entry.promotion_state === "stable" ? "stable" : "candidate",
    promotion_ready: entry.promotion_ready,
    observed_count: entry.observed_count,
    required_observations: entry.required_observations,
    source_kind: entry.source_kind,
    execution_outcome_role: entry.execution_outcome_role,
    promotion_origin: entry.promotion_origin,
    last_transition: entry.last_transition,
    maintenance_state: entry.maintenance_state,
    offline_priority: entry.offline_priority,
    last_maintenance_at: entry.last_maintenance_at,
    outcome_contract_gate: entry.outcome_contract_gate,
    authority_visibility: entry.authority_visibility,
  };
}

function buildOutcomeContractGateSummary(gates: OutcomeContractGate[]) {
  const reasonCounts: Record<string, number> = {};
  for (const gate of gates) {
    for (const reason of gate.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  return {
    summary_version: "outcome_contract_gate_summary_v1" as const,
    sufficient_count: gates.filter((gate) => gate.status === "sufficient").length,
    insufficient_count: gates.filter((gate) => gate.status === "insufficient").length,
    authoritative_allowed_count: gates.filter((gate) => gate.allows_authoritative).length,
    authoritative_blocked_count: gates.filter(
      (gate) => gate.requested_trust === "authoritative" && !gate.allows_authoritative,
    ).length,
    service_lifecycle_gap_count: gates.filter(
      (gate) =>
        gate.reasons.includes("missing_must_hold_after_exit")
        || gate.reasons.includes("missing_external_visibility_requirements"),
    ).length,
    reason_counts: reasonCounts,
  };
}

function toPolicyMemoryEntry(
  row: Awaited<ReturnType<LiteWriteStore["findNodes"]>>["rows"][number],
  tenantId: string,
  scope: string,
) {
  const slots = asRecord(row.slots);
  const contract = asRecord(slots.policy_contract_v1);
  const executionContract = resolveNodeExecutionContract({ slots });
  const outcomeContractGate = buildOutcomeContractGate({
    executionContract,
    requestedTrust: executionContract?.contract_trust ?? contract?.contract_trust,
  });
  const authorityVisibility = buildRuntimeAuthorityVisibilityFromSlots({
    nodeId: row.id,
    nodeKind: "policy_memory",
    title: firstString(row.title, row.text_summary),
    slots,
  });
  const maintenance = resolveNodeMaintenanceSurface(slots) ?? {};
  const policySurface = resolveNodePolicyMemorySurface(slots);
  return {
    kind: "policy_memory",
    summary_kind: "policy_memory",
    anchor_id: row.id,
    node_id: row.id,
    uri: toNodeUri(tenantId, scope, row.type, row.id),
    title: firstString(row.title),
    summary: firstString(row.text_summary),
    execution_contract_v1: executionContract,
    outcome_contract_gate: outcomeContractGate,
    ...(optionalRecord(slots.authority_gate_v1) ? { authority_gate_v1: optionalRecord(slots.authority_gate_v1) } : {}),
    ...(optionalRecord(slots.execution_evidence_assessment) ? { execution_evidence_assessment: optionalRecord(slots.execution_evidence_assessment) } : {}),
    authority_visibility: authorityVisibility,
    selected_tool: resolveNodeSelectedTool({ slots }),
    workflow_signature: resolveNodeWorkflowSignature({ slots }),
    file_path: resolveNodeFilePath({ slots }),
    target_files: resolveNodeTargetFiles({ slots }),
    task_signature: resolveNodeTaskSignature({ slots }),
    error_signature: resolveNodeErrorSignature(slots),
    feedback_positive: Number.isFinite(Number(slots.feedback_positive)) ? Number(slots.feedback_positive) : null,
    feedback_negative: Number.isFinite(Number(slots.feedback_negative)) ? Number(slots.feedback_negative) : null,
    feedback_quality: Number.isFinite(Number(slots.feedback_quality)) ? Number(slots.feedback_quality) : null,
    last_feedback_at: firstString(slots.last_feedback_at),
    last_materialized_at: firstString(slots.last_materialized_at),
    policy_memory_state: policySurface.policy_memory_state,
    policy_state: policySurface.policy_state,
    policy_source_kind: policySurface.policy_source_kind,
    activation_mode: policySurface.activation_mode,
    materialization_state: policySurface.materialization_state,
    maintenance_state: firstString(maintenance?.maintenance_state),
    offline_priority: firstString(maintenance?.offline_priority),
    last_maintenance_at: firstString(maintenance?.last_maintenance_at),
    last_transition: policySurface.last_transition,
    policy_contract_v1: contract ?? null,
    derived_policy_v1: asRecord(slots.derived_policy_v1) ?? null,
    confidence: row.confidence,
  };
}

function toDistillationEntry(
  row: Awaited<ReturnType<LiteWriteStore["findNodes"]>>["rows"][number],
  tenantId: string,
  scope: string,
) {
  const slots = asRecord(row.slots);
  const distillation = resolveNodeDistillationSurface(slots) ?? {};
  const maintenance = resolveNodeMaintenanceSurface(slots) ?? {};
  return {
    kind: firstString(resolveNodeExecutionKind(slots), resolveNodeSummaryKind(slots), row.type) ?? "unknown",
    summary_kind: resolveNodeSummaryKind(slots),
    node_id: row.id,
    uri: toNodeUri(tenantId, scope, row.type, row.id),
    title: firstString(row.title),
    summary: firstString(row.text_summary),
    compression_layer: resolveNodeCompressionLayer({ type: row.type, slots }),
    distillation_origin: firstString(distillation.distillation_origin),
    preferred_promotion_target: firstString(distillation.preferred_promotion_target),
    extraction_pattern: firstString(distillation.extraction_pattern),
    source_node_id: firstString(distillation.source_node_id, slots.source_node_id),
    source_evidence_node_id: firstString(distillation.source_evidence_node_id, slots.source_evidence_node_id),
    has_execution_signature: distillation.has_execution_signature === true,
    last_transition: firstString(distillation.last_transition),
    maintenance_state: firstString(maintenance.maintenance_state),
    offline_priority: firstString(maintenance.offline_priority),
    confidence: row.confidence,
  };
}

function toContinuityEntry(
  row: Awaited<ReturnType<LiteWriteStore["findNodes"]>>["rows"][number],
  tenantId: string,
  scope: string,
) {
  const slots = asRecord(row.slots);
  const executionContract = resolveNodeExecutionContract({ slots });
  const summaryKind = resolveNodeSummaryKind(slots);
  return {
    kind: "continuity_carrier",
    execution_contract_v1: executionContract,
    summary_kind: summaryKind,
    execution_kind: resolveNodeExecutionKind(slots),
    node_id: row.id,
    uri: toNodeUri(tenantId, scope, row.type, row.id),
    title: firstString(row.title),
    summary: firstString(row.text_summary),
    compression_layer: resolveNodeCompressionLayer({ type: row.type, slots }),
    file_path: resolveNodeFilePath({ slots }),
    target_files: resolveNodeTargetFiles({ slots }),
    next_action: resolveNodeNextAction({ slots }),
    confidence: row.confidence,
  };
}

function buildOperatorSurface(args: {
  workflowSignalSummary: ReturnType<typeof summarizeWorkflowSignalSurface>;
  patternSignalSummary: ReturnType<typeof summarizePatternSignalSurface>;
  workflowMaintenanceSummary: ReturnType<typeof summarizeWorkflowMaintenanceSurface>;
  patternMaintenanceSummary: ReturnType<typeof summarizePatternMaintenanceSurface>;
  recommendedWorkflows: Array<ReturnType<typeof toWorkflowEntry>>;
  candidateWorkflows: Array<ReturnType<typeof toWorkflowEntry>>;
  trustedPatterns: Array<ReturnType<typeof toPatternEntry>>;
  candidatePatterns: Array<ReturnType<typeof toPatternEntry>>;
  contestedPatterns: Array<ReturnType<typeof toPatternEntry>>;
}) {
  const workflowLines = [
    ...args.recommendedWorkflows.slice(0, 6).map((entry) => {
      const title = entry.title ?? entry.summary ?? entry.anchor_id;
      const tools = Array.isArray(entry.tool_set) && entry.tool_set.length > 0 ? `; tools=${entry.tool_set.join(", ")}` : "";
      const distillation = entry.distillation_origin
        ? `; distillation=${entry.distillation_origin}; target=${entry.preferred_promotion_target ?? "unknown"}`
        : "";
      const projection = entry.projection_generated_by
        ? `; projection=${entry.projection_generated_by}; source_node=${entry.projection_source_node_id ?? "unknown"}`
        : "";
      return `stable workflow: ${title}; source=${entry.source_kind ?? "unknown"}${distillation}${tools}${projection}; transition=${entry.last_transition ?? "unknown"}; maintenance=${entry.maintenance_state ?? "unknown"}`;
    }),
    ...args.candidateWorkflows.slice(0, 6).map((entry) => {
      const title = entry.title ?? entry.summary ?? entry.anchor_id;
      const observed = (
        Number.isFinite(entry.observed_count ?? Number.NaN)
        && Number.isFinite(entry.required_observations ?? Number.NaN)
      )
        ? `observed=${entry.observed_count}/${entry.required_observations}`
        : "observed=unknown";
      const source = entry.source_kind ? `; source=${entry.source_kind}` : "";
      const distillation = entry.distillation_origin
        ? `; distillation=${entry.distillation_origin}; target=${entry.preferred_promotion_target ?? "unknown"}`
        : "";
      const tools = Array.isArray(entry.tool_set) && entry.tool_set.length > 0 ? `; tools=${entry.tool_set.join(", ")}` : "";
      const projection = entry.projection_generated_by
        ? `; projection=${entry.projection_generated_by}; source_node=${entry.projection_source_node_id ?? "unknown"}`
        : "";
      return `candidate workflow: ${title}; ${observed}${source}${distillation}${tools}${projection}; promotion=${entry.promotion_ready ? "ready" : "observing"}; maintenance=${entry.maintenance_state ?? "unknown"}`;
    }),
  ];
  const patternLines = [
    ...args.trustedPatterns.slice(0, 6).map((entry) => `trusted pattern: prefer ${entry.selected_tool ?? "unknown"}; task_family=${entry.task_family ?? "unknown"}; summary=${entry.summary ?? entry.anchor_id}; maintenance=${entry.maintenance_state ?? "unknown"}${entry.suppressed ? `; suppressed=${entry.suppression_mode ?? "shadow_learn"}` : ""}`),
    ...args.candidatePatterns.slice(0, 6).map((entry) => `candidate pattern: prefer ${entry.selected_tool ?? "unknown"}; task_family=${entry.task_family ?? "unknown"}; summary=${entry.summary ?? entry.anchor_id}; maintenance=${entry.maintenance_state ?? "unknown"}${entry.suppressed ? `; suppressed=${entry.suppression_mode ?? "shadow_learn"}` : ""}`),
    ...args.contestedPatterns.slice(0, 6).map((entry) => `contested pattern: prefer ${entry.selected_tool ?? "unknown"}; task_family=${entry.task_family ?? "unknown"}; summary=${entry.summary ?? entry.anchor_id}; maintenance=${entry.maintenance_state ?? "unknown"}${entry.suppressed ? `; suppressed=${entry.suppression_mode ?? "shadow_learn"}` : ""}`),
  ];
  const maintenanceLines = [
    `workflow maintenance: retain=${args.workflowMaintenanceSummary.retain_count}; observe=${args.workflowMaintenanceSummary.observe_count}; promote_candidate=${args.workflowMaintenanceSummary.promote_candidate_count}`,
    `pattern maintenance: retain=${args.patternMaintenanceSummary.retain_count}; observe=${args.patternMaintenanceSummary.observe_count}; review=${args.patternMaintenanceSummary.review_count}; promote_candidate=${args.patternMaintenanceSummary.promote_candidate_count}`,
  ];
  const headline = [
    `stable workflows=${args.workflowSignalSummary.stable_workflow_count}`,
    `promotion-ready workflows=${args.workflowSignalSummary.promotion_ready_workflow_count}`,
    `trusted patterns=${args.patternSignalSummary.trusted_pattern_count}`,
    `contested patterns=${args.patternSignalSummary.contested_pattern_count}`,
  ].join("; ");
  const mergedText = [
    `# Execution Memory Operator Surface`,
    headline,
    workflowLines.length > 0 ? `# Workflows\n${workflowLines.map((line) => `- ${line}`).join("\n")}` : "",
    patternLines.length > 0 ? `# Patterns\n${patternLines.map((line) => `- ${line}`).join("\n")}` : "",
    `# Maintenance\n${maintenanceLines.map((line) => `- ${line}`).join("\n")}`,
  ].filter(Boolean).join("\n");
  return {
    surface_version: "execution_memory_operator_v1" as const,
    headline,
    sections: {
      workflows: workflowLines,
      patterns: patternLines,
      maintenance: maintenanceLines,
    },
    merged_text: mergedText,
  };
}

export async function buildExecutionMemoryIntrospectionLite(
  liteWriteStore: LiteWriteStore,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  defaultActorId: string,
): Promise<ExecutionMemoryIntrospectionResponse> {
  const parsed = ExecutionMemoryIntrospectionRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope;
  const scopeKey = tenancy.scope_key;
  const tenantId = tenancy.tenant_id;
  const consumerAgentId = parsed.consumer_agent_id ?? defaultActorId;
  const consumerTeamId = parsed.consumer_team_id ?? null;
  const limit = parsed.limit;

  const [
    workflowAnchors,
    workflowCandidates,
    patternAnchors,
    recentSourceEvents,
    recentSessions,
    delegationRecordRows,
    policyMemoryNodes,
    distilledEvidenceNodes,
    distilledFactNodes,
  ] = await Promise.all([
    liteWriteStore.findExecutionNativeNodes({
      scope: scopeKey,
      executionKind: "workflow_anchor",
      consumerAgentId,
      consumerTeamId,
      limit,
      offset: 0,
    }),
    liteWriteStore.findExecutionNativeNodes({
      scope: scopeKey,
      executionKind: "workflow_candidate",
      consumerAgentId,
      consumerTeamId,
      limit,
      offset: 0,
    }),
    liteWriteStore.findExecutionNativeNodes({
      scope: scopeKey,
      executionKind: "pattern_anchor",
      consumerAgentId,
      consumerTeamId,
      limit,
      offset: 0,
    }),
    liteWriteStore.findNodes({
      scope: scopeKey,
      type: "event",
      consumerAgentId,
      consumerTeamId,
      limit: Math.max(limit * 4, 24),
      offset: 0,
    }),
    liteWriteStore.findNodes({
      scope: scopeKey,
      type: "topic",
      consumerAgentId,
      consumerTeamId,
      limit: Math.max(limit * 2, 12),
      offset: 0,
    }),
    listRecentDelegationRecordNodeRowsLite({
      liteWriteStore,
      scope: scopeKey,
      consumerAgentId,
      consumerTeamId,
      limit: Math.max(limit, 4),
    }),
    liteWriteStore.findNodes({
      scope: scopeKey,
      type: "concept",
      consumerAgentId,
      consumerTeamId,
      limit: Math.max(limit, 8),
      offset: 0,
      slotsContains: {
        summary_kind: "policy_memory",
      },
    }),
    liteWriteStore.findNodes({
      scope: scopeKey,
      type: "evidence",
      consumerAgentId,
      consumerTeamId,
      limit: Math.max(limit, 8),
      offset: 0,
      slotsContains: {
        summary_kind: "write_distillation_evidence",
      },
    }),
    liteWriteStore.findNodes({
      scope: scopeKey,
      type: "concept",
      consumerAgentId,
      consumerTeamId,
      limit: Math.max(limit, 8),
      offset: 0,
      slotsContains: {
        summary_kind: "write_distillation_fact",
      },
    }),
  ]);

  const rawRecommendedWorkflows = dedupeByAnchorId(
    workflowAnchors.rows.map((row) => toWorkflowEntry(row, tenantId, scope)),
  );
  const demotedRecommendedWorkflows = rawRecommendedWorkflows.filter(
    (entry) => !entry.suppressed && executionOutcomeRoleBlocksDirectUse(entry.execution_outcome_role),
  );
  const recommendedWorkflows = rawRecommendedWorkflows.filter(
    (entry) => !entry.suppressed && !executionOutcomeRoleBlocksDirectUse(entry.execution_outcome_role),
  );
  const stableWorkflowSignatures = new Set(
    recommendedWorkflows
      .map((entry) => entry.workflow_signature)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const rawCandidateWorkflowsAll = dedupeByAnchorId(
    [
      ...workflowCandidates.rows.map((row) => toWorkflowEntry(row, tenantId, scope)),
      ...demotedRecommendedWorkflows,
    ],
  );
  const rawCandidateWorkflows = rawCandidateWorkflowsAll.filter((entry) => !entry.suppressed);
  const candidateWorkflows = dedupeWorkflowCandidatesBySignature(
    rawCandidateWorkflows.filter((entry) => !entry.workflow_signature || !stableWorkflowSignatures.has(entry.workflow_signature)),
  );
  const suppressedCandidateWorkflowCount =
    (rawRecommendedWorkflows.length - recommendedWorkflows.length)
    + (rawCandidateWorkflowsAll.length - candidateWorkflows.length);
  const continuityProjectedCandidateCount = rawCandidateWorkflows.filter(
    (entry) => entry.projection_generated_by === "execution_write_projection_v1",
  ).length;
  const continuityAutoPromotedWorkflowCount = recommendedWorkflows.filter(
    (entry) => entry.projection_generated_by === "execution_write_projection_v1" || entry.promotion_origin === "execution_write_auto_promotion",
  ).length;

  const patternEntries = dedupeByAnchorId(
    patternAnchors.rows.map((row) => toPatternEntry(row, tenantId, scope)),
  );
  const candidatePatterns = patternEntries.filter((entry) => entry.credibility_state === "candidate");
  const trustedPatterns = patternEntries.filter((entry) => entry.credibility_state === "trusted");
  const contestedPatterns = patternEntries.filter((entry) => entry.credibility_state === "contested" || entry.counter_evidence_open === true);
  const authorityDecisionReport = combineAuthorityDecisionReports([
    ...recommendedWorkflows.map((entry) => entry.authority_decision_report),
    ...candidateWorkflows.map((entry) => entry.authority_decision_report),
    ...trustedPatterns.map((entry) => entry.authority_decision_report),
  ]);

  const rehydrationCandidates = recommendedWorkflows
    .filter((entry) => entry.rehydration_default_mode)
    .map((entry) => ({
      anchor_id: entry.anchor_id,
      anchor_uri: entry.uri,
      anchor_kind: "workflow",
      anchor_level: entry.anchor_level,
      title: entry.title,
      summary: entry.summary,
      mode: entry.rehydration_default_mode,
      payload_cost_hint: "medium",
      recommended_when: [],
      trusted: false,
      selected_tool: null,
      example_call: `rehydrate_payload(anchor_id='${entry.anchor_id}', mode='${entry.rehydration_default_mode}')`,
    }));
  const patternSignals = patternEntries.map((entry) => toPatternSignal(entry));
  const workflowSignals = [
    ...recommendedWorkflows.map((entry) => toWorkflowSignal(entry)),
    ...candidateWorkflows.map((entry) => toWorkflowSignal(entry)),
  ];
  const distillationKnowledge = [
    ...distilledEvidenceNodes.rows.map((row) => toDistillationEntry(row, tenantId, scope)),
    ...distilledFactNodes.rows.map((row) => toDistillationEntry(row, tenantId, scope)),
  ];
  const continuitySourceNodes = [
    ...recentSourceEvents.rows.filter((row) => !hasWorkflowProjectionMarker(asRecord(row.slots))),
    ...recentSessions.rows.filter((row) => {
      if (hasWorkflowProjectionMarker(asRecord(row.slots))) return false;
      return firstString(asRecord(row.slots)?.system_kind) === "session";
    }),
  ].slice(0, Math.max(limit * 2, 12));
  const continuityKnowledge = continuitySourceNodes
    .map((row) => toContinuityEntry(row, tenantId, scope))
    .filter((entry) => entry.summary_kind === "handoff" || entry.summary_kind === "session_event" || entry.summary_kind === "session");
  const supportingKnowledge = [
    ...continuityKnowledge,
    ...policyMemoryNodes.rows.map((row) => toPolicyMemoryEntry(row, tenantId, scope)),
    ...distillationKnowledge,
  ];
  const outcomeContractGateSummary = buildOutcomeContractGateSummary([
    ...recommendedWorkflows.map((entry) => entry.outcome_contract_gate),
    ...candidateWorkflows.map((entry) => entry.outcome_contract_gate),
    ...patternEntries.map((entry) => entry.outcome_contract_gate),
    ...supportingKnowledge
      .map((entry) => asRecord(entry).outcome_contract_gate)
      .filter((entry): entry is OutcomeContractGate => asRecord(entry).gate_version === "outcome_contract_gate_v1"),
  ]);
  const surface = {
    action_recall_packet: {
      packet_version: "action_recall_v1" as const,
      recommended_workflows: recommendedWorkflows,
      candidate_workflows: candidateWorkflows,
      candidate_patterns: candidatePatterns,
      trusted_patterns: trustedPatterns,
      contested_patterns: contestedPatterns,
      rehydration_candidates: rehydrationCandidates,
      supporting_knowledge: supportingKnowledge,
    },
    recommended_workflows: recommendedWorkflows,
    candidate_workflows: candidateWorkflows,
    candidate_patterns: candidatePatterns,
    trusted_patterns: trustedPatterns,
    contested_patterns: contestedPatterns,
    rehydration_candidates: rehydrationCandidates,
    supporting_knowledge: supportingKnowledge,
    pattern_signals: patternSignals,
    workflow_signals: workflowSignals,
  };
  const summaryBundle = buildExecutionMemorySummaryBundle(surface);
  const continuityProjectionSamples = await Promise.all(
    continuitySourceNodes.map(async (row) => {
      const explained = await explainWorkflowProjectionForSourceNode({
        scope: scopeKey,
        source: {
          id: row.id,
          client_id: row.client_id ?? undefined,
          scope: scopeKey,
          type: row.type,
          memory_lane: row.memory_lane,
          producer_agent_id: row.producer_agent_id ?? undefined,
          owner_agent_id: row.owner_agent_id ?? undefined,
          owner_team_id: row.owner_team_id ?? undefined,
          title: row.title ?? undefined,
          text_summary: row.text_summary ?? undefined,
          slots: asRecord(row.slots),
        },
        liteWriteStore,
      });
      return {
        source_node_id: row.id,
        source_client_id: row.client_id,
        title: firstString(row.title, row.text_summary),
        decision: explained.decision,
        workflow_signature: explained.workflowSignature,
        projection_client_id: explained.projectionClientId,
      };
    }),
  );
  const continuityDecisionCounts = {
    projected: continuityProjectionSamples.filter((sample) => sample.decision === "projected").length,
    skipped_missing_execution_continuity: continuityProjectionSamples.filter((sample) => sample.decision === "skipped_missing_execution_continuity").length,
    skipped_invalid_execution_state: continuityProjectionSamples.filter((sample) => sample.decision === "skipped_invalid_execution_state").length,
    skipped_invalid_execution_packet: continuityProjectionSamples.filter((sample) => sample.decision === "skipped_invalid_execution_packet").length,
    skipped_existing_workflow_memory: continuityProjectionSamples.filter((sample) => sample.decision === "skipped_existing_workflow_memory").length,
    skipped_stable_exists: continuityProjectionSamples.filter((sample) => sample.decision === "skipped_stable_exists").length,
    eligible_without_projection: continuityProjectionSamples.filter((sample) => sample.decision === "eligible_without_projection").length,
  };
  const operatorSurface = buildOperatorSurface({
    workflowSignalSummary: summaryBundle.workflow_signal_summary,
    patternSignalSummary: summaryBundle.pattern_signal_summary,
    workflowMaintenanceSummary: summaryBundle.workflow_maintenance_summary,
    patternMaintenanceSummary: summaryBundle.pattern_maintenance_summary,
    recommendedWorkflows,
    candidateWorkflows,
    trustedPatterns,
    candidatePatterns,
    contestedPatterns,
  });
  const executionSummary = ExecutionSummaryV1Schema.parse(buildExecutionSummarySurface({
    planner_packet: null,
    surface,
    packet_assembly: null,
    tools: null,
    cost_signals: null,
    delegation_records: delegationRecordRows,
  }));
  const policyMutations = collectPolicyMutationsFromRows([
    ...workflowAnchors.rows,
    ...workflowCandidates.rows,
    ...policyMemoryNodes.rows,
    ...recentSourceEvents.rows,
  ]);
  const cognitiveStructure = buildCognitiveStructureV1({
    tenant_id: tenantId,
    scope,
    execution_summary: executionSummary,
    policy_mutations: policyMutations,
  });

  return {
    summary_version: "execution_memory_introspection_v1",
    tenant_id: tenantId,
    scope,
    inventory: {
      raw_workflow_anchor_count: workflowAnchors.rows.length,
      raw_workflow_candidate_count: rawCandidateWorkflows.length,
      suppressed_candidate_workflow_count: suppressedCandidateWorkflowCount,
      continuity_projected_candidate_count: continuityProjectedCandidateCount,
      continuity_auto_promoted_workflow_count: continuityAutoPromotedWorkflowCount,
      raw_pattern_anchor_count: patternAnchors.rows.length,
      raw_distilled_evidence_count: distilledEvidenceNodes.rows.length,
      raw_distilled_fact_count: distilledFactNodes.rows.length,
    },
    continuity_projection_report: {
      sampled_source_event_count: continuityProjectionSamples.length,
      decision_counts: continuityDecisionCounts,
      samples: continuityProjectionSamples.slice(0, Math.max(Math.min(limit, 8), 4)),
    },
    operator_surface: operatorSurface,
    execution_summary: executionSummary,
    cognitive_structure_v1: cognitiveStructure,
    recommended_workflows: recommendedWorkflows,
    candidate_workflows: candidateWorkflows,
    candidate_patterns: candidatePatterns,
    trusted_patterns: trustedPatterns,
    contested_patterns: contestedPatterns,
    rehydration_candidates: rehydrationCandidates,
    supporting_knowledge: supportingKnowledge,
    pattern_signals: patternSignals,
    workflow_signals: workflowSignals,
    outcome_contract_gate_summary: outcomeContractGateSummary,
    authority_decision_report: authorityDecisionReport,
    ...summaryBundle,
  };
}
