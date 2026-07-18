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
      AND (NEW.promotion_eligible = 0 AND NEW.served_arm = 'control' OR NEW.promotion_eligible = 1 AND NEW.served_arm = NEW.assignment_arm)
      AND (NEW.promotion_eligible = 0 OR NEW.recorded_at >= lease.activation_starts_at AND NEW.recorded_at <= lease.index_window_ends_at)
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

CREATE TRIGGER trg_lite_learning_external_authority_operation_update
BEFORE UPDATE ON lite_runtime_write_operations
WHEN OLD.scope = 'learning_external_authority_v1'
  OR NEW.scope = 'learning_external_authority_v1'
BEGIN
  SELECT RAISE(ABORT, 'learning_external_authority_operation_update_forbidden');
END;

CREATE TRIGGER trg_lite_learning_external_authority_operation_delete
BEFORE DELETE ON lite_runtime_write_operations
WHEN OLD.scope = 'learning_external_authority_v1'
BEGIN
  SELECT RAISE(ABORT, 'learning_external_authority_operation_delete_forbidden');
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
