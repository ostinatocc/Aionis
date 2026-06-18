import {
  decideAdmissionCandidatePolicyActionForEvaluation,
  evaluateAdmissionCandidatePoliciesRows,
  type AionisAdmissionCandidatePolicyEvaluationOptions,
  type AionisAdmissionCandidatePolicyId,
} from "./admission-candidate-policy-evaluator.js";
import { parseAdmissionDatasetJsonl } from "./admission-dataset-evaluator.js";
import {
  splitAdmissionDatasetRows,
  type AionisAdmissionDatasetHoldoutSplitBy,
  type AionisAdmissionDatasetParsedRow,
} from "./admission-dataset-holdout.js";
import type { AionisMemoryAdmissionRecordEntry } from "../sdk.js";

type AdmissionAction = AionisMemoryAdmissionRecordEntry["admission_action"];

export type AionisAdmissionCounterfactualRerunArmId =
  | "recorded_policy_baseline"
  | AionisAdmissionCandidatePolicyId;

export type AionisAdmissionCounterfactualRerunGroupOutcome =
  | "accepted_action"
  | "hard_boundary_direct_use"
  | "negative_direct_risk"
  | "missed_actionable_memory"
  | "non_actionable_direct_attention"
  | "no_actionable_memory";

export type AionisAdmissionCounterfactualRerunGroup = {
  group_id: string;
  row_count: number;
  direct_use_count: number;
  positive_row_count: number;
  positive_direct_count: number;
  negative_direct_count: number;
  hard_boundary_direct_count: number;
  unused_direct_count: number;
  changed_action_count: number;
  outcome: AionisAdmissionCounterfactualRerunGroupOutcome;
  changed_memory_ids: string[];
};

export type AionisAdmissionCounterfactualRerunArm = {
  arm_id: AionisAdmissionCounterfactualRerunArmId;
  display_name: string;
  row_count: number;
  group_count: number;
  direct_use_count: number;
  changed_action_count: number;
  accepted_action_count: number;
  hard_boundary_direct_use_count: number;
  negative_direct_risk_count: number;
  missed_actionable_memory_count: number;
  non_actionable_direct_attention_count: number;
  positive_group_count: number;
  accepted_action_rate: number;
  hard_boundary_direct_use_rate: number;
  negative_direct_risk_rate: number;
  missed_actionable_memory_rate: number;
  non_actionable_direct_attention_rate: number;
  positive_group_capture_rate: number;
  groups: AionisAdmissionCounterfactualRerunGroup[];
};

export type AionisAdmissionCounterfactualRerunReport = {
  contract_version: "aionis_admission_counterfactual_rerun_report_v1";
  intended_use: "offline_counterfactual_agent_action_validation";
  runtime_mutation: false;
  agent_prompt_included: false;
  agent_mode: "deterministic_action_proxy";
  policy: {
    candidate_policy_id: AionisAdmissionCandidatePolicyId;
    selected_by_candidate_evaluator: boolean;
  };
  split: {
    split_by: AionisAdmissionDatasetHoldoutSplitBy;
    seed: string;
    holdout_ratio: number;
    evaluation_split: "holdout" | "train" | "all";
    train_row_count: number;
    holdout_row_count: number;
    train_group_count: number;
    holdout_group_count: number;
  };
  dataset: {
    row_count: number;
    evaluated_row_count: number;
    evaluated_group_count: number;
  };
  arms: AionisAdmissionCounterfactualRerunArm[];
  recorded_arm: AionisAdmissionCounterfactualRerunArm;
  candidate_arm: AionisAdmissionCounterfactualRerunArm;
  checks: {
    no_runtime_mutation: true;
    deterministic_proxy_only: true;
    candidate_no_hard_boundary_direct_use_regression: boolean;
    candidate_no_negative_direct_risk_regression: boolean;
    candidate_no_missed_actionable_memory_regression: boolean;
    candidate_accepted_action_rate_not_worse: boolean;
    candidate_reduces_non_actionable_direct_attention: boolean;
    candidate_changes_actions: boolean;
    eligible_for_real_agent_rerun: boolean;
  };
  caveats: string[];
  summary: string;
};

export type AionisAdmissionCounterfactualRerunOptions = AionisAdmissionCandidatePolicyEvaluationOptions & {
  candidate_policy_id?: AionisAdmissionCandidatePolicyId | null;
  evaluation_split?: "holdout" | "train" | "all" | null;
};

const DEFAULT_HOLDOUT_RATIO = 0.5;
const DEFAULT_HOLDOUT_SEED = "aionis-admission-holdout-v1";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedSplitBy(value: AionisAdmissionDatasetHoldoutSplitBy | null | undefined): AionisAdmissionDatasetHoldoutSplitBy {
  return value === "run_id" ? "run_id" : "task_signature";
}

function normalizedHoldoutRatio(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HOLDOUT_RATIO;
  return Math.min(0.8, Math.max(0.05, value));
}

function normalizedSeed(value: string | null | undefined): string {
  return stringValue(value) ?? DEFAULT_HOLDOUT_SEED;
}

function normalizedEvaluationSplit(value: AionisAdmissionCounterfactualRerunOptions["evaluation_split"]): "holdout" | "train" | "all" {
  if (value === "train" || value === "all") return value;
  return "holdout";
}

function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function groupKey(row: AionisAdmissionDatasetParsedRow, splitBy: AionisAdmissionDatasetHoldoutSplitBy, index: number): string {
  return stringValue(row[splitBy]) ?? `missing:${splitBy}:${stringValue(row.task_id) ?? stringValue(row.memory_id) ?? index}`;
}

function memoryId(row: AionisAdmissionDatasetParsedRow, index: number): string {
  return stringValue(row.memory_id) ?? `row:${index}`;
}

function actionForArm(
  row: AionisAdmissionDatasetParsedRow,
  armId: AionisAdmissionCounterfactualRerunArmId,
): AdmissionAction {
  return armId === "recorded_policy_baseline"
    ? row.admission_action
    : decideAdmissionCandidatePolicyActionForEvaluation(row, armId);
}

function groupRows(rows: AionisAdmissionDatasetParsedRow[], splitBy: AionisAdmissionDatasetHoldoutSplitBy): Map<string, AionisAdmissionDatasetParsedRow[]> {
  const groups = new Map<string, AionisAdmissionDatasetParsedRow[]>();
  rows.forEach((row, index) => {
    const key = groupKey(row, splitBy, index);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  });
  return groups;
}

function scoreGroup(args: {
  armId: AionisAdmissionCounterfactualRerunArmId;
  groupId: string;
  rows: AionisAdmissionDatasetParsedRow[];
}): AionisAdmissionCounterfactualRerunGroup {
  let directUseCount = 0;
  let positiveRowCount = 0;
  let positiveDirectCount = 0;
  let negativeDirectCount = 0;
  let hardBoundaryDirectCount = 0;
  let unusedDirectCount = 0;
  let changedActionCount = 0;
  const changedMemoryIds: string[] = [];

  args.rows.forEach((row, index) => {
    const predicted = actionForArm(row, args.armId);
    if (row.outcome_label === "positive_use") positiveRowCount += 1;
    if (predicted !== row.admission_action) {
      changedActionCount += 1;
      changedMemoryIds.push(memoryId(row, index));
    }
    if (predicted !== "use_now") return;
    directUseCount += 1;
    if (row.outcome_label === "positive_use") positiveDirectCount += 1;
    if (row.outcome_label === "negative_use") negativeDirectCount += 1;
    if (row.outcome_label === "blocked_or_suppressed" || row.outcome_label === "rehydrate_requested") {
      hardBoundaryDirectCount += 1;
    }
    if (row.outcome_label === "unused_exposed") unusedDirectCount += 1;
  });

  const outcome: AionisAdmissionCounterfactualRerunGroupOutcome =
    hardBoundaryDirectCount > 0
      ? "hard_boundary_direct_use"
      : positiveDirectCount > 0
        ? "accepted_action"
        : negativeDirectCount > 0
          ? "negative_direct_risk"
        : positiveRowCount > 0
          ? "missed_actionable_memory"
          : unusedDirectCount > 0
            ? "non_actionable_direct_attention"
            : "no_actionable_memory";

  return {
    group_id: args.groupId,
    row_count: args.rows.length,
    direct_use_count: directUseCount,
    positive_row_count: positiveRowCount,
    positive_direct_count: positiveDirectCount,
    negative_direct_count: negativeDirectCount,
    hard_boundary_direct_count: hardBoundaryDirectCount,
    unused_direct_count: unusedDirectCount,
    changed_action_count: changedActionCount,
    outcome,
    changed_memory_ids: changedMemoryIds.slice(0, 25),
  };
}

function scoreArm(args: {
  armId: AionisAdmissionCounterfactualRerunArmId;
  displayName: string;
  rows: AionisAdmissionDatasetParsedRow[];
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
}): AionisAdmissionCounterfactualRerunArm {
  const groups = [...groupRows(args.rows, args.splitBy)].sort(([a], [b]) => a.localeCompare(b));
  const scoredGroups = groups.map(([groupId, rows]) => scoreGroup({ armId: args.armId, groupId, rows }));
  const positiveGroupCount = scoredGroups.filter((group) => group.positive_row_count > 0).length;
  const acceptedActionCount = scoredGroups.filter((group) => group.outcome === "accepted_action").length;
  const hardBoundaryDirectUseCount = scoredGroups.filter((group) => group.outcome === "hard_boundary_direct_use").length;
  const negativeDirectRiskCount = scoredGroups.filter((group) => group.negative_direct_count > 0).length;
  const missedActionableMemoryCount = scoredGroups.filter((group) => group.outcome === "missed_actionable_memory").length;
  const nonActionableDirectAttentionCount = scoredGroups.filter((group) => group.outcome === "non_actionable_direct_attention").length;
  const directUseCount = scoredGroups.reduce((sum, group) => sum + group.direct_use_count, 0);
  const changedActionCount = scoredGroups.reduce((sum, group) => sum + group.changed_action_count, 0);

  return {
    arm_id: args.armId,
    display_name: args.displayName,
    row_count: args.rows.length,
    group_count: scoredGroups.length,
    direct_use_count: directUseCount,
    changed_action_count: changedActionCount,
    accepted_action_count: acceptedActionCount,
    hard_boundary_direct_use_count: hardBoundaryDirectUseCount,
    negative_direct_risk_count: negativeDirectRiskCount,
    missed_actionable_memory_count: missedActionableMemoryCount,
    non_actionable_direct_attention_count: nonActionableDirectAttentionCount,
    positive_group_count: positiveGroupCount,
    accepted_action_rate: rate(acceptedActionCount, scoredGroups.length),
    hard_boundary_direct_use_rate: rate(hardBoundaryDirectUseCount, scoredGroups.length),
    negative_direct_risk_rate: rate(negativeDirectRiskCount, scoredGroups.length),
    missed_actionable_memory_rate: rate(missedActionableMemoryCount, positiveGroupCount),
    non_actionable_direct_attention_rate: rate(nonActionableDirectAttentionCount, scoredGroups.length),
    positive_group_capture_rate: rate(acceptedActionCount, positiveGroupCount),
    groups: scoredGroups,
  };
}

function caveats(args: {
  evaluationSplit: "holdout" | "train" | "all";
  evaluatedRows: AionisAdmissionDatasetParsedRow[];
  recorded: AionisAdmissionCounterfactualRerunArm;
  candidate: AionisAdmissionCounterfactualRerunArm;
}): string[] {
  return [
    "This is an offline deterministic action proxy over exported admission rows, not a real LLM Agent rerun.",
    "The candidate policy is evaluated only as a counterfactual adapter; Runtime admission gates are not mutated.",
    "The proxy treats use_now memories as action-driving context and inspect_before_use memories as non-direct guidance.",
    "Outcome labels are admission-dataset supervision, not per-memory counterfactual ground truth.",
    args.evaluationSplit !== "holdout" ? "Evaluation split is not holdout; do not use this report as a promotion gate." : null,
    args.evaluatedRows.length < 100 ? "Evaluated split has fewer than 100 rows; treat as pipeline validation only." : null,
    args.candidate.hard_boundary_direct_use_count > args.recorded.hard_boundary_direct_use_count
      ? "Candidate has more hard-boundary direct-use groups than recorded policy."
      : null,
    args.candidate.negative_direct_risk_count > args.recorded.negative_direct_risk_count
      ? "Candidate has more negative-attribution direct-risk groups than recorded policy."
      : null,
    args.candidate.missed_actionable_memory_count > args.recorded.missed_actionable_memory_count
      ? "Candidate misses more actionable positive groups than recorded policy."
      : null,
  ].filter((entry): entry is string => Boolean(entry));
}

export function rerunAdmissionCounterfactualRows(
  rows: AionisAdmissionDatasetParsedRow[],
  options: AionisAdmissionCounterfactualRerunOptions = {},
): AionisAdmissionCounterfactualRerunReport {
  const splitBy = normalizedSplitBy(options.split_by);
  const holdoutRatio = normalizedHoldoutRatio(options.holdout_ratio);
  const seed = normalizedSeed(options.seed);
  const evaluationSplit = normalizedEvaluationSplit(options.evaluation_split);
  const split = splitAdmissionDatasetRows({ rows, splitBy, holdoutRatio, seed });
  const candidateEvaluation = evaluateAdmissionCandidatePoliciesRows(rows, {
    split_by: splitBy,
    holdout_ratio: holdoutRatio,
    seed,
    policy_id: options.policy_id,
    policy_mode: options.policy_mode,
    policy_version: options.policy_version,
    runtime_version: options.runtime_version,
  });
  const candidatePolicyId = options.candidate_policy_id ?? candidateEvaluation.selected_policy_id;
  const evaluatedRows = evaluationSplit === "train"
    ? split.trainRows
    : evaluationSplit === "all"
      ? rows
      : split.holdoutRows;
  const recordedArm = scoreArm({
    armId: "recorded_policy_baseline",
    displayName: "Recorded Runtime policy",
    rows: evaluatedRows,
    splitBy,
  });
  const candidateArm = scoreArm({
    armId: candidatePolicyId,
    displayName: `Candidate policy: ${candidatePolicyId}`,
    rows: evaluatedRows,
    splitBy,
  });
  const reducesNonActionableDirectAttention =
    candidateArm.non_actionable_direct_attention_count < recordedArm.non_actionable_direct_attention_count;
  const noHardBoundaryRegression = candidateArm.hard_boundary_direct_use_count <= recordedArm.hard_boundary_direct_use_count;
  const noNegativeRiskRegression = candidateArm.negative_direct_risk_count <= recordedArm.negative_direct_risk_count;
  const noMissedActionableRegression = candidateArm.missed_actionable_memory_count <= recordedArm.missed_actionable_memory_count;
  const acceptedRateNotWorse = candidateArm.accepted_action_rate >= recordedArm.accepted_action_rate;
  const candidateChangesActions = candidateArm.changed_action_count > 0;
  const eligible = evaluationSplit === "holdout"
    && candidateEvaluation.promotion_gate.eligible_for_manual_review
    && noHardBoundaryRegression
    && noNegativeRiskRegression
    && noMissedActionableRegression
    && acceptedRateNotWorse
    && reducesNonActionableDirectAttention
    && candidateChangesActions;

  return {
    contract_version: "aionis_admission_counterfactual_rerun_report_v1",
    intended_use: "offline_counterfactual_agent_action_validation",
    runtime_mutation: false,
    agent_prompt_included: false,
    agent_mode: "deterministic_action_proxy",
    policy: {
      candidate_policy_id: candidatePolicyId,
      selected_by_candidate_evaluator: options.candidate_policy_id == null,
    },
    split: {
      split_by: splitBy,
      seed,
      holdout_ratio: holdoutRatio,
      evaluation_split: evaluationSplit,
      train_row_count: split.trainRows.length,
      holdout_row_count: split.holdoutRows.length,
      train_group_count: split.trainGroups.length,
      holdout_group_count: split.holdoutGroups.length,
    },
    dataset: {
      row_count: rows.length,
      evaluated_row_count: evaluatedRows.length,
      evaluated_group_count: recordedArm.group_count,
    },
    arms: [recordedArm, candidateArm],
    recorded_arm: recordedArm,
    candidate_arm: candidateArm,
    checks: {
      no_runtime_mutation: true,
      deterministic_proxy_only: true,
      candidate_no_hard_boundary_direct_use_regression: noHardBoundaryRegression,
      candidate_no_negative_direct_risk_regression: noNegativeRiskRegression,
      candidate_no_missed_actionable_memory_regression: noMissedActionableRegression,
      candidate_accepted_action_rate_not_worse: acceptedRateNotWorse,
      candidate_reduces_non_actionable_direct_attention: reducesNonActionableDirectAttention,
      candidate_changes_actions: candidateChangesActions,
      eligible_for_real_agent_rerun: eligible,
    },
    caveats: caveats({
      evaluationSplit,
      evaluatedRows,
      recorded: recordedArm,
      candidate: candidateArm,
    }),
    summary: `Counterfactual ${candidatePolicyId} on ${evaluationSplit}: accepted_action_rate=${candidateArm.accepted_action_rate}, hard_boundary_direct_use_rate=${candidateArm.hard_boundary_direct_use_rate}, negative_direct_risk_rate=${candidateArm.negative_direct_risk_rate}, non_actionable_direct_attention=${candidateArm.non_actionable_direct_attention_count} vs recorded ${recordedArm.non_actionable_direct_attention_count}, eligible_for_real_agent_rerun=${eligible}.`,
  };
}

export function rerunAdmissionCounterfactualJsonl(
  input: string,
  options: AionisAdmissionCounterfactualRerunOptions = {},
): AionisAdmissionCounterfactualRerunReport {
  return rerunAdmissionCounterfactualRows(parseAdmissionDatasetJsonl(input, options), options);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function armRow(arm: AionisAdmissionCounterfactualRerunArm): string {
  return [
    `| ${arm.display_name}`,
    pct(arm.accepted_action_rate),
    pct(arm.hard_boundary_direct_use_rate),
    pct(arm.negative_direct_risk_rate),
    String(arm.non_actionable_direct_attention_count),
    pct(arm.positive_group_capture_rate),
    String(arm.direct_use_count),
    String(arm.changed_action_count),
    `${arm.missed_actionable_memory_count} |`,
  ].join(" | ");
}

export function formatAdmissionCounterfactualRerunMarkdown(report: AionisAdmissionCounterfactualRerunReport): string {
  return [
    "# Aionis Admission Counterfactual Rerun",
    "",
    report.summary,
    "",
    "## Scope",
    "",
    `- Agent mode: \`${report.agent_mode}\``,
    `- Evaluation split: \`${report.split.evaluation_split}\``,
    `- Rows: ${report.dataset.evaluated_row_count} / ${report.dataset.row_count}`,
    `- Groups: ${report.dataset.evaluated_group_count}`,
    `- Candidate: \`${report.policy.candidate_policy_id}\``,
    "",
    "## Arms",
    "",
    "| Arm | Accepted action | Hard-boundary direct-use | Negative direct risk | Non-actionable direct attention | Positive capture | Direct-use rows | Changed actions | Missed actionable |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.arms.map(armRow),
    "",
    "## Gate",
    "",
    "| Check | Result |",
    "|---|---|",
    `| no Runtime mutation | ${report.checks.no_runtime_mutation ? "yes" : "no"} |`,
    `| deterministic proxy only | ${report.checks.deterministic_proxy_only ? "yes" : "no"} |`,
    `| no hard-boundary direct-use regression | ${report.checks.candidate_no_hard_boundary_direct_use_regression ? "yes" : "no"} |`,
    `| no negative direct-risk regression | ${report.checks.candidate_no_negative_direct_risk_regression ? "yes" : "no"} |`,
    `| no missed actionable regression | ${report.checks.candidate_no_missed_actionable_memory_regression ? "yes" : "no"} |`,
    `| accepted action rate not worse | ${report.checks.candidate_accepted_action_rate_not_worse ? "yes" : "no"} |`,
    `| reduces non-actionable direct attention | ${report.checks.candidate_reduces_non_actionable_direct_attention ? "yes" : "no"} |`,
    `| candidate changes actions | ${report.checks.candidate_changes_actions ? "yes" : "no"} |`,
    `| eligible for real Agent rerun | ${report.checks.eligible_for_real_agent_rerun ? "yes" : "no"} |`,
    "",
    "## Caveats",
    "",
    ...report.caveats.map((entry) => `- ${entry}`),
    "",
  ].join("\n");
}
