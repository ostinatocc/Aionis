import {
  parseAdmissionDatasetJsonl,
  type AionisAdmissionDatasetEvaluatorOptions,
} from "./admission-dataset-evaluator.js";
import {
  splitAdmissionDatasetRows,
  type AionisAdmissionDatasetHoldoutOptions,
  type AionisAdmissionDatasetHoldoutSplitBy,
  type AionisAdmissionDatasetParsedRow,
} from "./admission-dataset-holdout.js";
import type { AionisMemoryAdmissionRecordEntry } from "../sdk.js";

type AdmissionAction = AionisMemoryAdmissionRecordEntry["admission_action"];

export type AionisAdmissionCandidatePolicyId =
  | "recorded_policy_baseline"
  | "candidate_external_current_inspect"
  | "candidate_aionis_project_context_only"
  | "candidate_advisory_inspect"
  | "candidate_closed_loop_contradicted_inspect"
  | "candidate_project_context_closed_loop_inspect";

export type AionisAdmissionCandidatePolicyScore = {
  policy_id: AionisAdmissionCandidatePolicyId;
  display_name: string;
  description: string;
  used_fields: string[];
  label_leakage_guard: true;
  row_count: number;
  changed_action_count: number;
  predicted_action_counts: Record<string, number>;
  direct_use_count: number;
  positive_use_direct_count: number;
  negative_use_direct_count: number;
  blocked_or_suppressed_direct_count: number;
  rehydrate_direct_count: number;
  hard_boundary_direct_count: number;
  unused_exposed_direct_count: number;
  missed_positive_use_count: number;
  positive_capture_rate: number;
  direct_use_positive_precision_proxy: number;
  direct_use_negative_rate: number;
  hard_boundary_direct_rate: number;
  direct_use_unused_rate: number;
  negative_use_per_row: number;
  hard_boundary_per_row: number;
  unused_exposed_per_row: number;
  calibration_score: number;
  rank: number;
};

export type AionisAdmissionCandidatePolicyEvaluationReport = {
  contract_version: "aionis_admission_candidate_policy_evaluation_report_v1";
  intended_use: "offline_admission_candidate_policy_validation";
  runtime_mutation: false;
  agent_prompt_included: false;
  policy: {
    policy_id: string | null;
    policy_version: string | null;
    policy_mode: string | null;
    runtime_version: string | null;
  };
  split: {
    split_by: AionisAdmissionDatasetHoldoutSplitBy;
    seed: string;
    holdout_ratio: number;
    train_row_count: number;
    holdout_row_count: number;
    train_group_count: number;
    holdout_group_count: number;
    train_groups: string[];
    holdout_groups: string[];
  };
  dataset: {
    row_count: number;
    train_row_count: number;
    holdout_row_count: number;
  };
  guards: {
    no_runtime_mutation: true;
    label_leakage_guard: true;
    forbidden_decision_fields: string[];
    hard_actions_preserved: true;
  };
  train_leaderboard: AionisAdmissionCandidatePolicyScore[];
  holdout_scores: AionisAdmissionCandidatePolicyScore[];
  selected_policy_id: AionisAdmissionCandidatePolicyId;
  selected_policy: {
    train: AionisAdmissionCandidatePolicyScore;
    holdout: AionisAdmissionCandidatePolicyScore;
  };
  recorded_policy: {
    train: AionisAdmissionCandidatePolicyScore;
    holdout: AionisAdmissionCandidatePolicyScore;
  };
  promotion_gate: {
    eligible_for_manual_review: boolean;
    train_candidate_supported: boolean;
    train_calibration_score_not_worse: boolean;
    no_hard_boundary_regression: boolean;
    no_negative_use_count_regression: boolean;
    no_positive_capture_regression: boolean;
    calibration_score_improved: boolean;
    changed_actions_on_holdout: boolean;
  };
  caveats: string[];
  summary: string;
};

export type AionisAdmissionCandidatePolicyEvaluationOptions = AionisAdmissionDatasetHoldoutOptions;

type PolicyDefinition = {
  policy_id: AionisAdmissionCandidatePolicyId;
  display_name: string;
  description: string;
  used_fields: string[];
  decide(row: AionisAdmissionDatasetParsedRow): AdmissionAction;
};

const DEFAULT_HOLDOUT_RATIO = 0.5;
const DEFAULT_HOLDOUT_SEED = "aionis-admission-holdout-v1";
const UNUSED_EXPOSURE_WEIGHT = 0.25;
const FORBIDDEN_DECISION_FIELDS = [
  "outcome_label",
  "feedback_outcome",
  "attribution_strength",
  "agent_used",
  "title",
  "task_signature",
  "run_id",
  "task_id",
  "guide_trace_id",
  "memory_id",
  "prompt_char_count",
];

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

function policyOptions(options: AionisAdmissionCandidatePolicyEvaluationOptions): AionisAdmissionDatasetEvaluatorOptions {
  return {
    policy_id: options.policy_id,
    policy_version: options.policy_version,
    policy_mode: options.policy_mode,
    runtime_version: options.runtime_version,
  };
}

function preserveHardActions(row: AionisAdmissionDatasetParsedRow, proposed: AdmissionAction): AdmissionAction {
  if (row.admission_action !== "use_now") return row.admission_action;
  return proposed === "use_now" ? "use_now" : "inspect_before_use";
}

const POLICY_DEFINITIONS: PolicyDefinition[] = [
  {
    policy_id: "recorded_policy_baseline",
    display_name: "Recorded policy baseline",
    description: "Uses the Runtime-recorded admission action without candidate changes.",
    used_fields: ["admission_action"],
    decide: (row) => row.admission_action,
  },
  {
    policy_id: "candidate_external_current_inspect",
    display_name: "External current inspect-first",
    description: "Keeps Runtime hard boundaries, but downgrades external direct-use candidates to inspect_before_use.",
    used_fields: ["admission_action", "memory_origin"],
    decide: (row) => preserveHardActions(row, row.memory_origin === "external" ? "inspect_before_use" : "use_now"),
  },
  {
    policy_id: "candidate_aionis_project_context_only",
    display_name: "Aionis project-context direct-use only",
    description: "Keeps Runtime hard boundaries, but direct-uses only Aionis project_context candidates.",
    used_fields: ["admission_action", "source_backend", "memory_type"],
    decide: (row) => preserveHardActions(
      row,
      row.source_backend === "aionis" && row.memory_type === "project_context" ? "use_now" : "inspect_before_use",
    ),
  },
  {
    policy_id: "candidate_advisory_inspect",
    display_name: "Advisory inspect-first",
    description: "Keeps Runtime hard boundaries, but downgrades advisory direct-use candidates to inspect_before_use.",
    used_fields: ["admission_action", "authority"],
    decide: (row) => preserveHardActions(row, row.authority === "advisory" ? "inspect_before_use" : "use_now"),
  },
  {
    policy_id: "candidate_closed_loop_contradicted_inspect",
    display_name: "Closed-loop contradicted inspect-first",
    description: "Keeps Runtime hard boundaries, but downgrades direct-use candidates with prior contradicted or mixed closed-loop effect state.",
    used_fields: ["admission_action", "closed_loop_effect_state", "repeated_negative_posture"],
    decide: (row) => preserveHardActions(
      row,
      row.closed_loop_effect_state === "contradicted"
        || row.closed_loop_effect_state === "mixed"
        || row.repeated_negative_posture
        ? "inspect_before_use"
        : "use_now",
    ),
  },
  {
    policy_id: "candidate_project_context_closed_loop_inspect",
    display_name: "Project/execution context + closed-loop inspect-first",
    description: "Keeps Runtime hard boundaries, direct-uses only Aionis project_context or execution_memory candidates, and downgrades prior-contradicted or repeated-negative candidates to inspect_before_use.",
    used_fields: [
      "admission_action",
      "source_backend",
      "memory_type",
      "closed_loop_effect_state",
      "repeated_negative_posture",
    ],
    decide: (row) => preserveHardActions(
      row,
      row.source_backend === "aionis"
        && (row.memory_type === "project_context" || row.memory_type === "execution_memory")
        && row.closed_loop_effect_state !== "contradicted"
        && row.closed_loop_effect_state !== "mixed"
        && !row.repeated_negative_posture
        ? "use_now"
        : "inspect_before_use",
    ),
  },
];

function validatePolicyDefinitions(policies: PolicyDefinition[]): void {
  const forbidden = new Set(FORBIDDEN_DECISION_FIELDS);
  for (const policy of policies) {
    const leaked = policy.used_fields.filter((field) => forbidden.has(field));
    if (leaked.length > 0) {
      throw new Error(`Candidate policy ${policy.policy_id} uses forbidden decision fields: ${leaked.join(", ")}`);
    }
  }
}

function findPolicyDefinition(policyId: AionisAdmissionCandidatePolicyId): PolicyDefinition {
  const policy = POLICY_DEFINITIONS.find((entry) => entry.policy_id === policyId);
  if (!policy) throw new Error(`Unknown admission candidate policy: ${policyId}`);
  validatePolicyDefinitions(POLICY_DEFINITIONS);
  return policy;
}

export function decideAdmissionCandidatePolicyActionForEvaluation(
  row: AionisAdmissionDatasetParsedRow,
  policyId: AionisAdmissionCandidatePolicyId,
): AdmissionAction {
  return findPolicyDefinition(policyId).decide(row);
}

export function admissionCandidatePolicyUsedFieldsForEvaluation(policyId: AionisAdmissionCandidatePolicyId): string[] {
  return [...findPolicyDefinition(policyId).used_fields];
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

function scorePolicy(
  policy: PolicyDefinition,
  rows: AionisAdmissionDatasetParsedRow[],
): Omit<AionisAdmissionCandidatePolicyScore, "rank"> {
  const predictedActionCounts: Record<string, number> = {};
  const positiveUseRows = rows.filter((row) => row.outcome_label === "positive_use");
  let changedActionCount = 0;
  let directUseCount = 0;
  let positiveUseDirectCount = 0;
  let negativeUseDirectCount = 0;
  let blockedOrSuppressedDirectCount = 0;
  let rehydrateDirectCount = 0;
  let unusedExposedDirectCount = 0;
  let missedPositiveUseCount = 0;

  for (const row of rows) {
    const predicted = policy.decide(row);
    if (predicted !== row.admission_action) changedActionCount += 1;
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

  const hardBoundaryDirectCount = blockedOrSuppressedDirectCount + rehydrateDirectCount;
  const positiveCaptureRate = rate(positiveUseDirectCount, positiveUseRows.length);
  const negativeUsePerRow = rate(negativeUseDirectCount, rows.length);
  const hardBoundaryPerRow = rate(hardBoundaryDirectCount, rows.length);
  const unusedExposedPerRow = rate(unusedExposedDirectCount, rows.length);
  const calibrationScore = roundRate(
    positiveCaptureRate
    - hardBoundaryPerRow
    - negativeUsePerRow
    - (UNUSED_EXPOSURE_WEIGHT * unusedExposedPerRow),
  );

  return {
    policy_id: policy.policy_id,
    display_name: policy.display_name,
    description: policy.description,
    used_fields: policy.used_fields,
    label_leakage_guard: true,
    row_count: rows.length,
    changed_action_count: changedActionCount,
    predicted_action_counts: predictedActionCounts,
    direct_use_count: directUseCount,
    positive_use_direct_count: positiveUseDirectCount,
    negative_use_direct_count: negativeUseDirectCount,
    blocked_or_suppressed_direct_count: blockedOrSuppressedDirectCount,
    rehydrate_direct_count: rehydrateDirectCount,
    hard_boundary_direct_count: hardBoundaryDirectCount,
    unused_exposed_direct_count: unusedExposedDirectCount,
    missed_positive_use_count: missedPositiveUseCount,
    positive_capture_rate: positiveCaptureRate,
    direct_use_positive_precision_proxy: rate(positiveUseDirectCount, directUseCount),
    direct_use_negative_rate: rate(negativeUseDirectCount, directUseCount),
    hard_boundary_direct_rate: rate(hardBoundaryDirectCount, directUseCount),
    direct_use_unused_rate: rate(unusedExposedDirectCount, directUseCount),
    negative_use_per_row: negativeUsePerRow,
    hard_boundary_per_row: hardBoundaryPerRow,
    unused_exposed_per_row: unusedExposedPerRow,
    calibration_score: calibrationScore,
  };
}

function rankScores(scores: Array<Omit<AionisAdmissionCandidatePolicyScore, "rank">>): AionisAdmissionCandidatePolicyScore[] {
  const sorted = [...scores].sort((a, b) =>
    b.calibration_score - a.calibration_score
    || b.positive_capture_rate - a.positive_capture_rate
    || a.hard_boundary_direct_count - b.hard_boundary_direct_count
    || a.negative_use_direct_count - b.negative_use_direct_count
    || a.unused_exposed_direct_count - b.unused_exposed_direct_count
    || a.changed_action_count - b.changed_action_count
    || a.policy_id.localeCompare(b.policy_id),
  );
  return sorted.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function scorePolicies(rows: AionisAdmissionDatasetParsedRow[]): AionisAdmissionCandidatePolicyScore[] {
  validatePolicyDefinitions(POLICY_DEFINITIONS);
  return rankScores(POLICY_DEFINITIONS.map((policy) => scorePolicy(policy, rows)));
}

function findScore(scores: AionisAdmissionCandidatePolicyScore[], policyId: AionisAdmissionCandidatePolicyId): AionisAdmissionCandidatePolicyScore {
  const score = scores.find((entry) => entry.policy_id === policyId);
  if (!score) throw new Error(`Missing candidate policy score for ${policyId}`);
  return score;
}

function caveats(args: {
  selectedTrain: AionisAdmissionCandidatePolicyScore;
  selectedHoldout: AionisAdmissionCandidatePolicyScore;
  recordedTrain: AionisAdmissionCandidatePolicyScore;
  recordedHoldout: AionisAdmissionCandidatePolicyScore;
  eligible: boolean;
  holdoutRows: AionisAdmissionDatasetParsedRow[];
  holdoutGroups: string[];
}): string[] {
  return [
    "This is an offline candidate-policy evaluation over exported admission rows, not a counterfactual Agent rerun.",
    "Candidate decisions are restricted to label-safe fields and cannot upgrade do_not_use or rehydrate rows to direct use.",
    "A candidate marked eligible is eligible for manual review only; it must not mutate Runtime gates by itself.",
    args.holdoutRows.length < 100 ? "Holdout has fewer than 100 rows; do not claim policy quality." : null,
    args.holdoutGroups.length < 6 ? "Holdout has fewer than 6 task signatures; do not claim cross-task diversity." : null,
    args.selectedTrain.policy_id === "recorded_policy_baseline" ? "Training selected the recorded policy baseline; no candidate policy improved train score." : null,
    args.selectedTrain.changed_action_count === 0 ? "Selected candidate made no action changes on train; treat holdout improvement as a discovery, not a promotion signal." : null,
    args.selectedTrain.calibration_score < args.recordedTrain.calibration_score ? "Selected candidate underperformed recorded policy on train." : null,
    !args.eligible ? "Selected candidate did not pass all holdout promotion gates." : null,
    args.selectedHoldout.negative_use_direct_count === args.recordedHoldout.negative_use_direct_count
      ? "Selected candidate did not reduce negative_use direct count; negative_use remains weak run-level supervision."
      : null,
  ].filter((entry): entry is string => Boolean(entry));
}

export function evaluateAdmissionCandidatePoliciesRows(
  rows: AionisAdmissionDatasetParsedRow[],
  options: AionisAdmissionCandidatePolicyEvaluationOptions = {},
): AionisAdmissionCandidatePolicyEvaluationReport {
  const splitBy = normalizedSplitBy(options.split_by);
  const holdoutRatio = normalizedHoldoutRatio(options.holdout_ratio);
  const seed = normalizedSeed(options.seed);
  const { trainRows, holdoutRows, trainGroups, holdoutGroups } = splitAdmissionDatasetRows({
    rows,
    splitBy,
    holdoutRatio,
    seed,
  });
  const trainLeaderboard = scorePolicies(trainRows);
  const holdoutScores = scorePolicies(holdoutRows);
  const selectedTrain = trainLeaderboard[0] ?? scorePolicy(POLICY_DEFINITIONS[0], []);
  const selectedHoldout = findScore(holdoutScores, selectedTrain.policy_id);
  const recordedTrain = findScore(trainLeaderboard, "recorded_policy_baseline");
  const recordedHoldout = findScore(holdoutScores, "recorded_policy_baseline");
  const noHardBoundaryRegression = selectedHoldout.hard_boundary_direct_count <= recordedHoldout.hard_boundary_direct_count;
  const noNegativeUseCountRegression = selectedHoldout.negative_use_direct_count <= recordedHoldout.negative_use_direct_count;
  const noPositiveCaptureRegression = selectedHoldout.positive_capture_rate >= recordedHoldout.positive_capture_rate;
  const trainCandidateSupported = selectedTrain.changed_action_count > 0;
  const trainCalibrationScoreNotWorse = selectedTrain.calibration_score >= recordedTrain.calibration_score;
  const calibrationScoreImproved = selectedHoldout.calibration_score > recordedHoldout.calibration_score;
  const changedActionsOnHoldout = selectedHoldout.changed_action_count > 0;
  const eligible = selectedTrain.policy_id !== "recorded_policy_baseline"
    && trainCandidateSupported
    && trainCalibrationScoreNotWorse
    && holdoutRows.length >= 100
    && holdoutGroups.length >= 6
    && noHardBoundaryRegression
    && noNegativeUseCountRegression
    && noPositiveCaptureRegression
    && calibrationScoreImproved
    && changedActionsOnHoldout;
  const normalizedPolicy = policyOptions(options);
  return {
    contract_version: "aionis_admission_candidate_policy_evaluation_report_v1",
    intended_use: "offline_admission_candidate_policy_validation",
    runtime_mutation: false,
    agent_prompt_included: false,
    policy: {
      policy_id: stringValue(normalizedPolicy.policy_id),
      policy_version: stringValue(normalizedPolicy.policy_version),
      policy_mode: stringValue(normalizedPolicy.policy_mode),
      runtime_version: stringValue(normalizedPolicy.runtime_version),
    },
    split: {
      split_by: splitBy,
      seed,
      holdout_ratio: holdoutRatio,
      train_row_count: trainRows.length,
      holdout_row_count: holdoutRows.length,
      train_group_count: trainGroups.length,
      holdout_group_count: holdoutGroups.length,
      train_groups: trainGroups,
      holdout_groups: holdoutGroups,
    },
    dataset: {
      row_count: rows.length,
      train_row_count: trainRows.length,
      holdout_row_count: holdoutRows.length,
    },
    guards: {
      no_runtime_mutation: true,
      label_leakage_guard: true,
      forbidden_decision_fields: FORBIDDEN_DECISION_FIELDS,
      hard_actions_preserved: true,
    },
    train_leaderboard: trainLeaderboard,
    holdout_scores: holdoutScores,
    selected_policy_id: selectedTrain.policy_id,
    selected_policy: {
      train: selectedTrain,
      holdout: selectedHoldout,
    },
    recorded_policy: {
      train: recordedTrain,
      holdout: recordedHoldout,
    },
    promotion_gate: {
      eligible_for_manual_review: eligible,
      train_candidate_supported: trainCandidateSupported,
      train_calibration_score_not_worse: trainCalibrationScoreNotWorse,
      no_hard_boundary_regression: noHardBoundaryRegression,
      no_negative_use_count_regression: noNegativeUseCountRegression,
      no_positive_capture_regression: noPositiveCaptureRegression,
      calibration_score_improved: calibrationScoreImproved,
      changed_actions_on_holdout: changedActionsOnHoldout,
    },
    caveats: caveats({
      selectedTrain,
      selectedHoldout,
      recordedTrain,
      recordedHoldout,
      eligible,
      holdoutRows,
      holdoutGroups,
    }),
    summary: `Selected ${selectedTrain.policy_id} on train; holdout calibration_score=${selectedHoldout.calibration_score}, recorded=${recordedHoldout.calibration_score}, eligible_for_manual_review=${eligible}.`,
  };
}

export function evaluateAdmissionCandidatePoliciesJsonl(
  input: string,
  options: AionisAdmissionCandidatePolicyEvaluationOptions = {},
): AionisAdmissionCandidatePolicyEvaluationReport {
  return evaluateAdmissionCandidatePoliciesRows(parseAdmissionDatasetJsonl(input, options), options);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function scoreRow(score: AionisAdmissionCandidatePolicyScore): string {
  return [
    `| ${score.rank}`,
    score.display_name,
    score.calibration_score.toFixed(4),
    pct(score.positive_capture_rate),
    String(score.negative_use_direct_count),
    String(score.hard_boundary_direct_count),
    String(score.unused_exposed_direct_count),
    String(score.changed_action_count),
    `${score.missed_positive_use_count} |`,
  ].join(" | ");
}

export function formatAdmissionCandidatePolicyEvaluationMarkdown(
  report: AionisAdmissionCandidatePolicyEvaluationReport,
): string {
  return [
    "# Aionis Admission Candidate Policy Evaluation",
    "",
    report.summary,
    "",
    "| Split | Rows | Groups |",
    "|---|---:|---:|",
    `| Train | ${report.split.train_row_count} | ${report.split.train_group_count} |`,
    `| Holdout | ${report.split.holdout_row_count} | ${report.split.holdout_group_count} |`,
    "",
    "## Selected Policy",
    "",
    `- Policy: \`${report.selected_policy_id}\``,
    `- Eligible for manual review: ${report.promotion_gate.eligible_for_manual_review ? "yes" : "no"}`,
    `- Holdout calibration score: ${report.selected_policy.holdout.calibration_score.toFixed(4)}`,
    `- Recorded holdout calibration score: ${report.recorded_policy.holdout.calibration_score.toFixed(4)}`,
    "",
    "## Holdout Promotion Gate",
    "",
    "| Gate | Result |",
    "|---|---|",
    `| no hard-boundary regression | ${report.promotion_gate.no_hard_boundary_regression ? "yes" : "no"} |`,
    `| train candidate supported | ${report.promotion_gate.train_candidate_supported ? "yes" : "no"} |`,
    `| train calibration score not worse | ${report.promotion_gate.train_calibration_score_not_worse ? "yes" : "no"} |`,
    `| no negative-use count regression | ${report.promotion_gate.no_negative_use_count_regression ? "yes" : "no"} |`,
    `| no positive-capture regression | ${report.promotion_gate.no_positive_capture_regression ? "yes" : "no"} |`,
    `| calibration score improved | ${report.promotion_gate.calibration_score_improved ? "yes" : "no"} |`,
    `| changed actions on holdout | ${report.promotion_gate.changed_actions_on_holdout ? "yes" : "no"} |`,
    "",
    "## Train Leaderboard",
    "",
    "| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.train_leaderboard.map(scoreRow),
    "",
    "## Holdout Scores",
    "",
    "| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.holdout_scores.map(scoreRow),
    "",
    "## Guards",
    "",
    `- Runtime mutation: ${report.runtime_mutation}`,
    `- Agent prompt included: ${report.agent_prompt_included}`,
    `- Label leakage guard: ${report.guards.label_leakage_guard}`,
    `- Hard actions preserved: ${report.guards.hard_actions_preserved}`,
    `- Forbidden decision fields: ${report.guards.forbidden_decision_fields.map((field) => `\`${field}\``).join(", ")}`,
    "",
    "## Caveats",
    "",
    ...(report.caveats.length > 0 ? report.caveats.map((entry) => `- ${entry}`) : ["- none"]),
    "",
  ].join("\n");
}
