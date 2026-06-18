import { createHash } from "node:crypto";
import {
  evaluateAdmissionDatasetRows,
  parseAdmissionDatasetJsonl,
  type AionisAdmissionDatasetEvaluationReport,
  type AionisAdmissionDatasetEvaluatorOptions,
} from "./admission-dataset-evaluator.js";
import {
  compareAdmissionPoliciesForRows,
  type AionisAdmissionPolicyComparisonReport,
} from "./admission-policy-comparison.js";

export type AionisAdmissionDatasetParsedRow = ReturnType<typeof parseAdmissionDatasetJsonl>[number];

export type AionisAdmissionDatasetHoldoutSplitBy = "task_signature" | "run_id";

export type AionisAdmissionDatasetHoldoutOptions = AionisAdmissionDatasetEvaluatorOptions & {
  split_by?: AionisAdmissionDatasetHoldoutSplitBy | null;
  holdout_ratio?: number | null;
  seed?: string | null;
};

export type AionisAdmissionDatasetHoldoutReport = {
  contract_version: "aionis_admission_dataset_holdout_report_v1";
  intended_use: "offline_admission_policy_holdout_validation";
  runtime_mutation: false;
  agent_prompt_included: false;
  split: {
    split_by: AionisAdmissionDatasetHoldoutSplitBy;
    seed: string;
    holdout_ratio: number;
    group_count: number;
    train_group_count: number;
    holdout_group_count: number;
    train_row_count: number;
    holdout_row_count: number;
    train_groups: string[];
    holdout_groups: string[];
  };
  train: {
    evaluation: AionisAdmissionDatasetEvaluationReport;
    policy_comparison: AionisAdmissionPolicyComparisonReport;
  };
  holdout: {
    evaluation: AionisAdmissionDatasetEvaluationReport;
    policy_comparison: AionisAdmissionPolicyComparisonReport;
  };
  checks: {
    disjoint_groups: boolean;
    train_has_rows: boolean;
    holdout_has_rows: boolean;
    holdout_has_minimum_rows_for_policy_claim: boolean;
    holdout_has_minimum_task_signatures_for_diversity_claim: boolean;
    recorded_policy_holdout_leader: boolean;
  };
  caveats: string[];
  summary: string;
};

const DEFAULT_HOLDOUT_RATIO = 0.3;
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

function stableHash(seed: string, key: string): number {
  const hex = createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16);
}

function groupKey(row: AionisAdmissionDatasetParsedRow, splitBy: AionisAdmissionDatasetHoldoutSplitBy, index: number): string {
  return stringValue(row[splitBy]) ?? `missing:${splitBy}:${stringValue(row.task_id) ?? stringValue(row.memory_id) ?? index}`;
}

export function splitAdmissionDatasetRows(args: {
  rows: AionisAdmissionDatasetParsedRow[];
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
  holdoutRatio: number;
  seed: string;
}): {
  trainRows: AionisAdmissionDatasetParsedRow[];
  holdoutRows: AionisAdmissionDatasetParsedRow[];
  trainGroups: string[];
  holdoutGroups: string[];
} {
  const groups = new Map<string, AionisAdmissionDatasetParsedRow[]>();
  args.rows.forEach((row, index) => {
    const key = groupKey(row, args.splitBy, index);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  });
  const orderedGroups = [...groups.keys()].sort((a, b) =>
    stableHash(args.seed, a) - stableHash(args.seed, b) || a.localeCompare(b)
  );
  if (orderedGroups.length === 0) {
    return { trainRows: [], holdoutRows: [], trainGroups: [], holdoutGroups: [] };
  }
  if (orderedGroups.length === 1) {
    const only = orderedGroups[0] ?? "(missing)";
    return {
      trainRows: [],
      holdoutRows: groups.get(only) ?? [],
      trainGroups: [],
      holdoutGroups: [only],
    };
  }
  const holdoutCount = Math.min(
    orderedGroups.length - 1,
    Math.max(1, Math.round(orderedGroups.length * args.holdoutRatio)),
  );
  const holdoutSet = new Set(orderedGroups.slice(0, holdoutCount));
  const trainGroups = orderedGroups.filter((key) => !holdoutSet.has(key));
  const holdoutGroups = orderedGroups.filter((key) => holdoutSet.has(key));
  const trainRows = trainGroups.flatMap((key) => groups.get(key) ?? []);
  const holdoutRows = holdoutGroups.flatMap((key) => groups.get(key) ?? []);
  return { trainRows, holdoutRows, trainGroups, holdoutGroups };
}

function disjoint(a: string[], b: string[]): boolean {
  const left = new Set(a);
  return b.every((entry) => !left.has(entry));
}

function leadingPolicy(report: AionisAdmissionPolicyComparisonReport): string | null {
  return report.leaderboard[0]?.policy_id ?? null;
}

function buildCaveats(args: {
  splitBy: AionisAdmissionDatasetHoldoutSplitBy;
  trainRows: AionisAdmissionDatasetParsedRow[];
  holdoutRows: AionisAdmissionDatasetParsedRow[];
  trainGroups: string[];
  holdoutGroups: string[];
  holdoutEvaluation: AionisAdmissionDatasetEvaluationReport;
  holdoutComparison: AionisAdmissionPolicyComparisonReport;
}): string[] {
  return [
    "This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.",
    "Do not tune or promote an admission policy on the same holdout split used for the final claim.",
    args.splitBy === "run_id"
      ? "run_id split is chunk-like for current rows, but true chunk_id is not yet part of the dataset row contract."
      : null,
    args.trainRows.length === 0 ? "Train split is empty because the dataset has only one split group." : null,
    args.holdoutRows.length === 0 ? "Holdout split is empty; no policy claim is allowed." : null,
    !disjoint(args.trainGroups, args.holdoutGroups) ? "Train and holdout groups overlap; split is invalid." : null,
    args.holdoutEvaluation.sample_quality.not_enough_rows_for_policy_claim
      ? `Holdout has fewer than ${args.holdoutEvaluation.sample_quality.minimum_rows_for_policy_claim} rows; treat as pipeline validation only.`
      : null,
    args.holdoutEvaluation.sample_quality.not_enough_task_signatures_for_diversity_claim
      ? `Holdout has fewer than ${args.holdoutEvaluation.sample_quality.minimum_task_signatures_for_diversity_claim} task signatures; do not claim cross-task generality.`
      : null,
    leadingPolicy(args.holdoutComparison) !== "aionis_recorded_policy"
      ? "Recorded Aionis policy is not the holdout leaderboard leader; inspect before any policy promotion."
      : null,
  ].filter((entry): entry is string => Boolean(entry));
}

export function evaluateAdmissionDatasetHoldoutRows(
  rows: AionisAdmissionDatasetParsedRow[],
  options: AionisAdmissionDatasetHoldoutOptions = {},
): AionisAdmissionDatasetHoldoutReport {
  const splitBy = normalizedSplitBy(options.split_by);
  const holdoutRatio = normalizedHoldoutRatio(options.holdout_ratio);
  const seed = normalizedSeed(options.seed);
  const { trainRows, holdoutRows, trainGroups, holdoutGroups } = splitAdmissionDatasetRows({
    rows,
    splitBy,
    holdoutRatio,
    seed,
  });
  const policyOptions: AionisAdmissionDatasetEvaluatorOptions = {
    policy_id: options.policy_id,
    policy_version: options.policy_version,
    policy_mode: options.policy_mode,
    runtime_version: options.runtime_version,
  };
  const trainEvaluation = evaluateAdmissionDatasetRows(trainRows, policyOptions);
  const holdoutEvaluation = evaluateAdmissionDatasetRows(holdoutRows, policyOptions);
  const trainComparison = compareAdmissionPoliciesForRows(trainRows, policyOptions);
  const holdoutComparison = compareAdmissionPoliciesForRows(holdoutRows, policyOptions);
  const caveats = buildCaveats({
    splitBy,
    trainRows,
    holdoutRows,
    trainGroups,
    holdoutGroups,
    holdoutEvaluation,
    holdoutComparison,
  });
  const report: AionisAdmissionDatasetHoldoutReport = {
    contract_version: "aionis_admission_dataset_holdout_report_v1",
    intended_use: "offline_admission_policy_holdout_validation",
    runtime_mutation: false,
    agent_prompt_included: false,
    split: {
      split_by: splitBy,
      seed,
      holdout_ratio: holdoutRatio,
      group_count: trainGroups.length + holdoutGroups.length,
      train_group_count: trainGroups.length,
      holdout_group_count: holdoutGroups.length,
      train_row_count: trainRows.length,
      holdout_row_count: holdoutRows.length,
      train_groups: trainGroups,
      holdout_groups: holdoutGroups,
    },
    train: {
      evaluation: trainEvaluation,
      policy_comparison: trainComparison,
    },
    holdout: {
      evaluation: holdoutEvaluation,
      policy_comparison: holdoutComparison,
    },
    checks: {
      disjoint_groups: disjoint(trainGroups, holdoutGroups),
      train_has_rows: trainRows.length > 0,
      holdout_has_rows: holdoutRows.length > 0,
      holdout_has_minimum_rows_for_policy_claim: holdoutEvaluation.sample_quality.has_minimum_rows_for_policy_claim,
      holdout_has_minimum_task_signatures_for_diversity_claim: holdoutEvaluation.sample_quality.has_minimum_task_signatures_for_diversity_claim,
      recorded_policy_holdout_leader: leadingPolicy(holdoutComparison) === "aionis_recorded_policy",
    },
    caveats,
    summary: `Split ${rows.length} admission dataset rows by ${splitBy}: train=${trainRows.length}, holdout=${holdoutRows.length}; holdout leader=${leadingPolicy(holdoutComparison) ?? "none"}.`,
  };
  return report;
}

export function evaluateAdmissionDatasetHoldoutJsonl(
  input: string,
  options: AionisAdmissionDatasetHoldoutOptions = {},
): AionisAdmissionDatasetHoldoutReport {
  return evaluateAdmissionDatasetHoldoutRows(parseAdmissionDatasetJsonl(input, options), options);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatAdmissionDatasetHoldoutMarkdown(report: AionisAdmissionDatasetHoldoutReport): string {
  return [
    "# Aionis Admission Dataset Holdout",
    "",
    report.summary,
    "",
    "| Split | Rows | Groups | Enough rows | Enough task signatures |",
    "|---|---:|---:|---|---|",
    `| Train | ${report.split.train_row_count} | ${report.split.train_group_count} | ${report.train.evaluation.sample_quality.has_minimum_rows_for_policy_claim ? "yes" : "no"} | ${report.train.evaluation.sample_quality.has_minimum_task_signatures_for_diversity_claim ? "yes" : "no"} |`,
    `| Holdout | ${report.split.holdout_row_count} | ${report.split.holdout_group_count} | ${report.holdout.evaluation.sample_quality.has_minimum_rows_for_policy_claim ? "yes" : "no"} | ${report.holdout.evaluation.sample_quality.has_minimum_task_signatures_for_diversity_claim ? "yes" : "no"} |`,
    "",
    "## Holdout Metrics",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| use_now positive rate | ${pct(report.holdout.evaluation.metrics.use_now_positive_rate)} |`,
    `| use_now negative rate | ${pct(report.holdout.evaluation.metrics.use_now_negative_rate)} |`,
    `| unused exposed rate | ${pct(report.holdout.evaluation.metrics.unused_exposed_rate)} |`,
    `| blocked / suppressed rows | ${report.holdout.evaluation.metrics.blocked_or_suppressed_count} |`,
    `| rehydrate requested rows | ${report.holdout.evaluation.metrics.rehydrate_requested_count} |`,
    `| recorded policy holdout leader | ${report.checks.recorded_policy_holdout_leader ? "yes" : "no"} |`,
    "",
    "## Holdout Policy Comparison",
    "",
    "| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |",
    "|---:|---|---:|---:|---:|---:|---:|---:|",
    ...report.holdout.policy_comparison.leaderboard.map((arm) => [
      `| ${arm.rank}`,
      arm.display_name,
      arm.utility_minus_risk_score.toFixed(4),
      pct(arm.positive_capture_rate),
      pct(arm.direct_use_risk_rate),
      pct(arm.direct_use_positive_precision_proxy),
      String(arm.direct_use_count),
      `${arm.missed_positive_use_count} |`,
    ].join(" | ")),
    "",
    "## Caveats",
    "",
    ...(report.caveats.length > 0 ? report.caveats.map((caveat) => `- ${caveat}`) : ["- none"]),
    "",
  ].join("\n");
}
