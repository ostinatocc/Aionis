import assert from "node:assert/strict";
import test from "node:test";
import {
  AIONIS_ADMISSION_POLICY_ID,
  type AionisMemoryAdmissionDatasetRow,
} from "../../src/sdk.js";
import {
  evaluateAdmissionDatasetJsonl,
  evaluateAdmissionDatasetRows,
  formatAdmissionDatasetEvaluationMarkdown,
  parseAdmissionDatasetJsonl,
} from "../../src/memory/admission-dataset-evaluator.js";

function row(input: Partial<AionisMemoryAdmissionDatasetRow> & {
  memory_id: string;
  admission_action: AionisMemoryAdmissionDatasetRow["admission_action"];
  outcome_label: AionisMemoryAdmissionDatasetRow["outcome_label"];
}): AionisMemoryAdmissionDatasetRow {
  return {
    contract_version: "aionis_memory_admission_dataset_row_v1",
    intended_use: "memory_admission_policy_training_or_audit",
    source: "memory_admission_record",
    agent_prompt_included: false,
    runtime_mutation: false,
    policy_id: AIONIS_ADMISSION_POLICY_ID,
    policy_version: "2026-06-17",
    policy_mode: "deterministic_admission",
    runtime_version: "0.1.0-test",
    tenant_id: "default",
    scope: "admission-evaluator-test",
    guide_trace_id: "guide-test",
    run_id: "run-test",
    task_id: "task-test",
    task_signature: "admission-evaluator",
    row_index: 0,
    title: null,
    memory_origin: "aionis",
    source_backend: "aionis",
    domain: "execution",
    memory_type: "execution_memory",
    lifecycle_state: "active",
    authority: "trusted",
    decision_kind: input.admission_action === "use_now"
      ? "used"
      : input.admission_action === "do_not_use"
        ? "blocked"
        : input.admission_action === "rehydrate"
          ? "rehydrate"
          : "downgraded",
    actionable: input.admission_action === "use_now",
    prompt_included: true,
    agent_used: input.outcome_label === "positive_use" || input.outcome_label === "negative_use",
    feedback_outcome: input.outcome_label === "positive_use"
      ? "positive"
      : input.outcome_label === "negative_use"
        ? "negative"
        : null,
    attribution_strength: null,
    reason_codes: [],
    evidence_ids: [],
    prompt_char_count: 1200,
    history_used: true,
    actionable_history_used: input.admission_action === "use_now",
    ...input,
  };
}

test("admission dataset evaluator computes policy and admission bucket metrics", () => {
  const rows = [
    row({ memory_id: "mem-positive", admission_action: "use_now", outcome_label: "positive_use" }),
    row({ memory_id: "mem-negative", admission_action: "use_now", outcome_label: "negative_use" }),
    row({ memory_id: "mem-unused", admission_action: "inspect_before_use", outcome_label: "unused_exposed", authority: "advisory" }),
    row({ memory_id: "mem-blocked", admission_action: "do_not_use", outcome_label: "blocked_or_suppressed", authority: "blocked", lifecycle_state: "suppressed" }),
    row({ memory_id: "mem-rehydrate", admission_action: "rehydrate", outcome_label: "rehydrate_requested", lifecycle_state: "rehydration_candidate" }),
  ];
  const report = evaluateAdmissionDatasetRows(rows);
  assert.equal(report.contract_version, "aionis_admission_dataset_evaluation_report_v1");
  assert.equal(report.dataset.row_count, 5);
  assert.equal(report.sample_quality.minimum_rows_for_policy_claim, 100);
  assert.equal(report.sample_quality.not_enough_rows_for_policy_claim, true);
  assert.equal(report.sample_quality.minimum_task_signatures_for_diversity_claim, 6);
  assert.equal(report.sample_quality.not_enough_task_signatures_for_diversity_claim, true);
  assert.equal(report.policy.policy_id, AIONIS_ADMISSION_POLICY_ID);
  assert.equal(report.policy.row_policy_metadata_coverage, 1);
  assert.equal(report.dataset.task_signature_count, 1);
  assert.equal(report.metrics.use_now_count, 2);
  assert.equal(report.metrics.use_now_positive_rate, 0.5);
  assert.equal(report.metrics.use_now_negative_rate, 0.5);
  assert.equal(report.metrics.blocked_or_suppressed_count, 1);
  assert.equal(report.metrics.rehydrate_requested_count, 1);
  assert.ok(report.risk_flags.includes("use_now_negative_use_present"));
  assert.ok(report.risk_flags.includes("not_enough_rows_for_policy_claim"));
  assert.ok(report.risk_flags.includes("not_enough_task_signatures_for_diversity_claim"));
  assert.ok(report.recommendations.includes("inspect_negative_use_rows_before_policy_change"));
  assert.ok(report.recommendations.includes("collect_at_least_6_task_signatures_before_claiming_policy_diversity"));
  assert.ok(report.buckets.some((bucket) => bucket.dimension === "admission_action" && bucket.key === "use_now" && bucket.row_count === 2));
  assert.ok(report.buckets.some((bucket) => bucket.dimension === "task_signature" && bucket.key === "admission-evaluator" && bucket.row_count === 5));
});

test("admission dataset evaluator reads JSONL and backfills missing policy metadata", () => {
  const base = row({ memory_id: "mem-old", admission_action: "use_now", outcome_label: "positive_use" });
  const legacyRow = { ...base };
  delete (legacyRow as Partial<AionisMemoryAdmissionDatasetRow>).policy_id;
  delete (legacyRow as Partial<AionisMemoryAdmissionDatasetRow>).policy_version;
  delete (legacyRow as Partial<AionisMemoryAdmissionDatasetRow>).policy_mode;
  const jsonl = `${JSON.stringify(legacyRow)}\n`;
  const rows = parseAdmissionDatasetJsonl(jsonl, {
    policy_id: "CUSTOM_POLICY",
    policy_version: "v-test",
    policy_mode: "shadow",
  });
  assert.equal(rows[0]?.policy_id, "CUSTOM_POLICY");
  const report = evaluateAdmissionDatasetJsonl(jsonl, {
    policy_id: "CUSTOM_POLICY",
    policy_version: "v-test",
    policy_mode: "shadow",
  });
  assert.equal(report.policy.row_policy_metadata_coverage, 0);
  assert.ok(report.risk_flags.includes("policy_metadata_incomplete"));
});

test("admission dataset evaluator formats markdown report", () => {
  const report = evaluateAdmissionDatasetRows([
    row({ memory_id: "mem-positive", admission_action: "use_now", outcome_label: "positive_use" }),
    row({ memory_id: "mem-blocked", admission_action: "do_not_use", outcome_label: "blocked_or_suppressed" }),
  ]);
  const markdown = formatAdmissionDatasetEvaluationMarkdown(report);
  assert.match(markdown, /Aionis Admission Dataset Evaluation/);
  assert.match(markdown, /use_now positive rate/);
  assert.match(markdown, /enough rows for policy claim/);
  assert.match(markdown, /enough task signatures for diversity claim/);
  assert.match(markdown, /collect_at_least_100_rows_before_claiming_policy_quality/);
});
