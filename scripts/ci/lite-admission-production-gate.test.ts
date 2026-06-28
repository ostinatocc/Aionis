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
