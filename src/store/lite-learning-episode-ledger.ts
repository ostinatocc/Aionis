import { createHash, randomBytes } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import {
  ExternalExecutionPolicyV1Schema,
  HostUseReceiptV1BodySchema,
  LearningEpisodeEventWithoutDigestSchema,
  LearningEpisodePayloadV1Schema,
  LearningLedgerItemSchema,
  RequiredExternalInputsV1Schema,
  isLearningExposurePromotionEligible,
  hostUseReceiptDigest,
  learningEpisodeEventDigest,
  learningEpisodeTrackSummary,
  learningItemSetDigest,
  type EventWithoutDigest,
  type EffectMeasuredV1,
  type ExposureCommittedV1,
  type FeedbackAttributedV1,
  type LearningLedgerItem,
} from "../memory/learning-episode-ledger.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";
import {
  LearningAuthorityApprovalV1Schema,
  LearningExperimentCloseApprovalV1Schema,
  LearningLookProposalV1Schema,
  RuntimeIntegrityGateReportV1Schema,
  learningAuthorityApprovalDigest,
  learningExperimentCloseApprovalDigest,
  learningOutcomeRedactedAuthorityProjectionDigest,
  type LearningLookProposalV1,
  type LearningOutcomeRedactedAuthorityProjectionV1,
} from "../memory/learning-authority-approval.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  resolveLearningGatePolicy,
} from "../memory/learning-gate-policy.js";

const ARCHITECTURE_V3_DDL = String.raw`
CREATE TABLE lite_runtime_authority_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_instance_id TEXT NOT NULL UNIQUE CHECK (
    length(database_instance_id) = 64
    AND database_instance_id NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL
);

CREATE TRIGGER lite_runtime_authority_identity_no_update
BEFORE UPDATE ON lite_runtime_authority_identity
BEGIN
  SELECT RAISE(ABORT, 'lite_runtime_authority_identity is append-only');
END;

CREATE TRIGGER lite_runtime_authority_identity_no_delete
BEFORE DELETE ON lite_runtime_authority_identity
BEGIN
  SELECT RAISE(ABORT, 'lite_runtime_authority_identity is append-only');
END;
CREATE TABLE lite_learning_policy_versions (
  tenant_id TEXT NOT NULL,
  policy_kind TEXT NOT NULL CHECK (policy_kind IN ('candidate', 'gate')),
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_config_sha256 TEXT NOT NULL CHECK (
    length(policy_config_sha256) = 64
    AND policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  policy_config_json TEXT NOT NULL CHECK (json_valid(policy_config_json)),
  implementation_contract_sha256 TEXT NOT NULL CHECK (
    length(implementation_contract_sha256) = 64
    AND implementation_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prospective_calibration_sha256 TEXT CHECK (
    prospective_calibration_sha256 IS NULL OR (
      length(prospective_calibration_sha256) = 64
      AND prospective_calibration_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  prospective_calibration_json TEXT CHECK (
    prospective_calibration_json IS NULL OR (
      json_valid(prospective_calibration_json)
      AND length(CAST(prospective_calibration_json AS BLOB)) <= 524288
    )
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (policy_kind = 'candidate'
      AND prospective_calibration_sha256 IS NULL
      AND prospective_calibration_json IS NULL)
    OR (policy_kind = 'gate'
      AND prospective_calibration_sha256 IS NOT NULL
      AND prospective_calibration_json IS NOT NULL
      AND COALESCE(
        json_extract(prospective_calibration_json, '$.status'), ''
      ) = 'passed')
  ),
  PRIMARY KEY (tenant_id, policy_kind, policy_id, policy_version)
);
CREATE TABLE lite_learning_collection_principal_bindings (
  tenant_id TEXT NOT NULL,
  collection_principal_sha256 TEXT NOT NULL CHECK (
    length(collection_principal_sha256) = 64
    AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collection_class TEXT NOT NULL CHECK (collection_class IN (
    'eligible_host', 'fixture_pilot'
  )),
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  verifier_policy_sha256 TEXT NOT NULL CHECK (
    length(verifier_policy_sha256) = 64
    AND verifier_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_policy_json TEXT NOT NULL CHECK (json_valid(verifier_policy_json)),
  binding_sha256 TEXT NOT NULL CHECK (
    length(binding_sha256) = 64
    AND binding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, collection_principal_sha256)
);
CREATE TABLE lite_learning_experiment_revisions (
  tenant_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  profile_id TEXT NOT NULL,
  profile_rule_sha256 TEXT NOT NULL CHECK (
    length(profile_rule_sha256) = 64
    AND profile_rule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  serving_phase TEXT NOT NULL CHECK (serving_phase IN (
    'aa', 'shadow', 'active_control'
  )),
  evidence_intent TEXT NOT NULL CHECK (evidence_intent IN (
    'integrity_only', 'confirmatory'
  )),
  eligible_memory_namespace_set_sha256 TEXT CHECK (
    eligible_memory_namespace_set_sha256 IS NULL OR (
      length(eligible_memory_namespace_set_sha256) = 64
      AND eligible_memory_namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  eligible_memory_namespace_count INTEGER CHECK (
    eligible_memory_namespace_count IS NULL
    OR eligible_memory_namespace_count = 768
  ),
  assignment_design TEXT NOT NULL CHECK (assignment_design IN (
    'diagnostic_hash_v1', 'matched_pair_complete_randomization_v1'
  )),
  randomization_pair_manifest_sha256 TEXT CHECK (
    randomization_pair_manifest_sha256 IS NULL OR (
      length(randomization_pair_manifest_sha256) = 64
      AND randomization_pair_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  randomization_pair_count INTEGER CHECK (
    randomization_pair_count IS NULL OR randomization_pair_count = 384
  ),
  activation_schedule_sha256 TEXT CHECK (
    activation_schedule_sha256 IS NULL OR (
      length(activation_schedule_sha256) = 64
      AND activation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_config_sha256) = 64
    AND candidate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  assignment_unit_kind TEXT NOT NULL CHECK (
    assignment_unit_kind = 'store_memory_namespace_cluster'
  ),
  candidate_allocation_bps INTEGER NOT NULL
    CHECK (candidate_allocation_bps BETWEEN 1000 AND 9000),
  diagnostic_assignment_seed BLOB NOT NULL CHECK (
    length(diagnostic_assignment_seed) = 32
  ),
  diagnostic_assignment_seed_sha256 TEXT NOT NULL CHECK (
    length(diagnostic_assignment_seed_sha256) = 64
    AND diagnostic_assignment_seed_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  confirmatory_assignment_bits BLOB,
  confirmatory_assignment_bit_count INTEGER CHECK (
    confirmatory_assignment_bit_count IS NULL
    OR confirmatory_assignment_bit_count >= 1
  ),
  confirmatory_assignment_bits_sha256 TEXT CHECK (
    confirmatory_assignment_bits_sha256 IS NULL OR (
      length(confirmatory_assignment_bits_sha256) = 64
      AND confirmatory_assignment_bits_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collection_source_policy_sha256 TEXT NOT NULL CHECK (
    length(collection_source_policy_sha256) = 64
    AND collection_source_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collection_source_policy_json TEXT NOT NULL CHECK (
    json_valid(collection_source_policy_json)
  ),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  gate_prospective_calibration_sha256 TEXT NOT NULL CHECK (
    length(gate_prospective_calibration_sha256) = 64
    AND gate_prospective_calibration_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_evidence_series_sha256 TEXT NOT NULL CHECK (
    length(required_evidence_series_sha256) = 64
    AND required_evidence_series_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_evidence_series_json TEXT NOT NULL CHECK (
    json_valid(required_evidence_series_json)
  ),
  required_external_inputs_sha256 TEXT NOT NULL CHECK (
    length(required_external_inputs_sha256) = 64
    AND required_external_inputs_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_external_inputs_json TEXT NOT NULL CHECK (
    json_valid(required_external_inputs_json)
    AND length(CAST(required_external_inputs_json AS BLOB)) <= 16384
  ),
  external_execution_policy_sha256 TEXT NOT NULL CHECK (
    length(external_execution_policy_sha256) = 64
    AND external_execution_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  external_execution_policy_json TEXT NOT NULL CHECK (
    json_valid(external_execution_policy_json)
    AND length(CAST(external_execution_policy_json AS BLOB)) <= 16384
  ),
  safety_pause_mode TEXT NOT NULL CHECK (safety_pause_mode = 'automatic'),
  config_sha256 TEXT NOT NULL CHECK (
    length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL,
  CHECK (
    (serving_phase IN ('aa', 'shadow')
      AND evidence_intent = 'integrity_only'
      AND eligible_memory_namespace_set_sha256 IS NULL
      AND eligible_memory_namespace_count IS NULL
      AND assignment_design = 'diagnostic_hash_v1'
      AND randomization_pair_manifest_sha256 IS NULL
      AND randomization_pair_count IS NULL
      AND activation_schedule_sha256 IS NULL
      AND confirmatory_assignment_bits IS NULL
      AND confirmatory_assignment_bit_count IS NULL
      AND confirmatory_assignment_bits_sha256 IS NULL)
    OR (serving_phase = 'active_control'
      AND evidence_intent = 'confirmatory'
      AND eligible_memory_namespace_set_sha256 IS NOT NULL
      AND eligible_memory_namespace_count IS NOT NULL
      AND assignment_design = 'matched_pair_complete_randomization_v1'
      AND randomization_pair_manifest_sha256 IS NOT NULL
      AND randomization_pair_count IS NOT NULL
      AND activation_schedule_sha256 IS NOT NULL
      AND candidate_allocation_bps = 5000
      AND confirmatory_assignment_bits IS NOT NULL
      AND confirmatory_assignment_bit_count = randomization_pair_count
      AND confirmatory_assignment_bits_sha256 IS NOT NULL
      AND length(confirmatory_assignment_bits) =
        CAST((randomization_pair_count + 7) / 8 AS INTEGER))
  ),
  PRIMARY KEY (tenant_id, experiment_id, experiment_revision)
);
CREATE TABLE lite_learning_confirmatory_attempts (
  tenant_id TEXT NOT NULL,
  confirmatory_attempt_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  eligible_memory_namespace_set_sha256 TEXT NOT NULL CHECK (
    length(eligible_memory_namespace_set_sha256) = 64
    AND eligible_memory_namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  eligible_memory_namespace_count INTEGER NOT NULL CHECK (
    eligible_memory_namespace_count = 768
  ),
  planned_candidate_namespace_count INTEGER NOT NULL CHECK (
    planned_candidate_namespace_count = 384
  ),
  planned_control_namespace_count INTEGER NOT NULL CHECK (
    planned_control_namespace_count = 384
  ),
  randomization_pair_manifest_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_manifest_sha256) = 64
    AND randomization_pair_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  randomization_pair_count INTEGER NOT NULL CHECK (
    randomization_pair_count = 384
  ),
  activation_schedule_sha256 TEXT NOT NULL CHECK (
    length(activation_schedule_sha256) = 64
    AND activation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  attempt_sha256 TEXT NOT NULL CHECK (
    length(attempt_sha256) = 64
    AND attempt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, confirmatory_attempt_id),
  UNIQUE (
    tenant_id, task_family, candidate_policy_id, candidate_policy_version
  ),
  UNIQUE (
    tenant_id, task_family, candidate_policy_implementation_sha256
  ),
  UNIQUE (
    tenant_id, experiment_id, experiment_revision
  )
);
CREATE TABLE lite_learning_randomization_pairs (
  tenant_id TEXT NOT NULL,
  confirmatory_attempt_id TEXT NOT NULL,
  randomization_pair_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_sha256) = 64
    AND randomization_pair_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  pair_ordinal INTEGER NOT NULL CHECK (pair_ordinal BETWEEN 0 AND 383),
  member_0_memory_namespace_sha256 TEXT NOT NULL CHECK (
    length(member_0_memory_namespace_sha256) = 64
    AND member_0_memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_1_memory_namespace_sha256 TEXT NOT NULL CHECK (
    length(member_1_memory_namespace_sha256) = 64
    AND member_1_memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  matching_covariate_sha256 TEXT NOT NULL CHECK (
    length(matching_covariate_sha256) = 64
    AND matching_covariate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  matching_covariate_json TEXT NOT NULL CHECK (
    json_valid(matching_covariate_json)
    AND length(CAST(matching_covariate_json AS BLOB)) <= 4096
  ),
  activation_wave_index INTEGER NOT NULL CHECK (
    activation_wave_index IN (1, 2, 3)
  ),
  activation_starts_at TEXT NOT NULL,
  index_window_ends_at TEXT NOT NULL,
  wave_analysis_at TEXT NOT NULL,
  pair_record_sha256 TEXT NOT NULL CHECK (
    length(pair_record_sha256) = 64
    AND pair_record_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK (
    member_0_memory_namespace_sha256 <> member_1_memory_namespace_sha256
  ),
  PRIMARY KEY (
    tenant_id, confirmatory_attempt_id, randomization_pair_sha256
  ),
  UNIQUE (tenant_id, confirmatory_attempt_id, pair_ordinal),
  UNIQUE (
    tenant_id, confirmatory_attempt_id, member_0_memory_namespace_sha256
  ),
  UNIQUE (
    tenant_id, confirmatory_attempt_id, member_1_memory_namespace_sha256
  )
);

CREATE TRIGGER trg_lite_learning_randomization_pair_update
BEFORE UPDATE ON lite_learning_randomization_pairs
BEGIN
  SELECT RAISE(ABORT, 'learning_randomization_pair_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_randomization_pair_delete
BEFORE DELETE ON lite_learning_randomization_pairs
BEGIN
  SELECT RAISE(ABORT, 'learning_randomization_pair_delete_forbidden');
END;
CREATE TABLE lite_learning_namespace_leases (
  tenant_id TEXT NOT NULL,
  namespace_lease_id TEXT NOT NULL,
  memory_namespace_sha256 TEXT NOT NULL CHECK (
    length(memory_namespace_sha256) = 64
    AND memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  randomization_pair_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_sha256) = 64
    AND randomization_pair_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  pair_member_ordinal INTEGER NOT NULL CHECK (pair_member_ordinal IN (0, 1)),
  assigned_arm TEXT NOT NULL CHECK (assigned_arm IN ('candidate', 'control')),
  activation_wave_index INTEGER NOT NULL CHECK (
    activation_wave_index IN (1, 2, 3)
  ),
  activation_starts_at TEXT NOT NULL,
  index_window_ends_at TEXT NOT NULL,
  wave_analysis_at TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
  confirmatory_attempt_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  namespace_set_sha256 TEXT NOT NULL CHECK (
    length(namespace_set_sha256) = 64
    AND namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  acquire_operation_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  release_operation_id TEXT,
  release_ref_kind TEXT CHECK (
    release_ref_kind IS NULL OR release_ref_kind IN (
      'experiment_close', 'terminal_authority_adjudication'
    )
  ),
  release_ref_id TEXT,
  released_at TEXT,
  CHECK (
    (status = 'active'
      AND release_operation_id IS NULL
      AND release_ref_kind IS NULL
      AND release_ref_id IS NULL
      AND released_at IS NULL)
    OR (status = 'released'
      AND release_operation_id IS NOT NULL
      AND release_ref_kind IS NOT NULL
      AND release_ref_id IS NOT NULL
      AND released_at IS NOT NULL)
  ),
  PRIMARY KEY (tenant_id, namespace_lease_id),
  UNIQUE (tenant_id, memory_namespace_sha256, lease_generation),
  UNIQUE (tenant_id, confirmatory_attempt_id, memory_namespace_sha256),
  UNIQUE (
    tenant_id, confirmatory_attempt_id,
    randomization_pair_sha256, pair_member_ordinal
  ),
  UNIQUE (
    tenant_id, confirmatory_attempt_id,
    randomization_pair_sha256, assigned_arm
  ),
  UNIQUE (tenant_id, acquire_operation_id, memory_namespace_sha256),
  UNIQUE (tenant_id, release_operation_id, memory_namespace_sha256)
);

CREATE UNIQUE INDEX idx_lite_learning_namespace_one_active_lease
  ON lite_learning_namespace_leases(tenant_id, memory_namespace_sha256)
  WHERE status = 'active';

CREATE TRIGGER trg_lite_learning_namespace_lease_pair_binding
BEFORE INSERT ON lite_learning_namespace_leases
WHEN NOT EXISTS (
  SELECT 1 FROM lite_learning_randomization_pairs AS pair_row
  WHERE pair_row.tenant_id = NEW.tenant_id
    AND pair_row.confirmatory_attempt_id = NEW.confirmatory_attempt_id
    AND pair_row.randomization_pair_sha256 = NEW.randomization_pair_sha256
    AND pair_row.activation_wave_index = NEW.activation_wave_index
    AND pair_row.activation_starts_at = NEW.activation_starts_at
    AND pair_row.index_window_ends_at = NEW.index_window_ends_at
    AND pair_row.wave_analysis_at = NEW.wave_analysis_at
    AND (
      (NEW.pair_member_ordinal = 0
        AND pair_row.member_0_memory_namespace_sha256 =
          NEW.memory_namespace_sha256)
      OR (NEW.pair_member_ordinal = 1
        AND pair_row.member_1_memory_namespace_sha256 =
          NEW.memory_namespace_sha256)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_lease_pair_binding_required');
END;

CREATE TRIGGER trg_lite_learning_namespace_lease_update
BEFORE UPDATE ON lite_learning_namespace_leases
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'released'
  AND OLD.tenant_id IS NEW.tenant_id
  AND OLD.namespace_lease_id IS NEW.namespace_lease_id
  AND OLD.memory_namespace_sha256 IS NEW.memory_namespace_sha256
  AND OLD.randomization_pair_sha256 IS NEW.randomization_pair_sha256
  AND OLD.pair_member_ordinal IS NEW.pair_member_ordinal
  AND OLD.assigned_arm IS NEW.assigned_arm
  AND OLD.activation_wave_index IS NEW.activation_wave_index
  AND OLD.activation_starts_at IS NEW.activation_starts_at
  AND OLD.index_window_ends_at IS NEW.index_window_ends_at
  AND OLD.wave_analysis_at IS NEW.wave_analysis_at
  AND OLD.lease_generation IS NEW.lease_generation
  AND OLD.confirmatory_attempt_id IS NEW.confirmatory_attempt_id
  AND OLD.experiment_id IS NEW.experiment_id
  AND OLD.experiment_revision IS NEW.experiment_revision
  AND OLD.namespace_set_sha256 IS NEW.namespace_set_sha256
  AND OLD.acquire_operation_id IS NEW.acquire_operation_id
  AND OLD.acquired_at IS NEW.acquired_at
  AND NEW.release_operation_id IS NOT NULL
  AND NEW.release_ref_kind IS NOT NULL
  AND NEW.release_ref_id IS NOT NULL
  AND NEW.released_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_lease_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_namespace_lease_delete
BEFORE DELETE ON lite_learning_namespace_leases
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_lease_delete_forbidden');
END;
CREATE TABLE lite_learning_experiment_closures (
  tenant_id TEXT NOT NULL,
  experiment_close_id TEXT NOT NULL,
  confirmatory_attempt_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  namespace_set_sha256 TEXT NOT NULL CHECK (
    length(namespace_set_sha256) = 64
    AND namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  sealed_event_head_row_id INTEGER NOT NULL CHECK (
    sealed_event_head_row_id >= 0
  ),
  close_reason TEXT NOT NULL CHECK (close_reason IN (
    'operator_stop', 'safety_abort', 'rollout_expired', 'evidence_complete'
  )),
  authorization_sha256 TEXT NOT NULL CHECK (
    length(authorization_sha256) = 64
    AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_payload_json TEXT NOT NULL CHECK (
    json_valid(authorization_payload_json)
    AND length(CAST(authorization_payload_json AS BLOB)) <= 65536
  ),
  authorization_mac TEXT NOT NULL,
  authorization_nonce TEXT NOT NULL,
  authorization_expires_at TEXT NOT NULL,
  authorization_key_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  authority_operation_id TEXT NOT NULL,
  authority_operation_scope TEXT NOT NULL,
  authority_operation_kind TEXT NOT NULL CHECK (
    authority_operation_kind = 'learning_experiment_close_v1'
  ),
  close_sha256 TEXT NOT NULL CHECK (
    length(close_sha256) = 64
    AND close_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, experiment_close_id),
  UNIQUE (tenant_id, confirmatory_attempt_id),
  UNIQUE (
    tenant_id, authority_operation_scope,
    authority_operation_kind, authority_operation_id
  ),
  UNIQUE (tenant_id, authorization_key_id, authorization_nonce)
);
CREATE TABLE lite_learning_authorization_nonces (
  tenant_id TEXT NOT NULL,
  authorization_key_id TEXT NOT NULL,
  authorization_nonce TEXT NOT NULL,
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN (
    'gate_adjudication', 'experiment_close'
  )),
  authority_ref_id TEXT NOT NULL,
  authorization_sha256 TEXT NOT NULL CHECK (
    length(authorization_sha256) = 64
    AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, authorization_key_id, authorization_nonce),
  UNIQUE (tenant_id, authorization_kind, authority_ref_id)
);
CREATE TABLE lite_learning_episode_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  episode_sequence INTEGER NOT NULL CHECK (episode_sequence >= 1),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'exposure_committed', 'feedback_attributed', 'effect_measured'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'guide_receipt', 'memory_feedback_operation',
    'tool_feedback_operation', 'product_measurement', 'legacy_backfill'
  )),
  source_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_event_sha256 TEXT CHECK (
    previous_event_sha256 IS NULL OR (
      length(previous_event_sha256) = 64
      AND previous_event_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  event_sha256 TEXT NOT NULL CHECK (
    length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  item_set_sha256 TEXT NOT NULL CHECK (
    length(item_set_sha256) = 64 AND item_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_commit_id TEXT,
  supersedes_event_id TEXT CHECK (
    supersedes_event_id IS NULL OR supersedes_event_id <> event_id
  ),
  operation_id TEXT,
  run_id TEXT,
  collection_class TEXT NOT NULL CHECK (collection_class IN (
    'eligible_host', 'fixture_pilot', 'unverified', 'legacy_unclassified'
  )),
  collection_principal_sha256 TEXT CHECK (
    collection_principal_sha256 IS NULL OR (
      length(collection_principal_sha256) = 64
      AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collector_id TEXT,
  collector_version TEXT,
  host_task_id TEXT,
  host_source_task_sha256 TEXT CHECK (
    host_source_task_sha256 IS NULL OR (
      length(host_source_task_sha256) = 64
      AND host_source_task_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  host_source_event_sha256 TEXT CHECK (
    host_source_event_sha256 IS NULL OR (
      length(host_source_event_sha256) = 64
      AND host_source_event_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  host_task_envelope_created_at TEXT,
  host_task_envelope_sha256 TEXT CHECK (
    host_task_envelope_sha256 IS NULL OR (
      length(host_task_envelope_sha256) = 64
      AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  task_family TEXT,
  task_signature_sha256 TEXT CHECK (
    task_signature_sha256 IS NULL OR (
      length(task_signature_sha256) = 64
      AND task_signature_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  repo_signature_sha256 TEXT CHECK (
    repo_signature_sha256 IS NULL OR (
      length(repo_signature_sha256) = 64
      AND repo_signature_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  memory_namespace_sha256 TEXT CHECK (
    memory_namespace_sha256 IS NULL OR (
      length(memory_namespace_sha256) = 64
      AND memory_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  namespace_set_sha256 TEXT CHECK (
    namespace_set_sha256 IS NULL OR (
      length(namespace_set_sha256) = 64
      AND namespace_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  namespace_lease_id TEXT,
  namespace_lease_generation INTEGER CHECK (
    namespace_lease_generation IS NULL OR namespace_lease_generation >= 1
  ),
  profile_id TEXT,
  experiment_id TEXT,
  experiment_revision INTEGER,
  enrollment_state TEXT CHECK (enrollment_state IN (
    'enrolled', 'not_enrolled', 'legacy_unclassified'
  )),
  serving_phase TEXT CHECK (serving_phase IN (
    'aa', 'shadow', 'active_control', 'fixed_active', 'off'
  )),
  evidence_intent TEXT CHECK (evidence_intent IS NULL OR evidence_intent IN (
    'integrity_only', 'confirmatory'
  )),
  assignment_mode TEXT CHECK (assignment_mode IN (
    'matched_pair_randomized', 'diagnostic_randomized',
    'non_randomized', 'unassigned'
  )),
  assignment_unit_sha256 TEXT CHECK (
    assignment_unit_sha256 IS NULL OR (
      length(assignment_unit_sha256) = 64
      AND assignment_unit_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  assignment_namespace_sha256 TEXT CHECK (
    assignment_namespace_sha256 IS NULL OR (
      length(assignment_namespace_sha256) = 64
      AND assignment_namespace_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  assignment_bucket INTEGER CHECK (
    assignment_bucket IS NULL OR assignment_bucket BETWEEN 0 AND 9999
  ),
  randomization_pair_sha256 TEXT CHECK (
    randomization_pair_sha256 IS NULL OR (
      length(randomization_pair_sha256) = 64
      AND randomization_pair_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  matching_covariate_sha256 TEXT CHECK (
    matching_covariate_sha256 IS NULL OR (
      length(matching_covariate_sha256) = 64
      AND matching_covariate_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  pair_member_ordinal INTEGER CHECK (
    pair_member_ordinal IS NULL OR pair_member_ordinal IN (0, 1)
  ),
  activation_wave_index INTEGER CHECK (
    activation_wave_index IS NULL OR activation_wave_index IN (1, 2, 3)
  ),
  activation_starts_at TEXT,
  index_window_ends_at TEXT,
  wave_analysis_at TEXT,
  assignment_arm TEXT CHECK (assignment_arm IN (
    'control', 'candidate', 'not_enrolled'
  )),
  served_arm TEXT CHECK (served_arm IN ('control', 'candidate')),
  candidate_policy_id TEXT,
  candidate_policy_version TEXT,
  policy_affected INTEGER CHECK (
    policy_affected IS NULL OR policy_affected IN (0, 1)
  ),
  predecision_track TEXT CHECK (predecision_track IN (
    'explore', 'exploit', 'mixed', 'unaffected', 'unclassified'
  )),
  projection_complete INTEGER CHECK (
    projection_complete IS NULL OR projection_complete IN (0, 1)
  ),
  promotion_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (promotion_eligible IN (0, 1)),
  recorded_at TEXT NOT NULL,
  CHECK (
    promotion_eligible = 0 OR (
      collection_class = 'eligible_host'
      AND collection_principal_sha256 IS NOT NULL
      AND collector_id IS NOT NULL
      AND collector_version IS NOT NULL
      AND host_task_id IS NOT NULL
      AND host_source_task_sha256 IS NOT NULL
      AND host_source_event_sha256 IS NOT NULL
      AND host_task_envelope_created_at IS NOT NULL
      AND host_task_envelope_sha256 IS NOT NULL
      AND enrollment_state = 'enrolled'
      AND serving_phase = 'active_control'
      AND evidence_intent = 'confirmatory'
      AND assignment_mode = 'matched_pair_randomized'
      AND operation_id IS NOT NULL
      AND task_family IS NOT NULL
      AND task_signature_sha256 IS NOT NULL
      AND repo_signature_sha256 IS NOT NULL
      AND memory_namespace_sha256 IS NOT NULL
      AND namespace_set_sha256 IS NOT NULL
      AND namespace_lease_id IS NOT NULL
      AND namespace_lease_generation IS NOT NULL
      AND profile_id IS NOT NULL
      AND experiment_id IS NOT NULL
      AND experiment_revision IS NOT NULL
      AND assignment_unit_sha256 IS NOT NULL
      AND assignment_namespace_sha256 IS NOT NULL
      AND assignment_bucket IS NULL
      AND randomization_pair_sha256 IS NOT NULL
      AND matching_covariate_sha256 IS NOT NULL
      AND pair_member_ordinal IS NOT NULL
      AND activation_wave_index IS NOT NULL
      AND activation_starts_at IS NOT NULL
      AND index_window_ends_at IS NOT NULL
      AND wave_analysis_at IS NOT NULL
      AND recorded_at >= activation_starts_at
      AND recorded_at <= index_window_ends_at
      AND assignment_arm IS NOT NULL
      AND assignment_arm IN ('control', 'candidate')
      AND served_arm IS NOT NULL
      AND served_arm IN ('control', 'candidate')
      AND served_arm = assignment_arm
      AND candidate_policy_id IS NOT NULL
      AND candidate_policy_version IS NOT NULL
      AND policy_affected IS NOT NULL
      AND projection_complete = 1
    )
  ),
  CHECK (
    assignment_mode IS NOT 'matched_pair_randomized' OR (
      assignment_bucket IS NULL
      AND randomization_pair_sha256 IS NOT NULL
      AND matching_covariate_sha256 IS NOT NULL
      AND pair_member_ordinal IS NOT NULL
      AND activation_wave_index IS NOT NULL
      AND activation_starts_at IS NOT NULL
      AND index_window_ends_at IS NOT NULL
      AND wave_analysis_at IS NOT NULL
      AND assignment_arm IN ('control', 'candidate')
    )
  ),
  CHECK (
    assignment_mode IS NOT 'diagnostic_randomized' OR (
      assignment_bucket IS NOT NULL
      AND randomization_pair_sha256 IS NULL
      AND matching_covariate_sha256 IS NULL
      AND pair_member_ordinal IS NULL
      AND activation_wave_index IS NULL
    )
  ),
  UNIQUE (tenant_id, scope, event_id),
  UNIQUE (tenant_id, scope, episode_id, episode_sequence),
  UNIQUE (tenant_id, scope, source_kind, source_id)
);
CREATE UNIQUE INDEX idx_lite_learning_episode_one_exposure
  ON lite_learning_episode_events(tenant_id, scope, episode_id)
  WHERE event_kind = 'exposure_committed';

CREATE UNIQUE INDEX idx_lite_learning_episode_one_superseder
  ON lite_learning_episode_events(tenant_id, scope, supersedes_event_id)
  WHERE supersedes_event_id IS NOT NULL;

CREATE INDEX idx_lite_learning_episode_replay
  ON lite_learning_episode_events(
    tenant_id, scope, episode_id, episode_sequence, row_id
  );

CREATE INDEX idx_lite_learning_episode_gate_slice
  ON lite_learning_episode_events(
    tenant_id, task_family, candidate_policy_id,
    candidate_policy_version, experiment_id, experiment_revision,
    assignment_arm, recorded_at, row_id
  ) WHERE event_kind = 'exposure_committed';

CREATE INDEX idx_lite_learning_episode_namespace_assignment
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    memory_namespace_sha256, assignment_unit_sha256, assignment_arm
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE INDEX idx_lite_learning_episode_lease_binding
  ON lite_learning_episode_events(
    tenant_id, namespace_lease_id, namespace_lease_generation, row_id
  )
  WHERE event_kind = 'exposure_committed'
    AND promotion_eligible = 1;

CREATE TRIGGER trg_lite_learning_namespace_assignment_binding
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND EXISTS (
    SELECT 1 FROM lite_learning_episode_events AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.experiment_id = NEW.experiment_id
      AND prior.experiment_revision = NEW.experiment_revision
      AND prior.event_kind = 'exposure_committed'
      AND prior.collection_class = 'eligible_host'
      AND (
        prior.memory_namespace_sha256 = NEW.memory_namespace_sha256
        OR prior.assignment_unit_sha256 = NEW.assignment_unit_sha256
      )
      AND (
        prior.memory_namespace_sha256 IS NOT NEW.memory_namespace_sha256
        OR prior.assignment_unit_sha256 IS NOT NEW.assignment_unit_sha256
        OR prior.assignment_bucket IS NOT NEW.assignment_bucket
        OR prior.randomization_pair_sha256 IS NOT NEW.randomization_pair_sha256
        OR prior.matching_covariate_sha256 IS NOT NEW.matching_covariate_sha256
        OR prior.pair_member_ordinal IS NOT NEW.pair_member_ordinal
        OR prior.activation_wave_index IS NOT NEW.activation_wave_index
        OR prior.activation_starts_at IS NOT NEW.activation_starts_at
        OR prior.index_window_ends_at IS NOT NEW.index_window_ends_at
        OR prior.wave_analysis_at IS NOT NEW.wave_analysis_at
        OR prior.assignment_arm IS NOT NEW.assignment_arm
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_assignment_conflict');
END;

CREATE TRIGGER trg_lite_learning_eligible_active_lease
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND NEW.evidence_intent = 'confirmatory'
  AND NEW.assignment_mode = 'matched_pair_randomized'
  AND NOT EXISTS (
    SELECT 1
    FROM lite_learning_namespace_leases AS lease
    JOIN lite_learning_randomization_pairs AS pair_row
      ON pair_row.tenant_id = lease.tenant_id
      AND pair_row.confirmatory_attempt_id = lease.confirmatory_attempt_id
      AND pair_row.randomization_pair_sha256 = lease.randomization_pair_sha256
    WHERE lease.tenant_id = NEW.tenant_id
      AND lease.namespace_lease_id = NEW.namespace_lease_id
      AND lease.memory_namespace_sha256 = NEW.memory_namespace_sha256
      AND lease.lease_generation = NEW.namespace_lease_generation
      AND lease.experiment_id = NEW.experiment_id
      AND lease.experiment_revision = NEW.experiment_revision
      AND lease.namespace_set_sha256 = NEW.namespace_set_sha256
      AND lease.randomization_pair_sha256 = NEW.randomization_pair_sha256
      AND pair_row.matching_covariate_sha256 = NEW.matching_covariate_sha256
      AND lease.pair_member_ordinal = NEW.pair_member_ordinal
      AND lease.assigned_arm = NEW.assignment_arm
      AND lease.activation_wave_index = NEW.activation_wave_index
      AND lease.activation_starts_at = NEW.activation_starts_at
      AND lease.index_window_ends_at = NEW.index_window_ends_at
      AND lease.wave_analysis_at = NEW.wave_analysis_at
      AND NEW.recorded_at >= lease.activation_starts_at
      AND NEW.recorded_at <= lease.index_window_ends_at
      AND lease.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_namespace_active_lease_required');
END;

CREATE TRIGGER trg_lite_learning_fixture_lease_overlap
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'fixture_pilot'
  AND EXISTS (
    SELECT 1 FROM lite_learning_namespace_leases AS lease
    WHERE lease.tenant_id = NEW.tenant_id
      AND lease.memory_namespace_sha256 = NEW.memory_namespace_sha256
      AND lease.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_fixture_namespace_lease_overlap');
END;

CREATE UNIQUE INDEX idx_lite_learning_episode_host_source_event
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    host_source_event_sha256
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE INDEX idx_lite_learning_episode_host_task_binding
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    host_task_id
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE INDEX idx_lite_learning_episode_source_task_binding
  ON lite_learning_episode_events(
    tenant_id, experiment_id, experiment_revision,
    host_source_task_sha256
  )
  WHERE event_kind = 'exposure_committed'
    AND collection_class = 'eligible_host';

CREATE TRIGGER trg_lite_learning_host_task_binding
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND EXISTS (
    SELECT 1 FROM lite_learning_episode_events AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.experiment_id = NEW.experiment_id
      AND prior.experiment_revision = NEW.experiment_revision
      AND prior.event_kind = 'exposure_committed'
      AND prior.collection_class = 'eligible_host'
      AND prior.host_task_id = NEW.host_task_id
      AND (
        prior.host_source_task_sha256 IS NOT NEW.host_source_task_sha256
        OR prior.task_family IS NOT NEW.task_family
        OR prior.task_signature_sha256 IS NOT NEW.task_signature_sha256
        OR prior.repo_signature_sha256 IS NOT NEW.repo_signature_sha256
        OR prior.memory_namespace_sha256 IS NOT NEW.memory_namespace_sha256
        OR prior.collector_id IS NOT NEW.collector_id
        OR prior.collector_version IS NOT NEW.collector_version
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_host_task_binding_conflict');
END;

CREATE TRIGGER trg_lite_learning_host_source_task_alias
BEFORE INSERT ON lite_learning_episode_events
WHEN NEW.event_kind = 'exposure_committed'
  AND NEW.collection_class = 'eligible_host'
  AND EXISTS (
    SELECT 1 FROM lite_learning_episode_events AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.experiment_id = NEW.experiment_id
      AND prior.experiment_revision = NEW.experiment_revision
      AND prior.event_kind = 'exposure_committed'
      AND prior.collection_class = 'eligible_host'
      AND prior.host_source_task_sha256 = NEW.host_source_task_sha256
      AND prior.host_task_id <> NEW.host_task_id
  )
BEGIN
  SELECT RAISE(ABORT, 'learning_host_source_task_alias_conflict');
END;
CREATE TABLE lite_learning_exposure_items (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  decision_completeness TEXT NOT NULL CHECK (decision_completeness IN (
    'complete', 'legacy_served_only'
  )),
  memory_type TEXT,
  source_backend TEXT,
  recorded_action TEXT CHECK (recorded_action IS NULL OR recorded_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  candidate_action TEXT CHECK (candidate_action IS NULL OR candidate_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  served_action TEXT NOT NULL CHECK (served_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  policy_changed INTEGER CHECK (policy_changed IS NULL OR policy_changed IN (0, 1)),
  hard_boundary_preserved INTEGER CHECK (
    hard_boundary_preserved IS NULL OR hard_boundary_preserved IN (0, 1)
  ),
  prior_supported_use_count INTEGER CHECK (
    prior_supported_use_count IS NULL OR prior_supported_use_count >= 0
  ),
  prior_contradicted_use_count INTEGER CHECK (
    prior_contradicted_use_count IS NULL OR prior_contradicted_use_count >= 0
  ),
  prior_rehydrate_requested_count INTEGER CHECK (
    prior_rehydrate_requested_count IS NULL OR prior_rehydrate_requested_count >= 0
  ),
  prior_effect_state TEXT CHECK (prior_effect_state IS NULL OR prior_effect_state IN (
    'no_prior', 'supported', 'contradicted', 'mixed', 'rehydrate_requested'
  )),
  repeated_negative_posture INTEGER CHECK (
    repeated_negative_posture IS NULL OR repeated_negative_posture IN (0, 1)
  ),
  learning_track TEXT NOT NULL CHECK (learning_track IN (
    'explore', 'exploit', 'unclassified'
  )),
  track_reason TEXT NOT NULL CHECK (track_reason IN (
    'no_prior', 'prior_supported', 'prior_contradicted', 'prior_mixed',
    'prior_rehydrate_requested', 'prior_nonuse_control', 'legacy_unclassified'
  )),
  item_sha256 TEXT NOT NULL CHECK (
    length(item_sha256) = 64 AND item_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (
      decision_completeness = 'complete'
      AND memory_type IS NOT NULL AND length(memory_type) BETWEEN 1 AND 120
      AND source_backend IS NOT NULL AND length(source_backend) BETWEEN 1 AND 120
      AND recorded_action IS NOT NULL AND candidate_action IS NOT NULL
      AND policy_changed IS NOT NULL AND hard_boundary_preserved IS NOT NULL
      AND prior_supported_use_count IS NOT NULL
      AND prior_contradicted_use_count IS NOT NULL
      AND prior_rehydrate_requested_count IS NOT NULL
      AND prior_effect_state IS NOT NULL
      AND repeated_negative_posture IS NOT NULL
      AND learning_track IN ('explore', 'exploit')
      AND track_reason <> 'legacy_unclassified'
    ) OR (
      decision_completeness = 'legacy_served_only'
      AND memory_type IS NULL AND source_backend IS NULL
      AND recorded_action IS NULL AND candidate_action IS NULL
      AND policy_changed IS NULL AND hard_boundary_preserved IS NULL
      AND prior_supported_use_count IS NULL
      AND prior_contradicted_use_count IS NULL
      AND prior_rehydrate_requested_count IS NULL
      AND prior_effect_state IS NULL AND repeated_negative_posture IS NULL
      AND learning_track = 'unclassified'
      AND track_reason = 'legacy_unclassified'
    )
  ),
  PRIMARY KEY (tenant_id, scope, event_id, memory_id),
  UNIQUE (tenant_id, scope, episode_id, memory_id)
);
CREATE TABLE lite_learning_feedback_attributions (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'memory', 'tool_decision'
  )),
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'positive', 'negative', 'neutral'
  )),
  action_outcome TEXT CHECK (action_outcome IS NULL OR action_outcome IN (
    'accepted_completed', 'accepted_incomplete', 'rejected', 'not_applicable'
  )),
  used_surface TEXT CHECK (used_surface IS NULL OR used_surface IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'explicit_host_assertion'
  )),
  exposure_action TEXT CHECK (exposure_action IS NULL OR exposure_action IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  boundary_outcome TEXT NOT NULL CHECK (boundary_outcome IN (
    'aligned', 'boundary_ignored', 'not_applicable'
  )),
  attribution_strength TEXT NOT NULL CHECK (attribution_strength IN (
    'observed_feedback', 'positive_attribution',
    'weak_counter_signal', 'strong_counter_signal'
  )),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN (
    'verified_host_receipt', 'legacy_unverified', 'tool_decision'
  )),
  host_use_receipt_id TEXT,
  host_use_receipt_sha256 TEXT CHECK (
    host_use_receipt_sha256 IS NULL OR (
      length(host_use_receipt_sha256) = 64
      AND host_use_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  receipt_item_sha256 TEXT CHECK (
    receipt_item_sha256 IS NULL OR (
      length(receipt_item_sha256) = 64
      AND receipt_item_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  host_task_envelope_sha256 TEXT CHECK (
    host_task_envelope_sha256 IS NULL OR (
      length(host_task_envelope_sha256) = 64
      AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collection_principal_sha256 TEXT CHECK (
    collection_principal_sha256 IS NULL OR (
      length(collection_principal_sha256) = 64
      AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  collector_id TEXT,
  collector_version TEXT,
  content_evidence_sha256 TEXT CHECK (
    content_evidence_sha256 IS NULL OR (
      length(content_evidence_sha256) = 64
      AND content_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  verifier_kind TEXT CHECK (verifier_kind IS NULL OR verifier_kind IN (
    'instrumented_agent_trace', 'deterministic_scorer'
  )),
  verifier_version TEXT,
  verifier_config_sha256 TEXT CHECK (
    verifier_config_sha256 IS NULL OR (
      length(verifier_config_sha256) = 64
      AND verifier_config_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  verifier_status TEXT CHECK (
    verifier_status IS NULL OR verifier_status IN ('passed', 'failed', 'not_run')
  ),
  tool_status TEXT,
  runtime_signal_refs_sha256 TEXT CHECK (
    runtime_signal_refs_sha256 IS NULL OR (
      length(runtime_signal_refs_sha256) = 64
      AND runtime_signal_refs_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  item_sha256 TEXT NOT NULL CHECK (
    length(item_sha256) = 64 AND item_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (subject_kind = 'memory' AND used_surface IS NOT NULL AND exposure_action IS NOT NULL)
    OR (
      subject_kind = 'tool_decision' AND used_surface IS NULL
      AND exposure_action IS NULL AND boundary_outcome = 'not_applicable'
    )
  ),
  CHECK (
    (
      subject_kind = 'memory'
      AND evidence_class = 'verified_host_receipt'
      AND action_outcome IS NOT NULL
      AND host_use_receipt_id IS NOT NULL
      AND host_use_receipt_sha256 IS NOT NULL
      AND receipt_item_sha256 IS NOT NULL
      AND host_task_envelope_sha256 IS NOT NULL
      AND collection_principal_sha256 IS NOT NULL
      AND collector_id IS NOT NULL
      AND collector_version IS NOT NULL
      AND content_evidence_sha256 IS NOT NULL
      AND verifier_kind IS NOT NULL
      AND verifier_version IS NOT NULL
      AND verifier_config_sha256 IS NOT NULL
      AND verifier_status = 'passed'
      AND runtime_signal_refs_sha256 IS NOT NULL
      AND used_surface <> 'explicit_host_assertion'
    ) OR (
      subject_kind = 'memory'
      AND evidence_class = 'legacy_unverified'
      AND action_outcome IS NULL
      AND host_use_receipt_id IS NULL
      AND host_use_receipt_sha256 IS NULL
      AND receipt_item_sha256 IS NULL
      AND host_task_envelope_sha256 IS NULL
      AND collection_principal_sha256 IS NULL
      AND collector_id IS NULL
      AND collector_version IS NULL
      AND content_evidence_sha256 IS NULL
      AND verifier_kind IS NULL
      AND verifier_version IS NULL
      AND verifier_config_sha256 IS NULL
      AND verifier_status IS NULL
    ) OR (
      subject_kind = 'tool_decision'
      AND evidence_class = 'tool_decision'
      AND action_outcome IS NULL
      AND host_use_receipt_id IS NULL
      AND host_use_receipt_sha256 IS NULL
      AND receipt_item_sha256 IS NULL
      AND host_task_envelope_sha256 IS NULL
      AND content_evidence_sha256 IS NULL
      AND verifier_kind IS NULL
      AND verifier_version IS NULL
      AND verifier_config_sha256 IS NULL
      AND verifier_status IS NULL
    )
  ),
  PRIMARY KEY (
    tenant_id, scope, event_id, subject_kind, subject_id
  )
);
CREATE TABLE lite_learning_host_use_receipts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  feedback_event_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  host_task_id TEXT NOT NULL,
  host_task_envelope_sha256 TEXT NOT NULL CHECK (
    length(host_task_envelope_sha256) = 64
    AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collection_principal_sha256 TEXT NOT NULL CHECK (
    length(collection_principal_sha256) = 64
    AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  host_trace_sha256 TEXT NOT NULL CHECK (
    length(host_trace_sha256) = 64
    AND host_trace_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 512),
  item_set_sha256 TEXT NOT NULL CHECK (
    length(item_set_sha256) = 64
    AND item_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_payload_json TEXT NOT NULL CHECK (
    json_valid(receipt_payload_json)
    AND length(CAST(receipt_payload_json AS BLOB)) <= 262144
  ),
  verifier_status TEXT NOT NULL CHECK (verifier_status = 'passed'),
  PRIMARY KEY (tenant_id, scope, receipt_id),
  UNIQUE (tenant_id, scope, receipt_sha256),
  UNIQUE (tenant_id, scope, feedback_event_id),
  UNIQUE (tenant_id, scope, operation_id)
);
CREATE TABLE lite_learning_control_jobs (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (
    job_kind = 'unused_exposure_learning_control_v1'
  ),
  operation_id TEXT NOT NULL,
  source_episode_id TEXT NOT NULL,
  source_feedback_event_id TEXT NOT NULL,
  source_commit_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'completed', 'dead_letter'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  result_commit_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
  CHECK (
    (status = 'pending'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_commit_id IS NULL AND completed_at IS NULL)
    OR (status = 'leased'
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND result_commit_id IS NULL AND completed_at IS NULL)
    OR (status = 'completed'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_commit_id IS NOT NULL AND last_error_code IS NULL
      AND completed_at IS NOT NULL)
    OR (status = 'dead_letter'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_commit_id IS NULL AND last_error_code IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, scope, job_id),
  UNIQUE (tenant_id, scope, operation_id)
);

CREATE INDEX idx_lite_learning_control_jobs_available
  ON lite_learning_control_jobs(status, available_at, row_id);

CREATE INDEX idx_lite_learning_control_jobs_lease
  ON lite_learning_control_jobs(lease_expires_at)
  WHERE status = 'leased';

CREATE TRIGGER trg_lite_learning_control_jobs_update
BEFORE UPDATE ON lite_learning_control_jobs
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.job_id IS NOT OLD.job_id
  OR NEW.job_kind IS NOT OLD.job_kind
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.source_episode_id IS NOT OLD.source_episode_id
  OR NEW.source_feedback_event_id IS NOT OLD.source_feedback_event_id
  OR NEW.source_commit_id IS NOT OLD.source_commit_id
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempt_count < OLD.attempt_count
  OR OLD.status IN ('completed', 'dead_letter')
  OR (OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'leased', 'dead_letter'))
  OR (OLD.status = 'leased' AND NEW.status NOT IN ('leased', 'pending', 'completed', 'dead_letter'))
BEGIN
  SELECT RAISE(ABORT, 'learning_control_job_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_control_jobs_delete
BEFORE DELETE ON lite_learning_control_jobs
BEGIN
  SELECT RAISE(ABORT, 'learning_control_job_delete_forbidden');
END;
CREATE TABLE lite_learning_external_run_reservations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'offline_paired_rerun', 'production_shadow_gate', 'tool_e2e_gate'
  )),
  evidence_series_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_config_sha256) = 64
    AND candidate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applicable_experiment_id TEXT NOT NULL,
  applicable_experiment_revision INTEGER NOT NULL CHECK (
    applicable_experiment_revision >= 1
  ),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applicability_manifest_sha256 TEXT NOT NULL CHECK (
    length(applicability_manifest_sha256) = 64
    AND applicability_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  harness_bundle_sha256 TEXT NOT NULL CHECK (
    length(harness_bundle_sha256) = 64
    AND harness_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_snapshot_sha256 TEXT NOT NULL CHECK (
    length(source_snapshot_sha256) = 64
    AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  case_set_sha256 TEXT CHECK (
    case_set_sha256 IS NULL OR (
      length(case_set_sha256) = 64
      AND case_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  holdout_membership_projection_sha256 TEXT CHECK (
    holdout_membership_projection_sha256 IS NULL OR (
      length(holdout_membership_projection_sha256) = 64
      AND holdout_membership_projection_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  sealed_holdout_ref_sha256 TEXT CHECK (
    sealed_holdout_ref_sha256 IS NULL OR (
      length(sealed_holdout_ref_sha256) = 64
      AND sealed_holdout_ref_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  sealed_holdout_ciphertext_sha256 TEXT CHECK (
    sealed_holdout_ciphertext_sha256 IS NULL OR (
      length(sealed_holdout_ciphertext_sha256) = 64
      AND sealed_holdout_ciphertext_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  execution_profile_sha256 TEXT NOT NULL CHECK (
    length(execution_profile_sha256) = 64
    AND execution_profile_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  model_identity_sha256 TEXT NOT NULL CHECK (
    length(model_identity_sha256) = 64
    AND model_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  immutable_model_snapshot_sha256 TEXT CHECK (
    immutable_model_snapshot_sha256 IS NULL OR (
      length(immutable_model_snapshot_sha256) = 64
      AND immutable_model_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  tool_manifest_sha256 TEXT CHECK (
    tool_manifest_sha256 IS NULL OR (
      length(tool_manifest_sha256) = 64
      AND tool_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  execution_order_sha256 TEXT CHECK (
    execution_order_sha256 IS NULL OR (
      length(execution_order_sha256) = 64
      AND execution_order_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  retry_policy_sha256 TEXT NOT NULL CHECK (
    length(retry_policy_sha256) = 64
    AND retry_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  retry_policy_json TEXT NOT NULL CHECK (
    json_valid(retry_policy_json)
    AND length(CAST(retry_policy_json AS BLOB)) <= 4096
  ),
  immutable_input_manifest_sha256 TEXT NOT NULL CHECK (
    length(immutable_input_manifest_sha256) = 64
    AND immutable_input_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  immutable_input_manifest_json TEXT NOT NULL CHECK (
    json_valid(immutable_input_manifest_json)
    AND length(CAST(immutable_input_manifest_json AS BLOB)) <= 32768
  ),
  expected_runner_principal_sha256 TEXT NOT NULL CHECK (
    length(expected_runner_principal_sha256) = 64
    AND expected_runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_policy_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_policy_sha256) = 64
    AND credential_broker_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_policy_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_policy_sha256) = 64
    AND service_launcher_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_binary_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_binary_sha256) = 64
    AND service_launcher_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_key_id TEXT NOT NULL,
  supervisor_executable_sha256 TEXT NOT NULL CHECK (
    length(supervisor_executable_sha256) = 64
    AND supervisor_executable_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_argv_policy_sha256 TEXT NOT NULL CHECK (
    length(supervisor_argv_policy_sha256) = 64
    AND supervisor_argv_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_sandbox_policy_sha256 TEXT NOT NULL CHECK (
    length(supervisor_sandbox_policy_sha256) = 64
    AND supervisor_sandbox_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_session_class TEXT NOT NULL CHECK (
    credential_session_class IN (
      'eligible_host_adapter', 'formal_tool_eval', 'immutable_paired_eval'
    )
  ),
  run_id TEXT NOT NULL,
  reserve_operation_id TEXT NOT NULL,
  runner_ticket_sha256 TEXT NOT NULL CHECK (
    length(runner_ticket_sha256) = 64
    AND runner_ticket_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  reservation_sha256 TEXT NOT NULL CHECK (
    length(reservation_sha256) = 64
    AND reservation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  reserved_at TEXT NOT NULL,
  CHECK (
    (artifact_kind = 'offline_paired_rerun'
      AND case_set_sha256 IS NOT NULL
      AND holdout_membership_projection_sha256 IS NOT NULL
      AND sealed_holdout_ref_sha256 IS NOT NULL
      AND sealed_holdout_ciphertext_sha256 IS NOT NULL
      AND immutable_model_snapshot_sha256 IS NOT NULL
      AND tool_manifest_sha256 IS NOT NULL
      AND execution_order_sha256 IS NOT NULL
      AND credential_session_class = 'immutable_paired_eval')
    OR (artifact_kind = 'production_shadow_gate'
      AND case_set_sha256 IS NULL
      AND holdout_membership_projection_sha256 IS NULL
      AND sealed_holdout_ref_sha256 IS NULL
      AND sealed_holdout_ciphertext_sha256 IS NULL
      AND immutable_model_snapshot_sha256 IS NULL
      AND tool_manifest_sha256 IS NULL
      AND execution_order_sha256 IS NULL
      AND credential_session_class = 'eligible_host_adapter')
    OR (artifact_kind = 'tool_e2e_gate'
      AND case_set_sha256 IS NULL
      AND holdout_membership_projection_sha256 IS NULL
      AND sealed_holdout_ref_sha256 IS NULL
      AND sealed_holdout_ciphertext_sha256 IS NULL
      AND immutable_model_snapshot_sha256 IS NULL
      AND tool_manifest_sha256 IS NOT NULL
      AND execution_order_sha256 IS NULL
      AND credential_session_class = 'formal_tool_eval')
  ),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, evidence_series_id),
  UNIQUE (tenant_id, artifact_kind, run_id),
  UNIQUE (tenant_id, runner_ticket_sha256),
  UNIQUE (tenant_id, reservation_sha256)
);

CREATE TRIGGER trg_lite_learning_external_run_reservation_update
BEFORE UPDATE ON lite_learning_external_run_reservations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_reservation_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_run_reservation_delete
BEFORE DELETE ON lite_learning_external_run_reservations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_reservation_delete_forbidden');
END;

CREATE UNIQUE INDEX idx_lite_learning_offline_holdout_once
  ON lite_learning_external_run_reservations(
    tenant_id, task_family, case_set_sha256
  )
  WHERE artifact_kind = 'offline_paired_rerun';

CREATE TABLE lite_learning_external_holdout_members (
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  case_ordinal INTEGER NOT NULL CHECK (case_ordinal BETWEEN 0 AND 95),
  case_identity_sha256 TEXT NOT NULL CHECK (
    length(case_identity_sha256) = 64
    AND case_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  task_id_sha256 TEXT NOT NULL CHECK (
    length(task_id_sha256) = 64
    AND task_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  content_workflow_sha256 TEXT NOT NULL CHECK (
    length(content_workflow_sha256) = 64
    AND content_workflow_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  store_scope_sha256 TEXT NOT NULL CHECK (
    length(store_scope_sha256) = 64
    AND store_scope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_event_sha256 TEXT NOT NULL CHECK (
    length(source_event_sha256) = 64
    AND source_event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_evidence_sha256 TEXT NOT NULL CHECK (
    length(source_evidence_sha256) = 64
    AND source_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_record_sha256 TEXT NOT NULL CHECK (
    length(member_record_sha256) = 64
    AND member_record_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, reservation_id, case_ordinal),
  UNIQUE (tenant_id, task_family, case_identity_sha256),
  UNIQUE (tenant_id, task_family, task_id_sha256),
  UNIQUE (tenant_id, task_family, content_workflow_sha256),
  UNIQUE (tenant_id, task_family, store_scope_sha256),
  UNIQUE (tenant_id, task_family, source_event_sha256),
  UNIQUE (tenant_id, member_record_sha256)
);

CREATE TRIGGER trg_lite_learning_external_holdout_member_update
BEFORE UPDATE ON lite_learning_external_holdout_members
BEGIN
  SELECT RAISE(ABORT, 'learning_external_holdout_member_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_holdout_member_delete
BEFORE DELETE ON lite_learning_external_holdout_members
BEGIN
  SELECT RAISE(ABORT, 'learning_external_holdout_member_delete_forbidden');
END;

CREATE TABLE lite_learning_external_ticket_consumptions (
  tenant_id TEXT NOT NULL,
  consumption_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  runner_ticket_sha256 TEXT NOT NULL CHECK (
    length(runner_ticket_sha256) = 64
    AND runner_ticket_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_principal_sha256 TEXT NOT NULL CHECK (
    length(runner_principal_sha256) = 64
    AND runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_process_nonce_sha256 TEXT NOT NULL CHECK (
    length(broker_process_nonce_sha256) = 64
    AND broker_process_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  consume_operation_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  consumption_sha256 TEXT NOT NULL CHECK (
    length(consumption_sha256) = 64
    AND consumption_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, consumption_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, runner_ticket_sha256),
  UNIQUE (tenant_id, broker_process_nonce_sha256),
  UNIQUE (tenant_id, consumption_sha256)
);

CREATE TRIGGER trg_lite_learning_external_ticket_consumption_update
BEFORE UPDATE ON lite_learning_external_ticket_consumptions
BEGIN
  SELECT RAISE(ABORT, 'learning_external_ticket_consumption_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_ticket_consumption_delete
BEFORE DELETE ON lite_learning_external_ticket_consumptions
BEGIN
  SELECT RAISE(ABORT, 'learning_external_ticket_consumption_delete_forbidden');
END;

CREATE TABLE lite_learning_external_preclaim_holds (
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL CHECK (hold_reason IN (
    'sealed_input_mismatch', 'validation_failure', 'preclaim_crash',
    'preclaim_timeout', 'operator_abort', 'broker_integrity_failure'
  )),
  triggering_terminal_fact_sha256 TEXT CHECK (
    triggering_terminal_fact_sha256 IS NULL OR (
      length(triggering_terminal_fact_sha256) = 64
      AND triggering_terminal_fact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  zero_effects_proof_sha256 TEXT NOT NULL CHECK (
    length(zero_effects_proof_sha256) = 64
    AND zero_effects_proof_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_preclaim_hold_receipt_sha256 TEXT NOT NULL CHECK (
    length(broker_preclaim_hold_receipt_sha256) = 64
    AND broker_preclaim_hold_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_preclaim_hold_receipt_json TEXT NOT NULL CHECK (
    json_valid(broker_preclaim_hold_receipt_json)
    AND length(CAST(broker_preclaim_hold_receipt_json AS BLOB)) <= 16384
  ),
  broker_preclaim_hold_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(broker_preclaim_hold_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  hold_actor_id TEXT NOT NULL,
  hold_operation_id TEXT NOT NULL,
  held_at TEXT NOT NULL,
  hold_sha256 TEXT NOT NULL CHECK (
    length(hold_sha256) = 64
    AND hold_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (hold_reason = 'operator_abort'
      AND triggering_terminal_fact_sha256 IS NOT NULL)
    OR (hold_reason <> 'operator_abort'
      AND triggering_terminal_fact_sha256 IS NULL)
  ),
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, broker_preclaim_hold_receipt_sha256),
  UNIQUE (tenant_id, hold_sha256)
);

CREATE TRIGGER trg_lite_learning_external_preclaim_hold_update
BEFORE UPDATE ON lite_learning_external_preclaim_holds
BEGIN
  SELECT RAISE(ABORT, 'learning_external_preclaim_hold_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_preclaim_hold_delete
BEFORE DELETE ON lite_learning_external_preclaim_holds
BEGIN
  SELECT RAISE(ABORT, 'learning_external_preclaim_hold_delete_forbidden');
END;

CREATE TABLE lite_learning_external_run_claims (
  tenant_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  ticket_consumption_sha256 TEXT NOT NULL CHECK (
    length(ticket_consumption_sha256) = 64
    AND ticket_consumption_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_principal_sha256 TEXT NOT NULL CHECK (
    length(runner_principal_sha256) = 64
    AND runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_execution_nonce_sha256 TEXT NOT NULL CHECK (
    length(runner_execution_nonce_sha256) = 64
    AND runner_execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_receipt_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_receipt_sha256) = 64
    AND credential_broker_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_policy_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_policy_sha256) = 64
    AND credential_broker_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_binary_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_binary_sha256) = 64
    AND credential_broker_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_key_id TEXT NOT NULL,
  credential_broker_receipt_json TEXT NOT NULL CHECK (
    json_valid(credential_broker_receipt_json)
    AND length(CAST(credential_broker_receipt_json AS BLOB)) <= 16384
  ),
  credential_broker_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(credential_broker_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  credential_session_id_sha256 TEXT NOT NULL CHECK (
    length(credential_session_id_sha256) = 64
    AND credential_session_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_bind_expires_at TEXT NOT NULL,
  credential_session_expires_at TEXT NOT NULL,
  credential_session_heartbeat_seconds INTEGER NOT NULL CHECK (
    credential_session_heartbeat_seconds BETWEEN 1 AND 60
  ),
  credential_session_max_calls INTEGER NOT NULL CHECK (
    credential_session_max_calls BETWEEN 1 AND 10000
  ),
  claim_operation_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  claim_sha256 TEXT NOT NULL CHECK (
    length(claim_sha256) = 64
    AND claim_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, claim_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, runner_execution_nonce_sha256),
  UNIQUE (tenant_id, credential_session_id_sha256),
  UNIQUE (tenant_id, credential_broker_receipt_sha256),
  UNIQUE (tenant_id, claim_sha256)
);

CREATE TRIGGER trg_lite_learning_external_run_claim_update
BEFORE UPDATE ON lite_learning_external_run_claims
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_claim_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_run_claim_delete
BEFORE DELETE ON lite_learning_external_run_claims
BEGIN
  SELECT RAISE(ABORT, 'learning_external_run_claim_delete_forbidden');
END;

CREATE TABLE lite_learning_external_supervisor_bindings (
  tenant_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  credential_session_id_sha256 TEXT NOT NULL CHECK (
    length(credential_session_id_sha256) = 64
    AND credential_session_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runner_principal_sha256 TEXT NOT NULL CHECK (
    length(runner_principal_sha256) = 64
    AND runner_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_process_identity_sha256 TEXT NOT NULL CHECK (
    length(supervisor_process_identity_sha256) = 64
    AND supervisor_process_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_executable_sha256 TEXT NOT NULL CHECK (
    length(supervisor_executable_sha256) = 64
    AND supervisor_executable_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supervisor_argv_sha256 TEXT NOT NULL CHECK (
    length(supervisor_argv_sha256) = 64
    AND supervisor_argv_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  inherited_channel_sha256 TEXT NOT NULL CHECK (
    length(inherited_channel_sha256) = 64
    AND inherited_channel_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_receipt_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_receipt_sha256) = 64
    AND service_launcher_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_policy_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_policy_sha256) = 64
    AND service_launcher_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_binary_sha256 TEXT NOT NULL CHECK (
    length(service_launcher_binary_sha256) = 64
    AND service_launcher_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_launcher_key_id TEXT NOT NULL,
  supervisor_sandbox_policy_sha256 TEXT NOT NULL CHECK (
    length(supervisor_sandbox_policy_sha256) = 64
    AND supervisor_sandbox_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_binding_receipt_sha256 TEXT NOT NULL CHECK (
    length(broker_binding_receipt_sha256) = 64
    AND broker_binding_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_binding_receipt_json TEXT NOT NULL CHECK (
    json_valid(broker_binding_receipt_json)
    AND length(CAST(broker_binding_receipt_json AS BLOB)) <= 16384
  ),
  broker_binding_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(broker_binding_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  bind_operation_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL CHECK (
    length(binding_sha256) = 64
    AND binding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, binding_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, claim_id),
  UNIQUE (tenant_id, credential_session_id_sha256),
  UNIQUE (tenant_id, supervisor_process_identity_sha256),
  UNIQUE (tenant_id, inherited_channel_sha256),
  UNIQUE (tenant_id, service_launcher_receipt_sha256),
  UNIQUE (tenant_id, broker_binding_receipt_sha256),
  UNIQUE (tenant_id, binding_sha256)
);

CREATE TRIGGER trg_lite_learning_external_supervisor_binding_update
BEFORE UPDATE ON lite_learning_external_supervisor_bindings
BEGIN
  SELECT RAISE(ABORT, 'learning_external_supervisor_binding_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_supervisor_binding_delete
BEFORE DELETE ON lite_learning_external_supervisor_bindings
BEGIN
  SELECT RAISE(ABORT, 'learning_external_supervisor_binding_delete_forbidden');
END;

CREATE TABLE lite_learning_external_session_terminations (
  tenant_id TEXT NOT NULL,
  termination_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  ticket_consumption_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  supervisor_binding_id TEXT,
  credential_session_id_sha256 TEXT NOT NULL CHECK (
    length(credential_session_id_sha256) = 64
    AND credential_session_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  termination_reason TEXT NOT NULL CHECK (termination_reason IN (
    'passed', 'failed', 'inconclusive',
    'launch_failure', 'binding_integrity_failure',
    'runner_crash', 'lease_expired', 'operator_revoke',
    'post_quiesce_revoke', 'finalize_timeout'
  )),
  broker_quiesce_receipt_sha256 TEXT CHECK (
    broker_quiesce_receipt_sha256 IS NULL OR (
      length(broker_quiesce_receipt_sha256) = 64
      AND broker_quiesce_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  runner_output_manifest_sha256 TEXT CHECK (
    runner_output_manifest_sha256 IS NULL OR (
      length(runner_output_manifest_sha256) = 64
      AND runner_output_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  terminal_run_manifest_sha256 TEXT CHECK (
    terminal_run_manifest_sha256 IS NULL OR (
      length(terminal_run_manifest_sha256) = 64
      AND terminal_run_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  attempt_chain_sha256 TEXT NOT NULL CHECK (
    length(attempt_chain_sha256) = 64
    AND attempt_chain_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_policy_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_policy_sha256) = 64
    AND credential_broker_policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_binary_sha256 TEXT NOT NULL CHECK (
    length(credential_broker_binary_sha256) = 64
    AND credential_broker_binary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_broker_key_id TEXT NOT NULL,
  broker_terminal_receipt_sha256 TEXT NOT NULL CHECK (
    length(broker_terminal_receipt_sha256) = 64
    AND broker_terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  broker_terminal_receipt_json TEXT NOT NULL CHECK (
    json_valid(broker_terminal_receipt_json)
    AND length(CAST(broker_terminal_receipt_json AS BLOB)) <= 16384
  ),
  broker_terminal_receipt_signature TEXT NOT NULL CHECK (
    length(CAST(broker_terminal_receipt_signature AS BLOB)) BETWEEN 32 AND 1024
  ),
  termination_actor_id TEXT NOT NULL,
  terminate_operation_id TEXT NOT NULL,
  terminated_at TEXT NOT NULL,
  termination_sha256 TEXT NOT NULL CHECK (
    length(termination_sha256) = 64
    AND termination_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (termination_reason IN ('passed', 'failed', 'inconclusive')
      AND supervisor_binding_id IS NOT NULL
      AND broker_quiesce_receipt_sha256 IS NOT NULL
      AND runner_output_manifest_sha256 IS NOT NULL
      AND terminal_run_manifest_sha256 IS NOT NULL)
    OR (termination_reason IN ('post_quiesce_revoke', 'finalize_timeout')
      AND supervisor_binding_id IS NOT NULL
      AND broker_quiesce_receipt_sha256 IS NOT NULL
      AND runner_output_manifest_sha256 IS NOT NULL
      AND terminal_run_manifest_sha256 IS NULL)
    OR (termination_reason IN ('launch_failure', 'binding_integrity_failure')
      AND supervisor_binding_id IS NULL
      AND broker_quiesce_receipt_sha256 IS NULL
      AND runner_output_manifest_sha256 IS NULL
      AND terminal_run_manifest_sha256 IS NULL)
    OR (termination_reason IN (
      'runner_crash', 'lease_expired', 'operator_revoke'
    )
      AND broker_quiesce_receipt_sha256 IS NULL
      AND runner_output_manifest_sha256 IS NULL
      AND terminal_run_manifest_sha256 IS NULL)
  ),
  PRIMARY KEY (tenant_id, termination_id),
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, ticket_consumption_id),
  UNIQUE (tenant_id, claim_id),
  UNIQUE (tenant_id, supervisor_binding_id),
  UNIQUE (tenant_id, credential_session_id_sha256),
  UNIQUE (tenant_id, broker_terminal_receipt_sha256),
  UNIQUE (tenant_id, termination_sha256)
);

CREATE TRIGGER trg_lite_learning_external_session_termination_update
BEFORE UPDATE ON lite_learning_external_session_terminations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_session_termination_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_session_termination_delete
BEFORE DELETE ON lite_learning_external_session_terminations
BEGIN
  SELECT RAISE(ABORT, 'learning_external_session_termination_delete_forbidden');
END;
CREATE TABLE lite_learning_evidence_artifacts (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'offline_paired_rerun', 'production_shadow_gate',
    'tool_e2e_gate', 'runtime_integrity_gate'
  )),
  evidence_series_id TEXT NOT NULL,
  external_run_reservation_id TEXT,
  external_ticket_consumption_id TEXT,
  external_run_claim_id TEXT,
  external_supervisor_binding_id TEXT,
  external_session_termination_id TEXT,
  supersedes_artifact_id TEXT CHECK (
    supersedes_artifact_id IS NULL OR supersedes_artifact_id <> artifact_id
  ),
  artifact_status TEXT NOT NULL CHECK (artifact_status IN (
    'passed', 'failed', 'inconclusive'
  )),
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_config_sha256) = 64
    AND candidate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  applicable_experiment_id TEXT NOT NULL,
  applicable_experiment_revision INTEGER NOT NULL CHECK (
    applicable_experiment_revision >= 1
  ),
  source_experiment_id TEXT,
  source_experiment_revision INTEGER CHECK (
    source_experiment_revision IS NULL OR source_experiment_revision >= 1
  ),
  source_serving_phase TEXT NOT NULL CHECK (source_serving_phase IN (
    'isolated_paired', 'aa', 'shadow', 'active_control', 'external_tool'
  )),
  look_index INTEGER CHECK (look_index IS NULL OR look_index >= 1),
  look_proposal_sha256 TEXT CHECK (
    look_proposal_sha256 IS NULL OR (
      length(look_proposal_sha256) = 64
      AND look_proposal_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_scope_set_sha256 TEXT NOT NULL CHECK (
    length(evidence_scope_set_sha256) = 64
    AND evidence_scope_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_bundle_sha256 TEXT NOT NULL CHECK (
    length(source_bundle_sha256) = 64
    AND source_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  harness_bundle_sha256 TEXT NOT NULL CHECK (
    length(harness_bundle_sha256) = 64
    AND harness_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  report_sha256 TEXT NOT NULL CHECK (
    length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  report_json TEXT NOT NULL CHECK (
    json_valid(report_json)
    AND length(CAST(report_json AS BLOB)) <= 524288
  ),
  source_ref TEXT NOT NULL,
  source_commit_id TEXT,
  collected_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  CHECK (
    (artifact_kind = 'runtime_integrity_gate'
      AND external_run_reservation_id IS NULL
      AND external_ticket_consumption_id IS NULL
      AND external_run_claim_id IS NULL
      AND external_supervisor_binding_id IS NULL
      AND external_session_termination_id IS NULL
      AND look_index IS NOT NULL AND look_proposal_sha256 IS NOT NULL)
    OR (artifact_kind <> 'runtime_integrity_gate'
      AND external_run_reservation_id IS NOT NULL
      AND external_ticket_consumption_id IS NOT NULL
      AND external_run_claim_id IS NOT NULL
      AND external_supervisor_binding_id IS NOT NULL
      AND external_session_termination_id IS NOT NULL
      AND supersedes_artifact_id IS NULL
      AND look_index IS NULL AND look_proposal_sha256 IS NULL)
  ),
  UNIQUE (tenant_id, artifact_id),
  UNIQUE (tenant_id, report_sha256),
  UNIQUE (tenant_id, supersedes_artifact_id)
);

CREATE UNIQUE INDEX idx_lite_learning_evidence_series_root
  ON lite_learning_evidence_artifacts(tenant_id, evidence_series_id)
  WHERE supersedes_artifact_id IS NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_result_once
  ON lite_learning_evidence_artifacts(tenant_id, external_run_reservation_id)
  WHERE external_run_reservation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_claim_result_once
  ON lite_learning_evidence_artifacts(tenant_id, external_run_claim_id)
  WHERE external_run_claim_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_consumption_result_once
  ON lite_learning_evidence_artifacts(tenant_id, external_ticket_consumption_id)
  WHERE external_ticket_consumption_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_termination_result_once
  ON lite_learning_evidence_artifacts(
    tenant_id, external_session_termination_id
  )
  WHERE external_session_termination_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_external_binding_result_once
  ON lite_learning_evidence_artifacts(
    tenant_id, external_supervisor_binding_id
  )
  WHERE external_supervisor_binding_id IS NOT NULL;
CREATE TABLE lite_learning_gate_look_reservations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  gate_policy_config_sha256 TEXT NOT NULL CHECK (
    length(gate_policy_config_sha256) = 64
    AND gate_policy_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  look_schedule_sha256 TEXT NOT NULL CHECK (
    length(look_schedule_sha256) = 64
    AND look_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  randomization_pair_manifest_sha256 TEXT NOT NULL CHECK (
    length(randomization_pair_manifest_sha256) = 64
    AND randomization_pair_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  activation_schedule_sha256 TEXT NOT NULL CHECK (
    length(activation_schedule_sha256) = 64
    AND activation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  look_index INTEGER NOT NULL CHECK (look_index >= 1),
  target_cumulative_pair_count INTEGER NOT NULL CHECK (
    target_cumulative_pair_count >= 1
  ),
  analysis_at TEXT NOT NULL,
  evidence_cutoff_event_row_id INTEGER NOT NULL CHECK (
    evidence_cutoff_event_row_id >= 0
  ),
  evidence_artifact_cutoff_row_id INTEGER NOT NULL CHECK (
    evidence_artifact_cutoff_row_id >= 1
  ),
  candidate_scheduled_namespace_count INTEGER NOT NULL CHECK (
    candidate_scheduled_namespace_count = target_cumulative_pair_count
  ),
  control_scheduled_namespace_count INTEGER NOT NULL CHECK (
    control_scheduled_namespace_count = target_cumulative_pair_count
  ),
  candidate_index_exposure_count INTEGER NOT NULL CHECK (
    candidate_index_exposure_count BETWEEN 0 AND candidate_scheduled_namespace_count
  ),
  control_index_exposure_count INTEGER NOT NULL CHECK (
    control_index_exposure_count BETWEEN 0 AND control_scheduled_namespace_count
  ),
  candidate_no_index_count INTEGER NOT NULL CHECK (
    candidate_no_index_count >= 0
    AND candidate_no_index_count + candidate_index_exposure_count
      = candidate_scheduled_namespace_count
  ),
  control_no_index_count INTEGER NOT NULL CHECK (
    control_no_index_count >= 0
    AND control_no_index_count + control_index_exposure_count
      = control_scheduled_namespace_count
  ),
  candidate_verified_receipt_count INTEGER NOT NULL CHECK (
    candidate_verified_receipt_count BETWEEN 0 AND candidate_scheduled_namespace_count
  ),
  control_verified_receipt_count INTEGER NOT NULL CHECK (
    control_verified_receipt_count BETWEEN 0 AND control_scheduled_namespace_count
  ),
  runtime_integrity_artifact_id TEXT NOT NULL,
  runtime_integrity_report_sha256 TEXT NOT NULL CHECK (
    length(runtime_integrity_report_sha256) = 64
    AND runtime_integrity_report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  runtime_integrity_run_bundle_sha256 TEXT NOT NULL CHECK (
    length(runtime_integrity_run_bundle_sha256) = 64
    AND runtime_integrity_run_bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_artifact_heads_sha256 TEXT NOT NULL CHECK (
    length(required_artifact_heads_sha256) = 64
    AND required_artifact_heads_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_basis_sha256 TEXT NOT NULL CHECK (
    length(trigger_basis_sha256) = 64
    AND trigger_basis_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_basis_json TEXT NOT NULL CHECK (json_valid(trigger_basis_json)),
  reservation_sha256 TEXT NOT NULL CHECK (
    length(reservation_sha256) = 64
    AND reservation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, reservation_id),
  UNIQUE (tenant_id, operation_id),
  UNIQUE (
    tenant_id, task_family, candidate_policy_id, candidate_policy_version,
    candidate_policy_implementation_sha256, experiment_id,
    experiment_revision, gate_policy_id, gate_policy_version,
    look_index
  )
);
CREATE TABLE lite_learning_gate_decisions (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  task_family TEXT NOT NULL,
  candidate_policy_id TEXT NOT NULL,
  candidate_policy_version TEXT NOT NULL,
  candidate_policy_implementation_sha256 TEXT NOT NULL CHECK (
    length(candidate_policy_implementation_sha256) = 64
    AND candidate_policy_implementation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_id TEXT NOT NULL,
  experiment_revision INTEGER NOT NULL CHECK (experiment_revision >= 1),
  gate_policy_id TEXT NOT NULL,
  gate_policy_version TEXT NOT NULL,
  look_index INTEGER CHECK (look_index IS NULL OR look_index >= 1),
  look_reservation_id TEXT,
  look_reservation_sha256 TEXT CHECK (
    look_reservation_sha256 IS NULL OR (
      length(look_reservation_sha256) = 64
      AND look_reservation_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN (
    'evidence_evaluation', 'authority_adjudication', 'safety_stop'
  )),
  evidence_verdict TEXT NOT NULL CHECK (evidence_verdict IN (
    'hold', 'promotion_ready', 'pause_required',
    'demotion_ready', 'retirement_ready'
  )),
  authority_action TEXT CHECK (authority_action IS NULL OR authority_action IN (
    'hold', 'promote', 'pause', 'demote', 'retire'
  )),
  authority_scope TEXT NOT NULL CHECK (authority_scope IN (
    'experiment_revision', 'task_family_candidate_implementation'
  )),
  analysis_at TEXT NOT NULL,
  evidence_cutoff_event_row_id INTEGER NOT NULL CHECK (
    evidence_cutoff_event_row_id >= 0
  ),
  evidence_artifact_cutoff_row_id INTEGER NOT NULL CHECK (
    evidence_artifact_cutoff_row_id >= 0
  ),
  evidence_artifact_count INTEGER NOT NULL CHECK (
    evidence_artifact_count >= 0
  ),
  experiment_config_sha256 TEXT NOT NULL CHECK (
    length(experiment_config_sha256) = 64
    AND experiment_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_scope_set_sha256 TEXT NOT NULL CHECK (
    length(evidence_scope_set_sha256) = 64
    AND evidence_scope_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_cohort_sha256 TEXT NOT NULL CHECK (
    length(evidence_cohort_sha256) = 64
    AND evidence_cohort_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_artifact_set_sha256 TEXT NOT NULL CHECK (
    length(evidence_artifact_set_sha256) = 64
    AND evidence_artifact_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_summary_sha256 TEXT NOT NULL CHECK (
    length(evidence_summary_sha256) = 64
    AND evidence_summary_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_summary_json TEXT NOT NULL CHECK (json_valid(evidence_summary_json)),
  decision_sha256 TEXT NOT NULL CHECK (
    length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trigger_ref_kind TEXT CHECK (trigger_ref_kind IS NULL OR trigger_ref_kind IN (
    'episode_feedback', 'control_job', 'gate_evaluation', 'assignment_integrity',
    'artifact_integrity', 'ledger_integrity', 'config_integrity'
  )),
  trigger_ref_id TEXT,
  trigger_episode_id TEXT,
  supersedes_decision_id TEXT CHECK (
    supersedes_decision_id IS NULL OR supersedes_decision_id <> decision_id
  ),
  basis_evidence_decision_id TEXT,
  authority_mutation_id TEXT,
  source_commit_id TEXT,
  adjudication_observed_event_head_row_id INTEGER CHECK (
    adjudication_observed_event_head_row_id IS NULL
    OR adjudication_observed_event_head_row_id >= 1
  ),
  adjudication_observed_artifact_head_row_id INTEGER CHECK (
    adjudication_observed_artifact_head_row_id IS NULL
    OR adjudication_observed_artifact_head_row_id >= 0
  ),
  post_cutoff_safety_sha256 TEXT CHECK (
    post_cutoff_safety_sha256 IS NULL OR (
      length(post_cutoff_safety_sha256) = 64
      AND post_cutoff_safety_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN (
    'none', 'signed_operator', 'safety_automatic'
  )),
  authorization_sha256 TEXT CHECK (
    authorization_sha256 IS NULL OR (
      length(authorization_sha256) = 64
      AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  authorization_payload_json TEXT CHECK (
    authorization_payload_json IS NULL OR (
      json_valid(authorization_payload_json)
      AND length(CAST(authorization_payload_json AS BLOB)) <= 65536
    )
  ),
  authorization_mac TEXT,
  authorization_nonce TEXT,
  authorization_expires_at TEXT,
  authorization_key_id TEXT,
  approved_by TEXT,
  authority_operation_id TEXT,
  authority_operation_scope TEXT,
  authority_operation_kind TEXT CHECK (
    authority_operation_kind IS NULL
    OR authority_operation_kind = 'learning_gate_authority_v1'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (
      decision_kind = 'evidence_evaluation'
      AND authority_action IS NULL
      AND authority_scope = 'experiment_revision'
      AND basis_evidence_decision_id IS NULL
      AND trigger_ref_kind IS NULL
      AND trigger_ref_id IS NULL
      AND trigger_episode_id IS NULL
      AND look_index IS NOT NULL
      AND (
        (look_index = 1 AND supersedes_decision_id IS NULL)
        OR (look_index > 1 AND supersedes_decision_id IS NOT NULL)
      )
      AND evidence_cutoff_event_row_id >= 1
      AND evidence_artifact_cutoff_row_id >= 1
      AND look_reservation_id IS NOT NULL
      AND look_reservation_sha256 IS NOT NULL
      AND adjudication_observed_event_head_row_id IS NULL
      AND adjudication_observed_artifact_head_row_id IS NULL
      AND post_cutoff_safety_sha256 IS NULL
      AND authorization_kind = 'none'
      AND authorization_sha256 IS NULL
      AND authorization_payload_json IS NULL
      AND authority_operation_id IS NULL
      AND authority_operation_scope IS NULL
      AND authority_operation_kind IS NULL
    )
    OR (
      decision_kind = 'authority_adjudication'
      AND authority_action IS NOT NULL
      AND basis_evidence_decision_id IS NOT NULL
      AND trigger_ref_kind IS NULL
      AND trigger_ref_id IS NULL
      AND trigger_episode_id IS NULL
      AND supersedes_decision_id IS NULL
      AND look_index IS NOT NULL
      AND evidence_cutoff_event_row_id >= 1
      AND evidence_artifact_cutoff_row_id >= 1
      AND look_reservation_id IS NOT NULL
      AND look_reservation_sha256 IS NOT NULL
      AND adjudication_observed_event_head_row_id IS NOT NULL
      AND adjudication_observed_artifact_head_row_id IS NOT NULL
      AND post_cutoff_safety_sha256 IS NOT NULL
      AND authorization_kind = 'signed_operator'
      AND authorization_sha256 IS NOT NULL
      AND authorization_payload_json IS NOT NULL
      AND authority_operation_id IS NOT NULL
      AND authority_operation_scope IS NOT NULL
      AND authority_operation_kind = 'learning_gate_authority_v1'
    ) OR (
      decision_kind = 'safety_stop'
      AND evidence_verdict = 'pause_required'
      AND authority_action = 'pause'
      AND authority_scope = 'task_family_candidate_implementation'
      AND trigger_ref_kind IS NOT NULL
      AND trigger_ref_id IS NOT NULL
      AND (
        trigger_ref_kind <> 'episode_feedback'
        OR trigger_episode_id IS NOT NULL
      )
      AND basis_evidence_decision_id IS NULL
      AND supersedes_decision_id IS NULL
      AND look_index IS NULL
      AND look_reservation_id IS NULL
      AND look_reservation_sha256 IS NULL
      AND authorization_kind = 'safety_automatic'
      AND authorization_sha256 IS NOT NULL
      AND authorization_payload_json IS NOT NULL
      AND authority_operation_id IS NOT NULL
      AND authority_operation_scope IS NOT NULL
      AND authority_operation_kind = 'learning_gate_authority_v1'
    )
  ),
  CHECK (
    authority_action IS NULL OR authority_action = 'hold'
    OR (authority_action = 'promote' AND evidence_verdict = 'promotion_ready')
    OR (authority_action = 'pause' AND evidence_verdict = 'pause_required')
    OR (authority_action = 'demote' AND evidence_verdict = 'demotion_ready')
    OR (authority_action = 'retire' AND evidence_verdict = 'retirement_ready')
  ),
  CHECK (
    authority_action NOT IN ('promote', 'demote', 'retire')
    OR authority_mutation_id IS NOT NULL
  ),
  CHECK (
    authority_action NOT IN ('promote', 'pause', 'demote', 'retire')
    OR authority_scope = 'task_family_candidate_implementation'
  ),
  CHECK (
    authorization_kind <> 'signed_operator'
    OR (
      authorization_key_id IS NOT NULL
      AND approved_by IS NOT NULL
      AND authorization_mac IS NOT NULL
      AND authorization_nonce IS NOT NULL
      AND authorization_expires_at IS NOT NULL
    )
  ),
  CHECK (
    authorization_kind = 'signed_operator'
    OR (
      authorization_key_id IS NULL
      AND approved_by IS NULL
      AND authorization_mac IS NULL
      AND authorization_nonce IS NULL
      AND authorization_expires_at IS NULL
    )
  ),
  CHECK (
    authorization_kind <> 'safety_automatic'
    OR (authority_action = 'pause' AND evidence_verdict = 'pause_required')
  ),
  CHECK (
    authority_action NOT IN ('demote', 'retire')
    OR authorization_kind = 'signed_operator'
  ),
  UNIQUE (tenant_id, decision_id),
  UNIQUE (
    tenant_id, authority_operation_scope,
    authority_operation_kind, authority_operation_id
  ),
  UNIQUE (
    tenant_id, task_family, candidate_policy_id,
    candidate_policy_version, candidate_policy_implementation_sha256,
    experiment_id, experiment_revision,
    gate_policy_id, gate_policy_version, decision_kind,
    look_index, evidence_cutoff_event_row_id,
    evidence_artifact_cutoff_row_id, analysis_at
  )
);

CREATE UNIQUE INDEX idx_lite_learning_gate_decision_one_superseder
  ON lite_learning_gate_decisions(tenant_id, supersedes_decision_id)
  WHERE decision_kind = 'evidence_evaluation'
    AND supersedes_decision_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_learning_gate_authorization_nonce
  ON lite_learning_gate_decisions(
    tenant_id, authorization_key_id, authorization_nonce
  )
  WHERE authorization_kind = 'signed_operator';
CREATE TABLE lite_learning_gate_artifact_memberships (
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_role TEXT NOT NULL CHECK (artifact_role IN (
    'offline_primary', 'production_shadow', 'tool_e2e', 'runtime_integrity'
  )),
  role_ordinal INTEGER NOT NULL CHECK (role_ordinal >= 0),
  report_sha256 TEXT NOT NULL CHECK (
    length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  membership_sha256 TEXT NOT NULL CHECK (
    length(membership_sha256) = 64
    AND membership_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, decision_id, artifact_id),
  UNIQUE (tenant_id, decision_id, artifact_role, role_ordinal)
);
`;

const APPEND_ONLY_TABLES = [
  "lite_learning_policy_versions",
  "lite_learning_collection_principal_bindings",
  "lite_learning_experiment_revisions",
  "lite_learning_confirmatory_attempts",
  "lite_learning_experiment_closures",
  "lite_learning_authorization_nonces",
  "lite_learning_episode_events",
  "lite_learning_exposure_items",
  "lite_learning_feedback_attributions",
  "lite_learning_host_use_receipts",
  "lite_learning_evidence_artifacts",
  "lite_learning_gate_look_reservations",
  "lite_learning_gate_decisions",
  "lite_learning_gate_artifact_memberships",
] as const;

function appendOnlyTriggerSql(table: string): string {
  return `
CREATE TRIGGER trg_${table}_update
BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table}_update_forbidden');
END;

CREATE TRIGGER trg_${table}_delete
BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table}_delete_forbidden');
END;
`;
}

const GENERATED_APPEND_ONLY_TRIGGER_DDL = APPEND_ONLY_TABLES
  .map((table) => appendOnlyTriggerSql(table))
  .join("\n");

const LEARNING_POLICY_TABLE_MARKER = "CREATE TABLE lite_learning_policy_versions";
const learningPolicyOffset = ARCHITECTURE_V3_DDL.indexOf(LEARNING_POLICY_TABLE_MARKER);
if (learningPolicyOffset < 0) {
  throw new Error("Learning-ledger v3 DDL is missing its policy table marker");
}

export const LITE_RUNTIME_AUTHORITY_IDENTITY_SCHEMA_SQL = ARCHITECTURE_V3_DDL
  .slice(0, learningPolicyOffset)
  .trim();

export const LITE_LEARNING_EPISODE_LEDGER_SCHEMA_SQL = [
  ARCHITECTURE_V3_DDL.slice(learningPolicyOffset).trim(),
  GENERATED_APPEND_ONLY_TRIGGER_DDL.trim(),
].join("\n\n");

export const LITE_LEARNING_COMPLETE_V3_SCHEMA_SQL = [
  LITE_RUNTIME_AUTHORITY_IDENTITY_SCHEMA_SQL,
  LITE_LEARNING_EPISODE_LEDGER_SCHEMA_SQL,
].join("\n\n");

type ParsedTable = {
  name: string;
  body: string;
  statement: string;
};

function findClosingParenthesis(sql: string, openingOffset: number): number {
  let depth = 0;
  let inString = false;
  for (let index = openingOffset; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      if (inString && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unterminated CREATE TABLE statement in learning-ledger v3 DDL");
}

function parseTables(sql: string): ParsedTable[] {
  const out: ParsedTable[] = [];
  const matcher = /CREATE TABLE\s+([a-z0-9_]+)\s*\(/giu;
  for (let match = matcher.exec(sql); match; match = matcher.exec(sql)) {
    const name = match[1];
    if (!name) continue;
    const openingOffset = matcher.lastIndex - 1;
    const closingOffset = findClosingParenthesis(sql, openingOffset);
    const semicolonOffset = sql.indexOf(";", closingOffset);
    if (semicolonOffset < 0) throw new Error(`Missing semicolon after CREATE TABLE ${name}`);
    out.push({
      name,
      body: sql.slice(openingOffset + 1, closingOffset),
      statement: sql.slice(match.index, semicolonOffset + 1),
    });
    matcher.lastIndex = semicolonOffset + 1;
  }
  return out;
}

function splitTopLevelSqlList(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      if (inString && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      out.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function parseIdentifierList(value: string): string[] {
  const match = value.match(/\(([\s\S]*)\)/u);
  if (!match?.[1]) return [];
  return splitTopLevelSqlList(match[1]).map((entry) => {
    const identifier = entry.trim().match(/^([a-z_][a-z0-9_]*)/iu)?.[1];
    if (!identifier) throw new Error(`Unsupported SQL identifier in v3 constraint: ${entry}`);
    return identifier;
  });
}

export type LiteLearningRequiredTableConstraint = {
  primaryKey: readonly string[];
  uniqueKeys: ReadonlyArray<readonly string[]>;
  createTableSql: string;
};

function parseLearningLedgerRequirements(sql: string): {
  columns: Record<string, readonly string[]>;
  constraints: Record<string, LiteLearningRequiredTableConstraint>;
} {
  const columns: Record<string, readonly string[]> = {};
  const constraints: Record<string, LiteLearningRequiredTableConstraint> = {};
  for (const table of parseTables(sql)) {
    const tableColumns: string[] = [];
    let primaryKey: string[] = [];
    const uniqueKeys: string[][] = [];
    for (const entry of splitTopLevelSqlList(table.body)) {
      const normalized = entry.trim();
      const upper = normalized.toUpperCase();
      if (upper.startsWith("PRIMARY KEY")) {
        primaryKey = parseIdentifierList(normalized);
        continue;
      }
      if (upper.startsWith("UNIQUE")) {
        uniqueKeys.push(parseIdentifierList(normalized));
        continue;
      }
      if (
        upper.startsWith("CHECK")
        || upper.startsWith("FOREIGN KEY")
        || upper.startsWith("CONSTRAINT")
      ) {
        continue;
      }
      const column = normalized.match(/^([a-z_][a-z0-9_]*)\b/iu)?.[1];
      if (!column) throw new Error(`Unsupported v3 column definition in ${table.name}: ${entry}`);
      tableColumns.push(column);
      if (/\bPRIMARY\s+KEY\b/iu.test(normalized)) primaryKey = [column];
      if (/\bUNIQUE\b/iu.test(normalized)) uniqueKeys.push([column]);
    }
    columns[table.name] = Object.freeze(tableColumns);
    constraints[table.name] = Object.freeze({
      primaryKey: Object.freeze(primaryKey),
      uniqueKeys: Object.freeze(uniqueKeys.map((key) => Object.freeze(key))),
      createTableSql: table.statement,
    });
  }
  return { columns, constraints };
}

export type LiteLearningRequiredIndex = {
  table: string;
  columns: ReadonlyArray<{ name: string; descending?: boolean }>;
  unique: boolean;
  partial: boolean;
  predicate?: string;
  sql: string;
};

function normalizeSql(value: string): string {
  return value.trim().replace(/;$/u, "").trim().toLowerCase().replaceAll(/\s+/gu, " ");
}

function parseIndexes(sql: string): Record<string, LiteLearningRequiredIndex> {
  const out: Record<string, LiteLearningRequiredIndex> = {};
  const matcher = /CREATE\s+(UNIQUE\s+)?INDEX\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\s*\(([^)]*)\)\s*(?:WHERE\s+([\s\S]*?))?;/giu;
  for (let match = matcher.exec(sql); match; match = matcher.exec(sql)) {
    const [, uniqueKeyword, name, table, rawColumns, rawPredicate] = match;
    if (!name || !table || rawColumns === undefined) continue;
    const columns = splitTopLevelSqlList(rawColumns).map((entry) => {
      const parsed = entry.trim().match(/^([a-z_][a-z0-9_]*)(?:\s+(ASC|DESC))?$/iu);
      if (!parsed?.[1]) throw new Error(`Unsupported v3 index column: ${entry}`);
      return Object.freeze({
        name: parsed[1],
        ...(parsed[2]?.toUpperCase() === "DESC" ? { descending: true } : {}),
      });
    });
    const predicate = rawPredicate ? normalizeSql(rawPredicate) : undefined;
    out[name] = Object.freeze({
      table,
      columns: Object.freeze(columns),
      unique: uniqueKeyword !== undefined,
      partial: predicate !== undefined,
      ...(predicate ? { predicate } : {}),
      sql: match[0],
    });
  }
  return out;
}

export type LiteLearningRequiredTrigger = {
  table: string;
  sql: string;
};

function parseTriggers(sql: string): Record<string, LiteLearningRequiredTrigger> {
  const out: Record<string, LiteLearningRequiredTrigger> = {};
  const matcher = /CREATE TRIGGER\s+([a-z0-9_]+)[\s\S]*?\bON\s+([a-z0-9_]+)[\s\S]*?END;/giu;
  for (let match = matcher.exec(sql); match; match = matcher.exec(sql)) {
    const [, name, table] = match;
    if (name && table) out[name] = Object.freeze({ table, sql: match[0] });
  }
  return out;
}

const PARSED_V3_REQUIREMENTS = parseLearningLedgerRequirements(
  LITE_LEARNING_COMPLETE_V3_SCHEMA_SQL,
);

export const LITE_LEARNING_LEDGER_REQUIRED_COLUMNS = Object.freeze(
  PARSED_V3_REQUIREMENTS.columns,
);

export const LITE_LEARNING_LEDGER_REQUIRED_CONSTRAINTS = Object.freeze(
  PARSED_V3_REQUIREMENTS.constraints,
);

export const LITE_LEARNING_LEDGER_REQUIRED_INDEXES = Object.freeze(
  parseIndexes(LITE_LEARNING_COMPLETE_V3_SCHEMA_SQL),
);

export const LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS = Object.freeze(
  parseTriggers(LITE_LEARNING_COMPLETE_V3_SCHEMA_SQL),
);

export const LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES = Object.freeze(
  Object.keys(LITE_LEARNING_LEDGER_REQUIRED_COLUMNS).sort(),
);

export const LITE_LEARNING_LEDGER_REQUIRED_INDEX_NAMES = Object.freeze(
  Object.keys(LITE_LEARNING_LEDGER_REQUIRED_INDEXES).sort(),
);

export const LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES = Object.freeze(
  Object.keys(LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS).sort(),
);

export function migrateLiteRuntimeAuthorityIdentity(
  db: SqliteDatabase,
  options: {
    now?: Date;
    randomBytesFactory?: (size: number) => Uint8Array;
  } = {},
): string {
  db.exec(LITE_RUNTIME_AUTHORITY_IDENTITY_SCHEMA_SQL);
  const existing = db.prepare(
    "SELECT singleton, database_instance_id FROM lite_runtime_authority_identity",
  ).all() as Array<{ singleton: number; database_instance_id: string }>;
  if (existing.length === 0) {
    const bytes = options.randomBytesFactory?.(32) ?? randomBytes(32);
    if (bytes.byteLength !== 32) {
      throw new Error("Runtime authority identity requires exactly 32 random bytes");
    }
    const databaseInstanceId = Buffer.from(bytes).toString("hex");
    db.prepare(
      `INSERT INTO lite_runtime_authority_identity
         (singleton, database_instance_id, created_at)
       VALUES (1, ?, ?)`,
    ).run(databaseInstanceId, (options.now ?? new Date()).toISOString());
  }
  return assertLiteRuntimeAuthorityIdentity(db);
}

export function migrateLiteLearningEpisodeLedgerSchema(db: SqliteDatabase): void {
  db.exec(LITE_LEARNING_EPISODE_LEDGER_SCHEMA_SQL);
}

export function assertLiteRuntimeAuthorityIdentity(db: SqliteDatabase): string {
  const rows = db.prepare(
    "SELECT singleton, database_instance_id FROM lite_runtime_authority_identity ORDER BY singleton",
  ).all() as Array<{ singleton: number; database_instance_id: string }>;
  if (
    rows.length !== 1
    || rows[0]?.singleton !== 1
    || !/^[0-9a-f]{64}$/u.test(rows[0]?.database_instance_id ?? "")
  ) {
    throw new Error("lite_learning_integrity_failed:runtime_authority_identity");
  }
  return rows[0].database_instance_id;
}

type CountRow = { count: number };

function scalarCount(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as CountRow | undefined)?.count ?? 0);
}

export function assertLiteLearningEpisodeLedgerSchemaIntegrity(db: SqliteDatabase): void {
  const problems: string[] = [];
  const objectStatement = db.prepare(
    `SELECT type, tbl_name AS table_name, sql
     FROM sqlite_schema WHERE name = ?`,
  );
  const assertObject = (
    type: "table" | "index" | "trigger",
    name: string,
    expectedTable: string,
    expectedSql: string,
  ): void => {
    const row = objectStatement.get(name) as {
      type: string;
      table_name: string;
      sql: string | null;
    } | undefined;
    if (!row) {
      problems.push(`missing ${type} ${name}`);
      return;
    }
    if (row.type !== type || row.table_name !== expectedTable) {
      problems.push(`${type} ${name} is bound to the wrong object`);
      return;
    }
    if (!row.sql || normalizeSql(row.sql) !== normalizeSql(expectedSql)) {
      problems.push(`${type} ${name} definition mismatch`);
    }
  };

  for (const [table, requirement] of Object.entries(LITE_LEARNING_LEDGER_REQUIRED_CONSTRAINTS)) {
    assertObject("table", table, table, requirement.createTableSql);
  }
  for (const [index, requirement] of Object.entries(LITE_LEARNING_LEDGER_REQUIRED_INDEXES)) {
    assertObject("index", index, requirement.table, requirement.sql);
  }
  for (const [trigger, requirement] of Object.entries(LITE_LEARNING_LEDGER_REQUIRED_TRIGGERS)) {
    assertObject("trigger", trigger, requirement.table, requirement.sql);
  }
  if (problems.length > 0) {
    throw new Error(`lite_learning_schema_integrity_failed:${JSON.stringify(problems)}`);
  }
}

export function assertLiteLearningEpisodeLedgerIntegrity(
  db: SqliteDatabase,
  checkedAt = new Date().toISOString(),
): LiteLearningEpisodeLedgerReplay {
  assertLiteLearningEpisodeLedgerSchemaIntegrity(db);
  assertLiteRuntimeAuthorityIdentity(db);

  for (const row of db.prepare(
    `SELECT ${LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_external_run_reservations
      .filter((column) => column !== "row_id").join(", ")}
     FROM lite_learning_external_run_reservations
     ORDER BY tenant_id, reservation_id`,
  ).all() as LiteLearningAuthorityRow[]) {
    assertCanonicalJsonDigest(row, "retry_policy_json", "retry_policy_sha256");
    assertCanonicalJsonDigest(row, "immutable_input_manifest_json", "immutable_input_manifest_sha256");
    if (row.reservation_sha256 !== learningExternalRunReservationDigest(row)) {
      throw new Error("lite_learning_integrity_failed:external_run_reservation_digest");
    }
  }
  for (const row of db.prepare(
    `SELECT ${LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_external_ticket_consumptions
      .filter((column) => column !== "row_id").join(", ")}
     FROM lite_learning_external_ticket_consumptions
     ORDER BY tenant_id, consumption_id`,
  ).all() as LiteLearningAuthorityRow[]) {
    if (row.consumption_sha256 !== learningExternalTicketConsumptionDigest(row)) {
      throw new Error("lite_learning_integrity_failed:external_ticket_consumption_digest");
    }
  }

  const incompleteAttempts = db.prepare(
    `SELECT attempt.tenant_id, attempt.confirmatory_attempt_id
     FROM lite_learning_confirmatory_attempts AS attempt
     LEFT JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = attempt.tenant_id
      AND pair_row.confirmatory_attempt_id = attempt.confirmatory_attempt_id
     LEFT JOIN lite_learning_namespace_leases AS lease
       ON lease.tenant_id = attempt.tenant_id
      AND lease.confirmatory_attempt_id = attempt.confirmatory_attempt_id
     GROUP BY attempt.tenant_id, attempt.confirmatory_attempt_id
     HAVING COUNT(DISTINCT pair_row.randomization_pair_sha256) <> 384
        OR COUNT(DISTINCT lease.memory_namespace_sha256) <> 768`,
  ).all();
  if (incompleteAttempts.length > 0) {
    throw new Error("lite_learning_integrity_failed:incomplete_confirmatory_manifest");
  }

  const pairArmImbalance = db.prepare(
    `SELECT tenant_id, confirmatory_attempt_id, randomization_pair_sha256
     FROM lite_learning_namespace_leases
     GROUP BY tenant_id, confirmatory_attempt_id, randomization_pair_sha256
     HAVING COUNT(*) <> 2
        OR SUM(CASE WHEN assigned_arm = 'candidate' THEN 1 ELSE 0 END) <> 1
        OR SUM(CASE WHEN assigned_arm = 'control' THEN 1 ELSE 0 END) <> 1
        OR COUNT(DISTINCT pair_member_ordinal) <> 2`,
  ).all();
  if (pairArmImbalance.length > 0) {
    throw new Error("lite_learning_integrity_failed:namespace_pair_arm_imbalance");
  }

  const partialRelease = db.prepare(
    `SELECT tenant_id, confirmatory_attempt_id
     FROM lite_learning_namespace_leases
     GROUP BY tenant_id, confirmatory_attempt_id
     HAVING COUNT(DISTINCT status) > 1
        OR COUNT(DISTINCT COALESCE(release_operation_id, '')) > 1
        OR COUNT(DISTINCT COALESCE(release_ref_kind, '')) > 1
        OR COUNT(DISTINCT COALESCE(release_ref_id, '')) > 1
        OR COUNT(DISTINCT COALESCE(released_at, '')) > 1`,
  ).all();
  if (partialRelease.length > 0) {
    throw new Error("lite_learning_integrity_failed:partial_or_mixed_namespace_release");
  }

  const generationGaps = db.prepare(
    `SELECT tenant_id, memory_namespace_sha256
     FROM lite_learning_namespace_leases
     GROUP BY tenant_id, memory_namespace_sha256
     HAVING MIN(lease_generation) <> 1
        OR MAX(lease_generation) <> COUNT(DISTINCT lease_generation)`,
  ).all();
  if (generationGaps.length > 0) {
    throw new Error("lite_learning_integrity_failed:namespace_lease_generation_gap");
  }

  const unresolvedRelease = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_namespace_leases AS lease
     WHERE lease.status = 'released'
       AND (
         (lease.release_ref_kind = 'experiment_close' AND NOT EXISTS (
           SELECT 1 FROM lite_learning_experiment_closures AS closure
           WHERE closure.tenant_id = lease.tenant_id
             AND closure.experiment_close_id = lease.release_ref_id
             AND closure.confirmatory_attempt_id = lease.confirmatory_attempt_id
             AND closure.experiment_id = lease.experiment_id
             AND closure.experiment_revision = lease.experiment_revision
             AND closure.namespace_set_sha256 = lease.namespace_set_sha256
         ))
         OR
         (lease.release_ref_kind = 'terminal_authority_adjudication' AND NOT EXISTS (
           SELECT 1
           FROM lite_learning_gate_decisions AS decision
           JOIN lite_learning_confirmatory_attempts AS attempt
             ON attempt.tenant_id = lease.tenant_id
            AND attempt.confirmatory_attempt_id = lease.confirmatory_attempt_id
           WHERE decision.tenant_id = lease.tenant_id
             AND decision.decision_id = lease.release_ref_id
             AND decision.decision_kind = 'authority_adjudication'
             AND decision.authority_action IN ('promote', 'demote', 'retire')
             AND decision.task_family = attempt.task_family
             AND decision.candidate_policy_id = attempt.candidate_policy_id
             AND decision.candidate_policy_version = attempt.candidate_policy_version
             AND decision.candidate_policy_implementation_sha256 =
               attempt.candidate_policy_implementation_sha256
             AND decision.experiment_id = lease.experiment_id
             AND decision.experiment_revision = lease.experiment_revision
             AND decision.gate_policy_id = attempt.gate_policy_id
             AND decision.gate_policy_version = attempt.gate_policy_version
         ))
       )`,
  );
  if (unresolvedRelease > 0) {
    throw new Error("lite_learning_integrity_failed:unresolved_namespace_release");
  }

  const unverifiedExternalAuthorityFacts = [
    "lite_learning_external_preclaim_holds",
    "lite_learning_external_run_claims",
    "lite_learning_external_supervisor_bindings",
    "lite_learning_external_session_terminations",
  ].reduce((count, table) => count + scalarCount(
    db,
    `SELECT COUNT(*) AS count FROM ${table}`,
  ), 0) + scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_evidence_artifacts
     WHERE artifact_kind <> 'runtime_integrity_gate'`,
  );
  if (unverifiedExternalAuthorityFacts > 0) {
    throw new Error("lite_learning_integrity_failed:unverified_external_authority_fact");
  }

  const invalidRuntimeGatePrefixes = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_evidence_artifacts AS artifact
     WHERE artifact.artifact_kind = 'runtime_integrity_gate'
       AND NOT EXISTS (
         SELECT 1
         FROM lite_learning_gate_look_reservations AS reservation
         WHERE reservation.tenant_id = artifact.tenant_id
           AND reservation.runtime_integrity_artifact_id = artifact.artifact_id
           AND reservation.runtime_integrity_report_sha256 = artifact.report_sha256
           AND reservation.look_index = artifact.look_index
           AND reservation.task_family = artifact.task_family
           AND reservation.experiment_id = artifact.applicable_experiment_id
           AND reservation.experiment_revision = artifact.applicable_experiment_revision
           AND reservation.evidence_artifact_cutoff_row_id = artifact.row_id
       )`,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_gate_look_reservations AS reservation
     WHERE NOT EXISTS (
       SELECT 1
       FROM lite_learning_evidence_artifacts AS artifact
       WHERE artifact.tenant_id = reservation.tenant_id
         AND artifact.artifact_id = reservation.runtime_integrity_artifact_id
         AND artifact.artifact_kind = 'runtime_integrity_gate'
         AND artifact.report_sha256 = reservation.runtime_integrity_report_sha256
         AND artifact.look_index = reservation.look_index
         AND artifact.task_family = reservation.task_family
         AND artifact.applicable_experiment_id = reservation.experiment_id
         AND artifact.applicable_experiment_revision = reservation.experiment_revision
         AND artifact.row_id = reservation.evidence_artifact_cutoff_row_id
     )`,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_evidence_artifacts AS artifact
     WHERE artifact.artifact_kind = 'runtime_integrity_gate'
       AND (
         (artifact.look_index = 1 AND artifact.supersedes_artifact_id IS NOT NULL)
         OR (artifact.look_index > 1 AND NOT EXISTS (
           SELECT 1
           FROM lite_learning_evidence_artifacts AS predecessor
           WHERE predecessor.tenant_id = artifact.tenant_id
             AND predecessor.artifact_id = artifact.supersedes_artifact_id
             AND predecessor.artifact_kind = 'runtime_integrity_gate'
             AND predecessor.evidence_series_id = artifact.evidence_series_id
             AND predecessor.look_index = artifact.look_index - 1
             AND predecessor.task_family = artifact.task_family
             AND predecessor.candidate_policy_id = artifact.candidate_policy_id
             AND predecessor.candidate_policy_version = artifact.candidate_policy_version
             AND predecessor.candidate_policy_implementation_sha256 = artifact.candidate_policy_implementation_sha256
             AND predecessor.candidate_policy_config_sha256 = artifact.candidate_policy_config_sha256
             AND predecessor.applicable_experiment_id = artifact.applicable_experiment_id
             AND predecessor.applicable_experiment_revision = artifact.applicable_experiment_revision
             AND predecessor.gate_policy_id = artifact.gate_policy_id
             AND predecessor.gate_policy_version = artifact.gate_policy_version
             AND predecessor.gate_policy_config_sha256 = artifact.gate_policy_config_sha256
             AND predecessor.evidence_scope_set_sha256 = artifact.evidence_scope_set_sha256
         ))
       )`,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_evidence_artifacts
     WHERE artifact_kind = 'runtime_integrity_gate'
       AND artifact_status <> 'passed'`,
  );
  if (invalidRuntimeGatePrefixes > 0) {
    throw new Error("lite_learning_integrity_failed:invalid_runtime_gate_prefix");
  }
  try {
    for (const row of db.prepare(
      `SELECT ${LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_evidence_artifacts
        .filter((column) => column !== "row_id").join(", ")}
       FROM lite_learning_evidence_artifacts
       WHERE artifact_kind = 'runtime_integrity_gate'
       ORDER BY row_id`,
    ).all() as LiteLearningAuthorityRow[]) {
      validateAuthorityFactReferences(db, "lite_learning_evidence_artifacts", row);
    }
    for (const row of db.prepare(
      `SELECT ${LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_gate_look_reservations
        .filter((column) => column !== "row_id").join(", ")}
       FROM lite_learning_gate_look_reservations
       ORDER BY row_id`,
    ).all() as LiteLearningAuthorityRow[]) {
      validateAuthorityFactReferences(db, "lite_learning_gate_look_reservations", row);
    }
  } catch (error) {
    throw new Error("lite_learning_integrity_failed:runtime_gate_authority", { cause: error });
  }

  const invalidExternalPrefixes = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_external_preclaim_holds AS hold_row
     JOIN lite_learning_external_run_claims AS claim_row
       ON claim_row.tenant_id = hold_row.tenant_id
      AND claim_row.reservation_id = hold_row.reservation_id`,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_external_supervisor_bindings AS binding_row
     WHERE NOT EXISTS (
       SELECT 1 FROM lite_learning_external_run_claims AS claim_row
       WHERE claim_row.tenant_id = binding_row.tenant_id
         AND claim_row.claim_id = binding_row.claim_id
         AND claim_row.reservation_id = binding_row.reservation_id
         AND claim_row.ticket_consumption_id = binding_row.ticket_consumption_id
     )`,
  ) + scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_external_session_terminations AS termination
     WHERE NOT EXISTS (
       SELECT 1 FROM lite_learning_external_run_claims AS claim_row
       WHERE claim_row.tenant_id = termination.tenant_id
         AND claim_row.claim_id = termination.claim_id
         AND claim_row.reservation_id = termination.reservation_id
         AND claim_row.ticket_consumption_id = termination.ticket_consumption_id
     )`,
  );
  if (invalidExternalPrefixes > 0) {
    throw new Error("lite_learning_integrity_failed:invalid_external_fact_prefix");
  }

  try {
    return replayLiteLearningEpisodeLedger(db, checkedAt);
  } catch (error) {
    throw new Error("lite_learning_integrity_failed:semantic_replay", { cause: error });
  }
}

export type LiteLearningSqlValue = string | number | bigint | Uint8Array | null;
export type LiteLearningAuthorityRow = Readonly<Record<string, LiteLearningSqlValue>>;

export type LiteLearningRequiredEvidenceSeries = Readonly<{
  offline_paired: string;
  production_shadow: string;
  tool_e2e: string;
  runtime_integrity: string;
}>;

export type LiteLearningGateArtifactSetMember = Readonly<{
  artifact_role: "offline_primary" | "production_shadow" | "tool_e2e" | "runtime_integrity";
  role_ordinal: number;
  evidence_series_id: string;
  artifact_id: string;
  report_sha256: string;
}>;

const GATE_ARTIFACT_REQUIREMENTS = [
  {
    revisionRole: "offline_paired",
    artifactRole: "offline_primary",
    artifactKind: "offline_paired_rerun",
  },
  {
    revisionRole: "production_shadow",
    artifactRole: "production_shadow",
    artifactKind: "production_shadow_gate",
  },
  {
    revisionRole: "tool_e2e",
    artifactRole: "tool_e2e",
    artifactKind: "tool_e2e_gate",
  },
  {
    revisionRole: "runtime_integrity",
    artifactRole: "runtime_integrity",
    artifactKind: "runtime_integrity_gate",
  },
] as const;

const AUTO_INCREMENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  lite_learning_episode_events: ["row_id"],
  lite_learning_control_jobs: ["row_id"],
  lite_learning_external_run_reservations: ["row_id"],
  lite_learning_evidence_artifacts: ["row_id"],
  lite_learning_gate_look_reservations: ["row_id"],
  lite_learning_gate_decisions: ["row_id"],
};

const AUTHORITY_FACT_REPLAY_KEYS: Readonly<Record<string, readonly string[]>> = {
  lite_learning_experiment_closures: ["tenant_id", "experiment_close_id"],
  lite_learning_authorization_nonces: ["tenant_id", "authorization_key_id", "authorization_nonce"],
  lite_learning_external_run_reservations: ["tenant_id", "reservation_id"],
  lite_learning_external_holdout_members: ["tenant_id", "reservation_id", "case_ordinal"],
  lite_learning_external_ticket_consumptions: ["tenant_id", "consumption_id"],
  lite_learning_external_preclaim_holds: ["tenant_id", "hold_id"],
  lite_learning_external_run_claims: ["tenant_id", "claim_id"],
  lite_learning_external_supervisor_bindings: ["tenant_id", "binding_id"],
  lite_learning_external_session_terminations: ["tenant_id", "termination_id"],
  lite_learning_evidence_artifacts: ["tenant_id", "artifact_id"],
  lite_learning_gate_look_reservations: ["tenant_id", "reservation_id"],
  lite_learning_gate_decisions: ["tenant_id", "decision_id"],
  lite_learning_gate_artifact_memberships: ["tenant_id", "decision_id", "artifact_id"],
};

export type LiteLearningAuthorityFactTable = keyof typeof AUTHORITY_FACT_REPLAY_KEYS;

const TASK_8_PROTECTED_EXTERNAL_FACT_TABLES = new Set<LiteLearningAuthorityFactTable>([
  "lite_learning_external_preclaim_holds",
  "lite_learning_external_run_claims",
  "lite_learning_external_supervisor_bindings",
  "lite_learning_external_session_terminations",
]);

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCanonicalUtcMillis(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && new Date(value).toISOString() === value;
}

function canonicalJson(raw: LiteLearningSqlValue, field: string): unknown {
  if (typeof raw !== "string") throw new Error(`${field} must be canonical JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${field} must be valid canonical JSON`);
  }
  if (stableStringify(parsed) !== raw) {
    throw new Error(`${field} must use the canonical stable JSON encoding`);
  }
  return parsed;
}

function parseRequiredEvidenceSeries(raw: LiteLearningSqlValue): LiteLearningRequiredEvidenceSeries {
  const parsed = canonicalJson(raw, "required_evidence_series_json");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("required evidence series must be the exact four-role map");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = GATE_ARTIFACT_REQUIREMENTS.map(({ revisionRole }) => revisionRole).sort();
  const actualKeys = Object.keys(record).sort();
  if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
    throw new Error("required evidence series must be the exact four-role map");
  }
  const result = Object.fromEntries(expectedKeys.map((key) => {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new Error(`required evidence series ${key} must be a bounded non-empty ID`);
    }
    return [key, value];
  })) as LiteLearningRequiredEvidenceSeries;
  if (new Set(Object.values(result)).size !== expectedKeys.length) {
    throw new Error("required evidence series IDs must be distinct across roles");
  }
  return result;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return Buffer.from(left).equals(Buffer.from(right));
  }
  if (typeof left === "bigint" || typeof right === "bigint") {
    try {
      return BigInt(left as bigint | number | string) === BigInt(right as bigint | number | string);
    } catch {
      return false;
    }
  }
  return left === right;
}

function assertExactRowShape(table: string, values: LiteLearningAuthorityRow): string[] {
  const required = LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table];
  if (!required) throw new Error(`Unknown learning authority table: ${table}`);
  const auto = new Set(AUTO_INCREMENT_COLUMNS[table] ?? []);
  const expected = required.filter((column) => !auto.has(column));
  const supplied = Object.keys(values).sort();
  const expectedSorted = [...expected].sort();
  if (
    supplied.length !== expectedSorted.length
    || supplied.some((column, index) => column !== expectedSorted[index])
  ) {
    const missing = expectedSorted.filter((column) => !supplied.includes(column));
    const unknown = supplied.filter((column) => !expectedSorted.includes(column));
    throw new Error(
      `learning_authority_row_shape_mismatch:${table}:${JSON.stringify({ missing, unknown })}`,
    );
  }
  for (const [column, value] of Object.entries(values)) {
    if (value === undefined) throw new Error(`${table}.${column} cannot be undefined`);
    if (column.endsWith("_sha256") && value !== null) {
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
        throw new Error(`${table}.${column} must be a lowercase SHA-256 digest`);
      }
    }
    if (column.endsWith("_json") && value !== null) canonicalJson(value, `${table}.${column}`);
    if (column.endsWith("_at") && value !== null) {
      if (typeof value !== "string" || !isCanonicalUtcMillis(value)) {
        throw new Error(`${table}.${column} must be a canonical UTC millisecond timestamp`);
      }
    }
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) {
      throw new Error(`${table}.${column} exceeds the learning authority row bound`);
    }
  }
  return expected;
}

function selectExactRow(
  db: SqliteDatabase,
  table: string,
  replayKeys: readonly string[],
  values: LiteLearningAuthorityRow,
): Record<string, unknown> | null {
  for (const key of replayKeys) {
    if (!(key in values)) throw new Error(`Missing replay key ${table}.${key}`);
  }
  const where = replayKeys.map((key) => `${key} IS ?`).join(" AND ");
  return (db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`)
    .get(...replayKeys.map((key) => values[key])) as Record<string, unknown> | undefined) ?? null;
}

function assertExactReplay(
  table: string,
  existing: Readonly<Record<string, unknown>>,
  values: LiteLearningAuthorityRow,
): void {
  for (const [column, expected] of Object.entries(values)) {
    if (!valuesEqual(existing[column], expected)) {
      throw new Error(`learning_authority_replay_conflict:${table}.${column}`);
    }
  }
}

function insertExactImmutableRow(
  db: SqliteDatabase,
  table: string,
  values: LiteLearningAuthorityRow,
  replayKeys: readonly string[],
): { row: Record<string, unknown>; replayed: boolean } {
  const columns = assertExactRowShape(table, values);
  const existing = selectExactRow(db, table, replayKeys, values);
  if (existing) {
    assertExactReplay(table, existing, values);
    return { row: existing, replayed: true };
  }
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
  ).run(...columns.map((column) => values[column]));
  const inserted = selectExactRow(db, table, replayKeys, values);
  if (!inserted) throw new Error(`learning_authority_insert_missing:${table}`);
  return { row: inserted, replayed: false };
}

function requiredString(row: LiteLearningAuthorityRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function requiredInteger(row: LiteLearningAuthorityRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Missing integer ${field}`);
  return value;
}

function requiredBlob(row: LiteLearningAuthorityRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new Error(`Missing BLOB ${field}`);
  return value;
}

function assertCanonicalJsonDigest(row: LiteLearningAuthorityRow, jsonField: string, digestField: string): void {
  const raw = requiredString(row, jsonField);
  canonicalJson(raw, jsonField);
  if (sha256Text(raw) !== row[digestField]) {
    throw new Error(`${digestField} does not bind ${jsonField}`);
  }
}

type FrozenHostVerifier = {
  kind: "instrumented_agent_trace" | "deterministic_scorer";
  version: string;
  config_sha256: string;
};

function frozenHostVerifierKey(verifier: FrozenHostVerifier): string {
  return `${verifier.kind}\u0000${verifier.version}\u0000${verifier.config_sha256}`;
}

function parseFrozenHostVerifierPolicy(raw: string): ReadonlySet<string> {
  const parsed = canonicalJson(raw, "verifier_policy_json");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("verifier policy must be a canonical object");
  }
  const allowed = (parsed as Record<string, unknown>).allowed_verifiers;
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 32) {
    throw new Error("verifier policy requires 1..32 allowed_verifiers");
  }
  const keys: string[] = [];
  for (const [index, value] of allowed.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`verifier policy allowed_verifiers[${index}] must be an object`);
    }
    const verifier = value as Record<string, unknown>;
    const kind = verifier.kind;
    const version = verifier.version;
    const configSha256 = verifier.config_sha256;
    if (kind !== "instrumented_agent_trace" && kind !== "deterministic_scorer") {
      throw new Error(`verifier policy allowed_verifiers[${index}].kind is unsupported`);
    }
    if (typeof version !== "string" || version.length === 0 || Buffer.byteLength(version, "utf8") > 120) {
      throw new Error(`verifier policy allowed_verifiers[${index}].version is invalid`);
    }
    if (typeof configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(configSha256)) {
      throw new Error(`verifier policy allowed_verifiers[${index}].config_sha256 is invalid`);
    }
    const suppliedKeys = Object.keys(verifier).sort();
    if (stableStringify(suppliedKeys) !== stableStringify(["config_sha256", "kind", "version"])) {
      throw new Error(`verifier policy allowed_verifiers[${index}] has unknown fields`);
    }
    keys.push(frozenHostVerifierKey({ kind, version, config_sha256: configSha256 }));
  }
  const canonicalKeys = [...keys].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  if (new Set(keys).size !== keys.length || stableStringify(keys) !== stableStringify(canonicalKeys)) {
    throw new Error("verifier policy allowed_verifiers must be unique and sorted by canonical verifier key");
  }
  return new Set(keys);
}

export function learningCollectionPrincipalBindingDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify({
    tenant_id: row.tenant_id,
    collection_principal_sha256: row.collection_principal_sha256,
    collection_class: row.collection_class,
    collector_id: row.collector_id,
    collector_version: row.collector_version,
    verifier_policy_sha256: row.verifier_policy_sha256,
  }));
}

export function learningRandomizationPairRecordDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "pair_record_sha256")));
}

export function learningRandomizationPairManifestDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  const manifest = [...rows]
    .sort((left, right) => requiredInteger(left, "pair_ordinal") - requiredInteger(right, "pair_ordinal"))
    .map((row) => ({
      pair_ordinal: requiredInteger(row, "pair_ordinal"),
      randomization_pair_sha256: requiredString(row, "randomization_pair_sha256"),
      pair_record_sha256: requiredString(row, "pair_record_sha256"),
    }));
  return sha256Text(stableStringify(manifest));
}

export function learningActivationScheduleDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  const waves = new Map<number, {
    activation_wave_index: number;
    activation_starts_at: string;
    index_window_ends_at: string;
    wave_analysis_at: string;
    pair_count: number;
  }>();
  for (const row of rows) {
    const wave = requiredInteger(row, "activation_wave_index");
    const value = {
      activation_wave_index: wave,
      activation_starts_at: requiredString(row, "activation_starts_at"),
      index_window_ends_at: requiredString(row, "index_window_ends_at"),
      wave_analysis_at: requiredString(row, "wave_analysis_at"),
      pair_count: 1,
    };
    const existing = waves.get(wave);
    if (existing) {
      if (existing.activation_starts_at !== value.activation_starts_at
        || existing.index_window_ends_at !== value.index_window_ends_at
        || existing.wave_analysis_at !== value.wave_analysis_at) {
        throw new Error(`activation wave ${wave} has inconsistent schedule rows`);
      }
      existing.pair_count += 1;
    } else {
      waves.set(wave, value);
    }
  }
  return sha256Text(stableStringify([...waves.values()].sort(
    (left, right) => left.activation_wave_index - right.activation_wave_index,
  )));
}

export function learningConfirmatoryAttemptDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "attempt_sha256")));
}

export function learningExternalRunReservationDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "reservation_sha256")));
}

export function learningExternalTicketConsumptionDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "consumption_sha256")));
}

export function learningEvidenceArtifactReportDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(requiredString(row, "report_json"));
}

type RegisteredGateCheckpoint = Readonly<{
  look_index: number;
  target_cumulative_pair_count: number;
  checkpoint_kind: "safety_integrity_only" | "confirmatory";
}>;

function registeredGateCheckpoints(): readonly RegisteredGateCheckpoint[] {
  const config = resolveLearningGatePolicy(
    LEARNING_GATE_POLICY_ID,
    LEARNING_GATE_POLICY_VERSION,
  ).config;
  return config.checkpoint_indexes.map((lookIndex, index) => ({
    look_index: lookIndex,
    target_cumulative_pair_count: config.checkpoint_cumulative_matched_pairs[index]!,
    checkpoint_kind: config.checkpoint_kinds[index]!,
  }));
}

export function learningGateLookScheduleDigest(): string {
  return sha256Text(stableStringify({
    contract_version: "learning_gate_look_schedule_v1",
    checkpoints: registeredGateCheckpoints(),
  }));
}

export function learningGateLookReservationDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "reservation_sha256")));
}

export function learningGateArtifactMembershipDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "membership_sha256")));
}

export function learningGateArtifactSetDigest(rows: readonly LiteLearningGateArtifactSetMember[]): string {
  const ordered = rows
    .map((row) => ({
      artifact_role: row.artifact_role,
      role_ordinal: row.role_ordinal,
      evidence_series_id: row.evidence_series_id,
      artifact_id: row.artifact_id,
      report_sha256: row.report_sha256,
    }))
    .sort((left, right) => {
      const leftKey = `${String(left.artifact_role)}\u0000${String(left.role_ordinal).padStart(12, "0")}\u0000${String(left.artifact_id)}`;
      const rightKey = `${String(right.artifact_role)}\u0000${String(right.role_ordinal).padStart(12, "0")}\u0000${String(right.artifact_id)}`;
      return Buffer.compare(Buffer.from(leftKey, "utf8"), Buffer.from(rightKey, "utf8"));
    });
  return sha256Text(stableStringify(ordered));
}

export function learningRequiredArtifactHeadsDigest(
  rows: readonly LiteLearningGateArtifactSetMember[],
): string {
  return learningGateArtifactSetDigest(rows);
}

function selectRequiredGateArtifactHeads(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
    artifactCutoffRowId: number;
  },
): LiteLearningGateArtifactSetMember[] {
  const revision = db.prepare(
    `SELECT required_evidence_series_json
     FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(args.tenantId, args.experimentId, args.experimentRevision) as {
    required_evidence_series_json: string;
  } | undefined;
  if (!revision) throw new Error("gate artifact heads require an immutable experiment revision");
  const series = parseRequiredEvidenceSeries(revision.required_evidence_series_json);
  const heads: LiteLearningGateArtifactSetMember[] = [];
  for (const requirement of GATE_ARTIFACT_REQUIREMENTS) {
    const rows = db.prepare(
      `SELECT artifact_id, artifact_kind, evidence_series_id, report_sha256
       FROM lite_learning_evidence_artifacts AS artifact
       WHERE artifact.tenant_id = ?
         AND artifact.evidence_series_id = ?
         AND artifact.row_id <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM lite_learning_evidence_artifacts AS successor
           WHERE successor.tenant_id = artifact.tenant_id
             AND successor.supersedes_artifact_id = artifact.artifact_id
             AND successor.row_id <= ?
         )`,
    ).all(
      args.tenantId,
      series[requirement.revisionRole],
      args.artifactCutoffRowId,
      args.artifactCutoffRowId,
    ) as Array<Record<string, unknown>>;
    if (rows.length > 1) {
      throw new Error(`gate artifact series has multiple cutoff heads: ${requirement.revisionRole}`);
    }
    const head = rows[0];
    if (!head) continue;
    if (head.artifact_kind !== requirement.artifactKind) {
      throw new Error(`gate artifact series kind mismatch: ${requirement.revisionRole}`);
    }
    heads.push({
      artifact_role: requirement.artifactRole,
      role_ordinal: 0,
      evidence_series_id: String(head.evidence_series_id),
      artifact_id: String(head.artifact_id),
      report_sha256: String(head.report_sha256),
    });
  }
  return heads;
}

function learningArtifactHeadDigestAtCutoff(
  db: SqliteDatabase,
  cutoffRowId: number,
  tenantId?: string,
): string {
  const rows = db.prepare(
    `SELECT row_id, tenant_id, artifact_id, report_sha256
     FROM lite_learning_evidence_artifacts
     WHERE row_id <= ?${tenantId === undefined ? "" : " AND tenant_id = ?"}
     ORDER BY row_id`,
  ).all(...(tenantId === undefined ? [cutoffRowId] : [cutoffRowId, tenantId]));
  return sha256Text(stableStringify(rows));
}

function learningOutcomeRedactedEventHeadDigestAtCutoff(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
    cutoffRowId: number;
    recordedAt: string;
  },
): string {
  const rows = db.prepare(
    `SELECT event.row_id, event.tenant_id, event.scope, event.event_id,
            event.episode_id, event.episode_sequence, event.event_kind,
            event.source_kind, event.collection_class,
            event.collection_principal_sha256, event.collector_id,
            event.collector_version, event.host_task_id,
            event.host_source_task_sha256, event.host_source_event_sha256,
            event.host_task_envelope_created_at, event.task_family,
            event.memory_namespace_sha256, event.namespace_set_sha256,
            event.namespace_lease_id, event.namespace_lease_generation,
            event.profile_id, event.experiment_id, event.experiment_revision,
            event.enrollment_state, event.serving_phase, event.evidence_intent,
            event.assignment_mode, event.assignment_unit_sha256,
            event.assignment_namespace_sha256, event.assignment_bucket,
            event.randomization_pair_sha256, event.matching_covariate_sha256,
            event.pair_member_ordinal, event.activation_wave_index,
            event.activation_starts_at, event.index_window_ends_at,
            event.wave_analysis_at, event.assignment_arm, event.served_arm,
            event.candidate_policy_id, event.candidate_policy_version,
            event.projection_complete, event.promotion_eligible, event.recorded_at
     FROM lite_learning_episode_events AS event
     WHERE event.tenant_id = ? AND event.row_id <= ?
       AND event.recorded_at <= ?
       AND EXISTS (
         SELECT 1 FROM lite_learning_episode_events AS exposure
         WHERE exposure.tenant_id = event.tenant_id
           AND exposure.scope = event.scope
           AND exposure.episode_id = event.episode_id
           AND exposure.event_kind = 'exposure_committed'
           AND exposure.experiment_id = ?
           AND exposure.experiment_revision = ?
           AND exposure.recorded_at <= ?
       )
     ORDER BY event.row_id`,
  ).all(
    args.tenantId,
    args.cutoffRowId,
    args.recordedAt,
    args.experimentId,
    args.experimentRevision,
    args.recordedAt,
  );
  return sha256Text(stableStringify(rows));
}

export type LiteLearningLookAuthorityContext = Readonly<{
  look_index: number;
  target_cumulative_pair_count: number;
  checkpoint_kind: "safety_integrity_only" | "confirmatory";
  cutoff: Readonly<{
    event_row_id: number;
    artifact_row_id: number;
    recorded_at: string;
    event_head_sha256: string;
    artifact_head_sha256: string;
  }>;
}>;

export function deriveLiteLearningLookAuthorityContext(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
    lookIndex: number;
  },
): LiteLearningLookAuthorityContext {
  const checkpoint = registeredGateCheckpoints().find((entry) => entry.look_index === args.lookIndex);
  if (!checkpoint) throw new Error("look index is not registered by the immutable gate policy");
  const waves = db.prepare(
    `SELECT pair_row.activation_wave_index, pair_row.wave_analysis_at,
            COUNT(*) AS pair_count
     FROM lite_learning_confirmatory_attempts AS attempt
     JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = attempt.tenant_id
      AND pair_row.confirmatory_attempt_id = attempt.confirmatory_attempt_id
     WHERE attempt.tenant_id = ? AND attempt.experiment_id = ?
       AND attempt.experiment_revision = ?
     GROUP BY pair_row.activation_wave_index, pair_row.wave_analysis_at
     ORDER BY pair_row.activation_wave_index`,
  ).all(args.tenantId, args.experimentId, args.experimentRevision) as Array<{
    activation_wave_index: number;
    wave_analysis_at: string;
    pair_count: number;
  }>;
  let cumulative = 0;
  let analysisAt: string | null = null;
  for (const wave of waves) {
    cumulative += Number(wave.pair_count);
    if (cumulative === checkpoint.target_cumulative_pair_count) {
      analysisAt = wave.wave_analysis_at;
      break;
    }
  }
  if (analysisAt === null || !isCanonicalUtcMillis(analysisAt)) {
    throw new Error("look checkpoint does not resolve to an immutable activation-wave analysis time");
  }
  const eventCutoff = db.prepare(
    `SELECT COALESCE(MAX(row_id), 0) AS row_id
     FROM lite_learning_episode_events
     WHERE tenant_id = ? AND recorded_at <= ?`,
  ).get(
    args.tenantId,
    analysisAt,
  ) as { row_id: number };
  const artifactCutoff = db.prepare(
    `SELECT COALESCE(MAX(row_id), 0) AS row_id
     FROM lite_learning_evidence_artifacts WHERE tenant_id = ?`,
  ).get(args.tenantId) as { row_id: number };
  const eventRowId = Number(eventCutoff.row_id);
  const artifactRowId = Number(artifactCutoff.row_id);
  return {
    look_index: checkpoint.look_index,
    target_cumulative_pair_count: checkpoint.target_cumulative_pair_count,
    checkpoint_kind: checkpoint.checkpoint_kind,
    cutoff: {
      event_row_id: eventRowId,
      artifact_row_id: artifactRowId,
      recorded_at: analysisAt,
      event_head_sha256: learningOutcomeRedactedEventHeadDigestAtCutoff(db, {
        tenantId: args.tenantId,
        experimentId: args.experimentId,
        experimentRevision: args.experimentRevision,
        cutoffRowId: eventRowId,
        recordedAt: analysisAt,
      }),
      artifact_head_sha256: learningArtifactHeadDigestAtCutoff(db, artifactRowId, args.tenantId),
    },
  };
}

export function buildLearningOutcomeRedactedAuthorityProjection(
  db: SqliteDatabase,
  proposal: Pick<
    LearningLookProposalV1,
    "tenant_id" | "confirmatory_attempt_id" | "experiment_id" | "experiment_revision"
    | "experiment_config_sha256" | "candidate_policy_config_sha256"
    | "candidate_policy_implementation_sha256" | "gate_policy_config_sha256"
    | "gate_policy_implementation_sha256" | "cutoff"
  >,
): LearningOutcomeRedactedAuthorityProjectionV1 {
  const attempt = db.prepare(
    `SELECT attempt_sha256 FROM lite_learning_confirmatory_attempts
     WHERE tenant_id = ? AND confirmatory_attempt_id = ?
       AND experiment_id = ? AND experiment_revision = ?`,
  ).get(
    proposal.tenant_id,
    proposal.confirmatory_attempt_id,
    proposal.experiment_id,
    proposal.experiment_revision,
  ) as { attempt_sha256: string } | undefined;
  const revision = db.prepare(
    `SELECT config_sha256, candidate_policy_config_sha256,
            candidate_policy_implementation_sha256, gate_policy_config_sha256,
            randomization_pair_manifest_sha256, activation_schedule_sha256,
            collection_source_policy_sha256, required_evidence_series_sha256
     FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(
    proposal.tenant_id,
    proposal.experiment_id,
    proposal.experiment_revision,
  ) as Record<string, unknown> | undefined;
  if (!attempt || !revision) throw new Error("look proposal confirmatory authority is unresolved");
  const prerequisiteHeads = selectRequiredGateArtifactHeads(db, {
    tenantId: proposal.tenant_id,
    experimentId: proposal.experiment_id,
    experimentRevision: proposal.experiment_revision,
    artifactCutoffRowId: proposal.cutoff.artifact_row_id,
  });
  return {
    contract_version: "learning_outcome_redacted_authority_projection_v1",
    schema_version: 3,
    database_instance_id: assertLiteRuntimeAuthorityIdentity(db),
    confirmatory_attempt_sha256: attempt.attempt_sha256,
    experiment_config_sha256: requiredString(revision as LiteLearningAuthorityRow, "config_sha256"),
    candidate_policy_config_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "candidate_policy_config_sha256",
    ),
    candidate_policy_implementation_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "candidate_policy_implementation_sha256",
    ),
    gate_policy_config_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "gate_policy_config_sha256",
    ),
    gate_policy_implementation_sha256: proposal.gate_policy_implementation_sha256,
    look_schedule_sha256: learningGateLookScheduleDigest(),
    randomization_pair_manifest_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "randomization_pair_manifest_sha256",
    ),
    activation_schedule_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "activation_schedule_sha256",
    ),
    collection_source_policy_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "collection_source_policy_sha256",
    ),
    required_evidence_series_sha256: requiredString(
      revision as LiteLearningAuthorityRow,
      "required_evidence_series_sha256",
    ),
    required_artifact_heads_sha256: learningRequiredArtifactHeadsDigest(prerequisiteHeads),
    event_cutoff_row_id: proposal.cutoff.event_row_id,
    artifact_cutoff_row_id: proposal.cutoff.artifact_row_id,
    event_head_sha256: learningOutcomeRedactedEventHeadDigestAtCutoff(db, {
      tenantId: proposal.tenant_id,
      experimentId: proposal.experiment_id,
      experimentRevision: proposal.experiment_revision,
      cutoffRowId: proposal.cutoff.event_row_id,
      recordedAt: proposal.cutoff.recorded_at,
    }),
    artifact_head_sha256: learningArtifactHeadDigestAtCutoff(
      db,
      proposal.cutoff.artifact_row_id,
      proposal.tenant_id,
    ),
  };
}

export function assertLearningLookProposalAgainstDatabase(
  db: SqliteDatabase,
  input: LearningLookProposalV1,
): LearningLookProposalV1 {
  const proposal = LearningLookProposalV1Schema.parse(input);
  const checkpoints = registeredGateCheckpoints();
  const reservations = db.prepare(
    `SELECT look_index, reservation_id
     FROM lite_learning_gate_look_reservations
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?
     ORDER BY look_index`,
  ).all(
    proposal.tenant_id,
    proposal.experiment_id,
    proposal.experiment_revision,
  ) as Array<{ look_index: number; reservation_id: string }>;
  const reservationByLook = new Map(
    reservations.map((reservation) => [Number(reservation.look_index), reservation.reservation_id]),
  );
  const nextCheckpoint = checkpoints.find((checkpoint) => !reservationByLook.has(checkpoint.look_index));
  if (!nextCheckpoint || proposal.look_index !== nextCheckpoint.look_index) {
    throw new Error("look proposal must target the smallest unreserved canonical next look");
  }
  const checkpointPosition = checkpoints.findIndex(
    (checkpoint) => checkpoint.look_index === proposal.look_index,
  );
  if (checkpointPosition > 0) {
    const previousCheckpoint = checkpoints[checkpointPosition - 1]!;
    const previousReservationId = reservationByLook.get(previousCheckpoint.look_index);
    const previousEvaluation = previousReservationId === undefined ? undefined : db.prepare(
      `SELECT 1 FROM lite_learning_gate_decisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?
         AND decision_kind = 'evidence_evaluation' AND look_index = ?
         AND look_reservation_id = ?`,
    ).get(
      proposal.tenant_id,
      proposal.experiment_id,
      proposal.experiment_revision,
      previousCheckpoint.look_index,
      previousReservationId,
    );
    if (!previousEvaluation) {
      throw new Error("look proposal requires the immediate prior look evaluation");
    }
  }
  const context = deriveLiteLearningLookAuthorityContext(db, {
    tenantId: proposal.tenant_id,
    experimentId: proposal.experiment_id,
    experimentRevision: proposal.experiment_revision,
    lookIndex: proposal.look_index,
  });
  if (stableStringify(context.cutoff) !== stableStringify(proposal.cutoff)
    || context.target_cumulative_pair_count !== proposal.target_cumulative_pair_count
    || context.checkpoint_kind !== proposal.checkpoint_kind) {
    throw new Error("look proposal cutoff, target, or checkpoint does not match live immutable authority");
  }
  const revision = db.prepare(
    `SELECT config_sha256, candidate_policy_id, candidate_policy_version,
            candidate_policy_config_sha256, candidate_policy_implementation_sha256,
            gate_policy_id, gate_policy_version, gate_policy_config_sha256
     FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(
    proposal.tenant_id,
    proposal.experiment_id,
    proposal.experiment_revision,
  ) as Record<string, unknown> | undefined;
  const attempt = db.prepare(
    `SELECT confirmatory_attempt_id, task_family FROM lite_learning_confirmatory_attempts
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(
    proposal.tenant_id,
    proposal.experiment_id,
    proposal.experiment_revision,
  ) as Record<string, unknown> | undefined;
  const gatePolicy = db.prepare(
    `SELECT implementation_contract_sha256 FROM lite_learning_policy_versions
     WHERE tenant_id = ? AND policy_kind = 'gate'
       AND policy_id = ? AND policy_version = ?`,
  ).get(
    proposal.tenant_id,
    proposal.gate_policy_id,
    proposal.gate_policy_version,
  ) as { implementation_contract_sha256: string } | undefined;
  if (!revision || !attempt || !gatePolicy
    || attempt.confirmatory_attempt_id !== proposal.confirmatory_attempt_id
    || attempt.task_family !== proposal.task_family
    || revision.config_sha256 !== proposal.experiment_config_sha256
    || revision.candidate_policy_id !== proposal.candidate_policy_id
    || revision.candidate_policy_version !== proposal.candidate_policy_version
    || revision.candidate_policy_config_sha256 !== proposal.candidate_policy_config_sha256
    || revision.candidate_policy_implementation_sha256
      !== proposal.candidate_policy_implementation_sha256
    || revision.gate_policy_id !== proposal.gate_policy_id
    || revision.gate_policy_version !== proposal.gate_policy_version
    || revision.gate_policy_config_sha256 !== proposal.gate_policy_config_sha256
    || gatePolicy.implementation_contract_sha256 !== proposal.gate_policy_implementation_sha256) {
    throw new Error("look proposal policy, revision, attempt, or task-family binding mismatch");
  }
  const projection = buildLearningOutcomeRedactedAuthorityProjection(db, proposal);
  if (stableStringify(projection) !== stableStringify(proposal.outcome_redacted_authority_projection)
    || learningOutcomeRedactedAuthorityProjectionDigest(projection)
      !== proposal.outcome_redacted_authority_projection_sha256) {
    throw new Error("look proposal outcome-redacted authority projection mismatch");
  }
  return proposal;
}

export function learningGateDecisionDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "decision_sha256")));
}

function assertStoreTransaction(transaction: SqliteTransactionRunner): void {
  if (!transaction.inTransaction()) {
    throw new Error("learning episode ledger mutations require the shared Runtime transaction");
  }
}

function assertPolicyReferences(db: SqliteDatabase, revision: LiteLearningAuthorityRow): void {
  const candidate = db.prepare(
    `SELECT implementation_contract_sha256
     FROM lite_learning_policy_versions
     WHERE tenant_id = ? AND policy_kind = 'candidate'
       AND policy_id = ? AND policy_version = ? AND policy_config_sha256 = ?`,
  ).get(
    revision.tenant_id,
    revision.candidate_policy_id,
    revision.candidate_policy_version,
    revision.candidate_policy_config_sha256,
  ) as { implementation_contract_sha256: string } | undefined;
  if (!candidate || candidate.implementation_contract_sha256 !== revision.candidate_policy_implementation_sha256) {
    throw new Error("experiment revision candidate policy registration mismatch");
  }
  const gate = db.prepare(
    `SELECT prospective_calibration_sha256
     FROM lite_learning_policy_versions
     WHERE tenant_id = ? AND policy_kind = 'gate'
       AND policy_id = ? AND policy_version = ? AND policy_config_sha256 = ?`,
  ).get(
    revision.tenant_id,
    revision.gate_policy_id,
    revision.gate_policy_version,
    revision.gate_policy_config_sha256,
  ) as { prospective_calibration_sha256: string } | undefined;
  if (!gate || gate.prospective_calibration_sha256 !== revision.gate_prospective_calibration_sha256) {
    throw new Error("experiment revision gate policy calibration mismatch");
  }
}

function validatePolicyVersion(row: LiteLearningAuthorityRow): void {
  assertCanonicalJsonDigest(row, "policy_config_json", "policy_config_sha256");
  const kind = requiredString(row, "policy_kind");
  if (kind === "candidate") {
    if (row.prospective_calibration_json !== null || row.prospective_calibration_sha256 !== null) {
      throw new Error("candidate policy versions reject calibration fields");
    }
    return;
  }
  if (kind !== "gate") throw new Error(`Unknown learning policy kind: ${kind}`);
  const calibration = canonicalJson(row.prospective_calibration_json, "prospective_calibration_json") as {
    status?: unknown;
  };
  if (calibration?.status !== "passed") {
    throw new Error("gate policy registration requires a passing prospective calibration artifact");
  }
  const calibrationJson = requiredString(row, "prospective_calibration_json");
  if (sha256Text(calibrationJson) !== row.prospective_calibration_sha256) {
    throw new Error("gate policy calibration digest mismatch");
  }
  const config = canonicalJson(row.policy_config_json, "policy_config_json") as {
    prospective_calibration_artifact_sha256?: unknown;
  };
  if (config?.prospective_calibration_artifact_sha256 !== row.prospective_calibration_sha256) {
    throw new Error("gate policy configuration must freeze the calibration artifact digest");
  }
}

function validateExperimentRevision(db: SqliteDatabase, row: LiteLearningAuthorityRow): void {
  for (const [jsonField, digestField] of [
    ["collection_source_policy_json", "collection_source_policy_sha256"],
    ["required_evidence_series_json", "required_evidence_series_sha256"],
    ["required_external_inputs_json", "required_external_inputs_sha256"],
    ["external_execution_policy_json", "external_execution_policy_sha256"],
    ["config_json", "config_sha256"],
  ] as const) {
    assertCanonicalJsonDigest(row, jsonField, digestField);
  }
  const externalPolicy = ExternalExecutionPolicyV1Schema.parse(
    canonicalJson(row.external_execution_policy_json, "external_execution_policy_json"),
  );
  parseRequiredEvidenceSeries(row.required_evidence_series_json);
  RequiredExternalInputsV1Schema.parse(
    canonicalJson(row.required_external_inputs_json, "required_external_inputs_json"),
  );
  const revisionConfig = canonicalJson(row.config_json, "config_json") as Record<string, unknown>;
  if (revisionConfig.gate_prospective_calibration_sha256 !== row.gate_prospective_calibration_sha256) {
    throw new Error("experiment revision configuration must freeze the registered gate calibration digest");
  }
  if (revisionConfig.collection_source_policy_sha256 !== row.collection_source_policy_sha256) {
    throw new Error("experiment revision configuration must freeze the collection source policy digest");
  }
  for (const [configField, revisionField] of [
    ["required_evidence_series_sha256", "required_evidence_series_sha256"],
    ["required_external_inputs_sha256", "required_external_inputs_sha256"],
    ["external_execution_policy_sha256", "external_execution_policy_sha256"],
  ] as const) {
    if (revisionConfig[configField] !== row[revisionField]) {
      throw new Error(`experiment revision configuration binding mismatch: ${configField}`);
    }
  }
  if (row.evidence_intent === "confirmatory") {
    for (const [configField, revisionField] of [
      ["namespace_set_sha256", "eligible_memory_namespace_set_sha256"],
      ["pair_manifest_sha256", "randomization_pair_manifest_sha256"],
      ["activation_schedule_sha256", "activation_schedule_sha256"],
    ] as const) {
      if (revisionConfig[configField] !== row[revisionField]) {
        throw new Error(`experiment revision configuration binding mismatch: ${configField}`);
      }
    }
  }
  const databaseInstanceId = assertLiteRuntimeAuthorityIdentity(db);
  if (externalPolicy.runtime_authority_attestor.expected_database_instance_id !== databaseInstanceId) {
    throw new Error("experiment revision Runtime authority identity mismatch");
  }
  const diagnosticSeed = requiredBlob(row, "diagnostic_assignment_seed");
  if (diagnosticSeed.byteLength !== 32 || sha256Bytes(diagnosticSeed) !== row.diagnostic_assignment_seed_sha256) {
    throw new Error("experiment revision diagnostic assignment seed mismatch");
  }
  if (row.evidence_intent === "confirmatory") {
    const bits = requiredBlob(row, "confirmatory_assignment_bits");
    if (bits.byteLength !== 48 || sha256Bytes(bits) !== row.confirmatory_assignment_bits_sha256) {
      throw new Error("experiment revision confirmatory assignment bits mismatch");
    }
  }
  assertPolicyReferences(db, row);
}

function validateConfirmatoryAttempt(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
  options: { exactReplay: boolean },
): void {
  const revision = db.prepare(
    `SELECT * FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(row.tenant_id, row.experiment_id, row.experiment_revision) as Record<string, unknown> | undefined;
  if (!revision || revision.evidence_intent !== "confirmatory") {
    throw new Error("confirmatory attempt requires its immutable confirmatory revision");
  }
  const revisionConfig = canonicalJson(
    requiredString(revision as LiteLearningAuthorityRow, "config_json"),
    "config_json",
  ) as Record<string, unknown>;
  if (revisionConfig.task_family !== row.task_family) {
    throw new Error("confirmatory attempt task family does not match the immutable revision configuration");
  }
  for (const field of [
    "candidate_policy_id",
    "candidate_policy_version",
    "candidate_policy_implementation_sha256",
    "gate_policy_id",
    "gate_policy_version",
    "gate_policy_config_sha256",
    "eligible_memory_namespace_set_sha256",
    "eligible_memory_namespace_count",
    "randomization_pair_manifest_sha256",
    "randomization_pair_count",
    "activation_schedule_sha256",
  ]) {
    if (!valuesEqual(revision[field], row[field])) {
      throw new Error(`confirmatory attempt revision binding mismatch: ${field}`);
    }
  }
  const exposureCount = scalarCount(
    db,
    `SELECT COUNT(*) AS count FROM lite_learning_episode_events
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?
       AND event_kind = 'exposure_committed'`,
    row.tenant_id,
    row.experiment_id,
    row.experiment_revision,
  );
  if (exposureCount > 0 && !options.exactReplay) {
    throw new Error("confirmatory attempt cannot be registered after first exposure");
  }
  if (row.attempt_sha256 !== learningConfirmatoryAttemptDigest(row)) {
    throw new Error("confirmatory attempt digest mismatch");
  }
}

function validateRandomizationManifest(
  rows: readonly LiteLearningAuthorityRow[],
  attempt: LiteLearningAuthorityRow,
): { pairManifestSha256: string; activationScheduleSha256: string } {
  if (rows.length !== 384) throw new Error("confirmatory provisioning requires exactly 384 randomization pairs");
  const ordinals = rows.map((row) => requiredInteger(row, "pair_ordinal")).sort((a, b) => a - b);
  if (ordinals.some((value, index) => value !== index)) {
    throw new Error("confirmatory pair ordinals must be the complete 0..383 set");
  }
  const sortedHashes = [...rows]
    .sort((left, right) => Buffer.compare(
      Buffer.from(requiredString(left, "randomization_pair_sha256"), "utf8"),
      Buffer.from(requiredString(right, "randomization_pair_sha256"), "utf8"),
    ));
  if (sortedHashes.some((row, index) => requiredInteger(row, "pair_ordinal") !== index)) {
    throw new Error("confirmatory pair ordinal must equal canonical pair-hash order");
  }
  const members = new Set<string>();
  const waveCounts = new Map<number, number>();
  const waveTimes = new Map<number, string>();
  for (const row of rows) {
    assertExactRowShape("lite_learning_randomization_pairs", row);
    if (row.tenant_id !== attempt.tenant_id
      || row.confirmatory_attempt_id !== attempt.confirmatory_attempt_id) {
      throw new Error("randomization pair attempt identity mismatch");
    }
    assertCanonicalJsonDigest(row, "matching_covariate_json", "matching_covariate_sha256");
    if (row.pair_record_sha256 !== learningRandomizationPairRecordDigest(row)) {
      throw new Error(`randomization pair record digest mismatch: ${String(row.randomization_pair_sha256)}`);
    }
    const member0 = requiredString(row, "member_0_memory_namespace_sha256");
    const member1 = requiredString(row, "member_1_memory_namespace_sha256");
    if (members.has(member0) || members.has(member1) || member0 === member1) {
      throw new Error("confirmatory pair manifest reuses a memory namespace");
    }
    members.add(member0);
    members.add(member1);
    const wave = requiredInteger(row, "activation_wave_index");
    waveCounts.set(wave, (waveCounts.get(wave) ?? 0) + 1);
    const start = requiredString(row, "activation_starts_at");
    const end = requiredString(row, "index_window_ends_at");
    const analysis = requiredString(row, "wave_analysis_at");
    if (!isCanonicalUtcMillis(start) || !isCanonicalUtcMillis(end) || !isCanonicalUtcMillis(analysis)
      || !(start < end && end < analysis)) {
      throw new Error("confirmatory pair wave times must be canonical and monotone");
    }
    const signature = stableStringify([start, end, analysis]);
    const existingSignature = waveTimes.get(wave);
    if (existingSignature !== undefined && existingSignature !== signature) {
      throw new Error("confirmatory pairs in one wave must share one frozen time window");
    }
    waveTimes.set(wave, signature);
  }
  if (waveCounts.get(1) !== 96 || waveCounts.get(2) !== 96 || waveCounts.get(3) !== 192) {
    throw new Error("confirmatory activation waves must contain exactly 96/96/192 pairs");
  }
  const orderedTimes = [1, 2, 3].map((wave) => {
    const encoded = waveTimes.get(wave);
    if (!encoded) throw new Error(`confirmatory activation wave ${wave} has no frozen time window`);
    return JSON.parse(encoded) as [string, string, string];
  });
  if (!(orderedTimes[0]![2] < orderedTimes[1]![0] && orderedTimes[1]![2] < orderedTimes[2]![0])) {
    throw new Error("confirmatory activation wave windows must be strictly ordered and non-overlapping");
  }
  return {
    pairManifestSha256: learningRandomizationPairManifestDigest(rows),
    activationScheduleSha256: learningActivationScheduleDigest(rows),
  };
}

function validateNamespaceLeaseSet(
  db: SqliteDatabase,
  revision: LiteLearningAuthorityRow,
  attempt: LiteLearningAuthorityRow,
  pairs: readonly LiteLearningAuthorityRow[],
  leases: readonly LiteLearningAuthorityRow[],
): void {
  if (leases.length !== 768) throw new Error("confirmatory provisioning requires exactly 768 namespace leases");
  const pairByHash = new Map(pairs.map((row) => [requiredString(row, "randomization_pair_sha256"), row]));
  const bits = requiredBlob(revision, "confirmatory_assignment_bits");
  const namespaces = new Set<string>();
  const acquisitionOperations = new Set<string>();
  const acquisitionTimes = new Set<string>();
  for (const lease of leases) {
    if (lease.tenant_id !== attempt.tenant_id || lease.confirmatory_attempt_id !== attempt.confirmatory_attempt_id) {
      throw new Error("namespace lease attempt identity mismatch");
    }
    const pair = pairByHash.get(requiredString(lease, "randomization_pair_sha256"));
    if (!pair) throw new Error("namespace lease references an unknown randomization pair");
    if (lease.experiment_id !== revision.experiment_id
      || lease.experiment_revision !== revision.experiment_revision
      || lease.experiment_id !== attempt.experiment_id
      || lease.experiment_revision !== attempt.experiment_revision) {
      throw new Error("namespace lease experiment revision binding mismatch");
    }
    if (lease.status !== "active"
      || lease.release_operation_id !== null
      || lease.release_ref_kind !== null
      || lease.release_ref_id !== null
      || lease.released_at !== null) {
      throw new Error("new confirmatory namespace leases must be active and unreleased");
    }
    acquisitionOperations.add(requiredString(lease, "acquire_operation_id"));
    const acquiredAt = requiredString(lease, "acquired_at");
    if (!isCanonicalUtcMillis(acquiredAt)) {
      throw new Error("namespace lease acquisition time must be canonical UTC milliseconds");
    }
    acquisitionTimes.add(acquiredAt);
    const member = requiredInteger(lease, "pair_member_ordinal");
    const namespace = requiredString(lease, "memory_namespace_sha256");
    const expectedNamespace = requiredString(pair, member === 0
      ? "member_0_memory_namespace_sha256"
      : "member_1_memory_namespace_sha256");
    if (namespace !== expectedNamespace || namespaces.has(namespace)) {
      throw new Error("namespace lease membership mismatch or duplicate");
    }
    namespaces.add(namespace);
    const ordinal = requiredInteger(pair, "pair_ordinal");
    const byte = bits[Math.floor(ordinal / 8)] ?? 0;
    const candidateMember = (byte >> (7 - (ordinal % 8))) & 1;
    const expectedArm = member === candidateMember ? "candidate" : "control";
    if (lease.assigned_arm !== expectedArm) throw new Error("namespace lease arm does not match the persisted assignment bit");
    for (const field of [
      "activation_wave_index",
      "activation_starts_at",
      "index_window_ends_at",
      "wave_analysis_at",
    ]) {
      if (!valuesEqual(lease[field], pair[field])) throw new Error(`namespace lease pair binding mismatch: ${field}`);
    }
    const currentGeneration = db.prepare(
      `SELECT MAX(lease_generation) AS generation
       FROM lite_learning_namespace_leases
       WHERE tenant_id = ? AND memory_namespace_sha256 = ?`,
    ).get(lease.tenant_id, namespace) as { generation: number | null };
    const existingAttemptLease = db.prepare(
      `SELECT namespace_lease_id, lease_generation
       FROM lite_learning_namespace_leases
       WHERE tenant_id = ? AND confirmatory_attempt_id = ? AND memory_namespace_sha256 = ?`,
    ).get(lease.tenant_id, lease.confirmatory_attempt_id, namespace) as {
      namespace_lease_id: string;
      lease_generation: number;
    } | undefined;
    const expectedGeneration = existingAttemptLease
      && existingAttemptLease.namespace_lease_id === lease.namespace_lease_id
      ? existingAttemptLease.lease_generation
      : Number(currentGeneration.generation ?? 0) + 1;
    if (lease.lease_generation !== expectedGeneration) {
      throw new Error("namespace lease generation must be monotone without gaps");
    }
  }
  if (acquisitionOperations.size !== 1 || acquisitionTimes.size !== 1) {
    throw new Error("confirmatory namespace leases require one atomic acquisition operation and timestamp");
  }
  const namespaceSetSha256 = sha256Text(stableStringify([...namespaces].sort()));
  if (
    namespaceSetSha256 !== revision.eligible_memory_namespace_set_sha256
    || namespaceSetSha256 !== attempt.eligible_memory_namespace_set_sha256
    || leases.some((lease) => lease.namespace_set_sha256 !== namespaceSetSha256)
  ) {
    throw new Error("confirmatory namespace-set digest mismatch");
  }
}

function assertRowBindings(
  row: LiteLearningAuthorityRow,
  bindings: Readonly<Record<string, LiteLearningSqlValue>>,
  context: string,
): void {
  for (const [field, expected] of Object.entries(bindings)) {
    if (!valuesEqual(row[field], expected)) {
      throw new Error(`${context} row mismatch: ${field}`);
    }
  }
}

function validateExposureBindings(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
  payload: ExposureCommittedV1,
  items: readonly LearningLedgerItem[],
): void {
  const envelope = payload.host_task_envelope;
  const assignmentMode = {
    matched_pair_csprng_bit_v1: "matched_pair_randomized",
    diagnostic_sha256_48_mod_10000_v1: "diagnostic_randomized",
    none: "unassigned",
  }[payload.assignment_algorithm];
  const servedArm = payload.assignment_arm === "candidate" ? "candidate" : "control";
  const policyAffected = items.some((item) => (
    item.decision_completeness === "complete" && item.served_action !== item.recorded_action
  ))
    ? 1
    : 0;
  const hasLegacyItems = items.some((item) => item.decision_completeness === "legacy_served_only");
  const predecisionTrack = hasLegacyItems
    ? "unclassified"
    : learningEpisodeTrackSummary(items.map((item) => ({
      policy_affected: item.decision_completeness === "complete"
        && item.served_action !== item.recorded_action,
      learning_track: item.learning_track,
    })));
  assertRowBindings(row, {
    collection_class: payload.collection_class,
    collection_principal_sha256: payload.collection_principal_sha256,
    collector_id: payload.collector_id,
    collector_version: payload.collector_version,
    host_task_id: payload.host_task_id,
    host_source_task_sha256: envelope?.source_task_sha256 ?? null,
    host_source_event_sha256: envelope?.source_event_sha256 ?? null,
    host_task_envelope_created_at: envelope?.created_at ?? null,
    host_task_envelope_sha256: payload.host_task_envelope_sha256,
    task_family: envelope?.task_family ?? null,
    task_signature_sha256: envelope ? sha256Text(envelope.task_signature) : null,
    repo_signature_sha256: envelope ? sha256Text(envelope.repository_signature) : null,
    memory_namespace_sha256: payload.memory_namespace_sha256,
    namespace_set_sha256: payload.namespace_set_sha256,
    namespace_lease_id: payload.namespace_lease_id,
    namespace_lease_generation: payload.namespace_lease_generation,
    evidence_intent: payload.evidence_intent,
    assignment_mode: assignmentMode,
    assignment_namespace_sha256: payload.assignment_namespace_sha256,
    assignment_bucket: payload.assignment_bucket,
    randomization_pair_sha256: payload.randomization_pair_sha256,
    matching_covariate_sha256: payload.matching_covariate_sha256,
    pair_member_ordinal: payload.pair_member_ordinal,
    activation_wave_index: payload.activation_wave_index,
    activation_starts_at: payload.activation_starts_at,
    index_window_ends_at: payload.index_window_ends_at,
    wave_analysis_at: payload.wave_analysis_at,
    assignment_arm: payload.assignment_arm,
    served_arm: servedArm,
    policy_affected: policyAffected,
    predecision_track: predecisionTrack,
    projection_complete: payload.projection_complete ? 1 : 0,
    promotion_eligible: isLearningExposurePromotionEligible(payload) ? 1 : 0,
  }, "learning exposure");

  if (payload.memory_namespace_sha256 !== null) {
    const assignmentUnitSha256 = sha256Text(stableStringify({
      tenant_id: requiredString(row, "tenant_id"),
      memory_namespace_sha256: payload.memory_namespace_sha256,
    }));
    if (row.assignment_unit_sha256 !== assignmentUnitSha256) {
      throw new Error("learning exposure row mismatch: assignment_unit_sha256");
    }
  } else if (row.assignment_unit_sha256 !== null) {
    throw new Error("learning exposure without a namespace cannot claim an assignment unit");
  }

  if (payload.collection_principal_sha256 !== null) {
    const principal = db.prepare(
      `SELECT collection_class, collector_id, collector_version
       FROM lite_learning_collection_principal_bindings
       WHERE tenant_id = ? AND collection_principal_sha256 = ?`,
    ).get(row.tenant_id, payload.collection_principal_sha256) as Record<string, unknown> | undefined;
    if (!principal
      || principal.collection_class !== payload.collection_class
      || principal.collector_id !== payload.collector_id
      || principal.collector_version !== payload.collector_version) {
      throw new Error("learning exposure collection principal binding mismatch");
    }
  }

  if (payload.experiment_config_sha256 !== null) {
    const revision = db.prepare(
      `SELECT * FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND config_sha256 = ?`,
    ).get(row.tenant_id, payload.experiment_config_sha256) as Record<string, unknown> | undefined;
    if (!revision) throw new Error("learning exposure experiment revision is not registered");
    for (const [revisionField, eventField] of [
      ["profile_id", "profile_id"],
      ["experiment_id", "experiment_id"],
      ["experiment_revision", "experiment_revision"],
      ["serving_phase", "serving_phase"],
      ["evidence_intent", "evidence_intent"],
      ["candidate_policy_id", "candidate_policy_id"],
      ["candidate_policy_version", "candidate_policy_version"],
    ] as const) {
      if (!valuesEqual(revision[revisionField], row[eventField])) {
        throw new Error(`learning exposure revision binding mismatch: ${eventField}`);
      }
    }
    if (revision.profile_rule_sha256 !== payload.profile_rule_sha256
      || revision.collection_source_policy_sha256 !== payload.collection_source_policy_sha256) {
      throw new Error("learning exposure policy digest does not match the registered revision");
    }
    if (envelope && db.prepare(
      `SELECT task_family FROM lite_learning_confirmatory_attempts
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(row.tenant_id, revision.experiment_id, revision.experiment_revision)) {
      const attempt = db.prepare(
        `SELECT task_family, created_at FROM lite_learning_confirmatory_attempts
         WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
      ).get(row.tenant_id, revision.experiment_id, revision.experiment_revision) as {
        task_family: string;
        created_at: string;
      };
      if (attempt.task_family !== envelope.task_family || attempt.created_at > row.recorded_at!) {
        throw new Error("learning exposure confirmatory attempt did not predate the matching task family");
      }
    }
  }
}

function canonicalAuthorityRowWithoutDigest(
  row: LiteLearningAuthorityRow,
  digestField: string,
): Record<string, LiteLearningSqlValue> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function learningFeedbackAttributionItemDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "item_sha256")));
}

export function learningFeedbackAttributionSetDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  const sorted = [...rows].sort((left, right) => {
    const leftKey = `${String(left.subject_kind)}\u0000${String(left.subject_id)}`;
    const rightKey = `${String(right.subject_kind)}\u0000${String(right.subject_id)}`;
    return Buffer.compare(Buffer.from(leftKey, "utf8"), Buffer.from(rightKey, "utf8"));
  });
  return sha256Text(stableStringify(sorted.map((row) => (
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)))
  ))));
}

export function learningHostUseReceiptItemSetDigest(
  items: readonly Record<string, unknown>[],
): string {
  return sha256Text(stableStringify(items));
}

export function learningExperimentClosureRecordDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "close_sha256")));
}

function validateFeedbackChildren(
  db: SqliteDatabase,
  event: EventWithoutDigest,
  row: LiteLearningAuthorityRow,
  payload: FeedbackAttributedV1,
  attributions: readonly LiteLearningAuthorityRow[],
  hostUseReceipt: LiteLearningAuthorityRow | null,
): void {
  if (attributions.length === 0 || attributions.length > 512) {
    throw new Error("feedback events require a bounded non-empty complete attribution set");
  }
  const subjectKeys = new Set<string>();
  for (const attribution of attributions) {
    assertExactRowShape("lite_learning_feedback_attributions", attribution);
    assertRowBindings(attribution, {
      tenant_id: event.tenant_id,
      scope: event.scope,
      event_id: event.event_id,
      episode_id: event.episode_id,
    }, "learning feedback attribution");
    const subjectKind = requiredString(attribution, "subject_kind");
    if ((payload.feedback_kind === "memory" && subjectKind !== "memory")
      || (payload.feedback_kind === "tool_selection" && subjectKind !== "tool_decision")) {
      throw new Error("feedback attribution subject kind does not match the feedback payload");
    }
    const subjectKey = `${subjectKind}\u0000${requiredString(attribution, "subject_id")}`;
    if (subjectKeys.has(subjectKey)) throw new Error("feedback attribution subject set contains a duplicate");
    subjectKeys.add(subjectKey);
    if (attribution.item_sha256 !== learningFeedbackAttributionItemDigest(attribution)) {
      throw new Error("feedback attribution item digest mismatch");
    }
  }
  if (event.item_set_sha256 !== learningFeedbackAttributionSetDigest(attributions)) {
    throw new Error("feedback attribution item-set digest mismatch");
  }

  if (event.supersedes_event_id !== null) {
    const prior = db.prepare(
      `SELECT subject_kind, subject_id
       FROM lite_learning_feedback_attributions
       WHERE tenant_id = ? AND scope = ? AND event_id = ?
       ORDER BY subject_kind, subject_id`,
    ).all(event.tenant_id, event.scope, event.supersedes_event_id) as Array<{
      subject_kind: string;
      subject_id: string;
    }>;
    const priorKeys = prior.map((item) => `${item.subject_kind}\u0000${item.subject_id}`).sort();
    const nextKeys = [...subjectKeys].sort();
    if (priorKeys.length === 0 || stableStringify(priorKeys) !== stableStringify(nextKeys)) {
      throw new Error("feedback supersession requires the complete prior attribution subject set");
    }
  }

  if (payload.host_use_receipt_sha256 === null) {
    if (hostUseReceipt !== null) throw new Error("legacy and tool feedback cannot persist a host receipt header");
    if (attributions.some((attribution) => attribution.host_use_receipt_id !== null)) {
      throw new Error("feedback without a receipt cannot claim receipt attribution fields");
    }
    return;
  }
  if (payload.feedback_kind !== "memory" || hostUseReceipt === null) {
    throw new Error("verified memory feedback requires its canonical host-use receipt header");
  }
  assertExactRowShape("lite_learning_host_use_receipts", hostUseReceipt);
  const body = HostUseReceiptV1BodySchema.parse(
    canonicalJson(hostUseReceipt.receipt_payload_json, "receipt_payload_json"),
  );
  const receiptSha256 = hostUseReceiptDigest(body);
  if (receiptSha256 !== payload.host_use_receipt_sha256
    || hostUseReceipt.receipt_sha256 !== receiptSha256) {
    throw new Error("host-use receipt digest mismatch");
  }
  assertRowBindings(hostUseReceipt, {
    tenant_id: event.tenant_id,
    scope: event.scope,
    receipt_id: body.receipt_id,
    episode_id: event.episode_id,
    feedback_event_id: event.event_id,
    operation_id: body.operation_id,
    run_id: body.run_id,
    host_task_id: body.host_task_id,
    host_task_envelope_sha256: body.host_task_envelope_sha256,
    collector_id: body.collector_id,
    collector_version: body.collector_version,
    host_trace_sha256: body.host_trace_sha256,
    observed_at: body.observed_at,
    item_count: body.items.length,
    item_set_sha256: learningHostUseReceiptItemSetDigest(body.items),
    verifier_status: "passed",
  }, "host-use receipt");
  if (event.operation_id !== body.operation_id || event.run_id !== body.run_id) {
    throw new Error("host-use receipt operation or run does not match the feedback event");
  }
  const exposure = db.prepare(
    `SELECT source_id, host_task_id, host_task_envelope_sha256,
            collection_principal_sha256, collector_id, collector_version
     FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'exposure_committed'`,
  ).get(event.tenant_id, event.scope, event.episode_id) as Record<string, unknown> | undefined;
  if (!exposure
    || exposure.source_id !== payload.guide_trace_id
    || exposure.host_task_id !== body.host_task_id
    || exposure.host_task_envelope_sha256 !== body.host_task_envelope_sha256
    || exposure.collection_principal_sha256 !== hostUseReceipt.collection_principal_sha256
    || exposure.collector_id !== body.collector_id
    || exposure.collector_version !== body.collector_version) {
    throw new Error("host-use receipt does not bind the original exposure identity");
  }
  const principalBinding = db.prepare(
    `SELECT verifier_policy_sha256, verifier_policy_json
     FROM lite_learning_collection_principal_bindings
     WHERE tenant_id = ? AND collection_principal_sha256 = ?`,
  ).get(event.tenant_id, hostUseReceipt.collection_principal_sha256) as {
    verifier_policy_sha256: string;
    verifier_policy_json: string;
  } | undefined;
  if (!principalBinding
    || sha256Text(principalBinding.verifier_policy_json) !== principalBinding.verifier_policy_sha256) {
    throw new Error("host-use receipt collection principal verifier policy is unresolved");
  }
  const allowedVerifiers = parseFrozenHostVerifierPolicy(principalBinding.verifier_policy_json);
  if (body.items.length !== attributions.length) {
    throw new Error("host-use receipt item membership is incomplete");
  }
  const attributionById = new Map(attributions.map((attribution) => [
    requiredString(attribution, "subject_id"),
    attribution,
  ]));
  const runtimeSignalRefsSha256 = sha256Text(stableStringify([...payload.runtime_signal_refs].sort()));
  for (const item of body.items) {
    if (!allowedVerifiers.has(frozenHostVerifierKey({
      kind: item.verifier_kind,
      version: item.verifier_version,
      config_sha256: item.verifier_config_sha256,
    }))) {
      throw new Error(`host-use receipt verifier is not in the frozen principal policy: ${item.memory_id}`);
    }
    const attribution = attributionById.get(item.memory_id);
    const receiptItemSha256 = sha256Text(stableStringify(item));
    if (!attribution
      || attribution.subject_kind !== "memory"
      || attribution.outcome !== item.outcome
      || attribution.action_outcome !== item.action_outcome
      || attribution.used_surface !== item.used_surface
      || attribution.host_use_receipt_id !== body.receipt_id
      || attribution.host_use_receipt_sha256 !== receiptSha256
      || attribution.receipt_item_sha256 !== receiptItemSha256
      || attribution.host_task_envelope_sha256 !== body.host_task_envelope_sha256
      || attribution.collection_principal_sha256 !== hostUseReceipt.collection_principal_sha256
      || attribution.collector_id !== body.collector_id
      || attribution.collector_version !== body.collector_version
      || attribution.content_evidence_sha256 !== item.content_evidence_sha256
      || attribution.verifier_kind !== item.verifier_kind
      || attribution.verifier_version !== item.verifier_version
      || attribution.verifier_config_sha256 !== item.verifier_config_sha256
      || attribution.verifier_status !== item.verifier_status
      || attribution.runtime_signal_refs_sha256 !== runtimeSignalRefsSha256) {
      throw new Error(`host-use receipt attribution mismatch: ${item.memory_id}`);
    }
  }
}

function validateEffectMeasurement(
  db: SqliteDatabase,
  event: EventWithoutDigest,
  payload: EffectMeasuredV1,
): void {
  if (event.item_set_sha256 !== sha256Text(stableStringify([]))) {
    throw new Error("effect measurement events require the canonical empty item set");
  }
  const measurement = db.prepare(
    `SELECT tenant_id, scope, baseline_episode_id, after_episode_id,
            record_sha256, evidence_status, eligible_for_skill_export
     FROM lite_product_measurements WHERE measurement_id = ?`,
  ).get(payload.measurement_id) as Record<string, unknown> | undefined;
  if (!measurement
    || measurement.tenant_id !== event.tenant_id
    || measurement.scope !== event.scope
    || measurement.baseline_episode_id !== payload.baseline_episode_id
    || measurement.after_episode_id !== payload.after_episode_id
    || measurement.record_sha256 !== payload.measurement_record_sha256
    || measurement.evidence_status !== payload.evidence_status
    || Number(measurement.eligible_for_skill_export) !== (payload.eligible_for_skill_export ? 1 : 0)) {
    throw new Error("effect event does not match its immutable product measurement");
  }
}

function assertRegisteredGateReservationSchedule(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
): void {
  const registered = resolveLearningGatePolicy(
    requiredString(row, "gate_policy_id"),
    requiredString(row, "gate_policy_version"),
  );
  const storedPolicy = db.prepare(
    `SELECT policy_config_json, implementation_contract_sha256,
            prospective_calibration_sha256
     FROM lite_learning_policy_versions
     WHERE tenant_id = ? AND policy_kind = 'gate'
       AND policy_id = ? AND policy_version = ?`,
  ).get(
    row.tenant_id,
    row.gate_policy_id,
    row.gate_policy_version,
  ) as Record<string, unknown> | undefined;
  const expectedConfig = {
    ...registered.config,
    prospective_calibration_artifact_sha256: storedPolicy?.prospective_calibration_sha256,
  };
  if (!storedPolicy
    || storedPolicy.implementation_contract_sha256 !== registered.implementation_contract_sha256
    || stableStringify(canonicalJson(
      storedPolicy.policy_config_json as string,
      "gate policy config JSON",
    )) !== stableStringify(expectedConfig)) {
    throw new Error("gate look reservation requires the registered immutable gate policy");
  }
  const lookIndex = requiredInteger(row, "look_index");
  const checkpoint = registeredGateCheckpoints().find((value) => value.look_index === lookIndex);
  if (!checkpoint) throw new Error("gate look index is not registered by the immutable gate policy");
  if (row.look_schedule_sha256 !== learningGateLookScheduleDigest()
    || row.target_cumulative_pair_count !== checkpoint.target_cumulative_pair_count) {
    throw new Error("gate look target or schedule digest is not registered by the immutable gate policy");
  }
  const waves = db.prepare(
    `SELECT pair_row.activation_wave_index, pair_row.wave_analysis_at,
            COUNT(*) AS pair_count
     FROM lite_learning_confirmatory_attempts AS attempt
     JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = attempt.tenant_id
      AND pair_row.confirmatory_attempt_id = attempt.confirmatory_attempt_id
     WHERE attempt.tenant_id = ?
       AND attempt.experiment_id = ?
       AND attempt.experiment_revision = ?
     GROUP BY pair_row.activation_wave_index, pair_row.wave_analysis_at
     ORDER BY pair_row.activation_wave_index`,
  ).all(
    row.tenant_id,
    row.experiment_id,
    row.experiment_revision,
  ) as Array<{ activation_wave_index: number; wave_analysis_at: string; pair_count: number }>;
  let cumulativePairCount = 0;
  let expectedAnalysisAt: string | null = null;
  for (const wave of waves) {
    cumulativePairCount += Number(wave.pair_count);
    if (cumulativePairCount === checkpoint.target_cumulative_pair_count) {
      expectedAnalysisAt = wave.wave_analysis_at;
      break;
    }
  }
  if (expectedAnalysisAt === null || row.analysis_at !== expectedAnalysisAt) {
    throw new Error("gate look analysis time does not match the immutable activation wave");
  }
  const createdAt = requiredString(row, "created_at");
  if (!isCanonicalUtcMillis(expectedAnalysisAt)
    || !isCanonicalUtcMillis(createdAt)
    || expectedAnalysisAt > createdAt) {
    throw new Error("gate look reservation time is not a canonical completed checkpoint");
  }
}

function validateAuthorityFactReferences(
  db: SqliteDatabase,
  table: LiteLearningAuthorityFactTable,
  row: LiteLearningAuthorityRow,
): void {
  const tenantId = requiredString(row, "tenant_id");
  if (table === "lite_learning_experiment_closures") {
    const approval = LearningExperimentCloseApprovalV1Schema.parse(
      canonicalJson(row.authorization_payload_json, "authorization_payload_json"),
    );
    if (learningExperimentCloseApprovalDigest(approval) !== row.authorization_sha256) {
      throw new Error("experiment closure authorization digest mismatch");
    }
    for (const [approvalField, closureField] of [
      ["tenant_id", "tenant_id"],
      ["confirmatory_attempt_id", "confirmatory_attempt_id"],
      ["experiment_id", "experiment_id"],
      ["experiment_revision", "experiment_revision"],
      ["namespace_set_sha256", "namespace_set_sha256"],
      ["close_reason", "close_reason"],
      ["authority_operation_id", "authority_operation_id"],
      ["authority_scope", "authority_operation_scope"],
      ["authority_operation_kind", "authority_operation_kind"],
      ["approved_by", "approved_by"],
      ["authorization_key_id", "authorization_key_id"],
      ["authorization_nonce", "authorization_nonce"],
      ["authorization_expires_at", "authorization_expires_at"],
    ] as const) {
      if (!valuesEqual(approval[approvalField], row[closureField])) {
        throw new Error(`experiment closure authorization binding mismatch: ${closureField}`);
      }
    }
    const attempt = db.prepare(
      `SELECT candidate_policy_implementation_sha256, gate_policy_id,
              gate_policy_version, experiment_id, experiment_revision,
              eligible_memory_namespace_set_sha256
       FROM lite_learning_confirmatory_attempts
       WHERE tenant_id = ? AND confirmatory_attempt_id = ?`,
    ).get(tenantId, row.confirmatory_attempt_id) as Record<string, unknown> | undefined;
    const gatePolicy = attempt ? db.prepare(
      `SELECT implementation_contract_sha256
       FROM lite_learning_policy_versions
       WHERE tenant_id = ? AND policy_kind = 'gate'
         AND policy_id = ? AND policy_version = ?`,
    ).get(tenantId, attempt.gate_policy_id, attempt.gate_policy_version) as Record<string, unknown> | undefined : undefined;
    if (!attempt
      || attempt.experiment_id !== row.experiment_id
      || attempt.experiment_revision !== row.experiment_revision
      || attempt.eligible_memory_namespace_set_sha256 !== row.namespace_set_sha256
      || attempt.candidate_policy_implementation_sha256 !== approval.candidate_policy_implementation_sha256
      || gatePolicy?.implementation_contract_sha256 !== approval.gate_policy_implementation_sha256) {
      throw new Error("experiment closure confirmatory attempt or policy binding mismatch");
    }
    const nonce = db.prepare(
      `SELECT authorization_kind, authority_ref_id, authorization_sha256
       FROM lite_learning_authorization_nonces
       WHERE tenant_id = ? AND authorization_key_id = ? AND authorization_nonce = ?`,
    ).get(tenantId, row.authorization_key_id, row.authorization_nonce) as Record<string, unknown> | undefined;
    if (!nonce
      || nonce.authorization_kind !== "experiment_close"
      || nonce.authority_ref_id !== row.experiment_close_id
      || nonce.authorization_sha256 !== row.authorization_sha256) {
      throw new Error("experiment closure requires its one-time authorization nonce fact");
    }
    if (row.close_sha256 !== learningExperimentClosureRecordDigest(row)) {
      throw new Error("experiment closure record digest mismatch");
    }
  } else if (table === "lite_learning_external_run_reservations") {
    assertCanonicalJsonDigest(row, "retry_policy_json", "retry_policy_sha256");
    assertCanonicalJsonDigest(row, "immutable_input_manifest_json", "immutable_input_manifest_sha256");
    if (row.reservation_sha256 !== learningExternalRunReservationDigest(row)) {
      throw new Error("external run reservation record digest mismatch");
    }
  } else if (table === "lite_learning_external_ticket_consumptions") {
    const reservation = db.prepare(
      `SELECT runner_ticket_sha256, expected_runner_principal_sha256
       FROM lite_learning_external_run_reservations
       WHERE tenant_id = ? AND reservation_id = ?`,
    ).get(tenantId, row.reservation_id) as Record<string, unknown> | undefined;
    if (!reservation
      || reservation.runner_ticket_sha256 !== row.runner_ticket_sha256
      || reservation.expected_runner_principal_sha256 !== row.runner_principal_sha256) {
      throw new Error("external ticket consumption reservation mismatch");
    }
    if (row.consumption_sha256 !== learningExternalTicketConsumptionDigest(row)) {
      throw new Error("external ticket consumption record digest mismatch");
    }
  } else if (table === "lite_learning_external_preclaim_holds") {
    const consumption = db.prepare(
      "SELECT reservation_id FROM lite_learning_external_ticket_consumptions WHERE tenant_id = ? AND consumption_id = ?",
    ).get(tenantId, row.ticket_consumption_id) as { reservation_id: string } | undefined;
    if (!consumption || consumption.reservation_id !== row.reservation_id) {
      throw new Error("external pre-claim hold consumption mismatch");
    }
    if (db.prepare(
      "SELECT 1 FROM lite_learning_external_run_claims WHERE tenant_id = ? AND reservation_id = ?",
    ).get(tenantId, row.reservation_id)) {
      throw new Error("external pre-claim hold cannot coexist with a claim");
    }
  } else if (table === "lite_learning_external_run_claims") {
    const consumption = db.prepare(
      `SELECT reservation_id, consumption_sha256, runner_principal_sha256
       FROM lite_learning_external_ticket_consumptions
       WHERE tenant_id = ? AND consumption_id = ?`,
    ).get(tenantId, row.ticket_consumption_id) as Record<string, unknown> | undefined;
    const reservation = db.prepare(
      `SELECT expected_runner_principal_sha256, credential_broker_policy_sha256
       FROM lite_learning_external_run_reservations
       WHERE tenant_id = ? AND reservation_id = ?`,
    ).get(tenantId, row.reservation_id) as Record<string, unknown> | undefined;
    if (!consumption || consumption.reservation_id !== row.reservation_id
      || consumption.consumption_sha256 !== row.ticket_consumption_sha256
      || consumption.runner_principal_sha256 !== row.runner_principal_sha256
      || reservation?.expected_runner_principal_sha256 !== row.runner_principal_sha256
      || reservation?.credential_broker_policy_sha256 !== row.credential_broker_policy_sha256) {
      throw new Error("external claim consumption mismatch");
    }
    if (db.prepare(
      "SELECT 1 FROM lite_learning_external_preclaim_holds WHERE tenant_id = ? AND reservation_id = ?",
    ).get(tenantId, row.reservation_id)) {
      throw new Error("external claim cannot coexist with a pre-claim hold");
    }
  } else if (table === "lite_learning_external_supervisor_bindings") {
    const claim = db.prepare(
      `SELECT reservation_id, ticket_consumption_id, credential_session_id_sha256,
              runner_principal_sha256
       FROM lite_learning_external_run_claims WHERE tenant_id = ? AND claim_id = ?`,
    ).get(tenantId, row.claim_id) as Record<string, unknown> | undefined;
    if (!claim || ![
      "reservation_id", "ticket_consumption_id", "credential_session_id_sha256",
      "runner_principal_sha256",
    ]
      .every((field) => valuesEqual(claim[field], row[field]))) {
      throw new Error("external supervisor binding claim mismatch");
    }
    const reservation = db.prepare(
      `SELECT expected_runner_principal_sha256, service_launcher_policy_sha256,
              service_launcher_binary_sha256, service_launcher_key_id,
              supervisor_executable_sha256, supervisor_sandbox_policy_sha256
       FROM lite_learning_external_run_reservations
       WHERE tenant_id = ? AND reservation_id = ?`,
    ).get(tenantId, row.reservation_id) as Record<string, unknown> | undefined;
    if (!reservation
      || reservation.expected_runner_principal_sha256 !== row.runner_principal_sha256
      || ![
        "service_launcher_policy_sha256",
        "service_launcher_binary_sha256",
        "service_launcher_key_id",
        "supervisor_executable_sha256",
        "supervisor_sandbox_policy_sha256",
      ].every((field) => valuesEqual(reservation[field], row[field]))) {
      throw new Error("external supervisor binding reservation policy mismatch");
    }
  } else if (table === "lite_learning_external_session_terminations") {
    const claim = db.prepare(
      `SELECT reservation_id, ticket_consumption_id, credential_session_id_sha256,
              credential_broker_policy_sha256, credential_broker_binary_sha256,
              credential_broker_key_id
       FROM lite_learning_external_run_claims WHERE tenant_id = ? AND claim_id = ?`,
    ).get(tenantId, row.claim_id) as Record<string, unknown> | undefined;
    if (!claim || ![
      "reservation_id", "ticket_consumption_id", "credential_session_id_sha256",
      "credential_broker_policy_sha256", "credential_broker_binary_sha256",
      "credential_broker_key_id",
    ]
      .every((field) => valuesEqual(claim[field], row[field]))) {
      throw new Error("external session termination claim mismatch");
    }
    if (row.supervisor_binding_id !== null && !db.prepare(
      `SELECT 1 FROM lite_learning_external_supervisor_bindings
       WHERE tenant_id = ? AND binding_id = ? AND claim_id = ?`,
    ).get(tenantId, row.supervisor_binding_id, row.claim_id)) {
      throw new Error("external session termination binding mismatch");
    }
    const committedBinding = db.prepare(
      `SELECT binding_id FROM lite_learning_external_supervisor_bindings
       WHERE tenant_id = ? AND claim_id = ?`,
    ).get(tenantId, row.claim_id) as { binding_id: string } | undefined;
    if ((committedBinding && row.supervisor_binding_id !== committedBinding.binding_id)
      || (!committedBinding && row.supervisor_binding_id !== null)) {
      throw new Error("external session termination must preserve the committed binding prefix");
    }
  } else if (table === "lite_learning_evidence_artifacts") {
    assertCanonicalJsonDigest(row, "report_json", "report_sha256");
    if (row.artifact_kind !== "runtime_integrity_gate") {
      throw new Error("external evidence artifacts require the protected Task 8 ingestion verifier");
    }
    if (row.artifact_status !== "passed") {
      throw new Error("Runtime-integrity look reservation requires a passing artifact");
    }
    const report = RuntimeIntegrityGateReportV1Schema.parse(
      canonicalJson(row.report_json, "Runtime-integrity report JSON"),
    );
    if (report.integrity_status !== "passed") {
      throw new Error("Runtime-integrity look reservation requires a passing report");
    }
    const revision = db.prepare(
      `SELECT config_sha256, candidate_policy_id, candidate_policy_version,
              candidate_policy_implementation_sha256, candidate_policy_config_sha256,
              gate_policy_id, gate_policy_version, gate_policy_config_sha256,
              required_evidence_series_json, required_evidence_series_sha256,
              randomization_pair_manifest_sha256,
              activation_schedule_sha256, collection_source_policy_sha256
       FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(
      tenantId,
      row.applicable_experiment_id,
      row.applicable_experiment_revision,
    ) as Record<string, unknown> | undefined;
    if (!revision || ![
      "candidate_policy_id",
      "candidate_policy_version",
      "candidate_policy_implementation_sha256",
      "candidate_policy_config_sha256",
      "gate_policy_id",
      "gate_policy_version",
      "gate_policy_config_sha256",
    ].every((field) => valuesEqual(revision[field], row[field]))) {
      throw new Error("Runtime-integrity evidence artifact revision binding mismatch");
    }
    const attempt = db.prepare(
      `SELECT confirmatory_attempt_id, attempt_sha256, task_family
       FROM lite_learning_confirmatory_attempts
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(
      tenantId,
      row.applicable_experiment_id,
      row.applicable_experiment_revision,
    ) as {
      confirmatory_attempt_id: string;
      attempt_sha256: string;
      task_family: string;
    } | undefined;
    const gatePolicy = db.prepare(
      `SELECT implementation_contract_sha256
       FROM lite_learning_policy_versions
       WHERE tenant_id = ? AND policy_kind = 'gate'
         AND policy_id = ? AND policy_version = ?`,
    ).get(
      tenantId,
      row.gate_policy_id,
      row.gate_policy_version,
    ) as { implementation_contract_sha256: string } | undefined;
    if (!attempt || !gatePolicy
      || report.tenant_id !== tenantId
      || report.confirmatory_attempt_id !== attempt.confirmatory_attempt_id
      || report.experiment_id !== row.applicable_experiment_id
      || report.experiment_revision !== row.applicable_experiment_revision
      || report.experiment_config_sha256 !== revision.config_sha256
      || report.task_family !== attempt.task_family
      || report.task_family !== row.task_family
      || row.task_family !== attempt.task_family
      || report.candidate_policy_id !== row.candidate_policy_id
      || report.candidate_policy_version !== row.candidate_policy_version
      || report.candidate_policy_config_sha256 !== row.candidate_policy_config_sha256
      || report.candidate_policy_implementation_sha256 !== row.candidate_policy_implementation_sha256
      || report.gate_policy_id !== row.gate_policy_id
      || report.gate_policy_version !== row.gate_policy_version
      || report.gate_policy_config_sha256 !== row.gate_policy_config_sha256
      || report.gate_policy_implementation_sha256 !== gatePolicy.implementation_contract_sha256
      || report.look_index !== row.look_index
      || report.proposal_sha256 !== row.look_proposal_sha256) {
      throw new Error("Runtime-integrity report authority binding mismatch");
    }
    const persistedArtifact = db.prepare(
      `SELECT row_id FROM lite_learning_evidence_artifacts
       WHERE tenant_id = ? AND artifact_id = ?`,
    ).get(tenantId, row.artifact_id) as { row_id: number } | undefined;
    const previousArtifactRow = (persistedArtifact
      ? db.prepare(
        `SELECT COALESCE(MAX(row_id), 0) AS row_id
         FROM lite_learning_evidence_artifacts
         WHERE tenant_id = ? AND row_id < ?`,
      ).get(tenantId, persistedArtifact.row_id)
      : db.prepare(
        `SELECT COALESCE(MAX(row_id), 0) AS row_id
         FROM lite_learning_evidence_artifacts WHERE tenant_id = ?`,
      ).get(tenantId)) as { row_id: number };
    const previousArtifactRowId = Number(previousArtifactRow.row_id);
    const prerequisiteHeads = selectRequiredGateArtifactHeads(db, {
      tenantId,
      experimentId: requiredString(row, "applicable_experiment_id"),
      experimentRevision: requiredInteger(row, "applicable_experiment_revision"),
      artifactCutoffRowId: previousArtifactRowId,
    });
    const projection = report.outcome_redacted_authority_projection;
    const currentEventHead = db.prepare(
      "SELECT COALESCE(MAX(row_id), 0) AS row_id FROM lite_learning_episode_events",
    ).get() as { row_id: number };
    const lookContext = deriveLiteLearningLookAuthorityContext(db, {
      tenantId,
      experimentId: requiredString(row, "applicable_experiment_id"),
      experimentRevision: requiredInteger(row, "applicable_experiment_revision"),
      lookIndex: requiredInteger(row, "look_index"),
    });
    if (report.cutoff.event_row_id > Number(currentEventHead.row_id)) {
      throw new Error("Runtime-integrity report cutoff exceeds the current event ledger head");
    }
    if (report.target_cumulative_pair_count !== lookContext.target_cumulative_pair_count
      || report.checkpoint_kind !== lookContext.checkpoint_kind
      || report.cutoff.event_row_id !== lookContext.cutoff.event_row_id
      || report.cutoff.event_head_sha256 !== lookContext.cutoff.event_head_sha256
      || report.cutoff.recorded_at !== lookContext.cutoff.recorded_at
      || report.cutoff.artifact_row_id !== previousArtifactRowId
      || report.cutoff.artifact_head_sha256
        !== learningArtifactHeadDigestAtCutoff(db, previousArtifactRowId, tenantId)
      || report.cutoff.event_head_sha256 !== learningOutcomeRedactedEventHeadDigestAtCutoff(db, {
        tenantId,
        experimentId: requiredString(row, "applicable_experiment_id"),
        experimentRevision: requiredInteger(row, "applicable_experiment_revision"),
        cutoffRowId: report.cutoff.event_row_id,
        recordedAt: report.cutoff.recorded_at,
      })
      || projection.database_instance_id !== assertLiteRuntimeAuthorityIdentity(db)
      || projection.confirmatory_attempt_sha256 !== attempt.attempt_sha256
      || projection.experiment_config_sha256 !== revision.config_sha256
      || projection.candidate_policy_config_sha256 !== row.candidate_policy_config_sha256
      || projection.candidate_policy_implementation_sha256
        !== row.candidate_policy_implementation_sha256
      || projection.gate_policy_config_sha256 !== row.gate_policy_config_sha256
      || projection.gate_policy_implementation_sha256
        !== gatePolicy.implementation_contract_sha256
      || projection.look_schedule_sha256 !== learningGateLookScheduleDigest()
      || projection.randomization_pair_manifest_sha256
        !== revision.randomization_pair_manifest_sha256
      || projection.activation_schedule_sha256 !== revision.activation_schedule_sha256
      || projection.collection_source_policy_sha256 !== revision.collection_source_policy_sha256
      || projection.required_evidence_series_sha256 !== revision.required_evidence_series_sha256
      || projection.required_artifact_heads_sha256
        !== learningRequiredArtifactHeadsDigest(prerequisiteHeads)) {
      throw new Error("Runtime-integrity report live authority projection mismatch");
    }
    const requiredSeries = parseRequiredEvidenceSeries(revision.required_evidence_series_json as string);
    if (row.evidence_series_id !== requiredSeries.runtime_integrity) {
      throw new Error("Runtime-integrity evidence artifact must use the preregistered series");
    }
    const lookIndex = requiredInteger(row, "look_index");
    if (lookIndex === 1) {
      if (row.supersedes_artifact_id !== null || db.prepare(
        `SELECT 1 FROM lite_learning_evidence_artifacts
         WHERE tenant_id = ? AND evidence_series_id = ? AND artifact_id <> ?
           AND supersedes_artifact_id IS NULL`,
      ).get(tenantId, row.evidence_series_id, row.artifact_id)) {
        throw new Error("Runtime-integrity look 1 must create the unique series root");
      }
    } else {
      const predecessor = db.prepare(
        `SELECT artifact_id, artifact_kind, evidence_series_id, look_index, task_family,
                candidate_policy_id, candidate_policy_version,
                candidate_policy_implementation_sha256, candidate_policy_config_sha256,
                applicable_experiment_id, applicable_experiment_revision,
                gate_policy_id, gate_policy_version, gate_policy_config_sha256,
                evidence_scope_set_sha256
         FROM lite_learning_evidence_artifacts
         WHERE tenant_id = ? AND artifact_id = ?`,
      ).get(tenantId, row.supersedes_artifact_id) as Record<string, unknown> | undefined;
      if (!predecessor
        || predecessor.artifact_kind !== "runtime_integrity_gate"
        || predecessor.evidence_series_id !== row.evidence_series_id
        || predecessor.look_index !== lookIndex - 1
        || ![
          "task_family",
          "candidate_policy_id",
          "candidate_policy_version",
          "candidate_policy_implementation_sha256",
          "candidate_policy_config_sha256",
          "applicable_experiment_id",
          "applicable_experiment_revision",
          "gate_policy_id",
          "gate_policy_version",
          "gate_policy_config_sha256",
          "evidence_scope_set_sha256",
        ].every((field) => valuesEqual(predecessor[field], row[field]))) {
        throw new Error("Runtime-integrity artifact must supersede the same-series immediate prior look");
      }
      const predecessorEvaluated = db.prepare(
        `SELECT 1
         FROM lite_learning_gate_look_reservations AS reservation
         JOIN lite_learning_gate_decisions AS decision
           ON decision.tenant_id = reservation.tenant_id
          AND decision.look_reservation_id = reservation.reservation_id
          AND decision.decision_kind = 'evidence_evaluation'
         WHERE reservation.tenant_id = ?
           AND reservation.runtime_integrity_artifact_id = ?
           AND reservation.look_index = ?`,
      ).get(tenantId, predecessor.artifact_id, lookIndex - 1);
      if (!predecessorEvaluated) {
        throw new Error("Runtime-integrity predecessor must be reserved and evaluated before the next look");
      }
    }
  } else if (table === "lite_learning_gate_look_reservations") {
    assertCanonicalJsonDigest(row, "trigger_basis_json", "trigger_basis_sha256");
    if (row.reservation_sha256 !== learningGateLookReservationDigest(row)) {
      throw new Error("gate look reservation digest mismatch");
    }
    const currentEventHead = db.prepare(
      "SELECT COALESCE(MAX(row_id), 0) AS row_id FROM lite_learning_episode_events",
    ).get() as { row_id: number };
    if (Number(row.evidence_cutoff_event_row_id) > Number(currentEventHead.row_id)) {
      throw new Error("gate look reservation cutoff exceeds the current event ledger head");
    }
    assertRegisteredGateReservationSchedule(db, row);
    const revision = db.prepare(
      `SELECT config_sha256, candidate_policy_id, candidate_policy_version,
              candidate_policy_implementation_sha256, gate_policy_id,
              gate_policy_version, gate_policy_config_sha256,
              randomization_pair_manifest_sha256, activation_schedule_sha256
       FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(tenantId, row.experiment_id, row.experiment_revision) as Record<string, unknown> | undefined;
    if (!revision || ![
      "candidate_policy_id",
      "candidate_policy_version",
      "candidate_policy_implementation_sha256",
      "gate_policy_id",
      "gate_policy_version",
      "gate_policy_config_sha256",
      "randomization_pair_manifest_sha256",
      "activation_schedule_sha256",
    ].every((field) => valuesEqual(revision[field], row[field]))) {
      throw new Error("gate look reservation revision binding mismatch");
    }
    const artifact = db.prepare(
      `SELECT row_id, artifact_kind, report_sha256, report_json, look_index, task_family,
              look_proposal_sha256, source_bundle_sha256,
              applicable_experiment_id, applicable_experiment_revision
       FROM lite_learning_evidence_artifacts
       WHERE tenant_id = ? AND artifact_id = ?`,
    ).get(tenantId, row.runtime_integrity_artifact_id) as Record<string, unknown> | undefined;
    if (!artifact
      || artifact.artifact_kind !== "runtime_integrity_gate"
      || artifact.report_sha256 !== row.runtime_integrity_report_sha256
      || artifact.look_index !== row.look_index
      || artifact.task_family !== row.task_family
      || artifact.source_bundle_sha256 !== row.runtime_integrity_run_bundle_sha256
      || artifact.applicable_experiment_id !== row.experiment_id
      || artifact.applicable_experiment_revision !== row.experiment_revision
      || Number(artifact.row_id) !== Number(row.evidence_artifact_cutoff_row_id)) {
      throw new Error("gate look reservation Runtime-integrity artifact binding mismatch");
    }
    const report = RuntimeIntegrityGateReportV1Schema.parse(
      canonicalJson(artifact.report_json as string, "Runtime-integrity report JSON"),
    );
    if (report.proposal_sha256 !== artifact.look_proposal_sha256
      || report.look_index !== row.look_index
      || report.cutoff.event_row_id !== row.evidence_cutoff_event_row_id) {
      throw new Error("gate look reservation Runtime-integrity report cutoff mismatch");
    }
    const requiredHeads = selectRequiredGateArtifactHeads(db, {
      tenantId,
      experimentId: requiredString(row, "experiment_id"),
      experimentRevision: requiredInteger(row, "experiment_revision"),
      artifactCutoffRowId: requiredInteger(row, "evidence_artifact_cutoff_row_id"),
    });
    if (row.required_artifact_heads_sha256 !== learningRequiredArtifactHeadsDigest(requiredHeads)) {
      throw new Error("gate look reservation required artifact-head digest mismatch");
    }
  } else if (table === "lite_learning_gate_artifact_memberships") {
    const decision = db.prepare(
      "SELECT decision_kind FROM lite_learning_gate_decisions WHERE tenant_id = ? AND decision_id = ?",
    ).get(tenantId, row.decision_id) as { decision_kind: string } | undefined;
    const artifact = db.prepare(
      "SELECT report_sha256 FROM lite_learning_evidence_artifacts WHERE tenant_id = ? AND artifact_id = ?",
    ).get(tenantId, row.artifact_id) as { report_sha256: string } | undefined;
    if (decision?.decision_kind !== "evidence_evaluation" || artifact?.report_sha256 !== row.report_sha256) {
      throw new Error("gate artifact membership reference mismatch");
    }
  } else if (table === "lite_learning_gate_decisions" && row.decision_kind === "authority_adjudication") {
    const approval = LearningAuthorityApprovalV1Schema.parse(
      canonicalJson(row.authorization_payload_json, "authorization_payload_json"),
    );
    if (learningAuthorityApprovalDigest(approval) !== row.authorization_sha256) {
      throw new Error("gate adjudication authorization digest mismatch");
    }
    for (const [approvalField, decisionField] of [
      ["tenant_id", "tenant_id"],
      ["task_family", "task_family"],
      ["action", "authority_action"],
      ["authority_scope", "authority_operation_scope"],
      ["authority_operation_kind", "authority_operation_kind"],
      ["authority_operation_id", "authority_operation_id"],
      ["experiment_id", "experiment_id"],
      ["experiment_revision", "experiment_revision"],
      ["experiment_config_sha256", "experiment_config_sha256"],
      ["evidence_decision_id", "basis_evidence_decision_id"],
      ["look_reservation_id", "look_reservation_id"],
      ["look_reservation_sha256", "look_reservation_sha256"],
      ["evidence_scope_set_sha256", "evidence_scope_set_sha256"],
      ["evidence_cohort_sha256", "evidence_cohort_sha256"],
      ["evidence_artifact_set_sha256", "evidence_artifact_set_sha256"],
      ["candidate_policy_id", "candidate_policy_id"],
      ["candidate_policy_version", "candidate_policy_version"],
      ["candidate_policy_implementation_sha256", "candidate_policy_implementation_sha256"],
      ["gate_policy_id", "gate_policy_id"],
      ["gate_policy_version", "gate_policy_version"],
      ["authorization_key_id", "authorization_key_id"],
      ["authorization_nonce", "authorization_nonce"],
      ["authorization_expires_at", "authorization_expires_at"],
      ["approved_by", "approved_by"],
    ] as const) {
      if (!valuesEqual(approval[approvalField], row[decisionField])) {
        throw new Error(`gate adjudication authorization binding mismatch: ${decisionField}`);
      }
    }
    const candidatePolicy = db.prepare(
      `SELECT policy_config_sha256, implementation_contract_sha256
       FROM lite_learning_policy_versions
       WHERE tenant_id = ? AND policy_kind = 'candidate'
         AND policy_id = ? AND policy_version = ?`,
    ).get(tenantId, row.candidate_policy_id, row.candidate_policy_version) as Record<string, unknown> | undefined;
    const gatePolicy = db.prepare(
      `SELECT policy_config_sha256, implementation_contract_sha256
       FROM lite_learning_policy_versions
       WHERE tenant_id = ? AND policy_kind = 'gate'
         AND policy_id = ? AND policy_version = ?`,
    ).get(tenantId, row.gate_policy_id, row.gate_policy_version) as Record<string, unknown> | undefined;
    if (!candidatePolicy
      || candidatePolicy.policy_config_sha256 !== approval.candidate_policy_config_sha256
      || candidatePolicy.implementation_contract_sha256 !== approval.candidate_policy_implementation_sha256
      || !gatePolicy
      || gatePolicy.policy_config_sha256 !== approval.gate_policy_config_sha256
      || gatePolicy.implementation_contract_sha256 !== approval.gate_policy_implementation_sha256) {
      throw new Error("gate adjudication registered policy binding mismatch");
    }
    const nonce = db.prepare(
      `SELECT authorization_kind, authority_ref_id, authorization_sha256
       FROM lite_learning_authorization_nonces
       WHERE tenant_id = ? AND authorization_key_id = ? AND authorization_nonce = ?`,
    ).get(tenantId, row.authorization_key_id, row.authorization_nonce) as Record<string, unknown> | undefined;
    if (!nonce
      || nonce.authorization_kind !== "gate_adjudication"
      || nonce.authority_ref_id !== row.decision_id
      || nonce.authorization_sha256 !== row.authorization_sha256) {
      throw new Error("gate adjudication requires its one-time authorization nonce fact");
    }
  } else if (table === "lite_learning_gate_decisions" && row.decision_kind === "evidence_evaluation") {
    const lookIndex = requiredInteger(row, "look_index");
    if (lookIndex === 1 && row.supersedes_decision_id !== null) {
      throw new Error("gate look 1 cannot supersede another evaluation");
    }
    if (lookIndex > 1) {
      const predecessor = db.prepare(
        `SELECT look_index, task_family, candidate_policy_id, candidate_policy_version,
                candidate_policy_implementation_sha256, experiment_id, experiment_revision,
                gate_policy_id, gate_policy_version
         FROM lite_learning_gate_decisions
         WHERE tenant_id = ? AND decision_id = ? AND decision_kind = 'evidence_evaluation'`,
      ).get(tenantId, row.supersedes_decision_id) as Record<string, unknown> | undefined;
      const sameEvaluationSeries = predecessor
        && [
          "task_family",
          "candidate_policy_id",
          "candidate_policy_version",
          "candidate_policy_implementation_sha256",
          "experiment_id",
          "experiment_revision",
          "gate_policy_id",
          "gate_policy_version",
        ].every((field) => valuesEqual(predecessor[field], row[field]));
      if (!predecessor || predecessor.look_index !== lookIndex - 1 || !sameEvaluationSeries) {
        throw new Error("gate evaluation must supersede the immediate prior look");
      }
    }
  }
}

function validateGateEvidenceEvaluation(
  db: SqliteDatabase,
  decision: LiteLearningAuthorityRow,
  memberships: readonly LiteLearningAuthorityRow[],
): void {
  assertExactRowShape("lite_learning_gate_decisions", decision);
  if (decision.decision_kind !== "evidence_evaluation") {
    throw new Error("atomic gate evidence insertion accepts evidence_evaluation only");
  }
  assertCanonicalJsonDigest(decision, "evidence_summary_json", "evidence_summary_sha256");
  if (decision.decision_sha256 !== learningGateDecisionDigest(decision)) {
    throw new Error("gate evidence decision digest mismatch");
  }
  validateAuthorityFactReferences(db, "lite_learning_gate_decisions", decision);

  const reservation = db.prepare(
    `SELECT * FROM lite_learning_gate_look_reservations
     WHERE tenant_id = ? AND reservation_id = ?`,
  ).get(decision.tenant_id, decision.look_reservation_id) as Record<string, unknown> | undefined;
  if (!reservation || reservation.reservation_sha256 !== decision.look_reservation_sha256) {
    throw new Error("gate evidence decision requires its exact look reservation");
  }
  for (const field of [
    "tenant_id",
    "task_family",
    "candidate_policy_id",
    "candidate_policy_version",
    "candidate_policy_implementation_sha256",
    "experiment_id",
    "experiment_revision",
    "gate_policy_id",
    "gate_policy_version",
    "look_index",
    "analysis_at",
    "evidence_cutoff_event_row_id",
    "evidence_artifact_cutoff_row_id",
  ]) {
    if (!valuesEqual(reservation[field], decision[field])) {
      throw new Error(`gate evidence decision reservation binding mismatch: ${field}`);
    }
  }
  const revision = db.prepare(
    `SELECT config_sha256, candidate_policy_config_sha256, gate_policy_config_sha256
     FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(
    decision.tenant_id,
    decision.experiment_id,
    decision.experiment_revision,
  ) as Record<string, unknown> | undefined;
  if (!revision || revision.config_sha256 !== decision.experiment_config_sha256) {
    throw new Error("gate evidence decision experiment configuration mismatch");
  }

  const expectedHeads = selectRequiredGateArtifactHeads(db, {
    tenantId: requiredString(decision, "tenant_id"),
    experimentId: requiredString(decision, "experiment_id"),
    experimentRevision: requiredInteger(decision, "experiment_revision"),
    artifactCutoffRowId: requiredInteger(decision, "evidence_artifact_cutoff_row_id"),
  });
  const requiredHeadsDigest = learningRequiredArtifactHeadsDigest(expectedHeads);
  if (reservation.required_artifact_heads_sha256 !== requiredHeadsDigest) {
    throw new Error("gate evidence decision reservation artifact-head digest mismatch");
  }
  if (decision.evidence_verdict !== "hold"
    && expectedHeads.length !== GATE_ARTIFACT_REQUIREMENTS.length) {
    throw new Error("actionable gate evidence requires all four preregistered artifact heads");
  }
  const expectedCount = requiredInteger(decision, "evidence_artifact_count");
  if (memberships.length === 0
    || memberships.length !== expectedHeads.length
    || memberships.length !== expectedCount) {
    throw new Error("gate evidence decision requires its exact bounded artifact membership count");
  }
  const expectedHeadsByRole = new Map(expectedHeads.map((head) => [
    `${head.artifact_role}\u0000${head.role_ordinal}`,
    head,
  ]));
  const memberKeys = new Set<string>();
  const artifactSetMembers: LiteLearningGateArtifactSetMember[] = [];
  let includesReservedRuntimeIntegrityArtifact = false;
  for (const membership of memberships) {
    assertExactRowShape("lite_learning_gate_artifact_memberships", membership);
    assertRowBindings(membership, {
      tenant_id: requiredString(decision, "tenant_id"),
      decision_id: requiredString(decision, "decision_id"),
    }, "gate artifact membership");
    if (membership.membership_sha256 !== learningGateArtifactMembershipDigest(membership)) {
      throw new Error(`gate artifact membership digest mismatch: ${String(membership.artifact_id)}`);
    }
    const memberKey = `${requiredString(membership, "artifact_role")}\u0000${requiredInteger(membership, "role_ordinal")}`;
    if (memberKeys.has(memberKey)) throw new Error("gate artifact membership role/ordinal is duplicated");
    memberKeys.add(memberKey);
    const expectedHead = expectedHeadsByRole.get(memberKey);
    if (!expectedHead
      || expectedHead.artifact_id !== membership.artifact_id
      || expectedHead.report_sha256 !== membership.report_sha256) {
      throw new Error(`gate artifact membership does not match the preregistered cutoff head: ${String(membership.artifact_id)}`);
    }
    const artifact = db.prepare(
      `SELECT row_id, artifact_kind, artifact_status, artifact_id, report_sha256, task_family,
              evidence_series_id,
              candidate_policy_id, candidate_policy_version,
              candidate_policy_implementation_sha256, candidate_policy_config_sha256,
              applicable_experiment_id, applicable_experiment_revision,
              gate_policy_id, gate_policy_version, gate_policy_config_sha256,
              evidence_scope_set_sha256
       FROM lite_learning_evidence_artifacts
       WHERE tenant_id = ? AND artifact_id = ?`,
    ).get(decision.tenant_id, membership.artifact_id) as Record<string, unknown> | undefined;
    if (!artifact
      || artifact.report_sha256 !== membership.report_sha256
      || artifact.evidence_series_id !== expectedHead.evidence_series_id
      || artifact.task_family !== decision.task_family
      || artifact.candidate_policy_id !== decision.candidate_policy_id
      || artifact.candidate_policy_version !== decision.candidate_policy_version
      || artifact.candidate_policy_implementation_sha256 !== decision.candidate_policy_implementation_sha256
      || artifact.candidate_policy_config_sha256 !== revision.candidate_policy_config_sha256
      || artifact.applicable_experiment_id !== decision.experiment_id
      || artifact.applicable_experiment_revision !== decision.experiment_revision
      || artifact.gate_policy_id !== decision.gate_policy_id
      || artifact.gate_policy_version !== decision.gate_policy_version
      || artifact.gate_policy_config_sha256 !== revision.gate_policy_config_sha256
      || artifact.evidence_scope_set_sha256 !== decision.evidence_scope_set_sha256
      || Number(artifact.row_id) > Number(decision.evidence_artifact_cutoff_row_id)) {
      throw new Error(`gate artifact membership reference mismatch: ${String(membership.artifact_id)}`);
    }
    const roleRequirement = GATE_ARTIFACT_REQUIREMENTS.find(
      ({ artifactRole }) => artifactRole === membership.artifact_role,
    );
    if (!roleRequirement || artifact.artifact_kind !== roleRequirement.artifactKind) {
      throw new Error(`gate artifact membership role/kind mismatch: ${String(membership.artifact_id)}`);
    }
    if (decision.evidence_verdict !== "hold" && artifact.artifact_status !== "passed") {
      throw new Error("actionable gate evidence requires every artifact head to be passing");
    }
    const superseder = db.prepare(
      `SELECT 1 FROM lite_learning_evidence_artifacts
       WHERE tenant_id = ? AND supersedes_artifact_id = ? AND row_id <= ?`,
    ).get(decision.tenant_id, membership.artifact_id, decision.evidence_artifact_cutoff_row_id);
    if (superseder) throw new Error(`gate artifact membership is not the cutoff chain head: ${String(membership.artifact_id)}`);
    if (membership.artifact_role === "runtime_integrity") {
      if (artifact.artifact_kind !== "runtime_integrity_gate") {
        throw new Error("runtime_integrity membership requires a Runtime-integrity artifact");
      }
      if (membership.artifact_id === reservation.runtime_integrity_artifact_id
        && membership.report_sha256 === reservation.runtime_integrity_report_sha256) {
        includesReservedRuntimeIntegrityArtifact = true;
      }
    }
    artifactSetMembers.push(expectedHead);
  }
  if (!includesReservedRuntimeIntegrityArtifact) {
    throw new Error("gate artifact set omits the reserved Runtime-integrity artifact");
  }
  const artifactSetDigest = learningGateArtifactSetDigest(artifactSetMembers);
  if (decision.evidence_artifact_set_sha256 !== artifactSetDigest
    || requiredHeadsDigest !== artifactSetDigest) {
    throw new Error("gate evidence artifact-set digest mismatch");
  }
}

export type LiteLearningEpisodeLedgerReplay = Readonly<{
  verifier_id: "aionis_lite_learning_ledger_replay";
  verifier_version: 1;
  table_counts: Readonly<Record<string, number>>;
  protected_event_count: number;
  legacy_event_count: number;
  promotion_eligible_exposure_count: number;
  control_job_count: number;
  control_job_dead_letter_count: number;
  control_job_expired_lease_count: number;
}>;

function learningTableRows(
  db: SqliteDatabase,
  table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  orderBy: string,
): LiteLearningAuthorityRow[] {
  const columns = LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table]
    .filter((column) => !(AUTO_INCREMENT_COLUMNS[table] ?? []).includes(column));
  return db.prepare(
    `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`,
  ).all() as LiteLearningAuthorityRow[];
}

function learningEventFromRow(row: LiteLearningAuthorityRow): EventWithoutDigest {
  return LearningEpisodeEventWithoutDigestSchema.parse({
    contract_version: "aionis_learning_episode_event_v1",
    tenant_id: row.tenant_id,
    scope: row.scope,
    event_id: row.event_id,
    episode_id: row.episode_id,
    episode_sequence: row.episode_sequence,
    event_kind: row.event_kind,
    source_kind: row.source_kind,
    source_id: row.source_id,
    source_sha256: row.source_sha256,
    previous_event_sha256: row.previous_event_sha256,
    payload_sha256: row.payload_sha256,
    item_set_sha256: row.item_set_sha256,
    source_commit_id: row.source_commit_id,
    supersedes_event_id: row.supersedes_event_id,
    operation_id: row.operation_id,
    run_id: row.run_id,
    collection_class: row.collection_class,
    recorded_at: row.recorded_at,
  });
}

function learningItemFromRow(row: LiteLearningAuthorityRow): LearningLedgerItem {
  return LearningLedgerItemSchema.parse({
    memory_id: row.memory_id,
    decision_completeness: row.decision_completeness,
    memory_type: row.memory_type,
    source_backend: row.source_backend,
    recorded_action: row.recorded_action,
    candidate_action: row.candidate_action,
    served_action: row.served_action,
    policy_changed: row.policy_changed === null ? null : row.policy_changed === 1,
    hard_boundary_preserved: row.hard_boundary_preserved === null
      ? null
      : row.hard_boundary_preserved === 1,
    prior_supported_use_count: row.prior_supported_use_count,
    prior_contradicted_use_count: row.prior_contradicted_use_count,
    prior_rehydrate_requested_count: row.prior_rehydrate_requested_count,
    prior_effect_state: row.prior_effect_state,
    repeated_negative_posture: row.repeated_negative_posture === null
      ? null
      : row.repeated_negative_posture === 1,
    learning_track: row.learning_track,
    track_reason: row.track_reason,
  });
}

function validateStoredPolicyAndRevisionRows(db: SqliteDatabase): void {
  for (const row of learningTableRows(
    db,
    "lite_learning_policy_versions",
    "tenant_id, policy_kind, policy_id, policy_version",
  )) {
    assertExactRowShape("lite_learning_policy_versions", row);
    validatePolicyVersion(row);
  }
  for (const row of learningTableRows(
    db,
    "lite_learning_collection_principal_bindings",
    "tenant_id, collection_principal_sha256",
  )) {
    assertExactRowShape("lite_learning_collection_principal_bindings", row);
    assertCanonicalJsonDigest(row, "verifier_policy_json", "verifier_policy_sha256");
    parseFrozenHostVerifierPolicy(requiredString(row, "verifier_policy_json"));
    if (row.binding_sha256 !== learningCollectionPrincipalBindingDigest(row)) {
      throw new Error("collection principal binding digest mismatch");
    }
  }
  for (const row of learningTableRows(
    db,
    "lite_learning_experiment_revisions",
    "tenant_id, experiment_id, experiment_revision",
  )) {
    assertExactRowShape("lite_learning_experiment_revisions", row);
    validateExperimentRevision(db, row);
  }
}

function validateStoredConfirmatorySets(db: SqliteDatabase): void {
  const attempts = learningTableRows(
    db,
    "lite_learning_confirmatory_attempts",
    "tenant_id, confirmatory_attempt_id",
  );
  const allPairs = learningTableRows(
    db,
    "lite_learning_randomization_pairs",
    "tenant_id, confirmatory_attempt_id, pair_ordinal",
  );
  const allLeases = learningTableRows(
    db,
    "lite_learning_namespace_leases",
    "tenant_id, confirmatory_attempt_id, namespace_lease_id",
  );
  const byAttempt = (row: LiteLearningAuthorityRow): string => (
    `${String(row.tenant_id)}\u0000${String(row.confirmatory_attempt_id)}`
  );
  const pairsByAttempt = new Map<string, LiteLearningAuthorityRow[]>();
  const leasesByAttempt = new Map<string, LiteLearningAuthorityRow[]>();
  for (const pair of allPairs) {
    const key = byAttempt(pair);
    const values = pairsByAttempt.get(key) ?? [];
    values.push(pair);
    pairsByAttempt.set(key, values);
  }
  for (const lease of allLeases) {
    const key = byAttempt(lease);
    const values = leasesByAttempt.get(key) ?? [];
    values.push(lease);
    leasesByAttempt.set(key, values);
  }
  let pairCount = 0;
  let leaseCount = 0;
  for (const attempt of attempts) {
    assertExactRowShape("lite_learning_confirmatory_attempts", attempt);
    validateConfirmatoryAttempt(db, attempt, { exactReplay: true });
    const revision = db.prepare(
      `SELECT ${LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_experiment_revisions.join(", ")}
       FROM lite_learning_experiment_revisions
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(
      attempt.tenant_id,
      attempt.experiment_id,
      attempt.experiment_revision,
    ) as LiteLearningAuthorityRow | undefined;
    if (!revision) throw new Error("confirmatory attempt revision is unresolved");
    const attemptKey = byAttempt(attempt);
    const pairs = pairsByAttempt.get(attemptKey) ?? [];
    const leases = leasesByAttempt.get(attemptKey) ?? [];
    pairCount += pairs.length;
    leaseCount += leases.length;
    const manifest = validateRandomizationManifest(pairs, attempt);
    for (const owner of [revision, attempt]) {
      if (owner.randomization_pair_manifest_sha256 !== manifest.pairManifestSha256
        || owner.activation_schedule_sha256 !== manifest.activationScheduleSha256) {
        throw new Error("confirmatory manifest digest mismatch during replay");
      }
    }
    for (const lease of leases) {
      assertExactRowShape("lite_learning_namespace_leases", lease);
    }
    const acquisitionRows = leases.map((lease) => ({
      ...lease,
      status: "active",
      release_operation_id: null,
      release_ref_kind: null,
      release_ref_id: null,
      released_at: null,
    }));
    validateNamespaceLeaseSet(db, revision, attempt, pairs, acquisitionRows);
  }
  if (pairCount !== allPairs.length || leaseCount !== allLeases.length) {
    throw new Error("orphan confirmatory pair or namespace lease");
  }
}

function validateStoredExposureLease(
  db: SqliteDatabase,
  event: EventWithoutDigest,
  row: LiteLearningAuthorityRow,
  payload: ExposureCommittedV1,
): void {
  if (payload.assignment_algorithm !== "matched_pair_csprng_bit_v1") return;
  const lease = db.prepare(
    `SELECT memory_namespace_sha256, namespace_set_sha256, lease_generation,
            randomization_pair_sha256, pair_member_ordinal, assigned_arm,
            activation_wave_index, activation_starts_at, index_window_ends_at,
            wave_analysis_at, confirmatory_attempt_id, experiment_id,
            experiment_revision, acquired_at, status, released_at
     FROM lite_learning_namespace_leases
     WHERE tenant_id = ? AND namespace_lease_id = ?`,
  ).get(event.tenant_id, payload.namespace_lease_id) as Record<string, unknown> | undefined;
  const attempt = db.prepare(
    `SELECT confirmatory_attempt_id
     FROM lite_learning_confirmatory_attempts
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(event.tenant_id, row.experiment_id, row.experiment_revision) as {
    confirmatory_attempt_id: string;
  } | undefined;
  if (!lease
    || !attempt
    || lease.memory_namespace_sha256 !== payload.memory_namespace_sha256
    || lease.namespace_set_sha256 !== payload.namespace_set_sha256
    || lease.lease_generation !== payload.namespace_lease_generation
    || lease.randomization_pair_sha256 !== payload.randomization_pair_sha256
    || lease.pair_member_ordinal !== payload.pair_member_ordinal
    || lease.assigned_arm !== payload.assignment_arm
    || lease.activation_wave_index !== payload.activation_wave_index
    || lease.activation_starts_at !== payload.activation_starts_at
    || lease.index_window_ends_at !== payload.index_window_ends_at
    || lease.wave_analysis_at !== payload.wave_analysis_at
    || lease.confirmatory_attempt_id !== attempt.confirmatory_attempt_id
    || lease.experiment_id !== row.experiment_id
    || lease.experiment_revision !== row.experiment_revision
    || String(lease.acquired_at) > event.recorded_at
    || (lease.status !== "active" && lease.status !== "released")
    || (lease.status === "released"
      && (lease.released_at === null || String(lease.released_at) < event.recorded_at))
    || event.recorded_at < String(lease.activation_starts_at)
    || event.recorded_at > String(lease.index_window_ends_at)) {
    throw new Error("learning exposure persisted namespace lease binding mismatch");
  }
}

function validateStoredEpisodeRows(db: SqliteDatabase): {
  protectedEventCount: number;
  legacyEventCount: number;
  promotionEligibleExposureCount: number;
} {
  const rows = learningTableRows(db, "lite_learning_episode_events", "row_id");
  const allExposureItems = learningTableRows(
    db,
    "lite_learning_exposure_items",
    "tenant_id, scope, event_id, memory_id",
  );
  const allFeedbackAttributions = learningTableRows(
    db,
    "lite_learning_feedback_attributions",
    "tenant_id, scope, event_id, subject_kind, subject_id",
  );
  const allHostReceipts = learningTableRows(
    db,
    "lite_learning_host_use_receipts",
    "tenant_id, scope, receipt_id",
  );
  const childKey = (tenantId: LiteLearningSqlValue, scope: LiteLearningSqlValue, eventId: LiteLearningSqlValue) => (
    `${String(tenantId)}\u0000${String(scope)}\u0000${String(eventId)}`
  );
  const groupRows = (
    values: readonly LiteLearningAuthorityRow[],
    eventField: "event_id" | "feedback_event_id",
  ): Map<string, LiteLearningAuthorityRow[]> => {
    const grouped = new Map<string, LiteLearningAuthorityRow[]>();
    for (const value of values) {
      const key = childKey(value.tenant_id, value.scope, value[eventField]);
      const rowsForEvent = grouped.get(key) ?? [];
      rowsForEvent.push(value);
      grouped.set(key, rowsForEvent);
    }
    return grouped;
  };
  const exposureItemsByEvent = groupRows(allExposureItems, "event_id");
  const feedbackAttributionsByEvent = groupRows(allFeedbackAttributions, "event_id");
  const hostReceiptsByEvent = groupRows(allHostReceipts, "feedback_event_id");
  const chain = new Map<string, { sequence: number; eventSha256: string }>();
  const episodeProtection = new Map<string, "protected" | "legacy_unprotected">();
  const seenEvents = new Map<string, EventWithoutDigest>();
  const superseded = new Set<string>();
  let exposureItemCount = 0;
  let feedbackAttributionCount = 0;
  let hostReceiptCount = 0;
  let protectedEventCount = 0;
  let legacyEventCount = 0;
  let promotionEligibleExposureCount = 0;

  for (const row of rows) {
    assertExactRowShape("lite_learning_episode_events", row);
    const event = learningEventFromRow(row);
    const payloadJson = requiredString(row, "payload_json");
    const payloadValue = canonicalJson(payloadJson, "payload_json");
    if (sha256Text(payloadJson) !== row.payload_sha256) {
      throw new Error("learning episode payload digest mismatch");
    }
    const payload = LearningEpisodePayloadV1Schema.parse(payloadValue);
    const expectedKind = {
      aionis_learning_exposure_v1: "exposure_committed",
      aionis_learning_feedback_v1: "feedback_attributed",
      aionis_learning_effect_v1: "effect_measured",
    } as const;
    if (expectedKind[payload.contract_version] !== event.event_kind) {
      throw new Error("learning episode payload kind mismatch");
    }
    if (row.event_sha256 !== learningEpisodeEventDigest(event)) {
      throw new Error("learning episode event digest mismatch");
    }
    const chainKey = `${event.tenant_id}\u0000${event.scope}\u0000${event.episode_id}`;
    const prior = chain.get(chainKey);
    if (event.episode_sequence === 1) {
      if (prior || event.previous_event_sha256 !== null) {
        throw new Error("learning episode root chain mismatch");
      }
    } else if (!prior
      || prior.sequence + 1 !== event.episode_sequence
      || prior.eventSha256 !== event.previous_event_sha256) {
      throw new Error("learning episode previous-event chain mismatch");
    }
    chain.set(chainKey, {
      sequence: event.episode_sequence,
      eventSha256: requiredString(row, "event_sha256"),
    });

    if (event.supersedes_event_id !== null) {
      const supersessionKey = `${event.tenant_id}\u0000${event.scope}\u0000${event.supersedes_event_id}`;
      const previous = seenEvents.get(supersessionKey);
      if (!previous
        || previous.episode_id !== event.episode_id
        || previous.event_kind !== "feedback_attributed"
        || event.event_kind !== "feedback_attributed"
        || superseded.has(supersessionKey)) {
        throw new Error("learning feedback supersession chain mismatch");
      }
      superseded.add(supersessionKey);
    }
    seenEvents.set(`${event.tenant_id}\u0000${event.scope}\u0000${event.event_id}`, event);

    if (payload.contract_version === "aionis_learning_exposure_v1") {
      const itemRows = exposureItemsByEvent.get(childKey(
        event.tenant_id,
        event.scope,
        event.event_id,
      )) ?? [];
      const items = itemRows.map((itemRow) => {
        assertExactRowShape("lite_learning_exposure_items", itemRow);
        assertRowBindings(itemRow, {
          tenant_id: event.tenant_id,
          scope: event.scope,
          event_id: event.event_id,
          episode_id: event.episode_id,
        }, "learning exposure item");
        const item = learningItemFromRow(itemRow);
        if (itemRow.item_sha256 !== sha256Text(stableStringify(item))) {
          throw new Error("learning exposure item digest mismatch");
        }
        return item;
      });
      exposureItemCount += items.length;
      if (row.item_set_sha256 !== learningItemSetDigest(items)) {
        throw new Error("learning exposure item-set digest mismatch");
      }
      validateExposureBindings(db, row, payload, items);
      validateStoredExposureLease(db, event, row, payload);
      if (Number(row.promotion_eligible) !== (isLearningExposurePromotionEligible(payload) ? 1 : 0)) {
        throw new Error("learning exposure promotion eligibility cache mismatch");
      }
      if (row.promotion_eligible === 1) promotionEligibleExposureCount += 1;
      episodeProtection.set(chainKey, payload.operation_protection);
      if (payload.operation_protection === "protected") protectedEventCount += 1;
      else legacyEventCount += 1;
    } else if (payload.contract_version === "aionis_learning_feedback_v1") {
      const key = childKey(event.tenant_id, event.scope, event.event_id);
      const attributions = feedbackAttributionsByEvent.get(key) ?? [];
      const receipts = hostReceiptsByEvent.get(key) ?? [];
      if (receipts.length > 1) throw new Error("learning feedback has multiple host-use receipts");
      if (episodeProtection.get(chainKey) !== payload.operation_protection) {
        throw new Error("learning feedback operation protection does not match its exposure episode");
      }
      validateFeedbackChildren(db, event, row, payload, attributions, receipts[0] ?? null);
      feedbackAttributionCount += attributions.length;
      hostReceiptCount += receipts.length;
      if (payload.operation_protection === "protected") protectedEventCount += 1;
      else legacyEventCount += 1;
    } else {
      validateEffectMeasurement(db, event, payload);
      const protection = episodeProtection.get(chainKey);
      if (!protection) throw new Error("learning effect has no exposure protection authority");
      if (protection === "protected") protectedEventCount += 1;
      else legacyEventCount += 1;
    }
  }

  if (exposureItemCount !== allExposureItems.length
    || feedbackAttributionCount !== allFeedbackAttributions.length
    || hostReceiptCount !== allHostReceipts.length) {
    throw new Error("orphan learning episode child row");
  }

  const invalidHostAliases = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_episode_events AS left_row
     JOIN lite_learning_episode_events AS right_row
       ON right_row.row_id > left_row.row_id
      AND right_row.tenant_id = left_row.tenant_id
      AND right_row.experiment_id = left_row.experiment_id
      AND right_row.experiment_revision = left_row.experiment_revision
      AND right_row.event_kind = 'exposure_committed'
      AND right_row.collection_class = 'eligible_host'
     WHERE left_row.event_kind = 'exposure_committed'
       AND left_row.collection_class = 'eligible_host'
       AND ((right_row.host_task_id = left_row.host_task_id AND (
         right_row.host_source_task_sha256 IS NOT left_row.host_source_task_sha256
         OR right_row.task_family IS NOT left_row.task_family
         OR right_row.task_signature_sha256 IS NOT left_row.task_signature_sha256
         OR right_row.repo_signature_sha256 IS NOT left_row.repo_signature_sha256
         OR right_row.memory_namespace_sha256 IS NOT left_row.memory_namespace_sha256
         OR right_row.collector_id IS NOT left_row.collector_id
         OR right_row.collector_version IS NOT left_row.collector_version
       )) OR (
         right_row.host_source_task_sha256 = left_row.host_source_task_sha256
         AND right_row.host_task_id <> left_row.host_task_id
       ))`,
  );
  if (invalidHostAliases > 0) throw new Error("learning host-task source alias mismatch");
  return { protectedEventCount, legacyEventCount, promotionEligibleExposureCount };
}

function validateStoredControlJobs(
  db: SqliteDatabase,
  checkedAt: string,
): { count: number; deadLetters: number; expiredLeases: number } {
  if (!isCanonicalUtcMillis(checkedAt)) throw new Error("learning ledger checkedAt must be canonical UTC milliseconds");
  const jobs = learningTableRows(db, "lite_learning_control_jobs", "row_id");
  let deadLetters = 0;
  let expiredLeases = 0;
  for (const job of jobs) {
    assertExactRowShape("lite_learning_control_jobs", job);
    assertCanonicalJsonDigest(job, "payload_json", "payload_sha256");
    const payloadValue = canonicalJson(job.payload_json, "lite_learning_control_jobs.payload_json");
    if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) {
      throw new Error("learning control job payload must be the exact canonical object");
    }
    const payload = payloadValue as Record<string, unknown>;
    const payloadKeys = Object.keys(payload).sort();
    if (stableStringify(payloadKeys)
      !== stableStringify(["contract_version", "exposure_ids", "feedback_event_id"])) {
      throw new Error("learning control job payload must be the exact canonical object");
    }
    const exposureIds = payload.exposure_ids;
    if (payload.contract_version !== "unused_exposure_learning_control_v1"
      || payload.feedback_event_id !== job.source_feedback_event_id
      || !Array.isArray(exposureIds)
      || exposureIds.length < 1
      || exposureIds.length > 96
      || exposureIds.some((value) => typeof value !== "string" || value.length < 1 || value.length > 256)
      || new Set(exposureIds).size !== exposureIds.length) {
      throw new Error("learning control job payload semantic binding mismatch");
    }
    const source = db.prepare(
      `SELECT episode_id, source_commit_id, payload_json, recorded_at
       FROM lite_learning_episode_events
       WHERE tenant_id = ? AND scope = ? AND event_id = ?
         AND event_kind = 'feedback_attributed'`,
    ).get(job.tenant_id, job.scope, job.source_feedback_event_id) as Record<string, unknown> | undefined;
    if (!source
      || source.episode_id !== job.source_episode_id
      || source.source_commit_id !== job.source_commit_id) {
      throw new Error("learning control job source feedback binding mismatch");
    }
    const sourcePayload = LearningEpisodePayloadV1Schema.parse(canonicalJson(
      source.payload_json as string,
      "learning control source feedback payload",
    ));
    if (sourcePayload.contract_version !== "aionis_learning_feedback_v1"
      || stableStringify([...sourcePayload.unused_exposure_ids].sort())
        !== stableStringify([...(exposureIds as string[])].sort())) {
      throw new Error("learning control job exposure set does not match its source feedback");
    }
    for (const exposureId of exposureIds as string[]) {
      if (!db.prepare(
        `SELECT 1 FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND event_id = ?
           AND event_kind = 'exposure_committed'`,
      ).get(job.tenant_id, job.scope, exposureId)) {
        throw new Error("learning control job references an unresolved exposure event");
      }
    }
    const createdAt = requiredString(job, "created_at");
    const updatedAt = requiredString(job, "updated_at");
    const availableAt = requiredString(job, "available_at");
    if (String(source.recorded_at) > createdAt
      || createdAt > availableAt
      || createdAt > updatedAt
      || (job.lease_expires_at !== null && updatedAt >= String(job.lease_expires_at))
      || (job.completed_at !== null
        && (createdAt > String(job.completed_at) || String(job.completed_at) > updatedAt))) {
      throw new Error("learning control job lifecycle timestamp order mismatch");
    }
    if (job.status === "dead_letter") deadLetters += 1;
    if (job.status === "leased" && requiredString(job, "lease_expires_at") < checkedAt) {
      expiredLeases += 1;
    }
  }
  return { count: jobs.length, deadLetters, expiredLeases };
}

function validateStoredAuthorityRows(db: SqliteDatabase): void {
  const membershipsByDecision = new Map<string, LiteLearningAuthorityRow[]>();
  for (const membership of learningTableRows(
    db,
    "lite_learning_gate_artifact_memberships",
    "tenant_id, decision_id, artifact_role, role_ordinal, artifact_id",
  )) {
    const key = `${String(membership.tenant_id)}\u0000${String(membership.decision_id)}`;
    const rows = membershipsByDecision.get(key) ?? [];
    rows.push(membership);
    membershipsByDecision.set(key, rows);
  }
  for (const table of [
    "lite_learning_experiment_closures",
    "lite_learning_external_run_reservations",
    "lite_learning_external_ticket_consumptions",
    "lite_learning_evidence_artifacts",
    "lite_learning_gate_look_reservations",
    "lite_learning_gate_decisions",
  ] as const) {
    const orderBy = table === "lite_learning_evidence_artifacts"
      || table === "lite_learning_gate_look_reservations"
      || table === "lite_learning_gate_decisions"
      ? "row_id"
      : LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table].slice(0, 2).join(", ");
    for (const row of learningTableRows(db, table, orderBy)) {
      assertExactRowShape(table, row);
      if (table === "lite_learning_evidence_artifacts" && row.artifact_kind !== "runtime_integrity_gate") {
        continue;
      }
      if (table === "lite_learning_gate_decisions") {
        assertCanonicalJsonDigest(row, "evidence_summary_json", "evidence_summary_sha256");
        if (row.decision_sha256 !== learningGateDecisionDigest(row)) {
          throw new Error("gate decision digest mismatch");
        }
        if (row.decision_kind === "evidence_evaluation") {
          const memberships = membershipsByDecision.get(
            `${String(row.tenant_id)}\u0000${String(row.decision_id)}`,
          ) ?? [];
          validateGateEvidenceEvaluation(db, row, memberships);
          continue;
        }
      }
      validateAuthorityFactReferences(db, table, row);
    }
  }
  const orphanMemberships = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM lite_learning_gate_artifact_memberships AS membership
     WHERE NOT EXISTS (
       SELECT 1 FROM lite_learning_gate_decisions AS decision
       WHERE decision.tenant_id = membership.tenant_id
         AND decision.decision_id = membership.decision_id
         AND decision.decision_kind = 'evidence_evaluation'
     )`,
  );
  if (orphanMemberships > 0) throw new Error("orphan gate artifact membership");
}

export function replayLiteLearningEpisodeLedger(
  db: SqliteDatabase,
  checkedAt: string,
): LiteLearningEpisodeLedgerReplay {
  if (!isCanonicalUtcMillis(checkedAt)) throw new Error("checkedAt must be a canonical UTC millisecond timestamp");
  validateStoredPolicyAndRevisionRows(db);
  validateStoredConfirmatorySets(db);
  const episodes = validateStoredEpisodeRows(db);
  const jobs = validateStoredControlJobs(db, checkedAt);
  validateStoredAuthorityRows(db);
  const tableCounts = Object.fromEntries(LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES.map((table) => [
    table,
    scalarCount(db, `SELECT COUNT(*) AS count FROM ${table}`),
  ]));
  return {
    verifier_id: "aionis_lite_learning_ledger_replay",
    verifier_version: 1,
    table_counts: tableCounts,
    protected_event_count: episodes.protectedEventCount,
    legacy_event_count: episodes.legacyEventCount,
    promotion_eligible_exposure_count: episodes.promotionEligibleExposureCount,
    control_job_count: jobs.count,
    control_job_dead_letter_count: jobs.deadLetters,
    control_job_expired_lease_count: jobs.expiredLeases,
  };
}

export type LiteLearningEpisodeLedgerAccess = {
  transactionRunner(): SqliteTransactionRunner;
  databaseInstanceId(): Promise<string>;
  verifyIntegrity(): Promise<void>;
  insertPolicyVersion(row: LiteLearningAuthorityRow): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
  insertCollectionPrincipalBinding(row: LiteLearningAuthorityRow): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
  insertExperimentRevision(row: LiteLearningAuthorityRow): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
  provisionConfirmatorySet(args: {
    revision: LiteLearningAuthorityRow;
    attempt: LiteLearningAuthorityRow;
    pairs: readonly LiteLearningAuthorityRow[];
    leases: readonly LiteLearningAuthorityRow[];
  }): Promise<{ replayed: boolean }>;
  releaseNamespaceLeaseSet(args: {
    tenantId: string;
    confirmatoryAttemptId: string;
    releaseOperationId: string;
    releaseRefKind: "experiment_close" | "terminal_authority_adjudication";
    releaseRefId: string;
    releasedAt: string;
    expectedLeaseIds: readonly string[];
  }): Promise<number>;
  appendEpisodeEvent(args: {
    row: LiteLearningAuthorityRow;
    event: EventWithoutDigest;
    payload: unknown;
    exposureItems?: readonly LearningLedgerItem[];
    feedbackAttributions?: readonly LiteLearningAuthorityRow[];
    hostUseReceipt?: LiteLearningAuthorityRow | null;
  }): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
  reserveGateLook(args: {
    artifact: LiteLearningAuthorityRow;
    reservation: LiteLearningAuthorityRow;
  }): Promise<{
    artifact: Record<string, unknown>;
    reservation: Record<string, unknown>;
    replayed: boolean;
  }>;
  insertGateEvidenceEvaluation(args: {
    decision: LiteLearningAuthorityRow;
    memberships: readonly LiteLearningAuthorityRow[];
  }): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
  insertAuthorityFact(
    table: LiteLearningAuthorityFactTable,
    row: LiteLearningAuthorityRow,
  ): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
};

export function createLiteLearningEpisodeLedgerAccess(
  database: LiteRuntimeDatabase,
): LiteLearningEpisodeLedgerAccess {
  const { db, transaction } = database;
  assertLiteLearningEpisodeLedgerIntegrity(db);

  return {
    transactionRunner() {
      return transaction;
    },

    async databaseInstanceId() {
      return await transaction.read(() => assertLiteRuntimeAuthorityIdentity(db));
    },

    async verifyIntegrity() {
      await transaction.read(() => assertLiteLearningEpisodeLedgerIntegrity(db));
    },

    async insertPolicyVersion(row) {
      assertStoreTransaction(transaction);
      validatePolicyVersion(row);
      return insertExactImmutableRow(db, "lite_learning_policy_versions", row, [
        "tenant_id", "policy_kind", "policy_id", "policy_version",
      ]);
    },

    async insertCollectionPrincipalBinding(row) {
      assertStoreTransaction(transaction);
      assertCanonicalJsonDigest(row, "verifier_policy_json", "verifier_policy_sha256");
      parseFrozenHostVerifierPolicy(requiredString(row, "verifier_policy_json"));
      if (row.binding_sha256 !== learningCollectionPrincipalBindingDigest(row)) {
        throw new Error("collection principal binding digest mismatch");
      }
      return insertExactImmutableRow(db, "lite_learning_collection_principal_bindings", row, [
        "tenant_id", "collection_principal_sha256",
      ]);
    },

    async insertExperimentRevision(row) {
      assertStoreTransaction(transaction);
      validateExperimentRevision(db, row);
      if (row.evidence_intent === "confirmatory") {
        throw new Error("confirmatory revisions must use atomic provisionConfirmatorySet");
      }
      return insertExactImmutableRow(db, "lite_learning_experiment_revisions", row, [
        "tenant_id", "experiment_id", "experiment_revision",
      ]);
    },

    async provisionConfirmatorySet(args) {
      assertStoreTransaction(transaction);
      validateExperimentRevision(db, args.revision);
      if (args.revision.evidence_intent !== "confirmatory") {
        throw new Error("atomic confirmatory provisioning requires evidence_intent=confirmatory");
      }
      const manifest = validateRandomizationManifest(args.pairs, args.attempt);
      for (const owner of [args.revision, args.attempt]) {
        if (owner.randomization_pair_manifest_sha256 !== manifest.pairManifestSha256) {
          throw new Error("confirmatory pair-manifest digest mismatch");
        }
        if (owner.activation_schedule_sha256 !== manifest.activationScheduleSha256) {
          throw new Error("confirmatory activation-schedule digest mismatch");
        }
      }
      const existingRevision = selectExactRow(db, "lite_learning_experiment_revisions", [
        "tenant_id", "experiment_id", "experiment_revision",
      ], args.revision);
      const revisionResult = insertExactImmutableRow(db, "lite_learning_experiment_revisions", args.revision, [
        "tenant_id", "experiment_id", "experiment_revision",
      ]);
      const existingAttempt = selectExactRow(db, "lite_learning_confirmatory_attempts", [
        "tenant_id", "confirmatory_attempt_id",
      ], args.attempt);
      if (existingAttempt) assertExactReplay(
        "lite_learning_confirmatory_attempts",
        existingAttempt,
        args.attempt,
      );
      validateConfirmatoryAttempt(db, args.attempt, { exactReplay: existingAttempt !== null });
      const attemptResult = insertExactImmutableRow(db, "lite_learning_confirmatory_attempts", args.attempt, [
        "tenant_id", "confirmatory_attempt_id",
      ]);
      validateNamespaceLeaseSet(db, args.revision, args.attempt, args.pairs, args.leases);
      for (const pair of args.pairs) {
        if (pair.tenant_id !== args.attempt.tenant_id
          || pair.confirmatory_attempt_id !== args.attempt.confirmatory_attempt_id) {
          throw new Error("randomization pair attempt identity mismatch");
        }
        insertExactImmutableRow(db, "lite_learning_randomization_pairs", pair, [
          "tenant_id", "confirmatory_attempt_id", "randomization_pair_sha256",
        ]);
      }
      for (const lease of args.leases) {
        insertExactImmutableRow(db, "lite_learning_namespace_leases", lease, [
          "tenant_id", "namespace_lease_id",
        ]);
      }
      assertLiteLearningEpisodeLedgerIntegrity(db);
      return {
        replayed: existingRevision !== null && revisionResult.replayed && attemptResult.replayed,
      };
    },

    async releaseNamespaceLeaseSet(args) {
      assertStoreTransaction(transaction);
      if (!isCanonicalUtcMillis(args.releasedAt)) throw new Error("releasedAt must be canonical UTC milliseconds");
      const leases = db.prepare(
        `SELECT namespace_lease_id, status
         FROM lite_learning_namespace_leases
         WHERE tenant_id = ? AND confirmatory_attempt_id = ?
         ORDER BY namespace_lease_id`,
      ).all(args.tenantId, args.confirmatoryAttemptId) as Array<{ namespace_lease_id: string; status: string }>;
      const expected = [...args.expectedLeaseIds].sort();
      const actual = leases.map((row) => row.namespace_lease_id);
      if (actual.length !== 768 || stableStringify(actual) !== stableStringify(expected)) {
        throw new Error("namespace lease release requires the exact complete 768-member set");
      }
      const allReleased = leases.every((row) => row.status === "released");
      if (allReleased) {
        const rows = db.prepare(
          `SELECT DISTINCT release_operation_id, release_ref_kind, release_ref_id, released_at
           FROM lite_learning_namespace_leases
           WHERE tenant_id = ? AND confirmatory_attempt_id = ?`,
        ).all(args.tenantId, args.confirmatoryAttemptId) as Array<Record<string, unknown>>;
        if (rows.length === 1
          && rows[0]?.release_operation_id === args.releaseOperationId
          && rows[0]?.release_ref_kind === args.releaseRefKind
          && rows[0]?.release_ref_id === args.releaseRefId
          && rows[0]?.released_at === args.releasedAt) return 0;
        throw new Error("namespace lease release replay conflict");
      }
      if (leases.some((row) => row.status !== "active")) {
        throw new Error("namespace lease set is partially released or corrupt");
      }
      const attempt = db.prepare(
        `SELECT task_family, candidate_policy_id, candidate_policy_version,
                candidate_policy_implementation_sha256, experiment_id,
                experiment_revision, gate_policy_id, gate_policy_version,
                gate_policy_config_sha256, eligible_memory_namespace_set_sha256
         FROM lite_learning_confirmatory_attempts
         WHERE tenant_id = ? AND confirmatory_attempt_id = ?`,
      ).get(args.tenantId, args.confirmatoryAttemptId) as Record<string, unknown> | undefined;
      if (!attempt) throw new Error("namespace lease release confirmatory attempt is unresolved");
      const referenceExists = args.releaseRefKind === "experiment_close"
        ? !!db.prepare(
          `SELECT 1 FROM lite_learning_experiment_closures
           WHERE tenant_id = ? AND experiment_close_id = ? AND confirmatory_attempt_id = ?
             AND experiment_id = ? AND experiment_revision = ? AND namespace_set_sha256 = ?`,
        ).get(
          args.tenantId,
          args.releaseRefId,
          args.confirmatoryAttemptId,
          attempt.experiment_id,
          attempt.experiment_revision,
          attempt.eligible_memory_namespace_set_sha256,
        )
        : !!db.prepare(
          `SELECT 1 FROM lite_learning_gate_decisions
           WHERE tenant_id = ? AND decision_id = ? AND decision_kind = 'authority_adjudication'
             AND authority_action IN ('promote', 'demote', 'retire')
             AND task_family = ?
             AND candidate_policy_id = ? AND candidate_policy_version = ?
             AND candidate_policy_implementation_sha256 = ?
             AND experiment_id = ? AND experiment_revision = ?
             AND gate_policy_id = ? AND gate_policy_version = ?`,
        ).get(
          args.tenantId,
          args.releaseRefId,
          attempt.task_family,
          attempt.candidate_policy_id,
          attempt.candidate_policy_version,
          attempt.candidate_policy_implementation_sha256,
          attempt.experiment_id,
          attempt.experiment_revision,
          attempt.gate_policy_id,
          attempt.gate_policy_version,
        );
      if (!referenceExists) throw new Error("namespace lease release authority reference is unresolved");
      const result = db.prepare(
        `UPDATE lite_learning_namespace_leases
         SET status = 'released', release_operation_id = ?, release_ref_kind = ?,
             release_ref_id = ?, released_at = ?
         WHERE tenant_id = ? AND confirmatory_attempt_id = ? AND status = 'active'`,
      ).run(
        args.releaseOperationId,
        args.releaseRefKind,
        args.releaseRefId,
        args.releasedAt,
        args.tenantId,
        args.confirmatoryAttemptId,
      ) as { changes?: number };
      const changed = Number(result.changes ?? 0);
      if (changed !== 768) throw new Error(`namespace lease release changed ${changed} rows instead of 768`);
      assertLiteLearningEpisodeLedgerIntegrity(db);
      return changed;
    },

    async appendEpisodeEvent(args) {
      assertStoreTransaction(transaction);
      const event = LearningEpisodeEventWithoutDigestSchema.parse(args.event);
      const payload = LearningEpisodePayloadV1Schema.parse(args.payload);
      const payloadJson = stableStringify(payload);
      if (args.row.payload_json !== payloadJson || args.row.payload_sha256 !== sha256Text(payloadJson)) {
        throw new Error("learning episode payload digest mismatch");
      }
      const eventKindByContract = {
        aionis_learning_exposure_v1: "exposure_committed",
        aionis_learning_feedback_v1: "feedback_attributed",
        aionis_learning_effect_v1: "effect_measured",
      } as const;
      if (eventKindByContract[payload.contract_version] !== event.event_kind) {
        throw new Error("learning episode payload kind does not match event kind");
      }
      for (const field of [
        "tenant_id", "scope", "event_id", "episode_id", "episode_sequence", "event_kind",
        "source_kind", "source_id", "source_sha256", "previous_event_sha256", "payload_sha256",
        "item_set_sha256", "source_commit_id", "supersedes_event_id", "operation_id", "run_id",
        "collection_class", "recorded_at",
      ]) {
        if (!valuesEqual(args.row[field], event[field as keyof EventWithoutDigest])) {
          throw new Error(`learning episode event row mismatch: ${field}`);
        }
      }
      if (args.row.event_sha256 !== learningEpisodeEventDigest(event)) {
        throw new Error("learning episode event digest mismatch");
      }
      const items = (args.exposureItems ?? []).map((item) => LearningLedgerItemSchema.parse(item));
      const feedbackAttributions = args.feedbackAttributions ?? [];
      const hostUseReceipt = args.hostUseReceipt ?? null;
      if (event.event_kind === "exposure_committed") {
        if (feedbackAttributions.length > 0 || hostUseReceipt !== null) {
          throw new Error("exposure events cannot persist feedback child rows");
        }
        if (args.row.item_set_sha256 !== learningItemSetDigest(items)) {
          throw new Error("learning exposure item-set digest mismatch");
        }
        validateExposureBindings(db, args.row, payload as ExposureCommittedV1, items);
      } else if (event.event_kind === "feedback_attributed") {
        if (items.length > 0) throw new Error("feedback events cannot persist exposure item rows");
        validateFeedbackChildren(
          db,
          event,
          args.row,
          payload as FeedbackAttributedV1,
          feedbackAttributions,
          hostUseReceipt,
        );
      } else {
        if (items.length > 0 || feedbackAttributions.length > 0 || hostUseReceipt !== null) {
          throw new Error("effect events cannot persist exposure or feedback child rows");
        }
        validateEffectMeasurement(db, event, payload as EffectMeasuredV1);
      }
      const existingEvent = selectExactRow(db, "lite_learning_episode_events", [
        "tenant_id", "scope", "event_id",
      ], args.row);
      if (existingEvent) {
        assertExactReplay("lite_learning_episode_events", existingEvent, args.row);
        if (event.event_kind === "exposure_committed") {
          const storedItemCount = scalarCount(
            db,
            `SELECT COUNT(*) AS count FROM lite_learning_exposure_items
             WHERE tenant_id = ? AND scope = ? AND event_id = ?`,
            event.tenant_id,
            event.scope,
            event.event_id,
          );
          if (storedItemCount !== items.length) {
            throw new Error("learning exposure replay item membership conflict");
          }
        } else if (event.event_kind === "feedback_attributed") {
          for (const attribution of feedbackAttributions) {
            const existingAttribution = selectExactRow(db, "lite_learning_feedback_attributions", [
              "tenant_id", "scope", "event_id", "subject_kind", "subject_id",
            ], attribution);
            if (!existingAttribution) throw new Error("learning feedback replay item membership conflict");
            assertExactReplay("lite_learning_feedback_attributions", existingAttribution, attribution);
          }
          if (hostUseReceipt !== null) {
            const existingReceipt = selectExactRow(db, "lite_learning_host_use_receipts", [
              "tenant_id", "scope", "receipt_id",
            ], hostUseReceipt);
            if (!existingReceipt) throw new Error("learning feedback replay receipt membership conflict");
            assertExactReplay("lite_learning_host_use_receipts", existingReceipt, hostUseReceipt);
          }
        }
        return { row: existingEvent, replayed: true };
      }
      const prior = db.prepare(
        `SELECT episode_sequence, event_sha256
         FROM lite_learning_episode_events
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?
         ORDER BY episode_sequence DESC LIMIT 1`,
      ).get(event.tenant_id, event.scope, event.episode_id) as {
        episode_sequence: number;
        event_sha256: string;
      } | undefined;
      if (event.episode_sequence === 1) {
        if (prior) throw new Error("learning episode sequence must continue the existing chain");
      } else if (!prior
        || prior.episode_sequence + 1 !== event.episode_sequence
        || prior.event_sha256 !== event.previous_event_sha256) {
        throw new Error("learning episode previous-event chain mismatch");
      }
      const result = insertExactImmutableRow(db, "lite_learning_episode_events", args.row, [
        "tenant_id", "scope", "event_id",
      ]);
      if (!result.replayed) {
        for (const item of items) {
          const itemRow: LiteLearningAuthorityRow = {
            tenant_id: event.tenant_id,
            scope: event.scope,
            event_id: event.event_id,
            episode_id: event.episode_id,
            memory_id: item.memory_id,
            decision_completeness: item.decision_completeness,
            memory_type: item.memory_type,
            source_backend: item.source_backend,
            recorded_action: item.recorded_action,
            candidate_action: item.candidate_action,
            served_action: item.served_action,
            policy_changed: item.policy_changed === null ? null : item.policy_changed ? 1 : 0,
            hard_boundary_preserved: item.hard_boundary_preserved === null
              ? null
              : item.hard_boundary_preserved ? 1 : 0,
            prior_supported_use_count: item.prior_supported_use_count,
            prior_contradicted_use_count: item.prior_contradicted_use_count,
            prior_rehydrate_requested_count: item.prior_rehydrate_requested_count,
            prior_effect_state: item.prior_effect_state,
            repeated_negative_posture: item.repeated_negative_posture === null
              ? null
              : item.repeated_negative_posture ? 1 : 0,
            learning_track: item.learning_track,
            track_reason: item.track_reason,
            item_sha256: sha256Text(stableStringify(item)),
          };
          insertExactImmutableRow(db, "lite_learning_exposure_items", itemRow, [
            "tenant_id", "scope", "event_id", "memory_id",
          ]);
        }
        if (event.event_kind === "feedback_attributed") {
          if (hostUseReceipt !== null) {
            insertExactImmutableRow(db, "lite_learning_host_use_receipts", hostUseReceipt, [
              "tenant_id", "scope", "receipt_id",
            ]);
          }
          for (const attribution of feedbackAttributions) {
            insertExactImmutableRow(db, "lite_learning_feedback_attributions", attribution, [
              "tenant_id", "scope", "event_id", "subject_kind", "subject_id",
            ]);
          }
        }
      }
      return result;
    },

    async reserveGateLook(args) {
      assertStoreTransaction(transaction);
      assertExactRowShape("lite_learning_evidence_artifacts", args.artifact);
      assertExactRowShape("lite_learning_gate_look_reservations", args.reservation);
      if (args.artifact.artifact_kind !== "runtime_integrity_gate") {
        throw new Error("reserveGateLook accepts a Runtime-integrity artifact only");
      }
      const existingArtifact = selectExactRow(db, "lite_learning_evidence_artifacts", [
        "tenant_id", "artifact_id",
      ], args.artifact);
      const existingReservation = selectExactRow(db, "lite_learning_gate_look_reservations", [
        "tenant_id", "reservation_id",
      ], args.reservation);
      if (Boolean(existingArtifact) !== Boolean(existingReservation)) {
        throw new Error("gate look artifact/reservation atomic prefix is incomplete");
      }
      if (existingArtifact && existingReservation) {
        assertExactReplay("lite_learning_evidence_artifacts", existingArtifact, args.artifact);
        assertExactReplay("lite_learning_gate_look_reservations", existingReservation, args.reservation);
        validateAuthorityFactReferences(db, "lite_learning_evidence_artifacts", args.artifact);
        validateAuthorityFactReferences(db, "lite_learning_gate_look_reservations", args.reservation);
        return {
          artifact: existingArtifact,
          reservation: existingReservation,
          replayed: true,
        };
      }
      const liveReplay = assertLiteLearningEpisodeLedgerIntegrity(db);
      if (liveReplay.control_job_dead_letter_count > 0) {
        throw new Error("learning control dead letters block a new gate look reservation");
      }
      const savepoint = "lite_learning_reserve_gate_look";
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        validateAuthorityFactReferences(db, "lite_learning_evidence_artifacts", args.artifact);
        const artifact = insertExactImmutableRow(db, "lite_learning_evidence_artifacts", args.artifact, [
          "tenant_id", "artifact_id",
        ]);
        validateAuthorityFactReferences(db, "lite_learning_gate_look_reservations", args.reservation);
        const reservation = insertExactImmutableRow(
          db,
          "lite_learning_gate_look_reservations",
          args.reservation,
          ["tenant_id", "reservation_id"],
        );
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return {
          artifact: artifact.row,
          reservation: reservation.row,
          replayed: false,
        };
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    },

    async insertGateEvidenceEvaluation(args) {
      assertStoreTransaction(transaction);
      validateGateEvidenceEvaluation(db, args.decision, args.memberships);
      const existingDecision = selectExactRow(db, "lite_learning_gate_decisions", [
        "tenant_id", "decision_id",
      ], args.decision);
      if (existingDecision) {
        assertExactReplay("lite_learning_gate_decisions", existingDecision, args.decision);
        const existingMemberships = db.prepare(
          `SELECT * FROM lite_learning_gate_artifact_memberships
           WHERE tenant_id = ? AND decision_id = ?
           ORDER BY artifact_role, role_ordinal, artifact_id`,
        ).all(args.decision.tenant_id, args.decision.decision_id) as Array<Record<string, unknown>>;
        const expected = [...args.memberships].sort((left, right) => {
          const leftKey = `${String(left.artifact_role)}\u0000${String(left.role_ordinal).padStart(12, "0")}\u0000${String(left.artifact_id)}`;
          const rightKey = `${String(right.artifact_role)}\u0000${String(right.role_ordinal).padStart(12, "0")}\u0000${String(right.artifact_id)}`;
          return Buffer.compare(Buffer.from(leftKey, "utf8"), Buffer.from(rightKey, "utf8"));
        });
        if (existingMemberships.length !== expected.length) {
          throw new Error("gate evidence evaluation replay membership count conflict");
        }
        for (const [index, membership] of expected.entries()) {
          assertExactReplay(
            "lite_learning_gate_artifact_memberships",
            existingMemberships[index]!,
            membership,
          );
        }
        return { row: existingDecision, replayed: true };
      }
      const inserted = insertExactImmutableRow(db, "lite_learning_gate_decisions", args.decision, [
        "tenant_id", "decision_id",
      ]);
      for (const membership of args.memberships) {
        insertExactImmutableRow(db, "lite_learning_gate_artifact_memberships", membership, [
          "tenant_id", "decision_id", "artifact_id",
        ]);
      }
      return inserted;
    },

    async insertAuthorityFact(table, row) {
      assertStoreTransaction(transaction);
      if (table === "lite_learning_evidence_artifacts") {
        throw new Error(row.artifact_kind === "runtime_integrity_gate"
          ? "Runtime-integrity artifacts and look reservations require atomic reserveGateLook"
          : "external evidence artifacts require the protected Task 8 ingestion verifier");
      }
      if (table === "lite_learning_gate_look_reservations") {
        throw new Error("Runtime-integrity artifacts and look reservations require atomic reserveGateLook");
      }
      if (TASK_8_PROTECTED_EXTERNAL_FACT_TABLES.has(table)) {
        throw new Error("signed external facts require the protected Task 8 external receipt verifier");
      }
      if (table === "lite_learning_gate_artifact_memberships"
        || (table === "lite_learning_gate_decisions" && row.decision_kind === "evidence_evaluation")) {
        throw new Error("gate evidence evaluations and memberships require atomic insertGateEvidenceEvaluation");
      }
      const replayKeys = AUTHORITY_FACT_REPLAY_KEYS[table];
      if (!replayKeys) throw new Error(`Unsupported learning authority fact table: ${table}`);
      validateAuthorityFactReferences(db, table, row);
      return insertExactImmutableRow(db, table, row, replayKeys);
    },
  };
}
