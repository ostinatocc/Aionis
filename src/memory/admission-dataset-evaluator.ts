import {
  AIONIS_ADMISSION_POLICY_ID,
  AIONIS_ADMISSION_POLICY_MODE,
  AIONIS_ADMISSION_POLICY_VERSION,
  type AionisMemoryAdmissionDatasetOutcomeLabel,
  type AionisMemoryAdmissionDatasetRow,
} from "../sdk.js";

export type AionisAdmissionDatasetEvaluatorOptions = {
  policy_id?: string | null;
  policy_version?: string | null;
  policy_mode?: string | null;
  runtime_version?: string | null;
};

export type AionisAdmissionDatasetBucketDimension =
  | "admission_action"
  | "outcome_label"
  | "task_signature"
  | "lifecycle_state"
  | "authority"
  | "memory_type"
  | "source_backend"
  | "memory_origin"
  | "domain"
  | "policy_id";

export type AionisAdmissionDatasetEvaluationBucket = {
  dimension: AionisAdmissionDatasetBucketDimension;
  key: string;
  row_count: number;
  use_now_count: number;
  positive_use_count: number;
  negative_use_count: number;
  unused_exposed_count: number;
  blocked_or_suppressed_count: number;
  rehydrate_requested_count: number;
  use_now_positive_rate: number;
  use_now_negative_rate: number;
  unused_exposed_rate: number;
};

export type AionisAdmissionDatasetEvaluationReport = {
  contract_version: "aionis_admission_dataset_evaluation_report_v1";
  intended_use: "offline_admission_policy_audit";
  runtime_mutation: false;
  agent_prompt_included: false;
  policy: {
    policy_id: string;
    policy_version: string;
    policy_mode: string;
    runtime_version: string | null;
    row_policy_metadata_coverage: number;
  };
  dataset: {
    row_count: number;
    run_count: number;
    task_count: number;
    task_signature_count: number;
    guide_trace_count: number;
    scope_count: number;
    source_backends: string[];
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
  metrics: {
    prompt_char_total: number;
    prompt_char_average: number;
    prompt_included_count: number;
    agent_used_count: number;
    use_now_count: number;
    use_now_positive_count: number;
    use_now_negative_count: number;
    use_now_unused_count: number;
    use_now_positive_rate: number;
    use_now_negative_rate: number;
    use_now_unused_rate: number;
    blocked_or_suppressed_count: number;
    rehydrate_requested_count: number;
    unused_exposed_count: number;
    unused_exposed_rate: number;
    not_agent_facing_count: number;
    unknown_count: number;
  };
  action_counts: Record<string, number>;
  outcome_counts: Record<string, number>;
  buckets: AionisAdmissionDatasetEvaluationBucket[];
  risk_flags: string[];
  recommendations: string[];
  summary: string;
};

type AdmissionDatasetInputRow = Partial<AionisMemoryAdmissionDatasetRow> & {
  contract_version?: unknown;
  policy_id?: unknown;
  policy_version?: unknown;
  policy_mode?: unknown;
  runtime_version?: unknown;
  admission_action?: unknown;
  outcome_label?: unknown;
  prompt_included?: unknown;
  agent_used?: unknown;
  prompt_char_count?: unknown;
};

type NormalizedAdmissionDatasetRow = Omit<
  AionisMemoryAdmissionDatasetRow,
  "policy_id" | "policy_version" | "policy_mode" | "runtime_version"
> & {
  policy_id: string;
  policy_version: string;
  policy_mode: string;
  runtime_version: string | null;
};

const BUCKET_DIMENSIONS: AionisAdmissionDatasetBucketDimension[] = [
  "admission_action",
  "outcome_label",
  "task_signature",
  "lifecycle_state",
  "authority",
  "memory_type",
  "source_backend",
  "memory_origin",
  "domain",
  "policy_id",
];

export const AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM = 100;
export const AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM = 6;

function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function uniqueCount(rows: NormalizedAdmissionDatasetRow[], field: keyof NormalizedAdmissionDatasetRow): number {
  return new Set(rows.map((row) => row[field]).filter((value) => stringValue(value) !== null)).size;
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = stringValue(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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

function normalizeRow(
  row: AdmissionDatasetInputRow,
  policyDefaults: ReturnType<typeof normalizedPolicy>,
): NormalizedAdmissionDatasetRow {
  if (row.contract_version !== "aionis_memory_admission_dataset_row_v1") {
    throw new Error("Admission dataset row must use contract_version=aionis_memory_admission_dataset_row_v1");
  }
  const admissionAction = stringValue(row.admission_action);
  const outcomeLabel = stringValue(row.outcome_label);
  if (!admissionAction) throw new Error("Admission dataset row missing admission_action");
  if (!outcomeLabel) throw new Error("Admission dataset row missing outcome_label");
  return {
    ...(row as AionisMemoryAdmissionDatasetRow),
    policy_id: stringValue(row.policy_id) ?? policyDefaults.policy_id,
    policy_version: stringValue(row.policy_version) ?? policyDefaults.policy_version,
    policy_mode: stringValue(row.policy_mode) ?? policyDefaults.policy_mode,
    runtime_version: stringValue(row.runtime_version) ?? policyDefaults.runtime_version,
    tenant_id: stringValue(row.tenant_id) ?? null,
    scope: stringValue(row.scope) ?? null,
    guide_trace_id: stringValue(row.guide_trace_id) ?? null,
    run_id: stringValue(row.run_id) ?? null,
    task_id: stringValue(row.task_id) ?? null,
    task_signature: stringValue(row.task_signature) ?? null,
    title: stringValue(row.title) ?? null,
    source_backend: stringValue(row.source_backend) ?? null,
    admission_action: admissionAction as AionisMemoryAdmissionDatasetRow["admission_action"],
    outcome_label: outcomeLabel as AionisMemoryAdmissionDatasetOutcomeLabel,
    prompt_included: booleanValue(row.prompt_included),
    agent_used: booleanValue(row.agent_used),
    prompt_char_count: numberValue(row.prompt_char_count),
    reason_codes: Array.isArray(row.reason_codes) ? row.reason_codes.filter((entry): entry is string => typeof entry === "string") : [],
    evidence_ids: Array.isArray(row.evidence_ids) ? row.evidence_ids.filter((entry): entry is string => typeof entry === "string") : [],
    history_used: booleanValue(row.history_used),
    actionable_history_used: booleanValue(row.actionable_history_used),
  };
}

export function parseAdmissionDatasetJsonl(
  input: string,
  options: AionisAdmissionDatasetEvaluatorOptions = {},
): NormalizedAdmissionDatasetRow[] {
  const policyDefaults = normalizedPolicy(options);
  return parseAdmissionDatasetJsonlObjects(input).map((row) => normalizeRow(row, policyDefaults));
}

function parseAdmissionDatasetJsonlObjects(input: string): AdmissionDatasetInputRow[] {
  const rows: AdmissionDatasetInputRow[] = [];
  input.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid admission dataset JSONL at line ${index + 1}: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid admission dataset JSONL at line ${index + 1}: row must be an object`);
    }
    rows.push(parsed as AdmissionDatasetInputRow);
  });
  return rows;
}

function bucketValue(row: NormalizedAdmissionDatasetRow, dimension: AionisAdmissionDatasetBucketDimension): string {
  const value = row[dimension];
  return stringValue(value) ?? "(missing)";
}

function buildBucket(
  dimension: AionisAdmissionDatasetBucketDimension,
  key: string,
  rows: NormalizedAdmissionDatasetRow[],
): AionisAdmissionDatasetEvaluationBucket {
  const useNow = rows.filter((row) => row.admission_action === "use_now");
  const positiveUseCount = rows.filter((row) => row.outcome_label === "positive_use").length;
  const negativeUseCount = rows.filter((row) => row.outcome_label === "negative_use").length;
  const unusedExposedCount = rows.filter((row) => row.outcome_label === "unused_exposed").length;
  return {
    dimension,
    key,
    row_count: rows.length,
    use_now_count: useNow.length,
    positive_use_count: positiveUseCount,
    negative_use_count: negativeUseCount,
    unused_exposed_count: unusedExposedCount,
    blocked_or_suppressed_count: rows.filter((row) => row.outcome_label === "blocked_or_suppressed").length,
    rehydrate_requested_count: rows.filter((row) => row.outcome_label === "rehydrate_requested").length,
    use_now_positive_rate: rate(positiveUseCount, useNow.length),
    use_now_negative_rate: rate(negativeUseCount, useNow.length),
    unused_exposed_rate: rate(unusedExposedCount, rows.filter((row) => row.prompt_included).length),
  };
}

function buildBuckets(rows: NormalizedAdmissionDatasetRow[]): AionisAdmissionDatasetEvaluationBucket[] {
  const buckets: AionisAdmissionDatasetEvaluationBucket[] = [];
  for (const dimension of BUCKET_DIMENSIONS) {
    const grouped = new Map<string, NormalizedAdmissionDatasetRow[]>();
    for (const row of rows) {
      const key = bucketValue(row, dimension);
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }
    for (const [key, groupRows] of grouped.entries()) {
      buckets.push(buildBucket(dimension, key, groupRows));
    }
  }
  return buckets.sort((a, b) => b.row_count - a.row_count || a.dimension.localeCompare(b.dimension) || a.key.localeCompare(b.key));
}

function buildRecommendations(args: {
  rows: NormalizedAdmissionDatasetRow[];
  rowPolicyCoverage: number;
  useNowNegativeCount: number;
  unusedExposedRate: number;
  blockedOrSuppressedCount: number;
  rehydrateRequestedCount: number;
}): string[] {
  return compactStrings([
    args.rows.length < AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM ? "collect_at_least_100_rows_before_claiming_policy_quality" : null,
    uniqueCount(args.rows, "task_signature") < AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM
      ? "collect_at_least_6_task_signatures_before_claiming_policy_diversity"
      : null,
    args.rowPolicyCoverage < 1 ? "backfill_policy_metadata_before_policy_version_comparison" : null,
    args.useNowNegativeCount > 0 ? "inspect_negative_use_rows_before_policy_change" : null,
    args.unusedExposedRate > 0.5 ? "review_high_unused_exposure_for_candidate_noise_or_missing_feedback" : null,
    args.blockedOrSuppressedCount === 0 ? "add_blocked_or_suppressed_examples_to_test_firewall_precision" : null,
    args.rehydrateRequestedCount === 0 ? "add_rehydrate_examples_to_test_payload_sufficiency" : null,
  ]);
}

export function evaluateAdmissionDatasetRows(
  inputRows: AdmissionDatasetInputRow[],
  options: AionisAdmissionDatasetEvaluatorOptions = {},
): AionisAdmissionDatasetEvaluationReport {
  const policyDefaults = normalizedPolicy(options);
  const rows = inputRows.map((row) => normalizeRow(row, policyDefaults));
  const actionCounts: Record<string, number> = {};
  const outcomeCounts: Record<string, number> = {};
  for (const row of rows) {
    increment(actionCounts, row.admission_action);
    increment(outcomeCounts, row.outcome_label);
  }
  const useNowRows = rows.filter((row) => row.admission_action === "use_now");
  const promptIncludedRows = rows.filter((row) => row.prompt_included);
  const useNowPositiveCount = useNowRows.filter((row) => row.outcome_label === "positive_use").length;
  const useNowNegativeCount = useNowRows.filter((row) => row.outcome_label === "negative_use").length;
  const useNowUnusedCount = useNowRows.filter((row) => row.outcome_label === "unused_exposed").length;
  const unusedExposedCount = rows.filter((row) => row.outcome_label === "unused_exposed").length;
  const blockedOrSuppressedCount = rows.filter((row) => row.outcome_label === "blocked_or_suppressed").length;
  const rehydrateRequestedCount = rows.filter((row) => row.outcome_label === "rehydrate_requested").length;
  const rowsWithPolicyMetadata = inputRows.filter((row) =>
    stringValue(row.policy_id) && stringValue(row.policy_version) && stringValue(row.policy_mode)
  ).length;
  const rowPolicyCoverage = rate(rowsWithPolicyMetadata, rows.length);
  const unusedExposedRate = rate(unusedExposedCount, promptIncludedRows.length);
  const promptCharTotal = rows.reduce((sum, row) => sum + row.prompt_char_count, 0);
  const hasMinimumRowsForPolicyClaim = rows.length >= AIONIS_ADMISSION_DATASET_MIN_ROWS_FOR_POLICY_CLAIM;
  const taskSignatureCount = uniqueCount(rows, "task_signature");
  const hasMinimumTaskSignaturesForDiversityClaim = taskSignatureCount >= AIONIS_ADMISSION_DATASET_MIN_TASK_SIGNATURES_FOR_DIVERSITY_CLAIM;
  return {
    contract_version: "aionis_admission_dataset_evaluation_report_v1",
    intended_use: "offline_admission_policy_audit",
    runtime_mutation: false,
    agent_prompt_included: false,
    policy: {
      ...policyDefaults,
      row_policy_metadata_coverage: rowPolicyCoverage,
    },
    dataset: {
      row_count: rows.length,
      run_count: uniqueCount(rows, "run_id"),
      task_count: uniqueCount(rows, "task_id"),
      task_signature_count: taskSignatureCount,
      guide_trace_count: uniqueCount(rows, "guide_trace_id"),
      scope_count: uniqueCount(rows, "scope"),
      source_backends: compactStrings(rows.map((row) => row.source_backend ?? row.memory_origin ?? null)),
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
    metrics: {
      prompt_char_total: promptCharTotal,
      prompt_char_average: rows.length > 0 ? Math.round(promptCharTotal / rows.length) : 0,
      prompt_included_count: promptIncludedRows.length,
      agent_used_count: rows.filter((row) => row.agent_used).length,
      use_now_count: useNowRows.length,
      use_now_positive_count: useNowPositiveCount,
      use_now_negative_count: useNowNegativeCount,
      use_now_unused_count: useNowUnusedCount,
      use_now_positive_rate: rate(useNowPositiveCount, useNowRows.length),
      use_now_negative_rate: rate(useNowNegativeCount, useNowRows.length),
      use_now_unused_rate: rate(useNowUnusedCount, useNowRows.length),
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      rehydrate_requested_count: rehydrateRequestedCount,
      unused_exposed_count: unusedExposedCount,
      unused_exposed_rate: unusedExposedRate,
      not_agent_facing_count: rows.filter((row) => row.outcome_label === "not_agent_facing").length,
      unknown_count: rows.filter((row) => row.outcome_label === "unknown").length,
    },
    action_counts: actionCounts,
    outcome_counts: outcomeCounts,
    buckets: buildBuckets(rows),
    risk_flags: compactStrings([
      useNowNegativeCount > 0 ? "use_now_negative_use_present" : null,
      unusedExposedRate > 0.5 ? "high_unused_exposed_rate" : null,
      rowPolicyCoverage < 1 ? "policy_metadata_incomplete" : null,
      !hasMinimumRowsForPolicyClaim ? "not_enough_rows_for_policy_claim" : null,
      !hasMinimumRowsForPolicyClaim ? "small_dataset_do_not_claim_policy_quality" : null,
      !hasMinimumTaskSignaturesForDiversityClaim ? "not_enough_task_signatures_for_diversity_claim" : null,
    ]),
    recommendations: buildRecommendations({
      rows,
      rowPolicyCoverage,
      useNowNegativeCount,
      unusedExposedRate,
      blockedOrSuppressedCount,
      rehydrateRequestedCount,
    }),
    summary: `Evaluated ${rows.length} admission dataset rows for ${policyDefaults.policy_id}; use_now_positive_rate=${rate(useNowPositiveCount, useNowRows.length)}, use_now_negative_rate=${rate(useNowNegativeCount, useNowRows.length)}, unused_exposed_rate=${unusedExposedRate}.`,
  };
}

export function evaluateAdmissionDatasetJsonl(
  input: string,
  options: AionisAdmissionDatasetEvaluatorOptions = {},
): AionisAdmissionDatasetEvaluationReport {
  return evaluateAdmissionDatasetRows(parseAdmissionDatasetJsonlObjects(input), options);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function formatAdmissionDatasetEvaluationMarkdown(report: AionisAdmissionDatasetEvaluationReport): string {
  const topBuckets = report.buckets
    .filter((bucket) => bucket.dimension === "admission_action" || bucket.dimension === "outcome_label")
    .slice(0, 12);
  return [
    "# Aionis Admission Dataset Evaluation",
    "",
    `Policy: \`${report.policy.policy_id}\` (${report.policy.policy_version}, ${report.policy.policy_mode})`,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Rows | ${report.dataset.row_count} |`,
    `| Runs | ${report.dataset.run_count} |`,
    `| Tasks | ${report.dataset.task_count} |`,
    `| Task signatures | ${report.dataset.task_signature_count} |`,
    `| minimum rows for policy claim | ${report.sample_quality.minimum_rows_for_policy_claim} |`,
    `| enough rows for policy claim | ${report.sample_quality.has_minimum_rows_for_policy_claim ? "yes" : "no"} |`,
    `| minimum task signatures for diversity claim | ${report.sample_quality.minimum_task_signatures_for_diversity_claim} |`,
    `| enough task signatures for diversity claim | ${report.sample_quality.has_minimum_task_signatures_for_diversity_claim ? "yes" : "no"} |`,
    `| use_now positive rate | ${formatPercent(report.metrics.use_now_positive_rate)} |`,
    `| use_now negative rate | ${formatPercent(report.metrics.use_now_negative_rate)} |`,
    `| use_now unused rate | ${formatPercent(report.metrics.use_now_unused_rate)} |`,
    `| unused exposed rate | ${formatPercent(report.metrics.unused_exposed_rate)} |`,
    `| blocked / suppressed rows | ${report.metrics.blocked_or_suppressed_count} |`,
    `| rehydrate requested rows | ${report.metrics.rehydrate_requested_count} |`,
    `| policy metadata coverage | ${formatPercent(report.policy.row_policy_metadata_coverage)} |`,
    "",
    "## Buckets",
    "",
    "| Dimension | Key | Rows | use_now | Positive use | Negative use | Unused exposed |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...topBuckets.map((bucket) =>
      `| ${bucket.dimension} | ${bucket.key} | ${bucket.row_count} | ${bucket.use_now_count} | ${bucket.positive_use_count} | ${bucket.negative_use_count} | ${bucket.unused_exposed_count} |`
    ),
    "",
    "## Risk Flags",
    "",
    ...(report.risk_flags.length > 0 ? report.risk_flags.map((flag) => `- \`${flag}\``) : ["- none"]),
    "",
    "## Recommendations",
    "",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- \`${entry}\``) : ["- none"]),
    "",
  ].join("\n");
}
