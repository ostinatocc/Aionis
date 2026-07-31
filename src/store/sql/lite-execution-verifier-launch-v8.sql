CREATE TABLE lite_execution_verifier_launch_attempts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  verifier_invocation_id TEXT NOT NULL,
  launch_attempt_id TEXT NOT NULL CHECK (
    length(launch_attempt_id) BETWEEN 1 AND 256
  ),
  outcome_operation_id TEXT NOT NULL CHECK (
    length(outcome_operation_id) BETWEEN 1 AND 256
  ),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 1),
  owner_instance_id TEXT NOT NULL CHECK (
    length(owner_instance_id) BETWEEN 1 AND 256
  ),
  owner_process_id INTEGER NOT NULL CHECK (owner_process_id > 0),
  invocation_sha256 TEXT NOT NULL CHECK (
    length(invocation_sha256) = 64
    AND invocation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  invocation_authority_sha256 TEXT NOT NULL CHECK (
    length(invocation_authority_sha256) = 64
    AND invocation_authority_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  invocation_authority_channel_id TEXT NOT NULL CHECK (
    length(invocation_authority_channel_id) BETWEEN 1 AND 256
  ),
  materialization_id TEXT NOT NULL CHECK (
    length(materialization_id) BETWEEN 1 AND 256
  ),
  materialized_subject_root TEXT NOT NULL CHECK (
    length(materialized_subject_root) BETWEEN 1 AND 16384
    AND instr(materialized_subject_root, char(0)) = 0
    AND instr(materialized_subject_root, char(10)) = 0
    AND instr(materialized_subject_root, char(13)) = 0
    AND (
      substr(materialized_subject_root, 1, 1) = '/'
      OR (
        length(materialized_subject_root) >= 3
        AND substr(materialized_subject_root, 2, 1) = ':'
        AND (
          substr(materialized_subject_root, 3, 1) = '/'
          OR unicode(substr(materialized_subject_root, 3, 1)) = 92
        )
      )
      OR (
        unicode(substr(materialized_subject_root, 1, 1)) = 92
        AND unicode(substr(materialized_subject_root, 2, 1)) = 92
      )
    )
  ),
  materialized_scratch_root TEXT NOT NULL CHECK (
    length(materialized_scratch_root) BETWEEN 1 AND 16384
    AND instr(materialized_scratch_root, char(0)) = 0
    AND instr(materialized_scratch_root, char(10)) = 0
    AND instr(materialized_scratch_root, char(13)) = 0
    AND (
      substr(materialized_scratch_root, 1, 1) = '/'
      OR (
        length(materialized_scratch_root) >= 3
        AND substr(materialized_scratch_root, 2, 1) = ':'
        AND (
          substr(materialized_scratch_root, 3, 1) = '/'
          OR unicode(substr(materialized_scratch_root, 3, 1)) = 92
        )
      )
      OR (
        unicode(substr(materialized_scratch_root, 1, 1)) = 92
        AND unicode(substr(materialized_scratch_root, 2, 1)) = 92
      )
    )
  ),
  source_content_digest TEXT NOT NULL CHECK (
    length(source_content_digest) = 64
    AND source_content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_environment_digest TEXT NOT NULL CHECK (
    length(source_environment_digest) = 64
    AND source_environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  subject_identity_sha256 TEXT NOT NULL CHECK (
    length(subject_identity_sha256) = 64
    AND subject_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  subject_view_content_digest TEXT NOT NULL CHECK (
    length(subject_view_content_digest) = 64
    AND subject_view_content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  subject_view_environment_digest TEXT NOT NULL CHECK (
    length(subject_view_environment_digest) = 64
    AND subject_view_environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_definition_sha256 TEXT NOT NULL CHECK (
    length(verifier_definition_sha256) = 64
    AND verifier_definition_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
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
  execution_pack_manifest_sha256 TEXT NOT NULL CHECK (
    length(execution_pack_manifest_sha256) = 64
    AND execution_pack_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  resolved_config_digest TEXT NOT NULL CHECK (
    length(resolved_config_digest) = 64
    AND resolved_config_digest NOT GLOB '*[^0-9a-f]*'
  ),
  resolved_environment_digest TEXT NOT NULL CHECK (
    length(resolved_environment_digest) = 64
    AND resolved_environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  prepared_sha256 TEXT NOT NULL CHECK (
    length(prepared_sha256) = 64
    AND prepared_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prepared_at TEXT NOT NULL,
  PRIMARY KEY (
    tenant_id, scope, episode_id, launch_attempt_id
  ),
  UNIQUE (tenant_id, scope, launch_attempt_id),
  UNIQUE (
    tenant_id, scope, episode_id, verifier_invocation_id,
    launch_attempt_id
  ),
  UNIQUE (
    tenant_id, scope, episode_id, verifier_invocation_id,
    attempt_ordinal
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_invocation_id
  ) REFERENCES lite_execution_verifier_invocations(
    tenant_id, scope, episode_id, verifier_invocation_id
  )
);

CREATE TABLE lite_execution_verifier_launch_attempt_events (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  verifier_invocation_id TEXT NOT NULL,
  launch_attempt_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (
    event_sequence BETWEEN 0 AND 2
  ),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'launch_committed', 'spawn_observed', 'completed', 'interrupted'
  )),
  event_owner_instance_id TEXT NOT NULL CHECK (
    length(event_owner_instance_id) BETWEEN 1 AND 256
  ),
  event_owner_process_id INTEGER NOT NULL CHECK (
    event_owner_process_id > 0
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
  spawned_process_id INTEGER CHECK (
    spawned_process_id IS NULL OR spawned_process_id > 0
  ),
  verifier_output_artifact_id TEXT,
  verifier_output_sha256 TEXT CHECK (
    verifier_output_sha256 IS NULL OR (
      length(verifier_output_sha256) = 64
      AND verifier_output_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  runtime_launch_sha256 TEXT CHECK (
    runtime_launch_sha256 IS NULL OR (
      length(runtime_launch_sha256) = 64
      AND runtime_launch_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_sha256 TEXT CHECK (
    result_sha256 IS NULL OR (
      length(result_sha256) = 64
      AND result_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  effective_status TEXT CHECK (
    effective_status IS NULL OR effective_status IN (
      'passed', 'failed', 'infrastructure_error'
    )
  ),
  infrastructure_failure_reasons_json TEXT NOT NULL CHECK (
    json_valid(infrastructure_failure_reasons_json)
    AND json_type(infrastructure_failure_reasons_json) = 'array'
    AND length(CAST(infrastructure_failure_reasons_json AS BLOB)) <= 131072
  ),
  infrastructure_failure_attribution TEXT CHECK (
    infrastructure_failure_attribution IS NULL
    OR infrastructure_failure_attribution IN (
      'arm_caused', 'arm_independent'
    )
  ),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (
    tenant_id, scope, episode_id, launch_attempt_id, event_sequence
  ),
  UNIQUE (
    tenant_id, scope, episode_id, launch_attempt_id, event_sha256
  ),
  CHECK (
    (
      event_kind = 'launch_committed'
      AND event_sequence = 0
      AND previous_event_sha256 IS NULL
      AND spawned_process_id IS NULL
      AND verifier_output_artifact_id IS NULL
      AND verifier_output_sha256 IS NULL
      AND runtime_launch_sha256 IS NULL
      AND result_sha256 IS NULL
      AND effective_status IS NULL
      AND json_array_length(infrastructure_failure_reasons_json) = 0
      AND infrastructure_failure_attribution IS NULL
    )
    OR (
      event_kind = 'spawn_observed'
      AND event_sequence = 1
      AND previous_event_sha256 IS NOT NULL
      AND spawned_process_id IS NOT NULL
      AND verifier_output_artifact_id IS NULL
      AND verifier_output_sha256 IS NULL
      AND runtime_launch_sha256 IS NULL
      AND result_sha256 IS NULL
      AND effective_status IS NULL
      AND json_array_length(infrastructure_failure_reasons_json) = 0
      AND infrastructure_failure_attribution IS NULL
    )
    OR (
      event_kind = 'completed'
      AND event_sequence IN (1, 2)
      AND previous_event_sha256 IS NOT NULL
      AND spawned_process_id IS NULL
      AND verifier_output_artifact_id IS NOT NULL
      AND verifier_output_sha256 IS NOT NULL
      AND runtime_launch_sha256 IS NOT NULL
      AND result_sha256 IS NOT NULL
      AND effective_status IS NOT NULL
      AND (
        event_sequence = 2
        OR effective_status = 'infrastructure_error'
      )
      AND (
        (
          effective_status = 'infrastructure_error'
          AND json_array_length(infrastructure_failure_reasons_json) >= 1
          AND infrastructure_failure_attribution IN (
            'arm_caused', 'arm_independent'
          )
        )
        OR (
          effective_status != 'infrastructure_error'
          AND json_array_length(infrastructure_failure_reasons_json) = 0
          AND infrastructure_failure_attribution IS NULL
        )
      )
    )
    OR (
      event_kind = 'interrupted'
      AND event_sequence IN (1, 2)
      AND previous_event_sha256 IS NOT NULL
      AND spawned_process_id IS NULL
      AND verifier_output_artifact_id IS NOT NULL
      AND verifier_output_sha256 IS NOT NULL
      AND runtime_launch_sha256 IS NULL
      AND result_sha256 IS NULL
      AND effective_status = 'infrastructure_error'
      AND json_array_length(infrastructure_failure_reasons_json) >= 1
      AND infrastructure_failure_attribution = 'arm_caused'
    )
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_invocation_id,
    launch_attempt_id
  ) REFERENCES lite_execution_verifier_launch_attempts(
    tenant_id, scope, episode_id, verifier_invocation_id,
    launch_attempt_id
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, verifier_output_artifact_id
  ) REFERENCES lite_runtime_evidence_artifacts(
    tenant_id, scope, episode_id, artifact_id
  )
);

CREATE INDEX idx_lite_execution_verifier_launch_attempts_invocation
  ON lite_execution_verifier_launch_attempts(
    tenant_id, scope, episode_id, verifier_invocation_id,
    attempt_ordinal, prepared_at
  );

CREATE INDEX idx_lite_execution_verifier_launch_attempt_events_kind
  ON lite_execution_verifier_launch_attempt_events(
    tenant_id, scope, episode_id, verifier_invocation_id,
    event_kind, recorded_at, launch_attempt_id
  );

CREATE TRIGGER trg_lite_execution_verifier_launch_attempts_insert_guard
BEFORE INSERT ON lite_execution_verifier_launch_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_verifier_invocations AS invocation
    JOIN lite_execution_state_snapshots AS snapshot
      ON snapshot.tenant_id = invocation.tenant_id
     AND snapshot.scope = invocation.scope
     AND snapshot.episode_id = invocation.episode_id
     AND snapshot.snapshot_id = invocation.verified_state_snapshot_id
    JOIN lite_execution_episodes AS episode
      ON episode.tenant_id = invocation.tenant_id
     AND episode.scope = invocation.scope
     AND episode.episode_id = invocation.episode_id
    WHERE invocation.tenant_id = NEW.tenant_id
      AND invocation.scope = NEW.scope
      AND invocation.episode_id = NEW.episode_id
      AND invocation.verifier_invocation_id = NEW.verifier_invocation_id
      AND invocation.launch_authority_kind = 'runtime_launched'
      AND invocation.invocation_sha256 = NEW.invocation_sha256
      AND invocation.verifier_definition_sha256 =
        NEW.verifier_definition_sha256
      AND invocation.verifier_program_digest = NEW.verifier_program_digest
      AND invocation.verifier_config_digest = NEW.verifier_config_digest
      AND invocation.verifier_environment_digest =
        NEW.verifier_environment_digest
      AND snapshot.content_digest = NEW.source_content_digest
      AND snapshot.environment_digest = NEW.source_environment_digest
      AND episode.subject_identity_sha256 = NEW.subject_identity_sha256
      AND episode.required_verifier_id = invocation.verifier_id
      AND episode.required_verifier_definition_sha256 =
        invocation.verifier_definition_sha256
  )
  OR NEW.attempt_ordinal IS NOT (
    SELECT COALESCE(MAX(prior.attempt_ordinal), 0) + 1
    FROM lite_execution_verifier_launch_attempts AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.scope = NEW.scope
      AND prior.episode_id = NEW.episode_id
      AND prior.verifier_invocation_id = NEW.verifier_invocation_id
  )
  OR EXISTS (
    SELECT 1
    FROM lite_execution_verifier_launch_attempts AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.scope = NEW.scope
      AND prior.episode_id = NEW.episode_id
      AND prior.verifier_invocation_id = NEW.verifier_invocation_id
      AND NOT EXISTS (
        SELECT 1
        FROM lite_execution_verifier_launch_attempt_events AS terminal
        WHERE terminal.tenant_id = prior.tenant_id
          AND terminal.scope = prior.scope
          AND terminal.episode_id = prior.episode_id
          AND terminal.verifier_invocation_id =
            prior.verifier_invocation_id
          AND terminal.launch_attempt_id = prior.launch_attempt_id
          AND terminal.event_kind IN ('completed', 'interrupted')
      )
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
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_binding_invalid'
  );
END;

CREATE TRIGGER trg_lite_execution_verifier_launch_attempts_no_update
BEFORE UPDATE ON lite_execution_verifier_launch_attempts
BEGIN
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_update_forbidden'
  );
END;

CREATE TRIGGER trg_lite_execution_verifier_launch_attempts_no_delete
BEFORE DELETE ON lite_execution_verifier_launch_attempts
BEGIN
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_delete_forbidden'
  );
END;

CREATE TRIGGER trg_lite_execution_verifier_launch_attempt_events_sequence_guard
BEFORE INSERT ON lite_execution_verifier_launch_attempt_events
WHEN NOT EXISTS (
    SELECT 1
    FROM lite_execution_verifier_launch_attempts AS attempt
    WHERE attempt.tenant_id = NEW.tenant_id
      AND attempt.scope = NEW.scope
      AND attempt.episode_id = NEW.episode_id
      AND attempt.verifier_invocation_id = NEW.verifier_invocation_id
      AND attempt.launch_attempt_id = NEW.launch_attempt_id
      AND NEW.recorded_at >= attempt.prepared_at
      AND (
        NEW.event_kind = 'interrupted'
        OR (
          NEW.event_owner_instance_id = attempt.owner_instance_id
          AND NEW.event_owner_process_id = attempt.owner_process_id
        )
      )
  )
  OR (
    NEW.event_sequence = 0
    AND (
      NEW.event_kind != 'launch_committed'
      OR EXISTS (
        SELECT 1
        FROM lite_execution_verifier_launch_attempt_events AS prior
        WHERE prior.tenant_id = NEW.tenant_id
          AND prior.scope = NEW.scope
          AND prior.episode_id = NEW.episode_id
          AND prior.launch_attempt_id = NEW.launch_attempt_id
      )
      OR NEW.recorded_at IS NOT (
        SELECT attempt.prepared_at
        FROM lite_execution_verifier_launch_attempts AS attempt
        WHERE attempt.tenant_id = NEW.tenant_id
          AND attempt.scope = NEW.scope
          AND attempt.episode_id = NEW.episode_id
          AND attempt.verifier_invocation_id =
            NEW.verifier_invocation_id
          AND attempt.launch_attempt_id = NEW.launch_attempt_id
      )
    )
  )
  OR (
    NEW.event_sequence > 0
    AND NOT EXISTS (
      SELECT 1
      FROM lite_execution_verifier_launch_attempt_events AS prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.scope = NEW.scope
        AND prior.episode_id = NEW.episode_id
        AND prior.verifier_invocation_id = NEW.verifier_invocation_id
        AND prior.launch_attempt_id = NEW.launch_attempt_id
        AND prior.event_sequence = NEW.event_sequence - 1
        AND prior.event_sha256 = NEW.previous_event_sha256
        AND NEW.recorded_at >= prior.recorded_at
        AND (
          (
            prior.event_kind = 'launch_committed'
            AND (
              NEW.event_kind IN ('spawn_observed', 'interrupted')
              OR (
                NEW.event_kind = 'completed'
                AND NEW.effective_status = 'infrastructure_error'
              )
            )
          )
          OR (
            prior.event_kind = 'spawn_observed'
            AND NEW.event_kind IN ('completed', 'interrupted')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM lite_execution_verifier_launch_attempt_events AS later
          WHERE later.tenant_id = prior.tenant_id
            AND later.scope = prior.scope
            AND later.episode_id = prior.episode_id
            AND later.launch_attempt_id = prior.launch_attempt_id
            AND later.event_sequence > prior.event_sequence
        )
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_event_sequence_invalid'
  );
END;

CREATE TRIGGER trg_lite_execution_verifier_launch_attempt_events_output_guard
BEFORE INSERT ON lite_execution_verifier_launch_attempt_events
WHEN NEW.event_kind IN ('completed', 'interrupted')
  AND NOT EXISTS (
    SELECT 1
    FROM lite_runtime_evidence_artifacts AS artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.scope = NEW.scope
      AND artifact.episode_id = NEW.episode_id
      AND artifact.artifact_id = NEW.verifier_output_artifact_id
      AND artifact.kind = 'verifier_output'
      AND artifact.sha256 = NEW.verifier_output_sha256
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_event_output_invalid'
  );
END;

CREATE TRIGGER trg_lite_execution_verifier_launch_attempt_events_no_update
BEFORE UPDATE ON lite_execution_verifier_launch_attempt_events
BEGIN
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_event_update_forbidden'
  );
END;

CREATE TRIGGER trg_lite_execution_verifier_launch_attempt_events_no_delete
BEFORE DELETE ON lite_execution_verifier_launch_attempt_events
BEGIN
  SELECT RAISE(
    ABORT,
    'execution_verifier_launch_attempt_event_delete_forbidden'
  );
END;

CREATE TRIGGER trg_lite_runtime_evidence_artifacts_verifier_launch_delete_guard
BEFORE DELETE ON lite_runtime_evidence_artifacts
WHEN EXISTS (
  SELECT 1
  FROM lite_execution_verifier_launch_attempt_events AS event
  WHERE event.tenant_id = OLD.tenant_id
    AND event.scope = OLD.scope
    AND event.episode_id = OLD.episode_id
    AND event.verifier_output_artifact_id = OLD.artifact_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'runtime_evidence_artifact_is_referenced_by_verifier_launch'
  );
END;
