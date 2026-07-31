CREATE TABLE lite_runtime_evidence_blobs (
  tenant_id TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL CHECK (
    length(blob_sha256) = 64
    AND blob_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (
    byte_length BETWEEN 0 AND 67108864
  ),
  content_bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, blob_sha256),
  CHECK (length(content_bytes) = byte_length)
);

CREATE TABLE lite_runtime_evidence_uploads (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'state_snapshot', 'feature_vector', 'prompt', 'tool_request',
    'tool_result', 'usage_receipt', 'workspace_diff', 'verifier_input', 'verifier_output',
    'candidate_set', 'training_dataset', 'policy_parameters',
    'policy_calibration', 'procedure_candidate', 'manifest'
  )),
  declared_sha256 TEXT NOT NULL CHECK (
    length(declared_sha256) = 64
    AND declared_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  declared_byte_length INTEGER NOT NULL CHECK (
    declared_byte_length BETWEEN 0 AND 67108864
  ),
  media_type TEXT NOT NULL CHECK (length(CAST(media_type AS BLOB)) BETWEEN 1 AND 255),
  encoding TEXT NOT NULL CHECK (length(CAST(encoding AS BLOB)) BETWEEN 1 AND 64),
  redaction_policy TEXT NOT NULL CHECK (
    length(redaction_policy) BETWEEN 1 AND 256
  ),
  retention_policy TEXT NOT NULL CHECK (
    length(retention_policy) BETWEEN 1 AND 256
  ),
  retention_until TEXT,
  start_operation_id TEXT NOT NULL CHECK (
    length(start_operation_id) BETWEEN 1 AND 256
  ),
  start_request_sha256 TEXT NOT NULL CHECK (
    length(start_request_sha256) = 64
    AND start_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'open', 'finalized', 'aborted', 'expired'
  )),
  next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
  next_byte_offset INTEGER NOT NULL CHECK (
    next_byte_offset >= 0
    AND next_byte_offset <= declared_byte_length
  ),
  terminal_operation_id TEXT,
  terminal_request_sha256 TEXT CHECK (
    terminal_request_sha256 IS NULL OR (
      length(terminal_request_sha256) = 64
      AND terminal_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  finalized_artifact_id TEXT,
  finalize_receipt_sha256 TEXT CHECK (
    finalize_receipt_sha256 IS NULL OR (
      length(finalize_receipt_sha256) = 64
      AND finalize_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  terminal_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  row_version INTEGER NOT NULL CHECK (row_version >= 1),
  PRIMARY KEY (tenant_id, scope, upload_id),
  UNIQUE (tenant_id, scope, start_operation_id),
  CHECK (
    (
      status = 'open'
      AND terminal_operation_id IS NULL
      AND terminal_request_sha256 IS NULL
      AND finalized_artifact_id IS NULL
      AND finalize_receipt_sha256 IS NULL
      AND terminal_reason IS NULL
      AND terminal_at IS NULL
    ) OR (
      status = 'finalized'
      AND terminal_operation_id IS NOT NULL
      AND terminal_request_sha256 IS NOT NULL
      AND finalized_artifact_id IS NOT NULL
      AND finalize_receipt_sha256 IS NOT NULL
      AND terminal_reason IS NULL
      AND terminal_at IS NOT NULL
      AND next_byte_offset = declared_byte_length
    ) OR (
      status IN ('aborted', 'expired')
      AND terminal_operation_id IS NOT NULL
      AND terminal_request_sha256 IS NOT NULL
      AND finalized_artifact_id IS NULL
      AND finalize_receipt_sha256 IS NULL
      AND terminal_reason IS NOT NULL
      AND length(terminal_reason) BETWEEN 1 AND 2048
      AND terminal_at IS NOT NULL
    )
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, finalized_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lite_runtime_evidence_upload_chunks (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (
    byte_length BETWEEN 1 AND 1048576
  ),
  chunk_sha256 TEXT NOT NULL CHECK (
    length(chunk_sha256) = 64
    AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  chunk_bytes BLOB NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, upload_id, sequence),
  UNIQUE (tenant_id, scope, operation_id),
  CHECK (length(chunk_bytes) = byte_length),
  FOREIGN KEY (tenant_id, scope, upload_id)
    REFERENCES lite_runtime_evidence_uploads(tenant_id, scope, upload_id)
    ON DELETE CASCADE
);

CREATE TABLE lite_runtime_evidence_artifacts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'state_snapshot', 'feature_vector', 'prompt', 'tool_request',
    'tool_result', 'usage_receipt', 'workspace_diff', 'verifier_input', 'verifier_output',
    'candidate_set', 'training_dataset', 'policy_parameters',
    'policy_calibration', 'procedure_candidate', 'manifest'
  )),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  storage_ref TEXT NOT NULL CHECK (
    storage_ref = 'sqlite-cas://sha256/' || sha256
  ),
  byte_length INTEGER NOT NULL CHECK (
    byte_length BETWEEN 0 AND 67108864
  ),
  media_type TEXT NOT NULL CHECK (length(CAST(media_type AS BLOB)) BETWEEN 1 AND 255),
  encoding TEXT NOT NULL CHECK (length(CAST(encoding AS BLOB)) BETWEEN 1 AND 64),
  redaction_policy TEXT NOT NULL CHECK (
    length(redaction_policy) BETWEEN 1 AND 256
  ),
  retention_policy TEXT NOT NULL CHECK (
    length(retention_policy) BETWEEN 1 AND 256
  ),
  retention_until TEXT,
  ingest_mode TEXT NOT NULL CHECK (ingest_mode IN (
    'bounded_inline_base64', 'finalized_runtime_upload'
  )),
  source_upload_id TEXT,
  artifact_ref_sha256 TEXT NOT NULL CHECK (
    length(artifact_ref_sha256) = 64
    AND artifact_ref_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, artifact_id),
  UNIQUE (tenant_id, scope, episode_id, artifact_id),
  CHECK (
    (ingest_mode = 'bounded_inline_base64' AND source_upload_id IS NULL)
    OR (
      ingest_mode = 'finalized_runtime_upload'
      AND source_upload_id IS NOT NULL
    )
  ),
  FOREIGN KEY (tenant_id, sha256)
    REFERENCES lite_runtime_evidence_blobs(tenant_id, blob_sha256),
  FOREIGN KEY (tenant_id, scope, source_upload_id)
    REFERENCES lite_runtime_evidence_uploads(
      tenant_id, scope, upload_id
    )
);

CREATE TABLE lite_execution_state_snapshots (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  algorithm_id TEXT NOT NULL CHECK (length(algorithm_id) BETWEEN 1 AND 120),
  algorithm_version TEXT NOT NULL CHECK (
    length(algorithm_version) BETWEEN 1 AND 120
  ),
  state_kind TEXT NOT NULL CHECK (state_kind IN (
    'workspace', 'artifact', 'database', 'service', 'data'
  )),
  environment_digest TEXT NOT NULL CHECK (
    length(environment_digest) = 64
    AND environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64
    AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (
    length(snapshot_sha256) = 64
    AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, episode_id, snapshot_id),
  UNIQUE (tenant_id, scope, artifact_id),
  FOREIGN KEY (tenant_id, scope, episode_id, artifact_id)
    REFERENCES lite_runtime_evidence_artifacts(
      tenant_id, scope, episode_id, artifact_id
    ),
  FOREIGN KEY (tenant_id, scope, episode_id)
    REFERENCES lite_execution_episodes(tenant_id, scope, episode_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lite_execution_episodes (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  episode_contract_version TEXT NOT NULL CHECK (
    length(episode_contract_version) BETWEEN 1 AND 120
  ),
  public_scope TEXT NOT NULL CHECK (length(public_scope) BETWEEN 1 AND 256),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
  task_cluster_id TEXT NOT NULL CHECK (
    length(task_cluster_id) BETWEEN 1 AND 256
  ),
  task_cluster_policy_version TEXT NOT NULL CHECK (
    length(task_cluster_policy_version) BETWEEN 1 AND 120
  ),
  task_envelope_sha256 TEXT NOT NULL CHECK (
    length(task_envelope_sha256) = 64
    AND task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  task_envelope_artifact_id TEXT NOT NULL,
  task_manifest_sha256 TEXT NOT NULL CHECK (
    length(task_manifest_sha256) = 64
    AND task_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  task_manifest_artifact_id TEXT NOT NULL,
  source_task_sha256 TEXT NOT NULL CHECK (
    length(source_task_sha256) = 64
    AND source_task_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_task_artifact_id TEXT NOT NULL,
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  model_config_digest TEXT NOT NULL CHECK (
    length(model_config_digest) = 64
    AND model_config_digest NOT GLOB '*[^0-9a-f]*'
  ),
  model_config_artifact_id TEXT NOT NULL,
  environment_digest TEXT NOT NULL CHECK (
    length(environment_digest) = 64
    AND environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  subject_identity_json TEXT NOT NULL CHECK (
    json_valid(subject_identity_json)
    AND json_type(subject_identity_json) = 'object'
    AND length(CAST(subject_identity_json AS BLOB)) <= 1048576
  ),
  subject_identity_sha256 TEXT NOT NULL CHECK (
    length(subject_identity_sha256) = 64
    AND subject_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  required_verifier_id TEXT NOT NULL CHECK (
    length(required_verifier_id) BETWEEN 1 AND 256
  ),
  required_verifier_definition_sha256 TEXT NOT NULL CHECK (
    length(required_verifier_definition_sha256) = 64
    AND required_verifier_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  initial_state_snapshot_id TEXT NOT NULL,
  budget_max_steps INTEGER NOT NULL CHECK (budget_max_steps >= 1),
  budget_max_tokens INTEGER NOT NULL CHECK (budget_max_tokens >= 1),
  budget_max_cost_micros INTEGER CHECK (
    budget_max_cost_micros IS NULL OR budget_max_cost_micros >= 0
  ),
  budget_deadline_ms INTEGER CHECK (
    budget_deadline_ms IS NULL OR budget_deadline_ms >= 1
  ),
  episode_sha256 TEXT NOT NULL CHECK (
    length(episode_sha256) = 64
    AND episode_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  opened_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, episode_id),
  UNIQUE (tenant_id, scope, run_id),
  FOREIGN KEY (tenant_id, scope, episode_id, initial_state_snapshot_id)
    REFERENCES lite_execution_state_snapshots(
      tenant_id, scope, episode_id, snapshot_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, episode_id, task_envelope_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, task_manifest_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, source_task_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, model_config_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  )
);

CREATE TABLE lite_execution_verifier_invocations (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  verifier_invocation_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL CHECK (
    length(verifier_id) BETWEEN 1 AND 256
  ),
  verifier_definition_sha256 TEXT NOT NULL CHECK (
    length(verifier_definition_sha256) = 64
    AND verifier_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_kind TEXT NOT NULL CHECK (verifier_kind IN (
    'hidden_test', 'environment_assertion', 'database_constraint',
    'independent_executable', 'process_verifier', 'llm_judge_diagnostic'
  )),
  verifier_version TEXT NOT NULL CHECK (
    length(verifier_version) BETWEEN 1 AND 120
  ),
  verifier_issuer_id TEXT NOT NULL CHECK (
    length(verifier_issuer_id) BETWEEN 1 AND 256
  ),
  verifier_runner_instance_id TEXT NOT NULL CHECK (
    length(verifier_runner_instance_id) BETWEEN 1 AND 256
  ),
  launch_authority_kind TEXT NOT NULL CHECK (launch_authority_kind IN (
    'runtime_launched', 'trusted_runner'
  )),
  runtime_reservation_digest TEXT CHECK (
    runtime_reservation_digest IS NULL OR (
      length(runtime_reservation_digest) = 64
      AND runtime_reservation_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  principal_id TEXT,
  key_id TEXT,
  verifier_program_digest TEXT NOT NULL CHECK (
    length(verifier_program_digest) = 64
    AND verifier_program_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_config_digest TEXT NOT NULL CHECK (
    length(verifier_config_digest) = 64
    AND verifier_config_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_environment_digest TEXT NOT NULL CHECK (
    length(verifier_environment_digest) = 64
    AND verifier_environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verified_state_snapshot_id TEXT NOT NULL,
  target_state_snapshot_algorithm_version TEXT NOT NULL CHECK (
    length(target_state_snapshot_algorithm_version) BETWEEN 1 AND 120
  ),
  verifier_input_artifact_id TEXT NOT NULL,
  invocation_sha256 TEXT NOT NULL CHECK (
    length(invocation_sha256) = 64
    AND invocation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  invoked_at TEXT NOT NULL,
  PRIMARY KEY (
    tenant_id, scope, episode_id, verifier_invocation_id
  ),
  UNIQUE (tenant_id, scope, verifier_invocation_id),
  CHECK (
    (
      launch_authority_kind = 'runtime_launched'
      AND runtime_reservation_digest IS NOT NULL
      AND principal_id IS NULL
      AND key_id IS NULL
    ) OR (
      launch_authority_kind = 'trusted_runner'
      AND runtime_reservation_digest IS NULL
      AND principal_id IS NOT NULL
      AND key_id IS NOT NULL
    )
  ),
  FOREIGN KEY (tenant_id, scope, episode_id)
    REFERENCES lite_execution_episodes(tenant_id, scope, episode_id),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verified_state_snapshot_id
  ) REFERENCES lite_execution_state_snapshots(
    tenant_id, scope, episode_id, snapshot_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_input_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  )
);

CREATE TABLE lite_execution_verifier_receipts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  verifier_receipt_id TEXT NOT NULL,
  verifier_invocation_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL CHECK (
    length(verifier_id) BETWEEN 1 AND 256
  ),
  verifier_definition_sha256 TEXT NOT NULL CHECK (
    length(verifier_definition_sha256) = 64
    AND verifier_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_kind TEXT NOT NULL CHECK (verifier_kind IN (
    'hidden_test', 'environment_assertion', 'database_constraint',
    'independent_executable', 'process_verifier', 'llm_judge_diagnostic'
  )),
  verifier_version TEXT NOT NULL CHECK (
    length(verifier_version) BETWEEN 1 AND 120
  ),
  verifier_issuer_id TEXT NOT NULL CHECK (
    length(verifier_issuer_id) BETWEEN 1 AND 256
  ),
  verifier_runner_instance_id TEXT NOT NULL CHECK (
    length(verifier_runner_instance_id) BETWEEN 1 AND 256
  ),
  attestation_kind TEXT NOT NULL CHECK (attestation_kind IN (
    'runtime_launched', 'trusted_runner_signature'
  )),
  runtime_launch_sha256 TEXT CHECK (
    runtime_launch_sha256 IS NULL OR (
      length(runtime_launch_sha256) = 64
      AND runtime_launch_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  principal_id TEXT,
  key_id TEXT,
  signed_payload_digest TEXT CHECK (
    signed_payload_digest IS NULL OR (
      length(signed_payload_digest) = 64
      AND signed_payload_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  signature TEXT,
  verifier_program_digest TEXT NOT NULL CHECK (
    length(verifier_program_digest) = 64
    AND verifier_program_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_config_digest TEXT NOT NULL CHECK (
    length(verifier_config_digest) = 64
    AND verifier_config_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_environment_digest TEXT NOT NULL CHECK (
    length(verifier_environment_digest) = 64
    AND verifier_environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verified_state_snapshot_id TEXT NOT NULL,
  verified_state_snapshot_algorithm_version TEXT NOT NULL CHECK (
    length(verified_state_snapshot_algorithm_version) BETWEEN 1 AND 120
  ),
  verifier_input_artifact_id TEXT NOT NULL,
  verifier_output_artifact_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  execution_exit_code INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'passed', 'failed', 'infrastructure_error', 'inconclusive'
  )),
  infrastructure_failure_reasons_json TEXT NOT NULL CHECK (
    json_valid(infrastructure_failure_reasons_json)
    AND json_type(infrastructure_failure_reasons_json) = 'array'
    AND length(CAST(infrastructure_failure_reasons_json AS BLOB)) <= 131072
    AND (
      (status = 'infrastructure_error'
       AND json_array_length(infrastructure_failure_reasons_json) >= 1)
      OR
      (status != 'infrastructure_error'
       AND json_array_length(infrastructure_failure_reasons_json) = 0)
    )
  ),
  infrastructure_failure_attribution TEXT CHECK (
    (
      status = 'infrastructure_error'
      AND infrastructure_failure_attribution IN (
        'arm_caused', 'arm_independent'
      )
    )
    OR
    (
      status != 'infrastructure_error'
      AND infrastructure_failure_attribution IS NULL
    )
  ),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, episode_id, verifier_receipt_id),
  UNIQUE (tenant_id, scope, verifier_receipt_id),
  UNIQUE (tenant_id, scope, episode_id, verifier_invocation_id),
  CHECK (
    (
      attestation_kind = 'runtime_launched'
      AND runtime_launch_sha256 IS NOT NULL
      AND principal_id IS NULL
      AND key_id IS NULL
      AND signed_payload_digest IS NULL
      AND signature IS NULL
    ) OR (
      attestation_kind = 'trusted_runner_signature'
      AND runtime_launch_sha256 IS NULL
      AND principal_id IS NOT NULL
      AND key_id IS NOT NULL
      AND signed_payload_digest IS NOT NULL
      AND signature IS NOT NULL
      AND length(signature) BETWEEN 1 AND 16384
    )
  ),
  CHECK (
    (status = 'passed' AND execution_exit_code = 0)
    OR (status = 'failed' AND execution_exit_code IS NOT NULL)
    OR status IN ('infrastructure_error', 'inconclusive')
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_invocation_id
  ) REFERENCES lite_execution_verifier_invocations(
    tenant_id, scope, episode_id, verifier_invocation_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verified_state_snapshot_id
  ) REFERENCES lite_execution_state_snapshots(
    tenant_id, scope, episode_id, snapshot_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_input_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_output_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  )
);

CREATE TABLE lite_execution_episode_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_sequence INTEGER NOT NULL CHECK (episode_sequence >= 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'episode_started', 'decision_committed', 'action_observed',
    'verifier_recorded', 'episode_closed'
  )),
  operation_kind TEXT NOT NULL CHECK (
    length(operation_kind) BETWEEN 1 AND 120
  ),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_event_sha256 TEXT CHECK (
    previous_event_sha256 IS NULL OR (
      length(previous_event_sha256) = 64
      AND previous_event_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  event_sha256 TEXT NOT NULL CHECK (
    length(event_sha256) = 64
    AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND length(CAST(payload_json AS BLOB)) <= 2097152
  ),
  decision_id TEXT,
  action_id TEXT,
  state_before_snapshot_id TEXT,
  state_after_snapshot_id TEXT,
  action_mutation INTEGER CHECK (
    action_mutation IS NULL OR action_mutation IN (0, 1)
  ),
  verifier_receipt_id TEXT,
  reward_id TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (tenant_id, scope, event_id),
  UNIQUE (tenant_id, scope, episode_id, event_id),
  UNIQUE (tenant_id, scope, episode_id, episode_sequence),
  UNIQUE (tenant_id, scope, operation_kind, operation_id),
  CHECK (
    (
      event_kind = 'episode_started'
      AND episode_sequence = 0
      AND previous_event_sha256 IS NULL
      AND decision_id IS NULL
      AND action_id IS NULL
      AND state_before_snapshot_id IS NULL
      AND state_after_snapshot_id IS NULL
      AND action_mutation IS NULL
      AND verifier_receipt_id IS NULL
      AND reward_id IS NULL
    ) OR (
      event_kind = 'decision_committed'
      AND episode_sequence > 0
      AND previous_event_sha256 IS NOT NULL
      AND decision_id IS NOT NULL
      AND action_id IS NULL
      AND state_before_snapshot_id IS NULL
      AND state_after_snapshot_id IS NULL
      AND action_mutation IS NULL
      AND verifier_receipt_id IS NULL
      AND reward_id IS NULL
    ) OR (
      event_kind = 'action_observed'
      AND episode_sequence > 0
      AND previous_event_sha256 IS NOT NULL
      AND decision_id IS NULL
      AND action_id IS NOT NULL
      AND state_before_snapshot_id IS NOT NULL
      AND state_after_snapshot_id IS NOT NULL
      AND action_mutation IS NOT NULL
      AND (
        (
          action_mutation = 1
          AND state_before_snapshot_id <> state_after_snapshot_id
        )
        OR (
          action_mutation = 0
          AND state_before_snapshot_id = state_after_snapshot_id
        )
      )
      AND verifier_receipt_id IS NULL
      AND reward_id IS NULL
    ) OR (
      event_kind = 'verifier_recorded'
      AND episode_sequence > 0
      AND previous_event_sha256 IS NOT NULL
      AND decision_id IS NULL
      AND action_id IS NULL
      AND state_before_snapshot_id IS NULL
      AND state_after_snapshot_id IS NULL
      AND action_mutation IS NULL
      AND verifier_receipt_id IS NOT NULL
      AND reward_id IS NULL
    ) OR (
      event_kind = 'episode_closed'
      AND episode_sequence > 0
      AND previous_event_sha256 IS NOT NULL
      AND decision_id IS NULL
      AND action_id IS NULL
      AND state_before_snapshot_id IS NULL
      AND state_after_snapshot_id IS NULL
      AND action_mutation IS NULL
      AND verifier_receipt_id IS NULL
      AND reward_id IS NOT NULL
    )
  ),
  FOREIGN KEY (tenant_id, scope, episode_id)
    REFERENCES lite_execution_episodes(tenant_id, scope, episode_id),
  FOREIGN KEY (
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) REFERENCES lite_runtime_write_operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, episode_id, state_before_snapshot_id
  ) REFERENCES lite_execution_state_snapshots(
    tenant_id, scope, episode_id, snapshot_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, state_after_snapshot_id
  ) REFERENCES lite_execution_state_snapshots(
    tenant_id, scope, episode_id, snapshot_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_receipt_id
  ) REFERENCES lite_execution_verifier_receipts(
    tenant_id, scope, episode_id, verifier_receipt_id
  ),
  FOREIGN KEY (tenant_id, scope, episode_id, reward_id)
    REFERENCES lite_execution_episode_rewards(
      tenant_id, scope, episode_id, reward_id
    )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lite_execution_episode_rewards (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  close_event_id TEXT NOT NULL,
  reward_contract_version TEXT NOT NULL CHECK (
    length(reward_contract_version) BETWEEN 1 AND 120
  ),
  verified_success INTEGER CHECK (
    verified_success IS NULL OR verified_success IN (0, 1)
  ),
  outcome_class TEXT NOT NULL CHECK (outcome_class IN (
    'verified_pass', 'verified_failure', 'arm_caused_incomplete',
    'arm_independent_infrastructure', 'diagnostic_only'
  )),
  reward_authority TEXT NOT NULL CHECK (reward_authority IN (
    'deterministic', 'independent_executable', 'process',
    'protocol_itt_failure', 'diagnostic_only', 'missing'
  )),
  final_state_snapshot_id TEXT,
  verifier_receipt_id TEXT,
  token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  token_usage_authority TEXT NOT NULL CHECK (token_usage_authority IN (
    'provider_receipt', 'trusted_adapter_signature', 'unavailable'
  )),
  token_usage_artifact_id TEXT,
  tool_call_count INTEGER NOT NULL CHECK (tool_call_count >= 0),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  outcome_reasons_json TEXT NOT NULL CHECK (
    json_valid(outcome_reasons_json)
    AND json_type(outcome_reasons_json) = 'array'
    AND length(CAST(outcome_reasons_json AS BLOB)) <= 65536
  ),
  contamination_json TEXT NOT NULL CHECK (
    json_valid(contamination_json)
    AND json_type(contamination_json) = 'array'
    AND length(CAST(contamination_json AS BLOB)) <= 65536
  ),
  reward_sha256 TEXT NOT NULL CHECK (
    length(reward_sha256) = 64
    AND reward_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, episode_id, reward_id),
  UNIQUE (tenant_id, scope, episode_id),
  UNIQUE (tenant_id, scope, episode_id, close_event_id),
  CHECK (
    (
      outcome_class = 'verified_pass'
      AND verified_success = 1
      AND reward_authority IN (
        'deterministic', 'independent_executable', 'process'
      )
      AND final_state_snapshot_id IS NOT NULL
      AND verifier_receipt_id IS NOT NULL
    ) OR (
      outcome_class = 'verified_failure'
      AND verified_success = 0
      AND reward_authority IN (
        'deterministic', 'independent_executable', 'process'
      )
      AND final_state_snapshot_id IS NOT NULL
      AND verifier_receipt_id IS NOT NULL
    ) OR (
      outcome_class = 'arm_caused_incomplete'
      AND verified_success = 0
      AND reward_authority = 'protocol_itt_failure'
      AND json_array_length(outcome_reasons_json) > 0
    ) OR (
      outcome_class = 'arm_independent_infrastructure'
      AND verified_success IS NULL
      AND reward_authority = 'missing'
      AND json_array_length(outcome_reasons_json) > 0
    ) OR (
      outcome_class = 'diagnostic_only'
      AND verified_success IS NULL
      AND reward_authority = 'diagnostic_only'
      AND verifier_receipt_id IS NOT NULL
    )
  ),
  CHECK (
    (
      token_usage_authority = 'unavailable'
      AND token_count IS NULL
      AND token_usage_artifact_id IS NULL
    )
    OR (
      token_usage_authority IN (
        'provider_receipt', 'trusted_adapter_signature'
      )
      AND token_count IS NOT NULL
      AND token_usage_artifact_id IS NOT NULL
    )
  ),
  FOREIGN KEY (tenant_id, scope, episode_id)
    REFERENCES lite_execution_episodes(tenant_id, scope, episode_id),
  FOREIGN KEY (
    tenant_id, scope, episode_id, final_state_snapshot_id
  ) REFERENCES lite_execution_state_snapshots(
    tenant_id, scope, episode_id, snapshot_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_receipt_id
  ) REFERENCES lite_execution_verifier_receipts(
    tenant_id, scope, episode_id, verifier_receipt_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, token_usage_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  ),
  FOREIGN KEY (tenant_id, scope, episode_id, close_event_id)
    REFERENCES lite_execution_episode_events(
      tenant_id, scope, episode_id, event_id
    )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lite_execution_event_artifact_refs (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  reference_kind TEXT NOT NULL CHECK (reference_kind IN (
    'payload', 'feature_vector', 'prompt', 'tool_request', 'tool_result',
    'workspace_diff', 'state_snapshot', 'verifier_input',
    'verifier_output', 'candidate_set', 'policy_artifact', 'manifest',
    'usage_receipt'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    tenant_id, scope, event_id, artifact_id, reference_kind
  ),
  FOREIGN KEY (tenant_id, scope, episode_id, event_id)
    REFERENCES lite_execution_episode_events(
      tenant_id, scope, episode_id, event_id
    ),
  FOREIGN KEY (tenant_id, scope, episode_id, artifact_id)
    REFERENCES lite_runtime_evidence_artifacts(
      tenant_id, scope, episode_id, artifact_id
    )
);

CREATE TABLE lite_execution_learning_links (
  tenant_id TEXT NOT NULL,
  execution_scope TEXT NOT NULL,
  learning_scope TEXT NOT NULL,
  link_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind IN (
    'exposure', 'feedback', 'effect'
  )),
  execution_episode_id TEXT NOT NULL,
  execution_event_id TEXT NOT NULL,
  learning_episode_id TEXT NOT NULL,
  learning_event_id TEXT NOT NULL,
  link_sha256 TEXT NOT NULL CHECK (
    length(link_sha256) = 64
    AND link_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, execution_scope, link_id),
  UNIQUE (tenant_id, learning_scope, learning_event_id),
  FOREIGN KEY (
    tenant_id, execution_scope, execution_episode_id, execution_event_id
  ) REFERENCES lite_execution_episode_events(
    tenant_id, scope, episode_id, event_id
  ),
  FOREIGN KEY (tenant_id, learning_scope, learning_event_id)
    REFERENCES lite_learning_episode_events(tenant_id, scope, event_id)
);

CREATE INDEX idx_lite_runtime_evidence_blobs_created
  ON lite_runtime_evidence_blobs(tenant_id, created_at, blob_sha256);

CREATE UNIQUE INDEX idx_lite_runtime_write_operations_execution_binding
  ON lite_runtime_write_operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  );

CREATE INDEX idx_lite_runtime_evidence_uploads_episode_created
  ON lite_runtime_evidence_uploads(
    tenant_id, scope, episode_id, created_at, upload_id
  );

CREATE INDEX idx_lite_runtime_evidence_uploads_cleanup
  ON lite_runtime_evidence_uploads(
    status, expires_at, updated_at, upload_id
  );

CREATE UNIQUE INDEX idx_lite_runtime_evidence_uploads_terminal_operation
  ON lite_runtime_evidence_uploads(
    tenant_id, scope, terminal_operation_id
  )
  WHERE terminal_operation_id IS NOT NULL;

CREATE INDEX idx_lite_runtime_evidence_upload_chunks_offset
  ON lite_runtime_evidence_upload_chunks(
    tenant_id, scope, upload_id, byte_offset, sequence
  );

CREATE INDEX idx_lite_runtime_evidence_artifacts_episode_created
  ON lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, created_at, artifact_id
  );

CREATE INDEX idx_lite_runtime_evidence_artifacts_blob
  ON lite_runtime_evidence_artifacts(tenant_id, sha256, artifact_id);

CREATE UNIQUE INDEX idx_lite_runtime_evidence_artifacts_source_upload
  ON lite_runtime_evidence_artifacts(
    tenant_id, scope, source_upload_id
  )
  WHERE source_upload_id IS NOT NULL;

CREATE INDEX idx_lite_execution_state_snapshots_episode_captured
  ON lite_execution_state_snapshots(
    tenant_id, scope, episode_id, captured_at, snapshot_id
  );

CREATE INDEX idx_lite_execution_episodes_cluster_opened
  ON lite_execution_episodes(
    tenant_id, scope, task_cluster_id, opened_at, episode_id
  );

CREATE INDEX idx_lite_execution_episode_events_replay
  ON lite_execution_episode_events(
    tenant_id, scope, episode_id, episode_sequence, row_id
  );

CREATE UNIQUE INDEX idx_lite_execution_episode_events_one_start
  ON lite_execution_episode_events(tenant_id, scope, episode_id)
  WHERE event_kind = 'episode_started';

CREATE UNIQUE INDEX idx_lite_execution_episode_events_one_close
  ON lite_execution_episode_events(tenant_id, scope, episode_id)
  WHERE event_kind = 'episode_closed';

CREATE UNIQUE INDEX idx_lite_execution_episode_events_decision_identity
  ON lite_execution_episode_events(
    tenant_id, scope, episode_id, decision_id
  )
  WHERE decision_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lite_execution_episode_events_action_identity
  ON lite_execution_episode_events(
    tenant_id, scope, episode_id, action_id
  )
  WHERE action_id IS NOT NULL;

CREATE INDEX idx_lite_execution_verifier_invocations_episode
  ON lite_execution_verifier_invocations(
    tenant_id, scope, episode_id, invoked_at, verifier_invocation_id
  );

CREATE INDEX idx_lite_execution_verifier_receipts_episode_status
  ON lite_execution_verifier_receipts(
    tenant_id, scope, episode_id, status, completed_at, verifier_receipt_id
  );

CREATE INDEX idx_lite_execution_episode_rewards_outcome_created
  ON lite_execution_episode_rewards(
    tenant_id, scope, outcome_class, created_at, reward_id
  );

CREATE UNIQUE INDEX idx_lite_execution_episode_rewards_receipt
  ON lite_execution_episode_rewards(
    tenant_id, scope, verifier_receipt_id
  )
  WHERE verifier_receipt_id IS NOT NULL;

CREATE INDEX idx_lite_execution_event_artifact_refs_artifact
  ON lite_execution_event_artifact_refs(
    tenant_id, scope, artifact_id, event_id
  );

CREATE INDEX idx_lite_execution_learning_links_execution
  ON lite_execution_learning_links(
    tenant_id, execution_scope, execution_episode_id, execution_event_id
  );

CREATE INDEX idx_lite_execution_learning_links_learning
  ON lite_execution_learning_links(
    tenant_id, learning_scope, learning_episode_id, learning_event_id
  );

CREATE TRIGGER trg_lite_runtime_evidence_blobs_no_update
BEFORE UPDATE ON lite_runtime_evidence_blobs
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_blob_update_forbidden');
END;

CREATE TRIGGER trg_lite_runtime_evidence_blobs_delete_referenced
BEFORE DELETE ON lite_runtime_evidence_blobs
WHEN EXISTS (
  SELECT 1
  FROM lite_runtime_evidence_artifacts AS artifact
  WHERE artifact.tenant_id = OLD.tenant_id
    AND artifact.sha256 = OLD.blob_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_blob_is_referenced');
END;

CREATE TRIGGER trg_lite_runtime_evidence_upload_chunks_insert_guard
BEFORE INSERT ON lite_runtime_evidence_upload_chunks
WHEN NOT EXISTS (
  SELECT 1
  FROM lite_runtime_evidence_uploads AS upload
  WHERE upload.tenant_id = NEW.tenant_id
    AND upload.scope = NEW.scope
    AND upload.upload_id = NEW.upload_id
    AND upload.status = 'open'
    AND upload.next_sequence = NEW.sequence
    AND upload.next_byte_offset = NEW.byte_offset
    AND NEW.byte_offset + NEW.byte_length <= upload.declared_byte_length
)
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_upload_chunk_not_next');
END;

CREATE TRIGGER trg_lite_runtime_evidence_upload_chunks_no_update
BEFORE UPDATE ON lite_runtime_evidence_upload_chunks
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_upload_chunk_update_forbidden');
END;

CREATE TRIGGER trg_lite_runtime_evidence_upload_chunks_open_delete_forbidden
BEFORE DELETE ON lite_runtime_evidence_upload_chunks
WHEN EXISTS (
  SELECT 1
  FROM lite_runtime_evidence_uploads AS upload
  WHERE upload.tenant_id = OLD.tenant_id
    AND upload.scope = OLD.scope
    AND upload.upload_id = OLD.upload_id
    AND upload.status = 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_open_upload_chunk_delete_forbidden');
END;

CREATE TRIGGER trg_lite_runtime_evidence_uploads_update_guard
BEFORE UPDATE ON lite_runtime_evidence_uploads
WHEN OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.scope IS NOT NEW.scope
  OR OLD.upload_id IS NOT NEW.upload_id
  OR OLD.episode_id IS NOT NEW.episode_id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.declared_sha256 IS NOT NEW.declared_sha256
  OR OLD.declared_byte_length IS NOT NEW.declared_byte_length
  OR OLD.media_type IS NOT NEW.media_type
  OR OLD.encoding IS NOT NEW.encoding
  OR OLD.redaction_policy IS NOT NEW.redaction_policy
  OR OLD.retention_policy IS NOT NEW.retention_policy
  OR OLD.retention_until IS NOT NEW.retention_until
  OR OLD.start_operation_id IS NOT NEW.start_operation_id
  OR OLD.start_request_sha256 IS NOT NEW.start_request_sha256
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.status <> 'open'
  OR NEW.row_version <> OLD.row_version + 1
  OR NEW.next_sequence < OLD.next_sequence
  OR NEW.next_byte_offset < OLD.next_byte_offset
  OR NEW.next_sequence <> (
    SELECT count(*)
    FROM lite_runtime_evidence_upload_chunks AS chunk
    WHERE chunk.tenant_id = OLD.tenant_id
      AND chunk.scope = OLD.scope
      AND chunk.upload_id = OLD.upload_id
  )
  OR NEW.next_byte_offset <> COALESCE((
    SELECT sum(chunk.byte_length)
    FROM lite_runtime_evidence_upload_chunks AS chunk
    WHERE chunk.tenant_id = OLD.tenant_id
      AND chunk.scope = OLD.scope
      AND chunk.upload_id = OLD.upload_id
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_upload_update_invalid');
END;

CREATE TRIGGER trg_lite_runtime_evidence_uploads_finalize_guard
BEFORE UPDATE ON lite_runtime_evidence_uploads
WHEN NEW.status = 'finalized'
  AND NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.finalized_artifact_id
      AND artifact.kind = NEW.kind
      AND artifact.sha256 = NEW.declared_sha256
      AND artifact.byte_length = NEW.declared_byte_length
      AND artifact.media_type = NEW.media_type
      AND artifact.encoding = NEW.encoding
      AND artifact.redaction_policy = NEW.redaction_policy
      AND artifact.retention_policy = NEW.retention_policy
      AND artifact.retention_until IS NEW.retention_until
      AND artifact.ingest_mode = 'finalized_runtime_upload'
      AND artifact.source_upload_id = NEW.upload_id
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_upload_finalize_artifact_invalid');
END;

CREATE TRIGGER trg_lite_runtime_evidence_uploads_open_delete_forbidden
BEFORE DELETE ON lite_runtime_evidence_uploads
WHEN OLD.status = 'open'
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_open_upload_delete_forbidden');
END;

CREATE TRIGGER trg_lite_runtime_evidence_artifacts_insert_guard
BEFORE INSERT ON lite_runtime_evidence_artifacts
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_blobs AS blob
    WHERE blob.tenant_id = NEW.tenant_id
      AND blob.blob_sha256 = NEW.sha256
      AND blob.byte_length = NEW.byte_length
  )
  OR (
    NEW.ingest_mode = 'finalized_runtime_upload'
    AND NOT EXISTS (
      SELECT 1
      FROM lite_runtime_evidence_uploads AS upload
      WHERE upload.tenant_id = NEW.tenant_id
        AND upload.scope = NEW.scope
        AND upload.upload_id = NEW.source_upload_id
        AND upload.episode_id = NEW.episode_id
        AND upload.kind = NEW.kind
        AND upload.declared_sha256 = NEW.sha256
        AND upload.declared_byte_length = NEW.byte_length
        AND upload.media_type = NEW.media_type
        AND upload.encoding = NEW.encoding
        AND upload.redaction_policy = NEW.redaction_policy
        AND upload.retention_policy = NEW.retention_policy
        AND upload.retention_until IS NEW.retention_until
        AND upload.status = 'open'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_artifact_source_invalid');
END;

CREATE TRIGGER trg_lite_runtime_evidence_artifacts_no_update
BEFORE UPDATE ON lite_runtime_evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_artifact_update_forbidden');
END;

CREATE TRIGGER trg_lite_runtime_evidence_artifacts_delete_referenced
BEFORE DELETE ON lite_runtime_evidence_artifacts
WHEN EXISTS (
    SELECT 1 FROM lite_execution_state_snapshots AS snapshot
    WHERE snapshot.tenant_id = OLD.tenant_id
      AND snapshot.scope = OLD.scope
      AND snapshot.artifact_id = OLD.artifact_id
  )
  OR EXISTS (
    SELECT 1 FROM lite_execution_event_artifact_refs AS reference
    WHERE reference.tenant_id = OLD.tenant_id
      AND reference.scope = OLD.scope
      AND reference.artifact_id = OLD.artifact_id
  )
  OR EXISTS (
    SELECT 1 FROM lite_execution_verifier_invocations AS invocation
    WHERE invocation.tenant_id = OLD.tenant_id
      AND invocation.scope = OLD.scope
      AND invocation.verifier_input_artifact_id = OLD.artifact_id
  )
  OR EXISTS (
    SELECT 1 FROM lite_execution_verifier_receipts AS receipt
    WHERE receipt.tenant_id = OLD.tenant_id
      AND receipt.scope = OLD.scope
      AND (
        receipt.verifier_input_artifact_id = OLD.artifact_id
        OR receipt.verifier_output_artifact_id = OLD.artifact_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'runtime_evidence_artifact_is_referenced');
END;

CREATE TRIGGER trg_lite_execution_state_snapshots_insert_guard
BEFORE INSERT ON lite_execution_state_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM lite_runtime_evidence_artifacts AS artifact
  WHERE artifact.tenant_id = NEW.tenant_id
    AND artifact.scope = NEW.scope
    AND artifact.episode_id = NEW.episode_id
    AND artifact.artifact_id = NEW.artifact_id
    AND artifact.kind = 'state_snapshot'
    AND artifact.sha256 = NEW.content_digest
)
  OR EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS closed
    WHERE closed.tenant_id = NEW.tenant_id
      AND closed.scope = NEW.scope
      AND closed.episode_id = NEW.episode_id
      AND closed.event_kind = 'episode_closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_state_snapshot_artifact_invalid');
END;

CREATE TRIGGER trg_lite_execution_state_snapshots_no_update
BEFORE UPDATE ON lite_execution_state_snapshots
BEGIN
  SELECT RAISE(ABORT, 'execution_state_snapshot_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_state_snapshots_no_delete
BEFORE DELETE ON lite_execution_state_snapshots
BEGIN
  SELECT RAISE(ABORT, 'execution_state_snapshot_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_episodes_insert_guard
BEFORE INSERT ON lite_execution_episodes
WHEN NOT EXISTS (
  SELECT 1
  FROM lite_execution_state_snapshots AS snapshot
  WHERE snapshot.tenant_id = NEW.tenant_id
    AND snapshot.scope = NEW.scope
    AND snapshot.episode_id = NEW.episode_id
    AND snapshot.snapshot_id = NEW.initial_state_snapshot_id
    AND snapshot.environment_digest = NEW.environment_digest
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.task_envelope_artifact_id
      AND artifact.kind = 'manifest'
      AND artifact.sha256 = NEW.task_envelope_sha256
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.task_manifest_artifact_id
      AND artifact.kind = 'manifest'
      AND artifact.sha256 = NEW.task_manifest_sha256
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.source_task_artifact_id
      AND artifact.kind = 'prompt'
      AND artifact.sha256 = NEW.source_task_sha256
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.model_config_artifact_id
      AND artifact.kind = 'manifest'
      AND artifact.sha256 = NEW.model_config_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_initial_state_invalid');
END;

CREATE TRIGGER trg_lite_execution_episodes_no_update
BEFORE UPDATE ON lite_execution_episodes
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_episodes_no_delete
BEFORE DELETE ON lite_execution_episodes
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_verifier_invocations_insert_guard
BEFORE INSERT ON lite_execution_verifier_invocations
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_episodes AS episode
    WHERE episode.tenant_id = NEW.tenant_id
      AND episode.scope = NEW.scope
      AND episode.episode_id = NEW.episode_id
      AND episode.required_verifier_id = NEW.verifier_id
      AND episode.required_verifier_definition_sha256 =
        NEW.verifier_definition_sha256
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_execution_state_snapshots AS snapshot
    WHERE snapshot.tenant_id = NEW.tenant_id
      AND snapshot.scope = NEW.scope
      AND snapshot.episode_id = NEW.episode_id
      AND snapshot.snapshot_id = NEW.verified_state_snapshot_id
      AND snapshot.algorithm_version =
        NEW.target_state_snapshot_algorithm_version
      AND snapshot.environment_digest = NEW.verifier_environment_digest
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.verifier_input_artifact_id
      AND artifact.kind = 'verifier_input'
  )
  OR EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS closed
    WHERE closed.tenant_id = NEW.tenant_id
      AND closed.scope = NEW.scope
      AND closed.episode_id = NEW.episode_id
      AND closed.event_kind = 'episode_closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_invocation_binding_invalid');
END;

CREATE TRIGGER trg_lite_execution_verifier_invocations_no_update
BEFORE UPDATE ON lite_execution_verifier_invocations
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_invocation_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_verifier_invocations_no_delete
BEFORE DELETE ON lite_execution_verifier_invocations
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_invocation_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_verifier_receipts_insert_guard
BEFORE INSERT ON lite_execution_verifier_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_verifier_invocations AS invocation
    WHERE invocation.tenant_id = NEW.tenant_id
      AND invocation.scope = NEW.scope
      AND invocation.episode_id = NEW.episode_id
      AND invocation.verifier_invocation_id = NEW.verifier_invocation_id
      AND invocation.verifier_id = NEW.verifier_id
      AND invocation.verifier_definition_sha256 =
        NEW.verifier_definition_sha256
      AND invocation.verifier_kind = NEW.verifier_kind
      AND invocation.verifier_version = NEW.verifier_version
      AND invocation.verifier_issuer_id = NEW.verifier_issuer_id
      AND invocation.verifier_runner_instance_id =
        NEW.verifier_runner_instance_id
      AND (
        (
          invocation.launch_authority_kind = 'runtime_launched'
          AND NEW.attestation_kind = 'runtime_launched'
        )
        OR (
          invocation.launch_authority_kind = 'trusted_runner'
          AND NEW.attestation_kind = 'trusted_runner_signature'
        )
      )
      AND invocation.principal_id IS NEW.principal_id
      AND invocation.key_id IS NEW.key_id
      AND invocation.verifier_program_digest =
        NEW.verifier_program_digest
      AND invocation.verifier_config_digest = NEW.verifier_config_digest
      AND invocation.verifier_environment_digest =
        NEW.verifier_environment_digest
      AND invocation.verified_state_snapshot_id =
        NEW.verified_state_snapshot_id
      AND invocation.target_state_snapshot_algorithm_version =
        NEW.verified_state_snapshot_algorithm_version
      AND invocation.verifier_input_artifact_id =
        NEW.verifier_input_artifact_id
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_execution_state_snapshots AS snapshot
    WHERE snapshot.tenant_id = NEW.tenant_id
      AND snapshot.scope = NEW.scope
      AND snapshot.episode_id = NEW.episode_id
      AND snapshot.snapshot_id = NEW.verified_state_snapshot_id
      AND snapshot.algorithm_version =
        NEW.verified_state_snapshot_algorithm_version
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.verifier_output_artifact_id
      AND artifact.kind = 'verifier_output'
  )
  OR EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS closed
    WHERE closed.tenant_id = NEW.tenant_id
      AND closed.scope = NEW.scope
      AND closed.episode_id = NEW.episode_id
      AND closed.event_kind = 'episode_closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_receipt_binding_invalid');
END;

CREATE TRIGGER trg_lite_execution_verifier_receipts_no_update
BEFORE UPDATE ON lite_execution_verifier_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_receipt_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_verifier_receipts_no_delete
BEFORE DELETE ON lite_execution_verifier_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_receipt_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_episode_events_sequence_guard
BEFORE INSERT ON lite_execution_episode_events
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_episodes AS episode
    WHERE episode.tenant_id = NEW.tenant_id
      AND episode.scope = NEW.scope
      AND episode.episode_id = NEW.episode_id
  )
  OR EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS closed
    WHERE closed.tenant_id = NEW.tenant_id
      AND closed.scope = NEW.scope
      AND closed.episode_id = NEW.episode_id
      AND closed.event_kind = 'episode_closed'
  )
  OR (
    NEW.episode_sequence = 0
    AND EXISTS (
      SELECT 1
      FROM lite_execution_episode_events AS prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.scope = NEW.scope
        AND prior.episode_id = NEW.episode_id
    )
  )
  OR (
    NEW.episode_sequence > 0
    AND NOT EXISTS (
      SELECT 1
      FROM lite_execution_episode_events AS prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.scope = NEW.scope
        AND prior.episode_id = NEW.episode_id
        AND prior.episode_sequence = NEW.episode_sequence - 1
        AND prior.event_sha256 = NEW.previous_event_sha256
        AND NOT EXISTS (
          SELECT 1
          FROM lite_execution_episode_events AS later
          WHERE later.tenant_id = NEW.tenant_id
            AND later.scope = NEW.scope
            AND later.episode_id = NEW.episode_id
            AND later.episode_sequence > prior.episode_sequence
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_event_sequence_invalid');
END;

CREATE TRIGGER trg_lite_execution_episode_events_closed_guard
BEFORE INSERT ON lite_execution_episode_events
WHEN EXISTS (
  SELECT 1
  FROM lite_execution_episode_events AS closed
  WHERE closed.tenant_id = NEW.tenant_id
    AND closed.scope = NEW.scope
    AND closed.episode_id = NEW.episode_id
    AND closed.event_kind = 'episode_closed'
)
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_already_closed');
END;

CREATE TRIGGER trg_lite_execution_episode_events_action_state_guard
BEFORE INSERT ON lite_execution_episode_events
WHEN NEW.event_kind = 'action_observed'
  AND (
    NEW.state_before_snapshot_id IS NOT COALESCE((
      SELECT prior.state_after_snapshot_id
      FROM lite_execution_episode_events AS prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.scope = NEW.scope
        AND prior.episode_id = NEW.episode_id
        AND prior.event_kind = 'action_observed'
      ORDER BY prior.episode_sequence DESC
      LIMIT 1
    ), (
      SELECT episode.initial_state_snapshot_id
      FROM lite_execution_episodes AS episode
      WHERE episode.tenant_id = NEW.tenant_id
        AND episode.scope = NEW.scope
        AND episode.episode_id = NEW.episode_id
    ))
    OR NOT EXISTS (
      SELECT 1
      FROM lite_execution_state_snapshots AS snapshot
      WHERE snapshot.tenant_id = NEW.tenant_id
        AND snapshot.scope = NEW.scope
        AND snapshot.episode_id = NEW.episode_id
        AND snapshot.snapshot_id = NEW.state_after_snapshot_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_action_state_transition_invalid');
END;

CREATE TRIGGER trg_lite_execution_episode_events_verifier_state_guard
BEFORE INSERT ON lite_execution_episode_events
WHEN NEW.event_kind = 'verifier_recorded'
  AND NOT EXISTS (
    SELECT 1
    FROM lite_execution_verifier_receipts AS receipt
    WHERE receipt.tenant_id = NEW.tenant_id
      AND receipt.scope = NEW.scope
      AND receipt.episode_id = NEW.episode_id
      AND receipt.verifier_receipt_id = NEW.verifier_receipt_id
      AND receipt.verified_state_snapshot_id IS COALESCE((
        SELECT prior.state_after_snapshot_id
        FROM lite_execution_episode_events AS prior
        WHERE prior.tenant_id = NEW.tenant_id
          AND prior.scope = NEW.scope
          AND prior.episode_id = NEW.episode_id
          AND prior.event_kind = 'action_observed'
        ORDER BY prior.episode_sequence DESC
        LIMIT 1
      ), (
        SELECT episode.initial_state_snapshot_id
        FROM lite_execution_episodes AS episode
        WHERE episode.tenant_id = NEW.tenant_id
          AND episode.scope = NEW.scope
          AND episode.episode_id = NEW.episode_id
      ))
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_verifier_receipt_state_stale');
END;

CREATE TRIGGER trg_lite_execution_episode_events_close_guard
BEFORE INSERT ON lite_execution_episode_events
WHEN NEW.event_kind = 'episode_closed'
  AND NOT EXISTS (
    SELECT 1
    FROM lite_execution_episode_rewards AS reward
    WHERE reward.tenant_id = NEW.tenant_id
      AND reward.scope = NEW.scope
      AND reward.episode_id = NEW.episode_id
      AND reward.reward_id = NEW.reward_id
      AND reward.close_event_id = NEW.event_id
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_close_reward_invalid');
END;

CREATE TRIGGER trg_lite_execution_episode_events_no_update
BEFORE UPDATE ON lite_execution_episode_events
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_event_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_episode_events_no_delete
BEFORE DELETE ON lite_execution_episode_events
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_event_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_episode_rewards_insert_guard
BEFORE INSERT ON lite_execution_episode_rewards
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_episodes AS episode
    WHERE episode.tenant_id = NEW.tenant_id
      AND episode.scope = NEW.scope
      AND episode.episode_id = NEW.episode_id
  )
  OR EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS closed
    WHERE closed.tenant_id = NEW.tenant_id
      AND closed.scope = NEW.scope
      AND closed.episode_id = NEW.episode_id
      AND closed.event_kind = 'episode_closed'
  )
  OR (
    NEW.final_state_snapshot_id IS NOT NULL
    AND NEW.final_state_snapshot_id IS NOT COALESCE((
      SELECT prior.state_after_snapshot_id
      FROM lite_execution_episode_events AS prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.scope = NEW.scope
        AND prior.episode_id = NEW.episode_id
        AND prior.event_kind = 'action_observed'
      ORDER BY prior.episode_sequence DESC
      LIMIT 1
    ), (
      SELECT episode.initial_state_snapshot_id
      FROM lite_execution_episodes AS episode
      WHERE episode.tenant_id = NEW.tenant_id
        AND episode.scope = NEW.scope
        AND episode.episode_id = NEW.episode_id
    ))
  )
  OR (
    NEW.verifier_receipt_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM lite_execution_verifier_receipts AS receipt
      WHERE receipt.tenant_id = NEW.tenant_id
        AND receipt.scope = NEW.scope
        AND receipt.episode_id = NEW.episode_id
        AND receipt.verifier_receipt_id = NEW.verifier_receipt_id
        AND (
          NEW.final_state_snapshot_id IS NULL
          OR receipt.verified_state_snapshot_id =
            NEW.final_state_snapshot_id
        )
        AND (
          (
            NEW.outcome_class = 'verified_pass'
            AND receipt.status = 'passed'
          )
          OR (
            NEW.outcome_class = 'verified_failure'
            AND receipt.status = 'failed'
          )
          OR NEW.outcome_class NOT IN (
            'verified_pass', 'verified_failure'
          )
        )
        AND (
          NEW.reward_authority = 'diagnostic_only'
          OR (
            NEW.reward_authority = 'deterministic'
            AND receipt.verifier_kind IN (
              'hidden_test', 'environment_assertion',
              'database_constraint'
            )
          )
          OR (
            NEW.reward_authority = 'independent_executable'
            AND receipt.verifier_kind = 'independent_executable'
          )
          OR (
            NEW.reward_authority = 'process'
            AND receipt.verifier_kind = 'process_verifier'
          )
          OR NEW.reward_authority IN (
            'protocol_itt_failure', 'missing'
          )
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_reward_binding_invalid');
END;

CREATE TRIGGER trg_lite_execution_episode_rewards_no_update
BEFORE UPDATE ON lite_execution_episode_rewards
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_reward_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_episode_rewards_no_delete
BEFORE DELETE ON lite_execution_episode_rewards
BEGIN
  SELECT RAISE(ABORT, 'execution_episode_reward_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_event_artifact_refs_insert_guard
BEFORE INSERT ON lite_execution_event_artifact_refs
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS event
    WHERE event.tenant_id = NEW.tenant_id
      AND event.scope = NEW.scope
      AND event.episode_id = NEW.episode_id
      AND event.event_id = NEW.event_id
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_event_artifact_reference_invalid');
END;

CREATE TRIGGER trg_lite_execution_event_artifact_refs_no_update
BEFORE UPDATE ON lite_execution_event_artifact_refs
BEGIN
  SELECT RAISE(ABORT, 'execution_event_artifact_reference_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_event_artifact_refs_no_delete
BEFORE DELETE ON lite_execution_event_artifact_refs
BEGIN
  SELECT RAISE(ABORT, 'execution_event_artifact_reference_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_learning_links_insert_guard
BEFORE INSERT ON lite_execution_learning_links
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_episode_events AS event
    JOIN lite_execution_episodes AS episode
      ON episode.tenant_id = event.tenant_id
     AND episode.scope = event.scope
     AND episode.episode_id = event.episode_id
    WHERE event.tenant_id = NEW.tenant_id
      AND event.scope = NEW.execution_scope
      AND event.episode_id = NEW.execution_episode_id
      AND event.event_id = NEW.execution_event_id
      AND episode.public_scope = NEW.learning_scope
  )
  OR NOT EXISTS (
    SELECT 1
    FROM lite_learning_episode_events AS event
    WHERE event.tenant_id = NEW.tenant_id
      AND event.scope = NEW.learning_scope
      AND event.episode_id = NEW.learning_episode_id
      AND event.event_id = NEW.learning_event_id
      AND event.event_kind = CASE NEW.link_kind
        WHEN 'exposure' THEN 'exposure_committed'
        WHEN 'feedback' THEN 'feedback_attributed'
        WHEN 'effect' THEN 'effect_measured'
      END
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_learning_link_invalid');
END;

CREATE TRIGGER trg_lite_execution_learning_links_no_update
BEFORE UPDATE ON lite_execution_learning_links
BEGIN
  SELECT RAISE(ABORT, 'execution_learning_link_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_learning_links_no_delete
BEFORE DELETE ON lite_execution_learning_links
BEGIN
  SELECT RAISE(ABORT, 'execution_learning_link_delete_forbidden');
END;
