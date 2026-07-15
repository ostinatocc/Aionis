import stableStringify from "fast-json-stable-stringify";

import {
  LearningExperimentCloseApprovalV1Schema,
  learningExperimentCloseApprovalDigest,
} from "../memory/learning-authority-approval.js";
import {
  LearningExperimentCloseAuthorizationEnvelopeV1Schema,
  LearningExperimentCloseReceiptBodyV1Schema,
  LearningExperimentCloseReceiptV1Schema,
  learningExperimentCloseId,
  learningExperimentCloseRequestDigest,
  learningExperimentLeaseMembershipDigest,
  splitLearningExperimentCloseAuthorization,
  verifyLearningExperimentCloseApprovalMacSignature,
  verifyLearningExperimentCloseReceiptAttestation,
  type LearningExperimentCloseReceiptBodyV1,
  type LearningExperimentLeaseMembershipEntryV1,
} from "../memory/learning-experiment-closing.js";
import {
  resolveAuthorityReceiptKeyring,
  type AuthorityReceiptResolvedKeyring,
} from "../util/authority-receipt-keys.js";
import { sha256Hex } from "../util/crypto.js";
import type { SqliteDatabase } from "./sqlite.js";

type Row = Record<string, unknown>;

function requiredString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`lite_learning_integrity_failed:experiment_close_${field}`);
  }
  return value;
}

function requiredInteger(row: Row, field: string): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`lite_learning_integrity_failed:experiment_close_${field}`);
  }
  return value;
}

function canonicalUtcMillis(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function closeRecordDigest(row: Row): string {
  return sha256Hex(stableStringify(Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== "close_sha256")
      .sort(([left], [right]) => left.localeCompare(right)),
  )));
}

function closeMembershipRows(
  db: SqliteDatabase,
  tenantId: string,
  confirmatoryAttemptId: string,
): Array<Row & LearningExperimentLeaseMembershipEntryV1> {
  return db.prepare(
    `SELECT pair_row.pair_ordinal, lease.randomization_pair_sha256,
            lease.pair_member_ordinal, lease.memory_namespace_sha256,
            lease.namespace_lease_id,
            lease.lease_generation AS namespace_lease_generation,
            lease.activation_wave_index, lease.status,
            lease.confirmatory_attempt_id, lease.experiment_id,
            lease.experiment_revision, lease.namespace_set_sha256,
            lease.release_operation_id, lease.release_ref_kind,
            lease.release_ref_id, lease.released_at
     FROM lite_learning_namespace_leases AS lease
     JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = lease.tenant_id
      AND pair_row.confirmatory_attempt_id = lease.confirmatory_attempt_id
      AND pair_row.randomization_pair_sha256 = lease.randomization_pair_sha256
     WHERE lease.tenant_id = ? AND lease.confirmatory_attempt_id = ?
     ORDER BY pair_row.pair_ordinal, lease.pair_member_ordinal`,
  ).all(tenantId, confirmatoryAttemptId) as Array<Row & LearningExperimentLeaseMembershipEntryV1>;
}

function expectedReceiptForClosure(
  db: SqliteDatabase,
  closure: Row,
  keyring: AuthorityReceiptResolvedKeyring,
): LearningExperimentCloseReceiptBodyV1 {
  const tenantId = requiredString(closure, "tenant_id");
  const attemptId = requiredString(closure, "confirmatory_attempt_id");
  const approvalPayloadJson = requiredString(closure, "authorization_payload_json");
  let approvalPayload: unknown;
  try {
    approvalPayload = JSON.parse(approvalPayloadJson);
  } catch {
    throw new Error("lite_learning_integrity_failed:experiment_close_authorization_json");
  }
  const approval = LearningExperimentCloseApprovalV1Schema.parse(approvalPayload);
  if (stableStringify(approval) !== approvalPayloadJson
    || learningExperimentCloseApprovalDigest(approval)
      !== requiredString(closure, "authorization_sha256")) {
    throw new Error("lite_learning_integrity_failed:experiment_close_authorization_digest");
  }

  const fieldBindings = [
    ["tenant_id", "tenant_id"],
    ["confirmatory_attempt_id", "confirmatory_attempt_id"],
    ["experiment_id", "experiment_id"],
    ["experiment_revision", "experiment_revision"],
    ["namespace_set_sha256", "namespace_set_sha256"],
    ["close_reason", "close_reason"],
    ["authorization_key_id", "authorization_key_id"],
    ["authorization_nonce", "authorization_nonce"],
    ["authorization_expires_at", "authorization_expires_at"],
    ["approved_by", "approved_by"],
    ["authority_operation_id", "authority_operation_id"],
    ["authority_scope", "authority_operation_scope"],
    ["authority_operation_kind", "authority_operation_kind"],
  ] as const;
  for (const [approvalField, closureField] of fieldBindings) {
    if (approval[approvalField] !== closure[closureField]) {
      throw new Error(`lite_learning_integrity_failed:experiment_close_${closureField}_binding`);
    }
  }

  const closedAt = requiredString(closure, "created_at");
  if (!canonicalUtcMillis(closedAt)
    || !(approval.authorization_issued_at <= closedAt
      && closedAt < approval.authorization_expires_at)) {
    throw new Error("lite_learning_integrity_failed:experiment_close_authorization_time");
  }
  const authorizationMac = requiredString(closure, "authorization_mac");
  const authorization = LearningExperimentCloseAuthorizationEnvelopeV1Schema.parse({
    contract_version: "learning_experiment_close_authorization_envelope_v1",
    approval,
    authorization_mac: authorizationMac,
  });
  const authorizationSplit = splitLearningExperimentCloseAuthorization(authorization);
  const retainedKey = keyring.configured && !keyring.ephemeral
    ? keyring.keys.get(approval.authorization_key_id)
    : undefined;
  if (retainedKey) {
    if (retainedKey.byteLength < 32) {
      throw new Error("lite_learning_integrity_failed:experiment_close_authorization_key_weak");
    }
    const signature = verifyLearningExperimentCloseApprovalMacSignature({
      authorization,
      key: retainedKey,
      expected_authorization_key_id: approval.authorization_key_id,
    });
    if (!signature.ok) {
      throw new Error("lite_learning_integrity_failed:experiment_close_authorization_mac");
    }
  }

  const attempt = db.prepare(
    `SELECT attempt.task_family, attempt.attempt_sha256,
            attempt.candidate_policy_implementation_sha256,
            attempt.eligible_memory_namespace_set_sha256,
            revision.config_sha256 AS experiment_config_sha256,
            gate_policy.implementation_contract_sha256 AS gate_policy_implementation_sha256
     FROM lite_learning_confirmatory_attempts AS attempt
     JOIN lite_learning_experiment_revisions AS revision
       ON revision.tenant_id = attempt.tenant_id
      AND revision.experiment_id = attempt.experiment_id
      AND revision.experiment_revision = attempt.experiment_revision
     JOIN lite_learning_policy_versions AS gate_policy
       ON gate_policy.tenant_id = attempt.tenant_id
      AND gate_policy.policy_kind = 'gate'
      AND gate_policy.policy_id = attempt.gate_policy_id
      AND gate_policy.policy_version = attempt.gate_policy_version
     WHERE attempt.tenant_id = ? AND attempt.confirmatory_attempt_id = ?`,
  ).get(tenantId, attemptId) as Row | undefined;
  if (!attempt
    || attempt.task_family !== approval.task_family
    || attempt.attempt_sha256 !== approval.confirmatory_attempt_sha256
    || attempt.experiment_config_sha256 !== approval.experiment_config_sha256
    || attempt.eligible_memory_namespace_set_sha256 !== approval.namespace_set_sha256
    || attempt.candidate_policy_implementation_sha256
      !== approval.candidate_policy_implementation_sha256
    || attempt.gate_policy_implementation_sha256
      !== approval.gate_policy_implementation_sha256) {
    throw new Error("lite_learning_integrity_failed:experiment_close_authority_binding");
  }

  const identity = db.prepare(
    "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
  ).get() as { database_instance_id: string } | undefined;
  if (!identity
    || sha256Hex(identity.database_instance_id) !== approval.runtime_authority_lineage_sha256) {
    throw new Error("lite_learning_integrity_failed:experiment_close_runtime_lineage");
  }

  const nonce = db.prepare(
    `SELECT authorization_kind, authority_ref_id, authorization_sha256
     FROM lite_learning_authorization_nonces
     WHERE tenant_id = ? AND authorization_key_id = ? AND authorization_nonce = ?`,
  ).get(
    tenantId,
    approval.authorization_key_id,
    approval.authorization_nonce,
  ) as Row | undefined;
  if (!nonce
    || nonce.authorization_kind !== "experiment_close"
    || nonce.authority_ref_id !== closure.experiment_close_id
    || nonce.authorization_sha256 !== closure.authorization_sha256) {
    throw new Error("lite_learning_integrity_failed:experiment_close_nonce");
  }

  const closeId = learningExperimentCloseId(approval);
  if (closure.experiment_close_id !== closeId
    || closure.close_sha256 !== closeRecordDigest(closure)) {
    throw new Error("lite_learning_integrity_failed:experiment_close_record_digest");
  }

  const members = closeMembershipRows(db, tenantId, attemptId);
  if (members.length !== 768) {
    throw new Error("lite_learning_integrity_failed:experiment_close_lease_count");
  }
  for (const member of members) {
    if (member.status !== "released"
      || member.confirmatory_attempt_id !== attemptId
      || member.experiment_id !== approval.experiment_id
      || Number(member.experiment_revision) !== approval.experiment_revision
      || member.namespace_set_sha256 !== approval.namespace_set_sha256
      || member.release_operation_id !== approval.authority_operation_id
      || member.release_ref_kind !== "experiment_close"
      || member.release_ref_id !== closeId
      || member.released_at !== closedAt) {
      throw new Error("lite_learning_integrity_failed:experiment_close_lease_release_binding");
    }
  }
  const namespaceSetSha256 = sha256Hex(stableStringify(
    members.map((member) => member.memory_namespace_sha256).sort(),
  ));
  if (namespaceSetSha256 !== approval.namespace_set_sha256) {
    throw new Error("lite_learning_integrity_failed:experiment_close_namespace_set");
  }
  const membershipSha256 = learningExperimentLeaseMembershipDigest(members.map((member) => ({
    pair_ordinal: member.pair_ordinal,
    randomization_pair_sha256: member.randomization_pair_sha256,
    pair_member_ordinal: member.pair_member_ordinal,
    memory_namespace_sha256: member.memory_namespace_sha256,
    namespace_lease_id: member.namespace_lease_id,
    namespace_lease_generation: member.namespace_lease_generation,
    activation_wave_index: member.activation_wave_index,
  })));

  const currentEventHead = db.prepare(
    "SELECT COALESCE(MAX(row_id), 0) AS row_id FROM lite_learning_episode_events",
  ).get() as { row_id: number };
  const sealedEventHead = requiredInteger(closure, "sealed_event_head_row_id");
  if (sealedEventHead < 0 || sealedEventHead > Number(currentEventHead.row_id)) {
    throw new Error("lite_learning_integrity_failed:experiment_close_event_head");
  }

  return LearningExperimentCloseReceiptBodyV1Schema.parse({
    contract_version: "aionis_learning_experiment_close_receipt_v1",
    operation_kind: approval.authority_operation_kind,
    operation_id: approval.authority_operation_id,
    request_sha256: learningExperimentCloseRequestDigest({
      actor: requiredString(closure, "created_by"),
      authorization,
    }),
    tenant_id: tenantId,
    authority_scope: approval.authority_scope,
    runtime_authority_lineage_sha256: approval.runtime_authority_lineage_sha256,
    actor: requiredString(closure, "created_by"),
    status: "closed",
    authorization_sha256: requiredString(closure, "authorization_sha256"),
    authorization_mac_sha256: authorizationSplit.authorization_mac_sha256,
    authorization_key_id: approval.authorization_key_id,
    authorization_nonce: approval.authorization_nonce,
    approved_by: approval.approved_by,
    authorization_issued_at: approval.authorization_issued_at,
    authorization_expires_at: approval.authorization_expires_at,
    task_family: approval.task_family,
    confirmatory_attempt_id: attemptId,
    confirmatory_attempt_sha256: approval.confirmatory_attempt_sha256,
    experiment_id: approval.experiment_id,
    experiment_revision: approval.experiment_revision,
    experiment_config_sha256: approval.experiment_config_sha256,
    namespace_set_sha256: approval.namespace_set_sha256,
    candidate_policy_implementation_sha256:
      approval.candidate_policy_implementation_sha256,
    gate_policy_implementation_sha256: approval.gate_policy_implementation_sha256,
    experiment_close_id: closeId,
    close_reason: approval.close_reason,
    sealed_event_head_row_id: sealedEventHead,
    close_sha256: requiredString(closure, "close_sha256"),
    closed_at: closedAt,
    namespace_lease_membership_sha256: membershipSha256,
    namespace_lease_count: 768,
    release_operation_id: approval.authority_operation_id,
    release_ref_kind: "experiment_close",
    release_ref_id: closeId,
    released_at: closedAt,
  });
}

export function assertLiteLearningExperimentCloseBundlesIntegrity(
  db: SqliteDatabase,
  authorityKeyring?: AuthorityReceiptResolvedKeyring,
): void {
  const closures = db.prepare(
    "SELECT * FROM lite_learning_experiment_closures ORDER BY tenant_id, experiment_close_id",
  ).all() as Row[];
  const keyring = closures.length > 0
    ? authorityKeyring ?? resolveAuthorityReceiptKeyring()
    : null;
  if (closures.length > 0 && (!keyring?.configured || keyring.ephemeral)) {
    throw new Error(
      "lite_learning_integrity_failed:experiment_close_receipt_attestation_keyring_required",
    );
  }
  for (const closure of closures) {
    const expected = expectedReceiptForClosure(db, closure, keyring!);
    const operation = db.prepare(
      `SELECT request_sha256, receipt_json, commit_id
       FROM lite_runtime_write_operations
       WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
    ).get(
      expected.tenant_id,
      expected.authority_scope,
      expected.operation_kind,
      expected.operation_id,
    ) as Row | undefined;
    if (!operation
      || operation.request_sha256 !== expected.request_sha256
      || operation.commit_id !== null) {
      throw new Error("lite_learning_integrity_failed:experiment_close_operation_receipt");
    }
    let persistedReceipt: unknown;
    try {
      persistedReceipt = JSON.parse(requiredString(operation, "receipt_json"));
    } catch {
      throw new Error("lite_learning_integrity_failed:experiment_close_receipt_json");
    }
    const parsed = LearningExperimentCloseReceiptV1Schema.parse(persistedReceipt);
    if (stableStringify(parsed) !== operation.receipt_json) {
      throw new Error("lite_learning_integrity_failed:experiment_close_receipt_drift");
    }
    const attestationKey = keyring!.keys.get(parsed.receipt_attestation_key_id);
    if (!attestationKey) {
      throw new Error(
        "lite_learning_integrity_failed:experiment_close_receipt_attestation_key_unknown",
      );
    }
    if (attestationKey.byteLength < 32) {
      throw new Error(
        "lite_learning_integrity_failed:experiment_close_receipt_attestation_key_weak",
      );
    }
    const attestation = verifyLearningExperimentCloseReceiptAttestation({
      receipt: parsed,
      key: attestationKey,
      expected_receipt_attestation_key_id: parsed.receipt_attestation_key_id,
    });
    if (!attestation.ok) {
      throw new Error(
        "lite_learning_integrity_failed:experiment_close_receipt_attestation_mac",
      );
    }
    if (stableStringify(attestation.body) !== stableStringify(expected)) {
      throw new Error("lite_learning_integrity_failed:experiment_close_receipt_drift");
    }
  }

  const orphanCloseNonces = db.prepare(
    `SELECT COUNT(*) AS count
     FROM lite_learning_authorization_nonces AS nonce
     WHERE nonce.authorization_kind = 'experiment_close'
       AND NOT EXISTS (
         SELECT 1 FROM lite_learning_experiment_closures AS closure
         WHERE closure.tenant_id = nonce.tenant_id
           AND closure.experiment_close_id = nonce.authority_ref_id
           AND closure.authorization_key_id = nonce.authorization_key_id
           AND closure.authorization_nonce = nonce.authorization_nonce
           AND closure.authorization_sha256 = nonce.authorization_sha256
       )`,
  ).get() as { count: number };
  if (Number(orphanCloseNonces.count) !== 0) {
    throw new Error("lite_learning_integrity_failed:orphan_experiment_close_nonce");
  }

  const orphanCloseReceipts = db.prepare(
    `SELECT COUNT(*) AS count
     FROM lite_runtime_write_operations AS operation
     WHERE operation.operation_kind = 'learning_experiment_close_v1'
       AND NOT EXISTS (
         SELECT 1 FROM lite_learning_experiment_closures AS closure
         WHERE closure.tenant_id = operation.tenant_id
           AND closure.authority_operation_scope = operation.scope
           AND closure.authority_operation_kind = operation.operation_kind
           AND closure.authority_operation_id = operation.operation_id
       )`,
  ).get() as { count: number };
  if (Number(orphanCloseReceipts.count) !== 0) {
    throw new Error("lite_learning_integrity_failed:orphan_experiment_close_receipt");
  }
}
