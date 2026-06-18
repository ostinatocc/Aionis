import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildAdmissionRealAgentPromptPack,
  buildAdmissionRealAgentRerunReport,
  formatAdmissionRealAgentRerunMarkdown,
  normalizeAdmissionRealAgentDecision,
  parseAdmissionRealAgentDatasetJsonl,
  prepareAdmissionRealAgentGroups,
  scoreAdmissionRealAgentDecision,
} from "../../src/memory/admission-real-agent-rerun.js";

const BASELINE_ROWS = path.resolve("admission-dataset/rows.jsonl");

function baselineRows() {
  return parseAdmissionRealAgentDatasetJsonl(fs.readFileSync(BASELINE_ROWS, "utf8"));
}

function preparedGroups() {
  return prepareAdmissionRealAgentGroups(baselineRows(), {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
}

function positiveUseNowGroup() {
  const prepared = preparedGroups();
  return prepared.groups.find((entry) =>
    entry.rows.some((row) => row.outcome_label === "positive_use" && row.admission_action === "use_now"),
  );
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

test("admission real-agent rerun prompt pack is label-safe over real holdout rows", () => {
  const group = positiveUseNowGroup();
  assert.ok(group);

  const pack = buildAdmissionRealAgentPromptPack({
    arm_id: "recorded_policy_baseline",
    group_id: group.group_id,
    rows: group.rows,
  });
  const serialized = json(pack);

  assert.equal(pack.contract_version, "aionis_admission_real_agent_prompt_pack_v1");
  assert.equal(pack.runtime_mutation, false);
  assert.equal(pack.label_leakage_guard, true);
  assert.ok(pack.memories.use_now.length > 0);
  assert.equal(serialized.includes("outcome_label"), false);
  assert.equal(serialized.includes("feedback_outcome"), false);
  assert.equal(serialized.includes("attribution_strength"), false);
  assert.equal(serialized.includes("agent_used"), false);
  assert.equal(serialized.includes("prompt_char_count"), false);
});

test("admission real-agent scorer accepts direct use of real positive memory", () => {
  const group = positiveUseNowGroup();
  assert.ok(group);
  const positive = group.rows.find((row) => row.outcome_label === "positive_use" && row.admission_action === "use_now");
  assert.ok(positive);

  const trial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: positive.memory_id,
      used_memory_ids: [positive.memory_id],
      rationale: "Use the actionable current project context.",
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  assert.equal(trial.outcome, "accepted_action");
  assert.equal(trial.selected_outcome_label, "positive_use");
  assert.equal(trial.selected_admission_action, "use_now");
});

test("admission real-agent scorer catches non-actionable direct attention from real rows", () => {
  const prepared = preparedGroups();
  const group = prepared.groups.find((entry) => entry.group_id === "admission-dataset-export:targeted-external-current-sdk-contract");
  assert.ok(group);
  const unused = group.rows.find((row) => row.outcome_label === "unused_exposed" && row.admission_action === "use_now");
  assert.ok(unused);

  const trial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: unused.memory_id,
      used_memory_ids: [unused.memory_id],
      rationale: "Use the external current memory.",
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  assert.equal(trial.outcome, "non_actionable_direct_attention");
  assert.equal(trial.selected_outcome_label, "unused_exposed");
});

test("admission real-agent scorer marks direct use of candidate-inspect row as boundary ignored", () => {
  const prepared = preparedGroups();
  const group = prepared.groups.find((entry) => entry.group_id === "admission-dataset-export:targeted-external-current-sdk-contract");
  assert.ok(group);
  const unused = group.rows.find((row) => row.outcome_label === "unused_exposed" && row.admission_action === "use_now");
  assert.ok(unused);

  const trial = scoreAdmissionRealAgentDecision({
    arm_id: prepared.candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: unused.memory_id,
      used_memory_ids: [unused.memory_id],
      rationale: "Use the downgraded external memory directly anyway.",
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  assert.equal(trial.outcome, "boundary_ignored");
  assert.equal(trial.selected_admission_action, "inspect_before_use");
});

test("admission real-agent rerun report formats real-trial summaries without prompt payloads", () => {
  const rows = baselineRows();
  const prepared = prepareAdmissionRealAgentGroups(rows, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
    max_groups: 1,
  });
  const group = prepared.groups[0];
  assert.ok(group);
  const recordedTrial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({ action: "no_action", selected_memory_id: null, used_memory_ids: [] }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  const candidateTrial = scoreAdmissionRealAgentDecision({
    arm_id: prepared.candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({ action: "no_action", selected_memory_id: null, used_memory_ids: [] }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  const report = buildAdmissionRealAgentRerunReport({
    rows,
    options: {
      split_by: "task_signature",
      holdout_ratio: 0.5,
      seed: "aionis-admission-holdout-v1",
      max_groups: 1,
    },
    llm: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      base_url_host: "api.deepseek.com",
    },
    recorded_trials: [recordedTrial],
    candidate_trials: [candidateTrial],
  });
  const markdown = formatAdmissionRealAgentRerunMarkdown(report);

  assert.equal(report.contract_version, "aionis_admission_real_agent_rerun_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.external_model_called, true);
  assert.match(markdown, /Aionis Admission Real Agent Rerun/);
  assert.match(markdown, /real external LLM call/);
  assert.equal(json(report).includes("prompt_pack"), false);
});
