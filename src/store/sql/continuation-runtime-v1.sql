PRAGMA foreign_keys = ON;
PRAGMA application_id = 1095323470;
PRAGMA user_version = 1;

CREATE TABLE runtime_meta (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  database_instance_id TEXT NOT NULL UNIQUE CHECK (
    length(database_instance_id) = 64
    AND database_instance_id NOT GLOB '*[^0-9a-f]*'
  ),
  schema_id TEXT NOT NULL CHECK (schema_id = 'continuation_runtime_v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_manifest_sha256 TEXT NOT NULL CHECK (
    length(schema_manifest_sha256) = 64
    AND schema_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  authority_clock_floor_at TEXT NOT NULL CHECK (
    length(authority_clock_floor_at) = 24
    AND authority_clock_floor_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', authority_clock_floor_at) = authority_clock_floor_at
    AND authority_clock_floor_at >= created_at
  )
) STRICT;

CREATE TABLE operations (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'record_observations',
    'create_continuation',
    'record_outcome',
    'authority_decision',
    'worker_completion'
  )),
  operation_id TEXT NOT NULL CHECK (
    length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(operation_id, char(0)) = 0
  ),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN (
    'trusted_host', 'operator', 'worker'
  )),
  actor_principal_sha256 TEXT NOT NULL CHECK (
    length(actor_principal_sha256) = 64
    AND actor_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (
    json_valid(request_json)
    AND length(CAST(request_json AS BLOB)) >= 1
    AND (
      (operation_kind = 'worker_completion'
        AND length(CAST(request_json AS BLOB)) <= 8388608)
      OR (operation_kind <> 'worker_completion'
        AND length(CAST(request_json AS BLOB)) <= 1048576)
    )
  ),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json)
    AND json_type(receipt_json) = 'object'
    AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  completed_at TEXT NOT NULL CHECK (
    length(completed_at) = 24
    AND completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  ),
  PRIMARY KEY (tenant_id, scope, operation_kind, operation_id),
  UNIQUE (
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ),
  UNIQUE (
    tenant_id, scope, operation_kind, operation_id, request_sha256,
    actor_kind, actor_principal_sha256
  ),
  UNIQUE (tenant_id, receipt_sha256),
  CHECK (
    (operation_kind IN (
      'record_observations', 'create_continuation', 'record_outcome'
    ) AND actor_kind = 'trusted_host')
    OR (operation_kind = 'authority_decision' AND actor_kind = 'operator')
    OR (operation_kind = 'worker_completion' AND actor_kind = 'worker')
  )
) STRICT;

CREATE INDEX idx_operations_completed
  ON operations(tenant_id, scope, completed_at DESC, operation_id);

CREATE TABLE durable_jobs (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  task_family TEXT NOT NULL CHECK (
    length(CAST(task_family AS BLOB)) BETWEEN 1 AND 256
    AND instr(task_family, char(0)) = 0
  ),
  authority_subject_sha256 TEXT NOT NULL CHECK (
    length(authority_subject_sha256) = 64
    AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  job_id TEXT NOT NULL CHECK (
    length(CAST(job_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(job_id, char(0)) = 0
  ),
  job_kind TEXT NOT NULL CHECK (job_kind IN (
    'embedding', 'ann', 'effect', 'retention'
  )),
  dedupe_key TEXT NOT NULL CHECK (
    length(CAST(dedupe_key AS BLOB)) BETWEEN 1 AND 512
    AND instr(dedupe_key, char(0)) = 0
  ),
  source_operation_kind TEXT NOT NULL CHECK (source_operation_kind IN (
    'record_observations', 'record_outcome', 'authority_decision',
    'worker_completion'
  )),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'leased', 'succeeded', 'dead'
  )),
  priority INTEGER NOT NULL CHECK (priority BETWEEN -1000000 AND 1000000),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1000),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 1000),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
    AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  available_at TEXT NOT NULL CHECK (
    length(available_at) = 24
    AND available_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', available_at) = available_at
  ),
  initial_available_at TEXT NOT NULL CHECK (
    length(initial_available_at) = 24
    AND initial_available_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', initial_available_at) =
      initial_available_at
  ),
  lease_owner TEXT CHECK (
    lease_owner IS NULL OR (
      length(CAST(lease_owner AS BLOB)) BETWEEN 1 AND 256
      AND instr(lease_owner, char(0)) = 0
    )
  ),
  lease_token TEXT CHECK (
    lease_token IS NULL OR (
      length(lease_token) = 64
      AND lease_token NOT GLOB '*[^0-9a-f]*'
    )
  ),
  lease_acquired_at TEXT CHECK (
    lease_acquired_at IS NULL OR (
      length(lease_acquired_at) = 24
      AND lease_acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_acquired_at) = lease_acquired_at
    )
  ),
  lease_expires_at TEXT CHECK (
    lease_expires_at IS NULL OR (
      length(lease_expires_at) = 24
      AND lease_expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) = lease_expires_at
    )
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      length(completed_at) = 24
      AND completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
    )
  ),
  terminal_reason TEXT CHECK (
    terminal_reason IS NULL OR terminal_reason IN (
      'worker_succeeded', 'worker_dead',
      'lease_expired_attempts_exhausted'
    )
  ),
  completion_operation_kind TEXT CHECK (
    completion_operation_kind IS NULL
    OR completion_operation_kind = 'worker_completion'
  ),
  completion_operation_id TEXT CHECK (
    completion_operation_id IS NULL OR (
      length(CAST(completion_operation_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(completion_operation_id, char(0)) = 0
    )
  ),
  completion_request_sha256 TEXT CHECK (
    completion_request_sha256 IS NULL OR (
      length(completion_request_sha256) = 64
      AND completion_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  previous_completion_operation_kind TEXT CHECK (
    previous_completion_operation_kind IS NULL
    OR previous_completion_operation_kind = 'worker_completion'
  ),
  previous_completion_operation_id TEXT CHECK (
    previous_completion_operation_id IS NULL OR (
      length(CAST(previous_completion_operation_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(previous_completion_operation_id, char(0)) = 0
    )
  ),
  previous_completion_request_sha256 TEXT CHECK (
    previous_completion_request_sha256 IS NULL OR (
      length(previous_completion_request_sha256) = 64
      AND previous_completion_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_error_json TEXT CHECK (
    last_error_json IS NULL OR (
      json_valid(last_error_json)
      AND json_type(last_error_json) = 'object'
      AND length(CAST(last_error_json AS BLOB)) BETWEEN 2 AND 16384
    )
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    AND updated_at >= created_at
  ),
  PRIMARY KEY (tenant_id, scope, job_id),
  UNIQUE (tenant_id, scope, job_kind, dedupe_key),
  FOREIGN KEY (
    tenant_id, scope, source_operation_kind, source_operation_id,
    source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, completion_operation_kind, completion_operation_id,
    completion_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, previous_completion_operation_kind,
    previous_completion_operation_id, previous_completion_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (job_kind = 'embedding'
      AND source_operation_kind = 'record_observations')
    OR (job_kind = 'ann'
      AND source_operation_kind = 'worker_completion')
    OR (job_kind = 'effect'
      AND source_operation_kind = 'authority_decision')
    OR (job_kind = 'retention'
      AND source_operation_kind = 'authority_decision')
  ),
  CHECK (attempt_count <= max_attempts),
  CHECK (initial_available_at >= created_at),
  CHECK (available_at >= initial_available_at),
  CHECK (
    (completion_operation_kind IS NULL
      AND completion_operation_id IS NULL
      AND completion_request_sha256 IS NULL)
    OR (completion_operation_kind = 'worker_completion'
      AND completion_operation_id IS NOT NULL
      AND completion_request_sha256 IS NOT NULL)
  ),
  CHECK (
    (previous_completion_operation_kind IS NULL
      AND previous_completion_operation_id IS NULL
      AND previous_completion_request_sha256 IS NULL)
    OR (previous_completion_operation_kind = 'worker_completion'
      AND previous_completion_operation_id IS NOT NULL
      AND previous_completion_request_sha256 IS NOT NULL
      AND completion_operation_kind = 'worker_completion'
      AND (previous_completion_operation_id <> completion_operation_id
        OR previous_completion_request_sha256 <> completion_request_sha256))
  ),
  CHECK (
    (state = 'queued'
      AND attempt_count < max_attempts
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NULL
      AND terminal_reason IS NULL
      AND ((attempt_count = 0 AND last_error_json IS NULL)
        OR (attempt_count > 0 AND last_error_json IS NOT NULL)))
    OR (state = 'leased'
      AND attempt_count >= 1
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND available_at <= lease_acquired_at
      AND lease_expires_at > lease_acquired_at
      AND updated_at = lease_acquired_at
      AND completed_at IS NULL
      AND terminal_reason IS NULL
      AND ((attempt_count = 1 AND last_error_json IS NULL)
        OR (attempt_count > 1 AND last_error_json IS NOT NULL)))
    OR (state = 'succeeded'
      AND attempt_count >= 1
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at = updated_at
      AND available_at <= completed_at
      AND last_error_json IS NULL
      AND terminal_reason = 'worker_succeeded'
      AND completion_operation_kind = 'worker_completion'
      AND completion_operation_id IS NOT NULL
      AND completion_request_sha256 IS NOT NULL)
    OR (state = 'dead'
      AND attempt_count >= 1
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at = updated_at
      AND available_at <= completed_at
      AND last_error_json IS NOT NULL
      AND (
        (terminal_reason = 'worker_dead'
          AND completion_operation_kind = 'worker_completion'
          AND completion_operation_id IS NOT NULL
          AND completion_request_sha256 IS NOT NULL)
        OR (terminal_reason = 'lease_expired_attempts_exhausted'
          AND attempt_count = max_attempts)
      ))
  )
) STRICT;

CREATE INDEX idx_durable_jobs_dequeue
  ON durable_jobs(
    tenant_id, job_kind, state, available_at, priority DESC, scope, job_id
  );
CREATE INDEX idx_durable_jobs_lease_expiry
  ON durable_jobs(tenant_id, job_kind, state, lease_expires_at, scope, job_id)
  WHERE state = 'leased';
CREATE UNIQUE INDEX idx_durable_jobs_live_lease_token
  ON durable_jobs(lease_token)
  WHERE lease_token IS NOT NULL;

CREATE TABLE memory_commits (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  commit_id TEXT NOT NULL CHECK (
    length(CAST(commit_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(commit_id, char(0)) = 0
  ),
  commit_sha256 TEXT NOT NULL CHECK (
    length(commit_sha256) = 64
    AND commit_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  parent_revision INTEGER,
  parent_commit_id TEXT,
  parent_commit_sha256 TEXT,
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_operation_kind TEXT NOT NULL CHECK (source_operation_kind IN (
    'record_observations', 'authority_decision', 'worker_completion'
  )),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  mutation_sha256 TEXT NOT NULL CHECK (
    length(mutation_sha256) = 64
    AND mutation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  mutation_json TEXT NOT NULL CHECK (
    json_valid(mutation_json)
    AND json_type(mutation_json) = 'object'
    AND length(CAST(mutation_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN (
    'runtime', 'trusted_host', 'operator', 'worker'
  )),
  actor_principal_sha256 TEXT NOT NULL CHECK (
    length(actor_principal_sha256) = 64
    AND actor_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (tenant_id, scope, revision),
  UNIQUE (tenant_id, scope, commit_id),
  UNIQUE (tenant_id, scope, commit_sha256),
  UNIQUE (tenant_id, scope, revision, commit_id, commit_sha256),
  CHECK (request_sha256 = source_request_sha256),
  CHECK (
    (revision = 1
      AND parent_revision IS NULL
      AND parent_commit_id IS NULL
      AND parent_commit_sha256 IS NULL)
    OR (revision > 1
      AND parent_revision = revision - 1
      AND parent_commit_id IS NOT NULL
      AND parent_commit_sha256 IS NOT NULL
      AND length(parent_commit_sha256) = 64
      AND parent_commit_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  FOREIGN KEY (
    tenant_id, scope, parent_revision, parent_commit_id, parent_commit_sha256
  ) REFERENCES memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, source_operation_kind, source_operation_id,
    source_request_sha256, actor_kind, actor_principal_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256,
    actor_kind, actor_principal_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_memory_commits_created
  ON memory_commits(tenant_id, scope, created_at DESC, revision DESC);

CREATE TABLE memory_scope_heads (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
  head_commit_id TEXT NOT NULL CHECK (
    length(CAST(head_commit_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(head_commit_id, char(0)) = 0
  ),
  head_commit_sha256 TEXT NOT NULL CHECK (
    length(head_commit_sha256) = 64
    AND head_commit_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  head_sha256 TEXT NOT NULL CHECK (
    length(head_sha256) = 64
    AND head_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_operation_kind TEXT NOT NULL CHECK (source_operation_kind IN (
    'record_observations', 'authority_decision', 'worker_completion'
  )),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  ),
  PRIMARY KEY (tenant_id, scope),
  UNIQUE (tenant_id, scope, head_revision, head_commit_id, head_commit_sha256),
  UNIQUE (tenant_id, scope, head_sha256),
  FOREIGN KEY (
    tenant_id, scope, head_revision, head_commit_id, head_commit_sha256
  ) REFERENCES memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, source_operation_kind, source_operation_id,
    source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE memory_items (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  memory_id TEXT NOT NULL CHECK (
    length(CAST(memory_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(memory_id, char(0)) = 0
  ),
  memory_kind TEXT NOT NULL CHECK (
    length(CAST(memory_kind AS BLOB)) BETWEEN 1 AND 128
    AND instr(memory_kind, char(0)) = 0
  ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'active', 'suppressed', 'archived', 'quarantined'
  )),
  authority TEXT NOT NULL CHECK (authority IN (
    'candidate', 'verified', 'authoritative'
  )),
  hydrated INTEGER NOT NULL CHECK (hydrated IN (0, 1)),
  projection_sha256 TEXT NOT NULL CHECK (
    length(projection_sha256) = 64
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  projection_json TEXT NOT NULL CHECK (
    json_valid(projection_json)
    AND json_type(projection_json) = 'object'
    AND length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  rehydration_ref TEXT CHECK (
    rehydration_ref IS NULL OR (
      length(rehydration_ref) = 79
      AND substr(rehydration_ref, 1, 15) = 'rehydration:v1:'
      AND length(substr(rehydration_ref, 16)) = 64
      AND substr(rehydration_ref, 16) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  source_commit_revision INTEGER NOT NULL CHECK (source_commit_revision >= 1),
  source_commit_id TEXT NOT NULL CHECK (
    length(CAST(source_commit_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_commit_id, char(0)) = 0
  ),
  source_commit_sha256 TEXT NOT NULL CHECK (
    length(source_commit_sha256) = 64
    AND source_commit_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  row_sha256 TEXT NOT NULL CHECK (
    length(row_sha256) = 64
    AND row_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at TEXT CHECK (
    expires_at IS NULL OR (
      length(expires_at) = 24
      AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
    )
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    AND updated_at >= created_at
  ),
  PRIMARY KEY (tenant_id, scope, memory_id),
  UNIQUE (tenant_id, scope, memory_id, projection_sha256),
  UNIQUE (tenant_id, scope, row_sha256),
  CHECK (
    (lifecycle = 'archived' AND hydrated = 0 AND rehydration_ref IS NOT NULL)
    OR (lifecycle <> 'archived' AND hydrated = 1 AND rehydration_ref IS NULL)
  ),
  FOREIGN KEY (
    tenant_id, scope, source_commit_revision, source_commit_id,
    source_commit_sha256
  ) REFERENCES memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_memory_items_lifecycle
  ON memory_items(tenant_id, scope, lifecycle, authority, memory_id);
CREATE INDEX idx_memory_items_commit
  ON memory_items(tenant_id, scope, source_commit_revision, memory_id);
CREATE INDEX idx_memory_items_expiry
  ON memory_items(tenant_id, scope, expires_at, memory_id)
  WHERE expires_at IS NOT NULL;

CREATE TABLE memory_relations (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  relation_id TEXT NOT NULL CHECK (
    length(CAST(relation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(relation_id, char(0)) = 0
  ),
  relation_kind TEXT NOT NULL CHECK (
    length(CAST(relation_kind AS BLOB)) BETWEEN 1 AND 128
    AND instr(relation_kind, char(0)) = 0
  ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'active', 'suppressed', 'archived', 'quarantined'
  )),
  source_memory_id TEXT NOT NULL CHECK (
    length(CAST(source_memory_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_memory_id, char(0)) = 0
  ),
  target_memory_id TEXT NOT NULL CHECK (
    length(CAST(target_memory_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(target_memory_id, char(0)) = 0
  ),
  projection_sha256 TEXT NOT NULL CHECK (
    length(projection_sha256) = 64
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  projection_json TEXT NOT NULL CHECK (
    json_valid(projection_json)
    AND json_type(projection_json) = 'object'
    AND length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  source_commit_revision INTEGER NOT NULL CHECK (source_commit_revision >= 1),
  source_commit_id TEXT NOT NULL CHECK (
    length(CAST(source_commit_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_commit_id, char(0)) = 0
  ),
  source_commit_sha256 TEXT NOT NULL CHECK (
    length(source_commit_sha256) = 64
    AND source_commit_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  row_sha256 TEXT NOT NULL CHECK (
    length(row_sha256) = 64
    AND row_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    AND updated_at >= created_at
  ),
  PRIMARY KEY (tenant_id, scope, relation_id),
  UNIQUE (
    tenant_id, scope, relation_kind, source_memory_id, target_memory_id
  ),
  UNIQUE (tenant_id, scope, row_sha256),
  CHECK (source_memory_id <> target_memory_id),
  FOREIGN KEY (tenant_id, scope, source_memory_id)
    REFERENCES memory_items(tenant_id, scope, memory_id),
  FOREIGN KEY (tenant_id, scope, target_memory_id)
    REFERENCES memory_items(tenant_id, scope, memory_id),
  FOREIGN KEY (
    tenant_id, scope, source_commit_revision, source_commit_id,
    source_commit_sha256
  ) REFERENCES memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_memory_relations_source
  ON memory_relations(tenant_id, scope, source_memory_id, lifecycle, relation_id);
CREATE INDEX idx_memory_relations_target
  ON memory_relations(tenant_id, scope, target_memory_id, lifecycle, relation_id);

CREATE TABLE capsule_revisions (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  capsule_id TEXT NOT NULL CHECK (
    length(CAST(capsule_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_id, char(0)) = 0
  ),
  capsule_revision INTEGER NOT NULL CHECK (capsule_revision >= 1),
  capsule_sha256 TEXT NOT NULL CHECK (
    length(capsule_sha256) = 64
    AND capsule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  parent_capsule_revision INTEGER,
  parent_capsule_sha256 TEXT,
  memory_id TEXT NOT NULL CHECK (
    length(CAST(memory_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(memory_id, char(0)) = 0
  ),
  source_commit_revision INTEGER NOT NULL CHECK (source_commit_revision >= 1),
  source_commit_id TEXT NOT NULL CHECK (
    length(CAST(source_commit_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_commit_id, char(0)) = 0
  ),
  source_commit_sha256 TEXT NOT NULL CHECK (
    length(source_commit_sha256) = 64
    AND source_commit_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_projection_sha256 TEXT NOT NULL CHECK (
    length(source_projection_sha256) = 64
    AND source_projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  capsule_kind TEXT NOT NULL CHECK (capsule_kind IN (
    'current_state',
    'verified_fact',
    'procedure',
    'constraint',
    'counter_evidence',
    'rehydration_pointer'
  )),
  proposed_influence TEXT NOT NULL CHECK (proposed_influence IN (
    'use', 'inspect', 'block', 'rehydrate'
  )),
  task_family TEXT NOT NULL CHECK (
    length(CAST(task_family AS BLOB)) BETWEEN 1 AND 256
    AND instr(task_family, char(0)) = 0
  ),
  task_signature TEXT CHECK (
    task_signature IS NULL OR (
      length(CAST(task_signature AS BLOB)) BETWEEN 1 AND 256
      AND instr(task_signature, char(0)) = 0
    )
  ),
  workflow_signature TEXT CHECK (
    workflow_signature IS NULL OR (
      length(CAST(workflow_signature AS BLOB)) BETWEEN 1 AND 256
      AND instr(workflow_signature, char(0)) = 0
    )
  ),
  workspace_signature TEXT CHECK (
    workspace_signature IS NULL OR (
      length(CAST(workspace_signature AS BLOB)) BETWEEN 1 AND 256
      AND instr(workspace_signature, char(0)) = 0
    )
  ),
  producer_agent_id TEXT CHECK (
    producer_agent_id IS NULL OR (
      length(CAST(producer_agent_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(producer_agent_id, char(0)) = 0
    )
  ),
  owner_agent_id TEXT CHECK (
    owner_agent_id IS NULL OR (
      length(CAST(owner_agent_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(owner_agent_id, char(0)) = 0
    )
  ),
  owner_team_id TEXT CHECK (
    owner_team_id IS NULL OR (
      length(CAST(owner_team_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(owner_team_id, char(0)) = 0
    )
  ),
  projection_sha256 TEXT NOT NULL CHECK (
    length(projection_sha256) = 64
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  projection_json TEXT NOT NULL CHECK (
    json_valid(projection_json)
    AND json_type(projection_json) = 'object'
    AND length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 8192
  ),
  precondition_count INTEGER NOT NULL CHECK (
    precondition_count BETWEEN 0 AND 16
  ),
  preconditions_json TEXT NOT NULL CHECK (
    json_valid(preconditions_json)
    AND json_type(preconditions_json) = 'array'
    AND json_array_length(preconditions_json) = precondition_count
    AND length(CAST(preconditions_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  coverage_claim_count INTEGER NOT NULL CHECK (
    coverage_claim_count BETWEEN 1 AND 32
  ),
  coverage_claims_json TEXT NOT NULL CHECK (
    json_valid(coverage_claims_json)
    AND json_type(coverage_claims_json) = 'array'
    AND json_array_length(coverage_claims_json) = coverage_claim_count
    AND length(CAST(coverage_claims_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  conflict_count INTEGER NOT NULL CHECK (conflict_count BETWEEN 0 AND 16),
  conflicts_json TEXT NOT NULL CHECK (
    json_valid(conflicts_json)
    AND json_type(conflicts_json) = 'array'
    AND json_array_length(conflicts_json) = conflict_count
    AND length(CAST(conflicts_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  supersedes_count INTEGER NOT NULL CHECK (supersedes_count BETWEEN 0 AND 16),
  supersedes_json TEXT NOT NULL CHECK (
    json_valid(supersedes_json)
    AND json_type(supersedes_json) = 'array'
    AND json_array_length(supersedes_json) = supersedes_count
    AND length(CAST(supersedes_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  capsule_json TEXT NOT NULL CHECK (
    json_valid(capsule_json)
    AND json_type(capsule_json) = 'object'
    AND length(CAST(capsule_json AS BLOB)) BETWEEN 2 AND 131072
  ),
  expires_at TEXT CHECK (
    expires_at IS NULL OR (
      length(expires_at) = 24
      AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
    )
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (tenant_id, scope, capsule_id, capsule_revision),
  UNIQUE (tenant_id, scope, capsule_sha256),
  UNIQUE (
    tenant_id, scope, capsule_id, capsule_revision, capsule_sha256
  ),
  CHECK (
    (capsule_revision = 1
      AND parent_capsule_revision IS NULL
      AND parent_capsule_sha256 IS NULL)
    OR (capsule_revision > 1
      AND parent_capsule_revision = capsule_revision - 1
      AND parent_capsule_sha256 IS NOT NULL
      AND length(parent_capsule_sha256) = 64
      AND parent_capsule_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    capsule_kind <> 'counter_evidence' OR proposed_influence <> 'use'
  ),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  FOREIGN KEY (tenant_id, scope, memory_id)
    REFERENCES memory_items(tenant_id, scope, memory_id),
  FOREIGN KEY (
    tenant_id, scope, source_commit_revision, source_commit_id,
    source_commit_sha256
  ) REFERENCES memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256
  ),
  FOREIGN KEY (
    tenant_id, scope, capsule_id, parent_capsule_revision,
    parent_capsule_sha256
  ) REFERENCES capsule_revisions(
    tenant_id, scope, capsule_id, capsule_revision, capsule_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_capsule_revisions_source
  ON capsule_revisions(
    tenant_id, scope, memory_id, source_commit_revision, capsule_id,
    capsule_revision DESC
  );
CREATE INDEX idx_capsule_revisions_applicability
  ON capsule_revisions(
    tenant_id, scope, task_family, task_signature, workflow_signature,
    workspace_signature, capsule_sha256
  );
CREATE INDEX idx_capsule_revisions_expiry
  ON capsule_revisions(tenant_id, scope, expires_at, capsule_sha256)
  WHERE expires_at IS NOT NULL;

CREATE TABLE observation_snapshots (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  world_snapshot_id TEXT NOT NULL CHECK (
    length(CAST(world_snapshot_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(world_snapshot_id, char(0)) = 0
  ),
  world_snapshot_sha256 TEXT NOT NULL CHECK (
    length(world_snapshot_sha256) = 64
    AND world_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  host_task_id TEXT NOT NULL CHECK (
    length(CAST(host_task_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(host_task_id, char(0)) = 0
  ),
  host_task_envelope_sha256 TEXT NOT NULL CHECK (
    length(host_task_envelope_sha256) = 64
    AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  host_task_envelope_json TEXT NOT NULL CHECK (
    json_valid(host_task_envelope_json)
    AND json_type(host_task_envelope_json) = 'object'
    AND length(CAST(host_task_envelope_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  collection_principal_sha256 TEXT NOT NULL CHECK (
    length(collection_principal_sha256) = 64
    AND collection_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observation_count INTEGER NOT NULL CHECK (
    observation_count BETWEEN 0 AND 2048
  ),
  observations_json TEXT NOT NULL CHECK (
    json_valid(observations_json)
    AND json_type(observations_json) = 'array'
    AND json_array_length(observations_json) = observation_count
    AND length(CAST(observations_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  source_operation_kind TEXT NOT NULL CHECK (
    source_operation_kind = 'record_observations'
  ),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_from TEXT NOT NULL CHECK (
    length(observed_from) = 24
    AND observed_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_from) = observed_from
  ),
  observed_through TEXT NOT NULL CHECK (
    length(observed_through) = 24
    AND observed_through GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_through) = observed_through
  ),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) = 24
    AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (tenant_id, scope, world_snapshot_id),
  UNIQUE (tenant_id, scope, world_snapshot_sha256),
  UNIQUE (
    tenant_id, scope, world_snapshot_id, world_snapshot_sha256
  ),
  CHECK (observed_from <= observed_through),
  CHECK (observed_through <= created_at),
  CHECK (expires_at >= observed_through),
  FOREIGN KEY (
    tenant_id, scope, source_operation_kind, source_operation_id,
    source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_observation_snapshots_task
  ON observation_snapshots(
    tenant_id, scope, host_task_envelope_sha256, created_at DESC,
    world_snapshot_id
  );
CREATE INDEX idx_observation_snapshots_expiry
  ON observation_snapshots(tenant_id, scope, expires_at, world_snapshot_id);

CREATE TABLE authority_artifacts (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  source_operation_scope TEXT NOT NULL CHECK (
    length(CAST(source_operation_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_scope, char(0)) = 0
  ),
  source_operation_kind TEXT NOT NULL CHECK (
    source_operation_kind = 'authority_decision'
  ),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_id TEXT NOT NULL CHECK (
    length(CAST(artifact_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(artifact_id, char(0)) = 0
  ),
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision >= 1),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'compiler_policy', 'evidence_policy', 'experiment_cohort',
    'policy_rotation'
  )),
  artifact_schema TEXT NOT NULL CHECK (
    length(CAST(artifact_schema AS BLOB)) BETWEEN 1 AND 256
    AND instr(artifact_schema, char(0)) = 0
  ),
  authority_subject_sha256 TEXT CHECK (
    authority_subject_sha256 IS NULL OR (
      length(authority_subject_sha256) = 64
      AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
    AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  signer_principal_sha256 TEXT NOT NULL CHECK (
    length(signer_principal_sha256) = 64
    AND signer_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  trust_root_sha256 TEXT NOT NULL CHECK (
    length(trust_root_sha256) = 64
    AND trust_root_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  signature_algorithm TEXT NOT NULL CHECK (
    signature_algorithm = 'ed25519'
  ),
  signature BLOB NOT NULL CHECK (length(signature) = 64),
  protected_secret BLOB,
  valid_from TEXT NOT NULL CHECK (
    length(valid_from) = 24
    AND valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) = valid_from
  ),
  expires_at TEXT CHECK (
    expires_at IS NULL OR (
      length(expires_at) = 24
      AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
    )
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (tenant_id, artifact_id, artifact_revision),
  UNIQUE (tenant_id, artifact_sha256),
  UNIQUE (
    tenant_id, artifact_sha256, payload_sha256, artifact_kind
  ),
  UNIQUE (
    tenant_id, artifact_sha256, payload_sha256, artifact_kind,
    trust_root_sha256
  ),
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK (
    (artifact_kind = 'experiment_cohort'
      AND artifact_schema = 'experiment_cohort_v1'
      AND authority_subject_sha256 IS NOT NULL
      AND protected_secret IS NOT NULL
      AND typeof(protected_secret) = 'blob'
      AND length(protected_secret) = 32)
    OR (artifact_kind <> 'experiment_cohort' AND protected_secret IS NULL)
  ),
  FOREIGN KEY (
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_authority_artifacts_kind
  ON authority_artifacts(
    tenant_id, artifact_kind, artifact_id, artifact_revision DESC
  );
CREATE INDEX idx_authority_artifacts_subject
  ON authority_artifacts(
    tenant_id, authority_subject_sha256, artifact_kind, valid_from DESC
  );
CREATE INDEX idx_authority_artifacts_payload
  ON authority_artifacts(tenant_id, payload_sha256, artifact_kind);

CREATE TABLE branch_revisions (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  source_operation_scope TEXT NOT NULL CHECK (
    length(CAST(source_operation_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_scope, char(0)) = 0
  ),
  source_operation_kind TEXT NOT NULL CHECK (source_operation_kind IN (
    'record_observations', 'authority_decision'
  )),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authority_subject_sha256 TEXT NOT NULL CHECK (
    length(authority_subject_sha256) = 64
    AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  branch_id TEXT NOT NULL CHECK (
    length(CAST(branch_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(branch_id, char(0)) = 0
  ),
  branch_revision INTEGER NOT NULL CHECK (branch_revision >= 1),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  branch_kind TEXT NOT NULL CHECK (branch_kind IN (
    'authoritative', 'candidate'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'authoritative',
    'draft',
    'shadow',
    'eligible',
    'active_candidate',
    'merged',
    'rejected',
    'quarantined',
    'expired'
  )),
  base_branch_id TEXT,
  base_branch_revision INTEGER,
  base_manifest_sha256 TEXT,
  base_branch_kind TEXT,
  base_branch_state TEXT,
  previous_branch_revision INTEGER,
  previous_revision_sha256 TEXT,
  compiler_policy_artifact_sha256 TEXT NOT NULL CHECK (
    length(compiler_policy_artifact_sha256) = 64
    AND compiler_policy_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  compiler_policy_payload_sha256 TEXT NOT NULL CHECK (
    length(compiler_policy_payload_sha256) = 64
    AND compiler_policy_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  compiler_policy_kind TEXT NOT NULL CHECK (
    compiler_policy_kind = 'compiler_policy'
  ),
  evidence_policy_artifact_sha256 TEXT NOT NULL CHECK (
    length(evidence_policy_artifact_sha256) = 64
    AND evidence_policy_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_policy_payload_sha256 TEXT NOT NULL CHECK (
    length(evidence_policy_payload_sha256) = 64
    AND evidence_policy_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_policy_kind TEXT NOT NULL CHECK (
    evidence_policy_kind = 'evidence_policy'
  ),
  policy_rotation_artifact_sha256 TEXT CHECK (
    policy_rotation_artifact_sha256 IS NULL OR (
      length(policy_rotation_artifact_sha256) = 64
      AND policy_rotation_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  policy_rotation_payload_sha256 TEXT CHECK (
    policy_rotation_payload_sha256 IS NULL OR (
      length(policy_rotation_payload_sha256) = 64
      AND policy_rotation_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  policy_rotation_artifact_kind TEXT CHECK (
    policy_rotation_artifact_kind IS NULL
      OR policy_rotation_artifact_kind = 'policy_rotation'
  ),
  effect_certificate_sha256 TEXT CHECK (
    effect_certificate_sha256 IS NULL OR (
      length(effect_certificate_sha256) = 64
      AND effect_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  reverts_branch_id TEXT,
  reverts_branch_revision INTEGER,
  reverts_authority_revision_sha256 TEXT,
  reverts_branch_kind TEXT,
  reverts_branch_state TEXT,
  admission_world_snapshot_id TEXT CHECK (
    admission_world_snapshot_id IS NULL OR (
      length(CAST(admission_world_snapshot_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(admission_world_snapshot_id, char(0)) = 0
    )
  ),
  admission_world_snapshot_sha256 TEXT CHECK (
    admission_world_snapshot_sha256 IS NULL OR (
      length(admission_world_snapshot_sha256) = 64
      AND admission_world_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_host_task_envelope_sha256 TEXT CHECK (
    admission_host_task_envelope_sha256 IS NULL OR (
      length(admission_host_task_envelope_sha256) = 64
      AND admission_host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_memory_revision INTEGER CHECK (
    admission_memory_revision IS NULL OR admission_memory_revision >= 1
  ),
  admission_memory_commit_id TEXT CHECK (
    admission_memory_commit_id IS NULL OR (
      length(CAST(admission_memory_commit_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(admission_memory_commit_id, char(0)) = 0
    )
  ),
  admission_memory_commit_sha256 TEXT CHECK (
    admission_memory_commit_sha256 IS NULL OR (
      length(admission_memory_commit_sha256) = 64
      AND admission_memory_commit_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_memory_mutation_sha256 TEXT CHECK (
    admission_memory_mutation_sha256 IS NULL OR (
      length(admission_memory_mutation_sha256) = 64
      AND admission_memory_mutation_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_memory_head_sha256 TEXT CHECK (
    admission_memory_head_sha256 IS NULL OR (
      length(admission_memory_head_sha256) = 64
      AND admission_memory_head_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_item_count INTEGER CHECK (
    admission_item_count IS NULL OR admission_item_count BETWEEN 0 AND 4096
  ),
  admission_item_set_sha256 TEXT CHECK (
    admission_item_set_sha256 IS NULL OR (
      length(admission_item_set_sha256) = 64
      AND admission_item_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_relation_count INTEGER CHECK (
    admission_relation_count IS NULL
      OR admission_relation_count BETWEEN 0 AND 4096
  ),
  admission_relation_set_sha256 TEXT CHECK (
    admission_relation_set_sha256 IS NULL OR (
      length(admission_relation_set_sha256) = 64
      AND admission_relation_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  admission_capsule_count INTEGER CHECK (
    admission_capsule_count IS NULL OR admission_capsule_count BETWEEN 0 AND 4096
  ),
  admission_capsule_set_sha256 TEXT CHECK (
    admission_capsule_set_sha256 IS NULL OR (
      length(admission_capsule_set_sha256) = 64
      AND admission_capsule_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  manifest_json TEXT NOT NULL CHECK (
    json_valid(manifest_json)
    AND json_type(manifest_json) = 'object'
    AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (
    tenant_id, authority_subject_sha256, branch_id, branch_revision
  ),
  UNIQUE (tenant_id, authority_subject_sha256, manifest_sha256),
  UNIQUE (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256
  ),
  UNIQUE (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind
  ),
  UNIQUE (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, state
  ),
  UNIQUE (
    tenant_id, authority_subject_sha256, manifest_sha256, branch_kind, state
  ),
  CHECK (
    (admission_world_snapshot_id IS NULL
      AND admission_world_snapshot_sha256 IS NULL
      AND admission_host_task_envelope_sha256 IS NULL
      AND admission_memory_revision IS NULL
      AND admission_memory_commit_id IS NULL
      AND admission_memory_commit_sha256 IS NULL
      AND admission_memory_mutation_sha256 IS NULL
      AND admission_memory_head_sha256 IS NULL
      AND admission_item_count IS NULL
      AND admission_item_set_sha256 IS NULL
      AND admission_relation_count IS NULL
      AND admission_relation_set_sha256 IS NULL
      AND admission_capsule_count IS NULL
      AND admission_capsule_set_sha256 IS NULL)
    OR (admission_world_snapshot_id IS NOT NULL
      AND admission_world_snapshot_sha256 IS NOT NULL
      AND admission_host_task_envelope_sha256 IS NOT NULL
      AND admission_memory_revision IS NOT NULL
      AND admission_memory_commit_id IS NOT NULL
      AND admission_memory_commit_sha256 IS NOT NULL
      AND admission_memory_mutation_sha256 IS NOT NULL
      AND admission_memory_head_sha256 IS NOT NULL
      AND admission_item_count IS NOT NULL
      AND admission_item_set_sha256 IS NOT NULL
      AND admission_relation_count IS NOT NULL
      AND admission_relation_set_sha256 IS NOT NULL
      AND admission_capsule_count IS NOT NULL
      AND admission_capsule_set_sha256 IS NOT NULL)
  ),
  CHECK (
    (source_operation_kind = 'authority_decision'
      AND admission_world_snapshot_id IS NULL
      AND (branch_kind = 'candidate'
        OR (branch_kind = 'authoritative' AND branch_revision > 1)))
    OR (source_operation_kind = 'record_observations'
      AND (
        (branch_kind = 'authoritative'
          AND state = 'authoritative'
          AND branch_revision = 1
          AND admission_world_snapshot_id IS NULL
          AND base_branch_id IS NULL
          AND base_branch_revision IS NULL
          AND base_manifest_sha256 IS NULL
          AND base_branch_kind IS NULL
          AND base_branch_state IS NULL
          AND previous_branch_revision IS NULL
          AND previous_revision_sha256 IS NULL)
        OR (branch_kind = 'candidate'
          AND state = 'draft'
          AND branch_revision = 1
          AND admission_world_snapshot_id IS NOT NULL)
      )
      AND policy_rotation_artifact_sha256 IS NULL
      AND policy_rotation_payload_sha256 IS NULL
      AND policy_rotation_artifact_kind IS NULL
      AND effect_certificate_sha256 IS NULL
      AND reverts_branch_id IS NULL
      AND reverts_branch_revision IS NULL
      AND reverts_authority_revision_sha256 IS NULL
      AND reverts_branch_kind IS NULL
      AND reverts_branch_state IS NULL)
  ),
  CHECK (
    (branch_kind = 'authoritative'
      AND state = 'authoritative'
      AND base_branch_id IS NULL
      AND base_branch_revision IS NULL
      AND base_manifest_sha256 IS NULL
      AND base_branch_kind IS NULL
      AND base_branch_state IS NULL)
    OR (branch_kind = 'candidate'
      AND state IN (
        'draft', 'shadow', 'eligible', 'active_candidate', 'merged',
        'rejected', 'quarantined', 'expired'
      )
      AND base_branch_id IS NOT NULL
      AND branch_id <> base_branch_id
      AND base_branch_revision >= 1
      AND base_manifest_sha256 IS NOT NULL
      AND length(base_manifest_sha256) = 64
      AND base_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND base_branch_kind = 'authoritative'
      AND base_branch_state = 'authoritative')
  ),
  CHECK (
    (branch_revision = 1
      AND previous_branch_revision IS NULL
      AND previous_revision_sha256 IS NULL)
    OR (branch_revision > 1
      AND previous_branch_revision = branch_revision - 1
      AND previous_revision_sha256 IS NOT NULL
      AND length(previous_revision_sha256) = 64
      AND previous_revision_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    (reverts_branch_id IS NULL
      AND reverts_branch_revision IS NULL
      AND reverts_authority_revision_sha256 IS NULL
      AND reverts_branch_kind IS NULL
      AND reverts_branch_state IS NULL)
    OR (branch_kind = 'authoritative'
      AND reverts_branch_id = branch_id
      AND reverts_branch_revision >= 1
      AND reverts_branch_revision < branch_revision
      AND reverts_authority_revision_sha256 IS NOT NULL
      AND length(reverts_authority_revision_sha256) = 64
      AND reverts_authority_revision_sha256 NOT GLOB '*[^0-9a-f]*'
      AND reverts_branch_kind = 'authoritative'
      AND reverts_branch_state = 'authoritative')
  ),
  CHECK (
    (policy_rotation_artifact_sha256 IS NULL
      AND policy_rotation_payload_sha256 IS NULL
      AND policy_rotation_artifact_kind IS NULL)
    OR (policy_rotation_artifact_sha256 IS NOT NULL
      AND policy_rotation_payload_sha256 IS NOT NULL
      AND policy_rotation_artifact_kind = 'policy_rotation')
  ),
  CHECK (
    (effect_certificate_sha256 IS NOT NULL)
      + (reverts_authority_revision_sha256 IS NOT NULL)
      + (policy_rotation_artifact_sha256 IS NOT NULL)
      + (admission_world_snapshot_id IS NOT NULL) <= 1
  ),
  CHECK (
    branch_kind <> 'authoritative'
    OR (branch_revision = 1
      AND effect_certificate_sha256 IS NULL
      AND reverts_authority_revision_sha256 IS NULL
      AND policy_rotation_artifact_sha256 IS NULL
      AND admission_world_snapshot_id IS NULL)
    OR (branch_revision > 1
      AND (effect_certificate_sha256 IS NOT NULL)
        + (reverts_authority_revision_sha256 IS NOT NULL)
        + (policy_rotation_artifact_sha256 IS NOT NULL) = 1
      AND admission_world_snapshot_id IS NULL)
  ),
  CHECK (
    branch_kind <> 'candidate'
    OR (policy_rotation_artifact_sha256 IS NULL
      AND ((state = 'merged' AND effect_certificate_sha256 IS NOT NULL)
        OR (state <> 'merged' AND effect_certificate_sha256 IS NULL))
      AND (admission_world_snapshot_id IS NULL
        OR (state = 'draft' AND branch_revision = 1)))
  ),
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, base_branch_id,
    base_branch_revision, base_manifest_sha256, base_branch_kind,
    base_branch_state
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, state
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, branch_id,
    previous_branch_revision, previous_revision_sha256
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, compiler_policy_artifact_sha256,
    compiler_policy_payload_sha256, compiler_policy_kind
  ) REFERENCES authority_artifacts(
    tenant_id, artifact_sha256, payload_sha256, artifact_kind
  ),
  FOREIGN KEY (
    tenant_id, evidence_policy_artifact_sha256,
    evidence_policy_payload_sha256, evidence_policy_kind
  ) REFERENCES authority_artifacts(
    tenant_id, artifact_sha256, payload_sha256, artifact_kind
  ),
  FOREIGN KEY (
    tenant_id, policy_rotation_artifact_sha256,
    policy_rotation_payload_sha256, policy_rotation_artifact_kind
  ) REFERENCES authority_artifacts(
    tenant_id, artifact_sha256, payload_sha256, artifact_kind
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, effect_certificate_sha256)
    REFERENCES effect_certificates(tenant_id, certificate_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, reverts_branch_id,
    reverts_branch_revision, reverts_authority_revision_sha256,
    reverts_branch_kind, reverts_branch_state
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, state
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, source_operation_scope, admission_world_snapshot_id,
    admission_world_snapshot_sha256
  ) REFERENCES observation_snapshots(
    tenant_id, scope, world_snapshot_id, world_snapshot_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, source_operation_scope, admission_memory_revision,
    admission_memory_commit_id, admission_memory_commit_sha256
  ) REFERENCES memory_commits(
    tenant_id, scope, revision, commit_id, commit_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_branch_revisions_state
  ON branch_revisions(
    tenant_id, authority_subject_sha256, branch_kind, state, created_at DESC,
    branch_id, branch_revision DESC
  );
CREATE INDEX idx_branch_revisions_base
  ON branch_revisions(
    tenant_id, authority_subject_sha256, base_branch_id,
    base_branch_revision, branch_id, branch_revision
  ) WHERE base_branch_id IS NOT NULL;

CREATE TABLE branch_capsule_bindings (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  authority_subject_sha256 TEXT NOT NULL CHECK (
    length(authority_subject_sha256) = 64
    AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  branch_id TEXT NOT NULL CHECK (
    length(CAST(branch_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(branch_id, char(0)) = 0
  ),
  branch_revision INTEGER NOT NULL CHECK (branch_revision >= 1),
  branch_manifest_sha256 TEXT NOT NULL CHECK (
    length(branch_manifest_sha256) = 64
    AND branch_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  branch_kind TEXT NOT NULL CHECK (branch_kind IN (
    'authoritative', 'candidate'
  )),
  capsule_scope TEXT NOT NULL CHECK (
    length(CAST(capsule_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_scope, char(0)) = 0
  ),
  capsule_id TEXT NOT NULL CHECK (
    length(CAST(capsule_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_id, char(0)) = 0
  ),
  capsule_revision INTEGER NOT NULL CHECK (capsule_revision >= 1),
  capsule_sha256 TEXT NOT NULL CHECK (
    length(capsule_sha256) = 64
    AND capsule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'include', 'exclude', 'prohibit'
  )),
  admission_authority TEXT NOT NULL CHECK (admission_authority IN (
    'candidate', 'authoritative'
  )),
  binding_sha256 TEXT NOT NULL CHECK (
    length(binding_sha256) = 64
    AND binding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    capsule_scope, capsule_id, capsule_revision
  ),
  UNIQUE (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    capsule_scope, capsule_id
  ),
  UNIQUE (tenant_id, authority_subject_sha256, binding_sha256),
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    branch_manifest_sha256, branch_kind
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind
  ),
  FOREIGN KEY (
    tenant_id, capsule_scope, capsule_id, capsule_revision, capsule_sha256
  ) REFERENCES capsule_revisions(
    tenant_id, scope, capsule_id, capsule_revision, capsule_sha256
  )
) STRICT;

CREATE INDEX idx_branch_capsule_bindings_capsule
  ON branch_capsule_bindings(
    tenant_id, capsule_scope, capsule_id, capsule_revision,
    authority_subject_sha256, branch_id, branch_revision
  );
CREATE INDEX idx_branch_capsule_bindings_disposition
  ON branch_capsule_bindings(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    disposition, admission_authority, capsule_sha256
  );

CREATE TABLE authority_heads (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  source_operation_scope TEXT NOT NULL CHECK (
    length(CAST(source_operation_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_scope, char(0)) = 0
  ),
  source_operation_kind TEXT NOT NULL CHECK (source_operation_kind IN (
    'record_observations', 'authority_decision'
  )),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authority_subject_sha256 TEXT NOT NULL CHECK (
    length(authority_subject_sha256) = 64
    AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
  branch_id TEXT NOT NULL CHECK (
    length(CAST(branch_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(branch_id, char(0)) = 0
  ),
  branch_revision INTEGER NOT NULL CHECK (branch_revision >= 1),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  branch_kind TEXT NOT NULL CHECK (branch_kind = 'authoritative'),
  branch_state TEXT NOT NULL CHECK (branch_state = 'authoritative'),
  head_sha256 TEXT NOT NULL CHECK (
    length(head_sha256) = 64
    AND head_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  ),
  PRIMARY KEY (tenant_id, authority_subject_sha256),
  UNIQUE (tenant_id, authority_subject_sha256, head_revision, head_sha256),
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, branch_state
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, state
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_authority_heads_branch
  ON authority_heads(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256
  );

CREATE TABLE effect_certificates (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  source_operation_scope TEXT NOT NULL CHECK (
    length(CAST(source_operation_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_scope, char(0)) = 0
  ),
  source_operation_kind TEXT NOT NULL CHECK (
    source_operation_kind = 'worker_completion'
  ),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  certificate_id TEXT NOT NULL CHECK (
    length(CAST(certificate_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(certificate_id, char(0)) = 0
  ),
  certificate_sha256 TEXT NOT NULL CHECK (
    length(certificate_sha256) = 64
    AND certificate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authority_subject_sha256 TEXT NOT NULL CHECK (
    length(authority_subject_sha256) = 64
    AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_cohort_artifact_sha256 TEXT NOT NULL CHECK (
    length(experiment_cohort_artifact_sha256) = 64
    AND experiment_cohort_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_cohort_payload_sha256 TEXT NOT NULL CHECK (
    length(experiment_cohort_payload_sha256) = 64
    AND experiment_cohort_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  experiment_cohort_kind TEXT NOT NULL CHECK (
    experiment_cohort_kind = 'experiment_cohort'
  ),
  experiment_cohort_installation_receipt_sha256 TEXT NOT NULL CHECK (
    length(experiment_cohort_installation_receipt_sha256) = 64
    AND experiment_cohort_installation_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  assignment_seed_commitment_sha256 TEXT NOT NULL CHECK (
    length(assignment_seed_commitment_sha256) = 64
    AND assignment_seed_commitment_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  assignment_seed_reveal BLOB NOT NULL CHECK (
    typeof(assignment_seed_reveal) = 'blob'
    AND length(assignment_seed_reveal) = 32
  ),
  control_branch_id TEXT NOT NULL CHECK (
    length(CAST(control_branch_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(control_branch_id, char(0)) = 0
  ),
  control_branch_revision INTEGER NOT NULL CHECK (control_branch_revision >= 1),
  control_manifest_sha256 TEXT NOT NULL CHECK (
    length(control_manifest_sha256) = 64
    AND control_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  control_branch_kind TEXT NOT NULL CHECK (
    control_branch_kind = 'authoritative'
  ),
  control_branch_state TEXT NOT NULL CHECK (
    control_branch_state = 'authoritative'
  ),
  candidate_branch_id TEXT NOT NULL CHECK (
    length(CAST(candidate_branch_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(candidate_branch_id, char(0)) = 0
  ),
  candidate_branch_revision INTEGER NOT NULL CHECK (
    candidate_branch_revision >= 1
  ),
  candidate_manifest_sha256 TEXT NOT NULL CHECK (
    length(candidate_manifest_sha256) = 64
    AND candidate_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_branch_kind TEXT NOT NULL CHECK (
    candidate_branch_kind = 'candidate'
  ),
  candidate_branch_state TEXT NOT NULL CHECK (
    candidate_branch_state = 'active_candidate'
  ),
  compiler_policy_artifact_sha256 TEXT NOT NULL CHECK (
    length(compiler_policy_artifact_sha256) = 64
    AND compiler_policy_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  compiler_policy_payload_sha256 TEXT NOT NULL CHECK (
    length(compiler_policy_payload_sha256) = 64
    AND compiler_policy_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  compiler_policy_kind TEXT NOT NULL CHECK (
    compiler_policy_kind = 'compiler_policy'
  ),
  evidence_policy_artifact_sha256 TEXT NOT NULL CHECK (
    length(evidence_policy_artifact_sha256) = 64
    AND evidence_policy_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_policy_payload_sha256 TEXT NOT NULL CHECK (
    length(evidence_policy_payload_sha256) = 64
    AND evidence_policy_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_policy_kind TEXT NOT NULL CHECK (
    evidence_policy_kind = 'evidence_policy'
  ),
  evidence_window_sha256 TEXT NOT NULL CHECK (
    length(evidence_window_sha256) = 64
    AND evidence_window_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  effect_verifier_contract_sha256 TEXT NOT NULL CHECK (
    length(effect_verifier_contract_sha256) = 64
    AND effect_verifier_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  statistical_contract_sha256 TEXT NOT NULL CHECK (
    length(statistical_contract_sha256) = 64
    AND statistical_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  eligible_decision_count INTEGER NOT NULL CHECK (
    eligible_decision_count BETWEEN 0 AND 4096
  ),
  eligible_decision_set_sha256 TEXT NOT NULL CHECK (
    length(eligible_decision_set_sha256) = 64
    AND eligible_decision_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  missingness_bps INTEGER NOT NULL CHECK (missingness_bps BETWEEN 0 AND 10000),
  harm_conclusion TEXT NOT NULL CHECK (harm_conclusion IN (
    'safe', 'harmful', 'inconclusive'
  )),
  utility_conclusion TEXT NOT NULL CHECK (utility_conclusion IN (
    'beneficial', 'neutral', 'harmful', 'inconclusive'
  )),
  admission_state TEXT NOT NULL CHECK (admission_state IN (
    'admitted', 'rejected'
  )),
  effect_evaluation_sha256 TEXT NOT NULL CHECK (
    length(effect_evaluation_sha256) = 64
    AND effect_evaluation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  effect_evaluation_json TEXT NOT NULL CHECK (
    json_valid(effect_evaluation_json)
    AND json_type(effect_evaluation_json) = 'object'
    AND length(CAST(effect_evaluation_json AS BLOB)) BETWEEN 2 AND 65536
    AND json_extract(effect_evaluation_json, '$.evaluation_sha256') =
      effect_evaluation_sha256
    AND json_extract(effect_evaluation_json, '$.missingness_bps') =
      missingness_bps
    AND json_extract(effect_evaluation_json, '$.harm_conclusion') =
      harm_conclusion
    AND json_extract(effect_evaluation_json, '$.utility_conclusion') =
      utility_conclusion
    AND json_extract(effect_evaluation_json, '$.admission_state') =
      admission_state
  ),
  treatment_delta_count INTEGER NOT NULL CHECK (
    treatment_delta_count BETWEEN 0 AND 256
  ),
  treatment_delta_set_sha256 TEXT NOT NULL CHECK (
    length(treatment_delta_set_sha256) = 64
    AND treatment_delta_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  certificate_json TEXT NOT NULL CHECK (
    json_valid(certificate_json)
    AND json_type(certificate_json) = 'object'
    AND length(CAST(certificate_json AS BLOB)) BETWEEN 2 AND 262144
    AND json_type(certificate_json, '$.eligible_decisions') IS NULL
    AND json_type(certificate_json, '$.eligible_episodes') IS NULL
    AND json_type(certificate_json, '$.treatment_delta_members') IS NULL
  ),
  verifier_principal_sha256 TEXT NOT NULL CHECK (
    length(verifier_principal_sha256) = 64
    AND verifier_principal_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verifier_public_key_spki_base64url TEXT NOT NULL CHECK (
    length(verifier_public_key_spki_base64url) BETWEEN 40 AND 128
    AND verifier_public_key_spki_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
    AND instr(verifier_public_key_spki_base64url, '=') = 0
  ),
  trust_root_sha256 TEXT NOT NULL CHECK (
    length(trust_root_sha256) = 64
    AND trust_root_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  signature_algorithm TEXT NOT NULL CHECK (
    signature_algorithm = 'ed25519'
  ),
  signature BLOB NOT NULL CHECK (length(signature) = 64),
  window_opened_at TEXT NOT NULL CHECK (
    length(window_opened_at) = 24
    AND window_opened_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', window_opened_at) = window_opened_at
  ),
  window_closed_at TEXT NOT NULL CHECK (
    length(window_closed_at) = 24
    AND window_closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', window_closed_at) = window_closed_at
  ),
  settlement_cutoff_at TEXT NOT NULL CHECK (
    length(settlement_cutoff_at) = 24
    AND settlement_cutoff_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', settlement_cutoff_at) = settlement_cutoff_at
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (tenant_id, certificate_id),
  UNIQUE (tenant_id, certificate_sha256),
  UNIQUE (
    tenant_id, certificate_sha256, treatment_delta_set_sha256
  ),
  UNIQUE (
    tenant_id, certificate_sha256, eligible_decision_set_sha256
  ),
  CHECK (control_manifest_sha256 <> candidate_manifest_sha256),
  CHECK (window_opened_at < window_closed_at),
  CHECK (window_closed_at <= settlement_cutoff_at),
  CHECK (created_at >= settlement_cutoff_at),
  CHECK (
    (eligible_decision_count = 0
      AND eligible_decision_set_sha256 =
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
    OR (eligible_decision_count > 0
      AND eligible_decision_set_sha256 <>
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
  ),
  CHECK (
    (treatment_delta_count = 0
      AND treatment_delta_set_sha256 =
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
    OR (treatment_delta_count > 0
      AND treatment_delta_set_sha256 <>
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
  ),
  CHECK (
    admission_state = 'rejected'
    OR (eligible_decision_count >= 1
      AND harm_conclusion = 'safe'
      AND utility_conclusion = 'beneficial')
  ),
  FOREIGN KEY (
    tenant_id, experiment_cohort_artifact_sha256,
    experiment_cohort_payload_sha256, experiment_cohort_kind
  ) REFERENCES authority_artifacts(
    tenant_id, artifact_sha256, payload_sha256, artifact_kind
  ),
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, control_branch_id,
    control_branch_revision, control_manifest_sha256, control_branch_kind,
    control_branch_state
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, state
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, compiler_policy_artifact_sha256,
    compiler_policy_payload_sha256, compiler_policy_kind
  ) REFERENCES authority_artifacts(
    tenant_id, artifact_sha256, payload_sha256, artifact_kind
  ),
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, candidate_branch_id,
    candidate_branch_revision, candidate_manifest_sha256,
    candidate_branch_kind, candidate_branch_state
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, branch_id, branch_revision,
    manifest_sha256, branch_kind, state
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, evidence_policy_artifact_sha256,
    evidence_policy_payload_sha256, evidence_policy_kind, trust_root_sha256
  ) REFERENCES authority_artifacts(
    tenant_id, artifact_sha256, payload_sha256, artifact_kind,
    trust_root_sha256
  ),
  FOREIGN KEY (
    tenant_id, source_operation_scope, source_operation_kind,
    source_operation_id, source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_effect_certificates_subject
  ON effect_certificates(
    tenant_id, authority_subject_sha256, admission_state, created_at DESC,
    certificate_id
  );
CREATE INDEX idx_effect_certificates_candidate
  ON effect_certificates(
    tenant_id, authority_subject_sha256, candidate_branch_id,
    candidate_branch_revision, created_at DESC
  );

CREATE TABLE effect_certificate_treatment_members (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  certificate_sha256 TEXT NOT NULL CHECK (
    length(certificate_sha256) = 64
    AND certificate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  treatment_delta_set_sha256 TEXT NOT NULL CHECK (
    length(treatment_delta_set_sha256) = 64
    AND treatment_delta_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_sequence INTEGER NOT NULL CHECK (member_sequence BETWEEN 1 AND 256),
  capsule_scope TEXT NOT NULL CHECK (
    length(CAST(capsule_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_scope, char(0)) = 0
  ),
  capsule_id TEXT NOT NULL CHECK (
    length(CAST(capsule_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_id, char(0)) = 0
  ),
  change_kind TEXT NOT NULL CHECK (change_kind IN (
    'added', 'removed', 'changed'
  )),
  before_binding_json TEXT CHECK (
    before_binding_json IS NULL OR (
      json_valid(before_binding_json)
      AND json_type(before_binding_json) = 'object'
      AND length(CAST(before_binding_json AS BLOB)) BETWEEN 2 AND 4096
    )
  ),
  after_binding_json TEXT CHECK (
    after_binding_json IS NULL OR (
      json_valid(after_binding_json)
      AND json_type(after_binding_json) = 'object'
      AND length(CAST(after_binding_json AS BLOB)) BETWEEN 2 AND 4096
    )
  ),
  member_sha256 TEXT NOT NULL CHECK (
    length(member_sha256) = 64
    AND member_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (tenant_id, certificate_sha256, member_sequence),
  UNIQUE (tenant_id, certificate_sha256, member_sha256),
  UNIQUE (
    tenant_id, certificate_sha256, capsule_scope, capsule_id
  ),
  CHECK (
    (change_kind = 'added'
      AND before_binding_json IS NULL AND after_binding_json IS NOT NULL)
    OR (change_kind = 'removed'
      AND before_binding_json IS NOT NULL AND after_binding_json IS NULL)
    OR (change_kind = 'changed'
      AND before_binding_json IS NOT NULL AND after_binding_json IS NOT NULL
      AND before_binding_json <> after_binding_json)
  ),
  CHECK (
    (before_binding_json IS NULL OR (
      json_extract(before_binding_json, '$.capsule_scope') = capsule_scope
      AND json_extract(before_binding_json, '$.capsule.capsule_id') = capsule_id
    ))
    AND (after_binding_json IS NULL OR (
      json_extract(after_binding_json, '$.capsule_scope') = capsule_scope
      AND json_extract(after_binding_json, '$.capsule.capsule_id') = capsule_id
    ))
  ),
  FOREIGN KEY (
    tenant_id, certificate_sha256, treatment_delta_set_sha256
  ) REFERENCES effect_certificates(
    tenant_id, certificate_sha256, treatment_delta_set_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_effect_certificate_treatment_members_capsule
  ON effect_certificate_treatment_members(
    tenant_id, capsule_scope, capsule_id, certificate_sha256, change_kind
  );

CREATE TABLE episode_events (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  episode_id TEXT NOT NULL CHECK (
    length(CAST(episode_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(episode_id, char(0)) = 0
  ),
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  event_id TEXT NOT NULL CHECK (
    length(CAST(event_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(event_id, char(0)) = 0
  ),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'contract_exposed',
    'capsule_use_observed',
    'outcome_observed',
    'effect_certified'
  )),
  source_operation_kind TEXT NOT NULL CHECK (source_operation_kind IN (
    'create_continuation', 'record_outcome', 'worker_completion'
  )),
  source_operation_id TEXT NOT NULL CHECK (
    length(CAST(source_operation_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(source_operation_id, char(0)) = 0
  ),
  source_request_sha256 TEXT NOT NULL CHECK (
    length(source_request_sha256) = 64
    AND source_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_event_sequence INTEGER,
  previous_event_sha256 TEXT,
  cause_event_sequence INTEGER,
  cause_event_id TEXT,
  cause_event_kind TEXT CHECK (
    cause_event_kind IS NULL OR cause_event_kind IN (
      'contract_exposed', 'capsule_use_observed', 'outcome_observed'
    )
  ),
  cause_event_sha256 TEXT,
  effect_member_sequence INTEGER CHECK (
    effect_member_sequence IS NULL
      OR effect_member_sequence BETWEEN 1 AND 4096
  ),
  capsule_fact_count INTEGER CHECK (
    capsule_fact_count IS NULL OR capsule_fact_count BETWEEN 0 AND 256
  ),
  capsule_fact_set_sha256 TEXT CHECK (
    capsule_fact_set_sha256 IS NULL OR (
      length(capsule_fact_set_sha256) = 64
      AND capsule_fact_set_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  decision_id TEXT,
  run_id TEXT,
  host_task_envelope_sha256 TEXT,
  contract_sha256 TEXT,
  coverage_certificate_sha256 TEXT,
  render_result_sha256 TEXT,
  authority_subject_sha256 TEXT,
  branch_manifest_sha256 TEXT,
  serving_mode TEXT CHECK (serving_mode IS NULL OR serving_mode IN (
    'authoritative_unassigned', 'assigned_control', 'assigned_candidate'
  )),
  experiment_cohort_artifact_sha256 TEXT,
  experiment_cohort_payload_sha256 TEXT,
  serving_assignment_receipt_sha256 TEXT,
  effect_certificate_sha256 TEXT,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
    AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  event_sha256 TEXT NOT NULL CHECK (
    length(event_sha256) = 64
    AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (tenant_id, scope, episode_id, event_sequence),
  UNIQUE (tenant_id, scope, episode_id, event_id),
  UNIQUE (tenant_id, scope, episode_id, event_sequence, event_sha256),
  UNIQUE (tenant_id, scope, episode_id, event_id, event_kind),
  UNIQUE (
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind
  ),
  UNIQUE (
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    event_sha256
  ),
  CHECK (
    (event_sequence = 1
      AND previous_event_sequence IS NULL
      AND previous_event_sha256 IS NULL)
    OR (event_sequence > 1
      AND previous_event_sequence = event_sequence - 1
      AND previous_event_sha256 IS NOT NULL
      AND length(previous_event_sha256) = 64
      AND previous_event_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    (event_kind = 'contract_exposed'
      AND source_operation_kind = 'create_continuation')
    OR (event_kind IN ('capsule_use_observed', 'outcome_observed')
      AND source_operation_kind = 'record_outcome')
    OR (event_kind = 'effect_certified'
      AND source_operation_kind = 'worker_completion')
  ),
  CHECK (
    (event_kind = 'contract_exposed'
      AND cause_event_sequence IS NULL
      AND cause_event_id IS NULL
      AND cause_event_kind IS NULL
      AND cause_event_sha256 IS NULL)
    OR (event_kind = 'capsule_use_observed'
      AND cause_event_sequence >= 1
      AND cause_event_sequence < event_sequence
      AND cause_event_id IS NOT NULL
      AND cause_event_kind = 'contract_exposed'
      AND cause_event_sha256 IS NOT NULL)
    OR (event_kind = 'outcome_observed'
      AND cause_event_sequence >= 1
      AND cause_event_sequence < event_sequence
      AND cause_event_id IS NOT NULL
      AND cause_event_kind = 'capsule_use_observed'
      AND cause_event_sha256 IS NOT NULL)
    OR (event_kind = 'effect_certified'
      AND cause_event_sequence >= 1
      AND cause_event_sequence < event_sequence
      AND cause_event_id IS NOT NULL
      AND cause_event_kind IN ('contract_exposed', 'outcome_observed')
      AND cause_event_sha256 IS NOT NULL)
  ),
  CHECK (
    (event_kind = 'effect_certified'
      AND effect_member_sequence BETWEEN 1 AND 4096)
    OR (event_kind <> 'effect_certified'
      AND effect_member_sequence IS NULL)
  ),
  CHECK (
    (event_kind IN ('contract_exposed', 'capsule_use_observed')
      AND capsule_fact_count BETWEEN 0 AND 256
      AND capsule_fact_set_sha256 IS NOT NULL
      AND ((capsule_fact_count = 0
          AND capsule_fact_set_sha256 =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
        OR (capsule_fact_count > 0
          AND capsule_fact_set_sha256 <>
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')))
    OR (event_kind NOT IN ('contract_exposed', 'capsule_use_observed')
      AND capsule_fact_count IS NULL
      AND capsule_fact_set_sha256 IS NULL)
  ),
  CHECK (
    (event_kind = 'contract_exposed'
      AND decision_id IS NOT NULL
      AND run_id IS NOT NULL
      AND host_task_envelope_sha256 IS NOT NULL
      AND contract_sha256 IS NOT NULL
      AND coverage_certificate_sha256 IS NOT NULL
      AND render_result_sha256 IS NOT NULL
      AND authority_subject_sha256 IS NOT NULL
      AND branch_manifest_sha256 IS NOT NULL
      AND effect_certificate_sha256 IS NULL)
    OR (event_kind IN (
        'capsule_use_observed', 'outcome_observed', 'effect_certified'
      )
      AND decision_id IS NOT NULL
      AND run_id IS NOT NULL
      AND host_task_envelope_sha256 IS NOT NULL
      AND contract_sha256 IS NOT NULL
      AND coverage_certificate_sha256 IS NOT NULL
      AND render_result_sha256 IS NOT NULL
      AND authority_subject_sha256 IS NOT NULL
      AND branch_manifest_sha256 IS NOT NULL
      AND ((event_kind = 'effect_certified'
          AND effect_certificate_sha256 IS NOT NULL)
        OR (event_kind <> 'effect_certified'
          AND effect_certificate_sha256 IS NULL)))
  ),
  CHECK (
    decision_id IS NULL OR (
      length(CAST(decision_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(decision_id, char(0)) = 0
    )
  ),
  CHECK (
    run_id IS NULL OR (
      length(CAST(run_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(run_id, char(0)) = 0
    )
  ),
  CHECK (
    cause_event_id IS NULL OR (
      length(CAST(cause_event_id AS BLOB)) BETWEEN 1 AND 256
      AND instr(cause_event_id, char(0)) = 0
    )
  ),
  CHECK (
    cause_event_sha256 IS NULL OR (
      length(cause_event_sha256) = 64
      AND cause_event_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    host_task_envelope_sha256 IS NULL OR (
      length(host_task_envelope_sha256) = 64
      AND host_task_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    contract_sha256 IS NULL OR (
      length(contract_sha256) = 64
      AND contract_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    coverage_certificate_sha256 IS NULL OR (
      length(coverage_certificate_sha256) = 64
      AND coverage_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    render_result_sha256 IS NULL OR (
      length(render_result_sha256) = 64
      AND render_result_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    authority_subject_sha256 IS NULL OR (
      length(authority_subject_sha256) = 64
      AND authority_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    branch_manifest_sha256 IS NULL OR (
      length(branch_manifest_sha256) = 64
      AND branch_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    effect_certificate_sha256 IS NULL OR (
      length(effect_certificate_sha256) = 64
      AND effect_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (event_kind = 'contract_exposed'
      AND serving_mode IS NOT NULL
      AND ((serving_mode = 'authoritative_unassigned'
          AND experiment_cohort_artifact_sha256 IS NULL
          AND experiment_cohort_payload_sha256 IS NULL
          AND serving_assignment_receipt_sha256 IS NULL)
        OR (serving_mode IN ('assigned_control', 'assigned_candidate')
          AND experiment_cohort_artifact_sha256 IS NOT NULL
          AND experiment_cohort_payload_sha256 IS NOT NULL
          AND serving_assignment_receipt_sha256 IS NOT NULL)))
    OR (event_kind <> 'contract_exposed'
      AND serving_mode IS NULL
      AND experiment_cohort_artifact_sha256 IS NULL
      AND experiment_cohort_payload_sha256 IS NULL
      AND serving_assignment_receipt_sha256 IS NULL)
  ),
  CHECK (
    experiment_cohort_artifact_sha256 IS NULL OR (
      length(experiment_cohort_artifact_sha256) = 64
      AND experiment_cohort_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    experiment_cohort_payload_sha256 IS NULL OR (
      length(experiment_cohort_payload_sha256) = 64
      AND experiment_cohort_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    serving_assignment_receipt_sha256 IS NULL OR (
      length(serving_assignment_receipt_sha256) = 64
      AND serving_assignment_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, previous_event_sequence,
    previous_event_sha256
  ) REFERENCES episode_events(
    tenant_id, scope, episode_id, event_sequence, event_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, episode_id, cause_event_sequence, cause_event_id,
    cause_event_kind, cause_event_sha256
  ) REFERENCES episode_events(
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    event_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, authority_subject_sha256, branch_manifest_sha256
  ) REFERENCES branch_revisions(
    tenant_id, authority_subject_sha256, manifest_sha256
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, effect_certificate_sha256)
    REFERENCES effect_certificates(tenant_id, certificate_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, experiment_cohort_artifact_sha256)
    REFERENCES authority_artifacts(tenant_id, artifact_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id, scope, source_operation_kind, source_operation_id,
    source_request_sha256
  ) REFERENCES operations(
    tenant_id, scope, operation_kind, operation_id, request_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX idx_episode_events_decision_exposure
  ON episode_events(tenant_id, scope, decision_id)
  WHERE event_kind = 'contract_exposed';
CREATE INDEX idx_episode_events_cohort_arm
  ON episode_events(
    tenant_id, experiment_cohort_artifact_sha256, serving_mode,
    created_at, scope, decision_id
  )
  WHERE event_kind = 'contract_exposed'
    AND experiment_cohort_artifact_sha256 IS NOT NULL;
CREATE UNIQUE INDEX idx_episode_events_decision_receipt
  ON episode_events(tenant_id, scope, decision_id, event_kind)
  WHERE event_kind IN ('capsule_use_observed', 'outcome_observed');
CREATE UNIQUE INDEX idx_episode_events_operation_event
  ON episode_events(
    tenant_id, scope, source_operation_kind, source_operation_id, event_kind
  ) WHERE event_kind IN (
    'contract_exposed', 'capsule_use_observed', 'outcome_observed'
  );
CREATE UNIQUE INDEX idx_episode_events_effect_member_sequence
  ON episode_events(
    tenant_id, effect_certificate_sha256, effect_member_sequence
  ) WHERE event_kind = 'effect_certified';
CREATE UNIQUE INDEX idx_episode_events_effect_member_decision
  ON episode_events(
    tenant_id, effect_certificate_sha256, scope, decision_id
  ) WHERE event_kind = 'effect_certified';
CREATE INDEX idx_episode_events_run
  ON episode_events(
    tenant_id, scope, run_id, created_at, episode_id, event_sequence
  ) WHERE run_id IS NOT NULL;
CREATE INDEX idx_episode_events_kind
  ON episode_events(
    tenant_id, scope, event_kind, created_at, episode_id, event_sequence
  );
CREATE INDEX idx_episode_events_authority
  ON episode_events(
    tenant_id, authority_subject_sha256, created_at, episode_id,
    event_sequence
  ) WHERE authority_subject_sha256 IS NOT NULL;

CREATE TABLE episode_capsule_facts (
  tenant_id TEXT NOT NULL CHECK (
    length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(tenant_id, char(0)) = 0
  ),
  scope TEXT NOT NULL CHECK (
    length(CAST(scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(scope, char(0)) = 0
  ),
  episode_id TEXT NOT NULL CHECK (
    length(CAST(episode_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(episode_id, char(0)) = 0
  ),
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  event_id TEXT NOT NULL CHECK (
    length(CAST(event_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(event_id, char(0)) = 0
  ),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'contract_exposed', 'capsule_use_observed'
  )),
  event_sha256 TEXT NOT NULL CHECK (
    length(event_sha256) = 64
    AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  fact_sequence INTEGER NOT NULL CHECK (fact_sequence BETWEEN 1 AND 256),
  capsule_scope TEXT NOT NULL CHECK (
    length(CAST(capsule_scope AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_scope, char(0)) = 0
  ),
  capsule_id TEXT NOT NULL CHECK (
    length(CAST(capsule_id AS BLOB)) BETWEEN 1 AND 256
    AND instr(capsule_id, char(0)) = 0
  ),
  capsule_revision INTEGER NOT NULL CHECK (capsule_revision >= 1),
  capsule_sha256 TEXT NOT NULL CHECK (
    length(capsule_sha256) = 64
    AND capsule_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  surface TEXT NOT NULL CHECK (surface IN (
    'use_now', 'inspect_before_use', 'do_not_use', 'rehydrate'
  )),
  use_state TEXT CHECK (
    use_state IS NULL OR use_state IN ('used', 'not_used', 'unknown')
  ),
  fact_sha256 TEXT NOT NULL CHECK (
    length(fact_sha256) = 64
    AND fact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (
    tenant_id, scope, episode_id, event_sequence, fact_sequence
  ),
  UNIQUE (
    tenant_id, scope, episode_id, event_sequence, fact_sha256
  ),
  UNIQUE (
    tenant_id, scope, episode_id, event_sequence, capsule_scope,
    capsule_id, capsule_revision
  ),
  CHECK (
    (event_kind = 'contract_exposed'
      AND use_state IS NULL)
    OR (event_kind = 'capsule_use_observed'
      AND use_state IS NOT NULL)
  ),
  FOREIGN KEY (
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    event_sha256
  ) REFERENCES episode_events(
    tenant_id, scope, episode_id, event_sequence, event_id, event_kind,
    event_sha256
  ),
  FOREIGN KEY (
    tenant_id, capsule_scope, capsule_id, capsule_revision, capsule_sha256
  ) REFERENCES capsule_revisions(
    tenant_id, scope, capsule_id, capsule_revision, capsule_sha256
  ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_episode_capsule_facts_capsule
  ON episode_capsule_facts(
    tenant_id, capsule_scope, capsule_id, capsule_revision,
    episode_id, event_sequence
  );

CREATE TRIGGER runtime_meta_no_update
BEFORE UPDATE OF singleton, database_instance_id, schema_id, schema_version,
  schema_manifest_sha256, created_at ON runtime_meta
BEGIN
  SELECT RAISE(ABORT, 'runtime_meta is immutable');
END;

CREATE TRIGGER runtime_meta_clock_floor_no_regression
BEFORE UPDATE OF authority_clock_floor_at ON runtime_meta
WHEN NEW.authority_clock_floor_at < OLD.authority_clock_floor_at
BEGIN
  SELECT RAISE(ABORT, 'runtime_meta clock floor cannot regress');
END;

CREATE TRIGGER runtime_meta_no_delete
BEFORE DELETE ON runtime_meta
BEGIN
  SELECT RAISE(ABORT, 'runtime_meta is immutable');
END;

CREATE TRIGGER operations_no_update
BEFORE UPDATE ON operations
BEGIN
  SELECT RAISE(ABORT, 'operations is immutable');
END;

CREATE TRIGGER operations_no_delete
BEFORE DELETE ON operations
BEGIN
  SELECT RAISE(ABORT, 'operations is immutable');
END;

CREATE TRIGGER memory_commits_no_update
BEFORE UPDATE ON memory_commits
BEGIN
  SELECT RAISE(ABORT, 'memory_commits is immutable');
END;

CREATE TRIGGER memory_commits_no_delete
BEFORE DELETE ON memory_commits
BEGIN
  SELECT RAISE(ABORT, 'memory_commits is immutable');
END;

CREATE TRIGGER capsule_revisions_no_update
BEFORE UPDATE ON capsule_revisions
BEGIN
  SELECT RAISE(ABORT, 'capsule_revisions is immutable');
END;

CREATE TRIGGER capsule_revisions_no_delete
BEFORE DELETE ON capsule_revisions
BEGIN
  SELECT RAISE(ABORT, 'capsule_revisions is immutable');
END;

CREATE TRIGGER observation_snapshots_no_update
BEFORE UPDATE ON observation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'observation_snapshots is immutable');
END;

CREATE TRIGGER observation_snapshots_no_delete
BEFORE DELETE ON observation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'observation_snapshots is immutable');
END;

CREATE TRIGGER authority_artifacts_no_update
BEFORE UPDATE ON authority_artifacts
BEGIN
  SELECT RAISE(ABORT, 'authority_artifacts is immutable');
END;

CREATE TRIGGER authority_artifacts_no_delete
BEFORE DELETE ON authority_artifacts
BEGIN
  SELECT RAISE(ABORT, 'authority_artifacts is immutable');
END;

CREATE TRIGGER authority_artifacts_experiment_cohort_guard
BEFORE INSERT ON authority_artifacts
WHEN NEW.artifact_kind = 'experiment_cohort'
  AND NOT (
    json_extract(NEW.payload_json, '$.schema_version') =
      'experiment_cohort_v1'
    AND json_extract(NEW.payload_json, '$.tenant_id') = NEW.tenant_id
    AND json_extract(NEW.payload_json, '$.scope') =
      NEW.source_operation_scope
    AND json_extract(NEW.payload_json, '$.authority_subject_sha256') =
      NEW.authority_subject_sha256
    AND json_extract(
      NEW.payload_json,
      '$.assignment_protocol.algorithm'
    ) = 'hmac_sha256_threshold_v1'
    AND json_extract(
      NEW.payload_json,
      '$.assignment_protocol.algorithm_contract_sha256'
    ) = '46d34d5aae649a6cce53074cfcb1c04f41cb715de6228f05b53117e4ac5940a1'
    AND json_extract(
      NEW.payload_json,
      '$.assignment_protocol.basis_schema'
    ) = 'serving_assignment_basis_v1'
    AND length(json_extract(
      NEW.payload_json,
      '$.assignment_protocol.assignment_seed_commitment_sha256'
    )) = 64
    AND json_extract(
      NEW.payload_json,
      '$.assignment_protocol.assignment_seed_commitment_sha256'
    ) NOT GLOB '*[^0-9a-f]*'
    AND json_type(
      NEW.payload_json,
      '$.assignment_protocol.candidate_allocation_bps'
    ) = 'integer'
    AND json_extract(
      NEW.payload_json,
      '$.assignment_protocol.candidate_allocation_bps'
    ) BETWEEN 1 AND 9999
    AND json_type(NEW.payload_json, '$.settlement_grace_ms') = 'integer'
    AND json_extract(NEW.payload_json, '$.settlement_grace_ms')
      BETWEEN 0 AND 604800000
    AND json_extract(NEW.payload_json, '$.assignment_window_opened_at') <
      json_extract(NEW.payload_json, '$.assignment_window_closed_at')
    AND json_extract(NEW.payload_json, '$.assignment_window_closed_at') <=
      json_extract(NEW.payload_json, '$.outcome_deadline')
    AND json_extract(NEW.payload_json, '$.outcome_deadline') <=
      json_extract(NEW.payload_json, '$.settlement_cutoff_at')
    AND NEW.created_at <
      json_extract(NEW.payload_json, '$.assignment_window_opened_at')
    AND NEW.valid_from <=
      json_extract(NEW.payload_json, '$.assignment_window_opened_at')
    AND NEW.expires_at IS NOT NULL
    AND NEW.expires_at >=
      json_extract(NEW.payload_json, '$.settlement_cutoff_at')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid experiment cohort authority artifact');
END;

CREATE TRIGGER authority_artifacts_experiment_cohort_learning_pair_guard
BEFORE INSERT ON authority_artifacts
WHEN NEW.artifact_kind = 'experiment_cohort'
  AND NOT EXISTS (
    SELECT 1
    FROM authority_heads AS head
    JOIN branch_revisions AS control
      ON control.tenant_id = head.tenant_id
     AND control.authority_subject_sha256 = head.authority_subject_sha256
     AND control.branch_id = head.branch_id
     AND control.branch_revision = head.branch_revision
     AND control.manifest_sha256 = head.manifest_sha256
     AND control.branch_kind = 'authoritative'
     AND control.state = 'authoritative'
    JOIN branch_revisions AS candidate
      ON candidate.tenant_id = control.tenant_id
     AND candidate.authority_subject_sha256 =
       control.authority_subject_sha256
     AND candidate.branch_id = json_extract(
       NEW.payload_json, '$.candidate_learning_ref.branch_id'
     )
     AND candidate.branch_revision = json_extract(
       NEW.payload_json, '$.candidate_learning_ref.branch_revision'
     )
     AND candidate.manifest_sha256 = json_extract(
       NEW.payload_json, '$.candidate_learning_ref.manifest_sha256'
     )
     AND candidate.branch_kind = 'candidate'
     AND candidate.state = 'active_candidate'
     AND candidate.base_branch_id = control.branch_id
     AND candidate.base_branch_revision = control.branch_revision
     AND candidate.base_manifest_sha256 = control.manifest_sha256
    JOIN authority_artifacts AS compiler_policy
      ON compiler_policy.tenant_id = control.tenant_id
     AND compiler_policy.artifact_sha256 =
       control.compiler_policy_artifact_sha256
     AND compiler_policy.payload_sha256 =
       control.compiler_policy_payload_sha256
     AND compiler_policy.artifact_kind = 'compiler_policy'
    JOIN authority_artifacts AS evidence_policy
      ON evidence_policy.tenant_id = control.tenant_id
     AND evidence_policy.artifact_sha256 =
       control.evidence_policy_artifact_sha256
     AND evidence_policy.payload_sha256 =
       control.evidence_policy_payload_sha256
     AND evidence_policy.artifact_kind = 'evidence_policy'
    WHERE head.tenant_id = NEW.tenant_id
      AND head.authority_subject_sha256 = NEW.authority_subject_sha256
      AND control.branch_id = json_extract(
        NEW.payload_json, '$.control_learning_ref.branch_id'
      )
      AND control.branch_revision = json_extract(
        NEW.payload_json, '$.control_learning_ref.branch_revision'
      )
      AND control.manifest_sha256 = json_extract(
        NEW.payload_json, '$.control_learning_ref.manifest_sha256'
      )
      AND control.compiler_policy_artifact_sha256 = json_extract(
        NEW.payload_json, '$.compiler_policy_ref.artifact_sha256'
      )
      AND control.compiler_policy_payload_sha256 = json_extract(
        NEW.payload_json, '$.compiler_policy_ref.payload_sha256'
      )
      AND candidate.compiler_policy_artifact_sha256 =
        control.compiler_policy_artifact_sha256
      AND candidate.compiler_policy_payload_sha256 =
        control.compiler_policy_payload_sha256
      AND control.evidence_policy_artifact_sha256 = json_extract(
        NEW.payload_json, '$.evidence_policy_ref.artifact_sha256'
      )
      AND control.evidence_policy_payload_sha256 = json_extract(
        NEW.payload_json, '$.evidence_policy_ref.payload_sha256'
      )
      AND candidate.evidence_policy_artifact_sha256 =
        control.evidence_policy_artifact_sha256
      AND candidate.evidence_policy_payload_sha256 =
        control.evidence_policy_payload_sha256
      AND compiler_policy.valid_from <= json_extract(
        NEW.payload_json, '$.assignment_window_opened_at'
      )
      AND (compiler_policy.expires_at IS NULL
        OR json_extract(
          NEW.payload_json, '$.assignment_window_closed_at'
        ) < compiler_policy.expires_at)
      AND evidence_policy.valid_from <= json_extract(
        NEW.payload_json, '$.assignment_window_opened_at'
      )
      AND (evidence_policy.expires_at IS NULL
        OR json_extract(
          NEW.payload_json, '$.settlement_cutoff_at'
        ) < evidence_policy.expires_at)
      AND json_type(
        compiler_policy.payload_json, '$.learning_candidate_limit'
      ) = 'integer'
      AND json_type(
        evidence_policy.payload_json, '$.max_treatment_delta_count'
      ) = 'integer'
      AND (SELECT COUNT(*)
        FROM branch_capsule_bindings AS control_binding
        WHERE control_binding.tenant_id = control.tenant_id
          AND control_binding.authority_subject_sha256 =
            control.authority_subject_sha256
          AND control_binding.branch_id = control.branch_id
          AND control_binding.branch_revision = control.branch_revision
      ) <= json_extract(
        compiler_policy.payload_json, '$.learning_candidate_limit'
      )
      AND (SELECT COUNT(*)
        FROM branch_capsule_bindings AS candidate_binding
        WHERE candidate_binding.tenant_id = candidate.tenant_id
          AND candidate_binding.authority_subject_sha256 =
            candidate.authority_subject_sha256
          AND candidate_binding.branch_id = candidate.branch_id
          AND candidate_binding.branch_revision = candidate.branch_revision
      ) <= json_extract(
        compiler_policy.payload_json, '$.learning_candidate_limit'
      )
      AND (SELECT COUNT(*)
        FROM (
          SELECT control_identity.capsule_scope, control_identity.capsule_id
          FROM branch_capsule_bindings AS control_identity
          WHERE control_identity.tenant_id = control.tenant_id
            AND control_identity.authority_subject_sha256 =
              control.authority_subject_sha256
            AND control_identity.branch_id = control.branch_id
            AND control_identity.branch_revision = control.branch_revision
          UNION
          SELECT candidate_identity.capsule_scope, candidate_identity.capsule_id
          FROM branch_capsule_bindings AS candidate_identity
          WHERE candidate_identity.tenant_id = candidate.tenant_id
            AND candidate_identity.authority_subject_sha256 =
              candidate.authority_subject_sha256
            AND candidate_identity.branch_id = candidate.branch_id
            AND candidate_identity.branch_revision = candidate.branch_revision
        ) AS treatment_identity
        WHERE NOT EXISTS (
          SELECT 1
          FROM branch_capsule_bindings AS control_binding
          JOIN branch_capsule_bindings AS candidate_binding
            ON candidate_binding.tenant_id = control_binding.tenant_id
           AND candidate_binding.authority_subject_sha256 =
             control_binding.authority_subject_sha256
           AND candidate_binding.capsule_scope =
             control_binding.capsule_scope
           AND candidate_binding.capsule_id = control_binding.capsule_id
           AND candidate_binding.capsule_revision =
             control_binding.capsule_revision
           AND candidate_binding.capsule_sha256 =
             control_binding.capsule_sha256
           AND candidate_binding.disposition = control_binding.disposition
           AND candidate_binding.admission_authority =
             control_binding.admission_authority
           AND candidate_binding.branch_id = candidate.branch_id
           AND candidate_binding.branch_revision = candidate.branch_revision
          WHERE control_binding.tenant_id = control.tenant_id
            AND control_binding.authority_subject_sha256 =
              control.authority_subject_sha256
            AND control_binding.branch_id = control.branch_id
            AND control_binding.branch_revision = control.branch_revision
            AND control_binding.capsule_scope = treatment_identity.capsule_scope
            AND control_binding.capsule_id = treatment_identity.capsule_id
        )
      ) BETWEEN 1 AND json_extract(
        evidence_policy.payload_json, '$.max_treatment_delta_count'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM branch_revisions AS newer_candidate
        WHERE newer_candidate.tenant_id = candidate.tenant_id
          AND newer_candidate.authority_subject_sha256 =
            candidate.authority_subject_sha256
          AND newer_candidate.branch_id = candidate.branch_id
          AND newer_candidate.branch_revision > candidate.branch_revision
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'experiment cohort learning pair exceeds or drifts from frozen policy'
  );
END;

CREATE TRIGGER authority_artifacts_experiment_cohort_overlap_guard
BEFORE INSERT ON authority_artifacts
WHEN NEW.artifact_kind = 'experiment_cohort'
  AND EXISTS (
    SELECT 1
    FROM authority_artifacts AS existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.artifact_kind = 'experiment_cohort'
      AND existing.authority_subject_sha256 = NEW.authority_subject_sha256
      AND json_extract(
        existing.payload_json,
        '$.assignment_window_opened_at'
      ) < json_extract(
        NEW.payload_json,
        '$.assignment_window_closed_at'
      )
      AND json_extract(
        NEW.payload_json,
        '$.assignment_window_opened_at'
      ) < json_extract(
        existing.payload_json,
        '$.assignment_window_closed_at'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'overlapping experiment cohort for authority subject');
END;

CREATE TRIGGER branch_revisions_no_update
BEFORE UPDATE ON branch_revisions
BEGIN
  SELECT RAISE(ABORT, 'branch_revisions is immutable');
END;

CREATE TRIGGER branch_revisions_no_delete
BEFORE DELETE ON branch_revisions
BEGIN
  SELECT RAISE(ABORT, 'branch_revisions is immutable');
END;

CREATE TRIGGER branch_capsule_bindings_learning_capacity_guard
BEFORE INSERT ON branch_capsule_bindings
WHEN EXISTS (
    SELECT 1
    FROM branch_revisions AS branch
    WHERE branch.tenant_id = NEW.tenant_id
      AND branch.authority_subject_sha256 = NEW.authority_subject_sha256
      AND branch.branch_id = NEW.branch_id
      AND branch.branch_revision = NEW.branch_revision
      AND branch.manifest_sha256 = NEW.branch_manifest_sha256
      AND branch.branch_kind = NEW.branch_kind
      AND (branch.branch_kind = 'authoritative'
        OR branch.state IN ('eligible', 'active_candidate', 'merged'))
  )
  AND NOT EXISTS (
    SELECT 1
    FROM branch_revisions AS branch
    JOIN authority_artifacts AS compiler_policy
      ON compiler_policy.tenant_id = branch.tenant_id
     AND compiler_policy.artifact_sha256 =
       branch.compiler_policy_artifact_sha256
     AND compiler_policy.payload_sha256 =
       branch.compiler_policy_payload_sha256
     AND compiler_policy.artifact_kind = 'compiler_policy'
    WHERE branch.tenant_id = NEW.tenant_id
      AND branch.authority_subject_sha256 = NEW.authority_subject_sha256
      AND branch.branch_id = NEW.branch_id
      AND branch.branch_revision = NEW.branch_revision
      AND branch.manifest_sha256 = NEW.branch_manifest_sha256
      AND branch.branch_kind = NEW.branch_kind
      AND json_type(
        compiler_policy.payload_json, '$.learning_candidate_limit'
      ) = 'integer'
      AND (SELECT COUNT(*)
        FROM branch_capsule_bindings AS existing
        WHERE existing.tenant_id = NEW.tenant_id
          AND existing.authority_subject_sha256 =
            NEW.authority_subject_sha256
          AND existing.branch_id = NEW.branch_id
          AND existing.branch_revision = NEW.branch_revision
      ) < json_extract(
        compiler_policy.payload_json, '$.learning_candidate_limit'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'learning branch exceeds compiler policy capacity');
END;

CREATE TRIGGER branch_capsule_bindings_no_update
BEFORE UPDATE ON branch_capsule_bindings
BEGIN
  SELECT RAISE(ABORT, 'branch_capsule_bindings is immutable');
END;

CREATE TRIGGER branch_capsule_bindings_no_delete
BEFORE DELETE ON branch_capsule_bindings
BEGIN
  SELECT RAISE(ABORT, 'branch_capsule_bindings is immutable');
END;

CREATE TRIGGER effect_certificates_no_update
BEFORE UPDATE ON effect_certificates
BEGIN
  SELECT RAISE(ABORT, 'effect_certificates is immutable');
END;

CREATE TRIGGER effect_certificates_no_delete
BEFORE DELETE ON effect_certificates
BEGIN
  SELECT RAISE(ABORT, 'effect_certificates is immutable');
END;

CREATE TRIGGER effect_certificate_treatment_members_no_update
BEFORE UPDATE ON effect_certificate_treatment_members
BEGIN
  SELECT RAISE(ABORT, 'effect_certificate_treatment_members is immutable');
END;

CREATE TRIGGER effect_certificate_treatment_members_no_delete
BEFORE DELETE ON effect_certificate_treatment_members
BEGIN
  SELECT RAISE(ABORT, 'effect_certificate_treatment_members is immutable');
END;

CREATE TRIGGER episode_events_no_update
BEFORE UPDATE ON episode_events
BEGIN
  SELECT RAISE(ABORT, 'episode_events is immutable');
END;

CREATE TRIGGER episode_events_no_delete
BEFORE DELETE ON episode_events
BEGIN
  SELECT RAISE(ABORT, 'episode_events is immutable');
END;

CREATE TRIGGER episode_capsule_facts_no_update
BEFORE UPDATE ON episode_capsule_facts
BEGIN
  SELECT RAISE(ABORT, 'episode_capsule_facts is immutable');
END;

CREATE TRIGGER episode_capsule_facts_no_delete
BEFORE DELETE ON episode_capsule_facts
BEGIN
  SELECT RAISE(ABORT, 'episode_capsule_facts is immutable');
END;

CREATE TRIGGER durable_jobs_source_operation_fence
BEFORE INSERT ON durable_jobs
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'durable_jobs source operation is already completed');
END;

CREATE TRIGGER durable_jobs_effect_cohort_authority_guard
BEFORE INSERT ON durable_jobs
WHEN NEW.job_kind = 'effect'
BEGIN
  SELECT RAISE(ABORT, 'effect job must be the exact cohort settlement job')
  WHERE NEW.source_operation_kind <> 'authority_decision'
    OR NEW.priority <> 0
    OR NEW.max_attempts <> 8
    OR json_extract(NEW.payload_json, '$.schema_version') <>
      'effect_settlement_job_v1'
    OR NOT EXISTS (
      SELECT 1
      FROM authority_artifacts AS cohort
      WHERE cohort.tenant_id = NEW.tenant_id
        AND cohort.source_operation_scope = NEW.scope
        AND cohort.source_operation_kind = NEW.source_operation_kind
        AND cohort.source_operation_id = NEW.source_operation_id
        AND cohort.source_request_sha256 = NEW.source_request_sha256
        AND cohort.artifact_kind = 'experiment_cohort'
        AND cohort.authority_subject_sha256 = NEW.authority_subject_sha256
        AND json_extract(cohort.payload_json, '$.task_family') = NEW.task_family
        AND NEW.dedupe_key = 'experiment-cohort:' || cohort.artifact_sha256
        AND NEW.initial_available_at =
          json_extract(cohort.payload_json, '$.settlement_cutoff_at')
        AND NEW.available_at =
          json_extract(cohort.payload_json, '$.settlement_cutoff_at')
        AND NEW.created_at >= cohort.created_at
        AND NEW.created_at <
          json_extract(cohort.payload_json, '$.assignment_window_opened_at')
        AND json_extract(
          NEW.payload_json, '$.experiment_cohort_ref.artifact_sha256'
        ) = cohort.artifact_sha256
        AND json_extract(
          NEW.payload_json, '$.experiment_cohort_ref.payload_sha256'
        ) = cohort.payload_sha256
        AND json_extract(NEW.payload_json, '$.cohort_id') =
          json_extract(cohort.payload_json, '$.cohort_id')
        AND json_extract(NEW.payload_json, '$.assignment_window_opened_at') =
          json_extract(cohort.payload_json, '$.assignment_window_opened_at')
        AND json_extract(NEW.payload_json, '$.assignment_window_closed_at') =
          json_extract(cohort.payload_json, '$.assignment_window_closed_at')
        AND json_extract(NEW.payload_json, '$.outcome_deadline') =
          json_extract(cohort.payload_json, '$.outcome_deadline')
        AND json_extract(NEW.payload_json, '$.settlement_cutoff_at') =
          json_extract(cohort.payload_json, '$.settlement_cutoff_at')
        AND json_extract(NEW.payload_json, '$.control_learning_ref') =
          json_extract(cohort.payload_json, '$.control_learning_ref')
        AND json_extract(NEW.payload_json, '$.candidate_learning_ref') =
          json_extract(cohort.payload_json, '$.candidate_learning_ref')
        AND json_extract(NEW.payload_json, '$.compiler_policy_ref') =
          json_extract(cohort.payload_json, '$.compiler_policy_ref')
        AND json_extract(NEW.payload_json, '$.evidence_policy_ref') =
          json_extract(cohort.payload_json, '$.evidence_policy_ref')
    );
END;

CREATE TRIGGER memory_commits_source_operation_fence
BEFORE INSERT ON memory_commits
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'memory_commits source operation is already completed');
END;

CREATE TRIGGER memory_scope_heads_source_operation_insert_fence
BEFORE INSERT ON memory_scope_heads
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_heads source operation is already completed');
END;

CREATE TRIGGER memory_scope_heads_source_operation_update_fence
BEFORE UPDATE ON memory_scope_heads
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_heads source operation is already completed');
END;

CREATE TRIGGER observation_snapshots_source_operation_fence
BEFORE INSERT ON observation_snapshots
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'observation_snapshots source operation is already completed');
END;

CREATE TRIGGER authority_artifacts_source_operation_fence
BEFORE INSERT ON authority_artifacts
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.source_operation_scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'authority_artifacts source operation is already completed');
END;

CREATE TRIGGER operations_experiment_cohort_install_before_open_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'authority_decision'
  AND EXISTS (
    SELECT 1
    FROM authority_artifacts AS cohort
    WHERE cohort.tenant_id = NEW.tenant_id
      AND cohort.source_operation_scope = NEW.scope
      AND cohort.source_operation_kind = NEW.operation_kind
      AND cohort.source_operation_id = NEW.operation_id
      AND cohort.source_request_sha256 = NEW.request_sha256
      AND cohort.artifact_kind = 'experiment_cohort'
      AND NEW.completed_at >= json_extract(
        cohort.payload_json,
        '$.assignment_window_opened_at'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'experiment cohort must be installed before its window');
END;

CREATE TRIGGER branch_revisions_source_operation_fence
BEFORE INSERT ON branch_revisions
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.source_operation_scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'branch_revisions source operation is already completed');
END;

CREATE TRIGGER branch_capsule_bindings_source_operation_fence
BEFORE INSERT ON branch_capsule_bindings
WHEN EXISTS (
  SELECT 1
  FROM branch_revisions AS branch
  JOIN operations AS completed
    ON completed.tenant_id = branch.tenant_id
    AND completed.scope = branch.source_operation_scope
    AND completed.operation_kind = branch.source_operation_kind
    AND completed.operation_id = branch.source_operation_id
    AND completed.request_sha256 = branch.source_request_sha256
  WHERE branch.tenant_id = NEW.tenant_id
    AND branch.authority_subject_sha256 = NEW.authority_subject_sha256
    AND branch.branch_id = NEW.branch_id
    AND branch.branch_revision = NEW.branch_revision
    AND branch.manifest_sha256 = NEW.branch_manifest_sha256
    AND branch.branch_kind = NEW.branch_kind
)
BEGIN
  SELECT RAISE(
    ABORT,
    'branch_capsule_bindings cannot follow the operation receipt'
  );
END;

CREATE TRIGGER authority_heads_source_operation_insert_fence
BEFORE INSERT ON authority_heads
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.source_operation_scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'authority_heads source operation is already completed');
END;

CREATE TRIGGER authority_heads_source_operation_update_fence
BEFORE UPDATE ON authority_heads
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.source_operation_scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'authority_heads source operation is already completed');
END;

CREATE TRIGGER effect_certificates_source_operation_fence
BEFORE INSERT ON effect_certificates
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.source_operation_scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'effect_certificates source operation is already completed');
END;

CREATE TRIGGER effect_certificate_treatment_members_source_operation_fence
BEFORE INSERT ON effect_certificate_treatment_members
WHEN EXISTS (
  SELECT 1
  FROM effect_certificates AS certificate
  JOIN operations AS completed
    ON completed.tenant_id = certificate.tenant_id
    AND completed.scope = certificate.source_operation_scope
    AND completed.operation_kind = certificate.source_operation_kind
    AND completed.operation_id = certificate.source_operation_id
    AND completed.request_sha256 = certificate.source_request_sha256
  WHERE certificate.tenant_id = NEW.tenant_id
    AND certificate.certificate_sha256 = NEW.certificate_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'effect certificate treatment members cannot follow the operation receipt');
END;

CREATE TRIGGER operations_effect_certificate_sets_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'worker_completion'
  AND EXISTS (
    SELECT 1
    FROM effect_certificates AS certificate
    WHERE certificate.tenant_id = NEW.tenant_id
      AND certificate.source_operation_scope = NEW.scope
      AND certificate.source_operation_kind = NEW.operation_kind
      AND certificate.source_operation_id = NEW.operation_id
      AND certificate.source_request_sha256 = NEW.request_sha256
      AND ((
          SELECT count(*)
          FROM episode_events AS member
          WHERE member.tenant_id = certificate.tenant_id
            AND member.effect_certificate_sha256 =
              certificate.certificate_sha256
            AND member.event_kind = 'effect_certified'
        ) <> certificate.eligible_decision_count
        OR coalesce((
          SELECT min(member.effect_member_sequence)
          FROM episode_events AS member
          WHERE member.tenant_id = certificate.tenant_id
            AND member.effect_certificate_sha256 =
              certificate.certificate_sha256
            AND member.event_kind = 'effect_certified'
        ), 0) <> CASE
          WHEN certificate.eligible_decision_count = 0 THEN 0 ELSE 1 END
        OR coalesce((
          SELECT max(member.effect_member_sequence)
          FROM episode_events AS member
          WHERE member.tenant_id = certificate.tenant_id
            AND member.effect_certificate_sha256 =
              certificate.certificate_sha256
            AND member.event_kind = 'effect_certified'
        ), 0) <> certificate.eligible_decision_count
        OR (
          SELECT count(*)
          FROM effect_certificate_treatment_members AS treatment
          WHERE treatment.tenant_id = certificate.tenant_id
            AND treatment.certificate_sha256 = certificate.certificate_sha256
        ) <> certificate.treatment_delta_count
        OR coalesce((
          SELECT min(treatment.member_sequence)
          FROM effect_certificate_treatment_members AS treatment
          WHERE treatment.tenant_id = certificate.tenant_id
            AND treatment.certificate_sha256 = certificate.certificate_sha256
        ), 0) <> CASE
          WHEN certificate.treatment_delta_count = 0 THEN 0 ELSE 1 END
        OR coalesce((
          SELECT max(treatment.member_sequence)
          FROM effect_certificate_treatment_members AS treatment
          WHERE treatment.tenant_id = certificate.tenant_id
            AND treatment.certificate_sha256 = certificate.certificate_sha256
        ), 0) <> certificate.treatment_delta_count)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'effect certificate member or treatment delta set is incomplete'
  );
END;

CREATE TRIGGER operations_effect_job_certificate_authority_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'worker_completion'
  AND (
    EXISTS (
      SELECT 1 FROM effect_certificates AS certificate
      WHERE certificate.tenant_id = NEW.tenant_id
        AND certificate.source_operation_scope = NEW.scope
        AND certificate.source_operation_id = NEW.operation_id
        AND certificate.source_request_sha256 = NEW.request_sha256
    )
    OR EXISTS (
      SELECT 1 FROM durable_jobs AS job
      WHERE job.tenant_id = NEW.tenant_id
        AND job.scope = NEW.scope
        AND job.job_kind = 'effect'
        AND job.completion_operation_kind = NEW.operation_kind
        AND job.completion_operation_id = NEW.operation_id
        AND job.completion_request_sha256 = NEW.request_sha256
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM durable_jobs AS job
    JOIN effect_certificates AS certificate
      ON certificate.tenant_id = job.tenant_id
     AND certificate.source_operation_scope = job.scope
     AND certificate.source_operation_kind = job.completion_operation_kind
     AND certificate.source_operation_id = job.completion_operation_id
     AND certificate.source_request_sha256 = job.completion_request_sha256
     AND certificate.authority_subject_sha256 = job.authority_subject_sha256
     AND certificate.experiment_cohort_artifact_sha256 = json_extract(
       job.payload_json, '$.experiment_cohort_ref.artifact_sha256'
     )
     AND certificate.experiment_cohort_payload_sha256 = json_extract(
       job.payload_json, '$.experiment_cohort_ref.payload_sha256'
     )
     AND certificate.control_branch_id = json_extract(
       job.payload_json, '$.control_learning_ref.branch_id'
     )
     AND certificate.control_branch_revision = json_extract(
       job.payload_json, '$.control_learning_ref.branch_revision'
     )
     AND certificate.control_manifest_sha256 = json_extract(
       job.payload_json, '$.control_learning_ref.manifest_sha256'
     )
     AND certificate.candidate_branch_id = json_extract(
       job.payload_json, '$.candidate_learning_ref.branch_id'
     )
     AND certificate.candidate_branch_revision = json_extract(
       job.payload_json, '$.candidate_learning_ref.branch_revision'
     )
     AND certificate.candidate_manifest_sha256 = json_extract(
       job.payload_json, '$.candidate_learning_ref.manifest_sha256'
     )
     AND certificate.compiler_policy_artifact_sha256 = json_extract(
       job.payload_json, '$.compiler_policy_ref.artifact_sha256'
     )
     AND certificate.compiler_policy_payload_sha256 = json_extract(
       job.payload_json, '$.compiler_policy_ref.payload_sha256'
     )
     AND certificate.evidence_policy_artifact_sha256 = json_extract(
       job.payload_json, '$.evidence_policy_ref.artifact_sha256'
     )
     AND certificate.evidence_policy_payload_sha256 = json_extract(
       job.payload_json, '$.evidence_policy_ref.payload_sha256'
     )
     AND certificate.settlement_cutoff_at = job.initial_available_at
     AND certificate.created_at >= job.initial_available_at
    WHERE job.tenant_id = NEW.tenant_id
      AND job.scope = NEW.scope
      AND job.job_kind = 'effect'
      AND job.state = 'succeeded'
      AND job.completion_operation_kind = NEW.operation_kind
      AND job.completion_operation_id = NEW.operation_id
      AND job.completion_request_sha256 = NEW.request_sha256
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'effect worker completion must bind its exact cohort job and certificate'
  );
END;

CREATE TRIGGER operations_policy_rotation_bindings_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'authority_decision'
  AND EXISTS (
    SELECT 1
    FROM branch_revisions AS rotation
    WHERE rotation.tenant_id = NEW.tenant_id
      AND rotation.source_operation_scope = NEW.scope
      AND rotation.source_operation_kind = NEW.operation_kind
      AND rotation.source_operation_id = NEW.operation_id
      AND rotation.source_request_sha256 = NEW.request_sha256
      AND rotation.policy_rotation_artifact_sha256 IS NOT NULL
      AND (
        EXISTS (
          SELECT 1
          FROM branch_capsule_bindings AS previous_binding
          WHERE previous_binding.tenant_id = rotation.tenant_id
            AND previous_binding.authority_subject_sha256 =
              rotation.authority_subject_sha256
            AND previous_binding.branch_id = rotation.branch_id
            AND previous_binding.branch_revision =
              rotation.previous_branch_revision
            AND NOT EXISTS (
              SELECT 1
              FROM branch_capsule_bindings AS rotated_binding
              WHERE rotated_binding.tenant_id = previous_binding.tenant_id
                AND rotated_binding.authority_subject_sha256 =
                  previous_binding.authority_subject_sha256
                AND rotated_binding.branch_id = previous_binding.branch_id
                AND rotated_binding.branch_revision =
                  rotation.branch_revision
                AND rotated_binding.capsule_scope =
                  previous_binding.capsule_scope
                AND rotated_binding.capsule_id = previous_binding.capsule_id
                AND rotated_binding.capsule_revision =
                  previous_binding.capsule_revision
                AND rotated_binding.capsule_sha256 =
                  previous_binding.capsule_sha256
                AND rotated_binding.disposition =
                  previous_binding.disposition
                AND rotated_binding.admission_authority =
                  previous_binding.admission_authority
            )
        )
        OR EXISTS (
          SELECT 1
          FROM branch_capsule_bindings AS rotated_binding
          WHERE rotated_binding.tenant_id = rotation.tenant_id
            AND rotated_binding.authority_subject_sha256 =
              rotation.authority_subject_sha256
            AND rotated_binding.branch_id = rotation.branch_id
            AND rotated_binding.branch_revision = rotation.branch_revision
            AND NOT EXISTS (
              SELECT 1
              FROM branch_capsule_bindings AS previous_binding
              WHERE previous_binding.tenant_id = rotated_binding.tenant_id
                AND previous_binding.authority_subject_sha256 =
                  rotated_binding.authority_subject_sha256
                AND previous_binding.branch_id = rotated_binding.branch_id
                AND previous_binding.branch_revision =
                  rotation.previous_branch_revision
                AND previous_binding.capsule_scope =
                  rotated_binding.capsule_scope
                AND previous_binding.capsule_id = rotated_binding.capsule_id
                AND previous_binding.capsule_revision =
                  rotated_binding.capsule_revision
                AND previous_binding.capsule_sha256 =
                  rotated_binding.capsule_sha256
                AND previous_binding.disposition =
                  rotated_binding.disposition
                AND previous_binding.admission_authority =
                  rotated_binding.admission_authority
            )
        )
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'policy rotation must preserve exact capsule bindings'
  );
END;

CREATE TRIGGER episode_events_serving_authority_guard
BEFORE INSERT ON episode_events
WHEN NEW.event_kind = 'contract_exposed'
  AND NOT (
    (NEW.serving_mode = 'authoritative_unassigned'
      AND NEW.experiment_cohort_artifact_sha256 IS NULL
      AND json_type(
        NEW.payload_json,
        '$.continuation_contract.authority.experiment_cohort_ref'
      ) = 'null'
      AND json_type(
        NEW.payload_json,
        '$.continuation_contract.authority.serving_assignment_receipt'
      ) = 'null'
      AND json_extract(
        NEW.payload_json,
        '$.continuation_contract.authority.authoritative_learning_head.manifest_sha256'
      ) = NEW.branch_manifest_sha256
      AND json_extract(
        NEW.payload_json,
        '$.continuation_contract.authority.served_learning_branch.manifest_sha256'
      ) = NEW.branch_manifest_sha256)
    OR (NEW.serving_mode IN ('assigned_control', 'assigned_candidate')
      AND EXISTS (
        SELECT 1
        FROM authority_artifacts AS cohort_artifact
        JOIN authority_heads AS authority_head
          ON authority_head.tenant_id = NEW.tenant_id
         AND authority_head.authority_subject_sha256 = NEW.authority_subject_sha256
        JOIN branch_revisions AS control_branch
          ON control_branch.tenant_id = authority_head.tenant_id
         AND control_branch.authority_subject_sha256 = authority_head.authority_subject_sha256
         AND control_branch.branch_id = authority_head.branch_id
         AND control_branch.branch_revision = authority_head.branch_revision
         AND control_branch.manifest_sha256 = authority_head.manifest_sha256
         AND control_branch.branch_kind = 'authoritative'
         AND control_branch.state = 'authoritative'
        JOIN branch_revisions AS candidate_branch
          ON candidate_branch.tenant_id = authority_head.tenant_id
         AND candidate_branch.authority_subject_sha256 = authority_head.authority_subject_sha256
         AND candidate_branch.branch_id = json_extract(
           cohort_artifact.payload_json, '$.candidate_learning_ref.branch_id'
         )
         AND candidate_branch.branch_revision = json_extract(
           cohort_artifact.payload_json, '$.candidate_learning_ref.branch_revision'
         )
         AND candidate_branch.manifest_sha256 = json_extract(
           cohort_artifact.payload_json, '$.candidate_learning_ref.manifest_sha256'
         )
         AND candidate_branch.branch_kind = 'candidate'
         AND candidate_branch.state = 'active_candidate'
         AND candidate_branch.base_branch_id = authority_head.branch_id
         AND candidate_branch.base_branch_revision = authority_head.branch_revision
         AND candidate_branch.base_manifest_sha256 = authority_head.manifest_sha256
        JOIN observation_snapshots AS snapshot
          ON snapshot.tenant_id = NEW.tenant_id
         AND snapshot.scope = NEW.scope
         AND snapshot.world_snapshot_id = json_extract(
           NEW.payload_json,
           '$.continuation_contract.identity.world_snapshot_id'
         )
         AND snapshot.world_snapshot_sha256 = json_extract(
           NEW.payload_json,
           '$.continuation_contract.identity.world_snapshot_sha256'
         )
         AND snapshot.host_task_envelope_sha256 = NEW.host_task_envelope_sha256
        JOIN memory_scope_heads AS memory_head
          ON memory_head.tenant_id = NEW.tenant_id
         AND memory_head.scope = NEW.scope
         AND memory_head.head_revision = json_extract(
           NEW.payload_json,
           '$.continuation_contract.authority.memory_scope_head_revision'
         )
         AND memory_head.head_sha256 = json_extract(
           NEW.payload_json,
           '$.continuation_contract.authority.memory_scope_head_sha256'
         )
        WHERE cohort_artifact.tenant_id = NEW.tenant_id
          AND cohort_artifact.artifact_kind = 'experiment_cohort'
          AND cohort_artifact.artifact_schema = 'experiment_cohort_v1'
          AND cohort_artifact.artifact_sha256 = NEW.experiment_cohort_artifact_sha256
          AND cohort_artifact.payload_sha256 = NEW.experiment_cohort_payload_sha256
          AND cohort_artifact.authority_subject_sha256 = NEW.authority_subject_sha256
          AND cohort_artifact.source_operation_scope = NEW.scope
          AND json_extract(cohort_artifact.payload_json, '$.tenant_id') = NEW.tenant_id
          AND json_extract(cohort_artifact.payload_json, '$.scope') = NEW.scope
          AND json_extract(
            cohort_artifact.payload_json, '$.authority_subject_sha256'
          ) = NEW.authority_subject_sha256
          AND json_extract(
            cohort_artifact.payload_json, '$.assignment_window_opened_at'
          ) <= json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assigned_at'
          )
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assigned_at'
          ) < json_extract(
            cohort_artifact.payload_json, '$.assignment_window_closed_at'
          )
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.experiment_cohort_ref.artifact_sha256'
          ) = NEW.experiment_cohort_artifact_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.experiment_cohort_ref.payload_sha256'
          ) = NEW.experiment_cohort_payload_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.serving_assignment_receipt_sha256'
          ) = NEW.serving_assignment_receipt_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.create_continuation_operation_id'
          ) = NEW.source_operation_id
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.operation_request_sha256'
          ) = NEW.source_request_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.decision_id'
          ) = NEW.decision_id
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.episode_id'
          ) = NEW.episode_id
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.run_id'
          ) = NEW.run_id
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.host_task_envelope_sha256'
          ) = NEW.host_task_envelope_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.world_snapshot_ref.world_snapshot_sha256'
          ) = snapshot.world_snapshot_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.memory_scope_head_ref.revision'
          ) = memory_head.head_revision
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.memory_scope_head_ref.head_sha256'
          ) = memory_head.head_sha256
          AND json_extract(
            NEW.payload_json,
            '$.continuation_contract.authority.authoritative_learning_head.manifest_sha256'
          ) = control_branch.manifest_sha256
          AND ((NEW.serving_mode = 'assigned_control'
              AND json_extract(
                NEW.payload_json,
                '$.continuation_contract.authority.serving_assignment_receipt.arm'
              ) = 'control'
              AND NEW.branch_manifest_sha256 = control_branch.manifest_sha256)
            OR (NEW.serving_mode = 'assigned_candidate'
              AND json_extract(
                NEW.payload_json,
                '$.continuation_contract.authority.serving_assignment_receipt.arm'
              ) = 'candidate'
              AND NEW.branch_manifest_sha256 = candidate_branch.manifest_sha256))
      ))
  )
BEGIN
  SELECT RAISE(ABORT, 'episode exposure serving authority is invalid');
END;

CREATE TRIGGER operations_experiment_cohort_principal_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'create_continuation'
  AND EXISTS (
    SELECT 1 FROM episode_events AS exposure
    WHERE exposure.tenant_id = NEW.tenant_id
      AND exposure.scope = NEW.scope
      AND exposure.source_operation_id = NEW.operation_id
      AND exposure.source_request_sha256 = NEW.request_sha256
      AND exposure.event_kind = 'contract_exposed'
      AND exposure.serving_mode IN ('assigned_control', 'assigned_candidate')
      AND json_extract(
        exposure.payload_json,
        '$.continuation_contract.authority.serving_assignment_receipt.assignment_basis.host_principal_sha256'
      ) <> NEW.actor_principal_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'experiment cohort assignment is not granted to this host');
END;

CREATE TRIGGER operations_experiment_cohort_settlement_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'record_outcome'
  AND EXISTS (
    SELECT 1
    FROM episode_events AS outcome
    JOIN episode_events AS exposure
      ON exposure.tenant_id = outcome.tenant_id
     AND exposure.scope = outcome.scope
     AND exposure.decision_id = outcome.decision_id
     AND exposure.event_kind = 'contract_exposed'
     AND exposure.serving_mode IN ('assigned_control', 'assigned_candidate')
    JOIN authority_artifacts AS cohort
      ON cohort.tenant_id = exposure.tenant_id
     AND cohort.artifact_kind = 'experiment_cohort'
     AND cohort.artifact_sha256 = exposure.experiment_cohort_artifact_sha256
     AND cohort.payload_sha256 = exposure.experiment_cohort_payload_sha256
    WHERE outcome.tenant_id = NEW.tenant_id
      AND outcome.scope = NEW.scope
      AND outcome.source_operation_kind = NEW.operation_kind
      AND outcome.source_operation_id = NEW.operation_id
      AND outcome.source_request_sha256 = NEW.request_sha256
      AND outcome.event_kind = 'outcome_observed'
      AND (json_extract(
          outcome.payload_json, '$.outcome_receipt.observed_at'
        ) > json_extract(cohort.payload_json, '$.outcome_deadline')
        OR NEW.completed_at > json_extract(
          cohort.payload_json, '$.settlement_cutoff_at'
        ))
  )
BEGIN
  SELECT RAISE(ABORT, 'experiment cohort settlement deadline exceeded');
END;

CREATE TRIGGER episode_events_source_operation_fence
BEFORE INSERT ON episode_events
WHEN EXISTS (
  SELECT 1
  FROM operations AS completed
  WHERE completed.tenant_id = NEW.tenant_id
    AND completed.scope = NEW.scope
    AND completed.operation_kind = NEW.source_operation_kind
    AND completed.operation_id = NEW.source_operation_id
    AND completed.request_sha256 = NEW.source_request_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'episode_events source operation is already completed');
END;

CREATE TRIGGER episode_capsule_facts_source_operation_fence
BEFORE INSERT ON episode_capsule_facts
WHEN EXISTS (
  SELECT 1
  FROM episode_events AS event
  JOIN operations AS completed
    ON completed.tenant_id = event.tenant_id
    AND completed.scope = event.scope
    AND completed.operation_kind = event.source_operation_kind
    AND completed.operation_id = event.source_operation_id
    AND completed.request_sha256 = event.source_request_sha256
  WHERE event.tenant_id = NEW.tenant_id
    AND event.scope = NEW.scope
    AND event.episode_id = NEW.episode_id
    AND event.event_sequence = NEW.event_sequence
    AND event.event_id = NEW.event_id
    AND event.event_kind = NEW.event_kind
    AND event.event_sha256 = NEW.event_sha256
)
BEGIN
  SELECT RAISE(
    ABORT,
    'episode capsule facts cannot follow the operation receipt'
  );
END;

CREATE TRIGGER operations_episode_event_sets_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind IN ('create_continuation', 'record_outcome')
  AND (
    (NEW.operation_kind = 'create_continuation'
      AND (
        SELECT count(*)
        FROM episode_events AS exposure
        WHERE exposure.tenant_id = NEW.tenant_id
          AND exposure.scope = NEW.scope
          AND exposure.source_operation_kind = NEW.operation_kind
          AND exposure.source_operation_id = NEW.operation_id
          AND exposure.source_request_sha256 = NEW.request_sha256
          AND exposure.event_kind = 'contract_exposed'
      ) <> 1)
    OR (NEW.operation_kind = 'record_outcome'
      AND (
        SELECT count(*)
        FROM episode_events AS use_event
        WHERE use_event.tenant_id = NEW.tenant_id
          AND use_event.scope = NEW.scope
          AND use_event.source_operation_kind = NEW.operation_kind
          AND use_event.source_operation_id = NEW.operation_id
          AND use_event.source_request_sha256 = NEW.request_sha256
          AND use_event.event_kind = 'capsule_use_observed'
      ) <> 1)
    OR (NEW.operation_kind = 'record_outcome'
      AND (
        SELECT count(*)
        FROM episode_events AS outcome
        WHERE outcome.tenant_id = NEW.tenant_id
          AND outcome.scope = NEW.scope
          AND outcome.source_operation_kind = NEW.operation_kind
          AND outcome.source_operation_id = NEW.operation_id
          AND outcome.source_request_sha256 = NEW.request_sha256
          AND outcome.event_kind = 'outcome_observed'
      ) <> 1)
    OR EXISTS (
      SELECT 1
      FROM episode_events AS event
      WHERE event.tenant_id = NEW.tenant_id
        AND event.scope = NEW.scope
        AND event.source_operation_kind = NEW.operation_kind
        AND event.source_operation_id = NEW.operation_id
        AND event.source_request_sha256 = NEW.request_sha256
        AND event.event_kind IN ('contract_exposed', 'capsule_use_observed')
        AND ((
            SELECT count(*)
            FROM episode_capsule_facts AS fact
            WHERE fact.tenant_id = event.tenant_id
              AND fact.scope = event.scope
              AND fact.episode_id = event.episode_id
              AND fact.event_sequence = event.event_sequence
          ) <> event.capsule_fact_count
          OR coalesce((
            SELECT min(fact.fact_sequence)
            FROM episode_capsule_facts AS fact
            WHERE fact.tenant_id = event.tenant_id
              AND fact.scope = event.scope
              AND fact.episode_id = event.episode_id
              AND fact.event_sequence = event.event_sequence
          ), 0) <> CASE
            WHEN event.capsule_fact_count = 0 THEN 0 ELSE 1 END
          OR coalesce((
            SELECT max(fact.fact_sequence)
            FROM episode_capsule_facts AS fact
            WHERE fact.tenant_id = event.tenant_id
              AND fact.scope = event.scope
              AND fact.episode_id = event.episode_id
              AND fact.event_sequence = event.event_sequence
          ), 0) <> event.capsule_fact_count)
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'episode event or capsule fact set is incomplete'
  );
END;

CREATE TRIGGER durable_jobs_insert_guard
BEFORE INSERT ON durable_jobs
WHEN NOT (
  NEW.state = 'queued'
  AND NEW.attempt_count = 0
  AND NEW.initial_available_at = NEW.available_at
  AND NEW.available_at >= NEW.created_at
  AND NEW.lease_owner IS NULL
  AND NEW.lease_token IS NULL
  AND NEW.lease_acquired_at IS NULL
  AND NEW.lease_expires_at IS NULL
  AND NEW.completed_at IS NULL
  AND NEW.terminal_reason IS NULL
  AND NEW.completion_operation_kind IS NULL
  AND NEW.completion_operation_id IS NULL
  AND NEW.completion_request_sha256 IS NULL
  AND NEW.previous_completion_operation_kind IS NULL
  AND NEW.previous_completion_operation_id IS NULL
  AND NEW.previous_completion_request_sha256 IS NULL
  AND NEW.last_error_json IS NULL
  AND NEW.updated_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'invalid durable_jobs initial state');
END;

CREATE TRIGGER durable_jobs_completion_operation_fence
BEFORE UPDATE ON durable_jobs
WHEN NOT (
    NEW.completion_operation_kind IS OLD.completion_operation_kind
    AND NEW.completion_operation_id IS OLD.completion_operation_id
    AND NEW.completion_request_sha256 IS OLD.completion_request_sha256
  )
  AND NEW.completion_operation_kind IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM operations AS completed
    WHERE completed.tenant_id = NEW.tenant_id
      AND completed.scope = NEW.scope
      AND completed.operation_kind = NEW.completion_operation_kind
      AND completed.operation_id = NEW.completion_operation_id
      AND completed.request_sha256 = NEW.completion_request_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'durable_jobs completion operation is already completed');
END;

CREATE TRIGGER durable_jobs_transition_guard
BEFORE UPDATE ON durable_jobs
WHEN NOT (
  NEW.tenant_id = OLD.tenant_id
  AND NEW.scope = OLD.scope
  AND NEW.job_id = OLD.job_id
  AND NEW.job_kind = OLD.job_kind
  AND NEW.dedupe_key = OLD.dedupe_key
  AND NEW.source_operation_kind = OLD.source_operation_kind
  AND NEW.source_operation_id = OLD.source_operation_id
  AND NEW.source_request_sha256 = OLD.source_request_sha256
  AND NEW.priority = OLD.priority
  AND NEW.max_attempts = OLD.max_attempts
  AND NEW.payload_sha256 = OLD.payload_sha256
  AND NEW.payload_json = OLD.payload_json
  AND NEW.initial_available_at = OLD.initial_available_at
  AND NEW.created_at = OLD.created_at
  AND NEW.updated_at > OLD.updated_at
  AND (
    (OLD.state = 'queued'
      AND NEW.state = 'leased'
      AND NEW.attempt_count = OLD.attempt_count + 1
      AND NEW.available_at = OLD.available_at
      AND NEW.completion_operation_kind IS OLD.completion_operation_kind
      AND NEW.completion_operation_id IS OLD.completion_operation_id
      AND NEW.completion_request_sha256 IS OLD.completion_request_sha256
      AND NEW.previous_completion_operation_kind
        IS OLD.previous_completion_operation_kind
      AND NEW.previous_completion_operation_id
        IS OLD.previous_completion_operation_id
      AND NEW.previous_completion_request_sha256
        IS OLD.previous_completion_request_sha256
      AND NEW.last_error_json IS OLD.last_error_json)
    OR (OLD.state = 'leased'
      AND NEW.state = 'queued'
      AND NEW.attempt_count = OLD.attempt_count
      AND NEW.attempt_count < NEW.max_attempts
      AND NEW.available_at >= NEW.updated_at
      AND NEW.last_error_json IS NOT NULL
      AND (
        (NEW.updated_at >= OLD.lease_expires_at
          AND NEW.completion_operation_kind IS OLD.completion_operation_kind
          AND NEW.completion_operation_id IS OLD.completion_operation_id
          AND NEW.completion_request_sha256 IS OLD.completion_request_sha256
          AND NEW.previous_completion_operation_kind
            IS OLD.previous_completion_operation_kind
          AND NEW.previous_completion_operation_id
            IS OLD.previous_completion_operation_id
          AND NEW.previous_completion_request_sha256
            IS OLD.previous_completion_request_sha256)
        OR (NEW.updated_at < OLD.lease_expires_at
          AND NEW.completion_operation_kind = 'worker_completion'
          AND NEW.completion_operation_id IS NOT NULL
          AND NEW.completion_request_sha256 IS NOT NULL
          AND NEW.previous_completion_operation_kind
            IS OLD.completion_operation_kind
          AND NEW.previous_completion_operation_id
            IS OLD.completion_operation_id
          AND NEW.previous_completion_request_sha256
            IS OLD.completion_request_sha256)
      ))
    OR (OLD.state = 'leased'
      AND NEW.state IN ('succeeded', 'dead')
      AND NEW.attempt_count = OLD.attempt_count
      AND NEW.available_at = OLD.available_at
      AND (
        (NEW.terminal_reason IN ('worker_succeeded', 'worker_dead')
          AND NEW.completed_at < OLD.lease_expires_at
          AND NEW.completion_operation_kind = 'worker_completion'
          AND NEW.completion_operation_id IS NOT NULL
          AND NEW.completion_request_sha256 IS NOT NULL
          AND NEW.previous_completion_operation_kind
            IS OLD.completion_operation_kind
          AND NEW.previous_completion_operation_id
            IS OLD.completion_operation_id
          AND NEW.previous_completion_request_sha256
            IS OLD.completion_request_sha256)
        OR (NEW.terminal_reason = 'lease_expired_attempts_exhausted'
          AND NEW.attempt_count = NEW.max_attempts
          AND NEW.completed_at >= OLD.lease_expires_at
          AND NEW.completion_operation_kind IS OLD.completion_operation_kind
          AND NEW.completion_operation_id IS OLD.completion_operation_id
          AND NEW.completion_request_sha256 IS OLD.completion_request_sha256
          AND NEW.previous_completion_operation_kind
            IS OLD.previous_completion_operation_kind
          AND NEW.previous_completion_operation_id
            IS OLD.previous_completion_operation_id
          AND NEW.previous_completion_request_sha256
            IS OLD.previous_completion_request_sha256)
      ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid durable_jobs transition');
END;

CREATE TRIGGER operations_worker_completion_job_guard
BEFORE INSERT ON operations
WHEN NEW.operation_kind = 'worker_completion'
  AND (
    SELECT count(*)
    FROM durable_jobs AS completed_job
    WHERE completed_job.tenant_id = NEW.tenant_id
      AND completed_job.scope = NEW.scope
      AND completed_job.completion_operation_kind = NEW.operation_kind
      AND completed_job.completion_operation_id = NEW.operation_id
      AND completed_job.completion_request_sha256 = NEW.request_sha256
  ) <> 1
BEGIN
  SELECT RAISE(
    ABORT,
    'worker_completion operation must close exactly one durable job transition'
  );
END;

CREATE TRIGGER durable_jobs_no_delete
BEFORE DELETE ON durable_jobs
BEGIN
  SELECT RAISE(ABORT, 'durable_jobs cannot be deleted');
END;

CREATE TRIGGER memory_scope_heads_insert_guard
BEFORE INSERT ON memory_scope_heads
WHEN NEW.head_revision <> 1
  OR NOT EXISTS (
    SELECT 1
    FROM memory_commits AS target_commit
    WHERE target_commit.tenant_id = NEW.tenant_id
      AND target_commit.scope = NEW.scope
      AND target_commit.revision = NEW.head_revision
      AND target_commit.commit_id = NEW.head_commit_id
      AND target_commit.commit_sha256 = NEW.head_commit_sha256
      AND target_commit.source_operation_kind = NEW.source_operation_kind
      AND target_commit.source_operation_id = NEW.source_operation_id
      AND target_commit.source_request_sha256 = NEW.source_request_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid memory_scope_heads initial target');
END;

CREATE TRIGGER memory_scope_heads_advance_guard
BEFORE UPDATE ON memory_scope_heads
WHEN NOT (
  NEW.tenant_id = OLD.tenant_id
  AND NEW.scope = OLD.scope
  AND NEW.head_revision = OLD.head_revision + 1
  AND NEW.head_sha256 <> OLD.head_sha256
  AND NEW.updated_at > OLD.updated_at
  AND EXISTS (
    SELECT 1
    FROM memory_commits AS next_commit
    WHERE next_commit.tenant_id = NEW.tenant_id
      AND next_commit.scope = NEW.scope
      AND next_commit.revision = NEW.head_revision
      AND next_commit.commit_id = NEW.head_commit_id
      AND next_commit.commit_sha256 = NEW.head_commit_sha256
      AND next_commit.parent_revision = OLD.head_revision
      AND next_commit.parent_commit_id = OLD.head_commit_id
      AND next_commit.parent_commit_sha256 = OLD.head_commit_sha256
      AND next_commit.source_operation_kind = NEW.source_operation_kind
      AND next_commit.source_operation_id = NEW.source_operation_id
      AND next_commit.source_request_sha256 = NEW.source_request_sha256
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid memory_scope_heads advance');
END;

CREATE TRIGGER memory_scope_heads_no_delete
BEFORE DELETE ON memory_scope_heads
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_heads cannot be deleted');
END;

CREATE TRIGGER memory_items_update_guard
BEFORE UPDATE ON memory_items
WHEN NOT (
  NEW.tenant_id = OLD.tenant_id
  AND NEW.scope = OLD.scope
  AND NEW.memory_id = OLD.memory_id
  AND NEW.created_at = OLD.created_at
  AND NEW.source_commit_revision > OLD.source_commit_revision
  AND NEW.updated_at > OLD.updated_at
  AND NEW.row_sha256 <> OLD.row_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'invalid memory_items revision');
END;

CREATE TRIGGER memory_items_no_delete
BEFORE DELETE ON memory_items
BEGIN
  SELECT RAISE(ABORT, 'memory_items cannot be deleted');
END;

CREATE TRIGGER memory_relations_update_guard
BEFORE UPDATE ON memory_relations
WHEN NOT (
  NEW.tenant_id = OLD.tenant_id
  AND NEW.scope = OLD.scope
  AND NEW.relation_id = OLD.relation_id
  AND NEW.created_at = OLD.created_at
  AND NEW.source_commit_revision > OLD.source_commit_revision
  AND NEW.updated_at > OLD.updated_at
  AND NEW.row_sha256 <> OLD.row_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'invalid memory_relations revision');
END;

CREATE TRIGGER branch_capsule_bindings_learning_only_guard
BEFORE INSERT ON branch_capsule_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM capsule_revisions AS capsule
  WHERE capsule.tenant_id = NEW.tenant_id
    AND capsule.scope = NEW.capsule_scope
    AND capsule.capsule_id = NEW.capsule_id
    AND capsule.capsule_revision = NEW.capsule_revision
    AND capsule.capsule_sha256 = NEW.capsule_sha256
    AND capsule.capsule_kind IN ('procedure', 'counter_evidence')
    AND json_extract(capsule.capsule_json, '$.kind') = capsule.capsule_kind
)
BEGIN
  SELECT RAISE(ABORT, 'authority branches may bind only learning capsules');
END;

CREATE TRIGGER branch_revisions_active_cohort_freeze_guard
BEFORE INSERT ON branch_revisions
WHEN ((NEW.branch_kind = 'authoritative' AND NEW.branch_revision > 1)
    OR (NEW.branch_kind = 'candidate' AND NEW.state = 'merged'))
  AND EXISTS (
    SELECT 1
    FROM authority_artifacts AS cohort
    JOIN authority_heads AS head
      ON head.tenant_id = cohort.tenant_id
     AND head.authority_subject_sha256 = cohort.authority_subject_sha256
     AND head.branch_id = json_extract(
       cohort.payload_json, '$.control_learning_ref.branch_id'
     )
     AND head.branch_revision = json_extract(
       cohort.payload_json, '$.control_learning_ref.branch_revision'
     )
     AND head.manifest_sha256 = json_extract(
       cohort.payload_json, '$.control_learning_ref.manifest_sha256'
     )
    JOIN branch_revisions AS candidate
      ON candidate.tenant_id = cohort.tenant_id
     AND candidate.authority_subject_sha256 =
       cohort.authority_subject_sha256
     AND candidate.branch_id = json_extract(
       cohort.payload_json, '$.candidate_learning_ref.branch_id'
     )
     AND candidate.branch_revision = json_extract(
       cohort.payload_json, '$.candidate_learning_ref.branch_revision'
     )
     AND candidate.manifest_sha256 = json_extract(
       cohort.payload_json, '$.candidate_learning_ref.manifest_sha256'
     )
     AND candidate.branch_kind = 'candidate'
     AND candidate.state = 'active_candidate'
    WHERE cohort.tenant_id = NEW.tenant_id
      AND cohort.authority_subject_sha256 = NEW.authority_subject_sha256
      AND cohort.artifact_kind = 'experiment_cohort'
      AND json_extract(
        cohort.payload_json, '$.assignment_window_opened_at'
      ) <= NEW.created_at
      AND NEW.created_at <= json_extract(
        cohort.payload_json, '$.settlement_cutoff_at'
      )
      AND NOT EXISTS (
        SELECT 1 FROM branch_revisions AS newer_candidate
        WHERE newer_candidate.tenant_id = candidate.tenant_id
          AND newer_candidate.authority_subject_sha256 =
            candidate.authority_subject_sha256
          AND newer_candidate.branch_id = candidate.branch_id
          AND newer_candidate.branch_revision > candidate.branch_revision
      )
      AND NOT EXISTS (
        SELECT 1 FROM effect_certificates AS certificate
        WHERE certificate.tenant_id = cohort.tenant_id
          AND certificate.experiment_cohort_artifact_sha256 =
            cohort.artifact_sha256
          AND certificate.experiment_cohort_payload_sha256 =
            cohort.payload_sha256
      )
      AND ((NEW.branch_kind = 'authoritative'
          AND NEW.branch_id = head.branch_id
          AND NEW.previous_branch_revision = head.branch_revision
          AND NEW.previous_revision_sha256 = head.manifest_sha256)
        OR (NEW.branch_kind = 'candidate'
          AND NEW.state = 'merged'
          AND NEW.branch_id = candidate.branch_id
          AND NEW.previous_branch_revision = candidate.branch_revision
          AND NEW.previous_revision_sha256 = candidate.manifest_sha256))
  )
BEGIN
  SELECT RAISE(ABORT, 'active experiment cohort freezes its learning pair');
END;

CREATE TRIGGER branch_revisions_transition_guard
BEFORE INSERT ON branch_revisions
WHEN NOT (
  (NEW.branch_kind = 'authoritative'
    AND NEW.branch_revision = 1
    AND NEW.source_operation_kind = 'record_observations')
  OR (NEW.branch_kind = 'authoritative'
    AND NEW.branch_revision > 1
    AND NEW.source_operation_kind = 'authority_decision'
    AND EXISTS (
      SELECT 1
      FROM branch_revisions AS previous
      WHERE previous.tenant_id = NEW.tenant_id
        AND previous.authority_subject_sha256 =
          NEW.authority_subject_sha256
        AND previous.branch_id = NEW.branch_id
        AND previous.branch_revision = NEW.previous_branch_revision
        AND previous.manifest_sha256 = NEW.previous_revision_sha256
        AND previous.branch_kind = 'authoritative'
        AND previous.state = 'authoritative'
        AND ((NEW.policy_rotation_artifact_sha256 IS NULL
            AND previous.compiler_policy_artifact_sha256 =
              NEW.compiler_policy_artifact_sha256
            AND previous.compiler_policy_payload_sha256 =
              NEW.compiler_policy_payload_sha256
            AND previous.evidence_policy_artifact_sha256 =
              NEW.evidence_policy_artifact_sha256
            AND previous.evidence_policy_payload_sha256 =
              NEW.evidence_policy_payload_sha256)
          OR (NEW.policy_rotation_artifact_sha256 IS NOT NULL
            AND (previous.compiler_policy_artifact_sha256 <>
                NEW.compiler_policy_artifact_sha256
              OR previous.compiler_policy_payload_sha256 <>
                NEW.compiler_policy_payload_sha256
              OR previous.evidence_policy_artifact_sha256 <>
                NEW.evidence_policy_artifact_sha256
              OR previous.evidence_policy_payload_sha256 <>
                NEW.evidence_policy_payload_sha256)))
    ))
  OR (NEW.branch_kind = 'candidate'
    AND NEW.branch_revision = 1
    AND NEW.state = 'draft'
    AND EXISTS (
      SELECT 1
      FROM branch_revisions AS base
      WHERE base.tenant_id = NEW.tenant_id
        AND base.authority_subject_sha256 = NEW.authority_subject_sha256
        AND base.branch_id = NEW.base_branch_id
        AND base.branch_revision = NEW.base_branch_revision
        AND base.manifest_sha256 = NEW.base_manifest_sha256
        AND base.branch_kind = 'authoritative'
        AND base.state = 'authoritative'
        AND base.compiler_policy_artifact_sha256 =
          NEW.compiler_policy_artifact_sha256
        AND base.compiler_policy_payload_sha256 =
          NEW.compiler_policy_payload_sha256
        AND base.evidence_policy_artifact_sha256 =
          NEW.evidence_policy_artifact_sha256
        AND base.evidence_policy_payload_sha256 =
          NEW.evidence_policy_payload_sha256
    ))
  OR (NEW.branch_kind = 'candidate'
    AND NEW.branch_revision > 1
    AND EXISTS (
      SELECT 1
      FROM branch_revisions AS previous
      WHERE previous.tenant_id = NEW.tenant_id
        AND previous.authority_subject_sha256 = NEW.authority_subject_sha256
        AND previous.branch_id = NEW.branch_id
        AND previous.branch_revision = NEW.previous_branch_revision
        AND previous.manifest_sha256 = NEW.previous_revision_sha256
        AND previous.branch_kind = 'candidate'
        AND previous.base_branch_id = NEW.base_branch_id
        AND previous.base_branch_revision = NEW.base_branch_revision
        AND previous.base_manifest_sha256 = NEW.base_manifest_sha256
        AND previous.compiler_policy_artifact_sha256 =
          NEW.compiler_policy_artifact_sha256
        AND previous.compiler_policy_payload_sha256 =
          NEW.compiler_policy_payload_sha256
        AND previous.evidence_policy_artifact_sha256 =
          NEW.evidence_policy_artifact_sha256
        AND previous.evidence_policy_payload_sha256 =
          NEW.evidence_policy_payload_sha256
        AND (
          (previous.state = 'draft'
            AND NEW.state IN ('shadow', 'rejected', 'quarantined', 'expired'))
          OR (previous.state = 'shadow'
            AND NEW.state IN ('eligible', 'rejected', 'quarantined', 'expired'))
          OR (previous.state = 'eligible'
            AND NEW.state IN (
              'active_candidate', 'rejected', 'quarantined', 'expired'
            ))
          OR (previous.state = 'active_candidate'
            AND NEW.state IN ('merged', 'rejected', 'quarantined', 'expired'))
        )
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid branch_revisions transition');
END;

CREATE TRIGGER branch_revisions_trusted_observation_admission_guard
BEFORE INSERT ON branch_revisions
WHEN NEW.admission_world_snapshot_id IS NOT NULL
  AND NOT (
    NEW.branch_kind = 'candidate'
    AND NEW.state = 'draft'
    AND NEW.branch_revision = 1
    AND NEW.source_operation_kind = 'record_observations'
    AND NEW.admission_world_snapshot_id = NEW.source_operation_id
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.schema_version'
    ) = 'trusted_observation_admission_ref_v1'
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.observation_snapshot_ref.world_snapshot_id'
    ) = NEW.admission_world_snapshot_id
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.observation_snapshot_ref.world_snapshot_sha256'
    ) = NEW.admission_world_snapshot_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.observation_snapshot_ref.host_task_envelope_sha256'
    ) = NEW.admission_host_task_envelope_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.revision'
    ) = NEW.admission_memory_revision
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.commit_id'
    ) = NEW.admission_memory_commit_id
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.commit_sha256'
    ) = NEW.admission_memory_commit_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.mutation_sha256'
    ) = NEW.admission_memory_mutation_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.head_sha256'
    ) = NEW.admission_memory_head_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.item_count'
    ) = NEW.admission_item_count
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.item_set_sha256'
    ) = NEW.admission_item_set_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.relation_count'
    ) = NEW.admission_relation_count
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.relation_set_sha256'
    ) = NEW.admission_relation_set_sha256
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.capsule_count'
    ) = NEW.admission_capsule_count
    AND json_extract(
      NEW.manifest_json,
      '$.trusted_observation_admission_ref.memory_revision_ref.capsule_set_sha256'
    ) = NEW.admission_capsule_set_sha256
    AND EXISTS (
      SELECT 1
      FROM observation_snapshots AS snapshot
      WHERE snapshot.tenant_id = NEW.tenant_id
        AND snapshot.scope = NEW.source_operation_scope
        AND snapshot.world_snapshot_id = NEW.admission_world_snapshot_id
        AND snapshot.world_snapshot_sha256 =
          NEW.admission_world_snapshot_sha256
        AND snapshot.host_task_envelope_sha256 =
          NEW.admission_host_task_envelope_sha256
        AND snapshot.source_operation_kind = NEW.source_operation_kind
        AND snapshot.source_operation_id = NEW.source_operation_id
        AND snapshot.source_request_sha256 = NEW.source_request_sha256
        AND json_extract(
          snapshot.host_task_envelope_json,
          '$.authority_subject_sha256'
        ) = NEW.authority_subject_sha256
    )
    AND EXISTS (
      SELECT 1
      FROM memory_commits AS memory_commit
      JOIN memory_scope_heads AS memory_head
        ON memory_head.tenant_id = memory_commit.tenant_id
       AND memory_head.scope = memory_commit.scope
       AND memory_head.head_revision = memory_commit.revision
       AND memory_head.head_commit_id = memory_commit.commit_id
       AND memory_head.head_commit_sha256 = memory_commit.commit_sha256
      WHERE memory_commit.tenant_id = NEW.tenant_id
        AND memory_commit.scope = NEW.source_operation_scope
        AND memory_commit.revision = NEW.admission_memory_revision
        AND memory_commit.commit_id = NEW.admission_memory_commit_id
        AND memory_commit.commit_sha256 = NEW.admission_memory_commit_sha256
        AND memory_commit.mutation_sha256 =
          NEW.admission_memory_mutation_sha256
        AND memory_commit.source_operation_kind = NEW.source_operation_kind
        AND memory_commit.source_operation_id = NEW.source_operation_id
        AND memory_commit.source_request_sha256 = NEW.source_request_sha256
        AND memory_head.head_sha256 = NEW.admission_memory_head_sha256
        AND memory_head.source_operation_kind = NEW.source_operation_kind
        AND memory_head.source_operation_id = NEW.source_operation_id
        AND memory_head.source_request_sha256 = NEW.source_request_sha256
        AND json_array_length(
          memory_commit.mutation_json,
          '$.items'
        ) = NEW.admission_item_count
        AND json_array_length(
          memory_commit.mutation_json,
          '$.relations'
        ) = NEW.admission_relation_count
        AND json_array_length(
          memory_commit.mutation_json,
          '$.capsules'
        ) = NEW.admission_capsule_count
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'branch revision does not bind its exact trusted observation admission'
  );
END;

CREATE TRIGGER branch_revisions_policy_rotation_artifact_guard
BEFORE INSERT ON branch_revisions
WHEN NEW.policy_rotation_artifact_sha256 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM authority_artifacts AS rotation
    WHERE rotation.tenant_id = NEW.tenant_id
      AND rotation.artifact_sha256 =
        NEW.policy_rotation_artifact_sha256
      AND rotation.payload_sha256 = NEW.policy_rotation_payload_sha256
      AND rotation.artifact_kind = NEW.policy_rotation_artifact_kind
      AND rotation.authority_subject_sha256 =
        NEW.authority_subject_sha256
      AND rotation.created_at <= NEW.created_at
      AND rotation.valid_from <= NEW.created_at
      AND (rotation.expires_at IS NULL
        OR NEW.created_at < rotation.expires_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or inactive policy rotation artifact');
END;

CREATE TRIGGER branch_revisions_merge_certificate_guard
BEFORE INSERT ON branch_revisions
WHEN NEW.branch_kind = 'candidate'
  AND NEW.state = 'merged'
  AND NOT EXISTS (
    SELECT 1
    FROM effect_certificates AS certificate
    WHERE certificate.tenant_id = NEW.tenant_id
      AND certificate.authority_subject_sha256 =
        NEW.authority_subject_sha256
      AND certificate.candidate_branch_id = NEW.branch_id
      AND certificate.candidate_branch_revision =
        NEW.previous_branch_revision
      AND certificate.candidate_manifest_sha256 =
        NEW.previous_revision_sha256
      AND certificate.control_branch_id = NEW.base_branch_id
      AND certificate.control_branch_revision = NEW.base_branch_revision
      AND certificate.control_manifest_sha256 = NEW.base_manifest_sha256
      AND certificate.evidence_policy_artifact_sha256 =
        NEW.evidence_policy_artifact_sha256
      AND certificate.evidence_policy_payload_sha256 =
        NEW.evidence_policy_payload_sha256
      AND certificate.certificate_sha256 = NEW.effect_certificate_sha256
      AND certificate.admission_state = 'admitted'
  )
BEGIN
  SELECT RAISE(ABORT, 'merged branch does not bind an admitted exact certificate');
END;

CREATE TRIGGER branch_revisions_authoritative_certificate_guard
BEFORE INSERT ON branch_revisions
WHEN NEW.branch_kind = 'authoritative'
  AND NEW.branch_revision > 1
  AND NEW.effect_certificate_sha256 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM effect_certificates AS certificate
    WHERE certificate.tenant_id = NEW.tenant_id
      AND certificate.authority_subject_sha256 =
        NEW.authority_subject_sha256
      AND certificate.control_branch_id = NEW.branch_id
      AND certificate.control_branch_revision = NEW.previous_branch_revision
      AND certificate.control_manifest_sha256 = NEW.previous_revision_sha256
      AND certificate.evidence_policy_artifact_sha256 =
        NEW.evidence_policy_artifact_sha256
      AND certificate.evidence_policy_payload_sha256 =
        NEW.evidence_policy_payload_sha256
      AND certificate.certificate_sha256 = NEW.effect_certificate_sha256
      AND certificate.admission_state = 'admitted'
  )
BEGIN
  SELECT RAISE(ABORT, 'authoritative revision does not bind an admitted exact certificate');
END;

CREATE TRIGGER authority_heads_insert_guard
BEFORE INSERT ON authority_heads
WHEN NEW.head_revision <> 1
  OR NEW.branch_revision <> 1
  OR NEW.source_operation_kind <> 'record_observations'
  OR NOT EXISTS (
    SELECT 1
    FROM branch_revisions AS target_branch
    WHERE target_branch.tenant_id = NEW.tenant_id
      AND target_branch.authority_subject_sha256 =
        NEW.authority_subject_sha256
      AND target_branch.branch_id = NEW.branch_id
      AND target_branch.branch_revision = NEW.branch_revision
      AND target_branch.manifest_sha256 = NEW.manifest_sha256
      AND target_branch.branch_kind = NEW.branch_kind
      AND target_branch.state = NEW.branch_state
      AND target_branch.source_operation_scope = NEW.source_operation_scope
      AND target_branch.source_operation_kind = NEW.source_operation_kind
      AND target_branch.source_operation_id = NEW.source_operation_id
      AND target_branch.source_request_sha256 = NEW.source_request_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid authority_heads initial target');
END;

CREATE TRIGGER authority_heads_active_cohort_freeze_guard
BEFORE UPDATE ON authority_heads
WHEN EXISTS (
    SELECT 1
    FROM authority_artifacts AS cohort
    JOIN branch_revisions AS candidate
      ON candidate.tenant_id = cohort.tenant_id
     AND candidate.authority_subject_sha256 =
       cohort.authority_subject_sha256
     AND candidate.branch_id = json_extract(
       cohort.payload_json, '$.candidate_learning_ref.branch_id'
     )
     AND candidate.branch_revision = json_extract(
       cohort.payload_json, '$.candidate_learning_ref.branch_revision'
     )
     AND candidate.manifest_sha256 = json_extract(
       cohort.payload_json, '$.candidate_learning_ref.manifest_sha256'
     )
     AND candidate.branch_kind = 'candidate'
     AND candidate.state = 'active_candidate'
    WHERE cohort.tenant_id = OLD.tenant_id
      AND cohort.authority_subject_sha256 = OLD.authority_subject_sha256
      AND cohort.artifact_kind = 'experiment_cohort'
      AND OLD.branch_id = json_extract(
        cohort.payload_json, '$.control_learning_ref.branch_id'
      )
      AND OLD.branch_revision = json_extract(
        cohort.payload_json, '$.control_learning_ref.branch_revision'
      )
      AND OLD.manifest_sha256 = json_extract(
        cohort.payload_json, '$.control_learning_ref.manifest_sha256'
      )
      AND json_extract(
        cohort.payload_json, '$.assignment_window_opened_at'
      ) <= NEW.updated_at
      AND NEW.updated_at <= json_extract(
        cohort.payload_json, '$.settlement_cutoff_at'
      )
      AND NOT EXISTS (
        SELECT 1 FROM branch_revisions AS newer_candidate
        WHERE newer_candidate.tenant_id = candidate.tenant_id
          AND newer_candidate.authority_subject_sha256 =
            candidate.authority_subject_sha256
          AND newer_candidate.branch_id = candidate.branch_id
          AND newer_candidate.branch_revision > candidate.branch_revision
      )
      AND NOT EXISTS (
        SELECT 1 FROM effect_certificates AS certificate
        WHERE certificate.tenant_id = cohort.tenant_id
          AND certificate.experiment_cohort_artifact_sha256 =
            cohort.artifact_sha256
          AND certificate.experiment_cohort_payload_sha256 =
            cohort.payload_sha256
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'active experiment cohort freezes its authority head');
END;

CREATE TRIGGER authority_heads_advance_guard
BEFORE UPDATE ON authority_heads
WHEN NOT (
  NEW.tenant_id = OLD.tenant_id
  AND NEW.authority_subject_sha256 = OLD.authority_subject_sha256
  AND NEW.source_operation_kind IN (
    'authority_decision', 'record_observations'
  )
  AND NEW.head_revision = OLD.head_revision + 1
  AND NEW.branch_id = OLD.branch_id
  AND NEW.branch_revision = OLD.branch_revision + 1
  AND NEW.head_sha256 <> OLD.head_sha256
  AND NEW.updated_at > OLD.updated_at
  AND EXISTS (
    SELECT 1
    FROM branch_revisions AS target_branch
    WHERE target_branch.tenant_id = NEW.tenant_id
      AND target_branch.authority_subject_sha256 =
        NEW.authority_subject_sha256
      AND target_branch.branch_id = NEW.branch_id
      AND target_branch.branch_revision = NEW.branch_revision
      AND target_branch.manifest_sha256 = NEW.manifest_sha256
      AND target_branch.branch_kind = NEW.branch_kind
      AND target_branch.state = NEW.branch_state
      AND target_branch.source_operation_scope = NEW.source_operation_scope
      AND target_branch.source_operation_kind = NEW.source_operation_kind
      AND target_branch.source_operation_id = NEW.source_operation_id
      AND target_branch.source_request_sha256 = NEW.source_request_sha256
      AND target_branch.previous_branch_revision = OLD.branch_revision
      AND target_branch.previous_revision_sha256 = OLD.manifest_sha256
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid authority_heads advance');
END;

CREATE TRIGGER authority_heads_policy_rotation_bindings_guard
BEFORE UPDATE ON authority_heads
WHEN EXISTS (
  SELECT 1
  FROM branch_revisions AS rotation
  WHERE rotation.tenant_id = NEW.tenant_id
    AND rotation.authority_subject_sha256 = NEW.authority_subject_sha256
    AND rotation.branch_id = NEW.branch_id
    AND rotation.branch_revision = NEW.branch_revision
    AND rotation.manifest_sha256 = NEW.manifest_sha256
    AND rotation.branch_kind = NEW.branch_kind
    AND rotation.state = NEW.branch_state
    AND rotation.policy_rotation_artifact_sha256 IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM branch_capsule_bindings AS previous_binding
        WHERE previous_binding.tenant_id = rotation.tenant_id
          AND previous_binding.authority_subject_sha256 =
            rotation.authority_subject_sha256
          AND previous_binding.branch_id = rotation.branch_id
          AND previous_binding.branch_revision =
            rotation.previous_branch_revision
          AND NOT EXISTS (
            SELECT 1
            FROM branch_capsule_bindings AS rotated_binding
            WHERE rotated_binding.tenant_id = previous_binding.tenant_id
              AND rotated_binding.authority_subject_sha256 =
                previous_binding.authority_subject_sha256
              AND rotated_binding.branch_id = previous_binding.branch_id
              AND rotated_binding.branch_revision =
                rotation.branch_revision
              AND rotated_binding.capsule_scope =
                previous_binding.capsule_scope
              AND rotated_binding.capsule_id = previous_binding.capsule_id
              AND rotated_binding.capsule_revision =
                previous_binding.capsule_revision
              AND rotated_binding.capsule_sha256 =
                previous_binding.capsule_sha256
              AND rotated_binding.disposition =
                previous_binding.disposition
              AND rotated_binding.admission_authority =
                previous_binding.admission_authority
          )
      )
      OR EXISTS (
        SELECT 1
        FROM branch_capsule_bindings AS rotated_binding
        WHERE rotated_binding.tenant_id = rotation.tenant_id
          AND rotated_binding.authority_subject_sha256 =
            rotation.authority_subject_sha256
          AND rotated_binding.branch_id = rotation.branch_id
          AND rotated_binding.branch_revision = rotation.branch_revision
          AND NOT EXISTS (
            SELECT 1
            FROM branch_capsule_bindings AS previous_binding
            WHERE previous_binding.tenant_id = rotated_binding.tenant_id
              AND previous_binding.authority_subject_sha256 =
                rotated_binding.authority_subject_sha256
              AND previous_binding.branch_id = rotated_binding.branch_id
              AND previous_binding.branch_revision =
                rotation.previous_branch_revision
              AND previous_binding.capsule_scope =
                rotated_binding.capsule_scope
              AND previous_binding.capsule_id = rotated_binding.capsule_id
              AND previous_binding.capsule_revision =
                rotated_binding.capsule_revision
              AND previous_binding.capsule_sha256 =
                rotated_binding.capsule_sha256
              AND previous_binding.disposition =
                rotated_binding.disposition
              AND previous_binding.admission_authority =
                rotated_binding.admission_authority
          )
      )
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'policy rotation must preserve exact capsule bindings'
  );
END;

CREATE TRIGGER authority_heads_no_delete
BEFORE DELETE ON authority_heads
BEGIN
  SELECT RAISE(ABORT, 'authority_heads cannot be deleted');
END;

CREATE TRIGGER episode_events_chain_guard
BEFORE INSERT ON episode_events
WHEN NEW.event_sequence > 1
  AND NOT EXISTS (
    SELECT 1
    FROM episode_events AS previous
    WHERE previous.tenant_id = NEW.tenant_id
      AND previous.scope = NEW.scope
      AND previous.episode_id = NEW.episode_id
      AND previous.event_sequence = NEW.previous_event_sequence
      AND previous.event_sha256 = NEW.previous_event_sha256
      AND previous.created_at <= NEW.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'episode event does not extend the exact prior head');
END;

CREATE TRIGGER episode_events_decision_cause_guard
BEFORE INSERT ON episode_events
WHEN NEW.event_kind IN ('capsule_use_observed', 'outcome_observed')
  AND NOT EXISTS (
    SELECT 1
    FROM episode_events AS cause
    WHERE cause.tenant_id = NEW.tenant_id
      AND cause.scope = NEW.scope
      AND cause.episode_id = NEW.episode_id
      AND cause.event_sequence = NEW.cause_event_sequence
      AND cause.event_id = NEW.cause_event_id
      AND cause.event_kind = NEW.cause_event_kind
      AND cause.event_sha256 = NEW.cause_event_sha256
      AND cause.decision_id = NEW.decision_id
      AND cause.run_id = NEW.run_id
      AND cause.host_task_envelope_sha256 = NEW.host_task_envelope_sha256
      AND cause.contract_sha256 = NEW.contract_sha256
      AND cause.coverage_certificate_sha256 =
        NEW.coverage_certificate_sha256
      AND cause.render_result_sha256 = NEW.render_result_sha256
      AND cause.authority_subject_sha256 = NEW.authority_subject_sha256
      AND cause.branch_manifest_sha256 = NEW.branch_manifest_sha256
      AND (NEW.event_kind <> 'capsule_use_observed'
        OR cause.capsule_fact_count = NEW.capsule_fact_count)
  )
BEGIN
  SELECT RAISE(ABORT, 'episode event does not bind its exact decision cause');
END;

CREATE TRIGGER episode_events_record_outcome_operation_guard
BEFORE INSERT ON episode_events
WHEN NEW.event_kind IN ('capsule_use_observed', 'outcome_observed')
  AND EXISTS (
    SELECT 1
    FROM episode_events AS sibling
    WHERE sibling.tenant_id = NEW.tenant_id
      AND sibling.scope = NEW.scope
      AND sibling.source_operation_kind = NEW.source_operation_kind
      AND sibling.source_operation_id = NEW.source_operation_id
      AND (sibling.source_request_sha256 <> NEW.source_request_sha256
        OR sibling.decision_id <> NEW.decision_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'record_outcome operation spans different decisions');
END;

CREATE TRIGGER episode_events_effect_binding_guard
BEFORE INSERT ON episode_events
WHEN NEW.event_kind = 'effect_certified'
  AND NOT EXISTS (
    SELECT 1
    FROM effect_certificates AS certificate
    JOIN episode_events AS cause
      ON cause.tenant_id = NEW.tenant_id
      AND cause.scope = NEW.scope
      AND cause.episode_id = NEW.episode_id
      AND cause.event_sequence = NEW.cause_event_sequence
      AND cause.event_id = NEW.cause_event_id
      AND cause.event_kind = NEW.cause_event_kind
      AND cause.event_sha256 = NEW.cause_event_sha256
    WHERE certificate.tenant_id = NEW.tenant_id
      AND certificate.certificate_sha256 = NEW.effect_certificate_sha256
      AND certificate.authority_subject_sha256 = NEW.authority_subject_sha256
      AND certificate.source_operation_scope = NEW.scope
      AND certificate.source_operation_kind = NEW.source_operation_kind
      AND certificate.source_operation_id = NEW.source_operation_id
      AND certificate.source_request_sha256 = NEW.source_request_sha256
      AND certificate.created_at = NEW.created_at
      AND (
        (cause.event_kind = 'contract_exposed'
          AND cause.created_at >= certificate.window_opened_at
          AND cause.created_at < json_extract(
            certificate.certificate_json,
            '$.experiment_cohort.assignment_window_closed_at'
          ))
        OR (cause.event_kind = 'outcome_observed'
          AND json_extract(
            cause.payload_json,
            '$.outcome_receipt.observed_at'
          ) <= certificate.window_closed_at
          AND cause.created_at <= certificate.settlement_cutoff_at
          AND EXISTS (
            SELECT 1
            FROM episode_events AS exposure
            WHERE exposure.tenant_id = cause.tenant_id
              AND exposure.scope = cause.scope
              AND exposure.episode_id = cause.episode_id
              AND exposure.decision_id = cause.decision_id
              AND exposure.event_kind = 'contract_exposed'
              AND exposure.created_at >= certificate.window_opened_at
              AND exposure.created_at < json_extract(
                certificate.certificate_json,
                '$.experiment_cohort.assignment_window_closed_at'
              )
          ))
      )
      AND cause.decision_id = NEW.decision_id
      AND cause.run_id = NEW.run_id
      AND cause.host_task_envelope_sha256 = NEW.host_task_envelope_sha256
      AND cause.contract_sha256 = NEW.contract_sha256
      AND cause.coverage_certificate_sha256 =
        NEW.coverage_certificate_sha256
      AND cause.render_result_sha256 = NEW.render_result_sha256
      AND cause.authority_subject_sha256 = NEW.authority_subject_sha256
      AND cause.branch_manifest_sha256 = NEW.branch_manifest_sha256
      AND cause.branch_manifest_sha256 IN (
        certificate.control_manifest_sha256,
        certificate.candidate_manifest_sha256
      )
      AND (cause.event_kind <> 'contract_exposed'
        OR NOT EXISTS (
          SELECT 1
          FROM episode_events AS observed_outcome
          WHERE observed_outcome.tenant_id = NEW.tenant_id
            AND observed_outcome.scope = NEW.scope
            AND observed_outcome.episode_id = NEW.episode_id
            AND observed_outcome.decision_id = NEW.decision_id
            AND observed_outcome.event_kind = 'outcome_observed'
            AND json_extract(
              observed_outcome.payload_json,
              '$.outcome_receipt.observed_at'
            ) <= certificate.window_closed_at
            AND observed_outcome.created_at <= certificate.settlement_cutoff_at
        ))
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'effect member does not bind its exact eligible decision cause'
  );
END;

CREATE TRIGGER episode_capsule_facts_event_guard
BEFORE INSERT ON episode_capsule_facts
WHEN NOT EXISTS (
    SELECT 1
    FROM episode_events AS event
    WHERE event.tenant_id = NEW.tenant_id
      AND event.scope = NEW.scope
      AND event.episode_id = NEW.episode_id
      AND event.event_sequence = NEW.event_sequence
      AND event.event_id = NEW.event_id
      AND event.event_kind = NEW.event_kind
      AND event.event_sha256 = NEW.event_sha256
      AND NEW.fact_sequence <= event.capsule_fact_count
  )
BEGIN
  SELECT RAISE(ABORT, 'capsule fact does not bind its exact event header');
END;

CREATE TRIGGER episode_capsule_facts_use_guard
BEFORE INSERT ON episode_capsule_facts
WHEN NEW.event_kind = 'capsule_use_observed'
  AND NOT EXISTS (
    SELECT 1
    FROM episode_events AS use_event
    JOIN episode_capsule_facts AS exposure_fact
      ON exposure_fact.tenant_id = use_event.tenant_id
      AND exposure_fact.scope = use_event.scope
      AND exposure_fact.episode_id = use_event.episode_id
      AND exposure_fact.event_sequence = use_event.cause_event_sequence
      AND exposure_fact.event_id = use_event.cause_event_id
      AND exposure_fact.event_kind = use_event.cause_event_kind
      AND exposure_fact.event_sha256 = use_event.cause_event_sha256
      AND exposure_fact.capsule_scope = NEW.capsule_scope
      AND exposure_fact.capsule_id = NEW.capsule_id
      AND exposure_fact.capsule_revision = NEW.capsule_revision
      AND exposure_fact.capsule_sha256 = NEW.capsule_sha256
      AND exposure_fact.surface = NEW.surface
    WHERE use_event.tenant_id = NEW.tenant_id
      AND use_event.scope = NEW.scope
      AND use_event.episode_id = NEW.episode_id
      AND use_event.event_sequence = NEW.event_sequence
      AND use_event.event_id = NEW.event_id
      AND use_event.event_kind = 'capsule_use_observed'
      AND use_event.event_sha256 = NEW.event_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'capsule use fact does not bind its exposure surface');
END;
