import assert from "node:assert/strict";
import test from "node:test";
import { admissionCandidatePolicyFixtureJsonl } from "./admission-dataset-fixture.ts";
import {
  evaluateAdmissionCandidatePoliciesJsonl,
} from "../../src/memory/admission-candidate-policy-evaluator.js";
import {
  evaluateAdmissionProductionGateJsonl,
  formatAdmissionProductionGateMarkdown,
} from "../../src/memory/admission-production-gate.js";

const FIXTURE_JSONL = admissionCandidatePolicyFixtureJsonl();
const FIXTURE_ROW_COUNT = FIXTURE_JSONL.split(/\r?\n/).filter((line) => line.trim().length > 0).length;

function shadowBatchCollect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    admission_candidate_policy_online_projection: {
      mode: "shadow",
      guide_count: FIXTURE_ROW_COUNT,
      projection_present_count: FIXTURE_ROW_COUNT,
      agent_prompt_included_count: 0,
      runtime_mutation_count: 0,
      hard_boundary_upgrade_count: 0,
      shadow_projection_source_count: 96,
      active_projection_source_count: 0,
      ...overrides,
    },
  };
}

function candidatePolicyReport() {
  return evaluateAdmissionCandidatePoliciesJsonl(FIXTURE_JSONL, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
}

test("admission production gate passes the default-guide shadow expansion gate", () => {
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect(),
    candidate_policy: candidatePolicyReport(),
  });

  assert.equal(report.contract_version, "aionis_admission_production_gate_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.dataset.row_count, FIXTURE_ROW_COUNT);
  assert.equal(report.checks.enough_rows, true);
  assert.equal(report.checks.enough_task_signatures, true);
  assert.equal(report.checks.enough_scopes, true);
  assert.equal(report.checks.input_integrity_pass, true);
  assert.equal(report.checks.shadow_projection_present, true);
  assert.equal(report.checks.shadow_mode, true);
  assert.equal(report.checks.no_prompt_inclusion, true);
  assert.equal(report.checks.no_runtime_mutation, true);
  assert.equal(report.checks.no_hard_boundary_upgrade, true);
  assert.equal(report.checks.candidate_policy_selected, true);
  assert.equal(report.checks.candidate_policy_manual_review_eligible, true);
  assert.equal(report.decision.eligible_for_isolated_active_gray_review, true);
  assert.equal(report.decision.eligible_for_default_active, false);
  assert.deepEqual(report.decision.blocking_reasons, [
    "default_active_still_requires_cross_repository_tool_e2e_gate",
  ]);
  assert.ok(report.input_integrity.trusted_zero_count_fields.some((field) => field.endsWith(".runtime_mutation_count")));
});

test("admission production gate blocks missing required zero-count fields", () => {
  const batch = shadowBatchCollect();
  const projection = batch.admission_candidate_policy_online_projection as Record<string, unknown>;
  delete projection.runtime_mutation_count;
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: batch,
    candidate_policy: candidatePolicyReport(),
  });

  assert.equal(report.checks.input_integrity_pass, false);
  assert.equal(report.checks.no_runtime_mutation, false);
  assert.equal(report.decision.eligible_for_isolated_active_gray_review, false);
  assert.ok(report.input_integrity.missing_required_fields.some((field) => field.endsWith(".runtime_mutation_count")));
  assert.ok(report.decision.blocking_reasons.includes("missing_required_input_fields"));
  assert.ok(report.decision.blocking_reasons.includes("shadow_projection_mutated_runtime"));
});

test("admission production gate blocks invalid required zero-count fields", () => {
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect({
      runtime_mutation_count: -1,
    }),
    candidate_policy: candidatePolicyReport(),
  });

  assert.equal(report.checks.input_integrity_pass, false);
  assert.equal(report.checks.no_runtime_mutation, false);
  assert.equal(report.decision.eligible_for_isolated_active_gray_review, false);
  assert.ok(report.input_integrity.invalid_required_fields.some((field) => field.endsWith(".runtime_mutation_count")));
  assert.ok(report.decision.blocking_reasons.includes("invalid_required_input_fields"));
});

test("admission production gate inherits upstream projection input integrity", () => {
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect({
      input_integrity: {
        missing_required_fields: ["chunks[0].online_projection.runtime_mutation_count"],
        invalid_required_fields: [],
        missing_optional_fields: [],
        trusted_zero_count_fields: [],
      },
    }),
    candidate_policy: candidatePolicyReport(),
  });

  assert.equal(report.checks.input_integrity_pass, false);
  assert.equal(report.checks.no_runtime_mutation, false);
  assert.equal(report.decision.eligible_for_isolated_active_gray_review, false);
  assert.ok(report.input_integrity.missing_required_fields.some((field) =>
    field.endsWith(".runtime_mutation_count")
  ));
  assert.ok(report.decision.blocking_reasons.includes("missing_required_input_fields"));
  assert.ok(report.decision.blocking_reasons.includes("shadow_projection_mutated_runtime"));
});

test("admission production gate blocks missing candidate policy promotion fields", () => {
  const candidatePolicy = candidatePolicyReport() as any;
  delete candidatePolicy.promotion_gate.eligible_for_manual_review;
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect(),
    candidate_policy: candidatePolicy,
  });

  assert.equal(report.checks.input_integrity_pass, false);
  assert.equal(report.checks.candidate_policy_manual_review_eligible, false);
  assert.equal(report.decision.eligible_for_isolated_active_gray_review, false);
  assert.ok(report.input_integrity.missing_required_fields.some((field) =>
    field.endsWith(".eligible_for_manual_review")
  ));
  assert.ok(report.decision.blocking_reasons.includes("missing_required_input_fields"));
  assert.ok(report.decision.blocking_reasons.includes("candidate_policy_not_manual_review_eligible"));
});

test("admission production gate reports missing candidate calibration scores as unknown, not zero", () => {
  const candidatePolicy = candidatePolicyReport() as any;
  delete candidatePolicy.selected_policy.holdout.calibration_score;
  delete candidatePolicy.recorded_policy.holdout.calibration_score;
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect(),
    candidate_policy: candidatePolicy,
  });

  assert.equal(report.checks.input_integrity_pass, true);
  assert.equal(report.candidate_policy.holdout_calibration_score, null);
  assert.equal(report.candidate_policy.recorded_holdout_calibration_score, null);
  assert.ok(report.input_integrity.missing_optional_fields.some((field) =>
    field.endsWith(".selected_policy.holdout.calibration_score")
  ));
  assert.ok(report.input_integrity.missing_optional_fields.some((field) =>
    field.endsWith(".recorded_policy.holdout.calibration_score")
  ));
});

test("admission production gate blocks shadow runs that enter prompt or upgrade boundaries", () => {
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect({
      agent_prompt_included_count: 2,
      hard_boundary_upgrade_count: 1,
    }),
    candidate_policy: candidatePolicyReport(),
  });

  assert.equal(report.decision.eligible_for_isolated_active_gray_review, false);
  assert.ok(report.decision.blocking_reasons.includes("shadow_projection_entered_agent_prompt"));
  assert.ok(report.decision.blocking_reasons.includes("shadow_projection_upgraded_hard_boundary"));
});

test("admission production gate formats markdown", () => {
  const report = evaluateAdmissionProductionGateJsonl(FIXTURE_JSONL, {
    thresholds: {
      min_rows: 400,
      min_task_signatures: 12,
      min_scopes: 12,
      min_projection_present_count: 400,
    },
    batch_collect: shadowBatchCollect(),
    candidate_policy: candidatePolicyReport(),
  });
  const markdown = formatAdmissionProductionGateMarkdown(report);

  assert.match(markdown, /Aionis Admission Production Gate/);
  assert.match(markdown, /Online Shadow Projection/);
  assert.match(markdown, /Candidate Policy/);
  assert.match(markdown, /default_active_still_requires_cross_repository_tool_e2e_gate/);
});
