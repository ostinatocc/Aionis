import {
  AionisAgentContextSchema,
  AionisMemoryAdmissionRecordSchema,
  AionisMemoryDecisionTraceSchema,
  AionisMemoryUseReceiptSchema,
  AionisOperatorSnapshotSchema,
  parseAionisAgentFlightRecorderReport,
  type AionisAgentContext,
  type AionisAgentFlightRecorderReport,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryDecisionTrace,
  type AionisMemoryUseReceipt,
  type AionisOperatorSnapshot,
} from "./product-output-contract.js";

export type BuildAionisAgentFlightRecorderReportArgs = {
  tenant_id?: string | null;
  scope?: string | null;
  guide_trace_id?: string | null;
  run_id?: string | null;
  agent_context?: unknown;
  memory_decision_trace?: unknown;
  memory_use_receipt?: unknown;
  memory_admission_record?: unknown;
  operator_snapshot?: unknown;
  feedback_result?: unknown;
  now?: string | null;
  source_map?: Partial<AionisAgentFlightRecorderReport["source_map"]>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  const next = typeof value === "string" ? value.trim() : "";
  return next.length > 0 ? next : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return compactStrings(value);
}

function compactStrings(values: unknown[], limit = 128): string[] {
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

function parseAgentContext(value: unknown): AionisAgentContext | null {
  const direct = AionisAgentContextSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisAgentContextSchema.safeParse(asRecord(value).agent_context);
  return nested.success ? nested.data : null;
}

function parseTrace(value: unknown): AionisMemoryDecisionTrace | null {
  const direct = AionisMemoryDecisionTraceSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisMemoryDecisionTraceSchema.safeParse(asRecord(value).memory_decision_trace);
  return nested.success ? nested.data : null;
}

function parseReceipt(value: unknown): AionisMemoryUseReceipt | null {
  const direct = AionisMemoryUseReceiptSchema.safeParse(value);
  if (direct.success) return direct.data;
  const record = asRecord(value);
  const nested = AionisMemoryUseReceiptSchema.safeParse(record.memory_use_receipt);
  return nested.success ? nested.data : null;
}

function parseAdmissionRecord(value: unknown): AionisMemoryAdmissionRecord | null {
  const direct = AionisMemoryAdmissionRecordSchema.safeParse(value);
  if (direct.success) return direct.data;
  const record = asRecord(value);
  const nested = AionisMemoryAdmissionRecordSchema.safeParse(
    record.memory_admission_record ?? record.admission_record,
  );
  return nested.success ? nested.data : null;
}

function parseSnapshot(value: unknown): AionisOperatorSnapshot | null {
  const direct = AionisOperatorSnapshotSchema.safeParse(value);
  if (direct.success) return direct.data;
  const nested = AionisOperatorSnapshotSchema.safeParse(asRecord(value).operator_snapshot);
  return nested.success ? nested.data : null;
}

function runIdFromFeedback(value: unknown): string | null {
  const record = asRecord(value);
  return stringValue(record.run_id) ?? stringValue(asRecord(record.feedback_effect).run_id);
}

function outcomeFromFeedback(value: unknown): "positive" | "negative" | "neutral" | null {
  const outcome = stringValue(asRecord(value).outcome) ?? stringValue(asRecord(asRecord(value).feedback_effect).outcome);
  return outcome === "positive" || outcome === "negative" || outcome === "neutral" ? outcome : null;
}

function usedIdsFromFeedback(value: unknown): string[] {
  const record = asRecord(value);
  const effect = asRecord(record.feedback_effect);
  return compactStrings([
    ...stringArray(record.used_memory_ids),
    ...stringArray(record.memory_ids),
    ...stringArray(record.node_ids),
    ...stringArray(effect.used_memory_ids),
    ...stringArray(effect.affected_memory_ids),
  ]);
}

function receiptFromInputs(args: {
  supplied: unknown;
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisMemoryUseReceipt | null {
  return parseReceipt(args.supplied)
    ?? args.trace?.memory_use_receipt
    ?? args.snapshot?.memory_use_receipt
    ?? null;
}

function admissionRecordFromInputs(args: {
  supplied: unknown;
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisMemoryAdmissionRecord | null {
  return parseAdmissionRecord(args.supplied)
    ?? args.trace?.admission_record
    ?? args.snapshot?.memory_admission_record
    ?? null;
}

function agentViewFromInputs(args: {
  agent: AionisAgentContext | null;
  trace: AionisMemoryDecisionTrace | null;
  receipt: AionisMemoryUseReceipt | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisAgentFlightRecorderReport["agent_view"] {
  const rehydrateFromAgent = args.agent?.rehydrate_hints.map((entry) => entry.memory_id) ?? [];
  const exposedMemoryIds = compactStrings([
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
    use_now_memory_ids: compactStrings([
      ...(args.receipt?.use_now_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.use_now_memory_ids ?? []),
      ...(args.agent?.use_now_memory_ids ?? []),
    ]),
    inspect_before_use_memory_ids: compactStrings([
      ...(args.receipt?.inspect_before_use_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.inspect_before_use_memory_ids ?? []),
      ...(args.agent?.inspect_before_use_memory_ids ?? []),
    ]),
    do_not_use_memory_ids: compactStrings([
      ...(args.receipt?.do_not_use_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.do_not_use_memory_ids ?? []),
      ...(args.agent?.do_not_use_memory_ids ?? []),
    ]),
    rehydrate_memory_ids: compactStrings([
      ...(args.receipt?.rehydrate_memory_ids ?? []),
      ...rehydrateFromAgent,
    ]),
    target_files: compactStrings([
      ...(args.agent?.target_files ?? []),
      ...(args.trace?.context_decision.target_files ?? []),
      ...(args.snapshot?.execution_state.active_path.entries.flatMap((entry) => entry.evidence_refs) ?? []),
    ]),
    recall_sources_by_memory_id: Array.from(recallSourceMap.values())
      .filter((entry) => exposedSet.size === 0 || exposedSet.has(entry.memory_id))
      .slice(0, 96),
  };
}

function blockedOrSuppressedFromInputs(args: {
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

function attributionFromInputs(args: {
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
  feedback_result: unknown;
}): AionisAgentFlightRecorderReport["attribution"] {
  const traceAttribution = args.trace?.feedback_attribution;
  const feedbackUsedIds = usedIdsFromFeedback(args.feedback_result);
  const outcome = traceAttribution?.outcome
    ?? args.snapshot?.guide_trace.feedback_outcome
    ?? outcomeFromFeedback(args.feedback_result);
  const attributed = compactStrings([
    ...(traceAttribution?.attributed_memory_ids ?? []),
    ...(args.snapshot?.guide_trace.attributed_memory_ids ?? []),
  ]);
  const usedMemoryIds = compactStrings([
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
    unattributed_memory_ids: compactStrings([
      ...(traceAttribution?.unattributed_recalled_memory_ids ?? []),
      ...(args.snapshot?.guide_trace.unattributed_memory_ids ?? []),
    ]),
    supported_memory_ids: compactStrings(args.trace?.judgment_calibration_summary.supported_memory_ids ?? []),
    contradicted_memory_ids: compactStrings([
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

function sourceMapForReport(args: {
  supplied: Partial<AionisAgentFlightRecorderReport["source_map"]> | undefined;
  trace: AionisMemoryDecisionTrace | null;
  snapshot: AionisOperatorSnapshot | null;
}): AionisAgentFlightRecorderReport["source_map"] {
  return {
    routes_used: compactStrings([
      ...(args.supplied?.routes_used ?? []),
      ...(args.trace?.source_map.routes_used ?? []),
      ...(args.snapshot?.source_map.routes_used ?? []),
    ]),
    internal_surfaces_used: compactStrings([
      ...(args.supplied?.internal_surfaces_used ?? []),
      "agent_flight_recorder",
      ...(args.trace ? ["memory_decision_trace"] : []),
      ...(args.trace?.memory_use_receipt ? ["memory_use_receipt"] : []),
      ...(args.trace?.admission_record ? ["memory_admission_record"] : []),
      ...(args.snapshot ? ["operator_snapshot"] : []),
    ]),
    omitted_internal_surfaces: compactStrings([
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
  const trace = parseTrace(args.memory_decision_trace);
  const snapshot = parseSnapshot(args.operator_snapshot);
  const agent = parseAgentContext(args.agent_context) ?? parseAgentContext(args.memory_decision_trace);
  const receipt = receiptFromInputs({
    supplied: args.memory_use_receipt,
    trace,
    snapshot,
  });
  const admissionRecord = admissionRecordFromInputs({
    supplied: args.memory_admission_record,
    trace,
    snapshot,
  });
  const agentView = agentViewFromInputs({ agent, trace, receipt, snapshot });
  const blockedOrSuppressed = blockedOrSuppressedFromInputs({ trace, admissionRecord, agentView });
  const attribution = attributionFromInputs({
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
    ?? runIdFromFeedback(args.feedback_result)
    ?? null;
  const replaySources = {
    has_agent_context: agent !== null,
    has_memory_decision_trace: trace !== null,
    has_memory_use_receipt: receipt !== null,
    has_memory_admission_record: admissionRecord !== null,
    has_operator_snapshot: snapshot !== null,
    has_feedback_result: Object.keys(asRecord(args.feedback_result)).length > 0,
  };
  const sourceMap = sourceMapForReport({
    supplied: args.source_map,
    trace,
    snapshot,
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
    summary: `Agent Flight Recorder reconstructed ${agentView.exposed_memory_ids.length} exposed memories, ${agentView.use_now_memory_ids.length} direct-use memories, ${blockedOrSuppressed.length} blocked/suppressed memories, and feedback attribution=${attribution.present}.`,
  });
}
