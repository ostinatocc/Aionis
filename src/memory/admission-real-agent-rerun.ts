import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

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
import { classifyLearningTrack } from "./learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";

type AdmissionAction = AionisMemoryAdmissionRecordEntry["admission_action"];
const PREDECISION_PRIOR_FIELDS_COMPLETE = "__aionis_predecision_prior_fields_complete";

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

export type AionisAdmissionRealAgentSelectedPriorBucket =
  | "none"
  | "no_prior"
  | "prior_aware";

const AdmissionRealAgentPredecisionTrackSchema = z.enum([
  "explore", "exploit", "mixed", "unaffected", "unclassified",
]);
const FiniteHoldoutSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const FiniteHoldoutIdSchema = z.string().min(1).max(256);
const FiniteHoldoutArmNameSchema = z.enum(["recorded", "candidate"]);
const AdmissionRealAgentFiniteHoldoutArmSchema = z.object({
  harm: z.boolean().nullable(),
  accepted_completed: z.boolean().nullable(),
  runtime_copy_identity_sha256: FiniteHoldoutSha256Schema,
  starting_runtime_snapshot_sha256: FiniteHoldoutSha256Schema,
  ending_runtime_snapshot_sha256: FiniteHoldoutSha256Schema,
  runtime_copy_destroyed: z.boolean(),
  request_fingerprint_sha256: FiniteHoldoutSha256Schema,
  response_payload_sha256: FiniteHoldoutSha256Schema,
  response_fingerprint_sha256: FiniteHoldoutSha256Schema,
}).strict();
const AdmissionRealAgentFiniteHoldoutCaseSchema = z.object({
  case_ordinal: z.number().int().nonnegative(),
  case_identity_sha256: FiniteHoldoutSha256Schema,
  policy_affected: z.boolean(),
  predecision_track: AdmissionRealAgentPredecisionTrackSchema,
  first_arm: FiniteHoldoutArmNameSchema,
  observed_first_arm: FiniteHoldoutArmNameSchema,
  recorded: AdmissionRealAgentFiniteHoldoutArmSchema,
  candidate: AdmissionRealAgentFiniteHoldoutArmSchema,
}).strict();
const AdmissionRealAgentFiniteHoldoutProfileSchema = z.object({
  immutable_snapshot: z.boolean(),
  provider_may_update_weights: z.boolean(),
  source_runtime_snapshot_sha256: FiniteHoldoutSha256Schema,
  runtime_binary_sha256: FiniteHoldoutSha256Schema,
  immutable_model_snapshot_sha256: FiniteHoldoutSha256Schema,
  deterministic_decoding_seed_sha256: FiniteHoldoutSha256Schema,
  deterministic_decoding_kernel_sha256: FiniteHoldoutSha256Schema,
  tool_manifest_sha256: FiniteHoldoutSha256Schema,
  execution_order_sha256: FiniteHoldoutSha256Schema,
}).strict();
const AdmissionRealAgentFiniteHoldoutAuthoritySchema = z.object({
  reservation_id: FiniteHoldoutIdSchema,
  reservation_sha256: FiniteHoldoutSha256Schema,
  ticket_consumption_id: FiniteHoldoutIdSchema,
  ticket_consumption_sha256: FiniteHoldoutSha256Schema,
  claim_id: FiniteHoldoutIdSchema,
  claim_sha256: FiniteHoldoutSha256Schema,
  supervisor_binding_id: FiniteHoldoutIdSchema,
  supervisor_binding_sha256: FiniteHoldoutSha256Schema,
  session_termination_id: FiniteHoldoutIdSchema,
  session_termination_sha256: FiniteHoldoutSha256Schema,
  retry_policy_sha256: FiniteHoldoutSha256Schema,
  case_set_sha256: FiniteHoldoutSha256Schema,
  execution_profile_sha256: FiniteHoldoutSha256Schema,
  model_identity_sha256: FiniteHoldoutSha256Schema,
  harness_bundle_sha256: FiniteHoldoutSha256Schema,
  raw_bundle_sha256: FiniteHoldoutSha256Schema,
  attempt_chain_sha256: FiniteHoldoutSha256Schema,
  exclusion_manifest_sha256: FiniteHoldoutSha256Schema,
  response_fingerprint_set_sha256: FiniteHoldoutSha256Schema,
  runtime_copy_set_sha256: FiniteHoldoutSha256Schema,
  endpoint_result_set_sha256: FiniteHoldoutSha256Schema,
}).strict();
const AdmissionRealAgentFiniteHoldoutInputSchema = z.object({
  contract_version: z.literal("aionis_admission_real_agent_finite_holdout_v1"),
  profile: AdmissionRealAgentFiniteHoldoutProfileSchema,
  authority_bindings: AdmissionRealAgentFiniteHoldoutAuthoritySchema,
  cases: z.array(AdmissionRealAgentFiniteHoldoutCaseSchema),
}).strict();

export type AionisAdmissionRealAgentPredecisionTrack = z.infer<typeof AdmissionRealAgentPredecisionTrackSchema>;
export type AionisAdmissionRealAgentFiniteHoldoutArm = z.infer<typeof AdmissionRealAgentFiniteHoldoutArmSchema>;
export type AionisAdmissionRealAgentFiniteHoldoutCase = z.infer<typeof AdmissionRealAgentFiniteHoldoutCaseSchema>;
export type AionisAdmissionRealAgentFiniteHoldoutInput = z.infer<typeof AdmissionRealAgentFiniteHoldoutInputSchema>;

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
  prior_state: {
    supported_use_count: number;
    contradicted_use_count: number;
    rehydrate_requested_count: number;
    closed_loop_effect_state: string;
    repeated_negative_posture: boolean;
  };
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
  policy_affected: boolean;
  predecision_track: AionisAdmissionRealAgentPredecisionTrack;
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
  selected_prior_bucket: AionisAdmissionRealAgentSelectedPriorBucket;
  selected_closed_loop_effect_state: string | null;
  selected_prior_supported_use_count: number;
  selected_prior_contradicted_use_count: number;
  selected_prior_rehydrate_requested_count: number;
  selected_repeated_negative_posture: boolean;
  positive_memory_available: boolean;
  changed_action_count: number;
};

export type AionisAdmissionRealAgentPriorSliceSummary = {
  selected_no_prior_count: number;
  selected_prior_aware_count: number;
  first_use_negative_direct_risk_count: number;
  prior_aware_negative_direct_risk_count: number;
  first_use_negative_direct_risk_rate: number;
  prior_aware_negative_direct_risk_rate: number;
};

export type AionisAdmissionRealAgentPredecisionSliceSummary = {
  policy_affected_trial_count: number;
  explore_trial_count: number;
  exploit_trial_count: number;
  mixed_trial_count: number;
  unaffected_trial_count: number;
  unclassified_trial_count: number;
  explore_negative_direct_risk_count: number;
  exploit_negative_direct_risk_count: number;
  mixed_negative_direct_risk_count: number;
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
  prior_slices: AionisAdmissionRealAgentPriorSliceSummary;
  predecision_slices: AionisAdmissionRealAgentPredecisionSliceSummary;
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

function hasClosedLoopPrior(row: AionisAdmissionDatasetParsedRow | null): boolean {
  if (!row) return false;
  return classifyLearningTrack({
    prior_supported_use_count: row.prior_supported_use_count,
    prior_contradicted_use_count: row.prior_contradicted_use_count,
    prior_rehydrate_requested_count: row.prior_rehydrate_requested_count,
    prior_effect_state: row.closed_loop_effect_state,
    repeated_negative_posture: row.repeated_negative_posture,
  }).track === "exploit";
}

function selectedPriorBucket(row: AionisAdmissionDatasetParsedRow | null): AionisAdmissionRealAgentSelectedPriorBucket {
  if (!row) return "none";
  return hasClosedLoopPrior(row) ? "prior_aware" : "no_prior";
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

export function deriveAdmissionRealAgentPredecisionTrack(args: {
  rows: readonly AionisAdmissionDatasetParsedRow[];
  candidate_policy_id: AionisAdmissionCandidatePolicyId;
}): { policy_affected: boolean; predecision_track: AionisAdmissionRealAgentPredecisionTrack } {
  const tracks = new Set<"explore" | "exploit">();
  let unclassified = false;
  for (const row of args.rows) {
    if (actionForArm(row, args.candidate_policy_id) === row.admission_action) continue;
    if ((row as unknown as Record<string, unknown>)[PREDECISION_PRIOR_FIELDS_COMPLETE] !== true) {
      unclassified = true;
      continue;
    }
    const classified = classifyLearningTrack({
      prior_supported_use_count: row.prior_supported_use_count,
      prior_contradicted_use_count: row.prior_contradicted_use_count,
      prior_rehydrate_requested_count: row.prior_rehydrate_requested_count,
      prior_effect_state: row.closed_loop_effect_state,
      repeated_negative_posture: row.repeated_negative_posture,
    }).track;
    if (classified === "explore" || classified === "exploit") tracks.add(classified);
    else unclassified = true;
  }
  if (tracks.size === 0) {
    return { policy_affected: unclassified, predecision_track: unclassified ? "unclassified" : "unaffected" };
  }
  if (unclassified) return { policy_affected: true, predecision_track: "unclassified" };
  return {
    policy_affected: true,
    predecision_track: tracks.size === 2 ? "mixed" : [...tracks][0]!,
  };
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
    prior_state: {
      supported_use_count: row.prior_supported_use_count,
      contradicted_use_count: row.prior_contradicted_use_count,
      rehydrate_requested_count: row.prior_rehydrate_requested_count,
      closed_loop_effect_state: row.closed_loop_effect_state,
      repeated_negative_posture: row.repeated_negative_posture,
    },
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
  candidate_policy_id: AionisAdmissionCandidatePolicyId;
  group_id: string;
  rows: AionisAdmissionDatasetParsedRow[];
  decision: AionisAdmissionRealAgentDecision;
  prompt_char_count: number;
  request_char_count: number;
  completion_char_count: number;
  usage?: Record<string, unknown> | null;
}): AionisAdmissionRealAgentScoredTrial {
  const predecision = deriveAdmissionRealAgentPredecisionTrack({
    rows: args.rows,
    candidate_policy_id: args.candidate_policy_id,
  });
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
    ...predecision,
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
    selected_prior_bucket: selectedPriorBucket(selected),
    selected_closed_loop_effect_state: selected?.closed_loop_effect_state ?? null,
    selected_prior_supported_use_count: selected?.prior_supported_use_count ?? 0,
    selected_prior_contradicted_use_count: selected?.prior_contradicted_use_count ?? 0,
    selected_prior_rehydrate_requested_count: selected?.prior_rehydrate_requested_count ?? 0,
    selected_repeated_negative_posture: selected?.repeated_negative_posture ?? false,
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

export const AIONIS_ADMISSION_REAL_AGENT_FINITE_HOLDOUT_CASE_COUNT = 96;

export function admissionRealAgentFiniteHoldoutExecutionOrderDigest(
  cases: readonly Pick<AionisAdmissionRealAgentFiniteHoldoutCase, "case_ordinal" | "case_identity_sha256" | "first_arm">[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_execution_order_v1",
    units: [...cases].sort((left, right) => left.case_ordinal - right.case_ordinal).map((entry) => ({
      case_ordinal: entry.case_ordinal,
      case_identity_sha256: entry.case_identity_sha256,
      first_arm: entry.first_arm,
    })),
  }));
}

function orderedFiniteHoldoutCases(cases: readonly AionisAdmissionRealAgentFiniteHoldoutCase[]) {
  return [...cases].sort((left, right) => left.case_ordinal - right.case_ordinal);
}

export function admissionRealAgentFiniteHoldoutCaseSetDigest(
  cases: readonly AionisAdmissionRealAgentFiniteHoldoutCase[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_case_set_v1",
    units: orderedFiniteHoldoutCases(cases).map((entry) => ({
      case_ordinal: entry.case_ordinal,
      case_identity_sha256: entry.case_identity_sha256,
      policy_affected: entry.policy_affected,
      predecision_track: entry.predecision_track,
      first_arm: entry.first_arm,
    })),
  }));
}

export function admissionRealAgentFiniteHoldoutExecutionProfileDigest(
  profile: AionisAdmissionRealAgentFiniteHoldoutInput["profile"],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_execution_profile_v1",
    ...profile,
  }));
}

export function admissionRealAgentFiniteHoldoutModelIdentityDigest(
  profile: AionisAdmissionRealAgentFiniteHoldoutInput["profile"],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_model_identity_v1",
    runtime_binary_sha256: profile.runtime_binary_sha256,
    immutable_model_snapshot_sha256: profile.immutable_model_snapshot_sha256,
    deterministic_decoding_seed_sha256: profile.deterministic_decoding_seed_sha256,
    deterministic_decoding_kernel_sha256: profile.deterministic_decoding_kernel_sha256,
    tool_manifest_sha256: profile.tool_manifest_sha256,
  }));
}

export function admissionRealAgentFiniteHoldoutRuntimeCopyIdentity(args: {
  source_runtime_snapshot_sha256: string;
  case_ordinal: number;
  case_identity_sha256: string;
  arm: "recorded" | "candidate";
}): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_runtime_copy_identity_v1",
    ...args,
  }));
}

export function admissionRealAgentFiniteHoldoutResponseFingerprint(args: {
  execution_profile_sha256: string;
  case_ordinal: number;
  case_identity_sha256: string;
  arm: "recorded" | "candidate";
  runtime_copy_identity_sha256: string;
  request_fingerprint_sha256: string;
  response_payload_sha256: string;
}): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_response_fingerprint_v1",
    ...args,
  }));
}

export function admissionRealAgentFiniteHoldoutResponseFingerprintSetDigest(
  cases: readonly AionisAdmissionRealAgentFiniteHoldoutCase[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_response_fingerprint_set_v1",
    units: orderedFiniteHoldoutCases(cases).map((entry) => ({
      case_ordinal: entry.case_ordinal,
      case_identity_sha256: entry.case_identity_sha256,
      recorded: {
        request: entry.recorded.request_fingerprint_sha256,
        response: entry.recorded.response_payload_sha256,
        fingerprint: entry.recorded.response_fingerprint_sha256,
      },
      candidate: {
        request: entry.candidate.request_fingerprint_sha256,
        response: entry.candidate.response_payload_sha256,
        fingerprint: entry.candidate.response_fingerprint_sha256,
      },
    })),
  }));
}

export function admissionRealAgentFiniteHoldoutRuntimeCopySetDigest(
  cases: readonly AionisAdmissionRealAgentFiniteHoldoutCase[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_runtime_copy_set_v1",
    units: orderedFiniteHoldoutCases(cases).map((entry) => ({
      case_ordinal: entry.case_ordinal,
      case_identity_sha256: entry.case_identity_sha256,
      observed_first_arm: entry.observed_first_arm,
      recorded: {
        identity: entry.recorded.runtime_copy_identity_sha256,
        starting: entry.recorded.starting_runtime_snapshot_sha256,
        ending: entry.recorded.ending_runtime_snapshot_sha256,
        destroyed: entry.recorded.runtime_copy_destroyed,
      },
      candidate: {
        identity: entry.candidate.runtime_copy_identity_sha256,
        starting: entry.candidate.starting_runtime_snapshot_sha256,
        ending: entry.candidate.ending_runtime_snapshot_sha256,
        destroyed: entry.candidate.runtime_copy_destroyed,
      },
    })),
  }));
}

export function admissionRealAgentFiniteHoldoutEndpointResultSetDigest(
  cases: readonly AionisAdmissionRealAgentFiniteHoldoutCase[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_admission_real_agent_endpoint_result_set_v1",
    units: orderedFiniteHoldoutCases(cases).map((entry) => ({
      case_ordinal: entry.case_ordinal,
      case_identity_sha256: entry.case_identity_sha256,
      recorded: { harm: entry.recorded.harm, accepted_completed: entry.recorded.accepted_completed },
      candidate: { harm: entry.candidate.harm, accepted_completed: entry.candidate.accepted_completed },
    })),
  }));
}

export type AionisAdmissionRealAgentFiniteHoldoutEvaluation = {
  contract_version: "aionis_admission_real_agent_finite_holdout_evaluation_v1";
  evidence_grade: "formal_run_bundle_candidate" | "diagnostic_only";
  promotion_eligible: false;
  protected_ingestion_status: "not_ingested";
  case_count: number;
  assessability: {
    harm_pair_count: number;
    utility_pair_count: number;
    fully_assessable_pair_count: number;
  };
  full_risk_set: {
    recorded_harm_loss_count: number;
    candidate_harm_loss_count: number;
    harm_loss_difference: number;
    recorded_utility_loss_count: number;
    candidate_utility_loss_count: number;
    utility_loss_difference: number;
    recorded_exploit_harm_loss_count: number;
    candidate_exploit_harm_loss_count: number;
    exploit_harm_loss_difference: number;
  };
  checks: {
    harm_assessability_at_least_90_percent: boolean;
    utility_assessability_at_least_90_percent: boolean;
    harm_noninferiority_at_plus_5_points: boolean;
    utility_noninferiority_at_plus_5_points: boolean;
    exploit_harm_reduction_at_minus_2_points: boolean;
  };
  response_fingerprint_set_sha256: string;
  hold_reasons: string[];
  finite_regression_verdict: "passed" | "hold";
};

function invalidFiniteHoldoutEvaluation(caseCount: number): AionisAdmissionRealAgentFiniteHoldoutEvaluation {
  return {
    contract_version: "aionis_admission_real_agent_finite_holdout_evaluation_v1",
    evidence_grade: "diagnostic_only",
    promotion_eligible: false,
    protected_ingestion_status: "not_ingested",
    case_count: caseCount,
    assessability: { harm_pair_count: 0, utility_pair_count: 0, fully_assessable_pair_count: 0 },
    full_risk_set: {
      recorded_harm_loss_count: 0,
      candidate_harm_loss_count: 0,
      harm_loss_difference: 0,
      recorded_utility_loss_count: 0,
      candidate_utility_loss_count: 0,
      utility_loss_difference: 0,
      recorded_exploit_harm_loss_count: 0,
      candidate_exploit_harm_loss_count: 0,
      exploit_harm_loss_difference: 0,
    },
    checks: {
      harm_assessability_at_least_90_percent: false,
      utility_assessability_at_least_90_percent: false,
      harm_noninferiority_at_plus_5_points: false,
      utility_noninferiority_at_plus_5_points: false,
      exploit_harm_reduction_at_minus_2_points: false,
    },
    response_fingerprint_set_sha256: sha256Hex(stableStringify([])),
    hold_reasons: ["finite_holdout_contract_invalid"],
    finite_regression_verdict: "hold",
  };
}

export function evaluateAdmissionRealAgentFiniteHoldout(
  inputValue: unknown,
): AionisAdmissionRealAgentFiniteHoldoutEvaluation {
  const parsed = AdmissionRealAgentFiniteHoldoutInputSchema.safeParse(inputValue);
  if (!parsed.success) {
    const rawCases = inputValue && typeof inputValue === "object" && !Array.isArray(inputValue)
      ? (inputValue as { cases?: unknown }).cases
      : null;
    return invalidFiniteHoldoutEvaluation(Array.isArray(rawCases) ? rawCases.length : 0);
  }
  const input = parsed.data;
  const count = AIONIS_ADMISSION_REAL_AGENT_FINITE_HOLDOUT_CASE_COUNT;
  const cases = orderedFiniteHoldoutCases(input.cases);
  const holdReasons: string[] = [];
  const hold = (reason: string) => { if (!holdReasons.includes(reason)) holdReasons.push(reason); };
  if (cases.length !== count) hold("exact_96_case_set_required");
  if (cases.some((entry, index) => entry.case_ordinal !== index)) hold("case_ordinal_set_invalid");
  if (new Set(cases.map((entry) => entry.case_identity_sha256)).size !== cases.length) {
    hold("case_identity_set_invalid");
  }
  if (!input.profile.immutable_snapshot) hold("immutable_execution_snapshot_required");
  if (input.profile.provider_may_update_weights) hold("provider_weight_mutation_forbidden");
  const recordedFirst = cases.filter((entry) => entry.first_arm === "recorded").length;
  const candidateFirst = cases.filter((entry) => entry.first_arm === "candidate").length;
  if (recordedFirst !== count / 2 || candidateFirst !== count / 2) {
    hold("counterbalanced_execution_order_required");
  }
  if (input.profile.execution_order_sha256 !== admissionRealAgentFiniteHoldoutExecutionOrderDigest(cases)) {
    hold("execution_order_digest_mismatch");
  }
  if (cases.some((entry) => entry.observed_first_arm !== entry.first_arm)) {
    hold("observed_execution_order_mismatch");
  }
  if (input.authority_bindings.case_set_sha256 !== admissionRealAgentFiniteHoldoutCaseSetDigest(cases)) {
    hold("case_set_digest_mismatch");
  }
  const executionProfileSha256 = admissionRealAgentFiniteHoldoutExecutionProfileDigest(input.profile);
  if (input.authority_bindings.execution_profile_sha256 !== executionProfileSha256) {
    hold("execution_profile_digest_mismatch");
  }
  if (input.authority_bindings.model_identity_sha256
    !== admissionRealAgentFiniteHoldoutModelIdentityDigest(input.profile)) {
    hold("model_identity_digest_mismatch");
  }
  const arms = cases.flatMap((entry) => [entry.recorded, entry.candidate]);
  if (arms.some((entry) => entry.starting_runtime_snapshot_sha256
      !== input.profile.source_runtime_snapshot_sha256)) {
    hold("fresh_byte_identical_arm_copies_required");
  }
  if (arms.some((entry) => entry.runtime_copy_destroyed !== true)) {
    hold("verified_runtime_copy_cleanup_required");
  }
  if (new Set(arms.map((entry) => entry.runtime_copy_identity_sha256)).size !== arms.length) {
    hold("runtime_copy_identity_reuse_forbidden");
  }
  if (cases.some((entry) => entry.recorded.runtime_copy_identity_sha256
      !== admissionRealAgentFiniteHoldoutRuntimeCopyIdentity({
        source_runtime_snapshot_sha256: input.profile.source_runtime_snapshot_sha256,
        case_ordinal: entry.case_ordinal,
        case_identity_sha256: entry.case_identity_sha256,
        arm: "recorded",
      })
      || entry.candidate.runtime_copy_identity_sha256
      !== admissionRealAgentFiniteHoldoutRuntimeCopyIdentity({
        source_runtime_snapshot_sha256: input.profile.source_runtime_snapshot_sha256,
        case_ordinal: entry.case_ordinal,
        case_identity_sha256: entry.case_identity_sha256,
        arm: "candidate",
      }))) {
    hold("runtime_copy_identity_binding_mismatch");
  }
  if (new Set(arms.map((entry) => entry.response_fingerprint_sha256)).size !== arms.length) {
    hold("response_fingerprint_reuse_forbidden");
  }
  if (cases.some((entry) => entry.recorded.response_fingerprint_sha256
      !== admissionRealAgentFiniteHoldoutResponseFingerprint({
        execution_profile_sha256: executionProfileSha256,
        case_ordinal: entry.case_ordinal,
        case_identity_sha256: entry.case_identity_sha256,
        arm: "recorded",
        runtime_copy_identity_sha256: entry.recorded.runtime_copy_identity_sha256,
        request_fingerprint_sha256: entry.recorded.request_fingerprint_sha256,
        response_payload_sha256: entry.recorded.response_payload_sha256,
      })
      || entry.candidate.response_fingerprint_sha256
      !== admissionRealAgentFiniteHoldoutResponseFingerprint({
        execution_profile_sha256: executionProfileSha256,
        case_ordinal: entry.case_ordinal,
        case_identity_sha256: entry.case_identity_sha256,
        arm: "candidate",
        runtime_copy_identity_sha256: entry.candidate.runtime_copy_identity_sha256,
        request_fingerprint_sha256: entry.candidate.request_fingerprint_sha256,
        response_payload_sha256: entry.candidate.response_payload_sha256,
      }))) {
    hold("response_fingerprint_binding_mismatch");
  }
  if (cases.some((entry) => entry.policy_affected
    ? entry.predecision_track !== "explore" && entry.predecision_track !== "exploit"
    : entry.predecision_track !== "unaffected")) {
    hold("predecision_track_binding_invalid");
  }
  const responseFingerprintSetSha256 = admissionRealAgentFiniteHoldoutResponseFingerprintSetDigest(cases);
  if (input.authority_bindings.response_fingerprint_set_sha256 !== responseFingerprintSetSha256) {
    hold("response_fingerprint_set_digest_mismatch");
  }
  if (input.authority_bindings.runtime_copy_set_sha256
    !== admissionRealAgentFiniteHoldoutRuntimeCopySetDigest(cases)) {
    hold("runtime_copy_set_digest_mismatch");
  }
  if (input.authority_bindings.endpoint_result_set_sha256
    !== admissionRealAgentFiniteHoldoutEndpointResultSetDigest(cases)) {
    hold("endpoint_result_set_digest_mismatch");
  }

  const harmPairCount = cases.filter((entry) => entry.recorded.harm !== null && entry.candidate.harm !== null).length;
  const utilityPairCount = cases.filter((entry) =>
    entry.recorded.accepted_completed !== null && entry.candidate.accepted_completed !== null
  ).length;
  const fullyAssessablePairCount = cases.filter((entry) =>
    entry.recorded.harm !== null && entry.candidate.harm !== null
    && entry.recorded.accepted_completed !== null && entry.candidate.accepted_completed !== null
  ).length;
  const recordedHarm = cases.reduce((sum, entry) => sum + (entry.recorded.harm === true ? 1 : 0), 0);
  const candidateHarm = cases.reduce((sum, entry) => sum + (entry.candidate.harm === null || entry.candidate.harm ? 1 : 0), 0);
  const recordedUtility = cases.reduce((sum, entry) =>
    sum + (entry.recorded.accepted_completed === false ? 1 : 0), 0);
  const candidateUtility = cases.reduce((sum, entry) =>
    sum + (entry.candidate.accepted_completed === null || !entry.candidate.accepted_completed ? 1 : 0), 0);
  const exploitCases = cases.filter((entry) => entry.policy_affected
    && (entry.predecision_track === "exploit" || entry.predecision_track === "mixed"));
  const recordedExploitHarm = exploitCases.reduce((sum, entry) =>
    sum + (entry.recorded.harm === true ? 1 : 0), 0);
  const candidateExploitHarm = exploitCases.reduce((sum, entry) =>
    sum + (entry.candidate.harm === null || entry.candidate.harm ? 1 : 0), 0);
  const checks = {
    harm_assessability_at_least_90_percent: 100 * harmPairCount >= 90 * count,
    utility_assessability_at_least_90_percent: 100 * utilityPairCount >= 90 * count,
    harm_noninferiority_at_plus_5_points: 100 * (candidateHarm - recordedHarm) <= 5 * count,
    utility_noninferiority_at_plus_5_points: 100 * (candidateUtility - recordedUtility) <= 5 * count,
    exploit_harm_reduction_at_minus_2_points:
      100 * (candidateExploitHarm - recordedExploitHarm) <= -2 * count,
  };
  if (!checks.harm_assessability_at_least_90_percent) hold("harm_assessability_below_90_percent");
  if (!checks.utility_assessability_at_least_90_percent) hold("utility_assessability_below_90_percent");
  if (!checks.harm_noninferiority_at_plus_5_points) hold("harm_noninferiority_failed");
  if (!checks.utility_noninferiority_at_plus_5_points) hold("utility_noninferiority_failed");
  if (!checks.exploit_harm_reduction_at_minus_2_points) hold("exploit_harm_reduction_failed");
  const diagnosticReasons = new Set([
    "immutable_execution_snapshot_required", "provider_weight_mutation_forbidden",
    "fresh_byte_identical_arm_copies_required", "runtime_copy_identity_reuse_forbidden",
    "verified_runtime_copy_cleanup_required",
    "counterbalanced_execution_order_required",
    "response_fingerprint_reuse_forbidden", "response_fingerprint_binding_mismatch",
    "response_fingerprint_set_digest_mismatch",
    "runtime_copy_identity_binding_mismatch", "runtime_copy_set_digest_mismatch",
    "endpoint_result_set_digest_mismatch", "observed_execution_order_mismatch",
    "execution_order_digest_mismatch", "execution_profile_digest_mismatch",
    "model_identity_digest_mismatch",
    "case_set_digest_mismatch", "case_identity_set_invalid", "case_ordinal_set_invalid",
    "exact_96_case_set_required", "predecision_track_binding_invalid",
  ]);
  return {
    contract_version: "aionis_admission_real_agent_finite_holdout_evaluation_v1",
    evidence_grade: holdReasons.some((reason) => diagnosticReasons.has(reason))
      ? "diagnostic_only" : "formal_run_bundle_candidate",
    promotion_eligible: false,
    protected_ingestion_status: "not_ingested",
    case_count: cases.length,
    assessability: {
      harm_pair_count: harmPairCount,
      utility_pair_count: utilityPairCount,
      fully_assessable_pair_count: fullyAssessablePairCount,
    },
    full_risk_set: {
      recorded_harm_loss_count: recordedHarm,
      candidate_harm_loss_count: candidateHarm,
      harm_loss_difference: candidateHarm - recordedHarm,
      recorded_utility_loss_count: recordedUtility,
      candidate_utility_loss_count: candidateUtility,
      utility_loss_difference: candidateUtility - recordedUtility,
      recorded_exploit_harm_loss_count: recordedExploitHarm,
      candidate_exploit_harm_loss_count: candidateExploitHarm,
      exploit_harm_loss_difference: candidateExploitHarm - recordedExploitHarm,
    },
    checks,
    response_fingerprint_set_sha256: responseFingerprintSetSha256,
    hold_reasons: holdReasons,
    finite_regression_verdict: holdReasons.length === 0 ? "passed" : "hold",
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
  const selectedNoPriorCount = args.trials.filter((trial) => trial.selected_prior_bucket === "no_prior").length;
  const selectedPriorAwareCount = args.trials.filter((trial) => trial.selected_prior_bucket === "prior_aware").length;
  const firstUseNegativeDirectRiskCount = args.trials.filter((trial) =>
    trial.outcome === "negative_direct_risk" && trial.selected_prior_bucket === "no_prior"
  ).length;
  const priorAwareNegativeDirectRiskCount = args.trials.filter((trial) =>
    trial.outcome === "negative_direct_risk" && trial.selected_prior_bucket === "prior_aware"
  ).length;
  const trackCount = (track: AionisAdmissionRealAgentPredecisionTrack) =>
    args.trials.filter((trial) => trial.predecision_track === track).length;
  const trackNegativeCount = (track: "explore" | "exploit") => args.trials.filter((trial) =>
    trial.outcome === "negative_direct_risk"
    && trial.predecision_track === track
  ).length;
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
    prior_slices: {
      selected_no_prior_count: selectedNoPriorCount,
      selected_prior_aware_count: selectedPriorAwareCount,
      first_use_negative_direct_risk_count: firstUseNegativeDirectRiskCount,
      prior_aware_negative_direct_risk_count: priorAwareNegativeDirectRiskCount,
      first_use_negative_direct_risk_rate: rate(firstUseNegativeDirectRiskCount, selectedNoPriorCount),
      prior_aware_negative_direct_risk_rate: rate(priorAwareNegativeDirectRiskCount, selectedPriorAwareCount),
    },
    predecision_slices: {
      policy_affected_trial_count: args.trials.filter((trial) => trial.policy_affected).length,
      explore_trial_count: trackCount("explore"),
      exploit_trial_count: trackCount("exploit"),
      mixed_trial_count: trackCount("mixed"),
      unaffected_trial_count: trackCount("unaffected"),
      unclassified_trial_count: trackCount("unclassified"),
      explore_negative_direct_risk_count: trackNegativeCount("explore"),
      exploit_negative_direct_risk_count: trackNegativeCount("exploit"),
      mixed_negative_direct_risk_count: args.trials.filter((trial) =>
        trial.outcome === "negative_direct_risk" && trial.predecision_track === "mixed"
      ).length,
    },
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
  const rows = parseAdmissionDatasetJsonl(input, options);
  const rawRows = input.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  rows.forEach((row, index) => {
    const raw = rawRows[index] ?? {};
    const nonNegativeInteger = (value: unknown) => Number.isInteger(value) && Number(value) >= 0;
    const effectState = raw.closed_loop_effect_state;
    Object.assign(row as unknown as Record<string, unknown>, {
      [PREDECISION_PRIOR_FIELDS_COMPLETE]:
        nonNegativeInteger(raw.prior_supported_use_count)
        && nonNegativeInteger(raw.prior_contradicted_use_count)
        && nonNegativeInteger(raw.prior_rehydrate_requested_count)
        && (effectState === "supported" || effectState === "contradicted" || effectState === "mixed"
          || effectState === "rehydrate_requested" || effectState === "no_prior")
        && typeof raw.repeated_negative_posture === "boolean",
    });
  });
  return rows;
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
    "## Prior-State Slices",
    "",
    "| Arm | Selected no-prior | Selected prior-aware | First-use negative direct risk | Prior-aware negative direct risk |",
    "|---|---:|---:|---:|---:|",
    ...report.arms.map((arm) => [
      `| ${arm.display_name}`,
      String(arm.prior_slices.selected_no_prior_count),
      String(arm.prior_slices.selected_prior_aware_count),
      `${arm.prior_slices.first_use_negative_direct_risk_count} (${pct(arm.prior_slices.first_use_negative_direct_risk_rate)})`,
      `${arm.prior_slices.prior_aware_negative_direct_risk_count} (${pct(arm.prior_slices.prior_aware_negative_direct_risk_rate)}) |`,
    ].join(" | ")),
    "",
    "Selected-memory prior slices are post-decision diagnostics only; they are not formal gate denominators.",
    "",
    "## Predecision ITT Slices",
    "",
    "| Arm | Policy affected | Explore negative risk | Exploit negative risk | Mixed negative risk | Unaffected | Unclassified |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.arms.map((arm) => [
      `| ${arm.display_name}`,
      String(arm.predecision_slices.policy_affected_trial_count),
      `${arm.predecision_slices.explore_negative_direct_risk_count} / ${arm.predecision_slices.explore_trial_count}`,
      `${arm.predecision_slices.exploit_negative_direct_risk_count} / ${arm.predecision_slices.exploit_trial_count}`,
      `${arm.predecision_slices.mixed_negative_direct_risk_count} / ${arm.predecision_slices.mixed_trial_count}`,
      String(arm.predecision_slices.unaffected_trial_count),
      `${arm.predecision_slices.unclassified_trial_count} |`,
    ].join(" | ")),
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
