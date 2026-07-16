import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  resolveLearningGatePolicy,
  type LearningGateCheckpointKind,
  type LearningGatePolicyRegistryEntry,
  type LearningGatePolicyRegistryStatus,
} from "../memory/learning-gate-policy.js";
import { confirmatoryMatchedPairAssignment } from
  "../memory/learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";
import {
  assertLiteLearningGateReservationScopedIntegrity,
  learningActivationScheduleDigest,
  learningConfirmatoryAttemptDigest,
  learningGateLookReservationDigest,
  learningGateLookScheduleDigest,
  learningRandomizationPairIdentityDigest,
  learningRandomizationPairManifestDigest,
  learningRandomizationPairRecordDigest,
  type LiteLearningAuthorityRow,
} from "./lite-learning-episode-ledger.js";
import type { SqliteDatabase } from "./sqlite.js";

const TENANT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const HOUR_MILLIS = 60 * 60 * 1_000;

function cohortInvalid(detail: string): never {
  throw new Error(`lite_learning_evidence_cohort_invalid:${detail}`);
}

function isExactUtf8(value: string, maxBytes = 256): boolean {
  return value.length > 0
    && value.trim() === value
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && Buffer.from(value, "utf8").toString("utf8") === value;
}

function isCanonicalUtcMillis(value: string): boolean {
  if (!UTC_MILLIS_PATTERN.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

const ExactIdSchema = z.string().refine((value) => isExactUtf8(value), {
  message: "must be exact bounded control-free UTF-8 text",
});
const TenantIdSchema = z.string().regex(TENANT_ID_PATTERN);
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const CanonicalUtcMillisSchema = z.string().refine(isCanonicalUtcMillis, {
  message: "must be canonical UTC milliseconds",
});
const SafeIntegerSchema = z.number().int().safe();
const NonNegativeIntegerSchema = SafeIntegerSchema.nonnegative();
const PositiveIntegerSchema = SafeIntegerSchema.positive();
const CanonicalJsonTextSchema = z.string().min(2).refine(
  (raw) => Buffer.byteLength(raw, "utf8") <= 524_288,
  { message: "canonical JSON text exceeds the read-model bound" },
);

const GateLookReservationRowSchema = z.object({
  tenant_id: TenantIdSchema,
  reservation_id: ExactIdSchema,
  operation_id: ExactIdSchema,
  task_family: ExactIdSchema,
  candidate_policy_id: ExactIdSchema,
  candidate_policy_version: ExactIdSchema,
  candidate_policy_implementation_sha256: Sha256Schema,
  experiment_id: ExactIdSchema,
  experiment_revision: PositiveIntegerSchema,
  gate_policy_id: ExactIdSchema,
  gate_policy_version: ExactIdSchema,
  gate_policy_config_sha256: Sha256Schema,
  look_schedule_sha256: Sha256Schema,
  randomization_pair_manifest_sha256: Sha256Schema,
  activation_schedule_sha256: Sha256Schema,
  look_index: PositiveIntegerSchema,
  target_cumulative_pair_count: PositiveIntegerSchema,
  analysis_at: CanonicalUtcMillisSchema,
  evidence_cutoff_event_row_id: NonNegativeIntegerSchema,
  evidence_artifact_cutoff_row_id: PositiveIntegerSchema,
  candidate_scheduled_namespace_count: PositiveIntegerSchema,
  control_scheduled_namespace_count: PositiveIntegerSchema,
  candidate_index_exposure_count: NonNegativeIntegerSchema,
  control_index_exposure_count: NonNegativeIntegerSchema,
  candidate_no_index_count: NonNegativeIntegerSchema,
  control_no_index_count: NonNegativeIntegerSchema,
  candidate_verified_receipt_count: NonNegativeIntegerSchema,
  control_verified_receipt_count: NonNegativeIntegerSchema,
  runtime_integrity_artifact_id: ExactIdSchema,
  runtime_integrity_report_sha256: Sha256Schema,
  runtime_integrity_run_bundle_sha256: Sha256Schema,
  required_artifact_heads_sha256: Sha256Schema,
  trigger_basis_sha256: Sha256Schema,
  trigger_basis_json: CanonicalJsonTextSchema,
  reservation_sha256: Sha256Schema,
  created_by: ExactIdSchema,
  created_at: CanonicalUtcMillisSchema,
}).strict();

const PolicyVersionRowSchema = z.object({
  tenant_id: TenantIdSchema,
  policy_kind: z.enum(["candidate", "gate"]),
  policy_id: ExactIdSchema,
  policy_version: ExactIdSchema,
  policy_config_sha256: Sha256Schema,
  policy_config_json: CanonicalJsonTextSchema,
  implementation_contract_sha256: Sha256Schema,
  prospective_calibration_sha256: Sha256Schema.nullable(),
  prospective_calibration_json: CanonicalJsonTextSchema.nullable(),
  created_at: CanonicalUtcMillisSchema,
}).strict();

const ConfirmatoryAttemptRowSchema = z.object({
  tenant_id: TenantIdSchema,
  confirmatory_attempt_id: ExactIdSchema,
  task_family: ExactIdSchema,
  candidate_policy_id: ExactIdSchema,
  candidate_policy_version: ExactIdSchema,
  candidate_policy_implementation_sha256: Sha256Schema,
  experiment_id: ExactIdSchema,
  experiment_revision: PositiveIntegerSchema,
  gate_policy_id: ExactIdSchema,
  gate_policy_version: ExactIdSchema,
  gate_policy_config_sha256: Sha256Schema,
  eligible_memory_namespace_set_sha256: Sha256Schema,
  eligible_memory_namespace_count: PositiveIntegerSchema,
  planned_candidate_namespace_count: PositiveIntegerSchema,
  planned_control_namespace_count: PositiveIntegerSchema,
  randomization_pair_manifest_sha256: Sha256Schema,
  randomization_pair_count: PositiveIntegerSchema,
  activation_schedule_sha256: Sha256Schema,
  attempt_sha256: Sha256Schema,
  created_by: ExactIdSchema,
  created_at: CanonicalUtcMillisSchema,
}).strict();

const ConfirmatoryRevisionRowSchema = z.object({
  tenant_id: TenantIdSchema,
  experiment_id: ExactIdSchema,
  experiment_revision: PositiveIntegerSchema,
  serving_phase: z.literal("active_control"),
  evidence_intent: z.literal("confirmatory"),
  eligible_memory_namespace_set_sha256: Sha256Schema,
  eligible_memory_namespace_count: PositiveIntegerSchema,
  assignment_design: z.literal("matched_pair_complete_randomization_v1"),
  randomization_pair_manifest_sha256: Sha256Schema,
  randomization_pair_count: PositiveIntegerSchema,
  activation_schedule_sha256: Sha256Schema,
  candidate_policy_id: ExactIdSchema,
  candidate_policy_version: ExactIdSchema,
  candidate_policy_implementation_sha256: Sha256Schema,
  candidate_policy_config_sha256: Sha256Schema,
  assignment_unit_kind: z.literal("store_memory_namespace_cluster"),
  candidate_allocation_bps: z.literal(5_000),
  confirmatory_assignment_bits: z.instanceof(Uint8Array),
  confirmatory_assignment_bit_count: PositiveIntegerSchema,
  confirmatory_assignment_bits_sha256: Sha256Schema,
  gate_policy_id: ExactIdSchema,
  gate_policy_version: ExactIdSchema,
  gate_policy_config_sha256: Sha256Schema,
  gate_prospective_calibration_sha256: Sha256Schema,
  safety_pause_mode: z.literal("automatic"),
  config_sha256: Sha256Schema,
  config_json: CanonicalJsonTextSchema,
  created_at: CanonicalUtcMillisSchema,
}).strict();

const RandomizationPairRowSchema = z.object({
  tenant_id: TenantIdSchema,
  confirmatory_attempt_id: ExactIdSchema,
  randomization_pair_sha256: Sha256Schema,
  pair_ordinal: NonNegativeIntegerSchema,
  member_0_memory_namespace_sha256: Sha256Schema,
  member_1_memory_namespace_sha256: Sha256Schema,
  matching_covariate_sha256: Sha256Schema,
  matching_covariate_json: CanonicalJsonTextSchema.refine(
    (raw) => Buffer.byteLength(raw, "utf8") <= 4_096,
    { message: "matching covariate JSON exceeds 4096 bytes" },
  ),
  activation_wave_index: PositiveIntegerSchema,
  activation_starts_at: CanonicalUtcMillisSchema,
  index_window_ends_at: CanonicalUtcMillisSchema,
  wave_analysis_at: CanonicalUtcMillisSchema,
  pair_record_sha256: Sha256Schema,
  created_at: CanonicalUtcMillisSchema,
}).strict();

const NamespaceLeaseRowSchema = z.object({
  tenant_id: TenantIdSchema,
  namespace_lease_id: ExactIdSchema,
  memory_namespace_sha256: Sha256Schema,
  randomization_pair_sha256: Sha256Schema,
  pair_member_ordinal: z.union([z.literal(0), z.literal(1)]),
  assigned_arm: z.enum(["candidate", "control"]),
  activation_wave_index: PositiveIntegerSchema,
  activation_starts_at: CanonicalUtcMillisSchema,
  index_window_ends_at: CanonicalUtcMillisSchema,
  wave_analysis_at: CanonicalUtcMillisSchema,
  lease_generation: PositiveIntegerSchema,
  confirmatory_attempt_id: ExactIdSchema,
  experiment_id: ExactIdSchema,
  experiment_revision: PositiveIntegerSchema,
  namespace_set_sha256: Sha256Schema,
  acquire_operation_id: ExactIdSchema,
  acquired_at: CanonicalUtcMillisSchema,
  status: z.enum(["active", "released"]),
  release_operation_id: ExactIdSchema.nullable(),
  release_ref_kind: z.enum([
    "experiment_close",
    "terminal_authority_adjudication",
  ]).nullable(),
  release_ref_id: ExactIdSchema.nullable(),
  released_at: CanonicalUtcMillisSchema.nullable(),
}).strict();

type GateLookReservationRow = z.infer<typeof GateLookReservationRowSchema>;
type PolicyVersionRow = z.infer<typeof PolicyVersionRowSchema>;
type ConfirmatoryAttemptRow = z.infer<typeof ConfirmatoryAttemptRowSchema>;
type ConfirmatoryRevisionRow = z.infer<typeof ConfirmatoryRevisionRowSchema>;
type RandomizationPairRow = z.infer<typeof RandomizationPairRowSchema>;
type NamespaceLeaseRow = z.infer<typeof NamespaceLeaseRowSchema>;

export type LiteLearningScheduledRiskSetInput = Readonly<{
  db: SqliteDatabase;
  tenantId: string;
  reservationId: string;
}>;

export type LiteLearningScheduledRiskSetUnevaluatedRequirement = Readonly<{
  code:
    | "external_evidence_head_validation_not_evaluated"
    | "pre_response_arrival_freeze_not_evaluated"
    | "interference_attestation_not_evaluated"
    | "feedback_outcome_aggregation_not_evaluated";
  status: "outside_structural_read_model";
  required_layer:
    | "protected_external_evidence_head_validation"
    | "authenticated_pre_response_arrival_freeze"
    | "frozen_interference_attestation"
    | "verified_feedback_outcome_aggregation";
}>;

export type LiteLearningScheduledRiskSetMemberV1 = Readonly<{
  pair_member_ordinal: 0 | 1;
  memory_namespace_sha256: string;
  namespace_lease_id_sha256: string;
  namespace_lease_generation: number;
  assigned_arm: "candidate" | "control";
  historically_active_at_reserved_analysis: true;
}>;

export type LiteLearningScheduledRiskSetPairV1 = Readonly<{
  cohort_pair_ordinal: number;
  source_pair_ordinal: number;
  randomization_pair_sha256: string;
  pair_record_sha256: string;
  matching_covariate_sha256: string;
  activation_wave_index: number;
  activation_starts_at: string;
  index_window_ends_at: string;
  followup_closes_at: string;
  wave_analysis_at: string;
  members: readonly [
    LiteLearningScheduledRiskSetMemberV1,
    LiteLearningScheduledRiskSetMemberV1,
  ];
}>;

export type LiteLearningScheduledRiskSetWaveV1 = Readonly<{
  activation_wave_index: number;
  activation_starts_at: string;
  index_window_ends_at: string;
  followup_closes_at: string;
  wave_analysis_at: string;
  pair_count: number;
  cumulative_pair_count: number;
  primary_followup_duration_hours: number;
  followup_closed_before_analysis: true;
}>;

export type LiteLearningScheduledRiskSetV1 = Readonly<{
  contract_version: "aionis_lite_learning_scheduled_risk_set_v1";
  reservation_binding: Readonly<{
    tenant_id: string;
    reservation_id: string;
    reservation_sha256: string;
    operation_id: string;
    task_family: string;
    candidate_policy_id: string;
    candidate_policy_version: string;
    candidate_policy_implementation_sha256: string;
    experiment_id: string;
    experiment_revision: number;
    confirmatory_attempt_id: string;
    confirmatory_attempt_sha256: string;
    gate_policy_id: string;
    gate_policy_version: string;
    gate_policy_config_sha256: string;
    look_schedule_sha256: string;
    randomization_pair_manifest_sha256: string;
    activation_schedule_sha256: string;
  }>;
  checkpoint: Readonly<{
    look_index: number;
    checkpoint_kind: LearningGateCheckpointKind;
    target_cumulative_pair_count: number;
    analysis_at: string;
    reservation_created_at: string;
    evidence_cutoff_event_row_id: number;
    evidence_artifact_cutoff_row_id: number;
    primary_followup_duration_hours: number;
    outcome_fields_included: false;
  }>;
  design: Readonly<{
    assignment_design: "matched_pair_complete_randomization_v1";
    assignment_unit_kind: "store_memory_namespace_cluster";
    eligible_memory_namespace_set_sha256: string;
    full_pair_count: number;
    scheduled_pair_count: number;
    scheduled_candidate_namespace_count: number;
    scheduled_control_namespace_count: number;
    pair_order: "source_pair_ordinal_ascending";
    risk_set_rule: "all_preregistered_pairs_in_complete_waves_through_reserved_checkpoint";
  }>;
  waves: readonly LiteLearningScheduledRiskSetWaveV1[];
  pairs: readonly LiteLearningScheduledRiskSetPairV1[];
}>;

export type LiteLearningScheduledRiskSetInspectionV1 = Readonly<{
  contract_version: "aionis_lite_learning_scheduled_risk_set_inspection_v1";
  read_model_only: true;
  structural_status: "reconstructed_non_authority_preview";
  source_integrity: Readonly<{
    scope: "reservation_bound_runtime_prefix_and_confirmatory_lease_lifecycle";
    verified: true;
  }>;
  policy_registration: Readonly<{
    registry_status: LearningGatePolicyRegistryStatus;
    registry_calibration_artifact_sha256: string | null;
    stored_calibration_artifact_sha256: string;
    exact_registry_calibration_binding: boolean;
  }>;
  production_authority_eligible: false;
  authority_mutation: false;
  authority_action: null;
  scheduled_risk_set: LiteLearningScheduledRiskSetV1;
  scheduled_risk_set_sha256: string;
  unevaluated_requirements:
    readonly LiteLearningScheduledRiskSetUnevaluatedRequirement[];
  result_sha256: string;
}>;

const UNEVALUATED_REQUIREMENTS:
readonly LiteLearningScheduledRiskSetUnevaluatedRequirement[] = deepFreeze([
  {
    code: "external_evidence_head_validation_not_evaluated",
    status: "outside_structural_read_model",
    required_layer: "protected_external_evidence_head_validation",
  },
  {
    code: "pre_response_arrival_freeze_not_evaluated",
    status: "outside_structural_read_model",
    required_layer: "authenticated_pre_response_arrival_freeze",
  },
  {
    code: "interference_attestation_not_evaluated",
    status: "outside_structural_read_model",
    required_layer: "frozen_interference_attestation",
  },
  {
    code: "feedback_outcome_aggregation_not_evaluated",
    status: "outside_structural_read_model",
    required_layer: "verified_feedback_outcome_aggregation",
  },
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(raw: string, field: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cohortInvalid(`${field}_not_json`);
  }
  if (stableStringify(parsed) !== raw) cohortInvalid(`${field}_not_canonical`);
  return parsed;
}

function canonicalJsonObject(raw: string, field: string): Record<string, unknown> {
  const parsed = canonicalJson(raw, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    cohortInvalid(`${field}_not_object`);
  }
  return parsed as Record<string, unknown>;
}

function parseRow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) cohortInvalid(`${label}_row_shape`);
  return parsed.data;
}

function selectExactlyOne<T>(args: {
  db: SqliteDatabase;
  sql: string;
  params: readonly unknown[];
  schema: z.ZodType<T>;
  label: string;
}): T {
  const rows = args.db.prepare(args.sql).all(...args.params);
  if (rows.length !== 1) cohortInvalid(`${args.label}_requires_exactly_one_row`);
  return parseRow(args.schema, rows[0], args.label);
}

function readDataVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA data_version").get() as Record<string, unknown> | undefined;
  const values = row === undefined ? [] : Object.values(row);
  if (values.length !== 1 || typeof values[0] !== "number"
    || !Number.isSafeInteger(values[0]) || values[0] < 0) {
    cohortInvalid("sqlite_data_version_unavailable");
  }
  return values[0];
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right;
}

function assertBindings(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (!sameValue(actual[field], expectedValue)) cohortInvalid(`${label}_${field}_mismatch`);
  }
}

function authorityRow(value: object): LiteLearningAuthorityRow {
  return value as unknown as LiteLearningAuthorityRow;
}

function compareCanonicalText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateCanonicalJsonDigest(raw: string, digest: string, field: string): unknown {
  const parsed = canonicalJson(raw, field);
  if (sha256Hex(raw) !== digest) cohortInvalid(`${field}_digest_mismatch`);
  return parsed;
}

function loadReservation(
  db: SqliteDatabase,
  tenantId: string,
  reservationId: string,
): GateLookReservationRow {
  const row = selectExactlyOne({
    db,
    sql: `SELECT tenant_id, reservation_id, operation_id, task_family,
                 candidate_policy_id, candidate_policy_version,
                 candidate_policy_implementation_sha256, experiment_id,
                 experiment_revision, gate_policy_id, gate_policy_version,
                 gate_policy_config_sha256, look_schedule_sha256,
                 randomization_pair_manifest_sha256, activation_schedule_sha256,
                 look_index, target_cumulative_pair_count, analysis_at,
                 evidence_cutoff_event_row_id, evidence_artifact_cutoff_row_id,
                 candidate_scheduled_namespace_count,
                 control_scheduled_namespace_count,
                 candidate_index_exposure_count, control_index_exposure_count,
                 candidate_no_index_count, control_no_index_count,
                 candidate_verified_receipt_count,
                 control_verified_receipt_count, runtime_integrity_artifact_id,
                 runtime_integrity_report_sha256,
                 runtime_integrity_run_bundle_sha256,
                 required_artifact_heads_sha256, trigger_basis_sha256,
                 trigger_basis_json, reservation_sha256, created_by, created_at
          FROM lite_learning_gate_look_reservations
          WHERE tenant_id = ? AND reservation_id = ?`,
    params: [tenantId, reservationId],
    schema: GateLookReservationRowSchema,
    label: "look_reservation",
  });
  if (row.tenant_id !== tenantId || row.reservation_id !== reservationId) {
    cohortInvalid("look_reservation_input_binding_mismatch");
  }
  validateCanonicalJsonDigest(
    row.trigger_basis_json,
    row.trigger_basis_sha256,
    "look_reservation_trigger_basis",
  );
  if (learningGateLookReservationDigest(authorityRow(row)) !== row.reservation_sha256) {
    cohortInvalid("look_reservation_digest_mismatch");
  }
  if (row.candidate_scheduled_namespace_count !== row.target_cumulative_pair_count
    || row.control_scheduled_namespace_count !== row.target_cumulative_pair_count) {
    cohortInvalid("look_reservation_scheduled_count_mismatch");
  }
  if (row.analysis_at > row.created_at) cohortInvalid("look_reservation_pre_analysis");
  return row;
}

type RegisteredCheckpoint = Readonly<{
  position: number;
  lookIndex: number;
  targetPairCount: number;
  checkpointKind: LearningGateCheckpointKind;
}>;

type GatePolicyBinding = Readonly<{
  registered: LearningGatePolicyRegistryEntry;
  stored: PolicyVersionRow;
  checkpoint: RegisteredCheckpoint;
}>;

function registeredCheckpoint(
  policy: LearningGatePolicyRegistryEntry,
  reservation: GateLookReservationRow,
): RegisteredCheckpoint {
  const { config } = policy;
  const lengths = [
    config.activation_wave_pair_counts.length,
    config.checkpoint_indexes.length,
    config.checkpoint_cumulative_matched_pairs.length,
    config.checkpoint_kinds.length,
  ];
  if (new Set(lengths).size !== 1 || lengths[0] === 0) {
    cohortInvalid("gate_policy_checkpoint_schedule_shape");
  }
  let cumulative = 0;
  const checkpoints = config.checkpoint_indexes.map((lookIndex, position) => {
    const waveCount = config.activation_wave_pair_counts[position];
    const target = config.checkpoint_cumulative_matched_pairs[position];
    const kind = config.checkpoint_kinds[position];
    if (lookIndex !== position + 1 || waveCount === undefined || target === undefined
      || kind === undefined || !Number.isSafeInteger(waveCount) || waveCount <= 0) {
      cohortInvalid("gate_policy_checkpoint_schedule_not_canonical");
    }
    cumulative += waveCount;
    if (target !== cumulative) cohortInvalid("gate_policy_checkpoint_target_not_cumulative");
    return {
      position,
      lookIndex,
      targetPairCount: target,
      checkpointKind: kind,
    };
  });
  const checkpoint = checkpoints.find(({ lookIndex }) => lookIndex === reservation.look_index);
  if (!checkpoint) cohortInvalid("look_reservation_index_not_registered");
  if (checkpoint.targetPairCount !== reservation.target_cumulative_pair_count) {
    cohortInvalid("look_reservation_target_not_registered");
  }
  return checkpoint;
}

function loadGatePolicyBinding(
  db: SqliteDatabase,
  reservation: GateLookReservationRow,
): GatePolicyBinding {
  const registered = resolveLearningGatePolicy(
    reservation.gate_policy_id,
    reservation.gate_policy_version,
  );
  const stored = selectExactlyOne({
    db,
    sql: `SELECT tenant_id, policy_kind, policy_id, policy_version,
                 policy_config_sha256, policy_config_json,
                 implementation_contract_sha256,
                 prospective_calibration_sha256,
                 prospective_calibration_json, created_at
          FROM lite_learning_policy_versions
          WHERE tenant_id = ? AND policy_kind = 'gate'
            AND policy_id = ? AND policy_version = ?`,
    params: [
      reservation.tenant_id,
      reservation.gate_policy_id,
      reservation.gate_policy_version,
    ],
    schema: PolicyVersionRowSchema,
    label: "gate_policy",
  });
  const config = validateCanonicalJsonDigest(
    stored.policy_config_json,
    stored.policy_config_sha256,
    "gate_policy_config",
  );
  if (stored.policy_kind !== "gate" || stored.prospective_calibration_sha256 === null
    || stored.prospective_calibration_json === null) {
    cohortInvalid("gate_policy_calibration_missing");
  }
  const calibration = validateCanonicalJsonDigest(
    stored.prospective_calibration_json,
    stored.prospective_calibration_sha256,
    "gate_policy_calibration",
  );
  if (calibration === null || typeof calibration !== "object" || Array.isArray(calibration)
    || (calibration as Record<string, unknown>).status !== "passed") {
    cohortInvalid("gate_policy_calibration_not_passed");
  }
  const expectedConfig = {
    ...registered.config,
    prospective_calibration_artifact_sha256: stored.prospective_calibration_sha256,
  };
  if (stableStringify(config) !== stableStringify(expectedConfig)
    || stored.implementation_contract_sha256 !== registered.implementation_contract_sha256
    || stored.policy_config_sha256 !== reservation.gate_policy_config_sha256) {
    cohortInvalid("gate_policy_registered_binding_mismatch");
  }
  if (registered.prospective_calibration_artifact_sha256 !== null
    && registered.prospective_calibration_artifact_sha256
      !== stored.prospective_calibration_sha256) {
    cohortInvalid("gate_policy_registry_calibration_mismatch");
  }
  if (reservation.look_schedule_sha256 !== learningGateLookScheduleDigest()) {
    cohortInvalid("look_reservation_schedule_digest_mismatch");
  }
  return {
    registered,
    stored,
    checkpoint: registeredCheckpoint(registered, reservation),
  };
}

type AttemptRevisionBinding = Readonly<{
  attempt: ConfirmatoryAttemptRow;
  revision: ConfirmatoryRevisionRow;
  assignmentBits: Uint8Array;
  provisionOperationIdSha256: string;
}>;

function loadAttemptRevisionBinding(
  db: SqliteDatabase,
  reservation: GateLookReservationRow,
  gate: GatePolicyBinding,
): AttemptRevisionBinding {
  const attempt = selectExactlyOne({
    db,
    sql: `SELECT tenant_id, confirmatory_attempt_id, task_family,
                 candidate_policy_id, candidate_policy_version,
                 candidate_policy_implementation_sha256, experiment_id,
                 experiment_revision, gate_policy_id, gate_policy_version,
                 gate_policy_config_sha256,
                 eligible_memory_namespace_set_sha256,
                 eligible_memory_namespace_count,
                 planned_candidate_namespace_count,
                 planned_control_namespace_count,
                 randomization_pair_manifest_sha256, randomization_pair_count,
                 activation_schedule_sha256, attempt_sha256, created_by, created_at
          FROM lite_learning_confirmatory_attempts
          WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    params: [reservation.tenant_id, reservation.experiment_id, reservation.experiment_revision],
    schema: ConfirmatoryAttemptRowSchema,
    label: "confirmatory_attempt",
  });
  if (learningConfirmatoryAttemptDigest(authorityRow(attempt)) !== attempt.attempt_sha256) {
    cohortInvalid("confirmatory_attempt_digest_mismatch");
  }
  assertBindings(attempt, {
    tenant_id: reservation.tenant_id,
    task_family: reservation.task_family,
    candidate_policy_id: reservation.candidate_policy_id,
    candidate_policy_version: reservation.candidate_policy_version,
    candidate_policy_implementation_sha256:
      reservation.candidate_policy_implementation_sha256,
    experiment_id: reservation.experiment_id,
    experiment_revision: reservation.experiment_revision,
    gate_policy_id: reservation.gate_policy_id,
    gate_policy_version: reservation.gate_policy_version,
    gate_policy_config_sha256: reservation.gate_policy_config_sha256,
    randomization_pair_manifest_sha256:
      reservation.randomization_pair_manifest_sha256,
    activation_schedule_sha256: reservation.activation_schedule_sha256,
  }, "confirmatory_attempt_reservation_binding");
  const config = gate.registered.config;
  if (attempt.eligible_memory_namespace_count !== config.confirmatory_namespace_count
    || attempt.planned_candidate_namespace_count !== config.confirmatory_pair_count
    || attempt.planned_control_namespace_count !== config.confirmatory_pair_count
    || attempt.randomization_pair_count !== config.confirmatory_pair_count) {
    cohortInvalid("confirmatory_attempt_registered_design_mismatch");
  }
  const revision = selectExactlyOne({
    db,
    sql: `SELECT tenant_id, experiment_id, experiment_revision, serving_phase,
                 evidence_intent, eligible_memory_namespace_set_sha256,
                 eligible_memory_namespace_count, assignment_design,
                 randomization_pair_manifest_sha256, randomization_pair_count,
                 activation_schedule_sha256, candidate_policy_id,
                 candidate_policy_version,
                 candidate_policy_implementation_sha256,
                 candidate_policy_config_sha256, assignment_unit_kind,
                 candidate_allocation_bps, confirmatory_assignment_bits,
                 confirmatory_assignment_bit_count,
                 confirmatory_assignment_bits_sha256, gate_policy_id,
                 gate_policy_version, gate_policy_config_sha256,
                 gate_prospective_calibration_sha256, safety_pause_mode,
                 config_sha256, config_json, created_at
          FROM lite_learning_experiment_revisions
          WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    params: [reservation.tenant_id, reservation.experiment_id, reservation.experiment_revision],
    schema: ConfirmatoryRevisionRowSchema,
    label: "confirmatory_revision",
  });
  assertBindings(revision, {
    tenant_id: attempt.tenant_id,
    experiment_id: attempt.experiment_id,
    experiment_revision: attempt.experiment_revision,
    eligible_memory_namespace_set_sha256: attempt.eligible_memory_namespace_set_sha256,
    eligible_memory_namespace_count: attempt.eligible_memory_namespace_count,
    randomization_pair_manifest_sha256: attempt.randomization_pair_manifest_sha256,
    randomization_pair_count: attempt.randomization_pair_count,
    activation_schedule_sha256: attempt.activation_schedule_sha256,
    candidate_policy_id: attempt.candidate_policy_id,
    candidate_policy_version: attempt.candidate_policy_version,
    candidate_policy_implementation_sha256:
      attempt.candidate_policy_implementation_sha256,
    gate_policy_id: attempt.gate_policy_id,
    gate_policy_version: attempt.gate_policy_version,
    gate_policy_config_sha256: attempt.gate_policy_config_sha256,
    gate_prospective_calibration_sha256: gate.stored.prospective_calibration_sha256,
    created_at: attempt.created_at,
  }, "confirmatory_revision_attempt_binding");
  const revisionConfig = canonicalJsonObject(
    revision.config_json,
    "confirmatory_revision_config",
  );
  if (sha256Hex(revision.config_json) !== revision.config_sha256) {
    cohortInvalid("confirmatory_revision_config_digest_mismatch");
  }
  assertBindings(revisionConfig, {
    task_family: reservation.task_family,
    namespace_set_sha256: attempt.eligible_memory_namespace_set_sha256,
    pair_manifest_sha256: attempt.randomization_pair_manifest_sha256,
    activation_schedule_sha256: attempt.activation_schedule_sha256,
    gate_prospective_calibration_sha256: gate.stored.prospective_calibration_sha256,
  }, "confirmatory_revision_config_binding");
  const provisionOperationIdSha256 = revisionConfig.provision_operation_id_sha256;
  const provisioningActorSha256 = revisionConfig.provisioning_actor_sha256;
  if (typeof provisionOperationIdSha256 !== "string"
    || !SHA256_PATTERN.test(provisionOperationIdSha256)
    || typeof provisioningActorSha256 !== "string"
    || !SHA256_PATTERN.test(provisioningActorSha256)
    || sha256Hex(attempt.created_by) !== provisioningActorSha256) {
    cohortInvalid("confirmatory_revision_provision_authority_binding");
  }
  const assignmentBits = revision.confirmatory_assignment_bits;
  if (assignmentBits.byteLength !== gate.registered.config.confirmatory_assignment_random_bytes
    || revision.confirmatory_assignment_bit_count
      !== gate.registered.config.confirmatory_assignment_bit_count
    || bytesSha256(assignmentBits) !== revision.confirmatory_assignment_bits_sha256) {
    cohortInvalid("confirmatory_assignment_bits_binding_mismatch");
  }
  loadCandidatePolicyBinding(db, revision, attempt.created_at);
  if (gate.stored.created_at > attempt.created_at) cohortInvalid("gate_policy_registered_too_late");
  return { attempt, revision, assignmentBits, provisionOperationIdSha256 };
}

function loadCandidatePolicyBinding(
  db: SqliteDatabase,
  revision: ConfirmatoryRevisionRow,
  provisionedAt: string,
): void {
  const candidate = selectExactlyOne({
    db,
    sql: `SELECT tenant_id, policy_kind, policy_id, policy_version,
                 policy_config_sha256, policy_config_json,
                 implementation_contract_sha256,
                 prospective_calibration_sha256,
                 prospective_calibration_json, created_at
          FROM lite_learning_policy_versions
          WHERE tenant_id = ? AND policy_kind = 'candidate'
            AND policy_id = ? AND policy_version = ?`,
    params: [revision.tenant_id, revision.candidate_policy_id, revision.candidate_policy_version],
    schema: PolicyVersionRowSchema,
    label: "candidate_policy",
  });
  validateCanonicalJsonDigest(
    candidate.policy_config_json,
    candidate.policy_config_sha256,
    "candidate_policy_config",
  );
  if (candidate.policy_kind !== "candidate"
    || candidate.prospective_calibration_sha256 !== null
    || candidate.prospective_calibration_json !== null
    || candidate.policy_config_sha256 !== revision.candidate_policy_config_sha256
    || candidate.implementation_contract_sha256
      !== revision.candidate_policy_implementation_sha256) {
    cohortInvalid("candidate_policy_registered_binding_mismatch");
  }
  if (candidate.created_at > provisionedAt) cohortInvalid("candidate_policy_registered_too_late");
}

type FrozenWave = LiteLearningScheduledRiskSetWaveV1;

function loadRandomizationPairs(
  db: SqliteDatabase,
  binding: AttemptRevisionBinding,
  gate: GatePolicyBinding,
  reservation: GateLookReservationRow,
): { pairs: RandomizationPairRow[]; waves: FrozenWave[] } {
  const rawRows = db.prepare(
    `SELECT tenant_id, confirmatory_attempt_id, randomization_pair_sha256,
            pair_ordinal, member_0_memory_namespace_sha256,
            member_1_memory_namespace_sha256, matching_covariate_sha256,
            matching_covariate_json, activation_wave_index,
            activation_starts_at, index_window_ends_at, wave_analysis_at,
            pair_record_sha256, created_at
     FROM lite_learning_randomization_pairs
     WHERE tenant_id = ? AND confirmatory_attempt_id = ?
     ORDER BY pair_ordinal`,
  ).all(binding.attempt.tenant_id, binding.attempt.confirmatory_attempt_id);
  const pairs = rawRows.map((row, index) => parseRow(
    RandomizationPairRowSchema,
    row,
    `randomization_pair_${index}`,
  ));
  if (pairs.length !== gate.registered.config.confirmatory_pair_count) {
    cohortInvalid("randomization_pair_count_mismatch");
  }
  const namespaceHashes = new Set<string>();
  const waveRows = new Map<number, RandomizationPairRow[]>();
  for (const [index, pair] of pairs.entries()) {
    assertRandomizationPair(
      pair,
      index,
      pairs[index - 1]?.randomization_pair_sha256,
      binding,
      namespaceHashes,
    );
    const rows = waveRows.get(pair.activation_wave_index) ?? [];
    rows.push(pair);
    waveRows.set(pair.activation_wave_index, rows);
  }
  const manifestSha256 = learningRandomizationPairManifestDigest(pairs.map(authorityRow));
  const activationSha256 = learningActivationScheduleDigest(pairs.map(authorityRow));
  if (manifestSha256 !== binding.attempt.randomization_pair_manifest_sha256
    || manifestSha256 !== reservation.randomization_pair_manifest_sha256
    || activationSha256 !== binding.attempt.activation_schedule_sha256
    || activationSha256 !== reservation.activation_schedule_sha256) {
    cohortInvalid("randomization_manifest_or_activation_digest_mismatch");
  }
  const waves = freezeWaves(waveRows, binding, gate);
  const checkpointWave = waves[gate.checkpoint.position];
  if (!checkpointWave || checkpointWave.cumulative_pair_count !== gate.checkpoint.targetPairCount
    || checkpointWave.wave_analysis_at !== reservation.analysis_at) {
    cohortInvalid("look_reservation_wave_checkpoint_mismatch");
  }
  return { pairs, waves };
}

function assertRandomizationPair(
  pair: RandomizationPairRow,
  index: number,
  previousPairHash: string | undefined,
  binding: AttemptRevisionBinding,
  namespaceHashes: Set<string>,
): void {
  if (pair.pair_ordinal !== index
    || (previousPairHash !== undefined
      && compareCanonicalText(pair.randomization_pair_sha256, previousPairHash) <= 0)) {
    cohortInvalid("randomization_pair_ordinal_not_canonical_hash_order");
  }
  assertBindings(pair, {
    tenant_id: binding.attempt.tenant_id,
    confirmatory_attempt_id: binding.attempt.confirmatory_attempt_id,
    created_at: binding.attempt.created_at,
  }, "randomization_pair_attempt_binding");
  for (const namespace of [
    pair.member_0_memory_namespace_sha256,
    pair.member_1_memory_namespace_sha256,
  ]) {
    if (namespaceHashes.has(namespace)) cohortInvalid("randomization_pair_namespace_reused");
    namespaceHashes.add(namespace);
  }
  validateCanonicalJsonDigest(
    pair.matching_covariate_json,
    pair.matching_covariate_sha256,
    "matching_covariate",
  );
  if (learningRandomizationPairIdentityDigest(authorityRow(pair))
      !== pair.randomization_pair_sha256
    || learningRandomizationPairRecordDigest(authorityRow(pair))
      !== pair.pair_record_sha256) {
    cohortInvalid("randomization_pair_digest_mismatch");
  }
  if (!(pair.activation_starts_at < pair.index_window_ends_at
    && pair.index_window_ends_at < pair.wave_analysis_at)) {
    cohortInvalid("randomization_pair_wave_not_monotone");
  }
}

function freezeWaves(
  waveRows: ReadonlyMap<number, readonly RandomizationPairRow[]>,
  binding: AttemptRevisionBinding,
  gate: GatePolicyBinding,
): FrozenWave[] {
  const config = gate.registered.config;
  let cumulative = 0;
  const waves = config.activation_wave_pair_counts.map((expectedCount, position) => {
    const waveIndex = position + 1;
    const rows = waveRows.get(waveIndex);
    if (!rows || rows.length !== expectedCount) cohortInvalid("activation_wave_pair_count_mismatch");
    const first = rows[0];
    if (!first || rows.some((row) => row.activation_starts_at !== first.activation_starts_at
      || row.index_window_ends_at !== first.index_window_ends_at
      || row.wave_analysis_at !== first.wave_analysis_at)) {
      cohortInvalid("activation_wave_schedule_not_uniform");
    }
    const followupMillis = config.primary_followup_duration_hours * HOUR_MILLIS;
    const followupClosesAt = new Date(
      Date.parse(first.index_window_ends_at) + followupMillis,
    ).toISOString();
    if (first.wave_analysis_at < followupClosesAt) {
      cohortInvalid("activation_wave_primary_followup_not_closed");
    }
    cumulative += rows.length;
    return {
      activation_wave_index: waveIndex,
      activation_starts_at: first.activation_starts_at,
      index_window_ends_at: first.index_window_ends_at,
      followup_closes_at: followupClosesAt,
      wave_analysis_at: first.wave_analysis_at,
      pair_count: rows.length,
      cumulative_pair_count: cumulative,
      primary_followup_duration_hours: config.primary_followup_duration_hours,
      followup_closed_before_analysis: true as const,
    };
  });
  if (!waves[0] || binding.attempt.created_at >= waves[0].activation_starts_at) {
    cohortInvalid("activation_wave_started_before_provisioning");
  }
  for (let index = 1; index < waves.length; index += 1) {
    if (waves[index - 1]!.wave_analysis_at >= waves[index]!.activation_starts_at) {
      cohortInvalid("activation_waves_overlap");
    }
  }
  return waves;
}

function loadNamespaceLeases(
  db: SqliteDatabase,
  binding: AttemptRevisionBinding,
  pairs: readonly RandomizationPairRow[],
  gate: GatePolicyBinding,
  reservation: GateLookReservationRow,
): Map<string, readonly [NamespaceLeaseRow, NamespaceLeaseRow]> {
  const rawRows = db.prepare(
    `SELECT lease.tenant_id, lease.namespace_lease_id,
            lease.memory_namespace_sha256, lease.randomization_pair_sha256,
            lease.pair_member_ordinal, lease.assigned_arm,
            lease.activation_wave_index, lease.activation_starts_at,
            lease.index_window_ends_at, lease.wave_analysis_at,
            lease.lease_generation, lease.confirmatory_attempt_id,
            lease.experiment_id, lease.experiment_revision,
            lease.namespace_set_sha256, lease.acquire_operation_id,
            lease.acquired_at, lease.status, lease.release_operation_id,
            lease.release_ref_kind, lease.release_ref_id, lease.released_at
     FROM lite_learning_namespace_leases AS lease
     JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = lease.tenant_id
      AND pair_row.confirmatory_attempt_id = lease.confirmatory_attempt_id
      AND pair_row.randomization_pair_sha256 = lease.randomization_pair_sha256
     WHERE lease.tenant_id = ? AND lease.confirmatory_attempt_id = ?
     ORDER BY pair_row.pair_ordinal, lease.pair_member_ordinal`,
  ).all(binding.attempt.tenant_id, binding.attempt.confirmatory_attempt_id);
  const leases = rawRows.map((row, index) => parseRow(
    NamespaceLeaseRowSchema,
    row,
    `namespace_lease_${index}`,
  ));
  if (leases.length !== gate.registered.config.confirmatory_namespace_count) {
    cohortInvalid("namespace_lease_count_mismatch");
  }
  const pairByHash = new Map(pairs.map((pair) => [pair.randomization_pair_sha256, pair]));
  const grouped = new Map<string, NamespaceLeaseRow[]>();
  const namespaces = new Set<string>();
  const leaseIds = new Set<string>();
  const acquireOperations = new Set<string>();
  for (const lease of leases) {
    const pair = pairByHash.get(lease.randomization_pair_sha256);
    if (!pair) cohortInvalid("namespace_lease_unknown_pair");
    assertNamespaceLease(lease, pair, binding, reservation);
    if (namespaces.has(lease.memory_namespace_sha256)
      || leaseIds.has(lease.namespace_lease_id)) {
      cohortInvalid("namespace_lease_identity_reused");
    }
    namespaces.add(lease.memory_namespace_sha256);
    leaseIds.add(lease.namespace_lease_id);
    acquireOperations.add(lease.acquire_operation_id);
    const members = grouped.get(lease.randomization_pair_sha256) ?? [];
    members.push(lease);
    grouped.set(lease.randomization_pair_sha256, members);
  }
  if (acquireOperations.size !== 1
    || sha256Hex([...acquireOperations][0] ?? "") !== binding.provisionOperationIdSha256) {
    cohortInvalid("namespace_lease_acquire_operation_binding_mismatch");
  }
  if (sha256Hex(stableStringify([...namespaces].sort(compareCanonicalText)))
    !== binding.attempt.eligible_memory_namespace_set_sha256) {
    cohortInvalid("namespace_lease_namespace_set_digest_mismatch");
  }
  const complete = new Map<string, readonly [NamespaceLeaseRow, NamespaceLeaseRow]>();
  for (const pair of pairs) {
    const members = grouped.get(pair.randomization_pair_sha256);
    if (!members || members.length !== 2 || members[0]?.pair_member_ordinal !== 0
      || members[1]?.pair_member_ordinal !== 1
      || members[0].assigned_arm === members[1].assigned_arm) {
      cohortInvalid("namespace_lease_pair_not_complete_balanced");
    }
    complete.set(pair.randomization_pair_sha256, [members[0], members[1]]);
  }
  return complete;
}

function assertNamespaceLease(
  lease: NamespaceLeaseRow,
  pair: RandomizationPairRow,
  binding: AttemptRevisionBinding,
  reservation: GateLookReservationRow,
): void {
  const memberField = lease.pair_member_ordinal === 0
    ? "member_0_memory_namespace_sha256"
    : "member_1_memory_namespace_sha256";
  assertBindings(lease, {
    tenant_id: binding.attempt.tenant_id,
    memory_namespace_sha256: pair[memberField],
    randomization_pair_sha256: pair.randomization_pair_sha256,
    activation_wave_index: pair.activation_wave_index,
    activation_starts_at: pair.activation_starts_at,
    index_window_ends_at: pair.index_window_ends_at,
    wave_analysis_at: pair.wave_analysis_at,
    confirmatory_attempt_id: binding.attempt.confirmatory_attempt_id,
    experiment_id: binding.attempt.experiment_id,
    experiment_revision: binding.attempt.experiment_revision,
    namespace_set_sha256: binding.attempt.eligible_memory_namespace_set_sha256,
    acquired_at: binding.attempt.created_at,
  }, "namespace_lease_binding");
  const expectedAssignment = confirmatoryMatchedPairAssignment({
    assignmentRandomBits: binding.assignmentBits,
    canonicalPairOrdinal: pair.pair_ordinal,
    pairMemberOrdinal: lease.pair_member_ordinal,
  });
  if (lease.assigned_arm !== expectedAssignment.arm) {
    cohortInvalid("namespace_lease_assignment_bit_mismatch");
  }
  const releaseFields = [
    lease.release_operation_id,
    lease.release_ref_kind,
    lease.release_ref_id,
    lease.released_at,
  ];
  if ((lease.status === "active" && releaseFields.some((value) => value !== null))
    || (lease.status === "released" && releaseFields.some((value) => value === null))) {
    cohortInvalid("namespace_lease_release_shape_mismatch");
  }
  if (lease.released_at !== null && lease.released_at < lease.acquired_at) {
    cohortInvalid("namespace_lease_released_before_acquisition");
  }
  if (pair.activation_wave_index <= reservation.look_index
    && (lease.acquired_at > reservation.analysis_at
      || (lease.released_at !== null && lease.released_at <= reservation.analysis_at))) {
    cohortInvalid("namespace_lease_not_active_at_reserved_analysis");
  }
}

function buildRiskSet(args: {
  reservation: GateLookReservationRow;
  gate: GatePolicyBinding;
  binding: AttemptRevisionBinding;
  pairs: readonly RandomizationPairRow[];
  waves: readonly FrozenWave[];
  leases: ReadonlyMap<string, readonly [NamespaceLeaseRow, NamespaceLeaseRow]>;
}): LiteLearningScheduledRiskSetV1 {
  const includedWaveIndexes = new Set(
    args.waves.slice(0, args.gate.checkpoint.position + 1)
      .map(({ activation_wave_index: wave }) => wave),
  );
  const selectedPairs = args.pairs.filter(
    (pair) => includedWaveIndexes.has(pair.activation_wave_index),
  );
  if (selectedPairs.length !== args.gate.checkpoint.targetPairCount) {
    cohortInvalid("scheduled_risk_set_pair_count_mismatch");
  }
  const pairs = selectedPairs.map((pair, cohortPairOrdinal) => {
    const leases = args.leases.get(pair.randomization_pair_sha256);
    if (!leases) cohortInvalid("scheduled_risk_set_lease_missing");
    const followupClosesAt = new Date(
      Date.parse(pair.index_window_ends_at)
        + args.gate.registered.config.primary_followup_duration_hours * HOUR_MILLIS,
    ).toISOString();
    return {
      cohort_pair_ordinal: cohortPairOrdinal,
      source_pair_ordinal: pair.pair_ordinal,
      randomization_pair_sha256: pair.randomization_pair_sha256,
      pair_record_sha256: pair.pair_record_sha256,
      matching_covariate_sha256: pair.matching_covariate_sha256,
      activation_wave_index: pair.activation_wave_index,
      activation_starts_at: pair.activation_starts_at,
      index_window_ends_at: pair.index_window_ends_at,
      followup_closes_at: followupClosesAt,
      wave_analysis_at: pair.wave_analysis_at,
      members: leases.map((lease) => ({
        pair_member_ordinal: lease.pair_member_ordinal,
        memory_namespace_sha256: lease.memory_namespace_sha256,
        namespace_lease_id_sha256: sha256Hex(lease.namespace_lease_id),
        namespace_lease_generation: lease.lease_generation,
        assigned_arm: lease.assigned_arm,
        historically_active_at_reserved_analysis: true as const,
      })) as [LiteLearningScheduledRiskSetMemberV1, LiteLearningScheduledRiskSetMemberV1],
    };
  });
  return deepFreeze({
    contract_version: "aionis_lite_learning_scheduled_risk_set_v1",
    reservation_binding: {
      tenant_id: args.reservation.tenant_id,
      reservation_id: args.reservation.reservation_id,
      reservation_sha256: args.reservation.reservation_sha256,
      operation_id: args.reservation.operation_id,
      task_family: args.reservation.task_family,
      candidate_policy_id: args.reservation.candidate_policy_id,
      candidate_policy_version: args.reservation.candidate_policy_version,
      candidate_policy_implementation_sha256:
        args.reservation.candidate_policy_implementation_sha256,
      experiment_id: args.reservation.experiment_id,
      experiment_revision: args.reservation.experiment_revision,
      confirmatory_attempt_id: args.binding.attempt.confirmatory_attempt_id,
      confirmatory_attempt_sha256: args.binding.attempt.attempt_sha256,
      gate_policy_id: args.reservation.gate_policy_id,
      gate_policy_version: args.reservation.gate_policy_version,
      gate_policy_config_sha256: args.reservation.gate_policy_config_sha256,
      look_schedule_sha256: args.reservation.look_schedule_sha256,
      randomization_pair_manifest_sha256:
        args.reservation.randomization_pair_manifest_sha256,
      activation_schedule_sha256: args.reservation.activation_schedule_sha256,
    },
    checkpoint: {
      look_index: args.reservation.look_index,
      checkpoint_kind: args.gate.checkpoint.checkpointKind,
      target_cumulative_pair_count: args.gate.checkpoint.targetPairCount,
      analysis_at: args.reservation.analysis_at,
      reservation_created_at: args.reservation.created_at,
      evidence_cutoff_event_row_id: args.reservation.evidence_cutoff_event_row_id,
      evidence_artifact_cutoff_row_id: args.reservation.evidence_artifact_cutoff_row_id,
      primary_followup_duration_hours:
        args.gate.registered.config.primary_followup_duration_hours,
      outcome_fields_included: false,
    },
    design: {
      assignment_design: "matched_pair_complete_randomization_v1",
      assignment_unit_kind: "store_memory_namespace_cluster",
      eligible_memory_namespace_set_sha256:
        args.binding.attempt.eligible_memory_namespace_set_sha256,
      full_pair_count: args.binding.attempt.randomization_pair_count,
      scheduled_pair_count: selectedPairs.length,
      scheduled_candidate_namespace_count:
        args.reservation.candidate_scheduled_namespace_count,
      scheduled_control_namespace_count:
        args.reservation.control_scheduled_namespace_count,
      pair_order: "source_pair_ordinal_ascending",
      risk_set_rule:
        "all_preregistered_pairs_in_complete_waves_through_reserved_checkpoint",
    },
    waves: args.waves.slice(0, args.gate.checkpoint.position + 1),
    pairs,
  });
}

/**
 * Replays a protected reservation's registered design into a canonical,
 * outcome-free scheduled risk set. It first verifies the reservation-bound
 * Runtime/artifact prefix and confirmatory design, including the namespace
 * lease lifecycle, and then issues only SELECT/PRAGMA reads. The result is an
 * explicitly non-authority structural preview; unevaluated evidence layers are
 * requirements for a later evaluator, not evidence findings or a gate verdict.
 */
export function buildLiteLearningScheduledRiskSet(
  input: LiteLearningScheduledRiskSetInput,
): LiteLearningScheduledRiskSetInspectionV1 {
  if (!input || typeof input !== "object" || typeof input.db?.prepare !== "function") {
    cohortInvalid("input_database_required");
  }
  const tenantId = TenantIdSchema.safeParse(input.tenantId);
  const reservationId = ExactIdSchema.safeParse(input.reservationId);
  if (!tenantId.success) cohortInvalid("input_tenant_id_invalid");
  if (!reservationId.success) cohortInvalid("input_reservation_id_invalid");
  const dataVersion = readDataVersion(input.db);
  const reservation = loadReservation(input.db, tenantId.data, reservationId.data);
  const scopedIntegrity = assertLiteLearningGateReservationScopedIntegrity(input.db, {
    tenantId: tenantId.data,
    reservationId: reservationId.data,
  });
  const gate = loadGatePolicyBinding(input.db, reservation);
  const binding = loadAttemptRevisionBinding(input.db, reservation, gate);
  const { pairs, waves } = loadRandomizationPairs(
    input.db,
    binding,
    gate,
    reservation,
  );
  const leases = loadNamespaceLeases(input.db, binding, pairs, gate, reservation);
  const scheduledRiskSet = buildRiskSet({
    reservation,
    gate,
    binding,
    pairs,
    waves,
    leases,
  });
  if (readDataVersion(input.db) !== dataVersion) cohortInvalid("source_snapshot_changed");
  const scheduledRiskSetSha256 = sha256Hex(stableStringify(scheduledRiskSet));
  const resultWithoutDigest = {
    contract_version: "aionis_lite_learning_scheduled_risk_set_inspection_v1" as const,
    read_model_only: true as const,
    structural_status: "reconstructed_non_authority_preview" as const,
    source_integrity: {
      scope: scopedIntegrity.scope,
      verified: true as const,
    },
    policy_registration: {
      registry_status: gate.registered.registry_status,
      registry_calibration_artifact_sha256:
        gate.registered.prospective_calibration_artifact_sha256,
      stored_calibration_artifact_sha256:
        gate.stored.prospective_calibration_sha256!,
      exact_registry_calibration_binding:
        gate.registered.registry_status === "registered"
        && gate.registered.prospective_calibration_artifact_sha256
          === gate.stored.prospective_calibration_sha256,
    },
    production_authority_eligible: false as const,
    authority_mutation: false as const,
    authority_action: null,
    scheduled_risk_set: scheduledRiskSet,
    scheduled_risk_set_sha256: scheduledRiskSetSha256,
    unevaluated_requirements: UNEVALUATED_REQUIREMENTS,
  };
  return deepFreeze({
    ...resultWithoutDigest,
    result_sha256: sha256Hex(stableStringify(resultWithoutDigest)),
  });
}
