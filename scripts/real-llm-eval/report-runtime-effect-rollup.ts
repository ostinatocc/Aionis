export type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
}

function safeRate(count: number, total: number): number | null {
  return total > 0 ? Number((count / total).toFixed(6)) : null;
}

function objectAt(root: JsonObject | null | undefined, path: string[]): JsonObject | null {
  let current: unknown = root;
  for (const key of path) {
    current = asObject(current)?.[key];
  }
  return asObject(current);
}

function numberAt(root: JsonObject | null | undefined, path: string[]): number {
  let current: unknown = root;
  for (const key of path) {
    current = asObject(current)?.[key];
  }
  return numeric(current);
}

function numberOrNullAt(root: JsonObject | null | undefined, path: string[]): number | null {
  let current: unknown = root;
  for (const key of path) {
    current = asObject(current)?.[key];
  }
  return numericOrNull(current);
}

function booleanAt(root: JsonObject | null | undefined, path: string[]): boolean {
  let current: unknown = root;
  for (const key of path) {
    current = asObject(current)?.[key];
  }
  return current === true;
}

function comparisonNumbers(taskReports: JsonObject[], key: string): number[] {
  return taskReports
    .map((report) => numberOrNullAt(report, ["comparison", key]))
    .filter((value): value is number => value !== null);
}

function countByString(values: Array<string | null>, defaults: string[]): JsonObject {
  const out: Record<string, number> = Object.fromEntries(defaults.map((key) => [key, 0]));
  for (const value of values) {
    if (!value) continue;
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function sumNested(objects: JsonObject[], path: string[]): number {
  return objects.reduce((sum, item) => sum + numberAt(item, path), 0);
}

function weightedAverage(objects: JsonObject[], valuePath: string[], weightFor: (item: JsonObject) => number): number | null {
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const item of objects) {
    const value = numberOrNullAt(item, valuePath);
    if (value === null) continue;
    const weight = Math.max(0, weightFor(item));
    if (weight <= 0) continue;
    weightedTotal += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? Number((weightedTotal / weightTotal).toFixed(6)) : null;
}

function comparisonSignalSummary(comparison: JsonObject | null | undefined): JsonObject {
  if (!comparison) {
    return {
      assisted_effect_quality: "insufficient_comparison",
      positive_signals: [],
      regression_signals: ["missing_baseline_comparison"],
    };
  }

  const positiveSignals: string[] = [];
  const regressionSignals: string[] = [];

  if (comparison.verifier_improved === true) positiveSignals.push("verifier_improved");
  if (comparison.first_action_improved === true) positiveSignals.push("first_action_improved");

  const repeatedDiscoveryDelta = numericOrNull(comparison.repeated_discovery_delta);
  if (repeatedDiscoveryDelta !== null) {
    if (repeatedDiscoveryDelta > 0) positiveSignals.push("fewer_repeated_discovery_steps");
    if (repeatedDiscoveryDelta < 0) regressionSignals.push("more_repeated_discovery_steps");
  }

  const wrongFileTouchDelta = numericOrNull(comparison.wrong_file_touch_delta);
  if (wrongFileTouchDelta !== null) {
    if (wrongFileTouchDelta > 0) positiveSignals.push("fewer_wrong_file_touches");
    if (wrongFileTouchDelta < 0) regressionSignals.push("more_wrong_file_touches");
  }

  const toolStepDelta = numericOrNull(comparison.tool_step_delta);
  if (toolStepDelta !== null) {
    if (toolStepDelta > 0) positiveSignals.push("fewer_tool_steps");
    if (toolStepDelta < 0) regressionSignals.push("more_tool_steps");
  }

  const tokenDelta = numericOrNull(comparison.token_delta);
  if (tokenDelta !== null) {
    if (tokenDelta > 0) positiveSignals.push("lower_token_usage");
    if (tokenDelta < 0) regressionSignals.push("higher_token_usage");
  }

  const timeDelta = numericOrNull(comparison.time_delta_ms);
  if (timeDelta !== null) {
    if (timeDelta > 0) positiveSignals.push("faster_finish");
    if (timeDelta < 0) regressionSignals.push("slower_finish");
  }

  if (numeric(comparison.assisted_prior_success_invariant_uptake_count) > 0) {
    positiveSignals.push("prior_success_invariant_uptake");
  }
  if (comparison.assisted_repair_loop_succeeded === true) {
    positiveSignals.push("verifier_feedback_repair_succeeded");
  }

  if (comparison.assisted_context_budget_exceeded === true) {
    regressionSignals.push("context_budget_exceeded");
  }

  if (comparison.assisted_verifier_regressed === true) {
    regressionSignals.unshift("verifier_regressed");
  }
  if (comparison.assisted_verifier_passed !== true) {
    regressionSignals.unshift("assisted_verifier_failed");
  }

  let assistedEffectQuality = "neutral";
  if (comparison.assisted_verifier_regressed === true) {
    assistedEffectQuality = "regressed";
  } else if (comparison.assisted_verifier_passed !== true && positiveSignals.length > 0) {
    assistedEffectQuality = "failed_but_improved";
  } else if (comparison.assisted_verifier_passed !== true) {
    assistedEffectQuality = "failed";
  } else if (positiveSignals.length > 0 && regressionSignals.length === 0) {
    assistedEffectQuality = "positive";
  } else if (positiveSignals.length > 0 && regressionSignals.length > 0) {
    assistedEffectQuality = "mixed_positive";
  } else if (positiveSignals.length === 0 && regressionSignals.length > 0) {
    assistedEffectQuality = "mixed_negative";
  }

  return {
    assisted_effect_quality: assistedEffectQuality,
    positive_signals: positiveSignals,
    regression_signals: regressionSignals,
  };
}

function comparisonFromTaskReport(report: JsonObject): JsonObject | null {
  const comparison = asObject(report.comparison);
  if (!comparison) return null;
  const baselineMetrics = runMetrics(report, "baseline");
  const assistedMetrics = runMetrics(report, "aionis");
  return {
    ...comparison,
    baseline_verifier_passed: comparison.baseline_verifier_passed ?? (baselineMetrics.verifier_passed === true),
    assisted_verifier_passed: comparison.assisted_verifier_passed ?? (assistedMetrics.verifier_passed === true),
  };
}

function signalCounts(summaries: JsonObject[], key: "positive_signals" | "regression_signals"): JsonObject {
  const out: Record<string, number> = {};
  for (const summary of summaries) {
    const signals = Array.isArray(summary[key]) ? summary[key] : [];
    for (const signal of signals) {
      if (typeof signal !== "string" || signal.length === 0) continue;
      out[signal] = (out[signal] ?? 0) + 1;
    }
  }
  return out;
}

function runMetrics(report: JsonObject, arm: "baseline" | "aionis"): JsonObject {
  return objectAt(report, [arm, "metrics"]) ?? {};
}

function runSucceeded(report: JsonObject, arm: "baseline" | "aionis"): boolean {
  const run = asObject(report[arm]);
  const metrics = runMetrics(report, arm);
  return run?.status === "success" || metrics.verifier_passed === true;
}

export function runtimeEffectSummaryFromTaskReport(report: JsonObject): JsonObject | null {
  const maintenance = asObject(report.runtime_maintenance);
  const after = asObject(maintenance?.after);
  const before = asObject(maintenance?.before);
  return asObject(after?.runtime_effect_summary)
    ?? asObject(maintenance?.runtime_effect_summary)
    ?? asObject(maintenance?.runtime_effect_summary_v1)
    ?? asObject(before?.runtime_effect_summary);
}

export function promotionQualitySummaryFromTaskReport(report: JsonObject): JsonObject | null {
  const maintenance = asObject(report.runtime_maintenance);
  const after = asObject(maintenance?.after);
  const before = asObject(maintenance?.before);
  return asObject(after?.promotion_quality_summary)
    ?? asObject(maintenance?.promotion_quality_summary)
    ?? asObject(maintenance?.promotion_quality_summary_v1)
    ?? asObject(before?.promotion_quality_summary);
}

export function buildRuntimeEffectRollupFromTaskReports(taskReports: JsonObject[]): JsonObject {
  const runtimeEffects = taskReports
    .map(runtimeEffectSummaryFromTaskReport)
    .filter((summary): summary is JsonObject => !!summary);
  const promotionSummaries = taskReports
    .map(promotionQualitySummaryFromTaskReport)
    .filter((summary): summary is JsonObject => !!summary);
  const taskIdsWithRuntimeEvidence = taskReports
    .filter((report) => runtimeEffectSummaryFromTaskReport(report) || promotionQualitySummaryFromTaskReport(report))
    .map((report) => asString(report.task_id))
    .filter((taskId): taskId is string => !!taskId)
    .slice(0, 128);
  const comparisons = taskReports
    .map(comparisonFromTaskReport)
    .filter((comparison): comparison is JsonObject => !!comparison);
  const comparisonSignalSummaries = comparisons.map(comparisonSignalSummary);
  const assistedEffectQualities = comparisonSignalSummaries
    .map((summary) => asString(summary.assisted_effect_quality));
  const baselineSuccessCount = taskReports.filter((report) => runSucceeded(report, "baseline")).length;
  const assistedSuccessCount = taskReports.filter((report) => runSucceeded(report, "aionis")).length;
  const runtimeEffectPostures = runtimeEffects.map((summary) => asString(summary.measurable_effect_posture));
  const promotionPressures = promotionSummaries.map((summary) => asString(summary.invalidation_pressure));
  const runtimeLearning = runtimeEffects.map((summary) => objectAt(summary, ["learning"]) ?? {});
  const promotionLedgerWeight = (summary: JsonObject) => numberAt(summary, ["included_promotion_ledger_count"]);
  const promotionQualityWeight = (summary: JsonObject) => numberAt(summary, ["included_ledger_count"]);

  const budgetWeight = (summary: JsonObject) => {
    const tokenContext = objectAt(summary, ["token_context"]) ?? {};
    const observedBudgetCount = numberAt(tokenContext, ["within_budget_count"])
      + numberAt(tokenContext, ["over_budget_count"]);
    return observedBudgetCount > 0 ? observedBudgetCount : numberAt(tokenContext, ["observed_count"]);
  };

  const contextObservedCount = sumNested(runtimeEffects, ["token_context", "observed_count"]);
  const runtimeEffectPositiveTaskCount = runtimeEffectPostures.filter((posture) => posture === "positive").length;
  const runtimeEffectConstrainedOrBlockedTaskCount = runtimeEffectPostures
    .filter((posture) => posture === "constrained" || posture === "blocked").length;

  return {
    rollup_version: "aionis_real_llm_runtime_effect_rollup_v1",
    baseline_comparison_required: true,
    baseline_comparison_present: comparisons.length === taskReports.length && taskReports.length > 0,
    effect_claim_status: runtimeEffects.length > 0 && comparisons.length > 0
      ? "measurement_only_requires_effect_gate"
      : "insufficient_runtime_or_baseline_evidence",
    task_count: taskReports.length,
    task_with_runtime_effect_summary_count: runtimeEffects.length,
    task_with_promotion_quality_summary_count: promotionSummaries.length,
    baseline_success_count: baselineSuccessCount,
    assisted_success_count: assistedSuccessCount,
    baseline_success_rate: safeRate(baselineSuccessCount, taskReports.length),
    assisted_success_rate: safeRate(assistedSuccessCount, taskReports.length),
    verifier_improved_count: comparisons.filter((comparison) => comparison.verifier_improved === true).length,
    verifier_equal_or_better_count: comparisons.filter((comparison) => comparison.verifier_equal_or_better === true).length,
    assisted_verifier_regression_count: comparisons.filter((comparison) => comparison.assisted_verifier_regressed === true).length,
    first_action_improved_count: comparisons.filter((comparison) => comparison.first_action_improved === true).length,
    average_repeated_discovery_delta: average(comparisonNumbers(taskReports, "repeated_discovery_delta")),
    average_wrong_file_touch_delta: average(comparisonNumbers(taskReports, "wrong_file_touch_delta")),
    average_tool_step_delta: average(comparisonNumbers(taskReports, "tool_step_delta")),
    average_token_delta: average(comparisonNumbers(taskReports, "token_delta")),
    baseline_comparison_quality: {
      quality_counts: countByString(assistedEffectQualities, [
        "positive",
        "mixed_positive",
        "neutral",
        "mixed_negative",
        "regressed",
        "failed_but_improved",
        "failed",
        "insufficient_comparison",
      ]),
      strict_positive_count: assistedEffectQualities.filter((quality) => quality === "positive").length,
      positive_or_mixed_positive_count: assistedEffectQualities
        .filter((quality) => quality === "positive" || quality === "mixed_positive").length,
      regressed_or_mixed_negative_count: assistedEffectQualities
        .filter((quality) =>
          quality === "regressed"
          || quality === "mixed_negative"
          || quality === "failed_but_improved"
          || quality === "failed"
        ).length,
      positive_signal_counts: signalCounts(comparisonSignalSummaries, "positive_signals"),
      regression_signal_counts: signalCounts(comparisonSignalSummaries, "regression_signals"),
    },
    semantic_invariant_uptake: {
      observed_task_count: comparisons
        .filter((comparison) => numeric(comparison.assisted_prior_success_invariant_count) > 0).length,
      average_assisted_prior_success_invariant_uptake_rate:
        average(comparisonNumbers(taskReports, "assisted_prior_success_invariant_uptake_rate")),
      assisted_prior_success_invariant_count: comparisons
        .reduce((sum, comparison) => sum + numeric(comparison.assisted_prior_success_invariant_count), 0),
      assisted_prior_success_invariant_uptake_count: comparisons
        .reduce((sum, comparison) => sum + numeric(comparison.assisted_prior_success_invariant_uptake_count), 0),
      assisted_prior_success_invariant_missing_count: comparisons
        .reduce((sum, comparison) => sum + numeric(comparison.assisted_prior_success_invariant_missing_count), 0),
    },
    assistance_gate: {
      mode_counts: countByString(
        comparisons.map((comparison) => asString(comparison.assisted_assistance_mode)),
        ["no_op", "minimal_boundary", "compact_contract", "semantic_evidence", "strict_governance"],
      ),
      average_assisted_aionis_context_char_count:
        average(comparisonNumbers(taskReports, "assisted_aionis_context_char_count")),
      average_assisted_compact_contract_char_count:
        average(comparisonNumbers(taskReports, "assisted_aionis_compact_contract_char_count")),
      assisted_context_budget_exceeded_count: comparisons
        .filter((comparison) => comparison.assisted_context_budget_exceeded === true).length,
    },
    verifier_feedback_repair_loop: {
      baseline_repair_used_count: comparisons
        .filter((comparison) => numeric(comparison.baseline_repair_attempt_count) > 0).length,
      assisted_repair_used_count: comparisons
        .filter((comparison) => numeric(comparison.assisted_repair_attempt_count) > 0).length,
      assisted_repair_succeeded_count: comparisons
        .filter((comparison) => comparison.assisted_repair_loop_succeeded === true).length,
      average_baseline_repair_attempt_count:
        average(comparisonNumbers(taskReports, "baseline_repair_attempt_count")),
      average_assisted_repair_attempt_count:
        average(comparisonNumbers(taskReports, "assisted_repair_attempt_count")),
      assisted_repair_failure_evidence_count: comparisons
        .reduce((sum, comparison) => sum + numeric(comparison.assisted_repair_failure_evidence_count), 0),
      assisted_repair_repeated_failure_count: comparisons
        .reduce((sum, comparison) => sum + numeric(comparison.assisted_repair_repeated_failure_count), 0),
      assisted_repair_stagnation_detected_count: comparisons
        .filter((comparison) => comparison.assisted_repair_stagnation_detected === true).length,
    },
    runtime_effect_posture_counts: countByString(runtimeEffectPostures, [
      "insufficient_evidence",
      "positive",
      "mixed",
      "constrained",
      "blocked",
    ]),
    runtime_effect_positive_task_count: runtimeEffectPositiveTaskCount,
    runtime_effect_constrained_or_blocked_task_count: runtimeEffectConstrainedOrBlockedTaskCount,
    promotion_invalidation_pressure_counts: countByString(promotionPressures, ["none", "low", "medium", "high"]),
    runtime_context: {
      observation_count: contextObservedCount,
      within_budget_count: sumNested(runtimeEffects, ["token_context", "within_budget_count"]),
      over_budget_count: sumNested(runtimeEffects, ["token_context", "over_budget_count"]),
      unknown_budget_count: sumNested(runtimeEffects, ["token_context", "unknown_budget_count"]),
      average_est_tokens: weightedAverage(runtimeEffects, ["token_context", "average_est_tokens"], (summary) =>
        numberAt(summary, ["token_context", "observed_count"])
      ),
      average_token_budget: weightedAverage(runtimeEffects, ["token_context", "average_token_budget"], budgetWeight),
      max_est_tokens: Math.max(0, ...runtimeEffects.map((summary) => numberAt(summary, ["token_context", "max_est_tokens"]))),
      context_items_reduced_count: sumNested(runtimeEffects, ["token_context", "context_items_reduced_count"]),
    },
    runtime_continuity: {
      repeated_discovery_count: sumNested(runtimeEffects, ["continuity", "repeated_discovery_count"]),
      repeated_failed_action_count: sumNested(runtimeEffects, ["continuity", "repeated_failed_action_count"]),
      first_action_ready_signal_count: sumNested(runtimeEffects, ["continuity", "first_action_ready_signal_count"]),
    },
    runtime_verification: {
      verifier_success_count: sumNested(runtimeEffects, ["verification", "verifier_success_count"]),
      verifier_failure_count: sumNested(runtimeEffects, ["verification", "verifier_failure_count"]),
      retry_count_total: sumNested(runtimeEffects, ["verification", "retry_count_total"]),
      recovery_cost_total: sumNested(runtimeEffects, ["verification", "recovery_cost_total"]),
      provider_quarantine_count: sumNested(runtimeEffects, ["verification", "provider_quarantine_count"]),
    },
    runtime_learning: {
      workflow_reuse_success_count: sumNested(runtimeEffects, ["learning", "workflow_reuse_success_count"]),
      workflow_reuse_failure_count: sumNested(runtimeEffects, ["learning", "workflow_reuse_failure_count"]),
      tool_selection_success_count: sumNested(runtimeEffects, ["learning", "tool_selection_success_count"]),
      tool_selection_failure_count: sumNested(runtimeEffects, ["learning", "tool_selection_failure_count"]),
      average_promotion_admission_rate: weightedAverage(runtimeEffects, ["learning", "promotion_admission_rate"], promotionLedgerWeight),
      average_promotion_contested_rate: weightedAverage(runtimeEffects, ["learning", "promotion_contested_rate"], promotionLedgerWeight),
      average_quality_admission_rate: weightedAverage(promotionSummaries, ["promotion_admission_rate"], promotionQualityWeight),
      average_quality_contested_rate: weightedAverage(promotionSummaries, ["contested_rate"], promotionQualityWeight),
      recommended_learning_posture_counts: countByString(
        runtimeLearning.map((summary) => asString(summary.recommended_learning_posture)),
        ["explore", "promotion_ready", "constrain", "invalidate"],
      ),
    },
    runtime_forgetting: {
      forgetting_signal_count: sumNested(runtimeEffects, ["forgetting", "forgetting_signal_count"]),
      memory_demotions: sumNested(runtimeEffects, ["forgetting", "memory_demotions"]),
      memory_archives: sumNested(runtimeEffects, ["forgetting", "memory_archives"]),
      rehydration_useful_count: sumNested(runtimeEffects, ["forgetting", "rehydration_useful_count"]),
      rehydration_unhelpful_count: sumNested(runtimeEffects, ["forgetting", "rehydration_unhelpful_count"]),
    },
    runtime_effect_baseline_comparison_required_count: runtimeEffects
      .filter((summary) => booleanAt(summary, ["baseline_comparison_required"])).length,
    source: "runtime_maintenance_after_snapshots",
    source_task_ids: taskIdsWithRuntimeEvidence,
    source_code_change_allowed: false,
  };
}
