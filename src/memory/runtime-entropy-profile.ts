import {
  RuntimeEntropyProfileV1Schema,
  type ActionIntelligenceRuntimeEvidenceSummary,
  type ActionIntelligenceRuntimeGate,
  type ActionIntelligenceRuntimeLifecycle,
  type ActionRetrievalResponse,
  type RuntimeEntropyLevel,
  type RuntimeEntropyProfileV1,
  type RuntimeMutationAuthority,
  type RuntimePlasticityLevel,
  type RuntimePromotionThreshold,
  type RuntimeRecallBreadth,
  type RuntimeSignalKind,
  type RuntimeSignalLedgerV1,
  type RuntimeSignalTrendSummaryV1,
  type RuntimeVerificationDepth,
} from "./schemas.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function uniqueReasonCodes(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized.slice(0, 128));
    if (out.length >= 32) break;
  }
  return out;
}

function sourceSignals(
  ledger: RuntimeSignalLedgerV1 | null | undefined,
  trend: RuntimeSignalTrendSummaryV1 | null | undefined,
): RuntimeSignalKind[] {
  const out: RuntimeSignalKind[] = [];
  const seen = new Set<string>();
  const push = (kind: RuntimeSignalKind) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    out.push(kind);
  };
  for (const entry of ledger?.entries ?? []) {
    push(entry.signal_kind);
    if (out.length >= 64) break;
  }
  for (const count of trend?.signal_counts ?? []) {
    push(count.signal_kind);
    if (out.length >= 64) break;
  }
  return out;
}

function countSignals(
  ledger: RuntimeSignalLedgerV1 | null | undefined,
  predicate: (kind: RuntimeSignalKind, polarity: string, effect: string) => boolean,
): number {
  return (ledger?.entries ?? []).filter((entry) =>
    predicate(entry.signal_kind, entry.polarity, entry.authority_effect)
  ).length;
}

function hasSignal(
  ledger: RuntimeSignalLedgerV1 | null | undefined,
  kind: RuntimeSignalKind,
  polarity?: "positive" | "neutral" | "negative",
): boolean {
  return (ledger?.entries ?? []).some((entry) =>
    entry.signal_kind === kind && (!polarity || entry.polarity === polarity)
  );
}

function trendHasSignal(
  trend: RuntimeSignalTrendSummaryV1 | null | undefined,
  kind: RuntimeSignalKind,
  polarity?: "positive" | "neutral" | "negative",
): boolean {
  const count = (trend?.signal_counts ?? []).find((entry) => entry.signal_kind === kind);
  if (!count) return false;
  if (!polarity) return count.total > 0;
  return count[polarity] > 0;
}

function entropyLevel(args: {
  lockdown: boolean;
  exploration: number;
  control: number;
}): RuntimeEntropyLevel {
  if (args.lockdown) return "lockdown";
  if (args.exploration >= 0.68) return "high";
  if (args.exploration <= 0.32 && args.control <= 0.72) return "low";
  return "medium";
}

function plasticityLevel(args: {
  level: RuntimeEntropyLevel;
  exploration: number;
}): RuntimePlasticityLevel {
  if (args.level === "lockdown" || args.exploration <= 0.32) return "low";
  if (args.level === "high" || args.exploration >= 0.62) return "high";
  return "medium";
}

function recallBreadth(args: {
  level: RuntimeEntropyLevel;
  preActionGate: ActionIntelligenceRuntimeGate;
  hasRepeatedDiscovery: boolean;
  hasTokenPressure: boolean;
  hasStableReuse: boolean;
}): RuntimeRecallBreadth {
  if (args.preActionGate.requires_recall || args.hasRepeatedDiscovery) return "wide";
  if (args.level === "high") return "wide";
  if (args.hasTokenPressure && !args.preActionGate.requires_rehydration) return "narrow";
  if (args.level === "low" && args.hasStableReuse) return "narrow";
  return "balanced";
}

function verificationDepth(args: {
  level: RuntimeEntropyLevel;
  negativeVerifier: boolean;
  retryOrRecovery: boolean;
  uncertaintyLevel: "low" | "moderate" | "high";
}): RuntimeVerificationDepth {
  if (args.level === "lockdown" || args.negativeVerifier || args.retryOrRecovery || args.uncertaintyLevel === "high") {
    return "strict";
  }
  if (args.level === "low" && args.uncertaintyLevel === "low") return "light";
  return "normal";
}

function promotionThreshold(args: {
  level: RuntimeEntropyLevel;
  hasCounterEvidence: boolean;
  hasQuarantine: boolean;
  positiveVerifier: boolean;
  hasStableReuse: boolean;
}): RuntimePromotionThreshold {
  if (args.level === "lockdown" || args.hasQuarantine) return "blocked";
  if (args.hasCounterEvidence || args.level === "high") return "high";
  if (args.level === "low" && args.positiveVerifier && args.hasStableReuse) return "normal";
  return "normal";
}

function mutationAuthority(args: {
  level: RuntimeEntropyLevel;
  lifecycle: ActionIntelligenceRuntimeLifecycle;
  hasCounterEvidence: boolean;
  hasQuarantine: boolean;
  positiveVerifier: boolean;
  hasStableReuse: boolean;
}): RuntimeMutationAuthority {
  if (args.level === "lockdown" || args.hasQuarantine) return "none";
  if (args.hasCounterEvidence || args.level === "high") return "candidate_only";
  if (args.level === "low" && args.positiveVerifier && args.hasStableReuse && args.lifecycle.post_action_material_present) {
    return "stable_allowed";
  }
  if (args.lifecycle.mutation_candidate_available || args.lifecycle.post_action_material_present) return "scoped";
  return "candidate_only";
}

export function buildRuntimeEntropyProfileV1(args: {
  actionRetrieval: ActionRetrievalResponse;
  preActionGate: ActionIntelligenceRuntimeGate;
  evidenceSummary: ActionIntelligenceRuntimeEvidenceSummary;
  lifecycle: ActionIntelligenceRuntimeLifecycle;
  runtimeSignalLedger?: RuntimeSignalLedgerV1 | null;
  runtimeSignalTrendSummary?: RuntimeSignalTrendSummaryV1 | null;
}): RuntimeEntropyProfileV1 {
  let exploration = 0.45;
  let control = 0.45;
  const reasons: Array<string | null> = [];
  const uncertainty = args.actionRetrieval.uncertainty.level;
  const hasStableReuse =
    args.actionRetrieval.history_applied
    && args.evidenceSummary.stable_workflow_count > 0
    && args.evidenceSummary.trusted_pattern_count > 0
    && uncertainty === "low";

  if (!args.actionRetrieval.history_applied) {
    exploration += 0.18;
    reasons.push("history_not_applied");
  }
  if (uncertainty === "high") {
    exploration += 0.24;
    control += 0.18;
    reasons.push("high_action_uncertainty");
  } else if (uncertainty === "moderate") {
    exploration += 0.12;
    control += 0.08;
    reasons.push("moderate_action_uncertainty");
  }
  if (args.preActionGate.requires_recall) {
    exploration += 0.2;
    reasons.push("pre_action_requires_wider_recall");
  }
  if (args.preActionGate.requires_rehydration) {
    exploration += 0.08;
    control += 0.1;
    reasons.push("pre_action_requires_rehydration");
  }
  if (args.evidenceSummary.candidate_workflow_count > 0 && args.evidenceSummary.stable_workflow_count === 0) {
    exploration += 0.12;
    reasons.push("candidate_workflow_without_stable_reuse");
  }
  if (args.evidenceSummary.adaptive_guidance_candidate_count > 0 && args.evidenceSummary.stable_workflow_count === 0) {
    exploration += 0.08;
    control += 0.04;
    reasons.push("adaptive_guidance_candidate_without_stable_reuse");
  }
  if (args.evidenceSummary.rehydration_candidate_count > 0) {
    exploration += 0.06;
    reasons.push("rehydration_candidate_visible");
  }
  if (hasStableReuse) {
    exploration -= 0.22;
    control -= 0.05;
    reasons.push("stable_workflow_and_trusted_pattern_available");
  }

  const trendPosture = args.runtimeSignalTrendSummary?.recommended_runtime_posture ?? "none";
  const hasQuarantine =
    countSignals(args.runtimeSignalLedger, (_kind, _polarity, effect) => effect === "quarantine") > 0
    || (args.runtimeSignalTrendSummary?.quarantine_signal_count ?? 0) > 0
    || trendPosture === "quarantine";
  const hasCounterEvidence =
    countSignals(args.runtimeSignalLedger, (_kind, _polarity, effect) => effect === "counter_evidence") > 0
    || (args.runtimeSignalTrendSummary?.counter_evidence_count ?? 0) > 0
    || trendPosture === "constrain";
  const negativeVerifier =
    hasSignal(args.runtimeSignalLedger, "verifier_result", "negative")
    || trendHasSignal(args.runtimeSignalTrendSummary, "verifier_result", "negative");
  const positiveVerifier = hasSignal(args.runtimeSignalLedger, "verifier_result", "positive");
  const positiveAdaptiveGuidance =
    hasSignal(args.runtimeSignalLedger, "adaptive_guidance_outcome", "positive")
    || trendHasSignal(args.runtimeSignalTrendSummary, "adaptive_guidance_outcome", "positive");
  const hasRepeatedDiscovery =
    hasSignal(args.runtimeSignalLedger, "repeated_discovery", "negative")
    || trendHasSignal(args.runtimeSignalTrendSummary, "repeated_discovery", "negative");
  const retryOrRecovery =
    hasSignal(args.runtimeSignalLedger, "retry_count", "negative")
    || hasSignal(args.runtimeSignalLedger, "recovery_cost", "negative")
    || trendHasSignal(args.runtimeSignalTrendSummary, "retry_count", "negative")
    || trendHasSignal(args.runtimeSignalTrendSummary, "recovery_cost", "negative");
  const hasTokenPressure =
    hasSignal(args.runtimeSignalLedger, "token_context_pressure", "negative")
    || trendHasSignal(args.runtimeSignalTrendSummary, "token_context_pressure", "negative");

  if (trendPosture === "explore") {
    exploration += 0.12;
    reasons.push("runtime_signal_trend_explore");
  } else if (trendPosture === "constrain") {
    control += 0.14;
    reasons.push("runtime_signal_trend_constrain");
  } else if (trendPosture === "reuse" && hasStableReuse) {
    exploration -= 0.06;
    reasons.push("runtime_signal_trend_reuse");
  }

  if (hasRepeatedDiscovery) {
    exploration += 0.16;
    reasons.push("runtime_signal_repeated_discovery");
  }
  if (negativeVerifier) {
    control += 0.14;
    exploration += retryOrRecovery ? 0.14 : 0.08;
    reasons.push("runtime_signal_verifier_failed");
    reasons.push("runtime_signal_verifier_failure_requires_counterfactual_exploration");
  }
  if (retryOrRecovery) {
    control += 0.12;
    exploration += negativeVerifier ? 0.08 : 0.06;
    reasons.push("runtime_signal_retry_or_recovery_cost");
  }
  if (hasCounterEvidence) {
    control += 0.16;
    reasons.push(
      (args.runtimeSignalTrendSummary?.counter_evidence_count ?? 0) > 0
        ? "runtime_signal_trend_counter_evidence"
        : "runtime_signal_counter_evidence",
    );
  }
  if (hasTokenPressure) {
    control += 0.1;
    exploration -= 0.06;
    reasons.push("runtime_signal_token_context_pressure");
  }
  if (positiveVerifier && hasStableReuse) {
    exploration -= 0.08;
    reasons.push("runtime_signal_positive_verification");
  }
  if (positiveAdaptiveGuidance && !hasCounterEvidence) {
    exploration -= 0.04;
    reasons.push("runtime_signal_positive_adaptive_guidance");
  }

  const lockdown =
    hasQuarantine
    || args.preActionGate.authority_blocked
    || args.preActionGate.requires_operator_review;
  if (lockdown) {
    control = 1;
    exploration = Math.min(exploration, 0.12);
    reasons.push(hasQuarantine ? "runtime_signal_quarantine" : "authority_or_operator_review_required");
  }

  const clampedExploration = clamp01(exploration);
  const clampedControl = clamp01(control);
  const level = entropyLevel({
    lockdown,
    exploration: clampedExploration,
    control: clampedControl,
  });

  return RuntimeEntropyProfileV1Schema.parse({
    profile_version: "runtime_entropy_profile_v1",
    entropy_level: level,
    exploration_budget: clampedExploration,
    control_strength: clampedControl,
    plasticity_level: plasticityLevel({ level, exploration: clampedExploration }),
    recall_breadth: recallBreadth({
      level,
      preActionGate: args.preActionGate,
      hasRepeatedDiscovery,
      hasTokenPressure,
      hasStableReuse,
    }),
    verification_depth: verificationDepth({
      level,
      negativeVerifier,
      retryOrRecovery,
      uncertaintyLevel: uncertainty,
    }),
    promotion_threshold: promotionThreshold({
      level,
      hasCounterEvidence,
      hasQuarantine,
      positiveVerifier,
      hasStableReuse,
    }),
    mutation_authority: mutationAuthority({
      level,
      lifecycle: args.lifecycle,
      hasCounterEvidence,
      hasQuarantine,
      positiveVerifier,
      hasStableReuse,
    }),
    runtime_signal_trend_posture: trendPosture,
    reason_codes: uniqueReasonCodes(reasons),
    source_signals: sourceSignals(args.runtimeSignalLedger, args.runtimeSignalTrendSummary),
    source_code_change_allowed: false,
  });
}
