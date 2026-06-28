import { parseAdmissionDatasetJsonl } from "./admission-dataset-evaluator.js";
import type { AionisAdmissionDatasetParsedRow } from "./admission-dataset-holdout.js";
import type { AionisAdmissionCandidatePolicyEvaluationReport } from "./admission-candidate-policy-evaluator.js";

export type AionisAdmissionProductionGateThresholds = {
  min_rows: number;
  min_task_signatures: number;
  min_scopes: number;
  min_projection_present_count: number;
};

export type AionisAdmissionProductionGateInput = {
  rows: AionisAdmissionDatasetParsedRow[];
  thresholds?: Partial<AionisAdmissionProductionGateThresholds>;
  batch_collect?: unknown;
  candidate_policy?: unknown;
};

export type AionisAdmissionProductionGateReport = {
  contract_version: "aionis_admission_production_gate_report_v1";
  intended_use: "closed_loop_admission_policy_promotion_gate";
  runtime_mutation: false;
  agent_prompt_included: false;
  gate_scope: "default_guide_shadow_expansion";
  thresholds: AionisAdmissionProductionGateThresholds;
  dataset: {
    row_count: number;
    run_count: number;
    task_signature_count: number;
    scope_count: number;
  };
  online_projection: {
    report_present: boolean;
    mode: string | null;
    guide_count: number;
    projection_present_count: number;
    agent_prompt_included_count: number;
    runtime_mutation_count: number;
    hard_boundary_upgrade_count: number;
    shadow_projection_source_count: number;
    active_projection_source_count: number;
  };
  candidate_policy: {
    report_present: boolean;
    selected_policy_id: string | null;
    eligible_for_manual_review: boolean | null;
    holdout_calibration_score: number | null;
    recorded_holdout_calibration_score: number | null;
    no_hard_boundary_regression: boolean | null;
    no_negative_use_count_regression: boolean | null;
    no_positive_capture_regression: boolean | null;
    calibration_score_improved: boolean | null;
    changed_actions_on_holdout: boolean | null;
  };
  checks: {
    enough_rows: boolean;
    enough_task_signatures: boolean;
    enough_scopes: boolean;
    shadow_projection_report_present: boolean;
    enough_shadow_projection_coverage: boolean;
    shadow_projection_present: boolean;
    shadow_mode: boolean;
    no_prompt_inclusion: boolean;
    no_runtime_mutation: boolean;
    no_hard_boundary_upgrade: boolean;
    candidate_policy_selected: boolean;
    candidate_policy_manual_review_eligible: boolean;
    candidate_policy_no_hard_boundary_regression: boolean;
    candidate_policy_no_negative_regression: boolean;
    candidate_policy_no_positive_capture_regression: boolean;
    candidate_policy_calibration_improved: boolean;
    candidate_policy_changed_actions: boolean;
  };
  decision: {
    eligible_for_isolated_active_gray_review: boolean;
    eligible_for_default_active: false;
    status:
      | "passes_shadow_production_gate_ready_for_isolated_active_gray_review"
      | "blocked_for_isolated_active_gray_review"
      | "blocked_for_default_active_requires_tool_e2e_gate";
    blocking_reasons: string[];
  };
  summary: string;
};

const DEFAULT_THRESHOLDS: AionisAdmissionProductionGateThresholds = {
  min_rows: 1000,
  min_task_signatures: 30,
  min_scopes: 5,
  min_projection_present_count: 1000,
};

function mergeThresholds(
  thresholds: Partial<AionisAdmissionProductionGateThresholds> | undefined,
): AionisAdmissionProductionGateThresholds {
  return {
    min_rows: positiveInteger(thresholds?.min_rows, DEFAULT_THRESHOLDS.min_rows),
    min_task_signatures: positiveInteger(thresholds?.min_task_signatures, DEFAULT_THRESHOLDS.min_task_signatures),
    min_scopes: positiveInteger(thresholds?.min_scopes, DEFAULT_THRESHOLDS.min_scopes),
    min_projection_present_count: positiveInteger(
      thresholds?.min_projection_present_count,
      DEFAULT_THRESHOLDS.min_projection_present_count,
    ),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nestedRecord(record: Record<string, unknown> | null, field: string): Record<string, unknown> | null {
  return recordValue(record?.[field]);
}

function uniqueStringCount(rows: AionisAdmissionDatasetParsedRow[], field: keyof AionisAdmissionDatasetParsedRow): number {
  return new Set(rows.map((row) => stringValue(row[field])).filter((value): value is string => !!value)).size;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function onlineProjectionFromBatch(batchCollect: unknown): Omit<AionisAdmissionProductionGateReport["online_projection"], "report_present"> | null {
  const batch = recordValue(batchCollect);
  const projection = nestedRecord(batch, "admission_candidate_policy_online_projection");
  if (!projection) return null;
  return {
    mode: stringValue(projection?.mode),
    guide_count: numberValue(projection?.guide_count),
    projection_present_count: numberValue(projection?.projection_present_count),
    agent_prompt_included_count: numberValue(projection?.agent_prompt_included_count),
    runtime_mutation_count: numberValue(projection?.runtime_mutation_count),
    hard_boundary_upgrade_count: numberValue(projection?.hard_boundary_upgrade_count),
    shadow_projection_source_count: numberValue(projection?.shadow_projection_source_count),
    active_projection_source_count: numberValue(projection?.active_projection_source_count),
  };
}

function onlineProjectionSummary(batchCollect: unknown): AionisAdmissionProductionGateReport["online_projection"] {
  const projections = asArray(batchCollect).map(onlineProjectionFromBatch).filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const modes = new Set(projections.map((entry) => entry.mode ?? "(missing)"));
  return {
    report_present: projections.length > 0,
    mode: projections.length === 0 ? null : modes.size === 1 ? projections[0]?.mode ?? null : "mixed",
    guide_count: projections.reduce((sum, entry) => sum + entry.guide_count, 0),
    projection_present_count: projections.reduce((sum, entry) => sum + entry.projection_present_count, 0),
    agent_prompt_included_count: projections.reduce((sum, entry) => sum + entry.agent_prompt_included_count, 0),
    runtime_mutation_count: projections.reduce((sum, entry) => sum + entry.runtime_mutation_count, 0),
    hard_boundary_upgrade_count: projections.reduce((sum, entry) => sum + entry.hard_boundary_upgrade_count, 0),
    shadow_projection_source_count: projections.reduce((sum, entry) => sum + entry.shadow_projection_source_count, 0),
    active_projection_source_count: projections.reduce((sum, entry) => sum + entry.active_projection_source_count, 0),
  };
}

function candidatePolicySummary(candidatePolicy: unknown): AionisAdmissionProductionGateReport["candidate_policy"] {
  const report = recordValue(candidatePolicy) as Partial<AionisAdmissionCandidatePolicyEvaluationReport> | null;
  const promotionGate = recordValue(report?.promotion_gate);
  const selectedPolicy = recordValue(report?.selected_policy);
  const selectedHoldout = nestedRecord(selectedPolicy, "holdout");
  const recordedPolicy = recordValue(report?.recorded_policy);
  const recordedHoldout = nestedRecord(recordedPolicy, "holdout");
  return {
    report_present: !!report,
    selected_policy_id: stringValue(report?.selected_policy_id),
    eligible_for_manual_review: booleanValue(promotionGate?.eligible_for_manual_review),
    holdout_calibration_score: report ? numberValue(selectedHoldout?.calibration_score) : null,
    recorded_holdout_calibration_score: report ? numberValue(recordedHoldout?.calibration_score) : null,
    no_hard_boundary_regression: booleanValue(promotionGate?.no_hard_boundary_regression),
    no_negative_use_count_regression: booleanValue(promotionGate?.no_negative_use_count_regression),
    no_positive_capture_regression: booleanValue(promotionGate?.no_positive_capture_regression),
    calibration_score_improved: booleanValue(promotionGate?.calibration_score_improved),
    changed_actions_on_holdout: booleanValue(promotionGate?.changed_actions_on_holdout),
  };
}

function blockingReasons(checks: AionisAdmissionProductionGateReport["checks"]): string[] {
  const reasons: string[] = [];
  if (!checks.enough_rows) reasons.push("collect_more_rows");
  if (!checks.enough_task_signatures) reasons.push("collect_more_task_signatures");
  if (!checks.enough_scopes) reasons.push("collect_more_scopes");
  if (!checks.shadow_projection_report_present) reasons.push("missing_shadow_projection_report");
  if (checks.shadow_projection_report_present && !checks.enough_shadow_projection_coverage) {
    reasons.push("collect_more_shadow_projection_coverage");
  }
  if (!checks.shadow_mode) reasons.push("online_projection_not_shadow_mode");
  if (!checks.no_prompt_inclusion) reasons.push("shadow_projection_entered_agent_prompt");
  if (!checks.no_runtime_mutation) reasons.push("shadow_projection_mutated_runtime");
  if (!checks.no_hard_boundary_upgrade) reasons.push("shadow_projection_upgraded_hard_boundary");
  if (!checks.candidate_policy_selected) reasons.push("missing_candidate_policy_selection");
  if (!checks.candidate_policy_manual_review_eligible) reasons.push("candidate_policy_not_manual_review_eligible");
  if (!checks.candidate_policy_no_hard_boundary_regression) reasons.push("candidate_policy_hard_boundary_regression");
  if (!checks.candidate_policy_no_negative_regression) reasons.push("candidate_policy_negative_regression");
  if (!checks.candidate_policy_no_positive_capture_regression) reasons.push("candidate_policy_positive_capture_regression");
  if (!checks.candidate_policy_calibration_improved) reasons.push("candidate_policy_calibration_not_improved");
  if (!checks.candidate_policy_changed_actions) reasons.push("candidate_policy_changed_no_actions");
  return reasons;
}

export function evaluateAdmissionProductionGate(
  input: AionisAdmissionProductionGateInput,
): AionisAdmissionProductionGateReport {
  const thresholds = mergeThresholds(input.thresholds);
  const rows = input.rows;
  const dataset = {
    row_count: rows.length,
    run_count: uniqueStringCount(rows, "run_id"),
    task_signature_count: uniqueStringCount(rows, "task_signature"),
    scope_count: uniqueStringCount(rows, "scope"),
  };
  const onlineProjection = onlineProjectionSummary(input.batch_collect);
  const candidatePolicy = candidatePolicySummary(input.candidate_policy);
  const checks = {
    enough_rows: dataset.row_count >= thresholds.min_rows,
    enough_task_signatures: dataset.task_signature_count >= thresholds.min_task_signatures,
    enough_scopes: dataset.scope_count >= thresholds.min_scopes,
    shadow_projection_report_present: onlineProjection.report_present,
    enough_shadow_projection_coverage: onlineProjection.projection_present_count >= thresholds.min_projection_present_count,
    shadow_projection_present: onlineProjection.report_present
      && onlineProjection.projection_present_count >= thresholds.min_projection_present_count,
    shadow_mode: onlineProjection.mode === "shadow",
    no_prompt_inclusion: onlineProjection.agent_prompt_included_count === 0,
    no_runtime_mutation: onlineProjection.runtime_mutation_count === 0,
    no_hard_boundary_upgrade: onlineProjection.hard_boundary_upgrade_count === 0,
    candidate_policy_selected: candidatePolicy.selected_policy_id === "candidate_project_context_closed_loop_inspect",
    candidate_policy_manual_review_eligible: candidatePolicy.eligible_for_manual_review === true,
    candidate_policy_no_hard_boundary_regression: candidatePolicy.no_hard_boundary_regression === true,
    candidate_policy_no_negative_regression: candidatePolicy.no_negative_use_count_regression === true,
    candidate_policy_no_positive_capture_regression: candidatePolicy.no_positive_capture_regression === true,
    candidate_policy_calibration_improved: candidatePolicy.calibration_score_improved === true,
    candidate_policy_changed_actions: candidatePolicy.changed_actions_on_holdout === true,
  };
  const reasons = blockingReasons(checks);
  const eligibleForActiveGray = reasons.length === 0;
  const status = eligibleForActiveGray
    ? "passes_shadow_production_gate_ready_for_isolated_active_gray_review"
    : "blocked_for_isolated_active_gray_review";
  return {
    contract_version: "aionis_admission_production_gate_report_v1",
    intended_use: "closed_loop_admission_policy_promotion_gate",
    runtime_mutation: false,
    agent_prompt_included: false,
    gate_scope: "default_guide_shadow_expansion",
    thresholds,
    dataset,
    online_projection: onlineProjection,
    candidate_policy: candidatePolicy,
    checks,
    decision: {
      eligible_for_isolated_active_gray_review: eligibleForActiveGray,
      eligible_for_default_active: false,
      status,
      blocking_reasons: eligibleForActiveGray
        ? ["default_active_still_requires_cross_repository_tool_e2e_gate"]
        : reasons,
    },
    summary: eligibleForActiveGray
      ? `Admission candidate passed the default-guide shadow production gate over ${dataset.row_count} rows and ${dataset.task_signature_count} task signatures; default active remains blocked by the separate tool-executing E2E gate.`
      : `Admission candidate is blocked for isolated active gray review by ${reasons.length} gate reason(s): ${reasons.join(", ")}.`,
  };
}

export function evaluateAdmissionProductionGateJsonl(
  jsonl: string,
  input: Omit<AionisAdmissionProductionGateInput, "rows"> = {},
): AionisAdmissionProductionGateReport {
  return evaluateAdmissionProductionGate({
    ...input,
    rows: parseAdmissionDatasetJsonl(jsonl),
  });
}

function bool(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatAdmissionProductionGateMarkdown(report: AionisAdmissionProductionGateReport): string {
  return [
    "# Aionis Admission Production Gate",
    "",
    report.summary,
    "",
    "## Dataset",
    "",
    "| Metric | Value | Required |",
    "|---|---:|---:|",
    `| Rows | ${report.dataset.row_count} | ${report.thresholds.min_rows} |`,
    `| Task signatures | ${report.dataset.task_signature_count} | ${report.thresholds.min_task_signatures} |`,
    `| Scopes | ${report.dataset.scope_count} | ${report.thresholds.min_scopes} |`,
    `| Runs | ${report.dataset.run_count} | - |`,
    "",
    "## Online Shadow Projection",
    "",
    "| Check | Value |",
    "|---|---:|",
    `| Report present | ${report.online_projection.report_present ? "yes" : "no"} |`,
    `| Mode | ${report.online_projection.mode ?? "(missing)"} |`,
    `| Guide count | ${report.online_projection.guide_count} |`,
    `| Projection present | ${report.online_projection.projection_present_count} |`,
    `| Shadow source count | ${report.online_projection.shadow_projection_source_count} |`,
    `| Agent prompt included | ${report.online_projection.agent_prompt_included_count} |`,
    `| Runtime mutation | ${report.online_projection.runtime_mutation_count} |`,
    `| Hard-boundary upgrades | ${report.online_projection.hard_boundary_upgrade_count} |`,
    "",
    "## Candidate Policy",
    "",
    "| Check | Value |",
    "|---|---|",
    `| Selected policy | \`${report.candidate_policy.selected_policy_id ?? "(missing)"}\` |`,
    `| Manual-review eligible | ${bool(report.candidate_policy.eligible_for_manual_review === true)} |`,
    `| Holdout calibration | ${report.candidate_policy.holdout_calibration_score ?? "(missing)"} |`,
    `| Recorded holdout calibration | ${report.candidate_policy.recorded_holdout_calibration_score ?? "(missing)"} |`,
    `| No hard-boundary regression | ${bool(report.candidate_policy.no_hard_boundary_regression === true)} |`,
    `| No negative regression | ${bool(report.candidate_policy.no_negative_use_count_regression === true)} |`,
    `| No positive-capture regression | ${bool(report.candidate_policy.no_positive_capture_regression === true)} |`,
    `| Calibration improved | ${bool(report.candidate_policy.calibration_score_improved === true)} |`,
    `| Changed actions on holdout | ${bool(report.candidate_policy.changed_actions_on_holdout === true)} |`,
    "",
    "## Decision",
    "",
    "| Gate | Result |",
    "|---|---|",
    `| Eligible for isolated active gray review | ${bool(report.decision.eligible_for_isolated_active_gray_review)} |`,
    `| Eligible for default active | ${bool(report.decision.eligible_for_default_active)} |`,
    `| Status | \`${report.decision.status}\` |`,
    "",
    "## Blocking Reasons",
    "",
    ...report.decision.blocking_reasons.map((reason) => `- \`${reason}\``),
    "",
  ].join("\n");
}
