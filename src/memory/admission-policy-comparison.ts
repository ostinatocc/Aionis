import {
  AIONIS_ADMISSION_POLICY_ID,
  AIONIS_ADMISSION_POLICY_MODE,
  AIONIS_ADMISSION_POLICY_VERSION,
  type AionisMemoryAdmissionRecordEntry,
} from "../sdk.js";
import {
  AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM,
  AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM,
  parseAdmissionDatasetJsonl,
  type AionisAdmissionDatasetEvaluatorOptions,
} from "./admission-dataset-evaluator.js";

type AdmissionDatasetRow = ReturnType<typeof parseAdmissionDatasetJsonl>[number];

export type AionisAdmissionPolicyComparisonPolicyId =
  | "aionis_recorded_policy"
  | "raw_retrieval_prompt_proxy"
  | "always_use"
  | "always_block";

export type AionisAdmissionPolicyComparisonAction = AionisMemoryAdmissionRecordEntry["admission_action"];

export type AionisAdmissionPolicyComparisonArm = {
  policy_id: AionisAdmissionPolicyComparisonPolicyId;
  display_name: string;
  description: string;
  row_count: number;
  predicted_action_counts: Record<string, number>;
  direct_use_count: number;
  positive_use_direct_count: number;
  negative_use_direct_count: number;
  blocked_or_suppressed_direct_count: number;
  rehydrate_direct_count: number;
  unused_exposed_direct_count: number;
  missed_positive_use_count: number;
  positive_capture_rate: number;
  direct_use_positive_precision_proxy: number;
  direct_use_risk_rate: number;
  blocked_or_suppressed_direct_rate: number;
  rehydrate_bypass_rate: number;
  utility_minus_risk_score: number;
  rank: number;
};

export type AionisAdmissionPolicyComparisonReport = {
  contract_version: "aionis_admission_policy_comparison_report_v1";
  intended_use: "offline_admission_policy_baseline_comparison";
  runtime_mutation: false;
  agent_prompt_included: false;
  policy: {
    policy_id: string;
    policy_version: string;
    policy_mode: string;
    runtime_version: string | null;
  };
  dataset: {
    row_count: number;
    positive_use_count: number;
    negative_use_count: number;
    blocked_or_suppressed_count: number;
    rehydrate_requested_count: number;
    unused_exposed_count: number;
  };
  sample_quality: {
    minimum_rows_for_policy_claim: number;
    current_row_count: number;
    has_minimum_rows_for_policy_claim: boolean;
    not_enough_rows_for_policy_claim: boolean;
    minimum_task_signatures_for_diversity_claim: number;
    current_task_signature_count: number;
    has_minimum_task_signatures_for_diversity_claim: boolean;
    not_enough_task_signatures_for_diversity_claim: boolean;
  };
  arms: AionisAdmissionPolicyComparisonArm[];
  leaderboard: AionisAdmissionPolicyComparisonArm[];
  caveats: string[];
  summary: string;
};

type PolicyDefinition = {
  policy_id: AionisAdmissionPolicyComparisonPolicyId;
  display_name: string;
  description: string;
  decide(row: AdmissionDatasetRow): AionisAdmissionPolicyComparisonAction;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function uniqueStringCount(rows: AdmissionDatasetRow[], field: keyof AdmissionDatasetRow): number {
  return new Set(rows.map((row) => stringValue(row[field])).filter((value): value is string => !!value)).size;
}

function normalizedPolicy(options: AionisAdmissionDatasetEvaluatorOptions): {
  policy_id: string;
  policy_version: string;
  policy_mode: string;
  runtime_version: string | null;
} {
  return {
    policy_id: stringValue(options.policy_id) ?? AIONIS_ADMISSION_POLICY_ID,
    policy_version: stringValue(options.policy_version) ?? AIONIS_ADMISSION_POLICY_VERSION,
    policy_mode: stringValue(options.policy_mode) ?? AIONIS_ADMISSION_POLICY_MODE,
    runtime_version: stringValue(options.runtime_version),
  };
}

const POLICY_DEFINITIONS: PolicyDefinition[] = [
  {
    policy_id: "aionis_recorded_policy",
    display_name: "Aionis recorded policy",
    description: "Uses the admission_action recorded by the Runtime admission record.",
    decide: (row) => row.admission_action,
  },
  {
    policy_id: "raw_retrieval_prompt_proxy",
    display_name: "Raw retrieval prompt proxy",
    description: "Treats every prompt-included candidate as direct-use memory, ignoring lifecycle and authority routing.",
    decide: (row) => (row.prompt_included ? "use_now" : "not_agent_facing"),
  },
  {
    policy_id: "always_use",
    display_name: "Always use",
    description: "Routes every dataset candidate to direct use.",
    decide: () => "use_now",
  },
  {
    policy_id: "always_block",
    display_name: "Always block",
    description: "Routes every dataset candidate to do_not_use.",
    decide: () => "do_not_use",
  },
];

function scoreArm(args: {
  policy: PolicyDefinition;
  rows: AdmissionDatasetRow[];
  datasetPositiveUseCount: number;
  datasetBlockedOrSuppressedCount: number;
  datasetRehydrateRequestedCount: number;
}): Omit<AionisAdmissionPolicyComparisonArm, "rank"> {
  const predictedActionCounts: Record<string, number> = {};
  let directUseCount = 0;
  let positiveUseDirectCount = 0;
  let negativeUseDirectCount = 0;
  let blockedOrSuppressedDirectCount = 0;
  let rehydrateDirectCount = 0;
  let unusedExposedDirectCount = 0;
  let missedPositiveUseCount = 0;

  for (const row of args.rows) {
    const predicted = args.policy.decide(row);
    increment(predictedActionCounts, predicted);
    if (predicted === "use_now") {
      directUseCount += 1;
      if (row.outcome_label === "positive_use") positiveUseDirectCount += 1;
      if (row.outcome_label === "negative_use") negativeUseDirectCount += 1;
      if (row.outcome_label === "blocked_or_suppressed") blockedOrSuppressedDirectCount += 1;
      if (row.outcome_label === "rehydrate_requested") rehydrateDirectCount += 1;
      if (row.outcome_label === "unused_exposed") unusedExposedDirectCount += 1;
    } else if (row.outcome_label === "positive_use") {
      missedPositiveUseCount += 1;
    }
  }

  const directRiskCount = negativeUseDirectCount + blockedOrSuppressedDirectCount + rehydrateDirectCount;
  const positiveCaptureRate = rate(positiveUseDirectCount, args.datasetPositiveUseCount);
  const directUseRiskRate = rate(directRiskCount, directUseCount);
  const score = roundRate(positiveCaptureRate - directUseRiskRate);

  return {
    policy_id: args.policy.policy_id,
    display_name: args.policy.display_name,
    description: args.policy.description,
    row_count: args.rows.length,
    predicted_action_counts: predictedActionCounts,
    direct_use_count: directUseCount,
    positive_use_direct_count: positiveUseDirectCount,
    negative_use_direct_count: negativeUseDirectCount,
    blocked_or_suppressed_direct_count: blockedOrSuppressedDirectCount,
    rehydrate_direct_count: rehydrateDirectCount,
    unused_exposed_direct_count: unusedExposedDirectCount,
    missed_positive_use_count: missedPositiveUseCount,
    positive_capture_rate: positiveCaptureRate,
    direct_use_positive_precision_proxy: rate(positiveUseDirectCount, directUseCount),
    direct_use_risk_rate: directUseRiskRate,
    blocked_or_suppressed_direct_rate: rate(blockedOrSuppressedDirectCount, args.datasetBlockedOrSuppressedCount),
    rehydrate_bypass_rate: rate(rehydrateDirectCount, args.datasetRehydrateRequestedCount),
    utility_minus_risk_score: score,
  };
}

function rankArms(arms: Array<Omit<AionisAdmissionPolicyComparisonArm, "rank">>): AionisAdmissionPolicyComparisonArm[] {
  const sorted = [...arms].sort((a, b) =>
    b.utility_minus_risk_score - a.utility_minus_risk_score
    || b.positive_capture_rate - a.positive_capture_rate
    || a.direct_use_risk_rate - b.direct_use_risk_rate
    || a.direct_use_count - b.direct_use_count
    || a.policy_id.localeCompare(b.policy_id),
  );
  return sorted.map((arm, index) => ({ ...arm, rank: index + 1 }));
}

export function compareAdmissionPoliciesForRows(
  rows: AdmissionDatasetRow[],
  options: AionisAdmissionDatasetEvaluatorOptions = {},
): AionisAdmissionPolicyComparisonReport {
  const positiveUseCount = rows.filter((row) => row.outcome_label === "positive_use").length;
  const negativeUseCount = rows.filter((row) => row.outcome_label === "negative_use").length;
  const blockedOrSuppressedCount = rows.filter((row) => row.outcome_label === "blocked_or_suppressed").length;
  const rehydrateRequestedCount = rows.filter((row) => row.outcome_label === "rehydrate_requested").length;
  const unusedExposedCount = rows.filter((row) => row.outcome_label === "unused_exposed").length;
  const hasMinimumRowsForPolicyClaim = rows.length >= AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM;
  const taskSignatureCount = uniqueStringCount(rows, "task_signature");
  const hasMinimumTaskSignaturesForDiversityClaim = taskSignatureCount >= AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM;
  const arms = rankArms(POLICY_DEFINITIONS.map((policy) => scoreArm({
    policy,
    rows,
    datasetPositiveUseCount: positiveUseCount,
    datasetBlockedOrSuppressedCount: blockedOrSuppressedCount,
    datasetRehydrateRequestedCount: rehydrateRequestedCount,
  })));
  const byId = new Map(arms.map((arm) => [arm.policy_id, arm]));
  const recorded = byId.get("aionis_recorded_policy");
  const raw = byId.get("raw_retrieval_prompt_proxy");
  const summary = recorded && raw
    ? `Compared ${arms.length} admission policies over ${rows.length} rows; Aionis score=${recorded.utility_minus_risk_score}, raw retrieval proxy score=${raw.utility_minus_risk_score}.`
    : `Compared ${arms.length} admission policies over ${rows.length} rows.`;
  return {
    contract_version: "aionis_admission_policy_comparison_report_v1",
    intended_use: "offline_admission_policy_baseline_comparison",
    runtime_mutation: false,
    agent_prompt_included: false,
    policy: normalizedPolicy(options),
    dataset: {
      row_count: rows.length,
      positive_use_count: positiveUseCount,
      negative_use_count: negativeUseCount,
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      rehydrate_requested_count: rehydrateRequestedCount,
      unused_exposed_count: unusedExposedCount,
    },
    sample_quality: {
      minimum_rows_for_policy_claim: AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM,
      current_row_count: rows.length,
      has_minimum_rows_for_policy_claim: hasMinimumRowsForPolicyClaim,
      not_enough_rows_for_policy_claim: !hasMinimumRowsForPolicyClaim,
      minimum_task_signatures_for_diversity_claim: AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM,
      current_task_signature_count: taskSignatureCount,
      has_minimum_task_signatures_for_diversity_claim: hasMinimumTaskSignaturesForDiversityClaim,
      not_enough_task_signatures_for_diversity_claim: !hasMinimumTaskSignaturesForDiversityClaim,
    },
    arms,
    leaderboard: arms,
    caveats: [
      "This is an offline proxy comparison over admission dataset rows, not a counterfactual Agent rerun.",
      "Raw retrieval prompt proxy treats prompt-included candidates as direct-use memory because candidate ranks are not preserved in the dataset.",
      !hasMinimumRowsForPolicyClaim
        ? `Do not claim policy quality until the dataset reaches at least ${AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM} rows.`
        : null,
      !hasMinimumTaskSignaturesForDiversityClaim
        ? `Do not claim policy diversity until the dataset reaches at least ${AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM} task signatures.`
        : null,
      "Do not use this report to mutate Runtime gates without holdout validation.",
    ].filter((caveat): caveat is string => Boolean(caveat)),
    summary,
  };
}

export function compareAdmissionPoliciesJsonl(
  input: string,
  options: AionisAdmissionDatasetEvaluatorOptions = {},
): AionisAdmissionPolicyComparisonReport {
  return compareAdmissionPoliciesForRows(parseAdmissionDatasetJsonl(input, options), options);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatAdmissionPolicyComparisonMarkdown(report: AionisAdmissionPolicyComparisonReport): string {
  const lines = [
    "# Aionis Admission Policy Comparison",
    "",
    report.summary,
    "",
    "| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |",
    "|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const arm of report.leaderboard) {
    lines.push([
      `| ${arm.rank}`,
      arm.display_name,
      arm.utility_minus_risk_score.toFixed(4),
      pct(arm.positive_capture_rate),
      pct(arm.direct_use_risk_rate),
      pct(arm.direct_use_positive_precision_proxy),
      String(arm.direct_use_count),
      `${arm.missed_positive_use_count} |`,
    ].join(" | "));
  }
  lines.push(
    "",
    "## Dataset",
    "",
    `- Rows: ${report.dataset.row_count}`,
    `- Minimum rows for policy claim: ${report.sample_quality.minimum_rows_for_policy_claim}`,
    `- Enough rows for policy claim: ${report.sample_quality.has_minimum_rows_for_policy_claim ? "yes" : "no"}`,
    `- Minimum task signatures for diversity claim: ${report.sample_quality.minimum_task_signatures_for_diversity_claim}`,
    `- Enough task signatures for diversity claim: ${report.sample_quality.has_minimum_task_signatures_for_diversity_claim ? "yes" : "no"}`,
    `- Positive use rows: ${report.dataset.positive_use_count}`,
    `- Negative use rows: ${report.dataset.negative_use_count}`,
    `- Blocked or suppressed rows: ${report.dataset.blocked_or_suppressed_count}`,
    `- Rehydrate requested rows: ${report.dataset.rehydrate_requested_count}`,
    "",
    "## Caveats",
    "",
    ...report.caveats.map((caveat) => `- ${caveat}`),
    "",
  );
  return lines.join("\n");
}
