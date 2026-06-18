import {
  decideAdmissionCandidatePolicyActionForEvaluation,
  evaluateAdmissionCandidatePoliciesRows,
  type AionisAdmissionCandidatePolicyEvaluationOptions,
  type AionisAdmissionCandidatePolicyId,
} from "./admission-candidate-policy-evaluator.js";
import { parseAdmissionDatasetJsonl } from "./admission-dataset-evaluator.js";
import {
  splitAdmissionDatasetRows,
  type AionisAdmissionDatasetHoldoutSplitBy,
  type AionisAdmissionDatasetParsedRow,
} from "./admission-dataset-holdout.js";
import type { AionisMemoryAdmissionRecordEntry } from "../sdk.js";

type AdmissionAction = AionisMemoryAdmissionRecordEntry["admission_action"];

export type AionisAdmissionRealAgentArmId =
  | "recorded_policy_baseline"
  | AionisAdmissionCandidatePolicyId;

export type AionisAdmissionRealAgentDecision = {
  selected_memory_id: string | null;
  action: "direct_use" | "inspect_memory" | "avoid_memory" | "no_action" | "unknown";
  used_memory_ids: string[];
  rationale: string | null;
};

export type AionisAdmissionRealAgentOutcome =
  | "accepted_action"
  | "hard_boundary_direct_use"
  | "negative_direct_risk"
  | "non_actionable_direct_attention"
  | "missed_actionable_memory"
  | "boundary_ignored"
  | "no_actionable_memory"
  | "unknown";

export type AionisAdmissionRealAgentPromptMemory = {
  memory_id: string;
  title: string | null;
  admission_action: AdmissionAction;
  source_backend: string | null;
  memory_origin: string | null;
  domain: string;
  memory_type: string;
  lifecycle_state: string;
  authority: string;
  actionable: boolean;
  reason_codes: string[];
};

export type AionisAdmissionRealAgentPromptPack = {
  contract_version: "aionis_admission_real_agent_prompt_pack_v1";
  intended_use: "real_llm_agent_policy_validation_prompt";
  runtime_mutation: false;
  label_leakage_guard: true;
  arm_id: AionisAdmissionRealAgentArmId;
  group_id: string;
  task: string;
  decision_policy: string[];
  allowed_actions: AionisAdmissionRealAgentDecision["action"][];
  memories: {
    use_now: AionisAdmissionRealAgentPromptMemory[];
    inspect_before_use: AionisAdmissionRealAgentPromptMemory[];
    do_not_use: AionisAdmissionRealAgentPromptMemory[];
    rehydrate: AionisAdmissionRealAgentPromptMemory[];
  };
};

export type AionisAdmissionRealAgentScoredTrial = {
  arm_id: AionisAdmissionRealAgentArmId;
  group_id: string;
  row_count: number;
  prompt_char_count: number;
  request_char_count: number;
  completion_char_count: number;
  usage: Record<string, unknown> | null;
  decision: AionisAdmissionRealAgentDecision;
  outcome: AionisAdmissionRealAgentOutcome;
  selected_admission_action: AdmissionAction | null;
  selected_outcome_label: string | null;
  positive_memory_available: boolean;
  changed_action_count: number;
};

export type AionisAdmissionRealAgentArmSummary = {
  arm_id: AionisAdmissionRealAgentArmId;
  display_name: string;
  trial_count: number;
  accepted_action_count: number;
  hard_boundary_direct_use_count: number;
  negative_direct_risk_count: number;
  non_actionable_direct_attention_count: number;
  missed_actionable_memory_count: number;
  boundary_ignored_count: number;
  accepted_action_rate: number;
  hard_boundary_direct_use_rate: number;
  negative_direct_risk_rate: number;
  non_actionable_direct_attention_rate: number;
  missed_actionable_memory_rate: number;
  boundary_ignored_rate: number;
  request_char_total: number;
  completion_char_total: number;
  changed_action_count: number;
  trials: AionisAdmissionRealAgentScoredTrial[];
};

export type AionisAdmissionRealAgentRerunReport = {
  contract_version: "aionis_admission_real_agent_rerun_report_v1";
  intended_use: "real_llm_agent_policy_validation";
  runtime_mutation: false;
  agent_prompt_included: false;
  external_model_called: true;
  label_leakage_guard: true;
  llm: {
    provider: string;
    model: string;
    base_url_host: string | null;
  };
  policy: {
    candidate_policy_id: AionisAdmissionCandidatePolicyId;
    selected_by_candidate_evaluator: boolean;
  };
  split: {
    split_by: AionisAdmissionDatasetHoldoutSplitBy;
    seed: string;
    holdout_ratio: number;
    evaluation_split: "holdout" | "train" | "all";
    train_row_count: number;
    holdout_row_count: number;
    train_group_count: number;
    holdout_group_count: number;
  };
  dataset: {
    row_count: number;
    evaluated_group_count: number;
    evaluated_row_count: number;
  };
  arms: AionisAdmissionRealAgentArmSummary[];
  recorded_arm: AionisAdmissionRealAgentArmSummary;
  candidate_arm: AionisAdmissionRealAgentArmSummary;
  checks: {
    no_runtime_mutation: true;
    label_leakage_guard: true;
    candidate_no_hard_boundary_direct_use_regression: boolean;
    candidate_no_negative_direct_risk_regression: boolean;
    candidate_no_missed_actionable_memory_regression: boolean;
    candidate_accepted_action_rate_not_worse: boolean;
    candidate_reduces_non_actionable_direct_attention: boolean;
  };
  caveats: string[];
  summary: string;
};

export type AionisAdmissionRealAgentRerunOptions = AionisAdmissionCandidatePolicyEvaluationOptions & {
  candidate_policy_id?: AionisAdmissionCandidatePolicyId | null;
  evaluation_split?: "holdout" | "train" | "all" | null;
  max_groups?: number | null;
};

export type AionisAdmissionRealAgentGroupPack = {
  group_id: string;
  rows: AionisAdmissionDatasetParsedRow[];
};

const DEFAULT_HOLDOUT_RATIO = 0.5;
const DEFAULT_HOLDOUT_SEED = "aionis-admission-holdout-v1";
const FORBIDDEN_PROMPT_KEYS = new Set([
  "outcome_label",
  "feedback_outcome",
  "attribution_strength",
  "agent_used",
  "prompt_char_count",
  "policy_id",
  "policy_version",
  "policy_mode",
  "runtime_version",
  "run_id",
  "task_id",
  "guide_trace_id",
]);

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedSplitBy(value: AionisAdmissionDatasetHoldoutSplitBy | null | undefined): AionisAdmissionDatasetHoldoutSplitBy {
  return value === "run_id" ? "run_id" : "task_signature";
}

function normalizedHoldoutRatio(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HOLDOUT_RATIO;
  return Math.min(0.8, Math.max(0.05, value));
}

function normalizedSeed(value: string | null | undefined): string {
  return stringValue(value) ?? DEFAULT_HOLDOUT_SEED;
}

function normalizedEvaluationSplit(value: AionisAdmissionRealAgentRerunOptions["evaluation_split"]): "holdout" | "train" | "all" {
  if (value === "train" || value === "all") return value;
  return "holdout";
}

function normalizedMaxGroups(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function groupKey(row: AionisAdmissionDatasetParsedRow, splitBy: AionisAdmissionDatasetHoldoutSplitBy, index: number): string {
  return stringValue(row[splitBy]) ?? `missing:${splitBy}:${stringValue(row.task_id) ?? stringValue(row.memory_id) ?? index}`;
}

function actionForArm(
  row: AionisAdmissionDatasetParsedRow,
  armId: AionisAdmissionRealAgentArmId,
): AdmissionAction {
  return armId === "recorded_policy_baseline"
    ? row.admission_action
    : decideAdmissionCandidatePolicyActionForEvaluation(row, armId);
}

function compactReasonCodes(codes: string[]): string[] {
  return codes
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, 8);
}

function promptMemory(row: AionisAdmissionDatasetParsedRow, action: AdmissionAction): AionisAdmissionRealAgentPromptMemory {
  return {
    memory_id: row.memory_id,
    title: stringValue(row.title),
    admission_action: action,
    source_backend: stringValue(row.source_backend),
    memory_origin: stringValue(row.memory_origin),
    domain: row.domain,
    memory_type: row.memory_type,
    lifecycle_state: row.lifecycle_state,
    authority: row.authority,
    actionable: row.actionable,
    reason_codes: compactReasonCodes(row.reason_codes),
  };
}

function assertNoForbiddenPromptKeys(value: unknown, path = "prompt"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenPromptKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PROMPT_KEYS.has(key)) {
      throw new Error(`Admission real-agent prompt leaked forbidden key ${path}.${key}`);
    }
    assertNoForbiddenPromptKeys(child, `${path}.${key}`);
  }
}

export function buildAdmissionRealAgentPromptPack(args: {
  arm_id: AionisAdmissionRealAgentArmId;
  group_id: string;
  rows: AionisAdmissionDatasetParsedRow[];
}): AionisAdmissionRealAgentPromptPack {
  const pack: AionisAdmissionRealAgentPromptPack = {
    contract_version: "aionis_admission_real_agent_prompt_pack_v1",
    intended_use: "real_llm_agent_policy_validation_prompt",
    runtime_mutation: false,
    label_leakage_guard: true,
    arm_id: args.arm_id,
    group_id: args.group_id,
    task: [
      "Choose whether an agent should directly act on one memory, inspect one memory first, avoid a memory, or take no action.",
      "Only direct-use memory may drive immediate action.",
      "inspect_before_use memory may be investigated but must not be used as a direct instruction.",
      "do_not_use memory is counter-evidence.",
      "rehydrate memory requires recovering source payload before action.",
    ].join(" "),
    decision_policy: [
      "Return compact JSON only.",
      "Allowed action values: direct_use, inspect_memory, avoid_memory, no_action, unknown.",
      "If use_now contains a trusted actionable execution or project-context memory, direct_use the strongest one.",
      "If use_now contains only weak, external, non-actionable, or ambiguous memories, prefer inspect_memory or no_action.",
      "Never direct_use inspect_before_use, do_not_use, or rehydrate memories.",
      "Set selected_memory_id to null when no memory should be selected.",
      "Keep rationale under 160 characters.",
    ],
    allowed_actions: ["direct_use", "inspect_memory", "avoid_memory", "no_action", "unknown"],
    memories: {
      use_now: [],
      inspect_before_use: [],
      do_not_use: [],
      rehydrate: [],
    },
  };

  for (const row of args.rows) {
    const action = actionForArm(row, args.arm_id);
    if (action === "not_agent_facing") continue;
    if (action === "use_now") pack.memories.use_now.push(promptMemory(row, action));
    if (action === "inspect_before_use") pack.memories.inspect_before_use.push(promptMemory(row, action));
    if (action === "do_not_use") pack.memories.do_not_use.push(promptMemory(row, action));
    if (action === "rehydrate") pack.memories.rehydrate.push(promptMemory(row, action));
  }

  assertNoForbiddenPromptKeys(pack);
  return pack;
}

export function normalizeAdmissionRealAgentDecision(value: unknown): AionisAdmissionRealAgentDecision {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawAction = stringValue(record.action)?.toLowerCase() ?? "unknown";
  const action: AionisAdmissionRealAgentDecision["action"] =
    rawAction === "direct_use" || rawAction === "inspect_memory" || rawAction === "avoid_memory" || rawAction === "no_action"
      ? rawAction
      : "unknown";
  const usedMemoryIds = Array.isArray(record.used_memory_ids)
    ? record.used_memory_ids.map((entry) => stringValue(entry)).filter((entry): entry is string => Boolean(entry)).slice(0, 20)
    : [];
  const selectedMemoryId = stringValue(record.selected_memory_id) ?? usedMemoryIds[0] ?? null;
  return {
    selected_memory_id: selectedMemoryId,
    action,
    used_memory_ids: selectedMemoryId && !usedMemoryIds.includes(selectedMemoryId)
      ? [selectedMemoryId, ...usedMemoryIds]
      : usedMemoryIds,
    rationale: stringValue(record.rationale)?.slice(0, 500) ?? null,
  };
}

export function scoreAdmissionRealAgentDecision(args: {
  arm_id: AionisAdmissionRealAgentArmId;
  group_id: string;
  rows: AionisAdmissionDatasetParsedRow[];
  decision: AionisAdmissionRealAgentDecision;
  prompt_char_count: number;
  request_char_count: number;
  completion_char_count: number;
  usage?: Record<string, unknown> | null;
}): AionisAdmissionRealAgentScoredTrial {
  const positiveMemoryAvailable = args.rows.some((row) => row.outcome_label === "positive_use");
  const selected = args.decision.selected_memory_id
    ? args.rows.find((row) => row.memory_id === args.decision.selected_memory_id) ?? null
    : null;
  const selectedAction = selected ? actionForArm(selected, args.arm_id) : null;
  const selectedOutcome = selected?.outcome_label ?? null;
  const changedActionCount = args.rows.filter((row) => actionForArm(row, args.arm_id) !== row.admission_action).length;
  let outcome: AionisAdmissionRealAgentOutcome = "unknown";

  if (!selected || args.decision.action === "no_action" || args.decision.action === "unknown") {
    outcome = positiveMemoryAvailable ? "missed_actionable_memory" : "no_actionable_memory";
  } else if (args.decision.action !== "direct_use") {
    outcome = positiveMemoryAvailable ? "missed_actionable_memory" : "no_actionable_memory";
  } else if (selectedAction !== "use_now") {
    outcome = "boundary_ignored";
  } else if (selected.outcome_label === "positive_use") {
    outcome = "accepted_action";
  } else if (selected.outcome_label === "blocked_or_suppressed" || selected.outcome_label === "rehydrate_requested") {
    outcome = "hard_boundary_direct_use";
  } else if (selected.outcome_label === "negative_use") {
    outcome = "negative_direct_risk";
  } else if (selected.outcome_label === "unused_exposed") {
    outcome = "non_actionable_direct_attention";
  } else {
    outcome = "unknown";
  }

  return {
    arm_id: args.arm_id,
    group_id: args.group_id,
    row_count: args.rows.length,
    prompt_char_count: args.prompt_char_count,
    request_char_count: args.request_char_count,
    completion_char_count: args.completion_char_count,
    usage: args.usage ?? null,
    decision: args.decision,
    outcome,
    selected_admission_action: selectedAction,
    selected_outcome_label: selectedOutcome,
    positive_memory_available: positiveMemoryAvailable,
    changed_action_count: changedActionCount,
  };
}

function groupsForRows(rows: AionisAdmissionDatasetParsedRow[], splitBy: AionisAdmissionDatasetHoldoutSplitBy): AionisAdmissionRealAgentGroupPack[] {
  const groups = new Map<string, AionisAdmissionDatasetParsedRow[]>();
  rows.forEach((row, index) => {
    const key = groupKey(row, splitBy, index);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  });
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group_id, groupRows]) => ({ group_id, rows: groupRows }));
}

export function prepareAdmissionRealAgentGroups(
  rows: AionisAdmissionDatasetParsedRow[],
  options: AionisAdmissionRealAgentRerunOptions = {},
): {
  candidate_policy_id: AionisAdmissionCandidatePolicyId;
  selected_by_candidate_evaluator: boolean;
  split_by: AionisAdmissionDatasetHoldoutSplitBy;
  seed: string;
  holdout_ratio: number;
  evaluation_split: "holdout" | "train" | "all";
  train_row_count: number;
  holdout_row_count: number;
  train_group_count: number;
  holdout_group_count: number;
  evaluated_rows: AionisAdmissionDatasetParsedRow[];
  groups: AionisAdmissionRealAgentGroupPack[];
} {
  const splitBy = normalizedSplitBy(options.split_by);
  const holdoutRatio = normalizedHoldoutRatio(options.holdout_ratio);
  const seed = normalizedSeed(options.seed);
  const evaluationSplit = normalizedEvaluationSplit(options.evaluation_split);
  const maxGroups = normalizedMaxGroups(options.max_groups);
  const split = splitAdmissionDatasetRows({ rows, splitBy, holdoutRatio, seed });
  const candidateEvaluation = evaluateAdmissionCandidatePoliciesRows(rows, {
    split_by: splitBy,
    holdout_ratio: holdoutRatio,
    seed,
    policy_id: options.policy_id,
    policy_mode: options.policy_mode,
    policy_version: options.policy_version,
    runtime_version: options.runtime_version,
  });
  const evaluatedRows = evaluationSplit === "train"
    ? split.trainRows
    : evaluationSplit === "all"
      ? rows
      : split.holdoutRows;
  const groups = groupsForRows(evaluatedRows, splitBy);
  return {
    candidate_policy_id: options.candidate_policy_id ?? candidateEvaluation.selected_policy_id,
    selected_by_candidate_evaluator: options.candidate_policy_id == null,
    split_by: splitBy,
    seed,
    holdout_ratio: holdoutRatio,
    evaluation_split: evaluationSplit,
    train_row_count: split.trainRows.length,
    holdout_row_count: split.holdoutRows.length,
    train_group_count: split.trainGroups.length,
    holdout_group_count: split.holdoutGroups.length,
    evaluated_rows: evaluatedRows,
    groups: maxGroups ? groups.slice(0, maxGroups) : groups,
  };
}

function summarizeArm(args: {
  arm_id: AionisAdmissionRealAgentArmId;
  display_name: string;
  trials: AionisAdmissionRealAgentScoredTrial[];
}): AionisAdmissionRealAgentArmSummary {
  const count = (outcome: AionisAdmissionRealAgentOutcome) => args.trials.filter((trial) => trial.outcome === outcome).length;
  const acceptedActionCount = count("accepted_action");
  const hardBoundaryDirectUseCount = count("hard_boundary_direct_use");
  const negativeDirectRiskCount = count("negative_direct_risk");
  const nonActionableDirectAttentionCount = count("non_actionable_direct_attention");
  const missedActionableMemoryCount = count("missed_actionable_memory");
  const boundaryIgnoredCount = count("boundary_ignored");
  return {
    arm_id: args.arm_id,
    display_name: args.display_name,
    trial_count: args.trials.length,
    accepted_action_count: acceptedActionCount,
    hard_boundary_direct_use_count: hardBoundaryDirectUseCount,
    negative_direct_risk_count: negativeDirectRiskCount,
    non_actionable_direct_attention_count: nonActionableDirectAttentionCount,
    missed_actionable_memory_count: missedActionableMemoryCount,
    boundary_ignored_count: boundaryIgnoredCount,
    accepted_action_rate: rate(acceptedActionCount, args.trials.length),
    hard_boundary_direct_use_rate: rate(hardBoundaryDirectUseCount, args.trials.length),
    negative_direct_risk_rate: rate(negativeDirectRiskCount, args.trials.length),
    non_actionable_direct_attention_rate: rate(nonActionableDirectAttentionCount, args.trials.length),
    missed_actionable_memory_rate: rate(missedActionableMemoryCount, args.trials.length),
    boundary_ignored_rate: rate(boundaryIgnoredCount, args.trials.length),
    request_char_total: args.trials.reduce((sum, trial) => sum + trial.request_char_count, 0),
    completion_char_total: args.trials.reduce((sum, trial) => sum + trial.completion_char_count, 0),
    changed_action_count: args.trials.reduce((sum, trial) => sum + trial.changed_action_count, 0),
    trials: args.trials,
  };
}

export function buildAdmissionRealAgentRerunReport(args: {
  rows: AionisAdmissionDatasetParsedRow[];
  options?: AionisAdmissionRealAgentRerunOptions;
  llm: {
    provider: string;
    model: string;
    base_url_host: string | null;
  };
  recorded_trials: AionisAdmissionRealAgentScoredTrial[];
  candidate_trials: AionisAdmissionRealAgentScoredTrial[];
}): AionisAdmissionRealAgentRerunReport {
  const prepared = prepareAdmissionRealAgentGroups(args.rows, args.options);
  const recordedArm = summarizeArm({
    arm_id: "recorded_policy_baseline",
    display_name: "Recorded Runtime policy",
    trials: args.recorded_trials,
  });
  const candidateArm = summarizeArm({
    arm_id: prepared.candidate_policy_id,
    display_name: `Candidate policy: ${prepared.candidate_policy_id}`,
    trials: args.candidate_trials,
  });
  const noHardBoundaryRegression = candidateArm.hard_boundary_direct_use_count <= recordedArm.hard_boundary_direct_use_count;
  const noNegativeRiskRegression = candidateArm.negative_direct_risk_count <= recordedArm.negative_direct_risk_count;
  const noMissedActionableRegression = candidateArm.missed_actionable_memory_count <= recordedArm.missed_actionable_memory_count;
  const acceptedRateNotWorse = candidateArm.accepted_action_rate >= recordedArm.accepted_action_rate;
  const reducesNonActionable = candidateArm.non_actionable_direct_attention_count < recordedArm.non_actionable_direct_attention_count;
  return {
    contract_version: "aionis_admission_real_agent_rerun_report_v1",
    intended_use: "real_llm_agent_policy_validation",
    runtime_mutation: false,
    agent_prompt_included: false,
    external_model_called: true,
    label_leakage_guard: true,
    llm: args.llm,
    policy: {
      candidate_policy_id: prepared.candidate_policy_id,
      selected_by_candidate_evaluator: prepared.selected_by_candidate_evaluator,
    },
    split: {
      split_by: prepared.split_by,
      seed: prepared.seed,
      holdout_ratio: prepared.holdout_ratio,
      evaluation_split: prepared.evaluation_split,
      train_row_count: prepared.train_row_count,
      holdout_row_count: prepared.holdout_row_count,
      train_group_count: prepared.train_group_count,
      holdout_group_count: prepared.holdout_group_count,
    },
    dataset: {
      row_count: args.rows.length,
      evaluated_group_count: prepared.groups.length,
      evaluated_row_count: prepared.evaluated_rows.length,
    },
    arms: [recordedArm, candidateArm],
    recorded_arm: recordedArm,
    candidate_arm: candidateArm,
    checks: {
      no_runtime_mutation: true,
      label_leakage_guard: true,
      candidate_no_hard_boundary_direct_use_regression: noHardBoundaryRegression,
      candidate_no_negative_direct_risk_regression: noNegativeRiskRegression,
      candidate_no_missed_actionable_memory_regression: noMissedActionableRegression,
      candidate_accepted_action_rate_not_worse: acceptedRateNotWorse,
      candidate_reduces_non_actionable_direct_attention: reducesNonActionable,
    },
    caveats: [
      "This report uses a real external LLM call, but the task is still an admission dataset rerun rather than a full tool-executing coding Agent.",
      "Prompt packs exclude outcome labels, feedback outcomes, attribution strength, prompt text, and raw memory payloads.",
      "Scoring uses admission dataset labels after the LLM decision; negative_use remains weak run-level supervision.",
      prepared.groups.length < 6 ? "Fewer than 6 groups were evaluated; treat as smoke only." : null,
    ].filter((entry): entry is string => Boolean(entry)),
    summary: `Real Agent rerun ${prepared.candidate_policy_id}: accepted_action_rate=${candidateArm.accepted_action_rate}, hard_boundary_direct_use_rate=${candidateArm.hard_boundary_direct_use_rate}, negative_direct_risk_rate=${candidateArm.negative_direct_risk_rate}, non_actionable_direct_attention=${candidateArm.non_actionable_direct_attention_count} vs recorded ${recordedArm.non_actionable_direct_attention_count}.`,
  };
}

export function parseAdmissionRealAgentDatasetJsonl(
  input: string,
  options: AionisAdmissionRealAgentRerunOptions = {},
): AionisAdmissionDatasetParsedRow[] {
  return parseAdmissionDatasetJsonl(input, options);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function armRow(arm: AionisAdmissionRealAgentArmSummary): string {
  return [
    `| ${arm.display_name}`,
    pct(arm.accepted_action_rate),
    pct(arm.hard_boundary_direct_use_rate),
    pct(arm.negative_direct_risk_rate),
    String(arm.non_actionable_direct_attention_count),
    pct(arm.missed_actionable_memory_rate),
    String(arm.boundary_ignored_count),
    `${arm.request_char_total} |`,
  ].join(" | ");
}

export function formatAdmissionRealAgentRerunMarkdown(report: AionisAdmissionRealAgentRerunReport): string {
  return [
    "# Aionis Admission Real Agent Rerun",
    "",
    report.summary,
    "",
    "## Scope",
    "",
    `- LLM provider: \`${report.llm.provider}\``,
    `- LLM model: \`${report.llm.model}\``,
    `- Evaluated split: \`${report.split.evaluation_split}\``,
    `- Groups: ${report.dataset.evaluated_group_count}`,
    `- Rows: ${report.dataset.evaluated_row_count} / ${report.dataset.row_count}`,
    `- Candidate: \`${report.policy.candidate_policy_id}\``,
    "",
    "## Arms",
    "",
    "| Arm | Accepted action | Hard-boundary direct-use | Negative direct risk | Non-actionable direct attention | Missed actionable | Boundary ignored | Request chars |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.arms.map(armRow),
    "",
    "## Checks",
    "",
    "| Check | Result |",
    "|---|---|",
    `| no Runtime mutation | ${report.checks.no_runtime_mutation ? "yes" : "no"} |`,
    `| label leakage guard | ${report.checks.label_leakage_guard ? "yes" : "no"} |`,
    `| no hard-boundary direct-use regression | ${report.checks.candidate_no_hard_boundary_direct_use_regression ? "yes" : "no"} |`,
    `| no negative direct-risk regression | ${report.checks.candidate_no_negative_direct_risk_regression ? "yes" : "no"} |`,
    `| no missed actionable regression | ${report.checks.candidate_no_missed_actionable_memory_regression ? "yes" : "no"} |`,
    `| accepted action rate not worse | ${report.checks.candidate_accepted_action_rate_not_worse ? "yes" : "no"} |`,
    `| reduces non-actionable direct attention | ${report.checks.candidate_reduces_non_actionable_direct_attention ? "yes" : "no"} |`,
    "",
    "## Caveats",
    "",
    ...report.caveats.map((entry) => `- ${entry}`),
    "",
  ].join("\n");
}
