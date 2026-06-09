import {
  AionisAgentContextSchema,
  AionisEffectReportSchema,
  AionisGuidePacketSchema,
  AionisMemoryDecisionAuditReportSchema,
  AionisMemoryDecisionTraceSchema,
  parseAionisOperatorSnapshot,
  type AionisAgentContext,
  type AionisEffectReport,
  type AionisGuidePacket,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisOperatorSnapshot,
} from "./product-output-contract.js";

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

function includesAny(text: string, needles: string[]): boolean {
  const normalized = text.toLowerCase();
  return needles.some((needle) => needle && normalized.includes(needle.toLowerCase()));
}

function failedLeakage(args: {
  useNowText: string;
  failedEntries: AionisOperatorSnapshot["execution_state"]["failed_branches"]["entries"];
}): boolean {
  return args.failedEntries.some((entry) => {
    const summary = entry.summary.slice(0, 120);
    const markerMatch = summary.match(/[A-Z0-9_]*FAILED[A-Z0-9_]*/);
    return includesAny(args.useNowText, compactStrings([markerMatch?.[0], summary], 2));
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
      ...(args.audit ? ["memory_decision_audit_report"] : []),
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

function buildClaims(args: {
  activeCount: number;
  passedCount: number;
  failedCount: number;
  failedVisible: boolean;
  leaked: boolean;
  guideTracePresent: boolean;
  feedbackPresent: boolean;
  learningControlVisible: boolean;
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

export function buildAionisOperatorSnapshot(args: BuildAionisOperatorSnapshotArgs): AionisOperatorSnapshot {
  const guide = parseGuidePacket(args.guide_packet);
  const effect = parseEffect(args.effect_report);
  const trace = parseTrace(args.memory_decision_trace);
  const audit = parseAudit(args.memory_decision_audit);
  const executionContext = asRecord(args.execution_context);
  const agent = parseAgentContext(args.agent_context) ?? parseAgentContext(executionContext);
  const activePathEntries = currentActivePathEntries(executionContext, agent);
  const passedSolutionEntriesValue = passedSolutionEntries(executionContext, agent);
  const failedBranchEntriesValue = failedBranchEntries(executionContext, agent);
  const useNowText = [...(agent?.use_now ?? []), ...passedSolutionEntriesValue.map((entry) => entry.summary)].join("\n");
  const doNotUseText = [...(agent?.do_not_use ?? []), ...failedBranchEntriesValue.map((entry) => entry.summary)].join("\n");
  const leaked = failedLeakage({ useNowText, failedEntries: failedBranchEntriesValue });
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
  const attributedIds = uniqueStrings(feedbackAttribution?.attributed_memory_ids ?? []);
  const exposedIds = uniqueStrings(agent?.memory_ids ?? guide?.memory_lifecycle.used_memory_ids ?? []);
  const guideTraceId = args.guide_trace_id ?? feedbackAttribution?.guide_trace_id ?? null;
  const actionableHistoryUsed =
    agent?.actionable_history_used
    ?? guide?.guide_brief.actionable_history_used
    ?? trace?.summary.actionable_history_used
    ?? (activePathEntries.length > 0 || passedSolutionEntriesValue.length > 0 || failedBranchEntriesValue.length > 0);

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
    memory_lifecycle: {
      used_count: directUseCount,
      inspect_before_use_count: inspectCount,
      do_not_use_count: doNotUseCount,
      rehydrate_count: rehydrateCount,
      controlled_memory_count: controlledMemoryCount,
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      stale_memory_count: trace?.summary ? 0 : guide?.risk.stale_memory_count ?? 0,
      learning_control_visible: learningControlVisible,
      consolidation_guard: consolidationGuardFromTrace(trace, executionContext),
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
    }),
  });
}

export function renderAionisOperatorSnapshotMarkdown(snapshot: AionisOperatorSnapshot): string {
  const claimLines = snapshot.claims.map((claim) => `- ${claim.claim}: ${claim.status} - ${claim.evidence}`);
  const active = snapshot.execution_state.active_path.entries.slice(0, 5).map((entry) => `- ${entry.summary}`);
  const failed = snapshot.execution_state.failed_branches.entries.slice(0, 5).map((entry) => `- ${entry.summary}`);
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
