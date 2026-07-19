import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { LearningExternalCanonicalUtcMillisSchema } from
  "../../../../src/memory/learning-external-authority.js";
import { resolveLearningGatePolicy } from
  "../../../../src/memory/learning-gate-policy.js";

const MAX_REPORT_BYTES = 512 * 1024;
const MAX_AUTHORITY_PROJECTION_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPT_CHAIN_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUN_BUNDLE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_MEMBERS = 4_096;
const MAX_BUNDLE_MEMBER_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ATTEMPTS = 10_000;

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const BoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});
const SourceRefSchema = z.string().superRefine((value, context) => {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > 2_048) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an immutable source reference bounded to 2048 UTF-8 bytes",
    });
  }
});
const SourceCommitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const LearningExternalEvidenceArtifactKindSchema = z.enum([
  "offline_paired_rerun",
  "production_shadow_gate",
  "tool_e2e_gate",
]);

export const LearningExternalEvidenceStatusSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
]);

export type LearningExternalEvidenceArtifactKind = z.infer<
  typeof LearningExternalEvidenceArtifactKindSchema
>;
export type LearningExternalEvidenceStatus = z.infer<
  typeof LearningExternalEvidenceStatusSchema
>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1 = deepFreeze({
  contract_version: "aionis_learning_external_evidence_threshold_contract_v1",
  status_precedence: ["failed", "inconclusive", "passed"],
  offline_paired_rerun: {
    case_count: 96,
    minimum_assessability: { numerator: 9, denominator: 10 },
    harm_noninferiority_margin: { numerator: 1, denominator: 20 },
    utility_noninferiority_margin: { numerator: 1, denominator: 20 },
    exploit_harm_reduction: { numerator: 1, denominator: 50 },
    missing_risk_assignment: {
      recorded: "no_loss",
      candidate: "loss",
    },
    missingness_contingency: "per_endpoint_recorded_candidate_and_both_missing",
    endpoint_assessability_contingency: "both_endpoints_unassessable_overlap",
    inconclusive_checks: [
      "harm_assessability_at_least_90_percent",
      "utility_assessability_at_least_90_percent",
    ],
    failure_checks: [
      "harm_noninferiority_at_plus_5_points",
      "utility_noninferiority_at_plus_5_points",
      "exploit_harm_reduction_at_minus_2_points",
    ],
  },
  production_shadow_gate: {
    minimum_rows: 1_000,
    minimum_task_signatures: 30,
    minimum_scopes: 5,
    projection_coverage: "exact_source_row_set",
    required_online_mode: "shadow",
    maximum_agent_prompt_included_count: 0,
    maximum_runtime_mutation_count: 0,
    maximum_hard_boundary_upgrade_count: 0,
    candidate_policy_selection: "exact_report_candidate_policy_id",
    harm_regression: {
      hard_boundary_direct_use: "candidate_lte_recorded",
      negative_use: "candidate_lte_recorded",
      positive_capture: "candidate_gte_recorded",
    },
    calibration: "candidate_strictly_gt_recorded",
    minimum_changed_action_count: 1,
    inconclusive_checks: [
      "exact_source_coverage",
      "shadow_mode",
      "no_prompt_inclusion",
      "no_runtime_mutation",
    ],
    failure_checks: [
      "no_hard_boundary_upgrade",
      "candidate_policy_selected",
      "candidate_policy_no_harm_regression",
      "candidate_policy_calibration_improved",
      "candidate_policy_changed_actions",
    ],
  },
  tool_e2e_gate: {
    requested_count: 40,
    minimum_difficulty_levels: 4,
    maximum_route_write_violation_count: 0,
    maximum_route_action_violation_count: 0,
    maximum_direction_attention_violation_count: 0,
    maximum_terminal_inspect_count: 0,
    maximum_report_conflict_count: 0,
    accepted_route_rate: { numerator: 1, denominator: 1 },
    action_completion_rate: { numerator: 1, denominator: 1 },
    maximum_context_ratio: { numerator: 3, denominator: 4 },
    required_policy_mode: "active",
    required_policy_source: "exact_with_full_result_coverage",
    required_profile_identity: "exact_when_profile_rule",
    inconclusive_checks: [
      "exact_result_coverage",
      "enough_difficulty_levels",
      "active_policy_mode_declared",
      "required_policy_source_pass",
      "required_policy_profile_pass",
    ],
    failure_checks: [
      "no_route_write_violations",
      "no_route_action_violations",
      "no_direction_attention_violations",
      "no_terminal_inspect",
      "no_report_conflict",
      "accepted_route_rate_pass",
      "action_completion_rate_pass",
      "context_budget_pass",
    ],
  },
} as const);

const CommonEvidenceBindingShape = {
  tenant_id: BoundedIdSchema,
  database_instance_id: DigestSha256Schema,
  evidence_series_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  applicable_experiment_id: BoundedIdSchema,
  applicable_experiment_revision: PositiveSafeIntegerSchema,
  candidate_policy_id: BoundedIdSchema,
  candidate_policy_version: BoundedIdSchema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  candidate_policy_config_sha256: DigestSha256Schema,
  gate_policy_id: BoundedIdSchema,
  gate_policy_version: BoundedIdSchema,
  gate_policy_config_sha256: DigestSha256Schema,
  applicability_manifest_sha256: DigestSha256Schema,
  evidence_scope_set_sha256: DigestSha256Schema,
  immutable_input_manifest_sha256: DigestSha256Schema,
  retry_policy_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  source_snapshot_sha256: DigestSha256Schema,
  run_id: BoundedIdSchema,
} as const;

export const LearningExternalEvidenceBindingV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_evidence_binding_v1"),
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  ...CommonEvidenceBindingShape,
}).strict();

export type LearningExternalEvidenceBindingV1 = z.infer<
  typeof LearningExternalEvidenceBindingV1Schema
>;

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function learningExternalEvidenceThresholdContractDigest(): string {
  return sha256Canonical(LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1);
}

export function learningExternalEvidenceBindingDigest(value: unknown): string {
  return sha256Canonical(LearningExternalEvidenceBindingV1Schema.parse(value));
}

const EvidenceReportCommonShape = {
  contract_version: z.literal("aionis_learning_external_evidence_report_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  ...CommonEvidenceBindingShape,
  artifact_status: LearningExternalEvidenceStatusSchema,
  source_experiment_id: BoundedIdSchema.nullable(),
  source_experiment_revision: PositiveSafeIntegerSchema.nullable(),
  source_bundle_sha256: DigestSha256Schema,
  collected_at: LearningExternalCanonicalUtcMillisSchema,
  reason_codes: z.array(BoundedIdSchema).max(128),
} as const;

const OfflinePairedReportPayloadV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_offline_paired_report_payload_v1"),
  evidence_status: LearningExternalEvidenceStatusSchema,
  case_count: z.literal(
    LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1.offline_paired_rerun.case_count,
  ),
  harm_pair_count: z.number().int().min(0).max(96),
  utility_pair_count: z.number().int().min(0).max(96),
  fully_assessable_pair_count: z.number().int().min(0).max(96),
  recorded_harm_observed_loss_count: z.number().int().min(0).max(96),
  candidate_harm_observed_loss_count: z.number().int().min(0).max(96),
  recorded_harm_missing_count: z.number().int().min(0).max(96),
  candidate_harm_missing_count: z.number().int().min(0).max(96),
  harm_both_arms_missing_count: z.number().int().min(0).max(96),
  recorded_utility_observed_loss_count: z.number().int().min(0).max(96),
  candidate_utility_observed_loss_count: z.number().int().min(0).max(96),
  recorded_utility_missing_count: z.number().int().min(0).max(96),
  candidate_utility_missing_count: z.number().int().min(0).max(96),
  utility_both_arms_missing_count: z.number().int().min(0).max(96),
  both_endpoints_unassessable_pair_count: z.number().int().min(0).max(96),
  exploit_case_count: z.number().int().min(0).max(96),
  recorded_exploit_harm_observed_loss_count: z.number().int().min(0).max(96),
  candidate_exploit_harm_observed_loss_count: z.number().int().min(0).max(96),
  recorded_exploit_harm_missing_count: z.number().int().min(0).max(96),
  candidate_exploit_harm_missing_count: z.number().int().min(0).max(96),
  case_set_sha256: DigestSha256Schema,
  execution_profile_sha256: DigestSha256Schema,
  model_identity_sha256: DigestSha256Schema,
  execution_order_sha256: DigestSha256Schema,
  response_fingerprint_set_sha256: DigestSha256Schema,
  runtime_copy_set_sha256: DigestSha256Schema,
  endpoint_result_set_sha256: DigestSha256Schema,
  exclusion_manifest_sha256: DigestSha256Schema,
  fixed_threshold_contract_sha256: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  const caseCount = value.case_count;
  const endpointFacts = [
    ["harm", value.harm_pair_count, value.recorded_harm_observed_loss_count,
      value.candidate_harm_observed_loss_count, value.recorded_harm_missing_count,
      value.candidate_harm_missing_count, value.harm_both_arms_missing_count],
    ["utility", value.utility_pair_count, value.recorded_utility_observed_loss_count,
      value.candidate_utility_observed_loss_count, value.recorded_utility_missing_count,
      value.candidate_utility_missing_count, value.utility_both_arms_missing_count],
  ] as const;
  for (const [endpoint, pairCount, recordedLosses, candidateLosses,
    recordedMissing, candidateMissing, bothMissing] of endpointFacts) {
    if (recordedLosses + recordedMissing > caseCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`recorded_${endpoint}_observed_loss_count`],
        message: `Recorded ${endpoint} observed losses and missing rows exceed the case set`,
      });
    }
    if (candidateLosses + candidateMissing > caseCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`candidate_${endpoint}_observed_loss_count`],
        message: `Candidate ${endpoint} observed losses and missing rows exceed the case set`,
      });
    }
    if (bothMissing > Math.min(recordedMissing, candidateMissing)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${endpoint}_both_arms_missing_count`],
        message: `${endpoint} both-arm missing rows must be a subset of each arm's missing rows`,
      });
    }
    const expectedPairCount = caseCount - recordedMissing - candidateMissing + bothMissing;
    if (pairCount !== expectedPairCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${endpoint}_pair_count`],
        message: `${endpoint} pair count must equal the exact arm-missingness contingency`,
      });
    }
  }
  const harmUnassessableCount = caseCount - value.harm_pair_count;
  const utilityUnassessableCount = caseCount - value.utility_pair_count;
  const bothEndpointsUnassessable = value.both_endpoints_unassessable_pair_count;
  const expectedFullyAssessablePairCount = caseCount
    - harmUnassessableCount
    - utilityUnassessableCount
    + bothEndpointsUnassessable;
  if (bothEndpointsUnassessable > Math.min(harmUnassessableCount, utilityUnassessableCount)
    || bothEndpointsUnassessable
      < Math.max(0, harmUnassessableCount + utilityUnassessableCount - caseCount)
    || value.fully_assessable_pair_count !== expectedFullyAssessablePairCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fully_assessable_pair_count"],
      message: "Fully assessable pair count must equal the endpoint-assessability contingency",
    });
  }
  for (const [arm, observedLosses, missing, totalObservedLosses, totalMissing] of [
    ["recorded", value.recorded_exploit_harm_observed_loss_count,
      value.recorded_exploit_harm_missing_count, value.recorded_harm_observed_loss_count,
      value.recorded_harm_missing_count],
    ["candidate", value.candidate_exploit_harm_observed_loss_count,
      value.candidate_exploit_harm_missing_count, value.candidate_harm_observed_loss_count,
      value.candidate_harm_missing_count],
  ] as const) {
    if (observedLosses + missing > value.exploit_case_count
      || observedLosses > totalObservedLosses
      || missing > totalMissing) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${arm}_exploit_harm_observed_loss_count`],
        message: `${arm} exploit facts must be a subset of the declared harm facts`,
      });
    }
  }
});

const ProductionShadowReportPayloadV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_production_shadow_report_payload_v1"),
  evidence_status: LearningExternalEvidenceStatusSchema,
  row_count: z.number().int().min(0).max(10_000_000),
  run_count: z.number().int().min(0).max(10_000_000),
  task_signature_count: z.number().int().min(0).max(10_000_000),
  scope_count: z.number().int().min(0).max(10_000_000),
  projection_present_count: z.number().int().min(0).max(10_000_000),
  source_row_set_sha256: DigestSha256Schema,
  source_run_set_sha256: DigestSha256Schema,
  shadow_projection_set_sha256: DigestSha256Schema,
  host_adapter_conformance_sha256: DigestSha256Schema,
  fixed_threshold_contract_sha256: DigestSha256Schema,
  online_mode: z.enum(["off", "recorded", "shadow", "active", "mixed", "unspecified"]),
  shadow_projection_source_count: NonNegativeSafeIntegerSchema,
  agent_prompt_included_count: NonNegativeSafeIntegerSchema,
  runtime_mutation_count: NonNegativeSafeIntegerSchema,
  hard_boundary_upgrade_count: NonNegativeSafeIntegerSchema,
  selected_candidate_policy_id: BoundedIdSchema.nullable(),
  recorded_hard_boundary_direct_use_count: NonNegativeSafeIntegerSchema,
  candidate_hard_boundary_direct_use_count: NonNegativeSafeIntegerSchema,
  recorded_negative_use_count: NonNegativeSafeIntegerSchema,
  candidate_negative_use_count: NonNegativeSafeIntegerSchema,
  recorded_positive_capture_count: NonNegativeSafeIntegerSchema,
  candidate_positive_capture_count: NonNegativeSafeIntegerSchema,
  recorded_calibration_score_micros: z.number().int().min(0).max(1_000_000),
  candidate_calibration_score_micros: z.number().int().min(0).max(1_000_000),
  changed_action_count: NonNegativeSafeIntegerSchema,
}).strict().superRefine((value, context) => {
  for (const field of [
    "run_count", "task_signature_count", "scope_count", "projection_present_count",
    "shadow_projection_source_count", "agent_prompt_included_count",
    "runtime_mutation_count", "hard_boundary_upgrade_count",
    "recorded_hard_boundary_direct_use_count", "candidate_hard_boundary_direct_use_count",
    "recorded_negative_use_count", "candidate_negative_use_count",
    "recorded_positive_capture_count", "candidate_positive_capture_count",
    "changed_action_count",
  ] as const) {
    if (value[field] > value.row_count) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} cannot exceed the frozen source row set`,
      });
    }
  }
});

const ToolE2EReportPayloadV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_tool_e2e_report_payload_v1"),
  evidence_status: LearningExternalEvidenceStatusSchema,
  requested_count: z.literal(
    LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1.tool_e2e_gate.requested_count,
  ),
  completed_count: z.number().int().min(0).max(40),
  result_count: z.number().int().min(0).max(40),
  difficulty_level_count: z.number().int().min(0).max(64),
  result_set_sha256: DigestSha256Schema,
  tool_manifest_sha256: DigestSha256Schema,
  host_adapter_conformance_sha256: DigestSha256Schema,
  fixed_threshold_contract_sha256: DigestSha256Schema,
  policy_mode: z.enum(["active", "off", "recorded", "shadow", "unspecified"]),
  policy_source: z.enum(["global_env", "profile_rule", "off", "mixed", "unspecified"]),
  required_policy_source: z.enum(["global_env", "profile_rule"]),
  policy_source_guide_count: z.number().int().min(0).max(40),
  policy_source_matching_count: z.number().int().min(0).max(40),
  required_policy_profile_id: BoundedIdSchema.nullable(),
  actual_policy_profile_id: BoundedIdSchema.nullable(),
  policy_profile_matching_count: z.number().int().min(0).max(40),
  metrics: z.object({
    route_write_violation_count: NonNegativeSafeIntegerSchema,
    route_action_violation_count: NonNegativeSafeIntegerSchema,
    direction_attention_violation_count: NonNegativeSafeIntegerSchema,
    terminal_inspect_count: NonNegativeSafeIntegerSchema,
    report_conflict_count: NonNegativeSafeIntegerSchema,
    accepted_route_hits: z.number().int().min(0).max(40),
    action_completion_hits: z.number().int().min(0).max(40),
    initial_context_chars: NonNegativeSafeIntegerSchema,
    full_history_initial_context_chars: PositiveSafeIntegerSchema,
    prompt_tokens: NonNegativeSafeIntegerSchema,
    full_history_prompt_tokens: PositiveSafeIntegerSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  for (const [field, count, metric] of [
    ["accepted_route_hits", value.metrics.accepted_route_hits, true],
    ["action_completion_hits", value.metrics.action_completion_hits, true],
    ["policy_source_guide_count", value.policy_source_guide_count, false],
    ["policy_source_matching_count", value.policy_source_matching_count, false],
    ["policy_profile_matching_count", value.policy_profile_matching_count, false],
  ] as const) {
    if (count > value.result_count) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: metric ? ["metrics", field] : [field],
        message: `${field} cannot exceed the terminal result count`,
      });
    }
  }
});

type ReportStatusDerivation = Readonly<{
  status: LearningExternalEvidenceStatus;
  reasonCodes: readonly string[];
}>;

function falseCheckReasonCodes(checks: Readonly<Record<string, boolean>>): string[] {
  return Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function everyNamedCheckPass<Checks extends Readonly<Record<string, boolean>>>(
  checks: Checks,
  names: readonly (keyof Checks)[],
): boolean {
  return names.every((name) => checks[name]);
}

// Status semantics are frozen here rather than accepted from a report writer:
// an observed candidate/safety failure takes precedence over incomplete run
// coverage; missingness alone is inconclusive; only every mandatory check
// passing is passed. All three states are terminal report outcomes.

function deriveOfflineReportStatus(
  payload: z.infer<typeof OfflinePairedReportPayloadV1Schema>,
): ReportStatusDerivation {
  const contract = LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1.offline_paired_rerun;
  const recordedHarmLossCount = payload.recorded_harm_observed_loss_count;
  const candidateHarmLossCount = payload.candidate_harm_observed_loss_count
    + payload.candidate_harm_missing_count;
  const recordedUtilityLossCount = payload.recorded_utility_observed_loss_count;
  const candidateUtilityLossCount = payload.candidate_utility_observed_loss_count
    + payload.candidate_utility_missing_count;
  const recordedExploitHarmLossCount = payload.recorded_exploit_harm_observed_loss_count;
  const candidateExploitHarmLossCount = payload.candidate_exploit_harm_observed_loss_count
    + payload.candidate_exploit_harm_missing_count;
  const expectedChecks = {
    harm_assessability_at_least_90_percent:
      BigInt(contract.minimum_assessability.denominator) * BigInt(payload.harm_pair_count)
        >= BigInt(contract.minimum_assessability.numerator) * BigInt(payload.case_count),
    utility_assessability_at_least_90_percent:
      BigInt(contract.minimum_assessability.denominator) * BigInt(payload.utility_pair_count)
        >= BigInt(contract.minimum_assessability.numerator) * BigInt(payload.case_count),
    harm_noninferiority_at_plus_5_points:
      BigInt(contract.harm_noninferiority_margin.denominator)
        * BigInt(candidateHarmLossCount - recordedHarmLossCount)
        <= BigInt(contract.harm_noninferiority_margin.numerator) * BigInt(payload.case_count),
    utility_noninferiority_at_plus_5_points:
      BigInt(contract.utility_noninferiority_margin.denominator)
        * BigInt(candidateUtilityLossCount - recordedUtilityLossCount)
        <= BigInt(contract.utility_noninferiority_margin.numerator) * BigInt(payload.case_count),
    exploit_harm_reduction_at_minus_2_points:
      BigInt(contract.exploit_harm_reduction.denominator)
        * BigInt(candidateExploitHarmLossCount - recordedExploitHarmLossCount)
        <= -BigInt(contract.exploit_harm_reduction.numerator) * BigInt(payload.case_count),
  };
  const failed = !everyNamedCheckPass(expectedChecks, contract.failure_checks);
  const inconclusive = !everyNamedCheckPass(expectedChecks, contract.inconclusive_checks);
  return {
    status: failed ? "failed" : inconclusive ? "inconclusive" : "passed",
    reasonCodes: falseCheckReasonCodes(expectedChecks),
  };
}

function deriveProductionReportStatus(
  payload: z.infer<typeof ProductionShadowReportPayloadV1Schema>,
  candidatePolicyId: string,
): ReportStatusDerivation {
  const contract = LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1.production_shadow_gate;
  const expectedChecks = {
    exact_source_coverage: payload.row_count >= contract.minimum_rows
      && payload.task_signature_count >= contract.minimum_task_signatures
      && payload.scope_count >= contract.minimum_scopes
      && payload.projection_present_count === payload.row_count
      && payload.shadow_projection_source_count === payload.row_count,
    shadow_mode: payload.online_mode === contract.required_online_mode,
    no_prompt_inclusion:
      payload.agent_prompt_included_count <= contract.maximum_agent_prompt_included_count,
    no_runtime_mutation:
      payload.runtime_mutation_count <= contract.maximum_runtime_mutation_count,
    no_hard_boundary_upgrade:
      payload.hard_boundary_upgrade_count <= contract.maximum_hard_boundary_upgrade_count,
    candidate_policy_selected: payload.selected_candidate_policy_id === candidatePolicyId,
    candidate_policy_no_harm_regression:
      payload.candidate_hard_boundary_direct_use_count
        <= payload.recorded_hard_boundary_direct_use_count
      && payload.candidate_negative_use_count <= payload.recorded_negative_use_count
      && payload.candidate_positive_capture_count >= payload.recorded_positive_capture_count,
    candidate_policy_calibration_improved:
      payload.candidate_calibration_score_micros
        > payload.recorded_calibration_score_micros,
    candidate_policy_changed_actions:
      payload.changed_action_count >= contract.minimum_changed_action_count,
  };
  const failed = !everyNamedCheckPass(expectedChecks, contract.failure_checks);
  const inconclusive = !everyNamedCheckPass(expectedChecks, contract.inconclusive_checks);
  return {
    status: failed ? "failed" : inconclusive ? "inconclusive" : "passed",
    reasonCodes: falseCheckReasonCodes(expectedChecks),
  };
}

function deriveToolReportStatus(
  payload: z.infer<typeof ToolE2EReportPayloadV1Schema>,
): ReportStatusDerivation {
  const contract = LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1.tool_e2e_gate;
  const requiredPolicyProfilePass = payload.required_policy_source === "profile_rule"
    ? payload.required_policy_profile_id !== null
      && payload.actual_policy_profile_id === payload.required_policy_profile_id
      && payload.policy_profile_matching_count === payload.result_count
    : payload.required_policy_profile_id === null
      && payload.actual_policy_profile_id === null
      && payload.policy_profile_matching_count === 0;
  const expectedChecks = {
    exact_result_coverage: payload.completed_count === payload.requested_count
      && payload.result_count === payload.requested_count,
    enough_difficulty_levels:
      payload.difficulty_level_count >= contract.minimum_difficulty_levels,
    no_route_write_violations: payload.metrics.route_write_violation_count
      <= contract.maximum_route_write_violation_count,
    no_route_action_violations: payload.metrics.route_action_violation_count
      <= contract.maximum_route_action_violation_count,
    no_direction_attention_violations:
      payload.metrics.direction_attention_violation_count
        <= contract.maximum_direction_attention_violation_count,
    no_terminal_inspect:
      payload.metrics.terminal_inspect_count <= contract.maximum_terminal_inspect_count,
    no_report_conflict:
      payload.metrics.report_conflict_count <= contract.maximum_report_conflict_count,
    accepted_route_rate_pass:
      BigInt(payload.metrics.accepted_route_hits)
        * BigInt(contract.accepted_route_rate.denominator)
        >= BigInt(payload.result_count) * BigInt(contract.accepted_route_rate.numerator),
    action_completion_rate_pass:
      BigInt(payload.metrics.action_completion_hits)
        * BigInt(contract.action_completion_rate.denominator)
        >= BigInt(payload.result_count) * BigInt(contract.action_completion_rate.numerator),
    context_budget_pass:
      BigInt(payload.metrics.initial_context_chars)
        * BigInt(contract.maximum_context_ratio.denominator)
        <= BigInt(payload.metrics.full_history_initial_context_chars)
          * BigInt(contract.maximum_context_ratio.numerator)
      && BigInt(payload.metrics.prompt_tokens)
        * BigInt(contract.maximum_context_ratio.denominator)
        <= BigInt(payload.metrics.full_history_prompt_tokens)
          * BigInt(contract.maximum_context_ratio.numerator),
    active_policy_mode_declared: payload.policy_mode === contract.required_policy_mode,
    required_policy_source_pass: payload.policy_source === payload.required_policy_source
      && payload.policy_source_guide_count === payload.result_count
      && payload.policy_source_matching_count === payload.result_count,
    required_policy_profile_pass: requiredPolicyProfilePass,
  };
  const failed = !everyNamedCheckPass(expectedChecks, contract.failure_checks);
  const inconclusive = !everyNamedCheckPass(expectedChecks, contract.inconclusive_checks);
  return {
    status: failed ? "failed" : inconclusive ? "inconclusive" : "passed",
    reasonCodes: falseCheckReasonCodes(expectedChecks),
  };
}

const OfflinePairedEvidenceReportV1Schema = z.object({
  ...EvidenceReportCommonShape,
  artifact_kind: z.literal("offline_paired_rerun"),
  source_serving_phase: z.literal("isolated_paired"),
  payload: OfflinePairedReportPayloadV1Schema,
}).strict();

const ProductionShadowEvidenceReportV1Schema = z.object({
  ...EvidenceReportCommonShape,
  artifact_kind: z.literal("production_shadow_gate"),
  source_serving_phase: z.literal("shadow"),
  payload: ProductionShadowReportPayloadV1Schema,
}).strict();

const ToolE2EEvidenceReportV1Schema = z.object({
  ...EvidenceReportCommonShape,
  artifact_kind: z.literal("tool_e2e_gate"),
  source_serving_phase: z.literal("external_tool"),
  payload: ToolE2EReportPayloadV1Schema,
}).strict();

const EvidenceReportUnionSchema = z.discriminatedUnion("artifact_kind", [
  OfflinePairedEvidenceReportV1Schema,
  ProductionShadowEvidenceReportV1Schema,
  ToolE2EEvidenceReportV1Schema,
]);

export const LearningExternalEvidenceReportV1Schema = EvidenceReportUnionSchema.superRefine(
  (value, context) => {
    const derived = value.artifact_kind === "offline_paired_rerun"
      ? deriveOfflineReportStatus(value.payload)
      : value.artifact_kind === "production_shadow_gate"
        ? deriveProductionReportStatus(value.payload, value.candidate_policy_id)
        : deriveToolReportStatus(value.payload);
    if (value.payload.evidence_status !== derived.status
      || value.artifact_status !== derived.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "evidence_status"],
        message: "Formal report status must equal the status derived from bounded facts",
      });
    }
    if (stableStringify(value.reason_codes) !== stableStringify(derived.reasonCodes)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason_codes"],
        message: "Formal report reason codes must equal the derived failed checks",
      });
    }
    try {
      resolveLearningGatePolicy(
        value.gate_policy_id,
        value.gate_policy_version,
      );
      if (value.payload.fixed_threshold_contract_sha256
        !== learningExternalEvidenceThresholdContractDigest()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "fixed_threshold_contract_sha256"],
          message: "Formal report must bind the fixed external-evidence threshold contract",
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate_policy_id"],
        message: "Formal report must bind a registered canonical gate-policy tuple",
      });
    }
    const sourcePairPresent = value.source_experiment_id !== null
      && value.source_experiment_revision !== null;
    if ((value.source_experiment_id === null) !== (value.source_experiment_revision === null)
      || (value.artifact_kind === "production_shadow_gate") !== sourcePairPresent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_experiment_id"],
        message: "Only production-shadow evidence requires a complete source experiment binding",
      });
    }
    const binding = LearningExternalEvidenceBindingV1Schema.parse({
      contract_version: "aionis_learning_external_evidence_binding_v1",
      artifact_kind: value.artifact_kind,
      tenant_id: value.tenant_id,
      database_instance_id: value.database_instance_id,
      evidence_series_id: value.evidence_series_id,
      task_family: value.task_family,
      applicable_experiment_id: value.applicable_experiment_id,
      applicable_experiment_revision: value.applicable_experiment_revision,
      candidate_policy_id: value.candidate_policy_id,
      candidate_policy_version: value.candidate_policy_version,
      candidate_policy_implementation_sha256: value.candidate_policy_implementation_sha256,
      candidate_policy_config_sha256: value.candidate_policy_config_sha256,
      gate_policy_id: value.gate_policy_id,
      gate_policy_version: value.gate_policy_version,
      gate_policy_config_sha256: value.gate_policy_config_sha256,
      applicability_manifest_sha256: value.applicability_manifest_sha256,
      evidence_scope_set_sha256: value.evidence_scope_set_sha256,
      immutable_input_manifest_sha256: value.immutable_input_manifest_sha256,
      retry_policy_sha256: value.retry_policy_sha256,
      harness_bundle_sha256: value.harness_bundle_sha256,
      source_snapshot_sha256: value.source_snapshot_sha256,
      run_id: value.run_id,
    });
    if (value.evidence_binding_sha256 !== learningExternalEvidenceBindingDigest(binding)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_binding_sha256"],
        message: "Report evidence binding digest mismatch",
      });
    }
    if (new Set(value.reason_codes).size !== value.reason_codes.length
      || value.reason_codes.some((entry, index) => index > 0
        && Buffer.compare(Buffer.from(value.reason_codes[index - 1]!), Buffer.from(entry)) >= 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason_codes"],
        message: "Reason codes must be unique and canonically sorted",
      });
    }
    if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_REPORT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Canonical evidence report exceeds ${MAX_REPORT_BYTES} bytes`,
      });
    }
  },
);

export type LearningExternalEvidenceReportV1 = z.infer<
  typeof LearningExternalEvidenceReportV1Schema
>;

export function learningExternalEvidenceReportJson(value: unknown): string {
  return stableStringify(LearningExternalEvidenceReportV1Schema.parse(value));
}

export function learningExternalEvidenceReportDigest(value: unknown): string {
  return createHash("sha256").update(learningExternalEvidenceReportJson(value)).digest("hex");
}

function lifecycleOperationProjectionSchema<Kind extends string>(operationKind: Kind) {
  return z.object({
    scope: z.literal("learning_external_authority_v1"),
    operation_kind: z.literal(operationKind),
    operation_id: BoundedIdSchema,
    operation_request_sha256: DigestSha256Schema,
    authority_record_sha256: DigestSha256Schema,
  }).strict();
}

function lifecycleFactProjectionSchema<Table extends string, Kind extends string>(
  authorityTable: Table,
  operationKind: Kind,
) {
  return z.object({
    authority_table: z.literal(authorityTable),
    fact_id: BoundedIdSchema,
    fact_sha256: DigestSha256Schema,
    protected_operation: lifecycleOperationProjectionSchema(operationKind),
  }).strict().superRefine((value, context) => {
    if (value.fact_sha256 !== value.protected_operation!.authority_record_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protected_operation", "authority_record_sha256"],
        message: "Protected operation must bind its lifecycle fact digest",
      });
    }
  });
}

const ReservationProjectionV1Schema = lifecycleFactProjectionSchema(
  "lite_learning_external_run_reservations",
  "learning_external_run_reservation_v1",
);
const ConsumptionProjectionV1Schema = lifecycleFactProjectionSchema(
  "lite_learning_external_ticket_consumptions",
  "learning_external_ticket_consumption_v1",
);
const ClaimProjectionV1Schema = lifecycleFactProjectionSchema(
  "lite_learning_external_run_claims",
  "learning_external_run_claim_v1",
);
const BindingProjectionV1Schema = lifecycleFactProjectionSchema(
  "lite_learning_external_supervisor_bindings",
  "learning_external_supervisor_binding_v1",
);

const NormalTerminationProjectionV1Schema = z.object({
  authority_table: z.literal("lite_learning_external_session_terminations"),
  fact_id: BoundedIdSchema,
  fact_sha256: DigestSha256Schema,
  termination_reason: LearningExternalEvidenceStatusSchema,
  broker_terminal_receipt_sha256: DigestSha256Schema,
  broker_quiesce_receipt_sha256: DigestSha256Schema,
  runner_output_manifest_sha256: DigestSha256Schema,
  terminal_run_manifest_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  terminated_at: LearningExternalCanonicalUtcMillisSchema,
  protected_operation: lifecycleOperationProjectionSchema(
    "learning_external_session_termination_v1",
  ),
}).strict().superRefine((value, context) => {
  if (value.fact_sha256 !== value.protected_operation.authority_record_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["protected_operation", "authority_record_sha256"],
      message: "Protected operation must bind its lifecycle fact digest",
    });
  }
});

export const LearningExternalLifecycleAuthorityProjectionV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_lifecycle_authority_projection_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  tenant_id: BoundedIdSchema,
  database_instance_id: DigestSha256Schema,
  reservation: ReservationProjectionV1Schema,
  ticket_consumption: ConsumptionProjectionV1Schema,
  claim: ClaimProjectionV1Schema,
  supervisor_binding: BindingProjectionV1Schema,
  session_termination: NormalTerminationProjectionV1Schema,
  service_launcher_receipt_sha256: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_AUTHORITY_PROJECTION_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Lifecycle authority projection exceeds ${MAX_AUTHORITY_PROJECTION_BYTES} bytes`,
    });
  }
});

export type LearningExternalLifecycleAuthorityProjectionV1 = z.infer<
  typeof LearningExternalLifecycleAuthorityProjectionV1Schema
>;

export function learningExternalEvidenceLifecycleAuthorityProjectionDigest(
  value: unknown,
): string {
  return sha256Canonical(LearningExternalLifecycleAuthorityProjectionV1Schema.parse(value));
}

/*
 * A self-contained public archive also needs the signed broker health/drain
 * envelopes and full protected rows. Those contracts do not exist in the
 * current Runtime yet. This projection is deliberately limited to live-DB
 * comparison material and must not be treated as fresh-shell authority.
 */


const AttemptEntryV1Schema = z.object({
  attempt_ordinal: PositiveSafeIntegerSchema,
  call_id: BoundedIdSchema,
  capability_sha256: DigestSha256Schema,
  request_sha256: DigestSha256Schema,
  response_sha256: DigestSha256Schema.nullable(),
  result: z.enum(["succeeded", "failed", "denied", "cancelled"]),
  started_at: LearningExternalCanonicalUtcMillisSchema,
  finished_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.finished_at) < Date.parse(value.started_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finished_at"],
      message: "Attempt cannot finish before it starts",
    });
  }
  if ((value.result === "succeeded") !== (value.response_sha256 !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["response_sha256"],
      message: "Only a succeeded attempt carries a response digest",
    });
  }
});

export const LearningExternalAttemptChainV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_attempt_chain_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  credential_session_max_calls: PositiveSafeIntegerSchema.max(MAX_ATTEMPTS),
  attempts: z.array(AttemptEntryV1Schema).max(MAX_ATTEMPTS),
  sealed_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const callIds = new Set<string>();
  let previousStartedAt: string | null = null;
  if (value.attempts.length > value.credential_session_max_calls) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attempts"],
      message: "Attempt count exceeds the frozen credential-session call limit",
    });
  }
  for (const [index, attempt] of value.attempts.entries()) {
    if (attempt.attempt_ordinal !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempts", index, "attempt_ordinal"],
        message: "Attempt ordinals must be contiguous and one-based",
      });
    }
    if (callIds.has(attempt.call_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempts", index, "call_id"],
        message: "Attempt call identifiers must be unique",
      });
    }
    callIds.add(attempt.call_id);
    if (previousStartedAt !== null && attempt.started_at < previousStartedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempts", index, "started_at"],
        message: "Attempt chain must be in canonical start-time order",
      });
    }
    previousStartedAt = attempt.started_at;
    if (attempt.finished_at > value.sealed_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempts", index, "finished_at"],
        message: "Attempt cannot finish after the chain is sealed",
      });
    }
  }
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_ATTEMPT_CHAIN_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Attempt chain exceeds ${MAX_ATTEMPT_CHAIN_BYTES} bytes`,
    });
  }
});

export type LearningExternalAttemptChainV1 = z.infer<
  typeof LearningExternalAttemptChainV1Schema
>;

export function learningExternalAttemptChainDigest(value: unknown): string {
  return sha256Canonical(LearningExternalAttemptChainV1Schema.parse(value));
}

export const LearningExternalPreterminalPayloadSetV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_preterminal_payload_set_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  report_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  source_bundle_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
}).strict();

export function learningExternalPreterminalPayloadSetDigest(value: unknown): string {
  return sha256Canonical(LearningExternalPreterminalPayloadSetV1Schema.parse(value));
}

export const LearningExternalRunnerOutputManifestV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_runner_output_manifest_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  artifact_status: LearningExternalEvidenceStatusSchema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  report_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  source_bundle_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  preterminal_payload_set_sha256: DigestSha256Schema,
  source_ref: SourceRefSchema,
  source_commit_id: SourceCommitIdSchema,
  collected_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_MANIFEST_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Runner-output manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    });
  }
});

export type LearningExternalRunnerOutputManifestV1 = z.infer<
  typeof LearningExternalRunnerOutputManifestV1Schema
>;

export function learningExternalRunnerOutputManifestDigest(value: unknown): string {
  return sha256Canonical(LearningExternalRunnerOutputManifestV1Schema.parse(value));
}

export const LearningExternalTerminalRunManifestV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_terminal_run_manifest_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  artifact_status: LearningExternalEvidenceStatusSchema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  report_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  runner_output_manifest_sha256: DigestSha256Schema,
  source_bundle_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  preterminal_payload_set_sha256: DigestSha256Schema,
  source_ref: SourceRefSchema,
  source_commit_id: SourceCommitIdSchema,
  finalized_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_MANIFEST_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Terminal run manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    });
  }
});

export type LearningExternalTerminalRunManifestV1 = z.infer<
  typeof LearningExternalTerminalRunManifestV1Schema
>;

export function learningExternalTerminalRunManifestDigest(value: unknown): string {
  return sha256Canonical(LearningExternalTerminalRunManifestV1Schema.parse(value));
}

const SafeRelativeMemberPathSchema = z.string().superRefine((value, context) => {
  const parts = value.split("/");
  if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(value)
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 512
    || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Bundle member path must be a safe canonical relative POSIX path",
    });
  }
});

const RunBundleMemberV1Schema = z.object({
  path: SafeRelativeMemberPathSchema,
  role: z.enum([
    "report",
    "attempt_chain",
    "runner_output_manifest",
    "terminal_run_manifest",
    "lifecycle_authority_projection",
    "public_run_authority",
    "source_bundle",
    "supporting_evidence",
  ]),
  byte_length: NonNegativeSafeIntegerSchema.max(MAX_BUNDLE_MEMBER_BYTES),
  sha256: DigestSha256Schema,
}).strict();

export const LearningExternalEvidenceRunBundleV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_evidence_run_bundle_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  artifact_status: LearningExternalEvidenceStatusSchema,
  lifecycle_authority_projection_sha256: DigestSha256Schema,
  public_run_authority_sha256: DigestSha256Schema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  session_termination_id: BoundedIdSchema,
  session_termination_sha256: DigestSha256Schema,
  report_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  runner_output_manifest_sha256: DigestSha256Schema,
  terminal_run_manifest_sha256: DigestSha256Schema,
  source_bundle_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  preterminal_payload_set_sha256: DigestSha256Schema,
  source_ref: SourceRefSchema,
  source_commit_id: SourceCommitIdSchema,
  members: z.array(RunBundleMemberV1Schema).min(7).max(MAX_BUNDLE_MEMBERS),
  committed_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const requiredRoles = [
    "report",
    "attempt_chain",
    "runner_output_manifest",
    "terminal_run_manifest",
    "lifecycle_authority_projection",
    "public_run_authority",
    "source_bundle",
  ] as const;
  const paths = value.members.map((member) => member.path);
  if (new Set(paths).size !== paths.length
    || paths.some((entry, index) => index > 0
      && Buffer.compare(Buffer.from(paths[index - 1]!), Buffer.from(entry)) >= 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["members"],
      message: "Bundle members must have unique canonically sorted paths",
    });
  }
  for (const role of requiredRoles) {
    if (value.members.filter((member) => member.role === role).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members"],
        message: `Bundle requires exactly one ${role} member`,
      });
    }
  }
  if (value.members.reduce((total, member) => total + member.byte_length, 0) > MAX_BUNDLE_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["members"],
      message: `Bundle members exceed ${MAX_BUNDLE_BYTES} total bytes`,
    });
  }
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_RUN_BUNDLE_MANIFEST_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Run-bundle manifest exceeds ${MAX_RUN_BUNDLE_MANIFEST_BYTES} bytes`,
    });
  }
});

export type LearningExternalEvidenceRunBundleV1 = z.infer<
  typeof LearningExternalEvidenceRunBundleV1Schema
>;

export function learningExternalEvidenceRunBundleDigest(value: unknown): string {
  return sha256Canonical(LearningExternalEvidenceRunBundleV1Schema.parse(value));
}

function parseCanonicalContractJson<Schema extends z.ZodTypeAny>(args: Readonly<{
  bytes: Uint8Array;
  schema: Schema;
  maxBytes: number;
  label: string;
}>): z.output<Schema> {
  if (!(args.bytes instanceof Uint8Array) || args.bytes.byteLength > args.maxBytes) {
    throw new Error(`${args.label} exceeds its canonical byte limit`);
  }
  if (args.bytes.byteLength >= 3
    && args.bytes[0] === 0xef
    && args.bytes[1] === 0xbb
    && args.bytes[2] === 0xbf) {
    throw new Error(`${args.label} must not contain a UTF-8 byte-order mark`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(args.bytes);
  } catch {
    throw new Error(`${args.label} must contain valid UTF-8`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${args.label} must contain valid JSON`);
  }
  if (stableStringify(raw) !== text) {
    throw new Error(`${args.label} must contain canonical JSON without duplicate keys`);
  }
  const parsed = args.schema.parse(raw);
  if (stableStringify(parsed) !== text) {
    throw new Error(`${args.label} must be schema-canonical JSON`);
  }
  return parsed;
}

export function parseCanonicalLearningExternalEvidenceReportJson(
  bytes: Uint8Array,
): LearningExternalEvidenceReportV1 {
  return parseCanonicalContractJson({
    bytes,
    schema: LearningExternalEvidenceReportV1Schema,
    maxBytes: MAX_REPORT_BYTES,
    label: "external evidence report",
  });
}

export function parseCanonicalLearningExternalAttemptChainJson(
  bytes: Uint8Array,
): LearningExternalAttemptChainV1 {
  return parseCanonicalContractJson({
    bytes,
    schema: LearningExternalAttemptChainV1Schema,
    maxBytes: MAX_ATTEMPT_CHAIN_BYTES,
    label: "external attempt chain",
  });
}

export function parseCanonicalLearningExternalRunnerOutputManifestJson(
  bytes: Uint8Array,
): LearningExternalRunnerOutputManifestV1 {
  return parseCanonicalContractJson({
    bytes,
    schema: LearningExternalRunnerOutputManifestV1Schema,
    maxBytes: MAX_MANIFEST_BYTES,
    label: "external runner-output manifest",
  });
}

export function parseCanonicalLearningExternalTerminalRunManifestJson(
  bytes: Uint8Array,
): LearningExternalTerminalRunManifestV1 {
  return parseCanonicalContractJson({
    bytes,
    schema: LearningExternalTerminalRunManifestV1Schema,
    maxBytes: MAX_MANIFEST_BYTES,
    label: "external terminal run manifest",
  });
}

export function parseCanonicalLearningExternalLifecycleAuthorityProjectionJson(
  bytes: Uint8Array,
): LearningExternalLifecycleAuthorityProjectionV1 {
  return parseCanonicalContractJson({
    bytes,
    schema: LearningExternalLifecycleAuthorityProjectionV1Schema,
    maxBytes: MAX_AUTHORITY_PROJECTION_BYTES,
    label: "external lifecycle authority projection",
  });
}

export function parseCanonicalLearningExternalEvidenceRunBundleJson(
  bytes: Uint8Array,
): LearningExternalEvidenceRunBundleV1 {
  return parseCanonicalContractJson({
    bytes,
    schema: LearningExternalEvidenceRunBundleV1Schema,
    maxBytes: MAX_RUN_BUNDLE_MANIFEST_BYTES,
    label: "external evidence run-bundle manifest",
  });
}

function expectedMember(
  bundle: LearningExternalEvidenceRunBundleV1,
  role: "report" | "attempt_chain" | "runner_output_manifest" | "terminal_run_manifest"
    | "lifecycle_authority_projection" | "public_run_authority" | "source_bundle",
) {
  const member = bundle.members.find((entry) => entry.role === role);
  if (!member) throw new Error(`External evidence bundle is missing ${role}`);
  return member;
}

function assertEqual(label: string, values: readonly unknown[]): void {
  if (new Set(values).size !== 1) {
    throw new Error(`learning_external_evidence_binding_mismatch:${label}`);
  }
}

export type LearningExternalEvidenceValidatedContractSetV1 = Readonly<{
  lifecycleAuthorityProjection: LearningExternalLifecycleAuthorityProjectionV1;
  report: LearningExternalEvidenceReportV1;
  attemptChain: LearningExternalAttemptChainV1;
  runnerOutputManifest: LearningExternalRunnerOutputManifestV1;
  terminalRunManifest: LearningExternalTerminalRunManifestV1;
  runBundle: LearningExternalEvidenceRunBundleV1;
  digests: Readonly<{
    lifecycle_authority_projection_sha256: string;
    report_sha256: string;
    attempt_chain_sha256: string;
    runner_output_manifest_sha256: string;
    terminal_run_manifest_sha256: string;
    run_bundle_sha256: string;
  }>;
}>;

export function validateLearningExternalEvidenceContractSetV1(args: Readonly<{
  lifecycleAuthorityProjection: unknown;
  report: unknown;
  attemptChain: unknown;
  runnerOutputManifest: unknown;
  terminalRunManifest: unknown;
  publicRunAuthoritySha256: string;
  runBundle: unknown;
}>): LearningExternalEvidenceValidatedContractSetV1 {
  const lifecycleAuthorityProjection = LearningExternalLifecycleAuthorityProjectionV1Schema.parse(
    args.lifecycleAuthorityProjection,
  );
  const report = LearningExternalEvidenceReportV1Schema.parse(args.report);
  const attemptChain = LearningExternalAttemptChainV1Schema.parse(args.attemptChain);
  const runnerOutputManifest = LearningExternalRunnerOutputManifestV1Schema.parse(args.runnerOutputManifest);
  const terminalRunManifest = LearningExternalTerminalRunManifestV1Schema.parse(args.terminalRunManifest);
  const runBundle = LearningExternalEvidenceRunBundleV1Schema.parse(args.runBundle);
  const digests = {
    lifecycle_authority_projection_sha256:
      learningExternalEvidenceLifecycleAuthorityProjectionDigest(lifecycleAuthorityProjection),
    report_sha256: learningExternalEvidenceReportDigest(report),
    attempt_chain_sha256: learningExternalAttemptChainDigest(attemptChain),
    runner_output_manifest_sha256: learningExternalRunnerOutputManifestDigest(runnerOutputManifest),
    terminal_run_manifest_sha256: learningExternalTerminalRunManifestDigest(terminalRunManifest),
    run_bundle_sha256: learningExternalEvidenceRunBundleDigest(runBundle),
  };
  const preterminalPayloadSetSha256 = learningExternalPreterminalPayloadSetDigest({
    contract_version: "aionis_learning_external_preterminal_payload_set_v1",
    evidence_binding_sha256: report.evidence_binding_sha256,
    report_sha256: digests.report_sha256,
    attempt_chain_sha256: digests.attempt_chain_sha256,
    source_bundle_sha256: report.source_bundle_sha256,
    harness_bundle_sha256: report.harness_bundle_sha256,
  });

  assertEqual("evidence_binding_sha256", [
    lifecycleAuthorityProjection.evidence_binding_sha256,
    report.evidence_binding_sha256,
    attemptChain.evidence_binding_sha256,
    runnerOutputManifest.evidence_binding_sha256,
    terminalRunManifest.evidence_binding_sha256,
    runBundle.evidence_binding_sha256,
  ]);
  assertEqual("artifact_kind", [
    lifecycleAuthorityProjection.artifact_kind,
    report.artifact_kind,
    runnerOutputManifest.artifact_kind,
    terminalRunManifest.artifact_kind,
    runBundle.artifact_kind,
  ]);
  assertEqual("artifact_status", [
    lifecycleAuthorityProjection.session_termination.termination_reason,
    report.artifact_status,
    runnerOutputManifest.artifact_status,
    terminalRunManifest.artifact_status,
    runBundle.artifact_status,
  ]);
  assertEqual("reservation_id", [
    lifecycleAuthorityProjection.reservation.fact_id,
    attemptChain.reservation_id,
    runnerOutputManifest.reservation_id,
    terminalRunManifest.reservation_id,
    runBundle.reservation_id,
  ]);
  assertEqual("ticket_consumption_id", [
    lifecycleAuthorityProjection.ticket_consumption.fact_id,
    attemptChain.ticket_consumption_id,
    runnerOutputManifest.ticket_consumption_id,
    terminalRunManifest.ticket_consumption_id,
    runBundle.ticket_consumption_id,
  ]);
  assertEqual("claim_id", [
    lifecycleAuthorityProjection.claim.fact_id,
    attemptChain.claim_id,
    runnerOutputManifest.claim_id,
    terminalRunManifest.claim_id,
    runBundle.claim_id,
  ]);
  assertEqual("supervisor_binding_id", [
    lifecycleAuthorityProjection.supervisor_binding.fact_id,
    attemptChain.supervisor_binding_id,
    runnerOutputManifest.supervisor_binding_id,
    terminalRunManifest.supervisor_binding_id,
    runBundle.supervisor_binding_id,
  ]);
  assertEqual("session_termination_id", [
    lifecycleAuthorityProjection.session_termination.fact_id,
    runBundle.session_termination_id,
  ]);
  assertEqual("session_termination_sha256", [
    lifecycleAuthorityProjection.session_termination.fact_sha256,
    runBundle.session_termination_sha256,
  ]);
  assertEqual("report_sha256", [
    digests.report_sha256,
    runnerOutputManifest.report_sha256,
    terminalRunManifest.report_sha256,
    runBundle.report_sha256,
    expectedMember(runBundle, "report").sha256,
  ]);
  assertEqual("attempt_chain_sha256", [
    digests.attempt_chain_sha256,
    lifecycleAuthorityProjection.session_termination.attempt_chain_sha256,
    runnerOutputManifest.attempt_chain_sha256,
    terminalRunManifest.attempt_chain_sha256,
    runBundle.attempt_chain_sha256,
    expectedMember(runBundle, "attempt_chain").sha256,
  ]);
  assertEqual("runner_output_manifest_sha256", [
    digests.runner_output_manifest_sha256,
    lifecycleAuthorityProjection.session_termination.runner_output_manifest_sha256,
    terminalRunManifest.runner_output_manifest_sha256,
    runBundle.runner_output_manifest_sha256,
    expectedMember(runBundle, "runner_output_manifest").sha256,
  ]);
  assertEqual("terminal_run_manifest_sha256", [
    digests.terminal_run_manifest_sha256,
    lifecycleAuthorityProjection.session_termination.terminal_run_manifest_sha256,
    runBundle.terminal_run_manifest_sha256,
    expectedMember(runBundle, "terminal_run_manifest").sha256,
  ]);
  assertEqual("lifecycle_authority_projection_sha256", [
    digests.lifecycle_authority_projection_sha256,
    runBundle.lifecycle_authority_projection_sha256,
    expectedMember(runBundle, "lifecycle_authority_projection").sha256,
  ]);
  assertEqual("public_run_authority_sha256", [
    DigestSha256Schema.parse(args.publicRunAuthoritySha256),
    runBundle.public_run_authority_sha256,
    expectedMember(runBundle, "public_run_authority").sha256,
  ]);
  assertEqual("source_bundle_sha256", [
    report.source_bundle_sha256,
    runnerOutputManifest.source_bundle_sha256,
    terminalRunManifest.source_bundle_sha256,
    runBundle.source_bundle_sha256,
    expectedMember(runBundle, "source_bundle").sha256,
  ]);
  assertEqual("harness_bundle_sha256", [
    report.harness_bundle_sha256,
    runnerOutputManifest.harness_bundle_sha256,
    terminalRunManifest.harness_bundle_sha256,
    runBundle.harness_bundle_sha256,
  ]);
  assertEqual("preterminal_payload_set_sha256", [
    preterminalPayloadSetSha256,
    runnerOutputManifest.preterminal_payload_set_sha256,
    terminalRunManifest.preterminal_payload_set_sha256,
    runBundle.preterminal_payload_set_sha256,
  ]);
  assertEqual("source_ref", [
    runnerOutputManifest.source_ref,
    terminalRunManifest.source_ref,
    runBundle.source_ref,
  ]);
  assertEqual("source_commit_id", [
    runnerOutputManifest.source_commit_id,
    terminalRunManifest.source_commit_id,
    runBundle.source_commit_id,
  ]);
  assertEqual("tenant_id", [
    lifecycleAuthorityProjection.tenant_id,
    report.tenant_id,
  ]);
  assertEqual("database_instance_id", [
    lifecycleAuthorityProjection.database_instance_id,
    report.database_instance_id,
  ]);

  const canonicalMembers = [
    ["report", report],
    ["attempt_chain", attemptChain],
    ["runner_output_manifest", runnerOutputManifest],
    ["terminal_run_manifest", terminalRunManifest],
    ["lifecycle_authority_projection", lifecycleAuthorityProjection],
  ] as const;
  for (const [role, value] of canonicalMembers) {
    const member = expectedMember(runBundle, role);
    const bytes = Buffer.byteLength(stableStringify(value), "utf8");
    if (member.byte_length !== bytes) {
      throw new Error(`learning_external_evidence_binding_mismatch:${role}_byte_length`);
    }
  }

  const lastAttempt = attemptChain.attempts.at(-1);
  if ((lastAttempt && lastAttempt.finished_at > attemptChain.sealed_at)
    || attemptChain.sealed_at > report.collected_at
    || report.collected_at !== runnerOutputManifest.collected_at
    || runnerOutputManifest.collected_at > terminalRunManifest.finalized_at
    || terminalRunManifest.finalized_at
      > lifecycleAuthorityProjection.session_termination.terminated_at
    || lifecycleAuthorityProjection.session_termination.terminated_at > runBundle.committed_at) {
    throw new Error("learning_external_evidence_binding_mismatch:lifecycle_time_order");
  }

  return {
    lifecycleAuthorityProjection,
    report,
    attemptChain,
    runnerOutputManifest,
    terminalRunManifest,
    runBundle,
    digests,
  };
}

export const LearningExternalEvidenceIngestRequestV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_evidence_ingest_request_v1"),
  tenant_id: BoundedIdSchema,
  actor_id: BoundedIdSchema,
  operation_id: BoundedIdSchema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  evidence_series_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  applicable_experiment_id: BoundedIdSchema,
  applicable_experiment_revision: PositiveSafeIntegerSchema,
  lifecycle_authority_projection_sha256: DigestSha256Schema,
  public_run_authority_sha256: DigestSha256Schema,
  run_bundle_manifest_sha256: DigestSha256Schema,
  run_bundle_archive_sha256: DigestSha256Schema,
  bundle_commit_id: SourceCommitIdSchema,
}).strict();

export type LearningExternalEvidenceIngestRequestV1 = z.infer<
  typeof LearningExternalEvidenceIngestRequestV1Schema
>;

export function learningExternalEvidenceIngestRequestDigest(value: unknown): string {
  return sha256Canonical(LearningExternalEvidenceIngestRequestV1Schema.parse(value));
}

export const LearningExternalEvidenceArtifactIdentityV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_evidence_artifact_identity_v1"),
  evidence_binding_sha256: DigestSha256Schema,
  artifact_kind: LearningExternalEvidenceArtifactKindSchema,
  artifact_status: LearningExternalEvidenceStatusSchema,
  tenant_id: BoundedIdSchema,
  evidence_series_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  applicable_experiment_id: BoundedIdSchema,
  applicable_experiment_revision: PositiveSafeIntegerSchema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  session_termination_id: BoundedIdSchema,
  session_termination_sha256: DigestSha256Schema,
  report_sha256: DigestSha256Schema,
  attempt_chain_sha256: DigestSha256Schema,
  runner_output_manifest_sha256: DigestSha256Schema,
  terminal_run_manifest_sha256: DigestSha256Schema,
  source_bundle_sha256: DigestSha256Schema,
  harness_bundle_sha256: DigestSha256Schema,
  preterminal_payload_set_sha256: DigestSha256Schema,
}).strict();

export type LearningExternalEvidenceArtifactIdentityV1 = z.infer<
  typeof LearningExternalEvidenceArtifactIdentityV1Schema
>;

export function learningExternalEvidenceArtifactId(value: unknown): string {
  return `lea_${sha256Canonical(LearningExternalEvidenceArtifactIdentityV1Schema.parse(value))}`;
}
