import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";

export const LEARNING_GATE_POLICY_ID = "gate-policy" as const;
export const LEARNING_GATE_POLICY_VERSION = "v1" as const;
export const LEARNING_GATE_POLICY_KEY = "gate-policy-v1" as const;

export type LearningGatePolicyId = typeof LEARNING_GATE_POLICY_ID;
export type LearningGatePolicyVersion = typeof LEARNING_GATE_POLICY_VERSION;
export type LearningGatePolicyKey = typeof LEARNING_GATE_POLICY_KEY;
export type LearningGatePolicyRegistryStatus = "calibration_pending" | "registered";

export type LearningGateRational = Readonly<{
  numerator: number;
  denominator: number;
}>;

export type LearningGateCheckpointKind = "safety_integrity_only" | "confirmatory";
export type LearningGateServingPhase = "aa" | "shadow" | "active_control";
export type LearningGateEvidenceIntent = "integrity_only" | "confirmatory";

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

function rational(numerator: number, denominator: number): LearningGateRational {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new Error("Learning gate rational numerator must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("Learning gate rational denominator must be a positive safe integer");
  }
  return Object.freeze({ numerator, denominator });
}

const GATE_POLICY_CORE_CONFIG = deepFreeze({
  contract_version: "learning_gate_policy_config_v1",
  evidence_intent_by_serving_phase: {
    aa: "integrity_only",
    shadow: "integrity_only",
    active_control: "confirmatory",
  },
  confirmatory_attempt_limit_per_task_family_candidate_implementation: 1,
  assignment_unit: "store_memory_namespace",
  online_assignment_design: "matched_pair_complete_randomization_v1",
  confirmatory_candidate_allocation_bps: 5_000,
  matched_pair_member_count: 2,
  confirmatory_pair_count: 384,
  confirmatory_namespace_count: 768,
  confirmatory_assignment_random_bytes: 48,
  confirmatory_assignment_bit_count: 384,
  confirmatory_assignment_bit_order: "canonical_pair_hash_ascending_bit_zero_first_msb_first",
  confirmatory_randomness_rejection_or_redraw_allowed: false,
  diagnostic_assignment_random_bytes: 32,
  diagnostic_assignment_hash_prefix_bytes: 6,
  diagnostic_assignment_bucket_count: 10_000,
  activation_wave_pair_counts: [96, 96, 192],
  checkpoint_indexes: [1, 2, 3],
  checkpoint_cumulative_matched_pairs: [96, 192, 384],
  checkpoint_kinds: ["safety_integrity_only", "confirmatory", "confirmatory"],
  formal_look_checkpoint_indexes: [2, 3],
  familywise_any_direction_alpha: rational(1, 20),
  directional_family_alpha: rational(1, 40),
  sequential_method: "checkpoint_1_safety_then_2_formal_looks",
  alpha_per_direction_per_formal_look: rational(1, 80),
  checkpoint_1_confirmatory_alpha: rational(0, 1),
  min_conclusive_exploit_clusters_per_arm: 96,
  primary_followup_duration_hours: 24,
  min_distinct_task_signatures: 6,
  min_activation_waves: 2,
  min_feedback_coverage: rational(9, 10),
  offline_paired_case_count: 96,
  max_candidate_exploit_harm_upper: rational(1, 20),
  exploit_harm_noninferiority_margin: rational(1, 20),
  accepted_action_noninferiority_margin: rational(1, 20),
  min_offline_paired_harm_reduction: rational(1, 50),
  max_hard_boundary_violations: 0,
  paired_pre_response_imbalance_threshold: rational(1, 1_000),
  operational_pause_verified_harm_lower_above: rational(1, 20),
  operational_pause_alpha_per_checkpoint: rational(1, 1_000),
  missingness_alone_authority_action: "hold",
  retire_min_independent_demotion_windows: 2,
  retirement_required_complete_waves: 2,
} as const);

export type LearningGatePolicyCoreConfig = typeof GATE_POLICY_CORE_CONFIG;

const GATE_POLICY_IMPLEMENTATION_CONTRACT = deepFreeze({
  contract_version: "learning_gate_policy_implementation_contract_v1",
  gate_policy_id: LEARNING_GATE_POLICY_ID,
  gate_policy_version: LEARNING_GATE_POLICY_VERSION,
  gate_policy_key: LEARNING_GATE_POLICY_KEY,
  finite_population_claim: "frozen_reviewed_namespace_population_only",
  inference_engine: {
    design: "exact_matched_pair_randomization_inversion_v1",
    absolute_risk_kernel: "bounded_binary_potential_outcome_absolute_risk_v1",
    risk_difference_kernel: "bounded_binary_potential_outcome_risk_difference_v1",
    arithmetic: "exact_integer_bigint_v1",
    tail_rule: "inclusive",
    checkpoint_1_authority: "safety_integrity_hold_or_pause_only",
    formal_checkpoint_authority: "intersection_union_confirmatory_v1",
    missing_outcome_rule: "endpoint_specific_worst_case_never_improves_gate",
    assignment_balance_rule: "one_candidate_one_control_per_frozen_pair",
    assignment_randomness_rule: "one_frozen_hidden_bit_per_canonical_pair_no_redraw",
  },
  frozen_config: GATE_POLICY_CORE_CONFIG,
  golden_vectors: [
    {
      checkpoint_index: 1,
      cumulative_matched_pairs: 96,
      checkpoint_kind: "safety_integrity_only",
      confirmatory_alpha_per_direction: rational(0, 1),
      promotion_or_demotion_claim_allowed: false,
    },
    {
      checkpoint_index: 2,
      cumulative_matched_pairs: 192,
      checkpoint_kind: "confirmatory",
      confirmatory_alpha_per_direction: rational(1, 80),
      promotion_or_demotion_claim_allowed: true,
    },
    {
      checkpoint_index: 3,
      cumulative_matched_pairs: 384,
      checkpoint_kind: "confirmatory",
      confirmatory_alpha_per_direction: rational(1, 80),
      promotion_or_demotion_claim_allowed: true,
    },
  ],
  evidence_intent_golden_vectors: [
    { serving_phase: "aa", evidence_intent: "integrity_only", compatible: true },
    { serving_phase: "aa", evidence_intent: "confirmatory", compatible: false },
    { serving_phase: "shadow", evidence_intent: "integrity_only", compatible: true },
    { serving_phase: "shadow", evidence_intent: "confirmatory", compatible: false },
    { serving_phase: "active_control", evidence_intent: "integrity_only", compatible: false },
    { serving_phase: "active_control", evidence_intent: "confirmatory", compatible: true },
  ],
} as const);

export type LearningGatePolicyImplementationContract =
  typeof GATE_POLICY_IMPLEMENTATION_CONTRACT;

const IMPLEMENTATION_CONTRACT_SHA256 = sha256Hex(
  stableStringify(GATE_POLICY_IMPLEMENTATION_CONTRACT),
);

const GATE_POLICY_PROSPECTIVE_CALIBRATION_CONTRACT = deepFreeze({
  contract_version: "learning_gate_policy_prospective_calibration_contract_v1",
  gate_policy_id: LEARNING_GATE_POLICY_ID,
  gate_policy_version: LEARNING_GATE_POLICY_VERSION,
  gate_policy_key: LEARNING_GATE_POLICY_KEY,
  implementation_contract_sha256: IMPLEMENTATION_CONTRACT_SHA256,
  evidence_source: "prospective_outcome_free_scenario_grid",
  candidate_arm_or_live_confirmatory_outcomes_allowed: false,
  required_artifact_status: "passed",
  scenario_classes: ["target_safe", "exploit_harm_detection", "diagnostic_only"],
  required_scenario_dimensions: [
    "control_baseline_risk",
    "candidate_absolute_harm",
    "registered_risk_difference_endpoints",
    "within_pair_concordance",
    "matching_quality",
    "assignment_independent_provider_calendar_shocks",
    "no_index_rate",
    "feedback_coverage_90_through_100_percent",
    "hard_boundary_rate",
    "adversarial_missingness",
  ],
  required_boundary_scenarios: [
    "boundary_nulls",
    "zero_effect",
    "reviewed_target_safe_alternative",
    "harmful_alternatives_at_and_beyond_twice_each_margin",
  ],
  registration_critical_scenario_classes: ["target_safe", "exploit_harm_detection"],
  target_safe_final_joint_promotion_power_lower_bound_at_least: rational(4, 5),
  exploit_harm_union_detection_power_lower_bound_at_least: rational(4, 5),
  target_safe_terminal_hold_probability_upper_bound_at_most: rational(1, 5),
  monte_carlo_confidence_level: rational(99, 100),
  monte_carlo_precision_at_most: rational(1, 100),
  monte_carlo_interval_method: "clopper_pearson_exact_one_sided_v1",
  monte_carlo_decision_arithmetic: "exact_bigint_inclusive_equality_v1",
  deterministic_rng: "philox4x32_10_v1",
  shard_assignment: "disjoint_counter_ranges_v1",
  shard_merge: "canonical_shard_order_bigint_v1",
  exact_enumeration_where_tractable: true,
  production_kernel_parity_required: true,
  reference_runner: {
    vcpu_count: 32,
    max_elapsed_hours: 12,
    max_peak_rss_gib: 32,
  },
  resource_or_precision_failure_action: "remain_calibration_pending",
} as const);

export type LearningGatePolicyProspectiveCalibrationContract =
  typeof GATE_POLICY_PROSPECTIVE_CALIBRATION_CONTRACT;

const PROSPECTIVE_CALIBRATION_CONTRACT_SHA256 = sha256Hex(
  stableStringify(GATE_POLICY_PROSPECTIVE_CALIBRATION_CONTRACT),
);

const GATE_POLICY_CONFIG = deepFreeze({
  ...GATE_POLICY_CORE_CONFIG,
  implementation_contract_sha256: IMPLEMENTATION_CONTRACT_SHA256,
  prospective_calibration_contract_sha256: PROSPECTIVE_CALIBRATION_CONTRACT_SHA256,
  prospective_calibration_artifact_sha256: null,
} as const);

export type LearningGatePolicyConfig = typeof GATE_POLICY_CONFIG;

const POLICY_CONFIG_SHA256 = sha256Hex(stableStringify(GATE_POLICY_CONFIG));

export type LearningGatePolicyRegistryEntry = Readonly<{
  policy_kind: "gate";
  policy_id: LearningGatePolicyId;
  policy_version: LearningGatePolicyVersion;
  registry_key: LearningGatePolicyKey;
  registry_status: LearningGatePolicyRegistryStatus;
  config: LearningGatePolicyConfig;
  policy_config_sha256: string;
  implementation_contract: LearningGatePolicyImplementationContract;
  implementation_contract_sha256: string;
  prospective_calibration_contract: LearningGatePolicyProspectiveCalibrationContract;
  prospective_calibration_contract_sha256: string;
  prospective_calibration_artifact_sha256: string | null;
}>;

const REGISTRY_ENTRY: LearningGatePolicyRegistryEntry = deepFreeze({
  policy_kind: "gate",
  policy_id: LEARNING_GATE_POLICY_ID,
  policy_version: LEARNING_GATE_POLICY_VERSION,
  registry_key: LEARNING_GATE_POLICY_KEY,
  registry_status: "calibration_pending",
  config: GATE_POLICY_CONFIG,
  policy_config_sha256: POLICY_CONFIG_SHA256,
  implementation_contract: GATE_POLICY_IMPLEMENTATION_CONTRACT,
  implementation_contract_sha256: IMPLEMENTATION_CONTRACT_SHA256,
  prospective_calibration_contract: GATE_POLICY_PROSPECTIVE_CALIBRATION_CONTRACT,
  prospective_calibration_contract_sha256: PROSPECTIVE_CALIBRATION_CONTRACT_SHA256,
  prospective_calibration_artifact_sha256: null,
});

function assertCanonicalRegistryEntry(policy: LearningGatePolicyRegistryEntry): void {
  if (
    policy.policy_kind !== "gate"
    || policy.policy_id !== LEARNING_GATE_POLICY_ID
    || policy.policy_version !== LEARNING_GATE_POLICY_VERSION
    || policy.registry_key !== LEARNING_GATE_POLICY_KEY
  ) {
    throw new Error("Learning gate policy registry tuple is not canonical");
  }
  if (
    policy.policy_config_sha256 !== POLICY_CONFIG_SHA256
    || sha256Hex(stableStringify(policy.config)) !== POLICY_CONFIG_SHA256
  ) {
    throw new Error(`Learning gate policy config mismatch for ${LEARNING_GATE_POLICY_KEY}`);
  }
  if (
    policy.implementation_contract_sha256 !== IMPLEMENTATION_CONTRACT_SHA256
    || sha256Hex(stableStringify(policy.implementation_contract)) !== IMPLEMENTATION_CONTRACT_SHA256
  ) {
    throw new Error(`Learning gate policy implementation contract mismatch for ${LEARNING_GATE_POLICY_KEY}`);
  }
  if (
    policy.prospective_calibration_contract_sha256 !== PROSPECTIVE_CALIBRATION_CONTRACT_SHA256
    || sha256Hex(stableStringify(policy.prospective_calibration_contract))
      !== PROSPECTIVE_CALIBRATION_CONTRACT_SHA256
  ) {
    throw new Error(`Learning gate policy calibration contract mismatch for ${LEARNING_GATE_POLICY_KEY}`);
  }
  if (
    policy.config.prospective_calibration_artifact_sha256
      !== policy.prospective_calibration_artifact_sha256
  ) {
    throw new Error(`Learning gate policy calibration artifact mismatch for ${LEARNING_GATE_POLICY_KEY}`);
  }
}

export function resolveLearningGatePolicy(
  policyId: string,
  policyVersion: string,
  expectedConfigSha256?: string | null,
): LearningGatePolicyRegistryEntry {
  if (policyId !== LEARNING_GATE_POLICY_ID || policyVersion !== LEARNING_GATE_POLICY_VERSION) {
    throw new Error(`Unknown learning gate policy tuple: ${policyId}@${policyVersion}`);
  }
  if (expectedConfigSha256 != null && expectedConfigSha256 !== POLICY_CONFIG_SHA256) {
    throw new Error(`Learning gate policy config mismatch for ${policyId}@${policyVersion}`);
  }
  assertCanonicalRegistryEntry(REGISTRY_ENTRY);
  return REGISTRY_ENTRY;
}

export function learningGatePolicyEvidenceIntentCompatible(
  servingPhase: LearningGateServingPhase,
  evidenceIntent: LearningGateEvidenceIntent,
): boolean {
  return GATE_POLICY_CORE_CONFIG.evidence_intent_by_serving_phase[servingPhase]
    === evidenceIntent;
}

export function learningGatePolicyConfigDigest(): string {
  return POLICY_CONFIG_SHA256;
}

export function learningGatePolicyImplementationContractDigest(): string {
  return IMPLEMENTATION_CONTRACT_SHA256;
}

export function learningGatePolicyProspectiveCalibrationContractDigest(): string {
  return PROSPECTIVE_CALIBRATION_CONTRACT_SHA256;
}

export function assertLearningGatePolicyCanProvisionConfirmatory(
  policy: LearningGatePolicyRegistryEntry,
): void {
  assertCanonicalRegistryEntry(policy);
  if (policy.registry_status !== "registered") {
    throw new Error(
      `Learning gate policy ${policy.registry_key} cannot provision confirmatory evidence while registry_status=${policy.registry_status}`,
    );
  }
  if (policy.prospective_calibration_artifact_sha256 == null) {
    throw new Error(
      `Learning gate policy ${policy.registry_key} cannot provision confirmatory evidence without a passing calibration artifact`,
    );
  }
}
