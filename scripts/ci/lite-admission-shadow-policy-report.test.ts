import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAdmissionShadowPolicyJsonl,
  formatAdmissionShadowPolicyMarkdown,
} from "../../src/memory/admission-shadow-policy-report.js";
import type { AionisMemoryAdmissionDatasetRow } from "../../src/sdk.js";

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
    policy_id: "AIONIS_ADMISSION_POLICY_V1",
    policy_version: "2026-06-17",
    policy_mode: "deterministic_admission",
    runtime_version: "test",
    tenant_id: "tenant-local",
    scope: "shadow-report",
    guide_trace_id: `guide:${input.memory_id}`,
    run_id: `run:${input.memory_id}`,
    task_id: `task:${input.memory_id}`,
    task_signature: "admission-shadow-report",
    row_index: 0,
    title: input.title ?? input.memory_id,
    memory_origin: input.memory_origin ?? "aionis",
    source_backend: input.source_backend ?? "aionis",
    domain: input.domain ?? "execution",
    memory_type: input.memory_type ?? "project_context",
    lifecycle_state: input.lifecycle_state ?? "active",
    authority: input.authority ?? "advisory",
    decision_kind: input.decision_kind ?? (input.admission_action === "use_now" ? "used" : "downgraded"),
    actionable: input.admission_action === "use_now",
    prompt_included: true,
    agent_used: input.outcome_label === "positive_use" || input.outcome_label === "negative_use",
    feedback_outcome: input.feedback_outcome ?? (input.outcome_label === "negative_use" ? "negative" : input.outcome_label === "positive_use" ? "positive" : null),
    attribution_strength: input.attribution_strength ?? null,
    reason_codes: input.reason_codes ?? [],
    evidence_ids: input.evidence_ids ?? [],
    prompt_char_count: input.prompt_char_count ?? 100,
    history_used: true,
    actionable_history_used: true,
    prior_supported_use_count: input.prior_supported_use_count ?? 0,
    prior_contradicted_use_count: input.prior_contradicted_use_count ?? 0,
    prior_rehydrate_requested_count: input.prior_rehydrate_requested_count ?? 0,
    closed_loop_effect_state: input.closed_loop_effect_state ?? "no_prior",
    repeated_negative_posture: input.repeated_negative_posture ?? false,
    ...input,
  };
}

function jsonl(rows: AionisMemoryAdmissionDatasetRow[]): string {
  return `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

test("admission shadow policy report compares recorded and candidate shadow actions", () => {
  const report = evaluateAdmissionShadowPolicyJsonl(jsonl([
    row({
      memory_id: "mem-positive-project",
      admission_action: "use_now",
      outcome_label: "positive_use",
      memory_type: "project_context",
    }),
    row({
      memory_id: "mem-negative-prior",
      admission_action: "use_now",
      outcome_label: "negative_use",
      memory_type: "project_context",
      closed_loop_effect_state: "mixed",
      repeated_negative_posture: true,
    }),
    row({
      memory_id: "mem-unused-procedure",
      admission_action: "use_now",
      outcome_label: "unused_exposed",
      memory_type: "procedure",
    }),
    row({
      memory_id: "mem-blocked",
      admission_action: "do_not_use",
      outcome_label: "blocked_or_suppressed",
      lifecycle_state: "suppressed",
      authority: "blocked",
      decision_kind: "blocked",
    }),
  ]));

  assert.equal(report.contract_version, "aionis_admission_shadow_policy_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.guards.label_leakage_guard, true);
  assert.equal(report.guards.hard_actions_preserved, true);
  assert.equal(report.guards.hard_boundary_upgrade_count, 0);
  assert.equal(report.recorded.direct_use_count, 3);
  assert.equal(report.shadow.direct_use_count, 1);
  assert.equal(report.delta.changed_action_count, 2);
  assert.equal(report.delta.would_downgrade_use_now_count, 2);
  assert.equal(report.delta.negative_direct_delta, -1);
  assert.equal(report.delta.unused_direct_delta, -1);
  assert.deepEqual(report.downgraded_memory_ids_sample, ["mem-negative-prior", "mem-unused-procedure"]);
});

test("admission shadow policy report formats markdown", () => {
  const report = evaluateAdmissionShadowPolicyJsonl(jsonl([
    row({
      memory_id: "mem-positive-project",
      admission_action: "use_now",
      outcome_label: "positive_use",
      memory_type: "project_context",
    }),
  ]));
  const markdown = formatAdmissionShadowPolicyMarkdown(report);

  assert.match(markdown, /Aionis Admission Shadow Policy Report/);
  assert.match(markdown, /Recorded vs Shadow/);
  assert.match(markdown, /candidate_project_context_closed_loop_inspect/);
});
