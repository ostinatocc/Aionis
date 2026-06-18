import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  auditAdmissionFeatureSufficiencyJsonl,
  formatAdmissionFeatureSufficiencyAuditMarkdown,
} from "../../src/memory/admission-feature-sufficiency-audit.js";

const BASELINE_ROWS = path.resolve("admission-dataset/rows.jsonl");

test("admission feature sufficiency audit detects positive negative direct-use collision in real dataset", () => {
  const report = auditAdmissionFeatureSufficiencyJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"));

  assert.equal(report.contract_version, "aionis_admission_feature_sufficiency_audit_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.label_leakage_guard, true);
  assert.equal(report.dataset.row_count, 411);
  assert.ok(report.dataset.use_now_row_count > 150);
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

  const top = report.top_collisions[0];
  assert.ok(top);
  assert.ok(top.positive_use_count > 0);
  assert.ok(top.negative_use_count > 0);
  assert.equal(top.feature_values.source_backend, "aionis");
  assert.equal(top.feature_values.memory_type, "project_context");
  assert.equal(top.feature_values.lifecycle_state, "active");
  assert.equal(top.feature_values.authority, "advisory");
});

test("admission feature sufficiency audit formats markdown with recommendations", () => {
  const report = auditAdmissionFeatureSufficiencyJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"));
  const markdown = formatAdmissionFeatureSufficiencyAuditMarkdown(report);

  assert.match(markdown, /Aionis Admission Feature Sufficiency Audit/);
  assert.match(markdown, /positive\/negative collision signatures/);
  assert.match(markdown, /Do not add task-name or title based rules/);
  assert.match(markdown, /closed_loop_effect_state/);
});
