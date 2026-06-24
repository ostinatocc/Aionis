import assert from "node:assert/strict";
import test from "node:test";
import { admissionCandidatePolicyFixtureJsonl } from "./admission-dataset-fixture.ts";
import {
  auditAdmissionFeatureSufficiencyJsonl,
  formatAdmissionFeatureSufficiencyAuditMarkdown,
} from "../../src/memory/admission-feature-sufficiency-audit.js";

const BASELINE_JSONL = admissionCandidatePolicyFixtureJsonl();

function baselineRowCount(): number {
  return BASELINE_JSONL.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

test("admission feature sufficiency audit detects positive negative direct-use collision in real dataset", () => {
  const report = auditAdmissionFeatureSufficiencyJsonl(BASELINE_JSONL);

  assert.equal(report.contract_version, "aionis_admission_feature_sufficiency_audit_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.label_leakage_guard, true);
  assert.equal(report.dataset.row_count, baselineRowCount());
  assert.ok(report.dataset.use_now_row_count > 150);
  assert.ok(report.dataset.prior_state_signal_row_count >= 3);
  assert.ok(report.dataset.repeated_negative_posture_row_count >= 1);
  assert.ok(report.dataset.positive_negative_collision_signature_count >= 1);
  assert.equal(report.findings.has_positive_negative_collision, true);
  assert.equal(report.findings.negative_direct_risk_is_not_separable_with_current_label_safe_features, true);
  assert.equal(report.findings.direct_negative_reduction_requires_new_prior_state_feature_or_positive_capture_tradeoff, true);
  assert.ok(report.audit_scope.forbidden_or_excluded_features.includes("outcome_label"));
  assert.ok(report.audit_scope.forbidden_or_excluded_features.includes("feedback_outcome"));
  assert.ok(report.audit_scope.forbidden_or_excluded_features.includes("title"));
  assert.ok(report.audit_scope.forbidden_or_excluded_features.includes("task_signature"));
  assert.ok(report.audit_scope.forbidden_or_excluded_features.includes("memory_id"));
  assert.equal(report.audit_scope.signature_features.includes("reason_codes"), true);
  assert.equal(report.audit_scope.signature_features.includes("evidence_count"), true);
  assert.equal(report.audit_scope.signature_features.includes("prior_supported_use_count"), true);
  assert.equal(report.audit_scope.signature_features.includes("prior_contradicted_use_count"), true);
  assert.equal(report.audit_scope.signature_features.includes("prior_rehydrate_requested_count"), true);
  assert.equal(report.audit_scope.signature_features.includes("closed_loop_effect_state"), true);
  assert.equal(report.audit_scope.signature_features.includes("repeated_negative_posture"), true);

  const top = report.top_collisions[0];
  assert.ok(top);
  assert.ok(top.positive_use_count > 0);
  assert.ok(top.negative_use_count > 0);
  assert.equal(top.feature_values.source_backend, "aionis");
  assert.equal(top.feature_values.memory_type, "project_context");
  assert.equal(top.feature_values.lifecycle_state, "active");
  assert.equal(top.feature_values.authority, "advisory");
  assert.equal(top.feature_values.closed_loop_effect_state, "no_prior");
  assert.equal(top.feature_values.repeated_negative_posture, false);
});

test("admission feature sufficiency audit formats markdown with recommendations", () => {
  const report = auditAdmissionFeatureSufficiencyJsonl(BASELINE_JSONL);
  const markdown = formatAdmissionFeatureSufficiencyAuditMarkdown(report);

  assert.match(markdown, /Aionis Admission Feature Sufficiency Audit/);
  assert.match(markdown, /positive\/negative collision signatures/);
  assert.match(markdown, /prior-state signal rows/);
  assert.match(markdown, /Do not add task-name or title based rules/);
  assert.match(markdown, /closed_loop_effect_state/);
});
