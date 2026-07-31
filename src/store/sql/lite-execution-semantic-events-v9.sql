CREATE TABLE lite_execution_episode_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_sequence INTEGER NOT NULL CHECK (episode_sequence >= 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'episode_started', 'decision_committed', 'action_observed',
    'semantic_observation_recorded', 'agent_decision_recorded',
    'progress_state_recorded', 'planned_action_recorded',
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
      event_kind IN (
        'semantic_observation_recorded', 'agent_decision_recorded',
        'progress_state_recorded', 'planned_action_recorded'
      )
      AND episode_sequence > 0
      AND previous_event_sha256 IS NOT NULL
      AND decision_id IS NULL
      AND action_id IS NULL
      AND state_before_snapshot_id IS NULL
      AND state_after_snapshot_id IS NULL
      AND action_mutation IS NULL
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
