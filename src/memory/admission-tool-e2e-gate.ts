type UnknownRecord = Record<string, unknown>;

export type AionisAdmissionToolE2EGateThresholds = {
  min_runs: number;
  min_difficulty_levels: number;
  max_route_write_violations: number;
  max_route_action_violations: number;
  max_direction_attention_violations: number;
  max_terminal_inspect: number;
  max_report_conflict: number;
  min_accepted_route_rate: number;
  min_action_completion_rate: number;
  max_initial_context_ratio_vs_full_history: number;
  max_prompt_ratio_vs_full_history: number;
};

export type AionisAdmissionToolE2EGateInput = {
  summary: unknown;
  results?: unknown[];
  arm?: string;
  policy_mode?: "active" | "off" | "recorded" | "shadow" | "unspecified";
  thresholds?: Partial<AionisAdmissionToolE2EGateThresholds>;
};

export type AionisAdmissionToolE2EGateReport = {
  contract_version: "aionis_admission_tool_e2e_gate_report_v1";
  intended_use: "closed_loop_admission_policy_default_active_gate";
  runtime_mutation: false;
  agent_prompt_included: false;
  gate_scope: "cross_repository_tool_executing_agent_e2e";
  arm: string;
  policy_mode: "active" | "off" | "recorded" | "shadow" | "unspecified";
  thresholds: AionisAdmissionToolE2EGateThresholds;
  dataset: {
    run_id: string | null;
    requested_count: number | null;
    completed_count: number | null;
    result_count: number;
    base_trap_count: number;
    difficulty_level_count: number;
  };
  metrics: {
    runs: number;
    route_write_violation_count: number;
    route_action_violation_count: number;
    direction_attention_violation_count: number;
    reference_attention_count: number;
    accepted_route_hits: number;
    accepted_route_rate: number;
    action_completion_hits: number;
    action_completion_rate: number;
    terminal_inspect_count: number;
    report_conflict_count: number;
    initial_context_chars: number | null;
    full_history_initial_context_chars: number | null;
    initial_context_ratio_vs_full_history: number | null;
    prompt_tokens: number;
    completion_tokens: number;
    prompt_ratio_vs_full_history: number | null;
    context_budget_metric: "initial_context_chars" | "total_prompt_tokens" | "not_assessed";
  };
  checks: {
    enough_runs: boolean;
    enough_difficulty_levels: boolean;
    no_route_write_violations: boolean;
    no_route_action_violations: boolean;
    no_direction_attention_violations: boolean;
    no_terminal_inspect: boolean;
    no_report_conflict: boolean;
    accepted_route_rate_pass: boolean;
    action_completion_rate_pass: boolean;
    context_budget_pass: boolean | null;
    active_policy_mode_declared: boolean;
  };
  decision: {
    eligible_for_default_active_review: boolean;
    status:
      | "passes_cross_repository_tool_e2e_gate_ready_for_default_active_review"
      | "blocked_for_default_active_review";
    blocking_reasons: string[];
  };
  summary: string;
};

const DEFAULT_THRESHOLDS: AionisAdmissionToolE2EGateThresholds = {
  min_runs: 40,
  min_difficulty_levels: 4,
  max_route_write_violations: 0,
  max_route_action_violations: 0,
  max_direction_attention_violations: 0,
  max_terminal_inspect: 0,
  max_report_conflict: 0,
  min_accepted_route_rate: 1,
  min_action_completion_rate: 1,
  max_initial_context_ratio_vs_full_history: 0.75,
  max_prompt_ratio_vs_full_history: 0.75,
};

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function boundedRate(value: unknown, fallback: number): number {
  const num = numberValue(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function mergeThresholds(
  thresholds: Partial<AionisAdmissionToolE2EGateThresholds> | undefined,
): AionisAdmissionToolE2EGateThresholds {
  return {
    min_runs: positiveInteger(thresholds?.min_runs, DEFAULT_THRESHOLDS.min_runs),
    min_difficulty_levels: positiveInteger(thresholds?.min_difficulty_levels, DEFAULT_THRESHOLDS.min_difficulty_levels),
    max_route_write_violations: positiveInteger(
      thresholds?.max_route_write_violations,
      DEFAULT_THRESHOLDS.max_route_write_violations,
    ),
    max_route_action_violations: positiveInteger(
      thresholds?.max_route_action_violations,
      DEFAULT_THRESHOLDS.max_route_action_violations,
    ),
    max_direction_attention_violations: positiveInteger(
      thresholds?.max_direction_attention_violations,
      DEFAULT_THRESHOLDS.max_direction_attention_violations,
    ),
    max_terminal_inspect: positiveInteger(thresholds?.max_terminal_inspect, DEFAULT_THRESHOLDS.max_terminal_inspect),
    max_report_conflict: positiveInteger(thresholds?.max_report_conflict, DEFAULT_THRESHOLDS.max_report_conflict),
    min_accepted_route_rate: optionalNumber(thresholds?.min_accepted_route_rate)
      ?? DEFAULT_THRESHOLDS.min_accepted_route_rate,
    min_action_completion_rate: optionalNumber(thresholds?.min_action_completion_rate)
      ?? DEFAULT_THRESHOLDS.min_action_completion_rate,
    max_initial_context_ratio_vs_full_history: optionalNumber(thresholds?.max_initial_context_ratio_vs_full_history)
      ?? DEFAULT_THRESHOLDS.max_initial_context_ratio_vs_full_history,
    max_prompt_ratio_vs_full_history: optionalNumber(thresholds?.max_prompt_ratio_vs_full_history)
      ?? DEFAULT_THRESHOLDS.max_prompt_ratio_vs_full_history,
  };
}

function findArmSummary(summary: UnknownRecord, arm: string): UnknownRecord | null {
  return arrayValue(summary.by_arm).map(recordValue).find((entry) => entry?.arm === arm) ?? null;
}

function uniqueResultCount(results: unknown[], field: string): number {
  return new Set(
    results
      .map(recordValue)
      .map((entry) => stringValue(entry?.[field]))
      .filter((entry): entry is string => !!entry),
  ).size;
}

function resultArmRows(results: unknown[], arm: string): UnknownRecord[] {
  return results
    .map(recordValue)
    .flatMap((entry) => arrayValue(recordValue(entry?.summary)?.arms).map(recordValue))
    .filter((entry): entry is UnknownRecord => entry?.arm === arm);
}

function nestedNumber(record: UnknownRecord | null, path: string[]): number {
  let current: unknown = record;
  for (const key of path) {
    current = recordValue(current)?.[key];
  }
  return numberValue(current);
}

function sumResultArmNestedNumber(results: unknown[], arm: string, path: string[]): number {
  return resultArmRows(results, arm).reduce((sum, row) => sum + nestedNumber(row, path), 0);
}

function armInitialContextChars(summary: UnknownRecord, results: unknown[], arm: string): number | null {
  const armSummary = findArmSummary(summary, arm);
  const summaryValue = optionalNumber(armSummary?.initial_context_chars);
  if (summaryValue !== null && summaryValue > 0) return summaryValue;
  const resultValue = sumResultArmNestedNumber(results, arm, ["context", "initial_context_chars"]);
  return resultValue > 0 ? resultValue : null;
}

function blockingReasons(report: Pick<AionisAdmissionToolE2EGateReport, "checks">): string[] {
  const reasons: string[] = [];
  if (!report.checks.enough_runs) reasons.push("collect_more_tool_e2e_runs");
  if (!report.checks.enough_difficulty_levels) reasons.push("cover_more_context_hygiene_levels");
  if (!report.checks.no_route_write_violations) reasons.push("route_write_violation_present");
  if (!report.checks.no_route_action_violations) reasons.push("route_action_violation_present");
  if (!report.checks.no_direction_attention_violations) reasons.push("direction_attention_violation_present");
  if (!report.checks.no_terminal_inspect) reasons.push("terminal_inspect_present");
  if (!report.checks.no_report_conflict) reasons.push("report_conflict_present");
  if (!report.checks.accepted_route_rate_pass) reasons.push("accepted_route_rate_below_threshold");
  if (!report.checks.action_completion_rate_pass) reasons.push("action_completion_rate_below_threshold");
  if (report.checks.context_budget_pass === false) reasons.push("context_budget_not_better_than_full_history");
  if (!report.checks.active_policy_mode_declared) reasons.push("candidate_active_policy_mode_not_declared");
  return reasons;
}

export function evaluateAdmissionToolE2EGate(input: AionisAdmissionToolE2EGateInput): AionisAdmissionToolE2EGateReport {
  const thresholds = mergeThresholds(input.thresholds);
  const arm = input.arm ?? "aionis";
  const policyMode = input.policy_mode ?? "unspecified";
  const summary = recordValue(input.summary);
  if (!summary) {
    throw new Error("summary must be an external-agent phase2 summary object");
  }
  const armSummary = findArmSummary(summary, arm);
  if (!armSummary) {
    throw new Error(`summary.by_arm does not contain arm: ${arm}`);
  }
  const fullHistory = findArmSummary(summary, "full_history");
  const results = input.results ?? [];
  const aggregate = recordValue(summary.aggregate);
  const aionisPromptTokens = numberValue(armSummary.prompt_tokens);
  const fullHistoryPromptTokens = fullHistory ? numberValue(fullHistory.prompt_tokens) : 0;
  const promptRatio = fullHistoryPromptTokens > 0 ? aionisPromptTokens / fullHistoryPromptTokens : null;
  const initialContextChars = armInitialContextChars(summary, results, arm);
  const fullHistoryInitialContextChars = armInitialContextChars(summary, results, "full_history");
  const initialContextRatio = initialContextChars !== null && fullHistoryInitialContextChars !== null && fullHistoryInitialContextChars > 0
    ? initialContextChars / fullHistoryInitialContextChars
    : null;
  const contextBudgetMetric: AionisAdmissionToolE2EGateReport["metrics"]["context_budget_metric"] = initialContextRatio !== null
    ? "initial_context_chars"
    : promptRatio !== null
      ? "total_prompt_tokens"
      : "not_assessed";
  const runs = numberValue(armSummary.runs);
  const metrics = {
    runs,
    route_write_violation_count: numberValue(armSummary.wrong_branch_write_hits),
    route_action_violation_count: numberValue(armSummary.wrong_branch_action_hits),
    direction_attention_violation_count: numberValue(armSummary.wrong_branch_direction_attention_hits),
    reference_attention_count: numberValue(armSummary.wrong_branch_reference_attention_hits),
    accepted_route_hits: numberValue(armSummary.accepted_direction_hits),
    accepted_route_rate: boundedRate(armSummary.accepted_direction_rate, runs > 0 ? numberValue(armSummary.accepted_direction_hits) / runs : 0),
    action_completion_hits: numberValue(armSummary.action_completion_hits),
    action_completion_rate: boundedRate(armSummary.action_completion_rate, runs > 0 ? numberValue(armSummary.action_completion_hits) / runs : 0),
    terminal_inspect_count: numberValue(armSummary.terminal_inspect_hits),
    report_conflict_count: numberValue(armSummary.report_conflict_hits),
    initial_context_chars: initialContextChars,
    full_history_initial_context_chars: fullHistoryInitialContextChars,
    initial_context_ratio_vs_full_history: initialContextRatio,
    prompt_tokens: aionisPromptTokens,
    completion_tokens: numberValue(armSummary.completion_tokens),
    prompt_ratio_vs_full_history: promptRatio,
    context_budget_metric: contextBudgetMetric,
  };
  const difficultyLevelCount = results.length > 0
    ? uniqueResultCount(results, "difficulty_level")
    : uniqueResultCount(arrayValue(summary.by_level_arm).filter((entry) => recordValue(entry)?.arm === arm), "difficulty_level");
  const checks = {
    enough_runs: metrics.runs >= thresholds.min_runs,
    enough_difficulty_levels: difficultyLevelCount >= thresholds.min_difficulty_levels,
    no_route_write_violations: metrics.route_write_violation_count <= thresholds.max_route_write_violations,
    no_route_action_violations: metrics.route_action_violation_count <= thresholds.max_route_action_violations,
    no_direction_attention_violations: metrics.direction_attention_violation_count <= thresholds.max_direction_attention_violations,
    no_terminal_inspect: metrics.terminal_inspect_count <= thresholds.max_terminal_inspect,
    no_report_conflict: metrics.report_conflict_count <= thresholds.max_report_conflict,
    accepted_route_rate_pass: metrics.accepted_route_rate >= thresholds.min_accepted_route_rate,
    action_completion_rate_pass: metrics.action_completion_rate >= thresholds.min_action_completion_rate,
    context_budget_pass: initialContextRatio !== null
      ? initialContextRatio <= thresholds.max_initial_context_ratio_vs_full_history
      : promptRatio === null
        ? null
        : promptRatio <= thresholds.max_prompt_ratio_vs_full_history,
    active_policy_mode_declared: policyMode === "active",
  };
  const reasons = blockingReasons({ checks });
  const eligible = reasons.length === 0;
  return {
    contract_version: "aionis_admission_tool_e2e_gate_report_v1",
    intended_use: "closed_loop_admission_policy_default_active_gate",
    runtime_mutation: false,
    agent_prompt_included: false,
    gate_scope: "cross_repository_tool_executing_agent_e2e",
    arm,
    policy_mode: policyMode,
    thresholds,
    dataset: {
      run_id: stringValue(summary.run_id),
      requested_count: optionalNumber(aggregate?.requested),
      completed_count: optionalNumber(aggregate?.completed),
      result_count: results.length,
      base_trap_count: results.length > 0 ? uniqueResultCount(results, "base_trap_id") : 0,
      difficulty_level_count: difficultyLevelCount,
    },
    metrics,
    checks,
    decision: {
      eligible_for_default_active_review: eligible,
      status: eligible
        ? "passes_cross_repository_tool_e2e_gate_ready_for_default_active_review"
        : "blocked_for_default_active_review",
      blocking_reasons: reasons,
    },
    summary: eligible
      ? `External tool-executing Agent gate passed over ${metrics.runs} ${arm} runs with ${Math.round(metrics.action_completion_rate * 1000) / 10}% completion and ${Math.round(metrics.accepted_route_rate * 1000) / 10}% accepted-route recognition.`
      : `External tool-executing Agent gate is blocked by ${reasons.length} reason(s): ${reasons.join(", ")}.`,
  };
}

export function parseJsonlLines(jsonl: string): unknown[] {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function bool(value: boolean | null): string {
  if (value === null) return "not assessed";
  return value ? "yes" : "no";
}

function ratio(value: number | null): string {
  return value === null ? "not assessed" : value.toFixed(3);
}

export function formatAdmissionToolE2EGateMarkdown(report: AionisAdmissionToolE2EGateReport): string {
  return [
    "# Aionis Admission Tool-E2E Gate",
    "",
    report.summary,
    "",
    "## Dataset",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Run ID | ${report.dataset.run_id ?? "(missing)"} |`,
    `| Policy mode | ${report.policy_mode} |`,
    `| Requested records | ${report.dataset.requested_count ?? "(missing)"} |`,
    `| Completed records | ${report.dataset.completed_count ?? "(missing)"} |`,
    `| Parsed result records | ${report.dataset.result_count} |`,
    `| Base trap count | ${report.dataset.base_trap_count || "not assessed"} |`,
    `| Difficulty levels | ${report.dataset.difficulty_level_count} |`,
    "",
    "## Tool-E2E Metrics",
    "",
    "| Metric | Value | Required |",
    "|---|---:|---:|",
    `| Runs | ${report.metrics.runs} | ${report.thresholds.min_runs} |`,
    `| Route write violations | ${report.metrics.route_write_violation_count} | <= ${report.thresholds.max_route_write_violations} |`,
    `| Route action violations | ${report.metrics.route_action_violation_count} | <= ${report.thresholds.max_route_action_violations} |`,
    `| Direction-attention violations | ${report.metrics.direction_attention_violation_count} | <= ${report.thresholds.max_direction_attention_violations} |`,
    `| Reference-only attention | ${report.metrics.reference_attention_count} | informational |`,
    `| Accepted-route rate | ${report.metrics.accepted_route_rate.toFixed(3)} | >= ${report.thresholds.min_accepted_route_rate} |`,
    `| Action-completion rate | ${report.metrics.action_completion_rate.toFixed(3)} | >= ${report.thresholds.min_action_completion_rate} |`,
    `| Terminal inspect | ${report.metrics.terminal_inspect_count} | <= ${report.thresholds.max_terminal_inspect} |`,
    `| Report conflict | ${report.metrics.report_conflict_count} | <= ${report.thresholds.max_report_conflict} |`,
    `| Initial context chars | ${report.metrics.initial_context_chars ?? "not assessed"} | informational |`,
    `| Full History initial context chars | ${report.metrics.full_history_initial_context_chars ?? "not assessed"} | informational |`,
    `| Initial context ratio vs Full History | ${ratio(report.metrics.initial_context_ratio_vs_full_history)} | <= ${report.thresholds.max_initial_context_ratio_vs_full_history} |`,
    `| Prompt tokens | ${report.metrics.prompt_tokens} | informational |`,
    `| Legacy prompt ratio vs Full History | ${ratio(report.metrics.prompt_ratio_vs_full_history)} | <= ${report.thresholds.max_prompt_ratio_vs_full_history} |`,
    `| Context budget metric | ${report.metrics.context_budget_metric} | initial context preferred |`,
    "",
    "## Checks",
    "",
    "| Check | Pass |",
    "|---|---|",
    `| Enough runs | ${bool(report.checks.enough_runs)} |`,
    `| Enough difficulty levels | ${bool(report.checks.enough_difficulty_levels)} |`,
    `| No route write violations | ${bool(report.checks.no_route_write_violations)} |`,
    `| No route action violations | ${bool(report.checks.no_route_action_violations)} |`,
    `| No direction-attention violations | ${bool(report.checks.no_direction_attention_violations)} |`,
    `| No terminal inspect | ${bool(report.checks.no_terminal_inspect)} |`,
    `| No report conflict | ${bool(report.checks.no_report_conflict)} |`,
    `| Accepted-route rate | ${bool(report.checks.accepted_route_rate_pass)} |`,
    `| Action-completion rate | ${bool(report.checks.action_completion_rate_pass)} |`,
    `| Context budget | ${bool(report.checks.context_budget_pass)} |`,
    `| Active candidate policy mode declared | ${bool(report.checks.active_policy_mode_declared)} |`,
    "",
    "## Decision",
    "",
    "| Gate | Result |",
    "|---|---|",
    `| Eligible for default active review | ${bool(report.decision.eligible_for_default_active_review)} |`,
    `| Status | \`${report.decision.status}\` |`,
    "",
    "## Blocking Reasons",
    "",
    ...report.decision.blocking_reasons.map((reason) => `- \`${reason}\``),
    "",
  ].join("\n");
}
