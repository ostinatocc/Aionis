import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import {
  RuntimeSignalLedgerV1Schema,
  type RuntimeSignalAuthorityEffect,
  type RuntimeSignalCapability,
  type RuntimeSignalKind,
  type RuntimeSignalLedgerEntryV1,
  type RuntimeSignalLedgerV1,
  type RuntimeSignalPolarity,
} from "./schemas.js";
import { extractExecutionEvidenceFromSlots } from "./execution-evidence.js";

type RuntimeSignalDraft = Omit<RuntimeSignalLedgerEntryV1, "signal_id">;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(values: unknown[], limit = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (out.length >= limit) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = asRecord(value);
    if (record) {
      visit(record.ref);
      visit(record.uri);
      visit(record.id);
      visit(record.node_id);
      visit(record.decision_id);
      visit(record.run_id);
      visit(record.evidence_ref);
      return;
    }
    const text = stringField(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };
  for (const value of values) visit(value);
  return out;
}

function numberField(...values: unknown[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function booleanField(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1", "pass", "passed", "success", "succeeded", "ok"].includes(normalized)) return true;
      if (["false", "no", "0", "fail", "failed", "failure", "error", "errored"].includes(normalized)) return false;
    }
  }
  return null;
}

function compactText(value: unknown, maxLen = 512): string | null {
  const text = stringField(value);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ");
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function signalId(draft: RuntimeSignalDraft): string {
  return `rsl:${sha256Hex(stableStringify({
    kind: draft.signal_kind,
    polarity: draft.polarity,
    numeric: draft.numeric_value,
    text: draft.text_value,
    evidence: draft.evidence_refs,
    source: draft.source_refs,
    effect: draft.authority_effect,
  })).slice(0, 24)}`;
}

function entry(args: {
  signal_kind: RuntimeSignalKind;
  polarity: RuntimeSignalPolarity;
  numeric_value?: number | null;
  text_value?: string | null;
  evidence_refs?: unknown[];
  source_refs?: unknown[];
  affected_capabilities: RuntimeSignalCapability[];
  authority_effect?: RuntimeSignalAuthorityEffect;
}): RuntimeSignalLedgerEntryV1 {
  const draft: RuntimeSignalDraft = {
    signal_kind: args.signal_kind,
    polarity: args.polarity,
    numeric_value: typeof args.numeric_value === "number" && Number.isFinite(args.numeric_value) ? args.numeric_value : null,
    text_value: compactText(args.text_value) ?? null,
    evidence_refs: stringList(args.evidence_refs ?? [], 32),
    source_refs: stringList(args.source_refs ?? [], 32),
    affected_capabilities: Array.from(new Set(args.affected_capabilities)).slice(0, 4),
    authority_effect: args.authority_effect ?? "none",
  };
  return {
    signal_id: signalId(draft),
    ...draft,
  };
}

function normalizeExistingLedger(value: unknown): RuntimeSignalLedgerEntryV1[] {
  const parsed = RuntimeSignalLedgerV1Schema.safeParse(value);
  return parsed.success ? parsed.data.entries : [];
}

function appendUnique(entries: RuntimeSignalLedgerEntryV1[], next: RuntimeSignalLedgerEntryV1 | null | undefined) {
  if (!next) return;
  if (entries.some((entry) => entry.signal_id === next.signal_id)) return;
  entries.push(next);
}

function collectNestedRecords(...values: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    const record = asRecord(value);
    if (record) {
      out.push(record);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    }
  };
  for (const value of values) visit(value);
  return out;
}

function hasProviderProtocolFailure(records: Record<string, unknown>[]): boolean {
  return records.some((record) => {
    const explicit =
      booleanField(
        record.provider_failure,
        record.providerFailure,
        record.protocol_failure,
        record.protocolFailure,
        record.llm_tool_protocol_failure,
        record.provider_protocol_failure,
      ) === true;
    if (explicit) return true;
    const kind = compactText(record.failure_kind ?? record.error_kind ?? record.phase ?? record.status);
    if (kind && /provider|protocol|transport|rate_limit|insufficient_balance|quota|timeout/i.test(kind)) return true;
    const reason = compactText(record.failure_reason ?? record.error ?? record.reason);
    return !!reason && /provider|protocol|transport|rate_limit|insufficient balance|quota|timeout/i.test(reason);
  });
}

function statusOutcome(value: unknown): boolean | null {
  const record = asRecord(value);
  return booleanField(
    record?.success,
    record?.passed,
    record?.ok,
    record?.validation_passed,
    record?.status,
    record?.outcome,
    value,
  );
}

function collectContextPressure(slots: Record<string, unknown>, records: Record<string, unknown>[]): RuntimeSignalLedgerEntryV1 | null {
  const contextSignals = asRecord(slots.context_cost_signals_v1)
    ?? asRecord(slots.context_cost_signals)
    ?? records.find((record) => record.summary_version === "context_cost_signals_v1")
    ?? null;
  if (!contextSignals) return null;
  const estimatedTokens = numberField(contextSignals.context_est_tokens, contextSignals.estimated_tokens);
  const tokenBudget = numberField(contextSignals.context_token_budget, contextSignals.token_budget);
  const overBudget = booleanField(contextSignals.within_token_budget) === false
    || (estimatedTokens !== null && tokenBudget !== null && estimatedTokens > tokenBudget);
  return entry({
    signal_kind: "token_context_pressure",
    polarity: overBudget ? "negative" : "neutral",
    numeric_value: estimatedTokens,
    text_value: overBudget ? "context token pressure exceeded budget" : "context token pressure observed",
    source_refs: ["context_cost_signals_v1"],
    affected_capabilities: ["continuity", "forgetting"],
    authority_effect: overBudget ? "forgetting_signal" : "none",
  });
}

function collectMaintenanceEffect(slots: Record<string, unknown>, records: Record<string, unknown>[]): RuntimeSignalLedgerEntryV1 | null {
  const maintenance = asRecord(slots.runtime_maintenance_effect_summary_v1)
    ?? asRecord(slots.runtime_maintenance_effect_summary)
    ?? records.find((record) => record.effect_summary_version === "runtime_maintenance_effect_summary_v1")
    ?? null;
  if (!maintenance) return null;
  const promoted = numberField(maintenance.workflow_promotions) ?? 0;
  const demoted = numberField(maintenance.memory_demotions) ?? 0;
  const archived = numberField(maintenance.memory_archives) ?? 0;
  const retired = numberField(maintenance.policy_retirements) ?? 0;
  const mutationCount = promoted + demoted + archived + retired;
  return entry({
    signal_kind: "maintenance_effect",
    polarity: mutationCount > 0 ? "positive" : "neutral",
    numeric_value: mutationCount,
    text_value: `maintenance mutations=${mutationCount}`,
    source_refs: ["runtime_maintenance_effect_summary_v1"],
    affected_capabilities: ["learning", "forgetting", "learning_control"],
    authority_effect: mutationCount > 0 ? "forgetting_signal" : "none",
  });
}

function collectBooleanOutcome(args: {
  kind: RuntimeSignalKind;
  value: unknown;
  positiveText: string;
  negativeText: string;
  sourceRef: string;
  positiveCapabilities: RuntimeSignalCapability[];
  negativeCapabilities: RuntimeSignalCapability[];
}): RuntimeSignalLedgerEntryV1 | null {
  const outcome = statusOutcome(args.value);
  if (outcome === null) return null;
  return entry({
    signal_kind: args.kind,
    polarity: outcome ? "positive" : "negative",
    numeric_value: outcome ? 1 : 0,
    text_value: outcome ? args.positiveText : args.negativeText,
    evidence_refs: [args.value],
    source_refs: [args.sourceRef],
    affected_capabilities: outcome ? args.positiveCapabilities : args.negativeCapabilities,
    authority_effect: outcome ? "promotion_evidence_candidate" : "counter_evidence",
  });
}

function pushUniqueString(out: string[], seen: Set<string>, value: unknown, limit = 32): void {
  if (out.length >= limit) return;
  const text = stringField(value);
  if (!text || seen.has(text)) return;
  seen.add(text);
  out.push(text);
}

function collectStringsFromValue(value: unknown, limit = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (next: unknown) => {
    if (out.length >= limit) return;
    if (Array.isArray(next)) {
      for (const entry of next) visit(entry);
      return;
    }
    pushUniqueString(out, seen, next, limit);
  };
  visit(value);
  return out;
}

function collectExpectedAdaptiveGuidanceCandidateIds(args: {
  slots: Record<string, unknown>;
  records: Record<string, unknown>[];
  executionResultSummary: Record<string, unknown> | null;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const visitOverlay = (value: unknown) => {
    const overlay = asRecord(value);
    if (!overlay) return;
    const attributionPlan = asRecord(overlay.attribution_plan);
    for (const candidateId of collectStringsFromValue(attributionPlan?.candidate_ids, 16)) {
      pushUniqueString(out, seen, candidateId, 32);
    }
    const selectedCandidates = Array.isArray(overlay.selected_candidates) ? overlay.selected_candidates : [];
    for (const selected of selectedCandidates) {
      const record = asRecord(selected);
      pushUniqueString(out, seen, record?.candidate_id, 32);
    }
    const adaptedInstructions = Array.isArray(overlay.adapted_instructions) ? overlay.adapted_instructions : [];
    for (const instruction of adaptedInstructions) {
      const record = asRecord(instruction);
      for (const candidateId of collectStringsFromValue(record?.source_candidate_ids, 16)) {
        pushUniqueString(out, seen, candidateId, 32);
      }
    }
  };

  const actionRetrieval =
    asRecord(args.slots.action_retrieval)
    ?? asRecord(args.slots.action_retrieval_response)
    ?? null;
  const contextProjection =
    asRecord(args.slots.context_operator_projection_v1)
    ?? asRecord(args.slots.context_operator_projection)
    ?? null;
  const experienceIntelligence =
    asRecord(args.slots.experience_intelligence_v1)
    ?? asRecord(args.slots.experience_intelligence)
    ?? null;
  const experienceActionRetrieval = asRecord(experienceIntelligence?.action_retrieval);

  for (const value of [
    args.slots.adaptive_guidance,
    args.slots.adaptive_guidance_v1,
    args.slots.adaptive_guidance_overlay_v1,
    actionRetrieval?.adaptive_guidance,
    contextProjection?.adaptive_guidance,
    experienceActionRetrieval?.adaptive_guidance,
    args.executionResultSummary?.adaptive_guidance,
    args.executionResultSummary?.adaptive_guidance_v1,
    args.executionResultSummary?.adaptive_guidance_overlay_v1,
  ]) {
    visitOverlay(value);
  }

  for (const record of args.records) {
    if (stringField(record.summary_version) === "adaptive_guidance_overlay_v1") {
      visitOverlay(record);
    }
  }

  return out;
}

function adaptiveGuidanceOutcomeStatus(value: unknown): boolean | null {
  const outcome = statusOutcome(value);
  if (outcome !== null) return outcome;
  const record = asRecord(value);
  const polarity = stringField(record?.polarity)?.toLowerCase();
  if (polarity === "positive" || polarity === "success" || polarity === "succeeded") return true;
  if (polarity === "negative" || polarity === "failure" || polarity === "failed") return false;
  return null;
}

function collectOutcomeCandidateIds(value: unknown, expectedCandidateIds: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (candidateId: unknown) => pushUniqueString(out, seen, candidateId, 32);
  const visitExplicit = (next: unknown) => {
    if (Array.isArray(next)) {
      for (const item of next) visitExplicit(item);
      return;
    }
    const record = asRecord(next);
    if (record) {
      push(record.candidate_id);
      push(record.adaptive_guidance_candidate_id);
      push(record.guidance_candidate_id);
      push(record.selected_candidate_id);
      push(record.source_candidate_id);
      return;
    }
    push(next);
  };
  const visitExpectedRef = (next: unknown) => {
    if (Array.isArray(next)) {
      for (const item of next) visitExpectedRef(item);
      return;
    }
    const text = stringField(next);
    if (text && expectedCandidateIds.has(text)) push(text);
  };

  const visitOutcome = (next: unknown) => {
    if (Array.isArray(next)) {
      for (const item of next) visitOutcome(item);
      return;
    }
    const record = asRecord(next);
    if (!record) return;
    for (const field of [
      "candidate_id",
      "adaptive_guidance_candidate_id",
      "guidance_candidate_id",
      "selected_candidate_id",
      "source_candidate_id",
    ]) {
      push(record[field]);
    }
    for (const field of [
      "candidate_ids",
      "adaptive_guidance_candidate_ids",
      "guidance_candidate_ids",
      "selected_candidate_ids",
      "source_candidate_ids",
    ]) {
      visitExplicit(record[field]);
    }
    for (const field of [
      "adaptive_guidance_candidate",
      "selected_candidate",
      "source_candidate",
    ]) {
      visitExplicit(record[field]);
    }
    for (const field of ["source_refs", "evidence_refs", "refs"]) {
      visitExpectedRef(record[field]);
    }
  };

  visitOutcome(value);
  return out;
}

function collectAdaptiveGuidanceOutcomeValues(args: {
  slots: Record<string, unknown>;
  records: Record<string, unknown>[];
  executionResultSummary: Record<string, unknown> | null;
}): Array<{ value: unknown; sourceRef: string; container?: unknown }> {
  const out: Array<{ value: unknown; sourceRef: string; container?: unknown }> = [];
  const seen = new Set<string>();
  const push = (value: unknown, sourceRef: string, container?: unknown) => {
    if (value === null || value === undefined) return;
    const key = stableStringify({ sourceRef, value });
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, sourceRef, container });
  };

  push(args.slots.adaptive_guidance_outcome_v1, "adaptive_guidance_outcome_v1");
  push(args.slots.adaptive_guidance_outcome, "adaptive_guidance_outcome");
  push(args.executionResultSummary?.adaptive_guidance_outcome_v1, "execution_result_summary.adaptive_guidance_outcome_v1", args.executionResultSummary);
  push(args.executionResultSummary?.adaptive_guidance_outcome, "execution_result_summary.adaptive_guidance_outcome", args.executionResultSummary);

  for (const record of args.records) {
    const prefix = record === args.executionResultSummary ? "execution_result_summary" : "execution_evidence[]";
    push(record.adaptive_guidance_outcome_v1, `${prefix}.adaptive_guidance_outcome_v1`, record);
    push(record.adaptive_guidance_outcome, `${prefix}.adaptive_guidance_outcome`, record);
    if (
      stringField(record.signal_kind) === "adaptive_guidance_outcome"
      || stringField(record.summary_version) === "adaptive_guidance_outcome_v1"
      || stringField(record.kind) === "adaptive_guidance_outcome"
    ) {
      push(record, "adaptive_guidance_outcome_v1", record);
    }
  }

  return out;
}

function collectAdaptiveGuidanceOutcomeEntries(args: {
  slots: Record<string, unknown>;
  records: Record<string, unknown>[];
  executionResultSummary: Record<string, unknown> | null;
}): RuntimeSignalLedgerEntryV1[] {
  const expectedCandidateIds = collectExpectedAdaptiveGuidanceCandidateIds(args);
  const expectedCandidateIdSet = new Set(expectedCandidateIds);
  const outcomes = collectAdaptiveGuidanceOutcomeValues(args);
  const entries: RuntimeSignalLedgerEntryV1[] = [];

  for (const outcomeValue of outcomes) {
    const outcome = adaptiveGuidanceOutcomeStatus(outcomeValue.value);
    if (outcome === null) continue;
    const outcomeCandidateIds = collectOutcomeCandidateIds(outcomeValue.value, expectedCandidateIdSet);
    const boundCandidateIds = outcomeCandidateIds.filter((candidateId) => expectedCandidateIdSet.has(candidateId));
    const positiveBound = outcome && boundCandidateIds.length > 0;
    entries.push(entry({
      signal_kind: "adaptive_guidance_outcome",
      polarity: outcome ? "positive" : "negative",
      numeric_value: outcome ? 1 : 0,
      text_value: outcome
        ? positiveBound
          ? "adaptive guidance improved the next action"
          : "adaptive guidance outcome observed without selected candidate attribution"
        : "adaptive guidance did not improve the next action",
      evidence_refs: [outcomeValue.value, outcomeValue.container, ...boundCandidateIds],
      source_refs: [outcomeValue.sourceRef, ...outcomeCandidateIds],
      affected_capabilities: outcome
        ? positiveBound
          ? ["continuity", "learning"]
          : ["continuity", "learning_control"]
        : ["learning", "learning_control", "forgetting"],
      authority_effect: outcome
        ? positiveBound
          ? "promotion_evidence_candidate"
          : "none"
        : "counter_evidence",
    }));
  }

  return entries;
}

export function buildRuntimeSignalLedgerFromSlots(args: {
  slots?: Record<string, unknown> | null;
  metrics?: unknown;
}): RuntimeSignalLedgerV1 | null {
  const slots = args.slots ?? {};
  const entries: RuntimeSignalLedgerEntryV1[] = normalizeExistingLedger(slots.runtime_signal_ledger_v1);
  const executionResultSummary = asRecord(slots.execution_result_summary);
  const compileSummary = asRecord(slots.compile_summary);
  const actionContract = asRecord(slots.action_intelligence_runtime_contract);
  const records = collectNestedRecords(
    slots.runtime_signals_v1,
    slots.runtime_signal,
    slots.execution_result_summary,
    slots.execution_evidence,
    slots.compile_summary,
    slots.provider_failure_v1,
    slots.protocol_failure_v1,
    slots.edit_boundary_rejection_v1,
    args.metrics,
  );
  const evidence = extractExecutionEvidenceFromSlots({ slots, metrics: args.metrics });
  if (evidence?.validation_passed !== null && evidence?.validation_passed !== undefined) {
    appendUnique(entries, entry({
      signal_kind: "verifier_result",
      polarity: evidence.validation_passed && !evidence.false_confidence_detected ? "positive" : "negative",
      numeric_value: evidence.validation_passed && !evidence.false_confidence_detected ? 1 : 0,
      text_value: evidence.failure_reason ?? (evidence.validation_passed ? "verification passed" : "verification failed"),
      evidence_refs: evidence.evidence_refs,
      source_refs: ["execution_evidence_v1"],
      affected_capabilities: evidence.validation_passed
        ? ["learning", "learning_control"]
        : ["learning", "learning_control", "forgetting"],
      authority_effect: evidence.validation_passed ? "promotion_evidence_candidate" : "counter_evidence",
    }));
  }

  const retryCount = numberField(
    slots.retry_count,
    slots.retries,
    executionResultSummary?.retry_count,
    executionResultSummary?.retries,
    compileSummary?.retry_count,
    slots.runtime_signals_v1 && asRecord(slots.runtime_signals_v1)?.retry_count,
  );
  if (retryCount !== null) {
    appendUnique(entries, entry({
      signal_kind: "retry_count",
      polarity: retryCount > 0 ? "negative" : "neutral",
      numeric_value: Math.max(0, retryCount),
      text_value: `retry_count=${Math.max(0, retryCount)}`,
      source_refs: ["runtime_retry_count"],
      affected_capabilities: ["continuity", "learning"],
      authority_effect: retryCount > 0 ? "counter_evidence" : "none",
    }));
  }

  const recoveryCost = numberField(
    slots.recovery_cost,
    slots.recovery_steps,
    executionResultSummary?.recovery_cost,
    executionResultSummary?.recovery_steps,
    compileSummary?.recovery_cost,
    slots.runtime_signals_v1 && asRecord(slots.runtime_signals_v1)?.recovery_cost,
  );
  if (recoveryCost !== null) {
    appendUnique(entries, entry({
      signal_kind: "recovery_cost",
      polarity: recoveryCost > 0 ? "negative" : "neutral",
      numeric_value: Math.max(0, recoveryCost),
      text_value: `recovery_cost=${Math.max(0, recoveryCost)}`,
      source_refs: ["runtime_recovery_cost"],
      affected_capabilities: ["continuity", "learning", "forgetting"],
      authority_effect: recoveryCost > 0 ? "counter_evidence" : "none",
    }));
  }

  const repeatedDiscovery = numberField(
    slots.repeated_discovery_count,
    executionResultSummary?.repeated_discovery_count,
    slots.runtime_signals_v1 && asRecord(slots.runtime_signals_v1)?.repeated_discovery_count,
  );
  if (repeatedDiscovery !== null) {
    appendUnique(entries, entry({
      signal_kind: "repeated_discovery",
      polarity: repeatedDiscovery > 0 ? "negative" : "neutral",
      numeric_value: Math.max(0, repeatedDiscovery),
      text_value: `repeated_discovery_count=${Math.max(0, repeatedDiscovery)}`,
      source_refs: ["runtime_repeated_discovery"],
      affected_capabilities: ["continuity", "learning"],
      authority_effect: repeatedDiscovery > 0 ? "promotion_evidence_candidate" : "none",
    }));
  }

  const repeatedFailedAction = numberField(
    slots.repeated_failed_action_count,
    executionResultSummary?.repeated_failed_action_count,
    slots.runtime_signals_v1 && asRecord(slots.runtime_signals_v1)?.repeated_failed_action_count,
  );
  if (repeatedFailedAction !== null) {
    appendUnique(entries, entry({
      signal_kind: "repeated_failed_action",
      polarity: repeatedFailedAction > 0 ? "negative" : "neutral",
      numeric_value: Math.max(0, repeatedFailedAction),
      text_value: `repeated_failed_action_count=${Math.max(0, repeatedFailedAction)}`,
      source_refs: ["runtime_repeated_failed_action"],
      affected_capabilities: ["learning", "learning_control", "forgetting"],
      authority_effect: repeatedFailedAction > 0 ? "counter_evidence" : "none",
    }));
  }

  if (hasProviderProtocolFailure(records)) {
    appendUnique(entries, entry({
      signal_kind: "provider_protocol_failure",
      polarity: "negative",
      numeric_value: 1,
      text_value: "provider or protocol failure observed",
      evidence_refs: records,
      source_refs: ["provider_protocol_failure"],
      affected_capabilities: ["learning_control"],
      authority_effect: "quarantine",
    }));
  }

  const editBoundaryRejected =
    booleanField(
      slots.edit_boundary_rejected,
      slots.blocked_by_edit_boundary,
      asRecord(slots.edit_boundary_rejection_v1)?.rejected,
      asRecord(slots.edit_boundary_rejection_v1)?.blocked,
    ) === true;
  if (editBoundaryRejected) {
    appendUnique(entries, entry({
      signal_kind: "edit_boundary_rejection",
      polarity: "negative",
      numeric_value: 1,
      text_value: "edit boundary rejected the attempted action",
      evidence_refs: [slots.edit_boundary_rejection_v1],
      source_refs: ["edit_boundary_rejection_v1"],
      affected_capabilities: ["learning_control"],
      authority_effect: "counter_evidence",
    }));
  }

  appendUnique(entries, collectBooleanOutcome({
    kind: "tool_selection_outcome",
    value: slots.tool_selection_outcome_v1 ?? slots.tool_selection_outcome,
    positiveText: "tool selection succeeded",
    negativeText: "tool selection failed",
    sourceRef: "tool_selection_outcome_v1",
    positiveCapabilities: ["learning"],
    negativeCapabilities: ["learning", "learning_control"],
  }));

  appendUnique(entries, collectBooleanOutcome({
    kind: "workflow_reuse_outcome",
    value: slots.workflow_reuse_outcome_v1 ?? slots.workflow_reuse_outcome,
    positiveText: "workflow reuse succeeded",
    negativeText: "workflow reuse failed",
    sourceRef: "workflow_reuse_outcome_v1",
    positiveCapabilities: ["continuity", "learning"],
    negativeCapabilities: ["continuity", "learning", "forgetting"],
  }));

  for (const adaptiveGuidanceOutcome of collectAdaptiveGuidanceOutcomeEntries({ slots, records, executionResultSummary })) {
    appendUnique(entries, adaptiveGuidanceOutcome);
  }

  appendUnique(entries, collectBooleanOutcome({
    kind: "rehydration_usefulness",
    value: slots.rehydration_feedback_v1 ?? slots.rehydration_usefulness,
    positiveText: "rehydration was useful",
    negativeText: "rehydration was not useful",
    sourceRef: "rehydration_feedback_v1",
    positiveCapabilities: ["continuity", "forgetting"],
    negativeCapabilities: ["forgetting"],
  }));

  appendUnique(entries, collectContextPressure(slots, records));
  appendUnique(entries, collectMaintenanceEffect(slots, records));

  if (actionContract) {
    const gate = asRecord(actionContract.pre_action_gate);
    if (gate && booleanField(gate.known_enough) === false) {
      appendUnique(entries, entry({
        signal_kind: "repeated_discovery",
        polarity: "negative",
        numeric_value: 1,
        text_value: compactText(gate.primary_reason) ?? "pre-action gate required more recall before action",
        source_refs: ["action_intelligence_pre_action_gate_v1"],
        affected_capabilities: ["continuity", "learning"],
        authority_effect: "promotion_evidence_candidate",
      }));
    }
  }

  const sorted = entries
    .filter((item, index, all) => all.findIndex((entry) => entry.signal_id === item.signal_id) === index)
    .slice(0, 64);
  if (sorted.length === 0) return null;

  return RuntimeSignalLedgerV1Schema.parse({
    ledger_version: "runtime_signal_ledger_v1",
    signal_count: sorted.length,
    positive_signal_count: sorted.filter((entry) => entry.polarity === "positive").length,
    negative_signal_count: sorted.filter((entry) => entry.polarity === "negative").length,
    quarantine_signal_count: sorted.filter((entry) => entry.authority_effect === "quarantine").length,
    entries: sorted,
    source_code_change_allowed: false,
  });
}
