import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { admissionDatasetTargetedExternalCurrentSpecs } from "../e2e/admission-dataset-export-loop.ts";
import { evaluateAdmissionCandidatePoliciesRows } from "../../src/memory/admission-candidate-policy-evaluator.js";
import { parseAdmissionDatasetJsonl } from "../../src/memory/admission-dataset-evaluator.js";
import { splitAdmissionDatasetRows } from "../../src/memory/admission-dataset-holdout.js";

const BASELINE_ROWS = path.resolve("admission-dataset/rows.jsonl");

test("targeted external-current profile adds train-side support for candidate policy evaluation", () => {
  const baselineRows = parseAdmissionDatasetJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"));
  const externalTemplate = baselineRows.find((row) =>
    row.memory_origin === "external"
    && row.admission_action === "use_now"
    && row.outcome_label === "unused_exposed"
  );
  assert.ok(externalTemplate, "baseline dataset should contain an external current template row");

  const specs = admissionDatasetTargetedExternalCurrentSpecs({
    runId: "targeted-profile-test",
    baseScope: "admission-dataset:targeted-profile-test",
  });
  assert.ok(specs.length >= 10);

  const targetedRows = specs.map((spec, index) => ({
    ...externalTemplate,
    run_id: `run:targeted-profile-test:${spec.round_id}`,
    task_id: `task:targeted-profile-test:${spec.round_id}`,
    task_signature: `admission-dataset-export:${spec.round_id}`,
    row_index: index,
    memory_id: spec.current_id,
    title: `Targeted current route ${spec.round_id}`,
    scope: spec.scope,
    source_backend: "mem0",
    memory_origin: "external" as const,
    admission_action: "use_now" as const,
    outcome_label: "unused_exposed" as const,
    prompt_included: true,
    agent_used: false,
  }));
  const rows = [...baselineRows, ...targetedRows];
  const split = splitAdmissionDatasetRows({
    rows,
    splitBy: "task_signature",
    holdoutRatio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
  const targetedTrainGroups = split.trainGroups.filter((group) =>
    group.startsWith("admission-dataset-export:targeted-external-current-")
  );
  assert.ok(targetedTrainGroups.length > 0, "targeted profile must put candidate-changing groups into train");

  const report = evaluateAdmissionCandidatePoliciesRows(rows, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
  assert.equal(report.promotion_gate.train_candidate_supported, true);
  assert.ok(report.selected_policy.train.changed_action_count > 0);
});
