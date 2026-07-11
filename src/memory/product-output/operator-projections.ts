import {
  AionisAgentContextSchema,
  AionisEffectReportSchema,
  AionisGuidePacketSchema,
  AionisClaimLedgerProjectionSchema,
  AionisMemoryDecisionAuditReportSchema,
  AionisMemoryDecisionTraceSchema,
  parseAionisMemoryAdmissionRecord,
  parseAionisMemoryUseReceipt,
  parseAionisOperatorSnapshot,
  type AionisAgentContext,
  type AionisClaimLedgerProjection,
  type AionisEffectReport,
  type AionisGuidePacket,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisMemoryUseReceipt,
  type AionisOperatorSnapshot,
  AionisMemoryAdmissionRecordSchema,
  AionisMemoryUseReceiptSchema,
  AionisOperatorSnapshotSchema,
  parseAionisAgentFlightRecorderReport,
  type AionisAgentFlightRecorderReport,
  type AionisClaimLedgerProjectionItem,
  type AionisClaimLedgerProjectionSurface,
  type AionisMemoryAdmissionClosedLoopEffectState,
  type AionisMemoryAdmissionShadowPolicyReport,
  type AionisMemoryDecisionSurface,
  type AionisMemoryPacket,
} from "../product-output-contract.js";
import {
  buildAionisMemoryAdmissionRecordFromDecisionTrace,
  buildAionisMemoryUseReceiptFromDecisionTrace,
  buildAionisMemoryAdmissionShadowPolicyReport,
  type AionisMemoryAdmissionShadowPolicyReportInput,
} from "./decision-trace.js";
import {
  type ClaimLedgerRow,
} from "../../store/memory-store.js";

export type BuildAionisOperatorSnapshotArgs = {
  tenant_id: string;
  scope: string;
  run_id?: string | null;
  task_signature?: string | null;
  task_family?: string | null;
  workflow_signature?: string | null;
  agent_context?: unknown;
  guide_packet?: unknown;
  memory_decision_trace?: unknown;
  memory_decision_audit?: unknown;
  effect_report?: unknown;
  claim_ledger_projection?: unknown;
  execution_context?: unknown;
  guide_trace_id?: string | null;
  source_map?: Partial<AionisOperatorSnapshot["source_map"]>;
};

type OperatorEntrySource = AionisOperatorSnapshot["execution_state"]["active_path"]["entries"][number]["source"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  const next = typeof value === "string" ? value.trim() : "";
  return next.length > 0 ? next : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactStrings(values: unknown[], limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = stringValue(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueStrings(values: string[], limit = 128): string[] {
  return compactStrings(values, limit);
}

function premiseFirewallRiskFlags(reasons: string[]): string[] {
  return reasons.some((reason) => reason.startsWith("premise_firewall_"))
    ? ["premise_firewall_query_risk"]
    : [];
}

function memoryContractRiskFlags(reasons: string[]): string[] {
  return reasons.some((reason) => reason.startsWith("memory_contract_"))
    ? ["memory_contract_risk"]
    : [];
}

function parseAgentContext(value: unknown): AionisAgentContext | null {
  const direct = AionisAgentContextSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisAgentContextSchema.safeParse(asRecord(value).agent_context);
  return nested.success ? nested.data : null;
}

function parseGuidePacket(value: unknown): AionisGuidePacket | null {
  const parsed = AionisGuidePacketSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseTrace(value: unknown): AionisMemoryDecisionTrace | null {
  const direct = AionisMemoryDecisionTraceSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisMemoryDecisionTraceSchema.safeParse(asRecord(value).memory_decision_trace);
  return nested.success ? nested.data : null;
}

function memoryAdmissionRecordFromTrace(trace: AionisMemoryDecisionTrace | null): AionisMemoryAdmissionRecord | undefined {
  if (!trace) return undefined;
  return parseAionisMemoryAdmissionRecord(
    trace.admission_record ?? buildAionisMemoryAdmissionRecordFromDecisionTrace(trace),
  );
}

function parseAudit(value: unknown): AionisMemoryDecisionAuditReport | null {
  const direct = AionisMemoryDecisionAuditReportSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisMemoryDecisionAuditReportSchema.safeParse(asRecord(value).memory_decision_audit);
  return nested.success ? nested.data : null;
}

function parseEffect(value: unknown): AionisEffectReport | null {
  const direct = AionisEffectReportSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisEffectReportSchema.safeParse(asRecord(value).effect_report);
  return nested.success ? nested.data : null;
}

function parseClaimLedgerProjection(value: unknown): AionisClaimLedgerProjection | null {
  const direct = AionisClaimLedgerProjectionSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisClaimLedgerProjectionSchema.safeParse(asRecord(value).claim_ledger_projection);
  return nested.success ? nested.data : null;
}

function sourceEntriesFromObjects(
  values: unknown,
  source: OperatorEntrySource,
  limit: number,
): AionisOperatorSnapshot["execution_state"]["active_path"]["entries"] {
  if (!Array.isArray(values)) return [];
  const out: AionisOperatorSnapshot["execution_state"]["active_path"]["entries"] = [];
  for (const item of values) {
    const record = asRecord(item);
    const entryId = stringValue(record.id)
      ?? stringValue(record.node_id)
      ?? stringValue(record.memory_id)
      ?? stringValue(record.client_id)
      ?? stringValue(record.summary_node_id)
      ?? stringValue(record.ref)
      ?? `${source}-${out.length + 1}`;
    const summary = stringValue(record.summary)
      ?? stringValue(record.text_summary)
      ?? stringValue(record.observation)
      ?? stringValue(record.action)
      ?? stringValue(record.title)
      ?? JSON.stringify(record).slice(0, 300);
    if (!summary) continue;
    out.push({
      entry_id: entryId,
      title: stringValue(record.title),
      summary,
      source,
      memory_ids: compactStrings([
        record.memory_id,
        ...(Array.isArray(record.memory_ids) ? record.memory_ids : []),
      ], 16),
      evidence_refs: compactStrings([
        record.evidence_ref,
        record.raw_ref,
        ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : []),
        ...(Array.isArray(record.supporting_raw_refs) ? record.supporting_raw_refs : []),
      ], 16),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function sourceEntriesFromStrings(
  values: string[],
  source: OperatorEntrySource,
  prefix: string,
  memoryIds: string[] = [],
): AionisOperatorSnapshot["execution_state"]["active_path"]["entries"] {
  return values.slice(0, 12).map((entry, index) => ({
    entry_id: `${prefix}-${index + 1}`,
    title: null,
    summary: entry,
    source,
    memory_ids: memoryIds[index] ? [memoryIds[index]!] : [],
    evidence_refs: [],
  }));
}

function currentActivePathEntries(executionContext: Record<string, unknown>, agentContext: AionisAgentContext | null) {
  const active = asRecord(executionContext.current_active_path);
  const compressedState = sourceEntriesFromObjects(active.compressed_state, "execution_context", 12);
  if (compressedState.length > 0) return compressedState;
  return sourceEntriesFromStrings(agentContext?.use_now ?? [], "agent_context", "active", agentContext?.use_now_memory_ids ?? []);
}

function passedSolutionEntries(executionContext: Record<string, unknown>, agentContext: AionisAgentContext | null) {
  const passed = sourceEntriesFromObjects(executionContext.passed_solutions, "execution_context", 12);
  if (passed.length > 0) return passed;
  return sourceEntriesFromStrings(agentContext?.use_now ?? [], "agent_context", "passed", agentContext?.use_now_memory_ids ?? []);
}

function failedBranchEntries(executionContext: Record<string, unknown>, agentContext: AionisAgentContext | null) {
  const failed = sourceEntriesFromObjects(executionContext.failed_branches, "execution_context", 12);
  if (failed.length > 0) return failed;
  return sourceEntriesFromStrings(agentContext?.do_not_use ?? [], "agent_context", "failed", agentContext?.do_not_use_memory_ids ?? []);
}

type OperatorExecutionEntry = AionisOperatorSnapshot["execution_state"]["active_path"]["entries"][number];

function operatorEntryRefs(entry: OperatorExecutionEntry): string[] {
  const inlineNodeRefs = Array.from(entry.summary.matchAll(/\bnode=([^\s|,]+)/g), (match) => match[1]);
  return compactStrings([
    entry.entry_id,
    ...entry.memory_ids,
    ...inlineNodeRefs,
  ], 32);
}

function normalizedOperatorEntrySummary(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function failedLeakage(args: {
  directUseEntries: OperatorExecutionEntry[];
  directUseMemoryIds: string[];
  failedEntries: AionisOperatorSnapshot["execution_state"]["failed_branches"]["entries"];
}): boolean {
  const directUseRefs = new Set(compactStrings([
    ...args.directUseMemoryIds,
    ...args.directUseEntries.flatMap(operatorEntryRefs),
  ], 256));
  const directUseSummaries = new Set(
    args.directUseEntries
      .map((entry) => normalizedOperatorEntrySummary(entry.summary))
      .filter((summary) => summary.length > 0),
  );
  return args.failedEntries.some((entry) => {
    if (operatorEntryRefs(entry).some((ref) => directUseRefs.has(ref))) return true;
    const summary = normalizedOperatorEntrySummary(entry.summary);
    return summary.length > 0 && directUseSummaries.has(summary);
  });
}

function taskFromInputs(args: {
  run_id?: string | null;
  task_signature?: string | null;
  task_family?: string | null;
  workflow_signature?: string | null;
  guide: AionisGuidePacket | null;
  effect: AionisEffectReport | null;
  agent: AionisAgentContext | null;
}): AionisOperatorSnapshot["task"] {
  return {
    run_id: args.run_id ?? args.guide?.task.run_id ?? args.effect?.task.run_id ?? null,
    task_signature: args.task_signature ?? args.guide?.task.task_signature ?? args.effect?.task.task_signature ?? null,
    task_family: args.task_family ?? args.guide?.task.task_family ?? args.effect?.task.task_family ?? null,
    workflow_signature: args.workflow_signature ?? null,
    agent_role: args.agent?.agent_role ?? "agent",
  };
}

function sourceMapFromInputs(args: {
  source_map?: Partial<AionisOperatorSnapshot["source_map"]>;
  guide: AionisGuidePacket | null;
  trace: AionisMemoryDecisionTrace | null;
  audit: AionisMemoryDecisionAuditReport | null;
  traceToProcedurePresent?: boolean;
  claimLedgerProjectionPresent?: boolean;
}) {
  return {
    routes_used: uniqueStrings([
      ...(args.source_map?.routes_used ?? []),
      ...(args.guide?.source_map.routes_used ?? []),
      ...(args.trace?.source_map.routes_used ?? []),
      ...(args.audit?.source_map.routes_used ?? []),
    ]),
    internal_surfaces_used: uniqueStrings([
      ...(args.source_map?.internal_surfaces_used ?? []),
      "operator_snapshot",
      ...(args.guide ? ["guide_packet"] : []),
      ...(args.trace ? ["memory_decision_trace"] : []),
      "memory_use_receipt",
      ...(args.trace ? ["memory_admission_record"] : []),
      ...(args.audit ? ["memory_decision_audit_report"] : []),
      ...(args.trace?.judgment_calibration_summary.window.record_count
          || args.audit?.judgment_calibration_review.window.record_count
        ? ["judgment_calibration_summary"]
        : []),
      ...(args.traceToProcedurePresent ? ["trace_to_procedure_projection"] : []),
      ...(args.claimLedgerProjectionPresent ? ["claim_ledger_projection"] : []),
    ]),
    omitted_internal_surfaces: uniqueStrings([
      ...(args.source_map?.omitted_internal_surfaces ?? []),
      "raw_memory_rows",
      "raw_slots",
      "raw_embedding_vectors",
      "agent_prompt_injection",
    ]),
  };
}

function consolidationGuardFromTrace(
  trace: AionisMemoryDecisionTrace | null,
  executionContext: Record<string, unknown>,
): AionisOperatorSnapshot["memory_lifecycle"]["consolidation_guard"] {
  const selectionTrace = asRecord(executionContext.selection_trace);
  const promptText = String(executionContext.prompt_text ?? "");
  const promotionBlockedCount = Math.max(
    numberValue(selectionTrace.memory_consolidation_guard_blocked_count) ?? 0,
    (promptText.match(/promotion_blocked=/g) ?? []).length,
  );
  const supportingOnlyCount = Math.max(
    numberValue(selectionTrace.supporting_only_count) ?? 0,
    (promptText.match(/SUPPORTING_EVIDENCE/g) ?? []).length,
  );
  const candidateOnlyCount = trace?.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary.candidate_inspect_before_use_memory_ids.length ?? 0;
  return {
    supporting_only_count: supportingOnlyCount,
    candidate_only_count: candidateOnlyCount,
    promotion_blocked_count: promotionBlockedCount,
    reason: promotionBlockedCount > 0 || candidateOnlyCount > 0
      ? "Consolidated or candidate memory stayed outside stable direct-use authority."
      : "No consolidation guard intervention was visible in the supplied snapshot inputs.",
  };
}

function isProcedureDecision(decision: AionisMemoryDecisionTrace["memory_decisions"][number]): boolean {
  return decision.domain === "execution"
    || decision.memory_type === "procedure"
    || decision.memory_type === "execution_memory";
}

function buildTraceToProcedureProjection(args: {
  activePathEntries: AionisOperatorSnapshot["execution_state"]["active_path"]["entries"];
  passedSolutionEntries: AionisOperatorSnapshot["execution_state"]["passed_solutions"]["entries"];
  failedBranchEntries: AionisOperatorSnapshot["execution_state"]["failed_branches"]["entries"];
  guide: AionisGuidePacket | null;
  trace: AionisMemoryDecisionTrace | null;
  effect: AionisEffectReport | null;
  agent: AionisAgentContext | null;
  consolidationGuard: AionisOperatorSnapshot["memory_lifecycle"]["consolidation_guard"];
  promotionDeniedReasons: string[];
}): AionisOperatorSnapshot["trace_to_procedure"] {
  const executionEntries = [
    ...args.activePathEntries,
    ...args.passedSolutionEntries,
    ...args.failedBranchEntries,
  ];
  const procedureDecisions = (args.trace?.memory_decisions ?? []).filter(isProcedureDecision);
  const guideWorkflowCandidates = args.guide?.guidance.workflow_candidates ?? [];
  const replayEvidenceVisible =
    args.guide?.history_contributions.replay.used === true
    || args.effect?.history_contributions.replay.used === true
    || (args.effect?.evidence.replay_run_ids.length ?? 0) > 0;
  const promotionEvidenceVisible =
    (args.effect?.evidence.promotion_quality_summary_ids.length ?? 0) > 0
    || (args.effect?.training_candidates.length ?? 0) > 0
    || args.promotionDeniedReasons.length > 0
    || args.consolidationGuard.promotion_blocked_count > 0;
  const workflowIds = uniqueStrings([
    ...(args.agent?.evidence_refs.workflow_ids ?? []),
    ...guideWorkflowCandidates.map((entry) => entry.workflow_id),
    ...(args.effect?.learning_effect.promoted_workflow_ids ?? []),
    ...(args.effect?.learning_effect.candidate_workflow_ids ?? []),
  ], 48);
  const procedureMemoryIds = uniqueStrings([
    ...procedureDecisions.map((entry) => entry.memory_id),
    ...executionEntries.flatMap((entry) => entry.memory_ids),
  ], 48);
  const evidenceRefs = uniqueStrings([
    ...procedureDecisions.flatMap((entry) => entry.evidence_ids),
    ...executionEntries.flatMap((entry) => entry.evidence_refs),
    ...(args.effect?.evidence.evidence_ids ?? []),
    ...(args.effect?.evidence.replay_run_ids ?? []),
    ...(args.effect?.evidence.signal_summary_ids ?? []),
    ...(args.effect?.evidence.promotion_quality_summary_ids ?? []),
    ...(args.guide?.history_contributions.handoff.source_ids ?? []),
    ...(args.guide?.history_contributions.replay.source_ids ?? []),
  ], 64);
  const sourceSurfaces = uniqueStrings([
    executionEntries.length > 0 ? "execution_tree" : "",
    guideWorkflowCandidates.length > 0 || workflowIds.length > 0 ? "workflow_projection" : "",
    replayEvidenceVisible ? "replay_playbook" : "",
    workflowIds.length > 0 || procedureMemoryIds.length > 0 ? "execution_contract" : "",
    procedureDecisions.length > 0 ? "memory_decision_trace" : "",
    promotionEvidenceVisible ? "promotion_evidence" : "",
  ], 8) as AionisOperatorSnapshot["trace_to_procedure"]["source_surfaces"];
  const stableReuseVisible =
    guideWorkflowCandidates.some((entry) => entry.authority === "trusted")
    || (args.effect?.learning_effect.promoted_workflow_ids.length ?? 0) > 0
    || procedureDecisions.some((entry) => entry.authority === "trusted" && entry.agent_surface === "use_now");
  const candidateVisible =
    executionEntries.length > 0
    || procedureMemoryIds.length > 0
    || guideWorkflowCandidates.some((entry) => entry.authority === "candidate" || entry.authority === "advisory")
    || (args.effect?.learning_effect.candidate_workflow_ids.length ?? 0) > 0;
  const promotionBlockedCount = Math.max(
    args.consolidationGuard.promotion_blocked_count,
    args.promotionDeniedReasons.length,
  );
  const present = sourceSurfaces.length > 0;
  const promotionStatus: AionisOperatorSnapshot["trace_to_procedure"]["promotion_status"] = !present
    ? "not_applicable"
    : promotionBlockedCount > 0
      ? "blocked"
      : stableReuseVisible
        ? "stable_ready"
        : candidateVisible
          ? "candidate_only"
          : "insufficient_evidence";
  const reason = !present
    ? "No execution trace, workflow projection, replay, decision trace, or promotion evidence was supplied."
    : promotionStatus === "blocked"
      ? "Procedure evidence is visible, but stable promotion remains blocked by learning-control or consolidation evidence gates."
      : promotionStatus === "stable_ready"
        ? "Stable workflow or procedure reuse is visible through existing execution-memory surfaces."
        : promotionStatus === "candidate_only"
          ? "Trace-derived procedure evidence is visible as candidate or advisory reuse, not stable direct-use authority."
          : "Execution-memory evidence is visible, but it is not sufficient to claim reusable procedure readiness.";

  return {
    present,
    runtime_mutation: false,
    source_surfaces: sourceSurfaces,
    procedure_memory_ids: procedureMemoryIds,
    workflow_ids: workflowIds,
    evidence_refs: evidenceRefs,
    candidate_visible: candidateVisible,
    stable_reuse_visible: stableReuseVisible,
    promotion_status: promotionStatus,
    promotion_blocked_count: promotionBlockedCount,
    reason,
  };
}

function buildClaims(args: {
  activeCount: number;
  passedCount: number;
  failedCount: number;
  failedVisible: boolean;
  leaked: boolean;
  guideTracePresent: boolean;
  feedbackPresent: boolean;
  learningControlVisible: boolean;
  memoryUseReceipt: AionisMemoryUseReceipt;
  judgmentCalibration?: AionisOperatorSnapshot["judgment_calibration"] | null;
  traceToProcedure: AionisOperatorSnapshot["trace_to_procedure"];
  claimLedgerProjection: AionisClaimLedgerProjection | null;
  effect: AionisEffectReport | null;
}): AionisOperatorSnapshot["claims"] {
  return [
    {
      claim: "active_path_visible",
      status: args.activeCount > 0 || args.passedCount > 0 ? "pass" : "not_applicable",
      evidence: `${args.activeCount} active path entries and ${args.passedCount} passed solution entries are visible.`,
    },
    {
      claim: "failed_branch_isolated",
      status: args.failedCount === 0 ? "not_applicable" : args.failedVisible && !args.leaked ? "pass" : "fail",
      evidence: `${args.failedCount} failed branch entries; leaked_to_use_now=${args.leaked}.`,
    },
    {
      claim: "feedback_attribution_visible",
      status: args.feedbackPresent ? "pass" : args.guideTracePresent ? "warning" : "not_applicable",
      evidence: args.feedbackPresent
        ? "Guide trace feedback attribution is present."
        : args.guideTracePresent
          ? "Guide trace is present, but no activate feedback attribution was supplied."
          : "No guide trace was supplied.",
    },
    {
      claim: "learning_control_visible",
      status: args.learningControlVisible ? "pass" : "not_applicable",
      evidence: args.learningControlVisible
        ? "Memory decision trace or audit reports learning-control-visible state."
        : "No learning-control surface was visible in supplied inputs.",
    },
    {
      claim: "memory_use_receipt_visible",
      status: "pass",
      evidence: `Receipt exposes ${args.memoryUseReceipt.exposed_memory_ids.length} memory ids; agent_prompt_included=${args.memoryUseReceipt.agent_prompt_included}.`,
    },
    {
      claim: "judgment_calibration_visible",
      status: (args.judgmentCalibration?.window.record_count ?? 0) > 0 ? "pass" : "not_applicable",
      evidence: args.judgmentCalibration
        ? `Judgment calibration summarizes ${args.judgmentCalibration.window.record_count} read-only records; authority=${args.judgmentCalibration.authority}.`
        : "No judgment calibration summary was supplied.",
    },
    {
      claim: "trace_to_procedure_visible",
      status: args.traceToProcedure.present ? "pass" : "not_applicable",
      evidence: args.traceToProcedure.present
        ? `Trace-to-procedure projection sees ${args.traceToProcedure.source_surfaces.join(", ")}; promotion_status=${args.traceToProcedure.promotion_status}.`
        : "No trace-to-procedure source surfaces were supplied.",
    },
    {
      claim: "claim_ledger_projection_visible",
      status: args.claimLedgerProjection ? "pass" : "not_applicable",
      evidence: args.claimLedgerProjection
        ? `Claim Ledger projection exposes ${args.claimLedgerProjection.use_now.length} use_now, ${args.claimLedgerProjection.inspect_before_use.length} inspect, ${args.claimLedgerProjection.do_not_use.length} do_not_use, and ${args.claimLedgerProjection.audit_only.length} audit_only claims.`
        : "No Claim Ledger projection was supplied.",
    },
    {
      claim: "runtime_read_only",
      status: "pass",
      evidence: "Operator snapshot is a read-only projection and does not mutate runtime state.",
    },
    {
      claim: "effect_measured",
      status: args.effect ? "pass" : "not_applicable",
      evidence: args.effect
        ? `Effect report impact_direction=${args.effect.history_impact.impact_direction}.`
        : "No effect report was supplied.",
    },
  ];
}

function buildFallbackMemoryUseReceipt(args: {
  guideTraceId: string | null;
  agent: AionisAgentContext | null;
  guide: AionisGuidePacket | null;
}): AionisMemoryUseReceipt {
  const useNowMemoryIds = uniqueStrings([
    ...(args.agent?.use_now_memory_ids ?? []),
    ...(args.guide?.memory_lifecycle.used_memory_ids ?? []),
  ]);
  const inspectBeforeUseMemoryIds = uniqueStrings(args.agent?.inspect_before_use_memory_ids ?? []);
  const doNotUseMemoryIds = uniqueStrings([
    ...(args.agent?.do_not_use_memory_ids ?? []),
    ...(args.guide?.memory_lifecycle.suppressed_memory_ids ?? []),
  ]);
  const rehydrateMemoryIds = uniqueStrings([
    ...(args.agent?.rehydrate_hints.map((hint) => hint.memory_id) ?? []),
    ...(args.guide?.guide_brief.rehydrate.map((hint) => hint.memory_id) ?? []),
  ]);
  const exposedMemoryIds = uniqueStrings([
    ...(args.agent?.memory_ids ?? []),
    ...useNowMemoryIds,
    ...inspectBeforeUseMemoryIds,
    ...doNotUseMemoryIds,
    ...rehydrateMemoryIds,
  ]);
  const historyUsed = args.agent?.history_used ?? args.guide?.guide_brief.history_used ?? false;
  const actionableHistoryUsed =
    args.agent?.actionable_history_used
    ?? args.guide?.guide_brief.actionable_history_used
    ?? exposedMemoryIds.length > 0;
  const negativeTransferRisk =
    args.agent?.risk.negative_transfer_risk
    ?? args.guide?.risk.negative_transfer_risk
    ?? "low";
  const riskReasons = uniqueStrings([
    ...(args.agent?.risk.reasons ?? []),
    ...(args.guide?.risk.reasons ?? []),
  ]);

  return parseAionisMemoryUseReceipt({
    contract_version: "aionis_memory_use_receipt_v1",
    intended_use: "memory_use_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: args.guideTraceId,
    history_used: historyUsed,
    actionable_history_used: actionableHistoryUsed,
    prompt_char_count: args.agent?.prompt_text.length ?? 0,
    exposed_memory_ids: exposedMemoryIds,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
    do_not_use_memory_ids: doNotUseMemoryIds,
    rehydrate_memory_ids: rehydrateMemoryIds,
    attributed_memory_ids: [],
    unattributed_recalled_memory_ids: [],
    read_only_signal_memory_ids: [],
    risk_flags: uniqueStrings([
      negativeTransferRisk !== "low" ? `negative_transfer_risk:${negativeTransferRisk}` : "",
      ...riskReasons,
      ...premiseFirewallRiskFlags(riskReasons),
      ...memoryContractRiskFlags(riskReasons),
    ]),
    summary: `Aionis compiled memory into ${useNowMemoryIds.length} use_now, ${inspectBeforeUseMemoryIds.length} inspect_before_use, ${doNotUseMemoryIds.length} do_not_use, and ${rehydrateMemoryIds.length} rehydrate decisions; receipt is read-only and excluded from the Agent prompt.`,
  });
}

export function buildAionisOperatorSnapshot(args: BuildAionisOperatorSnapshotArgs): AionisOperatorSnapshot {
  const guide = parseGuidePacket(args.guide_packet);
  const effect = parseEffect(args.effect_report);
  const trace = parseTrace(args.memory_decision_trace);
  const audit = parseAudit(args.memory_decision_audit);
  const claimLedgerProjection = parseClaimLedgerProjection(args.claim_ledger_projection)
    ?? parseClaimLedgerProjection(args.agent_context)
    ?? parseClaimLedgerProjection(args.guide_packet);
  const executionContext = asRecord(args.execution_context);
  const agent = parseAgentContext(args.agent_context) ?? parseAgentContext(executionContext);
  const activePathEntries = currentActivePathEntries(executionContext, agent);
  const passedSolutionEntriesValue = passedSolutionEntries(executionContext, agent);
  const failedBranchEntriesValue = failedBranchEntries(executionContext, agent);
  const directUseEntries = [
    ...activePathEntries,
    ...passedSolutionEntriesValue,
    ...sourceEntriesFromStrings(agent?.use_now ?? [], "agent_context", "direct-use", agent?.use_now_memory_ids ?? []),
  ];
  const doNotUseText = [...(agent?.do_not_use ?? []), ...failedBranchEntriesValue.map((entry) => entry.summary)].join("\n");
  const leaked = failedLeakage({
    directUseEntries,
    directUseMemoryIds: agent?.use_now_memory_ids ?? [],
    failedEntries: failedBranchEntriesValue,
  });
  const failedVisibleInDoNotUse = failedBranchEntriesValue.length > 0 && doNotUseText.trim().length > 0;
  const branchStatus = failedBranchEntriesValue.length === 0 ? "not_applicable" : failedVisibleInDoNotUse && !leaked ? "pass" : "fail";
  const feedbackAttribution = trace?.feedback_attribution;
  const auditCounters = audit?.counters;
  const directUseCount = trace?.summary.direct_use_count ?? agent?.use_now.length ?? guide?.guide_brief.use_now.length ?? 0;
  const inspectCount = trace?.summary.inspect_before_use_count ?? agent?.inspect_before_use.length ?? guide?.guide_brief.inspect_before_use.length ?? 0;
  const doNotUseCount = trace?.summary.do_not_use_count ?? agent?.do_not_use.length ?? guide?.guide_brief.do_not_use.length ?? 0;
  const rehydrateCount = trace?.summary.rehydrate_count ?? agent?.rehydrate_hints.length ?? guide?.guide_brief.rehydrate.length ?? 0;
  const controlledMemoryCount = auditCounters?.controlled_memory_count ?? inspectCount + doNotUseCount + rehydrateCount;
  const blockedOrSuppressedCount = audit?.risks.blocked_or_suppressed_count
    ?? trace?.memory_decisions.filter((entry) =>
      entry.agent_surface === "do_not_use"
      || entry.lifecycle_state === "suppressed"
      || entry.lifecycle_state === "archived"
      || entry.authority === "blocked"
    ).length
    ?? 0;
  const learningControlVisible = trace?.summary.learning_control_visible === true
    || audit?.verdict === "learning_control_visible";
  const candidateLearning = trace?.feedback_attribution.sparse_feedback_signal_summary.candidate_learning_control_summary
    ?? audit?.feedback_signal_review.candidate_learning_control_summary
    ?? null;
  const promotionDeniedReasons = uniqueStrings([
    ...(guide?.risk.reasons ?? []),
    ...(effect?.learning_effect.promotion_denied_reasons ?? []),
  ], 16);
  const consolidationGuard = consolidationGuardFromTrace(trace, executionContext);
  const attributedIds = uniqueStrings(feedbackAttribution?.attributed_memory_ids ?? []);
  const exposedIds = uniqueStrings(agent?.memory_ids ?? guide?.memory_lifecycle.used_memory_ids ?? []);
  const guideTraceId = args.guide_trace_id ?? feedbackAttribution?.guide_trace_id ?? null;
  const memoryUseReceipt = trace?.memory_use_receipt
    ?? (trace
      ? buildAionisMemoryUseReceiptFromDecisionTrace(trace)
      : buildFallbackMemoryUseReceipt({ guideTraceId, agent, guide }));
  const memoryAdmissionRecord = memoryAdmissionRecordFromTrace(trace);
  const judgmentCalibration = trace?.judgment_calibration_summary
    ?? audit?.judgment_calibration_review
    ?? null;
  const actionableHistoryUsed =
    agent?.actionable_history_used
    ?? guide?.guide_brief.actionable_history_used
    ?? trace?.summary.actionable_history_used
    ?? (activePathEntries.length > 0 || passedSolutionEntriesValue.length > 0 || failedBranchEntriesValue.length > 0);
  const traceToProcedure = buildTraceToProcedureProjection({
    activePathEntries,
    passedSolutionEntries: passedSolutionEntriesValue,
    failedBranchEntries: failedBranchEntriesValue,
    guide,
    trace,
    effect,
    agent,
    consolidationGuard,
    promotionDeniedReasons,
  });

  return parseAionisOperatorSnapshot({
    contract_version: "aionis_operator_snapshot_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    intended_use: "operator_snapshot",
    agent_prompt_included: false,
    runtime_mutation: false,
    task: taskFromInputs({
      run_id: args.run_id,
      task_signature: args.task_signature,
      task_family: args.task_family,
      workflow_signature: args.workflow_signature,
      guide,
      effect,
      agent,
    }),
    execution_state: {
      history_used: agent?.history_used ?? guide?.guide_brief.history_used ?? false,
      actionable_history_used: actionableHistoryUsed,
      recommended_posture: agent?.recommended_posture ?? guide?.guide_brief.recommended_posture ?? "ignore_history",
      authority: agent?.authority ?? guide?.guide_brief.authority ?? "none",
      active_path: {
        count: activePathEntries.length,
        entries: activePathEntries,
      },
      passed_solutions: {
        count: passedSolutionEntriesValue.length,
        entries: passedSolutionEntriesValue,
      },
      failed_branches: {
        count: failedBranchEntriesValue.length,
        entries: failedBranchEntriesValue,
      },
      branch_isolation: {
        active_path_visible: activePathEntries.length > 0,
        passed_solution_visible: passedSolutionEntriesValue.length > 0,
        failed_branch_visible_in_do_not_use: failedVisibleInDoNotUse,
        failed_branch_leaked_to_use_now: leaked,
        status: branchStatus,
        reason: branchStatus === "pass"
          ? "Failed branches are visible as avoidance context and absent from direct-use active context."
          : branchStatus === "fail"
            ? "A failed branch was either missing from do_not_use or appeared in direct-use context."
            : "No failed branch evidence was supplied.",
      },
    },
    trace_to_procedure: traceToProcedure,
    guide_trace: {
      present: !!guideTraceId || !!trace?.feedback_attribution.present,
      guide_trace_id: guideTraceId,
      exposed_memory_ids: exposedIds,
      use_now_memory_ids: agent?.use_now_memory_ids ?? [],
      inspect_before_use_memory_ids: agent?.inspect_before_use_memory_ids ?? [],
      do_not_use_memory_ids: agent?.do_not_use_memory_ids ?? [],
      attributed_memory_ids: attributedIds,
      unattributed_memory_ids: uniqueStrings(feedbackAttribution?.unattributed_recalled_memory_ids ?? []),
      feedback_attribution_present: feedbackAttribution?.present === true,
      feedback_outcome: feedbackAttribution?.outcome ?? null,
      reason: feedbackAttribution?.present === true
        ? "Feedback attribution is tied to an exposed guide trace."
        : guideTraceId
          ? "Guide trace exists, but feedback attribution was not supplied."
          : "No guide trace was supplied.",
    },
    judgment_calibration: judgmentCalibration ?? undefined,
    memory_use_receipt: memoryUseReceipt,
    memory_admission_record: memoryAdmissionRecord,
    claim_ledger_projection: claimLedgerProjection ?? undefined,
    memory_lifecycle: {
      used_count: directUseCount,
      inspect_before_use_count: inspectCount,
      do_not_use_count: doNotUseCount,
      rehydrate_count: rehydrateCount,
      controlled_memory_count: controlledMemoryCount,
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      stale_memory_count: trace?.summary ? 0 : guide?.risk.stale_memory_count ?? 0,
      learning_control_visible: learningControlVisible,
      consolidation_guard: consolidationGuard,
    },
    learning_control: {
      visible: learningControlVisible || !!candidateLearning?.present,
      runtime_mutation: false,
      stable_promotion_allowed: effect ? effect.learning_effect.promotion_denied_reasons.length === 0 : null,
      candidate_count: candidateLearning?.candidate_inspect_before_use_memory_ids.length
        ?? effect?.learning_effect.candidate_workflow_ids.length
        ?? 0,
      blocked_authority_count: guide?.risk.blocked_authority_count
        ?? effect?.learning_effect.blocked_authority_ids.length
        ?? 0,
      promotion_denied_reasons: promotionDeniedReasons,
      reason: learningControlVisible || candidateLearning?.present
        ? "Learning-control state is visible without granting runtime mutation authority."
        : "No learning-control state was supplied.",
    },
    effect: {
      present: !!effect,
      impact_direction: effect?.history_impact.impact_direction ?? null,
      changed_future_behavior: effect?.history_impact.changed_future_behavior ?? null,
      token_delta: effect?.efficiency.token_delta ?? null,
      context_size_delta: effect?.efficiency.context_size_delta ?? null,
      repeated_discovery_delta: effect?.efficiency.repeated_discovery_delta ?? null,
      reason: effect?.history_impact.explanation ?? "No effect report was supplied.",
    },
    claims: buildClaims({
      activeCount: activePathEntries.length,
      passedCount: passedSolutionEntriesValue.length,
      failedCount: failedBranchEntriesValue.length,
      failedVisible: failedVisibleInDoNotUse,
      leaked,
      guideTracePresent: !!guideTraceId,
      feedbackPresent: feedbackAttribution?.present === true,
      learningControlVisible,
      memoryUseReceipt,
      judgmentCalibration,
      traceToProcedure,
      claimLedgerProjection,
      effect,
    }),
    risks: {
      negative_transfer_risk: trace?.summary.negative_transfer_risk
        ?? audit?.risks.negative_transfer_risk
        ?? agent?.risk.negative_transfer_risk
        ?? guide?.risk.negative_transfer_risk
        ?? "low",
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      unresolved_inspection_count: audit?.risks.unresolved_inspection_count ?? inspectCount,
      reasons: uniqueStrings([
        ...(audit?.risks.reasons ?? []),
        ...(agent?.risk.reasons ?? []),
        ...(guide?.risk.reasons ?? []),
      ], 16),
    },
    source_map: sourceMapFromInputs({
      source_map: args.source_map,
      guide,
      trace,
      audit,
      traceToProcedurePresent: traceToProcedure.present,
      claimLedgerProjectionPresent: claimLedgerProjection !== null,
    }),
  });
}

export function renderAionisOperatorSnapshotMarkdown(snapshot: AionisOperatorSnapshot): string {
  const claimLines = snapshot.claims.map((claim) => `- ${claim.claim}: ${claim.status} - ${claim.evidence}`);
  const active = snapshot.execution_state.active_path.entries.slice(0, 5).map((entry) => `- ${entry.summary}`);
  const failed = snapshot.execution_state.failed_branches.entries.slice(0, 5).map((entry) => `- ${entry.summary}`);
  const claimLedger = snapshot.claim_ledger_projection
    ? [
        `contract_version: ${snapshot.claim_ledger_projection.contract_version}`,
        `use_now: ${snapshot.claim_ledger_projection.use_now.map((entry) => entry.claim_id).join(", ") || "none"}`,
        `inspect_before_use: ${snapshot.claim_ledger_projection.inspect_before_use.map((entry) => entry.claim_id).join(", ") || "none"}`,
        `do_not_use: ${snapshot.claim_ledger_projection.do_not_use.map((entry) => entry.claim_id).join(", ") || "none"}`,
        `audit_only: ${snapshot.claim_ledger_projection.audit_only.map((entry) => entry.claim_id).join(", ") || "none"}`,
      ]
    : ["- none"];
  return [
    `# Aionis Operator Snapshot`,
    ``,
    `run_id: ${snapshot.task.run_id ?? "unknown"}`,
    `task_signature: ${snapshot.task.task_signature ?? "unknown"}`,
    `agent_role: ${snapshot.task.agent_role}`,
    ``,
    `## Execution State`,
    `branch_isolation: ${snapshot.execution_state.branch_isolation.status}`,
    `history_used: ${snapshot.execution_state.history_used}`,
    `actionable_history_used: ${snapshot.execution_state.actionable_history_used}`,
    `recommended_posture: ${snapshot.execution_state.recommended_posture}`,
    ``,
    `### Current Active Path`,
    ...(active.length ? active : ["- none"]),
    ``,
    `### Failed Branches`,
    ...(failed.length ? failed : ["- none"]),
    ``,
    `## Guide Trace`,
    `guide_trace_id: ${snapshot.guide_trace.guide_trace_id ?? "none"}`,
    `feedback_attribution_present: ${snapshot.guide_trace.feedback_attribution_present}`,
    `attributed_memory_ids: ${snapshot.guide_trace.attributed_memory_ids.join(", ") || "none"}`,
    ``,
    `## Memory Use Receipt`,
    `agent_prompt_included: ${snapshot.memory_use_receipt.agent_prompt_included}`,
    `runtime_mutation: ${snapshot.memory_use_receipt.runtime_mutation}`,
    `use_now_memory_ids: ${snapshot.memory_use_receipt.use_now_memory_ids.join(", ") || "none"}`,
    `do_not_use_memory_ids: ${snapshot.memory_use_receipt.do_not_use_memory_ids.join(", ") || "none"}`,
    ``,
    `## Memory Admission Record`,
    `present: ${!!snapshot.memory_admission_record}`,
    `candidate_memory_count: ${snapshot.memory_admission_record?.candidate_memory_count ?? 0}`,
    `prompt_included_memory_count: ${snapshot.memory_admission_record?.prompt_included_memory_count ?? 0}`,
    `agent_used_memory_count: ${snapshot.memory_admission_record?.agent_used_memory_count ?? 0}`,
    ``,
    `## Judgment Calibration`,
    `record_count: ${snapshot.judgment_calibration.window.record_count}`,
    `anchored_count: ${snapshot.judgment_calibration.window.anchored_count}`,
    `unused_count: ${snapshot.judgment_calibration.window.unused_count}`,
    `authority: ${snapshot.judgment_calibration.authority}`,
    ``,
    `## Trace to Procedure`,
    `present: ${snapshot.trace_to_procedure.present}`,
    `promotion_status: ${snapshot.trace_to_procedure.promotion_status}`,
    `source_surfaces: ${snapshot.trace_to_procedure.source_surfaces.join(", ") || "none"}`,
    `workflow_ids: ${snapshot.trace_to_procedure.workflow_ids.join(", ") || "none"}`,
    `procedure_memory_ids: ${snapshot.trace_to_procedure.procedure_memory_ids.join(", ") || "none"}`,
    ``,
    `## Claim Ledger Projection`,
    ...claimLedger,
    ``,
    `## Learning Control`,
    `visible: ${snapshot.learning_control.visible}`,
    `runtime_mutation: ${snapshot.learning_control.runtime_mutation}`,
    `candidate_count: ${snapshot.learning_control.candidate_count}`,
    ``,
    `## Effect`,
    `impact_direction: ${snapshot.effect.impact_direction ?? "not_supplied"}`,
    `changed_future_behavior: ${snapshot.effect.changed_future_behavior ?? "not_supplied"}`,
    ``,
    `## Claims`,
    ...claimLines,
  ].join("\n");
}

export type BuildAionisAgentFlightRecorderReportArgs = {
  tenant_id?: string | null;
  scope?: string | null;
  guide_trace_id?: string | null;
  run_id?: string | null;
  agent_context?: unknown;
  memory_decision_trace?: unknown;
  memory_use_receipt?: unknown;
  memory_admission_record?: unknown;
  claim_ledger_projection?: unknown;
  operator_snapshot?: unknown;
  feedback_result?: unknown;
  now?: string | null;
  source_map?: Partial<AionisAgentFlightRecorderReport["source_map"]>;
};

function flightAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function flightStringValue(value: unknown): string | null {
  const next = typeof value === "string" ? value.trim() : "";
  return next.length > 0 ? next : null;
}

function flightStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return flightCompactStrings(value);
}

function flightCompactStrings(values: unknown[], limit = 128): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = flightStringValue(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function parseFlightAgentContext(value: unknown): AionisAgentContext | null {
  const direct = AionisAgentContextSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisAgentContextSchema.safeParse(flightAsRecord(value).agent_context);
  return nested.success ? nested.data : null;
}

function parseFlightTrace(value: unknown): AionisMemoryDecisionTrace | null {
  const direct = AionisMemoryDecisionTraceSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisMemoryDecisionTraceSchema.safeParse(flightAsRecord(value).memory_decision_trace);
  return nested.success ? nested.data : null;
}

function parseFlightReceipt(value: unknown): AionisMemoryUseReceipt | null {
  const direct = AionisMemoryUseReceiptSchema.safeParse(value);
  if (direct.success) return direct.data;
  const record = flightAsRecord(value);
  const nested = AionisMemoryUseReceiptSchema.safeParse(record.memory_use_receipt);
  return nested.success ? nested.data : null;
}

function parseFlightAdmissionRecord(value: unknown): AionisMemoryAdmissionRecord | null {
  const direct = AionisMemoryAdmissionRecordSchema.safeParse(value);
  if (direct.success) return direct.data;
  const record = flightAsRecord(value);
  const nested = AionisMemoryAdmissionRecordSchema.safeParse(
    record.memory_admission_record ?? record.admission_record,
  );
  return nested.success ? nested.data : null;
}

function parseFlightSnapshot(value: unknown): AionisOperatorSnapshot | null {
  const direct = AionisOperatorSnapshotSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisOperatorSnapshotSchema.safeParse(flightAsRecord(value).operator_snapshot);
  return nested.success ? nested.data : null;
}

function parseFlightClaimLedgerProjection(value: unknown): AionisClaimLedgerProjection | null {
  const direct = AionisClaimLedgerProjectionSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisClaimLedgerProjectionSchema.safeParse(flightAsRecord(value).claim_ledger_projection);
  return nested.success ? nested.data : null;
}

function flightRunIdFromFeedback(value: unknown): string | null {
  const record = flightAsRecord(value);
  return flightStringValue(record.run_id) ?? flightStringValue(flightAsRecord(record.feedback_effect).run_id);
}

function flightOutcomeFromFeedback(value: unknown): "positive" | "negative" | "neutral" | null {
  const outcome = flightStringValue(flightAsRecord(value).outcome) ?? flightStringValue(flightAsRecord(flightAsRecord(value).feedback_effect).outcome);
  return outcome === "positive" || outcome === "negative" || outcome === "neutral" ? outcome : null;
}

function flightUsedIdsFromFeedback(value: unknown): string[] {
  const record = flightAsRecord(value);
  const effect = flightAsRecord(record.feedback_effect);
  return flightCompactStrings([
    ...flightStringArray(record.used_memory_ids),
    ...flightStringArray(record.memory_ids),
    ...flightStringArray(record.node_ids),
    ...flightStringArray(effect.used_memory_ids),
    ...flightStringArray(effect.affected_memory_ids),
  ]);
}

function flightReceiptFromInputs(args: {
  supplied: unknown;
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisMemoryUseReceipt | null {
  return parseFlightReceipt(args.supplied)
    ?? args.trace?.memory_use_receipt
    ?? args.snapshot?.memory_use_receipt
    ?? null;
}

function flightAdmissionRecordFromInputs(args: {
  supplied: unknown;
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisMemoryAdmissionRecord | null {
  return parseFlightAdmissionRecord(args.supplied)
    ?? args.trace?.admission_record
    ?? args.snapshot?.memory_admission_record
    ?? null;
}

function flightAgentViewFromInputs(args: {
  agent: AionisAgentContext | null;
  trace: AionisMemoryDecisionTrace | null;
  receipt: AionisMemoryUseReceipt | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisAgentFlightRecorderReport["agent_view"] {
  const rehydrateFromAgent = args.agent?.rehydrate_hints.map((entry) => entry.memory_id) ?? [];
  const exposedMemoryIds = flightCompactStrings([
    ...(args.receipt?.exposed_memory_ids ?? []),
    ...(args.snapshot?.guide_trace.exposed_memory_ids ?? []),
    ...(args.agent?.memory_ids ?? []),
    ...(args.trace?.context_decision.memory_ids ?? []),
  ]);
  const recallSourceMap = new Map<string, AionisAgentFlightRecorderReport["agent_view"]["recall_sources_by_memory_id"][number]>();
  for (const decision of args.trace?.memory_decisions ?? []) {
    if (decision.recall_sources.length === 0) continue;
    recallSourceMap.set(decision.memory_id, {
      memory_id: decision.memory_id,
      recall_sources: decision.recall_sources,
    });
  }
  for (const summary of args.receipt?.decision_summaries ?? []) {
    if (summary.recall_sources.length === 0 || recallSourceMap.has(summary.memory_id)) continue;
    recallSourceMap.set(summary.memory_id, {
      memory_id: summary.memory_id,
      recall_sources: summary.recall_sources,
    });
  }
  const exposedSet = new Set(exposedMemoryIds);
  return {
    history_used:
      args.receipt?.history_used
      ?? args.agent?.history_used
      ?? args.trace?.summary.history_used
      ?? args.snapshot?.execution_state.history_used
      ?? false,
    actionable_history_used:
      args.receipt?.actionable_history_used
      ?? args.agent?.actionable_history_used
      ?? args.trace?.summary.actionable_history_used
      ?? args.snapshot?.execution_state.actionable_history_used
      ?? false,
    recommended_posture:
      args.agent?.recommended_posture
      ?? args.trace?.summary.recommended_posture
      ?? args.snapshot?.execution_state.recommended_posture
      ?? "ignore_history",
    authority:
      args.agent?.authority
      ?? args.trace?.summary.authority
      ?? args.snapshot?.execution_state.authority
      ?? "none",
    prompt_char_count:
      args.receipt?.prompt_char_count
      ?? args.trace?.summary.prompt_char_count
      ?? args.trace?.context_decision.prompt_char_count
      ?? args.agent?.prompt_text.length
      ?? 0,
    prompt_text_included: false,
    exposed_memory_ids: exposedMemoryIds,
    use_now_memory_ids: flightCompactStrings([
      ...(args.receipt?.use_now_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.use_now_memory_ids ?? []),
      ...(args.agent?.use_now_memory_ids ?? []),
    ]),
    inspect_before_use_memory_ids: flightCompactStrings([
      ...(args.receipt?.inspect_before_use_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.inspect_before_use_memory_ids ?? []),
      ...(args.agent?.inspect_before_use_memory_ids ?? []),
    ]),
    do_not_use_memory_ids: flightCompactStrings([
      ...(args.receipt?.do_not_use_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.do_not_use_memory_ids ?? []),
      ...(args.agent?.do_not_use_memory_ids ?? []),
    ]),
    rehydrate_memory_ids: flightCompactStrings([
      ...(args.receipt?.rehydrate_memory_ids ?? []),
      ...rehydrateFromAgent,
    ]),
    target_files: flightCompactStrings([
      ...(args.agent?.target_files ?? []),
      ...(args.trace?.context_decision.target_files ?? []),
      ...(args.snapshot?.execution_state.active_path.entries.flatMap((entry) => entry.evidence_refs) ?? []),
    ]),
    recall_sources_by_memory_id: Array.from(recallSourceMap.values())
      .filter((entry) => exposedSet.size === 0 || exposedSet.has(entry.memory_id))
      .slice(0, 96),
  };
}

function flightBlockedOrSuppressedFromInputs(args: {
  trace: AionisMemoryDecisionTrace | null;
  admissionRecord: AionisMemoryAdmissionRecord | null;
  agentView: AionisAgentFlightRecorderReport["agent_view"];
}): AionisAgentFlightRecorderReport["blocked_or_suppressed"] {
  const fromTrace = args.trace?.memory_decisions
    .filter((entry) =>
      entry.agent_surface === "do_not_use"
      || entry.lifecycle_state === "suppressed"
      || entry.lifecycle_state === "archived"
      || entry.authority === "blocked"
    )
    .map((entry) => ({
      memory_id: entry.memory_id,
      title: entry.title,
      lifecycle_state: entry.lifecycle_state,
      authority: entry.authority,
      agent_surface: entry.agent_surface,
      reason_codes: entry.reason_codes,
      recall_sources: entry.recall_sources,
    })) ?? [];
  const fromAdmissionRecord = args.admissionRecord?.entries
    .filter((entry) =>
      entry.admission_action === "do_not_use"
      || entry.lifecycle_state === "suppressed"
      || entry.lifecycle_state === "archived"
      || entry.authority === "blocked"
    )
    .map((entry) => ({
      memory_id: entry.memory_id,
      title: entry.title,
      lifecycle_state: entry.lifecycle_state,
      authority: entry.authority,
      agent_surface: entry.admission_action,
      reason_codes: entry.reason_codes,
      recall_sources: entry.recall_sources,
    })) ?? [];
  const byId = new Map<string, AionisAgentFlightRecorderReport["blocked_or_suppressed"][number]>();
  for (const entry of [...fromTrace, ...fromAdmissionRecord]) byId.set(entry.memory_id, entry);
  for (const id of args.agentView.do_not_use_memory_ids) {
    if (byId.has(id)) continue;
    byId.set(id, {
      memory_id: id,
      title: null,
      lifecycle_state: "unknown",
      authority: "blocked",
      agent_surface: "do_not_use",
      reason_codes: ["agent_context_do_not_use"],
      recall_sources: [],
    });
  }
  return [...byId.values()];
}

function flightAttributionFromInputs(args: {
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
  feedback_result: unknown;
}): AionisAgentFlightRecorderReport["attribution"] {
  const traceAttribution = args.trace?.feedback_attribution;
  const feedbackUsedIds = flightUsedIdsFromFeedback(args.feedback_result);
  const outcome = traceAttribution?.outcome
    ?? args.snapshot?.guide_trace.feedback_outcome
    ?? flightOutcomeFromFeedback(args.feedback_result);
  const attributed = flightCompactStrings([
    ...(traceAttribution?.attributed_memory_ids ?? []),
    ...(args.snapshot?.guide_trace.attributed_memory_ids ?? []),
  ]);
  const usedMemoryIds = flightCompactStrings([
    ...feedbackUsedIds,
    ...attributed,
    ...(traceAttribution?.affected_memory_ids ?? []),
  ]);
  return {
    present: traceAttribution?.present === true
      || args.snapshot?.guide_trace.feedback_attribution_present === true
      || usedMemoryIds.length > 0
      || outcome !== null,
    outcome: outcome ?? null,
    used_memory_ids: usedMemoryIds,
    attributed_memory_ids: attributed,
    unattributed_memory_ids: flightCompactStrings([
      ...(traceAttribution?.unattributed_recalled_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.unattributed_memory_ids ?? []),
    ]),
    supported_memory_ids: flightCompactStrings(args.trace?.judgment_calibration_summary.supported_memory_ids ?? []),
    contradicted_memory_ids: flightCompactStrings([
      ...(args.trace?.judgment_calibration_summary.contradicted_memory_ids ?? []),
      ...(traceAttribution?.strong_counter_signal_memory_ids ?? []),
      ...(traceAttribution?.weak_counter_signal_memory_ids ?? []),
    ]),
    reason: traceAttribution?.reason
      ?? (usedMemoryIds.length > 0
        ? "Feedback result supplied used memory IDs for incident replay."
        : "No feedback attribution was supplied for this replay."),
  };
}

function flightSourceMapForReport(args: {
  supplied: Partial<AionisAgentFlightRecorderReport["source_map"]> | undefined;
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
  claimLedgerProjection: AionisClaimLedgerProjection | null;
}): AionisAgentFlightRecorderReport["source_map"] {
  return {
    routes_used: flightCompactStrings([
      ...(args.supplied?.routes_used ?? []),
      ...(args.trace?.source_map.routes_used ?? []),
      ...(args.snapshot?.source_map.routes_used ?? []),
    ]),
    internal_surfaces_used: flightCompactStrings([
      ...(args.supplied?.internal_surfaces_used ?? []),
      "agent_flight_recorder",
      ...(args.trace ? ["memory_decision_trace"] : []),
      ...(args.trace?.memory_use_receipt ? ["memory_use_receipt"] : []),
      ...(args.trace?.admission_record ? ["memory_admission_record"] : []),
      ...(args.snapshot ? ["operator_snapshot"] : []),
      ...(args.claimLedgerProjection ? ["claim_ledger_projection"] : []),
    ]),
    omitted_internal_surfaces: flightCompactStrings([
      ...(args.supplied?.omitted_internal_surfaces ?? []),
      "agent_prompt_text",
      "raw_memory_rows",
      "raw_slots",
      "raw_embedding_vectors",
    ]),
  };
}

export function buildAionisAgentFlightRecorderReport(
  args: BuildAionisAgentFlightRecorderReportArgs,
): AionisAgentFlightRecorderReport {
  const trace = parseFlightTrace(args.memory_decision_trace);
  const snapshot = parseFlightSnapshot(args.operator_snapshot);
  const claimLedgerProjection = parseFlightClaimLedgerProjection(args.claim_ledger_projection)
    ?? parseFlightClaimLedgerProjection(args.agent_context)
    ?? parseFlightClaimLedgerProjection(args.memory_decision_trace)
    ?? parseFlightClaimLedgerProjection(args.operator_snapshot)
    ?? snapshot?.claim_ledger_projection
    ?? null;
  const agent = parseFlightAgentContext(args.agent_context) ?? parseFlightAgentContext(args.memory_decision_trace);
  const receipt = flightReceiptFromInputs({
    supplied: args.memory_use_receipt,
    trace,
    snapshot,
  });
  const admissionRecord = flightAdmissionRecordFromInputs({
    supplied: args.memory_admission_record,
    trace,
    snapshot,
  });
  const agentView = flightAgentViewFromInputs({ agent, trace, receipt, snapshot });
  const blockedOrSuppressed = flightBlockedOrSuppressedFromInputs({ trace, admissionRecord, agentView });
  const attribution = flightAttributionFromInputs({
    trace,
    snapshot,
    feedback_result: args.feedback_result,
  });
  const guideTraceId = args.guide_trace_id
    ?? receipt?.guide_trace_id
    ?? trace?.feedback_attribution.guide_trace_id
    ?? snapshot?.guide_trace.guide_trace_id
    ?? null;
  const runId = args.run_id
    ?? trace?.feedback_attribution.run_id
    ?? snapshot?.task.run_id
    ?? flightRunIdFromFeedback(args.feedback_result)
    ?? null;
  const replaySources = {
    has_agent_context: agent !== null,
    has_memory_decision_trace: trace !== null,
    has_memory_use_receipt: receipt !== null,
    has_memory_admission_record: admissionRecord !== null,
    has_operator_snapshot: snapshot !== null,
    has_feedback_result: Object.keys(flightAsRecord(args.feedback_result)).length > 0,
  };
  const sourceMap = flightSourceMapForReport({
    supplied: args.source_map,
    trace,
    snapshot,
    claimLedgerProjection,
  });
  return parseAionisAgentFlightRecorderReport({
    contract_version: "aionis_agent_flight_recorder_report_v1",
    tenant_id: args.tenant_id?.trim() || trace?.tenant_id || snapshot?.tenant_id || agent?.tenant_id || "default",
    scope: args.scope?.trim() || trace?.scope || snapshot?.scope || agent?.scope || "default",
    intended_use: "incident_replay_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: guideTraceId,
    run_id: runId,
    decision_time: args.now ?? new Date().toISOString(),
    agent_view: agentView,
    blocked_or_suppressed: blockedOrSuppressed,
    claim_ledger_projection: claimLedgerProjection ?? undefined,
    attribution,
    replay_sources: replaySources,
    claims: [
      {
        claim: "agent_view_reconstructable",
        status: agentView.exposed_memory_ids.length > 0 || replaySources.has_agent_context ? "pass" : "warn",
        evidence: `${agentView.exposed_memory_ids.length} exposed memory ids reconstructed.`,
      },
      {
        claim: "prompt_payload_excluded",
        status: "pass",
        evidence: "Report includes prompt_char_count but excludes prompt_text.",
      },
      {
        claim: "blocked_memory_visible",
        status: blockedOrSuppressed.length > 0 ? "pass" : "warn",
        evidence: `${blockedOrSuppressed.length} blocked or suppressed memories are visible.`,
      },
      {
        claim: "claim_ledger_projection_replayable",
        status: claimLedgerProjection ? "pass" : "warn",
        evidence: claimLedgerProjection
          ? `Claim Ledger projection replayed ${claimLedgerProjection.use_now.length} use_now, ${claimLedgerProjection.inspect_before_use.length} inspect, ${claimLedgerProjection.do_not_use.length} do_not_use, and ${claimLedgerProjection.audit_only.length} audit_only claims.`
          : "No Claim Ledger projection was supplied.",
      },
      {
        claim: "feedback_attribution_replayable",
        status: attribution.present ? "pass" : "warn",
        evidence: attribution.present
          ? `${attribution.used_memory_ids.length} used memory ids replayed.`
          : "No feedback attribution was supplied.",
      },
      {
        claim: "runtime_read_only",
        status: "pass",
        evidence: "Agent Flight Recorder is a read-only projection over supplied artifacts.",
      },
    ],
    source_map: sourceMap,
    summary: `Agent Flight Recorder reconstructed ${agentView.exposed_memory_ids.length} exposed memories, ${agentView.use_now_memory_ids.length} direct-use memories, ${blockedOrSuppressed.length} blocked/suppressed memories, ${claimLedgerProjection ? claimLedgerProjection.use_now.length + claimLedgerProjection.inspect_before_use.length + claimLedgerProjection.do_not_use.length + claimLedgerProjection.audit_only.length : 0} claim-ledger decisions, and feedback attribution=${attribution.present}.`,
  });
}

const DEFAULT_PROJECTION_LIMIT = 12;

const MAX_PROJECTION_LIMIT = 64;

const VALUE_TEXT_MAX_CHARS = 500;

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_PROJECTION_LIMIT, Math.trunc(value))
    : DEFAULT_PROJECTION_LIMIT;
}

function compactText(value: string, maxChars = VALUE_TEXT_MAX_CHARS): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function claimValueText(row: ClaimLedgerRow): string {
  const text = typeof row.value_text === "string" ? compactText(row.value_text) : "";
  if (text) return text;
  return compactText(`${row.subject_key} ${row.predicate}`);
}

function parseStringListJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, 32);
  } catch {
    return [];
  }
}

function projectionSurface(row: ClaimLedgerRow): {
  surface: AionisClaimLedgerProjectionSurface;
  reasonCode: string;
} {
  if (row.authority === "evidence_only") {
    return { surface: "audit_only", reasonCode: "claim_ledger_evidence_only" };
  }
  if (row.authority === "blocked") {
    return { surface: "do_not_use", reasonCode: "claim_ledger_blocked" };
  }
  if (row.status === "superseded") {
    return { surface: "do_not_use", reasonCode: "claim_ledger_superseded" };
  }
  if (row.status === "contested") {
    return { surface: "inspect_before_use", reasonCode: "claim_ledger_contested_manual_inspect" };
  }
  if (row.status === "retired" || row.status === "redacted") {
    return { surface: "do_not_use", reasonCode: `claim_ledger_${row.status}` };
  }
  if (row.status === "active" && (row.authority === "advisory" || row.authority === "trusted")) {
    return {
      surface: "use_now",
      reasonCode: row.conflict_policy === "singleton_latest"
        ? "claim_ledger_live_singleton"
        : "claim_ledger_live_claim",
    };
  }
  return { surface: "inspect_before_use", reasonCode: "claim_ledger_unhandled_state" };
}

function projectionItem(row: ClaimLedgerRow): AionisClaimLedgerProjectionItem {
  const surface = projectionSurface(row);
  return {
    claim_id: row.claim_id,
    slot_key: row.slot_key,
    subject_key: row.subject_key,
    predicate: row.predicate,
    surface: surface.surface,
    reason_code: surface.reasonCode,
    value_text: claimValueText(row),
    authority: row.authority as AionisClaimLedgerProjectionItem["authority"],
    status: row.status,
    confidence: row.confidence,
    evidence_refs: parseStringListJson(row.evidence_refs_json),
    source_memory_id: row.source_memory_id,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    superseded_by_claim_id: row.superseded_by_claim_id,
  };
}

function pushBounded(
  projection: Pick<AionisClaimLedgerProjection, "use_now" | "inspect_before_use" | "do_not_use" | "audit_only">,
  item: AionisClaimLedgerProjectionItem,
  limit: number,
): void {
  const bucket = projection[item.surface];
  if (bucket.length < limit) bucket.push(item);
}

export function buildClaimLedgerProjection(args: {
  liveClaims: ClaimLedgerRow[];
  supersededClaims: ClaimLedgerRow[];
  queryText?: string | null;
  limit: number;
}): AionisClaimLedgerProjection {
  const limit = normalizeLimit(args.limit);
  const projection = {
    contract_version: "aionis_claim_ledger_projection_v1" as const,
    use_now: [] as AionisClaimLedgerProjectionItem[],
    inspect_before_use: [] as AionisClaimLedgerProjectionItem[],
    do_not_use: [] as AionisClaimLedgerProjectionItem[],
    audit_only: [] as AionisClaimLedgerProjectionItem[],
    blocked_superseded_count: args.supersededClaims.length,
    live_claim_count: args.liveClaims.length,
    contested_claim_count: args.liveClaims.filter((row) => row.status === "contested").length,
    agent_prompt_included: false as const,
    runtime_mutation: false as const,
  };

  for (const row of args.liveClaims) {
    pushBounded(projection, projectionItem(row), limit);
  }
  for (const row of args.supersededClaims) {
    pushBounded(projection, projectionItem(row), limit);
  }

  return AionisClaimLedgerProjectionSchema.parse(projection);
}

type MemoryPacketEntry = AionisMemoryPacket["relevant_memories"][number];

type RuntimeSlotMap = ReadonlyMap<string, Record<string, unknown>>;

export const AIONIS_ADMISSION_CANDIDATE_POLICY_ACTIVE_PROJECTION_REASON =
  "admission_candidate_policy_active_projection";

export type AionisAdmissionCandidatePolicyActiveProjection = {
  contract_version: "aionis_admission_candidate_policy_guide_projection_v1";
  intended_use: "guide_shadow_projection_audit" | "guide_active_projection_gate";
  mode: "shadow" | "active";
  agent_prompt_included: boolean;
  runtime_mutation: false;
  authority_mutation: false;
  shadow_policy_report: AionisMemoryAdmissionShadowPolicyReport;
  downgraded_memory_ids: string[];
  hard_boundary_upgrade_count: number;
  summary: string;
};

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function closedLoopEffectState(args: {
  supported: number;
  contradicted: number;
  rehydrateRequested: number;
}): AionisMemoryAdmissionClosedLoopEffectState {
  if (args.supported > 0 && args.contradicted > 0) return "mixed";
  if (args.contradicted > 0) return "contradicted";
  if (args.supported > 0) return "supported";
  if (args.rehydrateRequested > 0) return "rehydrate_requested";
  return "no_prior";
}

function runtimePriorStateFromSlots(slots: Record<string, unknown>) {
  const supported = nonNegativeInt(slots.positive_attributed_use_count);
  const weakCounterSignalCount = nonNegativeInt(slots.weak_counter_signal_count);
  const strongCounterSignalCount = nonNegativeInt(slots.strong_counter_signal_count);
  const contradicted = weakCounterSignalCount + strongCounterSignalCount;
  const rehydrateRequested = nonNegativeInt(slots.prior_rehydrate_requested_count)
    + nonNegativeInt(slots.rehydrate_requested_count);
  const repeatedNegativePosture =
    contradicted >= 2
    || slots.feedback_learning_control_posture === "inspect_before_use"
    || nonNegativeInt(slots.repeated_unused_without_positive_observation_count) >= 2;
  return {
    prior_supported_use_count: supported,
    prior_contradicted_use_count: contradicted,
    prior_rehydrate_requested_count: rehydrateRequested,
    closed_loop_effect_state: closedLoopEffectState({
      supported,
      contradicted,
      rehydrateRequested,
    }),
    repeated_negative_posture: repeatedNegativePosture,
  };
}

function surfaceForEntry(args: {
  entry: MemoryPacketEntry;
  useNowIds: ReadonlySet<string>;
  inspectBeforeUseIds: ReadonlySet<string>;
  doNotUseIds: ReadonlySet<string>;
  rehydrateIds: ReadonlySet<string>;
}): AionisMemoryDecisionSurface {
  if (args.useNowIds.has(args.entry.memory_id)) return "use_now";
  if (args.inspectBeforeUseIds.has(args.entry.memory_id)) return "inspect_before_use";
  if (args.doNotUseIds.has(args.entry.memory_id)) return "do_not_use";
  if (args.rehydrateIds.has(args.entry.memory_id)) return "rehydrate";
  return "not_agent_facing";
}

function shadowEntryForMemory(args: {
  entry: MemoryPacketEntry;
  agentContext: AionisAgentContext;
  slotByMemoryId: RuntimeSlotMap;
}): AionisMemoryAdmissionShadowPolicyReportInput["entries"][number] {
  const useNowIds = new Set(args.agentContext.use_now_memory_ids);
  const inspectBeforeUseIds = new Set(args.agentContext.inspect_before_use_memory_ids);
  const doNotUseIds = new Set(args.agentContext.do_not_use_memory_ids);
  const rehydrateIds = new Set(args.agentContext.rehydrate_hints.map((hint) => hint.memory_id));
  const slots = args.slotByMemoryId.get(args.entry.memory_id) ?? {};
  return {
    memory_id: args.entry.memory_id,
    title: args.entry.title,
    memory_origin: "aionis",
    source_backend: "aionis",
    memory_type: args.entry.memory_type,
    recorded_action: surfaceForEntry({
      entry: args.entry,
      useNowIds,
      inspectBeforeUseIds,
      doNotUseIds,
      rehydrateIds,
    }),
    ...runtimePriorStateFromSlots(slots),
  };
}

export function resolveAionisAdmissionCandidatePolicyActiveProjection(args: {
  agent_context: AionisAgentContext;
  memory_packet: AionisMemoryPacket | null;
  slot_by_memory_id?: RuntimeSlotMap | null;
  mode?: "shadow" | "active" | null;
}): AionisAdmissionCandidatePolicyActiveProjection {
  const mode = args.mode === "shadow" ? "shadow" : "active";
  const slotByMemoryId = args.slot_by_memory_id ?? new Map<string, Record<string, unknown>>();
  const report = buildAionisMemoryAdmissionShadowPolicyReport({
    source: "memory_decision_trace",
    entries: (args.memory_packet?.relevant_memories ?? []).map((entry) =>
      shadowEntryForMemory({
        entry,
        agentContext: args.agent_context,
        slotByMemoryId,
      })
    ),
  });
  const currentUseNowIds = new Set(args.agent_context.use_now_memory_ids);
  const downgradedMemoryIds = report.downgraded_memory_ids.filter((memoryId) =>
    currentUseNowIds.has(memoryId)
  );
  return {
    contract_version: "aionis_admission_candidate_policy_guide_projection_v1",
    intended_use: mode === "active" ? "guide_active_projection_gate" : "guide_shadow_projection_audit",
    mode,
    agent_prompt_included: mode === "active",
    runtime_mutation: false,
    authority_mutation: false,
    shadow_policy_report: report,
    downgraded_memory_ids: downgradedMemoryIds,
    hard_boundary_upgrade_count: report.hard_boundary_upgrade_count,
    summary: `Candidate admission policy would downgrade ${downgradedMemoryIds.length} current use_now memories to inspect_before_use without mutating stored memory state.`,
  };
}
