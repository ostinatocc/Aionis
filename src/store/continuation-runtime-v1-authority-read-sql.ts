export const AUTHORITY_BRANCH_SELECT_V1 = `SELECT
  branch.tenant_id, branch.source_operation_scope,
  branch.source_operation_kind, branch.source_operation_id,
  branch.source_request_sha256, branch.authority_subject_sha256,
  branch.branch_id, branch.branch_revision, branch.manifest_sha256,
  branch.branch_kind, branch.state, branch.base_branch_id,
  branch.base_branch_revision, branch.base_manifest_sha256,
  branch.base_branch_kind, branch.base_branch_state,
  branch.previous_branch_revision, branch.previous_revision_sha256,
  branch.compiler_policy_artifact_sha256,
  branch.compiler_policy_payload_sha256,
  branch.compiler_policy_kind,
  branch.evidence_policy_artifact_sha256,
  branch.evidence_policy_payload_sha256,
  branch.evidence_policy_kind, branch.policy_rotation_artifact_sha256,
  branch.policy_rotation_payload_sha256,
  branch.policy_rotation_artifact_kind, branch.effect_certificate_sha256,
  branch.reverts_branch_id, branch.reverts_branch_revision,
  branch.reverts_authority_revision_sha256, branch.reverts_branch_kind,
  branch.reverts_branch_state, branch.admission_world_snapshot_id,
  branch.admission_world_snapshot_sha256,
  branch.admission_host_task_envelope_sha256,
  branch.admission_memory_revision, branch.admission_memory_commit_id,
  branch.admission_memory_commit_sha256,
  branch.admission_memory_mutation_sha256,
  branch.admission_memory_head_sha256, branch.admission_item_count,
  branch.admission_item_set_sha256, branch.admission_relation_count,
  branch.admission_relation_set_sha256, branch.admission_capsule_count,
  branch.admission_capsule_set_sha256, branch.manifest_json, branch.created_at,
  operation.actor_kind AS source_actor_kind,
  operation.actor_principal_sha256 AS source_actor_principal_sha256,
  operation.receipt_sha256 AS source_receipt_sha256,
  operation.receipt_json AS source_receipt_json,
  operation.completed_at AS source_completed_at
FROM branch_revisions AS branch
LEFT JOIN operations AS operation
  ON operation.tenant_id = branch.tenant_id
 AND operation.scope = branch.source_operation_scope
 AND operation.operation_kind = branch.source_operation_kind
 AND operation.operation_id = branch.source_operation_id
 AND operation.request_sha256 = branch.source_request_sha256`;

export const AUTHORITY_HEAD_SELECT_V1 = `SELECT
  head.tenant_id, head.source_operation_scope, head.source_operation_kind,
  head.source_operation_id, head.source_request_sha256,
  head.authority_subject_sha256, head.head_revision, head.branch_id,
  head.branch_revision, head.manifest_sha256, head.branch_kind,
  head.branch_state, head.head_sha256, head.updated_at,
  operation.actor_kind AS source_actor_kind,
  operation.actor_principal_sha256 AS source_actor_principal_sha256,
  operation.receipt_sha256 AS source_receipt_sha256,
  operation.receipt_json AS source_receipt_json,
  operation.completed_at AS source_completed_at
FROM authority_heads AS head
LEFT JOIN operations AS operation
  ON operation.tenant_id = head.tenant_id
 AND operation.scope = head.source_operation_scope
 AND operation.operation_kind = head.source_operation_kind
 AND operation.operation_id = head.source_operation_id
 AND operation.request_sha256 = head.source_request_sha256`;

export const AUTHORITY_BINDING_SELECT_V1 = `SELECT
  binding.tenant_id, binding.authority_subject_sha256,
  binding.branch_id, binding.branch_revision,
  binding.branch_manifest_sha256, binding.branch_kind,
  binding.capsule_scope, binding.capsule_id, binding.capsule_revision,
  binding.capsule_sha256, binding.disposition,
  binding.admission_authority, binding.binding_sha256,
  binding.created_at, capsule.capsule_json,
  capsule.capsule_sha256 AS persisted_capsule_sha256
FROM branch_capsule_bindings AS binding
LEFT JOIN capsule_revisions AS capsule
  ON capsule.tenant_id = binding.tenant_id
 AND capsule.scope = binding.capsule_scope
 AND capsule.capsule_id = binding.capsule_id
 AND capsule.capsule_revision = binding.capsule_revision
 AND capsule.capsule_sha256 = binding.capsule_sha256`;
