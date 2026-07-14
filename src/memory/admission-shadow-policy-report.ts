import {
  admissionCandidatePolicyUsedFieldsForEvaluation,
  admissionCandidatePolicyVersionForEvaluation,
  decideAdmissionCandidatePolicyActionForEvaluation,
  type AionisAdmissionCandidatePolicyId,
} from "./admission-candidate-policy-evaluator.js";
import {
  parseAdmissionDatasetJsonl,
  type AionisAdmissionDatasetEvaluatorOptions,
} from "./admission-dataset-evaluator.js";
import type { AionisAdmissionDatasetParsedRow } from "./admission-dataset-holdout.js";
import type { AionisMemoryAdmissionRecordEntry } from "../sdk.js";
import { AIONIS_ADMISSION_CANDIDATE_POLICY_ID } from "./admission-candidate-policy.js";

type AdmissionAction = AionisMemoryAdmissionRecordEntry["admission_action"];

export type AionisAdmissionShadowPolicyArmMetrics = {
  arm_id: "recorded_policy" | AionisAdmissionCandidatePolicyId;
  direct_use_count: number;
  inspect_before_use_count: number;
  do_not_use_count: number;
  rehydrate_count: number;
  not_agent_facing_count: number;
  positive_direct_count: number;
  negative_direct_count: number;
  neutral_direct_count: number;
  unused_direct_count: number;
  hard_boundary_direct_count: number;
  missed_positive_count: number;
  direct_use_negative_rate: number;
  direct_use_unused_rate: number;
  direct_use_positive_precision_proxy: number;
};

export type AionisAdmissionShadowPolicyReport = {
  contract_version: "aionis_admission_shadow_policy_report_v1";
  intended_use: "offline_admission_shadow_policy_audit";
  runtime_mutation: false;
  agent_prompt_included: false;
  policy: {
    candidate_policy_id: AionisAdmissionCandidatePolicyId;
    candidate_policy_version: string;
    policy_id: string | null;
    policy_version: string | null;
    policy_mode: string | null;
    runtime_version: string | null;
  };
  dataset: {
    row_count: number;
    task_signature_count: number;
    run_count: number;
    guide_trace_count: number;
  };
  guards: {
    label_leakage_guard: true;
    runtime_shadow_only: true;
    hard_actions_preserved: boolean;
    hard_boundary_upgrade_count: number;
    used_fields: string[];
    forbidden_decision_fields: string[];
  };
  recorded: AionisAdmissionShadowPolicyArmMetrics;
  shadow: AionisAdmissionShadowPolicyArmMetrics;
  delta: {
    changed_action_count: number;
    would_downgrade_use_now_count: number;
    direct_use_delta: number;
    negative_direct_delta: number;
    unused_direct_delta: number;
    missed_positive_delta: number;
    hard_boundary_direct_delta: number;
  };
  changed_memory_ids_sample: string[];
  downgraded_memory_ids_sample: string[];
  caveats: string[];
  summary: string;
};

const SHADOW_POLICY_ID: AionisAdmissionCandidatePolicyId = AIONIS_ADMISSION_CANDIDATE_POLICY_ID;
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

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function actionCounts(rows: AionisAdmissionDatasetParsedRow[], actionForRow: (row: AionisAdmissionDatasetParsedRow) => AdmissionAction) {
  const counts: Record<AdmissionAction, number> = {
    use_now: 0,
    inspect_before_use: 0,
    do_not_use: 0,
    rehydrate: 0,
    not_agent_facing: 0,
  };
  let positiveDirect = 0;
  let negativeDirect = 0;
  let neutralDirect = 0;
  let unusedDirect = 0;
  let hardBoundaryDirect = 0;
  let missedPositive = 0;
  for (const row of rows) {
    const action = actionForRow(row);
    counts[action] += 1;
    if (action === "use_now") {
      if (row.outcome_label === "positive_use") positiveDirect += 1;
      if (row.outcome_label === "negative_use") negativeDirect += 1;
      if (row.outcome_label === "neutral_use") neutralDirect += 1;
      if (row.outcome_label === "unused_exposed") unusedDirect += 1;
      if (row.outcome_label === "blocked_or_suppressed" || row.outcome_label === "rehydrate_requested") {
        hardBoundaryDirect += 1;
      }
    } else if (row.outcome_label === "positive_use") {
      missedPositive += 1;
    }
  }
  return {
    counts,
    positiveDirect,
    negativeDirect,
    neutralDirect,
    unusedDirect,
    hardBoundaryDirect,
    missedPositive,
  };
}

function metricsForArm(args: {
  arm_id: AionisAdmissionShadowPolicyArmMetrics["arm_id"];
  rows: AionisAdmissionDatasetParsedRow[];
  actionForRow: (row: AionisAdmissionDatasetParsedRow) => AdmissionAction;
}): AionisAdmissionShadowPolicyArmMetrics {
  const counted = actionCounts(args.rows, args.actionForRow);
  const directUseCount = counted.counts.use_now;
  return {
    arm_id: args.arm_id,
    direct_use_count: directUseCount,
    inspect_before_use_count: counted.counts.inspect_before_use,
    do_not_use_count: counted.counts.do_not_use,
    rehydrate_count: counted.counts.rehydrate,
    not_agent_facing_count: counted.counts.not_agent_facing,
    positive_direct_count: counted.positiveDirect,
    negative_direct_count: counted.negativeDirect,
    neutral_direct_count: counted.neutralDirect,
    unused_direct_count: counted.unusedDirect,
    hard_boundary_direct_count: counted.hardBoundaryDirect,
    missed_positive_count: counted.missedPositive,
    direct_use_negative_rate: rate(counted.negativeDirect, directUseCount),
    direct_use_unused_rate: rate(counted.unusedDirect, directUseCount),
    direct_use_positive_precision_proxy: rate(counted.positiveDirect, directUseCount),
  };
}

function uniqueCount(rows: AionisAdmissionDatasetParsedRow[], field: keyof AionisAdmissionDatasetParsedRow): number {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[field];
    if (typeof value === "string" && value.length > 0) values.add(value);
  }
  return values.size;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function policyMetadata(rows: AionisAdmissionDatasetParsedRow[], field: "policy_id" | "policy_version" | "policy_mode" | "runtime_version"): string | null {
  return rows.find((row) => typeof row[field] === "string" && row[field].length > 0)?.[field] ?? null;
}

export function evaluateAdmissionShadowPolicyRows(
  rows: AionisAdmissionDatasetParsedRow[],
  candidatePolicyId: AionisAdmissionCandidatePolicyId = SHADOW_POLICY_ID,
): AionisAdmissionShadowPolicyReport {
  const usedFields = admissionCandidatePolicyUsedFieldsForEvaluation(candidatePolicyId);
  const forbidden = new Set(FORBIDDEN_DECISION_FIELDS);
  const leakedFields = usedFields.filter((field) => forbidden.has(field));
  if (leakedFields.length > 0) {
    throw new Error(`Shadow admission policy uses forbidden decision fields: ${leakedFields.join(", ")}`);
  }
  const recorded = metricsForArm({
    arm_id: "recorded_policy",
    rows,
    actionForRow: (row) => row.admission_action,
  });
  const shadow = metricsForArm({
    arm_id: candidatePolicyId,
    rows,
    actionForRow: (row) => decideAdmissionCandidatePolicyActionForEvaluation(row, candidatePolicyId),
  });
  let changedActionCount = 0;
  let wouldDowngradeUseNowCount = 0;
  let hardBoundaryUpgradeCount = 0;
  const changedMemoryIds: string[] = [];
  const downgradedMemoryIds: string[] = [];
  for (const row of rows) {
    const shadowAction = decideAdmissionCandidatePolicyActionForEvaluation(row, candidatePolicyId);
    if (shadowAction === row.admission_action) continue;
    changedActionCount += 1;
    changedMemoryIds.push(row.memory_id);
    if (row.admission_action === "use_now" && shadowAction === "inspect_before_use") {
      wouldDowngradeUseNowCount += 1;
      downgradedMemoryIds.push(row.memory_id);
    }
    if (row.admission_action !== "use_now" && shadowAction === "use_now") hardBoundaryUpgradeCount += 1;
  }
  const caveats = [
    "This is a dataset-level shadow audit. It does not enable the candidate policy in Runtime guide outputs.",
    "Outcome labels are used only for offline evaluation metrics, never for the candidate action decision.",
  ];
  if (rows.length < 100) caveats.push("Dataset has fewer than 100 rows; do not make external policy-quality claims.");
  const hardActionsPreserved = hardBoundaryUpgradeCount === 0;
  return {
    contract_version: "aionis_admission_shadow_policy_report_v1",
    intended_use: "offline_admission_shadow_policy_audit",
    runtime_mutation: false,
    agent_prompt_included: false,
    policy: {
      candidate_policy_id: candidatePolicyId,
      candidate_policy_version: admissionCandidatePolicyVersionForEvaluation(candidatePolicyId),
      policy_id: policyMetadata(rows, "policy_id"),
      policy_version: policyMetadata(rows, "policy_version"),
      policy_mode: policyMetadata(rows, "policy_mode"),
      runtime_version: policyMetadata(rows, "runtime_version"),
    },
    dataset: {
      row_count: rows.length,
      task_signature_count: uniqueCount(rows, "task_signature"),
      run_count: uniqueCount(rows, "run_id"),
      guide_trace_count: uniqueCount(rows, "guide_trace_id"),
    },
    guards: {
      label_leakage_guard: true,
      runtime_shadow_only: true,
      hard_actions_preserved: hardActionsPreserved,
      hard_boundary_upgrade_count: hardBoundaryUpgradeCount,
      used_fields: usedFields,
      forbidden_decision_fields: FORBIDDEN_DECISION_FIELDS,
    },
    recorded,
    shadow,
    delta: {
      changed_action_count: changedActionCount,
      would_downgrade_use_now_count: wouldDowngradeUseNowCount,
      direct_use_delta: shadow.direct_use_count - recorded.direct_use_count,
      negative_direct_delta: shadow.negative_direct_count - recorded.negative_direct_count,
      unused_direct_delta: shadow.unused_direct_count - recorded.unused_direct_count,
      missed_positive_delta: shadow.missed_positive_count - recorded.missed_positive_count,
      hard_boundary_direct_delta: shadow.hard_boundary_direct_count - recorded.hard_boundary_direct_count,
    },
    changed_memory_ids_sample: uniqueStrings(changedMemoryIds).slice(0, 32),
    downgraded_memory_ids_sample: uniqueStrings(downgradedMemoryIds).slice(0, 32),
    caveats,
    summary: `Shadow policy ${candidatePolicyId} would change ${changedActionCount}/${rows.length} recorded admission actions, downgrade ${wouldDowngradeUseNowCount} direct-use memories, and preserve ${hardActionsPreserved ? "all" : "not all"} Runtime hard boundaries.`,
  };
}

export function evaluateAdmissionShadowPolicyJsonl(
  input: string,
  options: AionisAdmissionDatasetEvaluatorOptions = {},
): AionisAdmissionShadowPolicyReport {
  return evaluateAdmissionShadowPolicyRows(parseAdmissionDatasetJsonl(input, options));
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function armRow(label: string, metrics: AionisAdmissionShadowPolicyArmMetrics): string {
  return [
    `| ${label}`,
    String(metrics.direct_use_count),
    String(metrics.positive_direct_count),
    String(metrics.negative_direct_count),
    String(metrics.unused_direct_count),
    String(metrics.hard_boundary_direct_count),
    String(metrics.missed_positive_count),
    pct(metrics.direct_use_negative_rate),
    `${pct(metrics.direct_use_positive_precision_proxy)} |`,
  ].join(" | ");
}

export function formatAdmissionShadowPolicyMarkdown(report: AionisAdmissionShadowPolicyReport): string {
  return [
    "# Aionis Admission Shadow Policy Report",
    "",
    report.summary,
    "",
    "## Policy",
    "",
    `- Candidate policy: \`${report.policy.candidate_policy_id}\``,
    `- Runtime mutation: ${report.runtime_mutation}`,
    `- Agent prompt included: ${report.agent_prompt_included}`,
    `- Label leakage guard: ${report.guards.label_leakage_guard}`,
    `- Hard actions preserved: ${report.guards.hard_actions_preserved}`,
    "",
    "## Recorded vs Shadow",
    "",
    "| Arm | Direct use | Positive direct | Negative direct | Unused direct | Hard-boundary direct | Missed positive | Negative direct rate | Positive precision proxy |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    armRow("Recorded", report.recorded),
    armRow("Shadow", report.shadow),
    "",
    "## Delta",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Changed actions | ${report.delta.changed_action_count} |`,
    `| Would downgrade use_now | ${report.delta.would_downgrade_use_now_count} |`,
    `| Direct-use delta | ${report.delta.direct_use_delta} |`,
    `| Negative direct delta | ${report.delta.negative_direct_delta} |`,
    `| Unused direct delta | ${report.delta.unused_direct_delta} |`,
    `| Missed positive delta | ${report.delta.missed_positive_delta} |`,
    `| Hard-boundary direct delta | ${report.delta.hard_boundary_direct_delta} |`,
    "",
    "## Dataset",
    "",
    `- Rows: ${report.dataset.row_count}`,
    `- Task signatures: ${report.dataset.task_signature_count}`,
    `- Runs: ${report.dataset.run_count}`,
    `- Guide traces: ${report.dataset.guide_trace_count}`,
    "",
    "## Guards",
    "",
    `- Used fields: ${report.guards.used_fields.map((field) => `\`${field}\``).join(", ")}`,
    `- Forbidden decision fields: ${report.guards.forbidden_decision_fields.map((field) => `\`${field}\``).join(", ")}`,
    "",
    "## Caveats",
    "",
    ...report.caveats.map((caveat) => `- ${caveat}`),
    "",
  ].join("\n");
}
