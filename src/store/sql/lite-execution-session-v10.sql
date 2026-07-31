CREATE TABLE lite_execution_sessions (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_key TEXT NOT NULL CHECK (
    length(CAST(session_key AS BLOB)) BETWEEN 1 AND 256
  ),
  continuation_id TEXT NOT NULL CHECK (
    length(CAST(continuation_id AS BLOB)) BETWEEN 1 AND 256
  ),
  episode_id TEXT NOT NULL CHECK (
    length(CAST(episode_id AS BLOB)) BETWEEN 1 AND 256
  ),
  public_scope TEXT NOT NULL CHECK (
    length(CAST(public_scope AS BLOB)) BETWEEN 1 AND 256
  ),
  goal_sha256 TEXT NOT NULL CHECK (
    length(goal_sha256) = 64
    AND goal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  task_envelope_sha256 TEXT NOT NULL CHECK (
    length(task_envelope_sha256) = 64
    AND task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  subject_identity_sha256 TEXT NOT NULL CHECK (
    length(subject_identity_sha256) = 64
    AND subject_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  binding_json TEXT NOT NULL CHECK (
    json_valid(binding_json)
    AND json_type(binding_json) = 'object'
    AND length(CAST(binding_json AS BLOB)) <= 1048576
  ),
  lease_id TEXT NOT NULL CHECK (
    length(CAST(lease_id AS BLOB)) BETWEEN 1 AND 256
  ),
  holder_id TEXT NOT NULL CHECK (
    length(CAST(holder_id AS BLOB)) BETWEEN 1 AND 256
  ),
  lease_revision INTEGER NOT NULL CHECK (lease_revision >= 1),
  lease_status TEXT NOT NULL CHECK (
    lease_status IN ('active', 'released', 'expired')
  ),
  lease_expires_at TEXT,
  current_state_sha256 TEXT NOT NULL CHECK (
    length(current_state_sha256) = 64
    AND current_state_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  last_event_id TEXT NOT NULL CHECK (
    length(CAST(last_event_id AS BLOB)) BETWEEN 1 AND 256
  ),
  last_event_sha256 TEXT NOT NULL CHECK (
    length(last_event_sha256) = 64
    AND last_event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  lease_sha256 TEXT NOT NULL CHECK (
    length(lease_sha256) = 64
    AND lease_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, session_key),
  UNIQUE (tenant_id, scope, continuation_id),
  UNIQUE (tenant_id, scope, session_key, episode_id),
  CHECK (
    (lease_status = 'active' AND lease_expires_at IS NOT NULL)
    OR (lease_status = 'released' AND lease_expires_at IS NULL)
    OR (lease_status = 'expired' AND lease_expires_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, scope, episode_id)
    REFERENCES lite_execution_episodes(tenant_id, scope, episode_id)
);

CREATE TABLE lite_execution_session_lease_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_key TEXT NOT NULL,
  continuation_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN (
      'acquired', 'renewed', 'taken_over',
      'handed_off', 'released', 'expired'
    )
  ),
  operation_id TEXT NOT NULL CHECK (
    length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 256
  ),
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
  lease_id TEXT NOT NULL,
  lease_revision INTEGER NOT NULL CHECK (lease_revision >= 1),
  holder_id TEXT NOT NULL,
  previous_holder_id TEXT,
  expires_at TEXT,
  current_state_sha256 TEXT NOT NULL CHECK (
    length(current_state_sha256) = 64
    AND current_state_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  handoff_receipt_id TEXT,
  event_json TEXT NOT NULL CHECK (
    json_valid(event_json)
    AND json_type(event_json) = 'object'
    AND length(CAST(event_json AS BLOB)) <= 1048576
  ),
  recorded_at TEXT NOT NULL,
  UNIQUE (tenant_id, scope, event_id),
  UNIQUE (tenant_id, scope, operation_id),
  UNIQUE (tenant_id, scope, session_key, lease_revision),
  CHECK (
    (
      event_kind = 'acquired'
      AND lease_revision = 1
      AND previous_event_sha256 IS NULL
      AND previous_holder_id IS NULL
    )
    OR (
      event_kind <> 'acquired'
      AND lease_revision > 1
      AND previous_event_sha256 IS NOT NULL
    )
  ),
  CHECK (
    (event_kind = 'handed_off' AND handoff_receipt_id IS NOT NULL)
    OR (event_kind <> 'handed_off' AND handoff_receipt_id IS NULL)
  ),
  CHECK (
    (event_kind = 'released' AND expires_at IS NULL)
    OR (event_kind <> 'released' AND expires_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, scope, session_key, episode_id)
    REFERENCES lite_execution_sessions(
      tenant_id, scope, session_key, episode_id
    )
);

CREATE TABLE lite_execution_session_handoff_receipts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  continuation_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  from_holder_id TEXT NOT NULL,
  to_holder_id TEXT NOT NULL,
  from_lease_revision INTEGER NOT NULL CHECK (from_lease_revision >= 1),
  state_sha256 TEXT NOT NULL CHECK (
    length(state_sha256) = 64
    AND state_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    json_valid(evidence_refs_json)
    AND json_type(evidence_refs_json) = 'array'
    AND length(CAST(evidence_refs_json AS BLOB)) <= 1048576
  ),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json)
    AND json_type(receipt_json) = 'object'
    AND length(CAST(receipt_json AS BLOB)) <= 1048576
  ),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, receipt_id),
  UNIQUE (
    tenant_id, scope, session_key, from_lease_revision
  ),
  CHECK (from_holder_id <> to_holder_id),
  FOREIGN KEY (tenant_id, scope, session_key, episode_id)
    REFERENCES lite_execution_sessions(
      tenant_id, scope, session_key, episode_id
    )
);

CREATE INDEX idx_lite_execution_sessions_episode
  ON lite_execution_sessions(tenant_id, scope, episode_id);

CREATE INDEX idx_lite_execution_sessions_active_expiry
  ON lite_execution_sessions(lease_expires_at)
  WHERE lease_status = 'active';

CREATE INDEX idx_lite_execution_session_events_session_revision
  ON lite_execution_session_lease_events(
    tenant_id, scope, session_key, lease_revision
  );

CREATE INDEX idx_lite_execution_session_handoffs_session_created
  ON lite_execution_session_handoff_receipts(
    tenant_id, scope, session_key, created_at DESC, receipt_id DESC
  );

CREATE TRIGGER trg_lite_execution_session_event_no_update
BEFORE UPDATE ON lite_execution_session_lease_events
BEGIN
  SELECT RAISE(ABORT, 'execution_session_event_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_session_event_no_delete
BEFORE DELETE ON lite_execution_session_lease_events
BEGIN
  SELECT RAISE(ABORT, 'execution_session_event_delete_forbidden');
END;

CREATE TRIGGER trg_lite_execution_session_handoff_no_update
BEFORE UPDATE ON lite_execution_session_handoff_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_session_handoff_update_forbidden');
END;

CREATE TRIGGER trg_lite_execution_session_handoff_no_delete
BEFORE DELETE ON lite_execution_session_handoff_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_session_handoff_delete_forbidden');
END;
