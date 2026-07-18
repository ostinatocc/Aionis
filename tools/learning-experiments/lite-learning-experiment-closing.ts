import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import stableStringify from "fast-json-stable-stringify";

import {
  LearningExperimentCloseAuthorizationEnvelopeV1Schema,
  LearningExperimentCloseReceiptBodyV1Schema,
  LearningExperimentCloseReceiptV1Schema,
  learningExperimentCloseId,
  learningExperimentCloseReceiptAttestationMac,
  learningExperimentCloseRequestDigest,
  learningExperimentLeaseMembershipDigest,
  splitLearningExperimentCloseAuthorization,
  verifyLearningExperimentCloseApprovalMac,
  type LearningExperimentCloseAuthorizationEnvelopeV1,
  type LearningExperimentCloseReceiptV1,
  type LearningExperimentLeaseMembershipEntryV1,
} from "../../src/memory/learning-experiment-closing.js";
import { sha256Hex } from "../../src/util/crypto.js";
import {
  resolveAuthorityReceiptKeyring,
  type AuthorityReceiptResolvedKeyring,
} from "../../src/util/authority-receipt-keys.js";
import {
  assertLiteLearningEpisodeLedgerIntegrity,
  learningExperimentClosureRecordDigest,
  type LiteLearningAuthorityRow,
} from "../../src/store/lite-learning-episode-ledger.js";
import {
  createLiteRuntimeProtectedWriteDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../src/store/lite-runtime-schema.js";
import {
  createSqliteImmutableReadOnlyDatabase,
  createSqliteReadOnlyDatabase,
  type SqliteDatabase,
} from "../../src/store/sqlite.js";
import {
  type LiteWriteOperationRow,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.js";

export type LearningExperimentCloseInput = Readonly<{
  tenantId: string;
  actor: string;
  operationId: string;
  authorization: LearningExperimentCloseAuthorizationEnvelopeV1;
  experimentId: string;
  experimentRevision: number;
}>;

export type LearningExperimentCloseResult = Readonly<{
  receipt: LearningExperimentCloseReceiptV1;
  receiptJson: string;
  replayed: boolean;
}>;

type LearningExperimentCloseWriteStore = Pick<
  LiteWriteStore,
  "getWriteOperation" | "insertWriteOperation" | "withTx"
>;

function createProtectedCloseWriteStore(
  database: LiteRuntimeDatabase,
): LearningExperimentCloseWriteStore {
  const { db, transaction } = database;
  return {
    withTx: async (fn) => await transaction.run(fn),
    getWriteOperation: async (args) => await transaction.read(() => (
      db.prepare(
        `SELECT tenant_id, scope, operation_kind, operation_id,
                request_sha256, receipt_json, commit_id, created_at
         FROM lite_runtime_write_operations
         WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
      ).get(
        args.tenantId,
        args.scope,
        args.operationKind,
        args.operationId,
      ) as LiteWriteOperationRow | undefined
    ) ?? null),
    insertWriteOperation: async (args) => {
      if (!transaction.inTransaction()) {
        throw new Error(
          "Runtime close operation receipt must be inserted inside the protected transaction",
        );
      }
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO lite_runtime_write_operations
           (tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.tenantId,
        args.scope,
        args.operationKind,
        args.operationId,
        args.requestSha256,
        args.receiptJson,
        args.commitId ?? null,
        createdAt,
      );
      return {
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_kind: args.operationKind,
        operation_id: args.operationId,
        request_sha256: args.requestSha256,
        receipt_json: args.receiptJson,
        commit_id: args.commitId ?? null,
        created_at: createdAt,
      };
    },
  };
}

/** @internal Runtime composition/test seam; the CLI uses the production wrapper. */
export type LearningExperimentClosingDependencies = Readonly<{
  now?: () => string;
  resolveKeyring?: () => AuthorityReceiptResolvedKeyring;
  assertProductionBoundary?: () => void;
}>;

export class LearningExperimentClosingError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "LearningExperimentClosingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function closingError(code: string, message: string, statusCode = 400): never {
  throw new LearningExperimentClosingError(code, message, statusCode);
}

function exactBoundedText(value: string, field: string, maxBytes = 256): string {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maxBytes
    || Buffer.from(value, "utf8").toString("utf8") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    closingError(
      "learning_experiment_close_input_invalid",
      `${field} must be exact control-free UTF-8 text bounded to ${String(maxBytes)} bytes`,
    );
  }
  return value;
}

function canonicalUtcMillis(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    closingError(
      "learning_experiment_close_clock_invalid",
      "close time must be a canonical UTC millisecond timestamp",
      500,
    );
  }
  return value;
}

function prepareInput(input: LearningExperimentCloseInput) {
  const authorization = LearningExperimentCloseAuthorizationEnvelopeV1Schema.parse(
    input.authorization,
  );
  const approval = authorization.approval;
  const tenantId = exactBoundedText(input.tenantId, "tenantId");
  const actor = exactBoundedText(input.actor, "actor");
  const operationId = exactBoundedText(input.operationId, "operationId");
  const experimentId = exactBoundedText(input.experimentId, "experimentId");
  if (!Number.isSafeInteger(input.experimentRevision) || input.experimentRevision < 1) {
    closingError(
      "learning_experiment_close_input_invalid",
      "experimentRevision must be a positive safe integer",
    );
  }
  if (tenantId !== approval.tenant_id
    || operationId !== approval.authority_operation_id
    || experimentId !== approval.experiment_id
    || input.experimentRevision !== approval.experiment_revision) {
    closingError(
      "learning_experiment_close_approval_binding_mismatch",
      "close flags do not match the signed approval",
      409,
    );
  }
  return {
    tenantId,
    actor,
    operationId,
    authorization,
    approval,
    experimentId,
    experimentRevision: input.experimentRevision,
    requestSha256: learningExperimentCloseRequestDigest({ actor, authorization }),
  };
}

type CloseAuthoritySnapshot = Readonly<{
  task_family: string;
  confirmatory_attempt_id: string;
  attempt_sha256: string;
  candidate_policy_implementation_sha256: string;
  experiment_id: string;
  experiment_revision: number;
  experiment_config_sha256: string;
  namespace_set_sha256: string;
  gate_policy_implementation_sha256: string;
}>;

function authoritySnapshot(
  db: SqliteDatabase,
  tenantId: string,
  experimentId: string,
  experimentRevision: number,
): CloseAuthoritySnapshot {
  const row = db.prepare(
    `SELECT attempt.task_family, attempt.confirmatory_attempt_id,
            attempt.attempt_sha256,
            attempt.candidate_policy_implementation_sha256,
            attempt.experiment_id, attempt.experiment_revision,
            revision.config_sha256 AS experiment_config_sha256,
            attempt.eligible_memory_namespace_set_sha256 AS namespace_set_sha256,
            gate_policy.implementation_contract_sha256
              AS gate_policy_implementation_sha256
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
     WHERE attempt.tenant_id = ? AND attempt.experiment_id = ?
       AND attempt.experiment_revision = ?`,
  ).get(tenantId, experimentId, experimentRevision) as CloseAuthoritySnapshot | undefined;
  if (!row) {
    closingError(
      "learning_experiment_close_attempt_unresolved",
      "close requires one registered confirmatory attempt and revision",
      409,
    );
  }
  return row;
}

type CloseLeaseRow = LearningExperimentLeaseMembershipEntryV1 & Readonly<{
  status: string;
  experiment_id: string;
  experiment_revision: number;
  namespace_set_sha256: string;
  release_operation_id: string | null;
  release_ref_kind: string | null;
  release_ref_id: string | null;
  released_at: string | null;
}>;

function activeLeaseMembership(
  db: SqliteDatabase,
  tenantId: string,
  attemptId: string,
  snapshot: CloseAuthoritySnapshot,
): { rows: CloseLeaseRow[]; membershipSha256: string } {
  const rows = db.prepare(
    `SELECT pair_row.pair_ordinal, lease.randomization_pair_sha256,
            lease.pair_member_ordinal, lease.memory_namespace_sha256,
            lease.namespace_lease_id,
            lease.lease_generation AS namespace_lease_generation,
            lease.activation_wave_index, lease.status,
            lease.experiment_id, lease.experiment_revision,
            lease.namespace_set_sha256, lease.release_operation_id,
            lease.release_ref_kind, lease.release_ref_id, lease.released_at
     FROM lite_learning_namespace_leases AS lease
     JOIN lite_learning_randomization_pairs AS pair_row
       ON pair_row.tenant_id = lease.tenant_id
      AND pair_row.confirmatory_attempt_id = lease.confirmatory_attempt_id
      AND pair_row.randomization_pair_sha256 = lease.randomization_pair_sha256
     WHERE lease.tenant_id = ? AND lease.confirmatory_attempt_id = ?
     ORDER BY pair_row.pair_ordinal, lease.pair_member_ordinal`,
  ).all(tenantId, attemptId) as CloseLeaseRow[];
  if (rows.length !== 768
    || rows.some((row) => row.status !== "active"
      || row.experiment_id !== snapshot.experiment_id
      || Number(row.experiment_revision) !== snapshot.experiment_revision
      || row.namespace_set_sha256 !== snapshot.namespace_set_sha256
      || row.release_operation_id !== null
      || row.release_ref_kind !== null
      || row.release_ref_id !== null
      || row.released_at !== null)) {
    closingError(
      "learning_experiment_close_lease_set_conflict",
      "close requires the exact complete active 768-member namespace lease set",
      409,
    );
  }
  const namespaceSetSha256 = sha256Hex(stableStringify(
    rows.map((row) => row.memory_namespace_sha256).sort(),
  ));
  if (namespaceSetSha256 !== snapshot.namespace_set_sha256) {
    closingError(
      "learning_experiment_close_membership_drift",
      "active namespace membership no longer matches the confirmatory attempt",
      409,
    );
  }
  const digestMembers = rows.map((row) => ({
    pair_ordinal: row.pair_ordinal,
    randomization_pair_sha256: row.randomization_pair_sha256,
    pair_member_ordinal: row.pair_member_ordinal,
    memory_namespace_sha256: row.memory_namespace_sha256,
    namespace_lease_id: row.namespace_lease_id,
    namespace_lease_generation: row.namespace_lease_generation,
    activation_wave_index: row.activation_wave_index,
  }));
  return {
    rows,
    membershipSha256: learningExperimentLeaseMembershipDigest(digestMembers),
  };
}

function assertApprovalMatchesAuthority(args: {
  prepared: ReturnType<typeof prepareInput>;
  snapshot: CloseAuthoritySnapshot;
  runtimeAuthorityLineageSha256: string;
}): void {
  const { approval } = args.prepared;
  if (approval.runtime_authority_lineage_sha256 !== args.runtimeAuthorityLineageSha256
    || approval.task_family !== args.snapshot.task_family
    || approval.confirmatory_attempt_id !== args.snapshot.confirmatory_attempt_id
    || approval.confirmatory_attempt_sha256 !== args.snapshot.attempt_sha256
    || approval.experiment_id !== args.snapshot.experiment_id
    || approval.experiment_revision !== args.snapshot.experiment_revision
    || approval.experiment_config_sha256 !== args.snapshot.experiment_config_sha256
    || approval.namespace_set_sha256 !== args.snapshot.namespace_set_sha256
    || approval.candidate_policy_implementation_sha256
      !== args.snapshot.candidate_policy_implementation_sha256
    || approval.gate_policy_implementation_sha256
      !== args.snapshot.gate_policy_implementation_sha256) {
    closingError(
      "learning_experiment_close_authority_drift",
      "signed close approval does not match current immutable Runtime authority",
      409,
    );
  }
}

function verifyFreshAuthorization(args: {
  prepared: ReturnType<typeof prepareInput>;
  keyring: AuthorityReceiptResolvedKeyring;
  verifiedAt: string;
}): Readonly<{
  authorization: ReturnType<typeof splitLearningExperimentCloseAuthorization>;
  receiptAttestationKeyId: string;
  receiptAttestationKey: Buffer;
}> {
  if (!args.keyring.configured || args.keyring.ephemeral) {
    closingError(
      "learning_experiment_close_keyring_required",
      "a configured non-ephemeral authority keyring is required for a fresh close",
      503,
    );
  }
  const key = args.keyring.keys.get(args.prepared.approval.authorization_key_id);
  if (!key) {
    closingError(
      "learning_experiment_close_authorization_key_unknown",
      "signed close approval references an unknown authority key",
      403,
    );
  }
  if (key.byteLength < 32) {
    closingError(
      "learning_experiment_close_authorization_key_weak",
      "experiment-close authority keys must contain at least 32 bytes",
      503,
    );
  }
  const receiptAttestationKey = args.keyring.keys.get(args.keyring.activeKeyId);
  if (!receiptAttestationKey || receiptAttestationKey.byteLength < 32) {
    closingError(
      "learning_experiment_close_receipt_attestation_key_invalid",
      "the active authority key must contain at least 32 bytes for close receipt attestation",
      503,
    );
  }
  const verification = verifyLearningExperimentCloseApprovalMac({
    authorization: args.prepared.authorization,
    key,
    expected_authorization_key_id: args.prepared.approval.authorization_key_id,
    verified_at: args.verifiedAt,
  });
  if (!verification.ok) {
    const expired = verification.reason === "authorization_expired"
      || verification.reason === "authorization_not_yet_valid";
    closingError(
      expired
        ? "learning_experiment_close_authorization_time_invalid"
        : "learning_experiment_close_authorization_invalid",
      `signed close approval verification failed: ${verification.reason}`,
      403,
    );
  }
  return {
    authorization: verification.authorization,
    receiptAttestationKeyId: args.keyring.activeKeyId,
    receiptAttestationKey,
  };
}

function exactReplay(args: {
  db: SqliteDatabase;
  operation: LiteWriteOperationRow;
  prepared: ReturnType<typeof prepareInput>;
  keyring: AuthorityReceiptResolvedKeyring;
}): LearningExperimentCloseResult {
  assertLiteLearningEpisodeLedgerIntegrity(
    args.db,
    new Date().toISOString(),
    { authorityReceiptKeyring: args.keyring },
  );
  if (args.operation.request_sha256 !== args.prepared.requestSha256) {
    closingError(
      "learning_experiment_close_operation_conflict",
      "operation ID is already bound to a different close request",
      409,
    );
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(args.operation.receipt_json);
  } catch {
    closingError(
      "learning_experiment_close_receipt_corrupt",
      "stored close operation receipt is not valid JSON",
      409,
    );
  }
  const receipt = LearningExperimentCloseReceiptV1Schema.parse(rawReceipt);
  if (stableStringify(receipt) !== args.operation.receipt_json
    || receipt.request_sha256 !== args.prepared.requestSha256) {
    closingError(
      "learning_experiment_close_receipt_corrupt",
      "stored close operation receipt does not exactly match the request",
      409,
    );
  }
  return {
    receipt,
    receiptJson: args.operation.receipt_json,
    replayed: true,
  };
}

export type LiteLearningExperimentCloser = Readonly<{
  close(input: LearningExperimentCloseInput): Promise<LearningExperimentCloseResult>;
}>;

/** @internal Runtime composition/test factory; operator-facing code uses the wrapper below. */
export function createLiteLearningExperimentCloser(args: {
  database: LiteRuntimeDatabase;
  writeStore: Pick<LiteWriteStore, "getWriteOperation" | "insertWriteOperation" | "withTx">;
  dependencies?: LearningExperimentClosingDependencies;
}): LiteLearningExperimentCloser {
  const now = args.dependencies?.now ?? (() => new Date().toISOString());
  const resolveKeyring = args.dependencies?.resolveKeyring
    ?? (() => resolveAuthorityReceiptKeyring());

  return {
    async close(input) {
      const prepared = prepareInput(input);
      const operationKey = {
        tenantId: prepared.tenantId,
        scope: prepared.approval.authority_scope,
        operationKind: prepared.approval.authority_operation_kind,
        operationId: prepared.operationId,
      };

      return await args.writeStore.withTx(async () => {
        args.dependencies?.assertProductionBoundary?.();
        const authorityKeyring = resolveKeyring();
        const existingOperation = await args.writeStore.getWriteOperation(operationKey);
        if (existingOperation) {
          return exactReplay({
            db: args.database.db,
            operation: existingOperation,
            prepared,
            keyring: authorityKeyring,
          });
        }

        assertLiteLearningEpisodeLedgerIntegrity(
          args.database.db,
          new Date().toISOString(),
          { authorityReceiptKeyring: authorityKeyring },
        );
        const closedAt = canonicalUtcMillis(now());
        const verifiedAuthority = verifyFreshAuthorization({
          prepared,
          keyring: authorityKeyring,
          verifiedAt: closedAt,
        });

        const databaseIdentity = args.database.db.prepare(
          "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
        ).get() as { database_instance_id: string } | undefined;
        if (!databaseIdentity) {
          closingError(
            "learning_experiment_close_runtime_identity_missing",
            "Runtime authority identity is missing",
            409,
          );
        }
        const runtimeAuthorityLineageSha256 = sha256Hex(databaseIdentity.database_instance_id);
        const snapshot = authoritySnapshot(
          args.database.db,
          prepared.tenantId,
          prepared.experimentId,
          prepared.experimentRevision,
        );
        assertApprovalMatchesAuthority({
          prepared,
          snapshot,
          runtimeAuthorityLineageSha256,
        });

        const existingAuthority = args.database.db.prepare(
          `SELECT 1 FROM lite_learning_experiment_closures
           WHERE tenant_id = ? AND (
             confirmatory_attempt_id = ? OR authority_operation_id = ?
             OR (authorization_key_id = ? AND authorization_nonce = ?)
           ) LIMIT 1`,
        ).get(
          prepared.tenantId,
          snapshot.confirmatory_attempt_id,
          prepared.operationId,
          prepared.approval.authorization_key_id,
          prepared.approval.authorization_nonce,
        );
        if (existingAuthority) {
          closingError(
            "learning_experiment_close_authority_conflict",
            "confirmatory attempt or signed close authority is already consumed",
            409,
          );
        }

        const membership = activeLeaseMembership(
          args.database.db,
          prepared.tenantId,
          snapshot.confirmatory_attempt_id,
          snapshot,
        );
        const eventHead = args.database.db.prepare(
          "SELECT COALESCE(MAX(row_id), 0) AS row_id FROM lite_learning_episode_events",
        ).get() as { row_id: number };
        const sealedEventHeadRowId = Number(eventHead.row_id);
        if (!Number.isSafeInteger(sealedEventHeadRowId) || sealedEventHeadRowId < 0) {
          closingError(
            "learning_experiment_close_event_head_invalid",
            "current learning event head is invalid",
            409,
          );
        }

        const authorization = splitLearningExperimentCloseAuthorization(
          prepared.authorization,
        );
        const closeId = learningExperimentCloseId(prepared.approval);
        const closureBase = {
          tenant_id: prepared.tenantId,
          experiment_close_id: closeId,
          confirmatory_attempt_id: snapshot.confirmatory_attempt_id,
          experiment_id: snapshot.experiment_id,
          experiment_revision: snapshot.experiment_revision,
          namespace_set_sha256: snapshot.namespace_set_sha256,
          sealed_event_head_row_id: sealedEventHeadRowId,
          close_reason: prepared.approval.close_reason,
          authorization_sha256: authorization.authorization_sha256,
          authorization_payload_json: authorization.authorization_payload_json,
          authorization_mac: authorization.authorization_mac,
          authorization_nonce: prepared.approval.authorization_nonce,
          authorization_expires_at: prepared.approval.authorization_expires_at,
          authorization_key_id: prepared.approval.authorization_key_id,
          approved_by: prepared.approval.approved_by,
          authority_operation_id: prepared.operationId,
          authority_operation_scope: prepared.approval.authority_scope,
          authority_operation_kind: prepared.approval.authority_operation_kind,
          close_sha256: "0".repeat(64),
          created_by: prepared.actor,
          created_at: closedAt,
        } satisfies LiteLearningAuthorityRow;
        const closure = {
          ...closureBase,
          close_sha256: learningExperimentClosureRecordDigest(closureBase),
        } satisfies LiteLearningAuthorityRow;

        args.database.db.prepare(
          `INSERT INTO lite_learning_authorization_nonces
            (tenant_id, authorization_key_id, authorization_nonce,
             authorization_kind, authority_ref_id, authorization_sha256, created_at)
           VALUES (?, ?, ?, 'experiment_close', ?, ?, ?)`,
        ).run(
          prepared.tenantId,
          prepared.approval.authorization_key_id,
          prepared.approval.authorization_nonce,
          closeId,
          authorization.authorization_sha256,
          closedAt,
        );
        args.database.db.prepare(
          `INSERT INTO lite_learning_experiment_closures
            (tenant_id, experiment_close_id, confirmatory_attempt_id,
             experiment_id, experiment_revision, namespace_set_sha256,
             sealed_event_head_row_id, close_reason, authorization_sha256,
             authorization_payload_json, authorization_mac,
             authorization_nonce, authorization_expires_at,
             authorization_key_id, approved_by, authority_operation_id,
             authority_operation_scope, authority_operation_kind,
             close_sha256, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          closure.tenant_id,
          closure.experiment_close_id,
          closure.confirmatory_attempt_id,
          closure.experiment_id,
          closure.experiment_revision,
          closure.namespace_set_sha256,
          closure.sealed_event_head_row_id,
          closure.close_reason,
          closure.authorization_sha256,
          closure.authorization_payload_json,
          closure.authorization_mac,
          closure.authorization_nonce,
          closure.authorization_expires_at,
          closure.authorization_key_id,
          closure.approved_by,
          closure.authority_operation_id,
          closure.authority_operation_scope,
          closure.authority_operation_kind,
          closure.close_sha256,
          closure.created_by,
          closure.created_at,
        );

        const receiptBody = LearningExperimentCloseReceiptBodyV1Schema.parse({
          contract_version: "aionis_learning_experiment_close_receipt_v1",
          operation_kind: prepared.approval.authority_operation_kind,
          operation_id: prepared.operationId,
          request_sha256: prepared.requestSha256,
          tenant_id: prepared.tenantId,
          authority_scope: prepared.approval.authority_scope,
          runtime_authority_lineage_sha256: runtimeAuthorityLineageSha256,
          actor: prepared.actor,
          status: "closed",
          authorization_sha256: authorization.authorization_sha256,
          authorization_mac_sha256: authorization.authorization_mac_sha256,
          authorization_key_id: prepared.approval.authorization_key_id,
          authorization_nonce: prepared.approval.authorization_nonce,
          approved_by: prepared.approval.approved_by,
          authorization_issued_at: prepared.approval.authorization_issued_at,
          authorization_expires_at: prepared.approval.authorization_expires_at,
          task_family: snapshot.task_family,
          confirmatory_attempt_id: snapshot.confirmatory_attempt_id,
          confirmatory_attempt_sha256: snapshot.attempt_sha256,
          experiment_id: snapshot.experiment_id,
          experiment_revision: snapshot.experiment_revision,
          experiment_config_sha256: snapshot.experiment_config_sha256,
          namespace_set_sha256: snapshot.namespace_set_sha256,
          candidate_policy_implementation_sha256:
            snapshot.candidate_policy_implementation_sha256,
          gate_policy_implementation_sha256:
            snapshot.gate_policy_implementation_sha256,
          experiment_close_id: closeId,
          close_reason: prepared.approval.close_reason,
          sealed_event_head_row_id: sealedEventHeadRowId,
          close_sha256: closure.close_sha256,
          closed_at: closedAt,
          namespace_lease_membership_sha256: membership.membershipSha256,
          namespace_lease_count: 768,
          release_operation_id: prepared.operationId,
          release_ref_kind: "experiment_close",
          release_ref_id: closeId,
          released_at: closedAt,
        });
        const receipt = LearningExperimentCloseReceiptV1Schema.parse({
          ...receiptBody,
          receipt_attestation_key_id: verifiedAuthority.receiptAttestationKeyId,
          receipt_attestation_mac: learningExperimentCloseReceiptAttestationMac(
            receiptBody,
            verifiedAuthority.receiptAttestationKeyId,
            verifiedAuthority.receiptAttestationKey,
          ),
        });
        const receiptJson = stableStringify(receipt);
        await args.writeStore.insertWriteOperation({
          ...operationKey,
          requestSha256: prepared.requestSha256,
          receiptJson,
          commitId: null,
        });

        const release = args.database.db.prepare(
          `UPDATE lite_learning_namespace_leases
           SET status = 'released', release_operation_id = ?,
               release_ref_kind = 'experiment_close', release_ref_id = ?, released_at = ?
           WHERE tenant_id = ? AND confirmatory_attempt_id = ?
             AND status = 'active' AND release_operation_id IS NULL
             AND release_ref_kind IS NULL AND release_ref_id IS NULL AND released_at IS NULL`,
        ).run(
          prepared.operationId,
          closeId,
          closedAt,
          prepared.tenantId,
          snapshot.confirmatory_attempt_id,
        ) as { changes?: number };
        if (Number(release.changes ?? 0) !== membership.rows.length
          || Number(release.changes ?? 0) !== 768) {
          closingError(
            "learning_experiment_close_partial_release",
            "experiment close did not release the exact 768-member lease set",
            409,
          );
        }

        assertLiteLearningEpisodeLedgerIntegrity(
          args.database.db,
          new Date().toISOString(),
          { authorityReceiptKeyring: authorityKeyring },
        );
        return { receipt, receiptJson, replayed: false };
      });
    },
  };
}

function assertProductionClosePreflight(
  db: SqliteDatabase,
  input: LearningExperimentCloseInput,
  authorityKeyring: AuthorityReceiptResolvedKeyring,
): void {
  const prepared = prepareInput(input);
  const schema = inspectLiteRuntimeSchema(db);
  if (schema.classification !== "current"
    || schema.detected_version !== LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
    closingError(
      "learning_experiment_close_current_database_required",
      "close requires an already-current Runtime database and never performs migration",
      409,
    );
  }

  const operation = db.prepare(
      `SELECT tenant_id, scope, operation_kind, operation_id,
              request_sha256, receipt_json, commit_id, created_at
       FROM lite_runtime_write_operations
       WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
    ).get(
      prepared.tenantId,
      prepared.approval.authority_scope,
      prepared.approval.authority_operation_kind,
      prepared.operationId,
    ) as LiteWriteOperationRow | undefined;
  if (operation) {
    exactReplay({ db, operation, prepared, keyring: authorityKeyring });
    return;
  }

  assertLiteLearningEpisodeLedgerIntegrity(
    db,
    new Date().toISOString(),
    { authorityReceiptKeyring: authorityKeyring },
  );
  const verifiedAt = canonicalUtcMillis(new Date().toISOString());
  verifyFreshAuthorization({
    prepared,
    keyring: authorityKeyring,
    verifiedAt,
  });

  const databaseIdentity = db.prepare(
      "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
    ).get() as { database_instance_id: string } | undefined;
  if (!databaseIdentity) {
    closingError(
      "learning_experiment_close_runtime_identity_missing",
      "Runtime authority identity is missing",
      409,
    );
  }
  const snapshot = authoritySnapshot(
    db,
    prepared.tenantId,
    prepared.experimentId,
    prepared.experimentRevision,
  );
  assertApprovalMatchesAuthority({
    prepared,
    snapshot,
    runtimeAuthorityLineageSha256: sha256Hex(databaseIdentity.database_instance_id),
  });

  const consumedAuthority = db.prepare(
      `SELECT 1
       FROM lite_learning_experiment_closures
       WHERE tenant_id = ? AND (
         confirmatory_attempt_id = ? OR authority_operation_id = ?
         OR (authorization_key_id = ? AND authorization_nonce = ?)
       )
       LIMIT 1`,
    ).get(
      prepared.tenantId,
      snapshot.confirmatory_attempt_id,
      prepared.operationId,
      prepared.approval.authorization_key_id,
      prepared.approval.authorization_nonce,
    );
  const consumedNonce = db.prepare(
      `SELECT 1
       FROM lite_learning_authorization_nonces
       WHERE tenant_id = ? AND authorization_key_id = ? AND authorization_nonce = ?
       LIMIT 1`,
    ).get(
      prepared.tenantId,
      prepared.approval.authorization_key_id,
      prepared.approval.authorization_nonce,
    );
  if (consumedAuthority || consumedNonce) {
    closingError(
      "learning_experiment_close_authority_conflict",
      "confirmatory attempt or signed close authority is already consumed",
      409,
    );
  }
  activeLeaseMembership(
    db,
    prepared.tenantId,
    snapshot.confirmatory_attempt_id,
    snapshot,
  );
}

function preflightProductionClose(
  path: string,
  input: LearningExperimentCloseInput,
  authorityKeyring: AuthorityReceiptResolvedKeyring,
): void {
  const serviceUid = currentServiceUid();
  const sidecars = inspectTrustedSqliteSidecars(path, serviceUid);
  const db = sidecars.walPresent
    ? createSqliteReadOnlyDatabase(path)
    : createSqliteImmutableReadOnlyDatabase(path);
  let dbClosed = false;
  try {
    assertProductionClosePreflight(db, input, authorityKeyring);
  } catch (error) {
    // A live Runtime may enter WAL mode after the immutable-open decision. In
    // that case retry against the already-existing WAL/SHM pair so validation
    // observes committed state without creating sidecars on a quiescent target.
    if (!sidecars.walPresent) {
      const liveSidecars = inspectTrustedSqliteSidecars(path, serviceUid);
      if (!liveSidecars.walPresent) throw error;
      db.close();
      dbClosed = true;
      const liveDb = createSqliteReadOnlyDatabase(path);
      try {
        assertProductionClosePreflight(liveDb, input, authorityKeyring);
        return;
      } finally {
        liveDb.close();
      }
    }
    throw error;
  } finally {
    if (!dbClosed) db.close();
  }
}

type PinnedRuntimeFileIdentity = Readonly<{
  realpath: string;
  device: number;
  inode: number;
}>;

const SQLITE_CLOSE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

type TrustedSqliteSidecarState = Readonly<{
  walPresent: boolean;
  sharedMemoryPresent: boolean;
  rollbackJournalPresent: boolean;
}>;

type FilesystemAclInspectionContext = Readonly<{
  object: "database" | "sidecar" | "direct_parent" | "ancestor";
}>;

type LinuxAclEntryKind =
  | "default"
  | "duplicate_base"
  | "effective_comment"
  | "flags"
  | "incomplete_base"
  | "mask"
  | "mode_mismatch"
  | "named_group"
  | "named_user"
  | "unparseable"
  | "verifier_failure";

type ParsedLinuxDefaultAclEntry = Readonly<{
  tag: "user" | "group" | "mask" | "other";
  qualifier: string | null;
}>;

const LINUX_ACL_DIAGNOSTIC_PRIORITY: readonly LinuxAclEntryKind[] = [
  "default",
  "named_user",
  "named_group",
  "mask",
  "flags",
  "duplicate_base",
  "effective_comment",
  "unparseable",
] as const;

function filesystemTrustError(message: string): never {
  closingError(
    "learning_experiment_close_database_filesystem_untrusted",
    message,
    403,
  );
}

function currentServiceUid(): number {
  if (typeof process.getuid !== "function") {
    filesystemTrustError(
      "protected close cannot verify the current service UID on this platform",
    );
  }
  return process.getuid();
}

const ACL_INSPECTION_ENV = {
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
} as const;

function linuxAclTrustError(
  context: FilesystemAclInspectionContext,
  entryKind: LinuxAclEntryKind,
  message: string,
): never {
  filesystemTrustError(
    `${message} [object=${context.object} entry_kind=${entryKind}]`,
  );
}

function classifyRejectedLinuxAclEntry(entry: string): LinuxAclEntryKind {
  if (/^#\s*flags:/u.test(entry)) return "flags";
  if (/^mask::/u.test(entry)) return "mask";
  if (/^user:[^:]+:/u.test(entry)) return "named_user";
  if (/^group:[^:]+:/u.test(entry)) return "named_group";
  if (/\s+#effective:/u.test(entry)) return "effective_comment";
  return "unparseable";
}

function parseLinuxDefaultAclEntry(
  entry: string,
): ParsedLinuxDefaultAclEntry | null {
  const match = /^default:(user|group|mask|other):([^:]*):([r-][w-][x-])$/u
    .exec(entry);
  if (!match) return null;
  const tag = match[1] as ParsedLinuxDefaultAclEntry["tag"];
  const rawQualifier = match[2]!;
  if (tag === "mask" || tag === "other") {
    return rawQualifier.length === 0 ? { tag, qualifier: null } : null;
  }
  if (rawQualifier.length === 0) return { tag, qualifier: null };
  if (!/^(?:0|[1-9][0-9]*)$/u.test(rawQualifier)) return null;
  return { tag, qualifier: rawQualifier };
}

function isCompleteLinuxDefaultAcl(entries: readonly string[]): boolean {
  const parsed = entries.map(parseLinuxDefaultAclEntry);
  if (parsed.some((entry) => entry === null)) return false;
  const complete = parsed as ParsedLinuxDefaultAclEntry[];
  const keys = new Set<string>();
  for (const entry of complete) {
    const key = `${entry.tag}:${entry.qualifier ?? ""}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  const namedEntryCount = complete.filter(
    (entry) => entry.qualifier !== null,
  ).length;
  const hasMask = keys.has("mask:");
  return keys.has("user:")
    && keys.has("group:")
    && keys.has("other:")
    && (namedEntryCount === 0 || hasMask);
}

function assertLinuxBasicAccessControlList(
  path: string,
  context: FilesystemAclInspectionContext,
): void {
  let inspected: ReturnType<typeof spawnSync> | null = null;
  for (const executable of ["/usr/bin/getfacl", "/bin/getfacl"] as const) {
    const candidate = spawnSync(
      executable,
      ["-c", "-E", "-p", "-n", "--", path],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: ACL_INSPECTION_ENV,
      },
    );
    if (candidate.error
      && "code" in candidate.error
      && candidate.error.code === "ENOENT") {
      continue;
    }
    inspected = candidate;
    break;
  }
  if (!inspected
    || inspected.error
    || inspected.status !== 0
    || inspected.signal !== null
    || typeof inspected.stdout !== "string"
    || typeof inspected.stderr !== "string"
    || inspected.stderr.trim().length !== 0
    || inspected.stdout.includes("\ufffd")) {
    linuxAclTrustError(
      context,
      "verifier_failure",
      "protected close requires a working Linux getfacl verifier",
    );
  }
  const entries = inspected.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const baseAcl = new Map<"user" | "group" | "other", string>();
  const defaultAclEntries: string[] = [];
  const rejectedKinds = new Set<LinuxAclEntryKind>();
  for (const entry of entries) {
    if (entry.startsWith("default:")) {
      defaultAclEntries.push(entry);
      continue;
    }
    const match = /^(user|group|other)::([r-][w-][x-])$/u.exec(entry);
    if (!match) {
      rejectedKinds.add(classifyRejectedLinuxAclEntry(entry));
      continue;
    }
    const baseKind = match[1] as "user" | "group" | "other";
    if (baseAcl.has(baseKind)) {
      rejectedKinds.add("duplicate_base");
      continue;
    }
    baseAcl.set(baseKind, match[2]!);
  }
  if (defaultAclEntries.length > 0
    && (context.object !== "ancestor"
      || !isCompleteLinuxDefaultAcl(defaultAclEntries))) {
    rejectedKinds.add("default");
  }
  // A complete default ACL affects only children created directly beneath an
  // ancestor. Protected close creates SQLite sidecars in the already existing
  // direct parent, whose access and default ACLs remain checked fail-closed.
  if (rejectedKinds.size > 0) {
    const entryKind = LINUX_ACL_DIAGNOSTIC_PRIORITY.find(
      (candidate) => rejectedKinds.has(candidate),
    ) ?? "unparseable";
    linuxAclTrustError(
      context,
      entryKind,
      "protected close rejects non-basic Linux filesystem ACLs",
    );
  }
  if (baseAcl.size !== 3) {
    linuxAclTrustError(
      context,
      "incomplete_base",
      "protected close received an incomplete Linux filesystem ACL",
    );
  }
  const mode = lstatSync(path).mode;
  const permissionText = (read: number, write: number, execute: number): string => (
    `${(mode & read) !== 0 ? "r" : "-"}${(mode & write) !== 0 ? "w" : "-"}${(mode & execute) !== 0 ? "x" : "-"}`
  );
  if (baseAcl.get("user") !== permissionText(0o400, 0o200, 0o100)
    || baseAcl.get("group") !== permissionText(0o040, 0o020, 0o010)
    || baseAcl.get("other") !== permissionText(0o004, 0o002, 0o001)) {
    linuxAclTrustError(
      context,
      "mode_mismatch",
      "protected close received a Linux ACL that contradicts filesystem mode",
    );
  }
}

function assertDarwinNoDelegatedAccessControlList(path: string): void {
  const inspected = spawnSync(
    "/bin/ls",
    ["-lde", "--", path],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: ACL_INSPECTION_ENV,
    },
  );
  if (inspected.error
    || inspected.status !== 0
    || inspected.signal !== null
    || typeof inspected.stdout !== "string") {
    filesystemTrustError(
      "protected close could not verify macOS filesystem ACLs",
    );
  }
  const modeToken = inspected.stdout.trimStart().split(/\s+/u, 1)[0] ?? "";
  if (!/^[bcdlps-][rwxStTs-]{9}[@.+]?$/u.test(modeToken)) {
    filesystemTrustError(
      "protected close received an unverifiable macOS filesystem ACL result",
    );
  }
  // macOS can prefer '@' and supports deny-only ACLs (including the standard
  // home-directory `everyone deny delete` entry); `-e` exposes the entries so
  // deny-only restrictions remain acceptable while every delegated `allow`
  // entry is rejected conservatively.
  const aclLines = inspected.stdout.split(/\r?\n/u).slice(1).filter(
    (line) => /^\s*\d+:/u.test(line),
  );
  const aclUnverifiable = aclLines.some(
    (line) => !/\b(?:allow|deny)\b/u.test(line),
  );
  const delegatesAuthority = aclLines.some((line) => /\ballow\b/u.test(line));
  if ((modeToken.includes("+") && aclLines.length === 0)
    || aclUnverifiable
    || delegatesAuthority) {
    filesystemTrustError(
      "protected close rejects filesystem ACLs that delegate additional authority",
    );
  }
}

function assertNoDelegatedAccessControlList(
  path: string,
  context: FilesystemAclInspectionContext,
): void {
  if (process.platform === "linux") {
    assertLinuxBasicAccessControlList(path, context);
    return;
  }
  if (process.platform === "darwin") {
    assertDarwinNoDelegatedAccessControlList(path);
    return;
  }
  filesystemTrustError(
    "protected close cannot verify filesystem ACLs on this platform",
  );
}

function assertTrustedDirectoryChain(
  databaseRealpath: string,
  serviceUid: number,
): void {
  let directory = dirname(databaseRealpath);
  let directParent = true;
  for (;;) {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory()
      || (directoryStat.mode & 0o022) !== 0
      || (directoryStat.uid !== serviceUid && directoryStat.uid !== 0)
      || (directParent && directoryStat.uid !== serviceUid)) {
      filesystemTrustError(
        "protected close requires a current-user parent and a non-writable current-user/root ancestor chain",
      );
    }
    assertNoDelegatedAccessControlList(
      directory,
      { object: directParent ? "direct_parent" : "ancestor" },
    );
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
    directParent = false;
  }
}

function assertTrustedOwnedRegularFile(
  path: string,
  serviceUid: number,
  kind: "database" | "sidecar",
): void {
  const fileStat = lstatSync(path);
  if (!fileStat.isFile()
    || fileStat.uid !== serviceUid
    || (fileStat.mode & 0o022) !== 0) {
    filesystemTrustError(
      `protected close requires every SQLite ${kind} to be a current-user regular file without group/other write authority`,
    );
  }
  assertNoDelegatedAccessControlList(path, { object: kind });
}

function inspectTrustedSqliteSidecars(
  databaseRealpath: string,
  serviceUid: number,
): TrustedSqliteSidecarState {
  const present = new Map<string, boolean>();
  for (const suffix of SQLITE_CLOSE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databaseRealpath}${suffix}`;
    const sidecarPresent = lstatSync(
      sidecarPath,
      { throwIfNoEntry: false },
    ) !== undefined;
    present.set(suffix, sidecarPresent);
    if (sidecarPresent) {
      assertTrustedOwnedRegularFile(sidecarPath, serviceUid, "sidecar");
    }
  }
  const state = {
    walPresent: present.get("-wal") === true,
    sharedMemoryPresent: present.get("-shm") === true,
    rollbackJournalPresent: present.get("-journal") === true,
  };
  if (state.rollbackJournalPresent
    || state.walPresent !== state.sharedMemoryPresent) {
    closingError(
      "learning_experiment_close_database_recovery_required",
      "protected close requires a clean rollback state or an existing trusted WAL/SHM pair",
      409,
    );
  }
  return state;
}

function runtimeFileIdentity(path: string): PinnedRuntimeFileIdentity {
  const realpath = realpathSync.native(path);
  const stat = statSync(realpath);
  if (!stat.isFile()) {
    closingError(
      "learning_experiment_close_database_required",
      "close requires an existing regular Runtime SQLite database",
      400,
    );
  }
  return {
    realpath,
    device: stat.dev,
    inode: stat.ino,
  };
}

function assertRuntimeFileIdentityPinned(
  path: string,
  expected: PinnedRuntimeFileIdentity,
): void {
  let actual: PinnedRuntimeFileIdentity;
  try {
    actual = runtimeFileIdentity(path);
  } catch (error) {
    if (error instanceof LearningExperimentClosingError) throw error;
    closingError(
      "learning_experiment_close_database_identity_changed",
      "Runtime database path changed after protected close preflight",
      409,
    );
  }
  if (actual.realpath !== expected.realpath
    || actual.device !== expected.device
    || actual.inode !== expected.inode) {
    closingError(
      "learning_experiment_close_database_identity_changed",
      "Runtime database path changed after protected close preflight",
      409,
    );
  }
}

function openPinnedRuntimeFile(
  identity: PinnedRuntimeFileIdentity,
): number {
  const serviceUid = currentServiceUid();
  assertTrustedOwnedRegularFile(identity.realpath, serviceUid, "database");
  assertTrustedDirectoryChain(identity.realpath, serviceUid);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const descriptor = openSync(
    identity.realpath,
    fsConstants.O_RDONLY | noFollow,
  );
  const pinned = fstatSync(descriptor);
  if (!pinned.isFile()
    || pinned.dev !== identity.device
    || pinned.ino !== identity.inode) {
    closeSync(descriptor);
    closingError(
      "learning_experiment_close_database_identity_changed",
      "Runtime database changed while acquiring its protected file descriptor",
      409,
    );
  }
  return descriptor;
}

function assertPinnedRuntimeFilesystemBoundary(
  requestedPath: string,
  identity: PinnedRuntimeFileIdentity,
  descriptor: number,
): void {
  const pinned = fstatSync(descriptor);
  if (!pinned.isFile()
    || pinned.dev !== identity.device
    || pinned.ino !== identity.inode) {
    closingError(
      "learning_experiment_close_database_identity_changed",
      "Runtime database descriptor changed during protected close",
      409,
    );
  }
  assertRuntimeFileIdentityPinned(requestedPath, identity);
  const serviceUid = currentServiceUid();
  assertTrustedOwnedRegularFile(identity.realpath, serviceUid, "database");
  assertTrustedDirectoryChain(identity.realpath, serviceUid);
  inspectTrustedSqliteSidecars(identity.realpath, serviceUid);
}

export async function closeLiteLearningExperiment(
  args: LearningExperimentCloseInput & { path: string },
): Promise<LearningExperimentCloseResult> {
  let pinnedIdentity: PinnedRuntimeFileIdentity;
  try {
    pinnedIdentity = runtimeFileIdentity(args.path);
  } catch (error) {
    if (error instanceof LearningExperimentClosingError) throw error;
    closingError(
      "learning_experiment_close_database_required",
      "close requires an existing Runtime SQLite database",
      404,
    );
  }
  const pinnedDescriptor = openPinnedRuntimeFile(pinnedIdentity);
  try {
    const authorityKeyring = resolveAuthorityReceiptKeyring();
    preflightProductionClose(pinnedIdentity.realpath, args, authorityKeyring);
    assertRuntimeFileIdentityPinned(args.path, pinnedIdentity);
    const database = createLiteRuntimeProtectedWriteDatabase(pinnedIdentity.realpath);
    try {
      assertRuntimeFileIdentityPinned(args.path, pinnedIdentity);
      // Revalidate on the protected write connection before BEGIN IMMEDIATE.
      // The close transaction performs the same checks once more under lock.
      assertProductionClosePreflight(database.db, args, authorityKeyring);
      const writeStore = createProtectedCloseWriteStore(database);
      return await createLiteLearningExperimentCloser({
        database,
        writeStore,
        dependencies: {
          resolveKeyring: () => authorityKeyring,
          // Runs immediately after BEGIN IMMEDIATE and before replay/fresh
          // authority reads or logical mutation. This also validates any
          // WAL/SHM files SQLite created while acquiring the write lock.
          assertProductionBoundary: () => assertPinnedRuntimeFilesystemBoundary(
            args.path,
            pinnedIdentity,
            pinnedDescriptor,
          ),
        },
      }).close(args);
    } finally {
      await database.close();
    }
  } finally {
    closeSync(pinnedDescriptor);
  }
}
