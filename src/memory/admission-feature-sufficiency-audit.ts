import { parseAdmissionDatasetJsonl } from "./admission-dataset-evaluator.js";
import type { AionisAdmissionDatasetParsedRow } from "./admission-dataset-holdout.js";
import { classifyLearningTrack } from "./learning-episode-ledger.js";

export type AionisAdmissionFeatureSufficiencySignature = {
  signature: string;
  row_count: number;
  use_now_count: number;
  positive_use_count: number;
  negative_use_count: number;
  unused_exposed_count: number;
  blocked_or_suppressed_count: number;
  rehydrate_requested_count: number;
  outcome_labels: string[];
  sample_memory_ids: string[];
  sample_task_signatures: string[];
  feature_values: Record<string, unknown>;
};

export type AionisAdmissionFeatureSufficiencyAuditReport = {
  contract_version: "aionis_admission_feature_sufficiency_audit_report_v1";
  intended_use: "offline_admission_policy_feature_sufficiency_audit";
  runtime_mutation: false;
  agent_prompt_included: false;
  label_leakage_guard: true;
  dataset: {
    row_count: number;
    use_now_row_count: number;
    prior_state_signal_row_count: number;
    repeated_negative_posture_row_count: number;
    signature_count: number;
    mixed_outcome_signature_count: number;
    positive_negative_collision_signature_count: number;
  };
  audit_scope: {
    row_filter: "use_now_rows";
    signature_features: string[];
    forbidden_or_excluded_features: string[];
  };
  findings: {
    has_positive_negative_collision: boolean;
    negative_direct_risk_is_not_separable_with_current_label_safe_features: boolean;
    direct_negative_reduction_requires_new_prior_state_feature_or_positive_capture_tradeoff: boolean;
  };
  top_collisions: AionisAdmissionFeatureSufficiencySignature[];
  caveats: string[];
  recommendations: string[];
  summary: string;
};

const SIGNATURE_FEATURES = [
  "admission_action",
  "memory_origin",
  "source_backend",
  "domain",
  "memory_type",
  "lifecycle_state",
  "authority",
  "decision_kind",
  "actionable",
  "prompt_included",
  "history_used",
  "actionable_history_used",
  "reason_codes",
  "evidence_count",
  "prior_supported_use_count",
  "prior_contradicted_use_count",
  "prior_rehydrate_requested_count",
  "closed_loop_effect_state",
  "repeated_negative_posture",
] as const;

const FORBIDDEN_OR_EXCLUDED_FEATURES = [
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
  "evidence_ids",
  "prompt_char_count",
  "policy_id",
  "policy_version",
  "policy_mode",
  "runtime_version",
];

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactStrings(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = stringValue(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function featureValues(row: AionisAdmissionDatasetParsedRow): Record<string, unknown> {
  return {
    admission_action: row.admission_action,
    memory_origin: row.memory_origin,
    source_backend: row.source_backend,
    domain: row.domain,
    memory_type: row.memory_type,
    lifecycle_state: row.lifecycle_state,
    authority: row.authority,
    decision_kind: row.decision_kind,
    actionable: row.actionable,
    prompt_included: row.prompt_included,
    history_used: row.history_used,
    actionable_history_used: row.actionable_history_used,
    reason_codes: [...row.reason_codes].sort(),
    evidence_count: row.evidence_ids.length,
    prior_supported_use_count: row.prior_supported_use_count,
    prior_contradicted_use_count: row.prior_contradicted_use_count,
    prior_rehydrate_requested_count: row.prior_rehydrate_requested_count,
    closed_loop_effect_state: row.closed_loop_effect_state,
    repeated_negative_posture: row.repeated_negative_posture,
  };
}

function signatureForRow(row: AionisAdmissionDatasetParsedRow): string {
  return JSON.stringify(featureValues(row));
}

function summarizeSignature(signature: string, rows: AionisAdmissionDatasetParsedRow[]): AionisAdmissionFeatureSufficiencySignature {
  const count = (label: string): number => rows.filter((row) => row.outcome_label === label).length;
  const outcomeLabels = compactStrings(rows.map((row) => row.outcome_label), 16).sort();
  return {
    signature,
    row_count: rows.length,
    use_now_count: rows.filter((row) => row.admission_action === "use_now").length,
    positive_use_count: count("positive_use"),
    negative_use_count: count("negative_use"),
    unused_exposed_count: count("unused_exposed"),
    blocked_or_suppressed_count: count("blocked_or_suppressed"),
    rehydrate_requested_count: count("rehydrate_requested"),
    outcome_labels: outcomeLabels,
    sample_memory_ids: compactStrings(rows.map((row) => row.memory_id), 8),
    sample_task_signatures: compactStrings(rows.map((row) => row.task_signature), 8),
    feature_values: JSON.parse(signature) as Record<string, unknown>,
  };
}

export function auditAdmissionFeatureSufficiencyRows(
  rows: AionisAdmissionDatasetParsedRow[],
): AionisAdmissionFeatureSufficiencyAuditReport {
  const useNowRows = rows.filter((row) => row.admission_action === "use_now");
  const priorStateSignalRows = rows.filter((row) => classifyLearningTrack({
    prior_supported_use_count: row.prior_supported_use_count,
    prior_contradicted_use_count: row.prior_contradicted_use_count,
    prior_rehydrate_requested_count: row.prior_rehydrate_requested_count,
    prior_effect_state: row.closed_loop_effect_state,
    repeated_negative_posture: row.repeated_negative_posture,
  }).track === "exploit");
  const groups = new Map<string, AionisAdmissionDatasetParsedRow[]>();
  for (const row of useNowRows) {
    const signature = signatureForRow(row);
    const current = groups.get(signature) ?? [];
    current.push(row);
    groups.set(signature, current);
  }
  const signatures = [...groups].map(([signature, groupedRows]) => summarizeSignature(signature, groupedRows));
  const mixed = signatures.filter((entry) => entry.outcome_labels.length > 1);
  const positiveNegative = signatures.filter((entry) => entry.positive_use_count > 0 && entry.negative_use_count > 0);
  const topCollisions = [...positiveNegative].sort((a, b) =>
    (b.positive_use_count + b.negative_use_count) - (a.positive_use_count + a.negative_use_count)
    || b.row_count - a.row_count
    || a.signature.localeCompare(b.signature),
  ).slice(0, 10);
  const hasCollision = positiveNegative.length > 0;

  return {
    contract_version: "aionis_admission_feature_sufficiency_audit_report_v1",
    intended_use: "offline_admission_policy_feature_sufficiency_audit",
    runtime_mutation: false,
    agent_prompt_included: false,
    label_leakage_guard: true,
    dataset: {
      row_count: rows.length,
      use_now_row_count: useNowRows.length,
      prior_state_signal_row_count: priorStateSignalRows.length,
      repeated_negative_posture_row_count: rows.filter((row) => row.repeated_negative_posture).length,
      signature_count: signatures.length,
      mixed_outcome_signature_count: mixed.length,
      positive_negative_collision_signature_count: positiveNegative.length,
    },
    audit_scope: {
      row_filter: "use_now_rows",
      signature_features: [...SIGNATURE_FEATURES],
      forbidden_or_excluded_features: [...FORBIDDEN_OR_EXCLUDED_FEATURES],
    },
    findings: {
      has_positive_negative_collision: hasCollision,
      negative_direct_risk_is_not_separable_with_current_label_safe_features: hasCollision,
      direct_negative_reduction_requires_new_prior_state_feature_or_positive_capture_tradeoff: hasCollision,
    },
    top_collisions: topCollisions,
    caveats: [
      "This is an offline feature sufficiency audit over exported admission rows, not a Runtime policy change.",
      "The signature deliberately excludes outcome labels, feedback outcome, attribution strength, prompt text, task names, titles, and raw memory payload.",
      "A positive/negative collision means a label-safe deterministic policy over the current feature set cannot separate those labels without affecting both classes.",
    ],
    recommendations: hasCollision
      ? [
        "Do not add task-name or title based rules to reduce negative_direct_risk; that would overfit the dataset.",
        priorStateSignalRows.length > 0
          ? "Increase closed-loop-prior coverage across fresh task signatures; prior-state signal is present but still too sparse to break the dominant no_prior collision."
          : "Collect a next-decision prior-state feature such as prior_supported_use_count, prior_contradicted_use_count, closed_loop_effect_state, or repeated_negative_posture.",
        "Keep current candidate policies at manual-review/eval level until the added feature is observed on fresh holdout groups.",
      ]
      : [
        "Current label-safe features separate positive and negative direct-use rows in this dataset; candidate-policy search can proceed without adding prior-state features.",
      ],
    summary: hasCollision
      ? `Found ${positiveNegative.length} positive/negative direct-use feature collision signature(s); negative_direct_risk cannot be reduced safely with the current label-safe feature set without a positive-capture tradeoff.`
      : "No positive/negative direct-use feature collisions found under the current label-safe signature.",
  };
}

export function auditAdmissionFeatureSufficiencyJsonl(input: string): AionisAdmissionFeatureSufficiencyAuditReport {
  return auditAdmissionFeatureSufficiencyRows(parseAdmissionDatasetJsonl(input));
}

export function formatAdmissionFeatureSufficiencyAuditMarkdown(
  report: AionisAdmissionFeatureSufficiencyAuditReport,
): string {
  return [
    "# Aionis Admission Feature Sufficiency Audit",
    "",
    report.summary,
    "",
    "## Dataset",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| rows | ${report.dataset.row_count} |`,
    `| use_now rows | ${report.dataset.use_now_row_count} |`,
    `| prior-state signal rows | ${report.dataset.prior_state_signal_row_count} |`,
    `| repeated-negative posture rows | ${report.dataset.repeated_negative_posture_row_count} |`,
    `| label-safe signatures | ${report.dataset.signature_count} |`,
    `| mixed-outcome signatures | ${report.dataset.mixed_outcome_signature_count} |`,
    `| positive/negative collision signatures | ${report.dataset.positive_negative_collision_signature_count} |`,
    "",
    "## Findings",
    "",
    `- Has positive/negative collision: ${report.findings.has_positive_negative_collision ? "yes" : "no"}`,
    `- Negative direct risk separable with current label-safe features: ${report.findings.negative_direct_risk_is_not_separable_with_current_label_safe_features ? "no" : "yes"}`,
    `- Needs new prior-state feature or positive-capture tradeoff: ${report.findings.direct_negative_reduction_requires_new_prior_state_feature_or_positive_capture_tradeoff ? "yes" : "no"}`,
    "",
    "## Top Collisions",
    "",
    "| Rows | Positive | Negative | Unused | Outcomes | Sample task signatures |",
    "|---:|---:|---:|---:|---|---|",
    ...report.top_collisions.map((entry) => [
      `| ${entry.row_count}`,
      String(entry.positive_use_count),
      String(entry.negative_use_count),
      String(entry.unused_exposed_count),
      entry.outcome_labels.map((label) => `\`${label}\``).join(", "),
      `${entry.sample_task_signatures.map((task) => `\`${task}\``).join(", ")} |`,
    ].join(" | ")),
    "",
    "## Signature Features",
    "",
    report.audit_scope.signature_features.map((feature) => `- \`${feature}\``).join("\n"),
    "",
    "## Excluded Fields",
    "",
    report.audit_scope.forbidden_or_excluded_features.map((feature) => `- \`${feature}\``).join("\n"),
    "",
    "## Recommendations",
    "",
    ...report.recommendations.map((entry) => `- ${entry}`),
    "",
    "## Caveats",
    "",
    ...report.caveats.map((entry) => `- ${entry}`),
    "",
  ].join("\n");
}
