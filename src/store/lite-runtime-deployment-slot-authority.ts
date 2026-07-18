import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "../memory/learning-episode-ledger.js";
import {
  learningRuntimeDatabaseBindingReceiptDigest,
  learningRuntimeDatabaseBindingReceiptJson,
  parseCanonicalLearningRuntimeDatabaseBindingReceiptJson,
  verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation,
  type LearningRuntimeDatabaseBindingChainExpectationV1,
  type LearningRuntimeDatabaseBindingReceiptEnvelopeV1,
} from "../memory/learning-runtime-database-binding.js";
import {
  assertLiteRuntimeProtectedAuthorityDatabasePinned,
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  openLiteRuntimeProtectedAuthorityDatabase,
  pinLiteRuntimeProtectedAuthorityDatabase,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "./lite-runtime-protected-authority-database.js";
import { assertLiteRuntimeAuthorityIdentity } from "./lite-learning-episode-ledger.js";
import { normalizeSqliteSchemaSql } from "./sqlite-schema-sql.js";
import {
  createSqliteReadWriteExistingDatabase,
  type SqliteDatabase,
} from "./sqlite.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_CANONICAL_POLICY_BYTES = 1024 * 1024;
const MAX_OPERATION_ID_BYTES = 256;
const DEPLOYMENT_SLOT_STATE_APPLICATION_ID = 0x41494f53;
const DEPLOYMENT_SLOT_LEASE_APPLICATION_ID = 0x41494f4c;
const DEPLOYMENT_SLOT_SCHEMA_VERSION = 1;
const SQLITE_AUTHORITY_NAMESPACE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export type LiteRuntimeDeploymentSlotAuthorityErrorCode =
  | "lite_runtime_deployment_slot_authority_absolute_path_required"
  | "lite_runtime_deployment_slot_authority_path_conflict"
  | "lite_runtime_deployment_slot_authority_filesystem_untrusted"
  | "lite_runtime_deployment_slot_authority_already_provisioned"
  | "lite_runtime_deployment_slot_authority_recovery_required"
  | "lite_runtime_deployment_slot_authority_schema_invalid"
  | "lite_runtime_deployment_slot_authority_integrity_failed"
  | "lite_runtime_deployment_slot_authority_slot_mismatch"
  | "lite_runtime_deployment_slot_authority_database_mismatch"
  | "lite_runtime_deployment_slot_authority_lease_contended"
  | "lite_runtime_deployment_slot_authority_lease_invalid"
  | "lite_runtime_deployment_slot_authority_lease_closed"
  | "lite_runtime_deployment_slot_authority_lease_lost"
  | "lite_runtime_deployment_slot_authority_generation_exhausted"
  | "lite_runtime_deployment_slot_authority_operation_conflict"
  | "lite_runtime_deployment_slot_authority_operation_generation_burned"
  | "lite_runtime_deployment_slot_authority_reservation_invalid"
  | "lite_runtime_deployment_slot_authority_reservation_consumed"
  | "lite_runtime_deployment_slot_authority_completion_invalid"
  | "lite_runtime_deployment_slot_authority_completion_stale"
  | "lite_runtime_deployment_slot_authority_release_failed";

export class LiteRuntimeDeploymentSlotAuthorityError extends Error {
  readonly code: LiteRuntimeDeploymentSlotAuthorityErrorCode;

  constructor(code: LiteRuntimeDeploymentSlotAuthorityErrorCode, message: string) {
    super(message);
    this.name = "LiteRuntimeDeploymentSlotAuthorityError";
    this.code = code;
  }
}

function authorityError(
  code: LiteRuntimeDeploymentSlotAuthorityErrorCode,
  message: string,
): never {
  throw new LiteRuntimeDeploymentSlotAuthorityError(code, message);
}

const leaseBrand: unique symbol = Symbol("lite-runtime-deployment-slot-exclusive-lease");
const reservationBrand: unique symbol = Symbol(
  "lite-runtime-deployment-slot-checkpoint-reservation",
);
const preparedCompletionBrand: unique symbol = Symbol(
  "lite-runtime-deployment-slot-prepared-binding-completion",
);

/**
 * Conditional process-live locking for one configured authority-path instance.
 * Its immediate mechanism is the retained BEGIN IMMEDIATE on the private
 * carrier, not a PID or timeout. Formal exclusivity additionally requires a
 * verified local-locking filesystem and an isolated carrier-holder process.
 */
export type LiteRuntimeDeploymentSlotExclusiveLeaseCapability = Readonly<{
  [leaseBrand]: "aionis_lite_runtime_deployment_slot_exclusive_lease_v1";
}>;

/** One-shot authority for a generation committed in the current durable lineage. */
export type LiteRuntimeDeploymentSlotCheckpointReservationCapability = Readonly<{
  [reservationBrand]:
    "aionis_lite_runtime_deployment_slot_checkpoint_reservation_v1";
}>;

/**
 * Opaque result of re-verifying a complete signed receipt against the live
 * reservation and the durable predecessor. It contains no signing authority.
 */
export type LiteRuntimeDeploymentSlotPreparedBindingCompletionCapability =
  Readonly<{
    [preparedCompletionBrand]:
      "aionis_lite_runtime_deployment_slot_prepared_binding_completion_v1";
  }>;

export type LiteRuntimeDeploymentSlotProvisioningInspection = Readonly<{
  contract_version:
    "aionis_lite_runtime_deployment_slot_provisioning_inspection_v1";
  authority_scope: "caller_configured_authority_path_registration";
  signing_eligible: false;
  deployment_slot: string;
  authority_state_path: string;
  lease_carrier_path: string;
  authority_instance_id: string;
  carrier_instance_id: string;
  database_realpath: string;
  database_instance_id: string;
  database_file_device: string;
  database_file_inode: string;
  first_binding_anchor_sha256: string;
  registration_sha256: string;
  slot_path_mapping: "trusted_launcher_configuration_required";
}>;

export type LiteRuntimeDeploymentSlotLeaseInspection = Readonly<{
  contract_version:
    "aionis_lite_runtime_deployment_slot_exclusive_lease_inspection_v1";
  authority_scope:
    "configured_authority_path_conditional_process_live_exclusivity";
  signing_eligible: false;
  deployment_slot: string;
  authority_state_path: string;
  lease_carrier_path: string;
  authority_instance_id: string;
  carrier_instance_id: string;
  lease_epoch: string;
  lease_holder_token_sha256: string;
  database_realpath: string;
  database_instance_id: string;
  database_file_device: string;
  database_file_inode: string;
  first_binding_anchor_sha256: string;
  current_database_binding_receipt_sha256: string | null;
  current_checkpoint_generation: string | null;
  filesystem_locking_assumption:
    "trusted_single_host_local_locking_filesystem";
  same_process_carrier_fd_isolation: "required_not_established";
  slot_path_mapping: "trusted_launcher_configuration_required";
  rollback_resistance:
    "clean_release_prefix_only_without_carrier_storage_rollback";
  required_next_capabilities: readonly [
    "verified_local_locking_filesystem",
    "isolated_carrier_lock_process",
    "launcher_slot_path_mapping",
    "nonrollback_slot_state_authority",
    "managed_runtime_writer_quiesce",
    "runtime_attestation_writer_fence",
    "live_revision_policy",
    "private_launcher_signer_channel",
  ];
}>;

export type LiteRuntimeDeploymentSlotReservationInspection = Readonly<{
  contract_version:
    "aionis_lite_runtime_deployment_slot_checkpoint_reservation_inspection_v1";
  authority_scope: "configured_authority_path_generation_and_chain_expectation";
  signing_eligible: false;
  deployment_slot: string;
  operation_id: string;
  operation_request_sha256: string;
  reservation_id: string;
  checkpoint_generation: string;
  lease_epoch: string;
  expected_binding_chain:
    | Readonly<{
      chain_kind: "first";
      first_binding_anchor_sha256: string;
    }>
    | Readonly<{
      chain_kind: "successor";
      previous_database_binding_receipt_sha256: string;
    }>;
  database_instance_id: string;
  database_file_device: string;
  database_file_inode: string;
  filesystem_locking_assumption:
    "trusted_single_host_local_locking_filesystem";
  same_process_carrier_fd_isolation: "required_not_established";
  slot_path_mapping: "trusted_launcher_configuration_required";
  rollback_resistance:
    "clean_release_prefix_only_without_carrier_storage_rollback";
  required_next_capabilities: readonly [
    "verified_local_locking_filesystem",
    "isolated_carrier_lock_process",
    "launcher_slot_path_mapping",
    "nonrollback_slot_state_authority",
    "managed_runtime_writer_quiesce",
    "runtime_attestation_writer_fence",
    "live_revision_policy",
    "private_launcher_signer_channel",
  ];
}>;

export type LiteRuntimeDeploymentSlotBindingCompletion = Readonly<{
  contract_version:
    "aionis_lite_runtime_deployment_slot_binding_completion_v1";
  authority_scope: "configured_authority_path_chain_transition";
  signing_eligible: false;
  exact_replay: boolean;
  deployment_slot: string;
  operation_id: string;
  operation_request_sha256: string;
  reservation_id: string;
  checkpoint_generation: string;
  database_binding_receipt_sha256: string;
  database_binding_receipt_json: string;
  external_execution_policy_sha256: string;
  external_execution_policy_json: string;
  completed_at: string;
  rollback_resistance:
    "current_lineage_only_without_carrier_storage_rollback";
  required_next_capabilities: readonly [
    "verified_local_locking_filesystem",
    "isolated_carrier_lock_process",
    "launcher_slot_path_mapping",
    "nonrollback_slot_state_authority",
    "managed_runtime_writer_quiesce",
    "runtime_attestation_writer_fence",
    "live_revision_policy",
    "private_launcher_signer_channel",
  ];
}>;

export type LiteRuntimeDeploymentSlotCheckpointReservationResult =
  | Readonly<{
    kind: "reserved";
    reservation: LiteRuntimeDeploymentSlotCheckpointReservationCapability;
  }>
  | Readonly<{
    kind: "completed_replay";
    completion: LiteRuntimeDeploymentSlotBindingCompletion;
  }>;

type RegistrationRow = {
  singleton: number;
  contract_version: string;
  deployment_slot: string;
  authority_instance_id: string;
  carrier_instance_id: string;
  lease_database_device: string;
  lease_database_inode: string;
  database_realpath: string;
  database_instance_id: string;
  database_file_device: string;
  database_file_inode: string;
  first_binding_anchor_sha256: string;
  registration_sha256: string;
  created_at: string;
};

type CarrierIdentityRow = {
  singleton: number;
  contract_version: string;
  deployment_slot: string;
  authority_instance_id: string;
  carrier_instance_id: string;
  state_database_device: string;
  state_database_inode: string;
  registration_sha256: string;
  created_at: string;
};

type CarrierStateWitnessRow = {
  witness_epoch: string;
  previous_witness_sha256: string | null;
  state_database_device: string;
  state_database_inode: string;
  registration_sha256: string;
  last_lease_epoch: string;
  last_checkpoint_generation: string;
  last_reservation_id: string | null;
  current_binding_receipt_sha256: string | null;
  state_semantic_sha256: string;
  witnessed_at: string;
  witness_sha256: string;
};

type OperationRow = {
  operation_id: string;
  operation_request_sha256: string;
  created_at: string;
};

type LeaseEpochRow = {
  lease_epoch: string;
  lease_holder_token_sha256: string;
  acquired_at: string;
};

type ReservationRow = {
  reservation_id: string;
  operation_id: string;
  checkpoint_generation: string;
  lease_epoch: string;
  lease_holder_token_sha256: string;
  expected_previous_receipt_sha256: string | null;
  reserved_at: string;
};

type AbandonmentRow = {
  reservation_id: string;
  closed_by_lease_epoch: string;
  reason: "lease_recovered" | "lease_released";
  abandoned_at: string;
};

type CompletionRow = {
  reservation_id: string;
  operation_id: string;
  checkpoint_generation: string;
  database_binding_receipt_sha256: string;
  database_binding_receipt_json: string;
  external_execution_policy_sha256: string;
  external_execution_policy_json: string;
  completed_at: string;
};

type DurableHead = Readonly<{
  completion: CompletionRow;
  receipt: LearningRuntimeDatabaseBindingReceiptEnvelopeV1;
  policy: ExternalExecutionPolicyV1;
}>;

type ReplayedState = Readonly<{
  registration: RegistrationRow;
  operations: ReadonlyMap<string, OperationRow>;
  leaseEpochs: readonly LeaseEpochRow[];
  reservations: readonly ReservationRow[];
  abandonments: ReadonlyMap<string, AbandonmentRow>;
  completions: ReadonlyMap<string, CompletionRow>;
  activeReservation: ReservationRow | null;
  head: DurableHead | null;
}>;

type LeaseState = {
  readonly authorityStatePath: string;
  readonly leaseCarrierPath: string;
  readonly statePin: LiteRuntimeProtectedAuthorityDatabasePin;
  readonly carrierPin: LiteRuntimeProtectedAuthorityDatabasePin;
  readonly runtimeDatabasePin: LiteRuntimeProtectedAuthorityDatabasePin;
  readonly stateDatabase: LiteRuntimeDatabase;
  readonly carrierDatabase: LiteRuntimeDatabase;
  readonly sqliteSavepoint: string;
  readonly registration: RegistrationRow;
  readonly leaseEpoch: string;
  readonly leaseHolderTokenSha256: string;
  inspection: LiteRuntimeDeploymentSlotLeaseInspection;
  activeReservationCapability:
    LiteRuntimeDeploymentSlotCheckpointReservationCapability | null;
  closed: boolean;
};

type ReservationState = {
  readonly leaseCapability: LiteRuntimeDeploymentSlotExclusiveLeaseCapability;
  readonly leaseState: LeaseState;
  readonly row: ReservationRow;
  readonly operation: OperationRow;
  readonly expectedHead: DurableHead | null;
  readonly inspection: LiteRuntimeDeploymentSlotReservationInspection;
  consumed: boolean;
};

type PreparedCompletionState = {
  readonly leaseCapability: LiteRuntimeDeploymentSlotExclusiveLeaseCapability;
  readonly reservationCapability:
    LiteRuntimeDeploymentSlotCheckpointReservationCapability;
  readonly reservationState: ReservationState;
  readonly envelope: LearningRuntimeDatabaseBindingReceiptEnvelopeV1;
  readonly envelopeJson: string;
  readonly envelopeSha256: string;
  readonly policy: ExternalExecutionPolicyV1;
  readonly policyJson: string;
  readonly policySha256: string;
  readonly expectedHeadSha256: string | null;
  consumed: boolean;
};

const leaseRegistry = new WeakMap<object, LeaseState>();
const reservationRegistry = new WeakMap<object, ReservationState>();
const preparedCompletionRegistry = new WeakMap<object, PreparedCompletionState>();

const NEXT_CAPABILITIES = Object.freeze([
  "verified_local_locking_filesystem",
  "isolated_carrier_lock_process",
  "launcher_slot_path_mapping",
  "nonrollback_slot_state_authority",
  "managed_runtime_writer_quiesce",
  "runtime_attestation_writer_fence",
  "live_revision_policy",
  "private_launcher_signer_channel",
] as const);
const RESERVATION_NEXT_CAPABILITIES = NEXT_CAPABILITIES;

const DIGEST_CHECK = String.raw`length(%COLUMN%) = 64
    AND %COLUMN% NOT GLOB '*[^0-9a-f]*'`;
const U64_CHECK = String.raw`(
    %COLUMN% = '0'
    OR (
      length(%COLUMN%) BETWEEN 1 AND 20
      AND substr(%COLUMN%, 1, 1) BETWEEN '1' AND '9'
      AND %COLUMN% NOT GLOB '*[^0-9]*'
      AND (
        length(%COLUMN%) < 20
        OR %COLUMN% <= '18446744073709551615'
      )
    )
  )`;

function digestCheck(column: string): string {
  return DIGEST_CHECK.replaceAll("%COLUMN%", column);
}

function u64Check(column: string): string {
  return U64_CHECK.replaceAll("%COLUMN%", column);
}

const CARRIER_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_lease_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  contract_version TEXT NOT NULL CHECK (
    contract_version = 'aionis_lite_runtime_deployment_slot_lease_identity_v1'
  ),
  deployment_slot TEXT NOT NULL UNIQUE CHECK (
    length(CAST(deployment_slot AS BLOB)) BETWEEN 1 AND 256
    AND deployment_slot = trim(deployment_slot)
  ),
  authority_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("authority_instance_id")}
  ),
  carrier_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("carrier_instance_id")}
  ),
  state_database_device TEXT NOT NULL CHECK (
    ${u64Check("state_database_device")}
  ),
  state_database_inode TEXT NOT NULL CHECK (
    ${u64Check("state_database_inode")}
  ),
  registration_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("registration_sha256")}
  ),
  created_at TEXT NOT NULL
) STRICT;`.trim();

const CARRIER_WITNESS_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_state_witnesses (
  witness_epoch TEXT PRIMARY KEY CHECK (
    ${u64Check("witness_epoch")} AND witness_epoch <> '0'
  ),
  previous_witness_sha256 TEXT CHECK (
    previous_witness_sha256 IS NULL OR (${digestCheck("previous_witness_sha256")})
  ),
  state_database_device TEXT NOT NULL CHECK (
    ${u64Check("state_database_device")}
  ),
  state_database_inode TEXT NOT NULL CHECK (
    ${u64Check("state_database_inode")}
  ),
  registration_sha256 TEXT NOT NULL CHECK (
    ${digestCheck("registration_sha256")}
  ),
  last_lease_epoch TEXT NOT NULL CHECK (
    ${u64Check("last_lease_epoch")}
  ),
  last_checkpoint_generation TEXT NOT NULL CHECK (
    ${u64Check("last_checkpoint_generation")}
  ),
  last_reservation_id TEXT CHECK (
    last_reservation_id IS NULL OR (${digestCheck("last_reservation_id")})
  ),
  current_binding_receipt_sha256 TEXT CHECK (
    current_binding_receipt_sha256 IS NULL OR (
      ${digestCheck("current_binding_receipt_sha256")}
    )
  ),
  state_semantic_sha256 TEXT NOT NULL CHECK (
    ${digestCheck("state_semantic_sha256")}
  ),
  witnessed_at TEXT NOT NULL,
  witness_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("witness_sha256")}
  ),
  CHECK (
    (last_checkpoint_generation = '0' AND last_reservation_id IS NULL)
    OR (last_checkpoint_generation <> '0' AND last_reservation_id IS NOT NULL)
  ),
  CHECK (
    (witness_epoch = '1' AND previous_witness_sha256 IS NULL)
    OR (witness_epoch <> '1' AND previous_witness_sha256 IS NOT NULL)
  )
) STRICT;`.trim();

const CARRIER_UPDATE_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_lease_identity_no_update
BEFORE UPDATE ON lite_runtime_deployment_slot_lease_identity
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_lease_identity_is_immutable');
END;`.trim();

const CARRIER_DELETE_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_lease_identity_no_delete
BEFORE DELETE ON lite_runtime_deployment_slot_lease_identity
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_lease_identity_is_immutable');
END;`.trim();

const CARRIER_WITNESS_UPDATE_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_state_witnesses_no_update
BEFORE UPDATE ON lite_runtime_deployment_slot_state_witnesses
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_state_witness_is_append_only');
END;`.trim();

const CARRIER_WITNESS_DELETE_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_state_witnesses_no_delete
BEFORE DELETE ON lite_runtime_deployment_slot_state_witnesses
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_state_witness_is_append_only');
END;`.trim();

const STATE_REGISTRATION_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_registration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  contract_version TEXT NOT NULL CHECK (
    contract_version = 'aionis_lite_runtime_deployment_slot_registration_v1'
  ),
  deployment_slot TEXT NOT NULL UNIQUE CHECK (
    length(CAST(deployment_slot AS BLOB)) BETWEEN 1 AND 256
    AND deployment_slot = trim(deployment_slot)
  ),
  authority_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("authority_instance_id")}
  ),
  carrier_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("carrier_instance_id")}
  ),
  lease_database_device TEXT NOT NULL CHECK (
    ${u64Check("lease_database_device")}
  ),
  lease_database_inode TEXT NOT NULL CHECK (
    ${u64Check("lease_database_inode")}
  ),
  database_realpath TEXT NOT NULL UNIQUE,
  database_instance_id TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("database_instance_id")}
  ),
  database_file_device TEXT NOT NULL CHECK (
    ${u64Check("database_file_device")}
  ),
  database_file_inode TEXT NOT NULL CHECK (
    ${u64Check("database_file_inode")}
  ),
  first_binding_anchor_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("first_binding_anchor_sha256")}
  ),
  registration_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("registration_sha256")}
  ),
  created_at TEXT NOT NULL
) STRICT;`.trim();

const STATE_OPERATIONS_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_operations (
  operation_id TEXT PRIMARY KEY CHECK (
    length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 256
    AND operation_id = trim(operation_id)
  ),
  operation_request_sha256 TEXT NOT NULL CHECK (
    ${digestCheck("operation_request_sha256")}
  ),
  created_at TEXT NOT NULL
) STRICT;`.trim();

const STATE_LEASE_EPOCHS_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_lease_epochs (
  lease_epoch TEXT PRIMARY KEY CHECK (
    ${u64Check("lease_epoch")} AND lease_epoch <> '0'
  ),
  lease_holder_token_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("lease_holder_token_sha256")}
  ),
  acquired_at TEXT NOT NULL
) STRICT;`.trim();

const STATE_RESERVATIONS_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_checkpoint_reservations (
  reservation_id TEXT PRIMARY KEY CHECK (
    ${digestCheck("reservation_id")}
  ),
  operation_id TEXT NOT NULL UNIQUE REFERENCES
    lite_runtime_deployment_slot_operations(operation_id),
  checkpoint_generation TEXT NOT NULL UNIQUE CHECK (
    ${u64Check("checkpoint_generation")} AND checkpoint_generation <> '0'
  ),
  lease_epoch TEXT NOT NULL REFERENCES
    lite_runtime_deployment_slot_lease_epochs(lease_epoch),
  lease_holder_token_sha256 TEXT NOT NULL REFERENCES
    lite_runtime_deployment_slot_lease_epochs(lease_holder_token_sha256),
  expected_previous_receipt_sha256 TEXT CHECK (
    expected_previous_receipt_sha256 IS NULL OR (
      ${digestCheck("expected_previous_receipt_sha256")}
    )
  ),
  reserved_at TEXT NOT NULL
) STRICT;`.trim();

const STATE_ABANDONMENTS_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_reservation_abandonments (
  reservation_id TEXT PRIMARY KEY REFERENCES
    lite_runtime_deployment_slot_checkpoint_reservations(reservation_id),
  closed_by_lease_epoch TEXT NOT NULL REFERENCES
    lite_runtime_deployment_slot_lease_epochs(lease_epoch),
  reason TEXT NOT NULL CHECK (reason IN ('lease_recovered', 'lease_released')),
  abandoned_at TEXT NOT NULL
) STRICT;`.trim();

const STATE_COMPLETIONS_TABLE_SQL = String.raw`
CREATE TABLE lite_runtime_deployment_slot_binding_completions (
  reservation_id TEXT PRIMARY KEY REFERENCES
    lite_runtime_deployment_slot_checkpoint_reservations(reservation_id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES
    lite_runtime_deployment_slot_operations(operation_id),
  checkpoint_generation TEXT NOT NULL UNIQUE CHECK (
    ${u64Check("checkpoint_generation")} AND checkpoint_generation <> '0'
  ),
  database_binding_receipt_sha256 TEXT NOT NULL UNIQUE CHECK (
    ${digestCheck("database_binding_receipt_sha256")}
  ),
  database_binding_receipt_json TEXT NOT NULL CHECK (
    json_valid(database_binding_receipt_json)
    AND length(CAST(database_binding_receipt_json AS BLOB)) <= 16384
  ),
  external_execution_policy_sha256 TEXT NOT NULL CHECK (
    ${digestCheck("external_execution_policy_sha256")}
  ),
  external_execution_policy_json TEXT NOT NULL CHECK (
    json_valid(external_execution_policy_json)
    AND length(CAST(external_execution_policy_json AS BLOB)) <= 1048576
  ),
  completed_at TEXT NOT NULL
) STRICT;`.trim();

function immutableTriggers(table: string): readonly string[] {
  return Object.freeze([
    String.raw`
CREATE TRIGGER ${table}_no_update
BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table}_is_append_only');
END;`.trim(),
    String.raw`
CREATE TRIGGER ${table}_no_delete
BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table}_is_append_only');
END;`.trim(),
  ]);
}

const STATE_IMMUTABLE_TABLES = [
  "lite_runtime_deployment_slot_registration",
  "lite_runtime_deployment_slot_operations",
  "lite_runtime_deployment_slot_lease_epochs",
  "lite_runtime_deployment_slot_checkpoint_reservations",
  "lite_runtime_deployment_slot_reservation_abandonments",
  "lite_runtime_deployment_slot_binding_completions",
] as const;

const STATE_COMPLETION_EXCLUSION_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_completion_excludes_abandonment
BEFORE INSERT ON lite_runtime_deployment_slot_binding_completions
WHEN EXISTS (
  SELECT 1 FROM lite_runtime_deployment_slot_reservation_abandonments
  WHERE reservation_id = NEW.reservation_id
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_reservation_already_abandoned');
END;`.trim();

const STATE_ABANDONMENT_EXCLUSION_TRIGGER_SQL = String.raw`
CREATE TRIGGER lite_runtime_deployment_slot_abandonment_excludes_completion
BEFORE INSERT ON lite_runtime_deployment_slot_reservation_abandonments
WHEN EXISTS (
  SELECT 1 FROM lite_runtime_deployment_slot_binding_completions
  WHERE reservation_id = NEW.reservation_id
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_slot_reservation_already_completed');
END;`.trim();

const CARRIER_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: "table", name: "lite_runtime_deployment_slot_lease_identity",
    sql: CARRIER_TABLE_SQL }),
  Object.freeze({ type: "table", name: "lite_runtime_deployment_slot_state_witnesses",
    sql: CARRIER_WITNESS_TABLE_SQL }),
  Object.freeze({ type: "trigger",
    name: "lite_runtime_deployment_slot_lease_identity_no_update",
    sql: CARRIER_UPDATE_TRIGGER_SQL }),
  Object.freeze({ type: "trigger",
    name: "lite_runtime_deployment_slot_lease_identity_no_delete",
    sql: CARRIER_DELETE_TRIGGER_SQL }),
  Object.freeze({ type: "trigger",
    name: "lite_runtime_deployment_slot_state_witnesses_no_update",
    sql: CARRIER_WITNESS_UPDATE_TRIGGER_SQL }),
  Object.freeze({ type: "trigger",
    name: "lite_runtime_deployment_slot_state_witnesses_no_delete",
    sql: CARRIER_WITNESS_DELETE_TRIGGER_SQL }),
] as const);

const STATE_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: "table", name: "lite_runtime_deployment_slot_registration",
    sql: STATE_REGISTRATION_TABLE_SQL }),
  Object.freeze({ type: "table", name: "lite_runtime_deployment_slot_operations",
    sql: STATE_OPERATIONS_TABLE_SQL }),
  Object.freeze({ type: "table", name: "lite_runtime_deployment_slot_lease_epochs",
    sql: STATE_LEASE_EPOCHS_TABLE_SQL }),
  Object.freeze({ type: "table",
    name: "lite_runtime_deployment_slot_checkpoint_reservations",
    sql: STATE_RESERVATIONS_TABLE_SQL }),
  Object.freeze({ type: "table",
    name: "lite_runtime_deployment_slot_reservation_abandonments",
    sql: STATE_ABANDONMENTS_TABLE_SQL }),
  Object.freeze({ type: "table",
    name: "lite_runtime_deployment_slot_binding_completions",
    sql: STATE_COMPLETIONS_TABLE_SQL }),
  ...STATE_IMMUTABLE_TABLES.flatMap((table) => immutableTriggers(table).map(
    (sql, index) => Object.freeze({
      type: "trigger" as const,
      name: `${table}_no_${index === 0 ? "update" : "delete"}`,
      sql,
    }),
  )),
  Object.freeze({ type: "trigger",
    name: "lite_runtime_deployment_slot_completion_excludes_abandonment",
    sql: STATE_COMPLETION_EXCLUSION_TRIGGER_SQL }),
  Object.freeze({ type: "trigger",
    name: "lite_runtime_deployment_slot_abandonment_excludes_completion",
    sql: STATE_ABANDONMENT_EXCLUSION_TRIGGER_SQL }),
] as const);

const CARRIER_SCHEMA_SQL = CARRIER_SCHEMA_OBJECTS.map((entry) => entry.sql).join("\n");
const STATE_SCHEMA_SQL = STATE_SCHEMA_OBJECTS.map((entry) => entry.sql).join("\n");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received an invalid ${label}`,
    );
  }
  return value;
}

function assertBoundedId(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_OPERATION_ID_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received an invalid ${label}`,
    );
  }
  return value;
}

function parseCanonicalU64(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received a non-canonical ${label}`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64 || (positive && parsed === 0n)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received an out-of-range ${label}`,
    );
  }
  return parsed;
}

function incrementU64(
  value: bigint,
  label: "lease epoch" | "checkpoint generation" | "carrier witness epoch",
): string {
  if (value >= MAX_U64) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_generation_exhausted",
      `deployment-slot ${label} is exhausted`,
    );
  }
  return (value + 1n).toString(10);
}

function canonicalTime(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received an invalid ${label}`,
    );
  }
  return assertCanonicalTime(value.toISOString(), label);
}

function assertCanonicalTime(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received a non-canonical ${label}`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot authority received an invalid ${label}`,
    );
  }
  return value;
}

function randomDigest(
  factory: ((size: number) => Uint8Array) | undefined,
  label: string,
): string {
  const bytes = factory?.(32) ?? randomBytes(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot ${label} requires exactly 32 random bytes`,
    );
  }
  return sha256(bytes);
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_absolute_path_required",
      `deployment-slot ${label} must be an absolute path`,
    );
  }
  return value;
}

function assertDisjointSqlitePathNamespaces(
  paths: readonly Readonly<{ label: string; path: string }>[],
): void {
  const names: Array<Readonly<{ label: string; path: string }>> = [];
  // Provisioning must also be safe on case-folding and normalization-folding
  // filesystems such as default APFS. Base collation deliberately over-rejects
  // some names that a case-sensitive filesystem could otherwise distinguish.
  const collator = new Intl.Collator("und", {
    usage: "search",
    sensitivity: "base",
  });
  for (const entry of paths) {
    for (const suffix of SQLITE_AUTHORITY_NAMESPACE_SUFFIXES) {
      const candidate = `${entry.path}${suffix}`;
      for (const previous of names) {
        if (dirname(previous.path) !== dirname(candidate)) continue;
        const previousName = basename(previous.path);
        const candidateName = basename(candidate);
        if (previousName === candidateName
          || previousName.normalize("NFD").toLowerCase()
            === candidateName.normalize("NFD").toLowerCase()
          || collator.compare(previousName, candidateName) === 0) {
          return authorityError(
            "lite_runtime_deployment_slot_authority_path_conflict",
            `deployment-slot SQLite namespaces overlap between ${previous.label} and ${entry.label}`,
          );
        }
      }
      names.push({ label: entry.label, path: candidate });
    }
  }
}

/** The lease carrier name is fixed; callers cannot redirect it independently. */
export function liteRuntimeDeploymentSlotLeaseCarrierPath(
  authorityStatePath: string,
): string {
  return `${requireAbsolutePath(authorityStatePath, "authority state path")}.lease`;
}

function closeDescriptorBestEffort(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the authority error that caused cleanup.
  }
}

function closeDatabaseBestEffort(database: LiteRuntimeDatabase | null): void {
  if (!database) return;
  try {
    void database.close().catch(() => undefined);
  } catch {
    // Preserve the authority error that caused cleanup.
  }
}

function closePinBestEffort(pin: LiteRuntimeProtectedAuthorityDatabasePin | null): void {
  if (!pin) return;
  try {
    closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
  } catch {
    // Preserve the authority error that caused cleanup.
  }
}

function pragmaScalar(db: SqliteDatabase, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  return Object.values(row as Record<string, unknown>)[0];
}

function assertDatabasePragmas(
  db: SqliteDatabase,
  expectedApplicationId: number,
  expectedJournalMode: "delete" | "wal",
  label: string,
): void {
  if (pragmaScalar(db, "application_id") !== expectedApplicationId
    || pragmaScalar(db, "user_version") !== DEPLOYMENT_SLOT_SCHEMA_VERSION
    || pragmaScalar(db, "journal_mode") !== expectedJournalMode
    || pragmaScalar(db, "synchronous") !== 3
    || pragmaScalar(db, "fullfsync") !== 1
    || pragmaScalar(db, "checkpoint_fullfsync") !== 1
    || pragmaScalar(db, "trusted_schema") !== 0
    || pragmaScalar(db, "busy_timeout") !== 0) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_schema_invalid",
      `deployment-slot ${label} SQLite pragmas do not match the v1 contract`,
    );
  }
  const foreignKeys = pragmaScalar(db, "foreign_keys");
  if (foreignKeys !== 1) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_schema_invalid",
      `deployment-slot ${label} requires SQLite foreign keys`,
    );
  }
}

function assertExactSchema(
  db: SqliteDatabase,
  expected: readonly Readonly<{ type: "table" | "trigger"; name: string; sql: string }>[],
  label: string,
): void {
  const actual = db.prepare(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; sql: string | null }>;
  const expectedSorted = [...expected].sort(
    (left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name),
  );
  if (actual.length !== expectedSorted.length) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_schema_invalid",
      `deployment-slot ${label} schema object count is invalid`,
    );
  }
  for (let index = 0; index < expectedSorted.length; index += 1) {
    const expectedEntry = expectedSorted[index]!;
    const actualEntry = actual[index];
    if (!actualEntry
      || actualEntry.type !== expectedEntry.type
      || actualEntry.name !== expectedEntry.name
      || actualEntry.sql === null
      || normalizeSqliteSchemaSql(actualEntry.sql)
        !== normalizeSqliteSchemaSql(expectedEntry.sql)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_schema_invalid",
        `deployment-slot ${label} schema object ${expectedEntry.name} is invalid`,
      );
    }
  }
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot ${label} SQLite integrity check failed`,
    );
  }
  const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyProblems.length !== 0) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot ${label} SQLite foreign-key check failed`,
    );
  }
}

function configureAuthorityDatabase(
  db: SqliteDatabase,
  applicationId: number,
  journalMode: "DELETE" | "WAL",
): void {
  const selectedJournalMode = pragmaScalar(db, `journal_mode=${journalMode}`);
  if (selectedJournalMode !== journalMode.toLowerCase()) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_schema_invalid",
      `deployment-slot authority requires SQLite ${journalMode} journal mode`,
    );
  }
  db.exec(`
    PRAGMA synchronous = EXTRA;
    PRAGMA fullfsync = ON;
    PRAGMA checkpoint_fullfsync = ON;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA busy_timeout = 0;
    PRAGMA application_id = ${applicationId};
    PRAGMA user_version = ${DEPLOYMENT_SLOT_SCHEMA_VERSION};
  `);
}

function syncPath(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
}

function syncFileAndDirectory(path: string): void {
  syncPath(path);
  syncPath(dirname(path));
}

function syncStateDatabaseFiles(path: string): void {
  syncPath(path);
  // WAL contains committed authority state. SHM is transient coordination
  // metadata and is intentionally not treated as a durable artifact.
  for (const suffix of ["-wal"] as const) {
    const sidecar = `${path}${suffix}`;
    if (pathExists(sidecar)) syncPath(sidecar);
  }
  syncPath(dirname(path));
}

function assertTrustedProvisioningParent(path: string): void {
  const parent = dirname(path);
  let realParent: string;
  let stat: BigIntStats;
  try {
    realParent = realpathSync(parent);
    stat = lstatSync(realParent, { bigint: true });
  } catch {
    return authorityError(
      "lite_runtime_deployment_slot_authority_filesystem_untrusted",
      "deployment-slot authority parent directory must already exist",
    );
  }
  if (realParent !== parent
    || !stat.isDirectory()
    || typeof process.getuid !== "function"
    || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o022n) !== 0n) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_filesystem_untrusted",
      "deployment-slot authority requires a canonical owner-controlled parent directory",
    );
  }
}

function createEmptyAuthorityFile(path: string): void {
  assertTrustedProvisioningParent(path);
  if (typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof fsConstants.O_EXCL !== "number") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_filesystem_untrusted",
      "deployment-slot authority requires O_NOFOLLOW and O_EXCL",
    );
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_RDWR
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()
      || stat.nlink !== 1n
      || typeof process.getuid !== "function"
      || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_filesystem_untrusted",
        "deployment-slot authority file was not created as a private regular file",
      );
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotAuthorityError) throw error;
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "EEXIST") {
      return authorityError(
        "lite_runtime_deployment_slot_authority_already_provisioned",
        "deployment-slot authority path already exists; implicit replacement is forbidden",
      );
    }
    return authorityError(
      "lite_runtime_deployment_slot_authority_recovery_required",
      "deployment-slot authority file creation failed and requires explicit recovery",
    );
  } finally {
    if (descriptor !== null) closeDescriptorBestEffort(descriptor);
  }
  syncPath(dirname(path));
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") return false;
    return authorityError(
      "lite_runtime_deployment_slot_authority_filesystem_untrusted",
      "deployment-slot authority path could not be inspected",
    );
  }
}

function assertProvisioningPairAbsent(statePath: string, carrierPath: string): void {
  const stateExists = pathExists(statePath);
  const carrierExists = pathExists(carrierPath);
  if (stateExists && carrierExists) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_already_provisioned",
      "deployment-slot authority is already provisioned",
    );
  }
  if (stateExists || carrierExists) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_recovery_required",
      "deployment-slot authority is partially provisioned and requires explicit recovery",
    );
  }
}

function initializeCarrier(
  path: string,
  row: CarrierIdentityRow,
): void {
  const db = createSqliteReadWriteExistingDatabase(path);
  try {
    configureAuthorityDatabase(db, DEPLOYMENT_SLOT_LEASE_APPLICATION_ID, "WAL");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(CARRIER_SCHEMA_SQL);
      db.prepare(
        `INSERT INTO lite_runtime_deployment_slot_lease_identity
           (singleton, contract_version, deployment_slot, authority_instance_id,
            carrier_instance_id, state_database_device, state_database_inode,
            registration_sha256, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.contract_version,
        row.deployment_slot,
        row.authority_instance_id,
        row.carrier_instance_id,
        row.state_database_device,
        row.state_database_inode,
        row.registration_sha256,
        row.created_at,
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve first error */ }
      throw error;
    }
    assertDatabasePragmas(
      db,
      DEPLOYMENT_SLOT_LEASE_APPLICATION_ID,
      "wal",
      "lease carrier",
    );
    assertExactSchema(db, CARRIER_SCHEMA_OBJECTS, "lease carrier");
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
  syncStateDatabaseFiles(path);
}

function registrationProjection(row: Omit<RegistrationRow, "registration_sha256">): string {
  return stableStringify({
    contract_version: row.contract_version,
    deployment_slot: row.deployment_slot,
    authority_instance_id: row.authority_instance_id,
    carrier_instance_id: row.carrier_instance_id,
    lease_database_device: row.lease_database_device,
    lease_database_inode: row.lease_database_inode,
    database_realpath: row.database_realpath,
    database_instance_id: row.database_instance_id,
    database_file_device: row.database_file_device,
    database_file_inode: row.database_file_inode,
    first_binding_anchor_sha256: row.first_binding_anchor_sha256,
    created_at: row.created_at,
  });
}

function initializeState(path: string, row: RegistrationRow): void {
  const db = createSqliteReadWriteExistingDatabase(path);
  try {
    configureAuthorityDatabase(db, DEPLOYMENT_SLOT_STATE_APPLICATION_ID, "WAL");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(STATE_SCHEMA_SQL);
      db.prepare(
        `INSERT INTO lite_runtime_deployment_slot_registration
           (singleton, contract_version, deployment_slot, authority_instance_id,
            carrier_instance_id, lease_database_device, lease_database_inode,
            database_realpath, database_instance_id, database_file_device,
            database_file_inode, first_binding_anchor_sha256,
            registration_sha256, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.contract_version,
        row.deployment_slot,
        row.authority_instance_id,
        row.carrier_instance_id,
        row.lease_database_device,
        row.lease_database_inode,
        row.database_realpath,
        row.database_instance_id,
        row.database_file_device,
        row.database_file_inode,
        row.first_binding_anchor_sha256,
        row.registration_sha256,
        row.created_at,
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve first error */ }
      throw error;
    }
    assertDatabasePragmas(
      db,
      DEPLOYMENT_SLOT_STATE_APPLICATION_ID,
      "wal",
      "durable state",
    );
    assertExactSchema(db, STATE_SCHEMA_OBJECTS, "durable state");
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
  syncStateDatabaseFiles(path);
}

function readRuntimeDatabaseIdentity(
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
): string {
  const database = openLiteRuntimeProtectedAuthorityDatabase(pin);
  try {
    return assertLiteRuntimeAuthorityIdentity(database.db);
  } finally {
    void database.close().catch(() => undefined);
  }
}

/**
 * One-time launcher provisioning. The Runtime path and physical identity are
 * derived from an opaque protected-database pin; callers cannot register a
 * display path or a free-standing database identifier as authority.
 */
export function provisionLiteRuntimeDeploymentSlotAuthority(args: Readonly<{
  authorityStatePath: string;
  deploymentSlot: string;
  runtimeDatabasePin: LiteRuntimeProtectedAuthorityDatabasePin;
  now?: Date;
  randomBytesFactory?: (size: number) => Uint8Array;
}>): LiteRuntimeDeploymentSlotProvisioningInspection {
  const authorityStatePath = requireAbsolutePath(
    args.authorityStatePath,
    "authority state path",
  );
  const leaseCarrierPath = liteRuntimeDeploymentSlotLeaseCarrierPath(authorityStatePath);
  const deploymentSlot = assertBoundedId(args.deploymentSlot, "deployment slot");
  const runtimeInspection = assertLiteRuntimeProtectedAuthorityDatabasePinned(
    args.runtimeDatabasePin,
  );
  assertTrustedProvisioningParent(authorityStatePath);
  assertTrustedProvisioningParent(leaseCarrierPath);
  assertDisjointSqlitePathNamespaces([
    { label: "durable state", path: authorityStatePath },
    { label: "lease carrier", path: leaseCarrierPath },
    { label: "Runtime database", path: runtimeInspection.database_realpath },
  ]);
  assertProvisioningPairAbsent(authorityStatePath, leaseCarrierPath);
  const databaseInstanceId = readRuntimeDatabaseIdentity(args.runtimeDatabasePin);
  const createdAt = canonicalTime(args.now ?? new Date(), "provisioning time");
  const authorityInstanceId = randomDigest(
    args.randomBytesFactory,
    "authority instance",
  );
  const carrierInstanceId = randomDigest(
    args.randomBytesFactory,
    "carrier instance",
  );
  const firstBindingAnchorSha256 = randomDigest(
    args.randomBytesFactory,
    "first-binding anchor",
  );

  // Create both inodes before initializing either database so each side can
  // bind the other's physical identity without a circular pathname lookup.
  createEmptyAuthorityFile(leaseCarrierPath);
  createEmptyAuthorityFile(authorityStatePath);
  const carrierStat = lstatSync(leaseCarrierPath, { bigint: true });
  const stateStat = lstatSync(authorityStatePath, { bigint: true });
  if (!carrierStat.isFile() || carrierStat.nlink !== 1n
    || !stateStat.isFile() || stateStat.nlink !== 1n) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_recovery_required",
      "deployment-slot lease carrier changed during provisioning",
    );
  }

  const registrationWithoutDigest: Omit<RegistrationRow, "registration_sha256"> = {
    singleton: 1,
    contract_version: "aionis_lite_runtime_deployment_slot_registration_v1",
    deployment_slot: deploymentSlot,
    authority_instance_id: authorityInstanceId,
    carrier_instance_id: carrierInstanceId,
    lease_database_device: carrierStat.dev.toString(10),
    lease_database_inode: carrierStat.ino.toString(10),
    database_realpath: runtimeInspection.database_realpath,
    database_instance_id: databaseInstanceId,
    database_file_device: String(runtimeInspection.database_device),
    database_file_inode: String(runtimeInspection.database_inode),
    first_binding_anchor_sha256: firstBindingAnchorSha256,
    created_at: createdAt,
  };
  const registration: RegistrationRow = {
    ...registrationWithoutDigest,
    registration_sha256: sha256(registrationProjection(registrationWithoutDigest)),
  };

  initializeCarrier(leaseCarrierPath, {
    singleton: 1,
    contract_version: "aionis_lite_runtime_deployment_slot_lease_identity_v1",
    deployment_slot: deploymentSlot,
    authority_instance_id: authorityInstanceId,
    carrier_instance_id: carrierInstanceId,
    state_database_device: stateStat.dev.toString(10),
    state_database_inode: stateStat.ino.toString(10),
    registration_sha256: registration.registration_sha256,
    created_at: createdAt,
  });
  initializeState(authorityStatePath, registration);

  let carrierPin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let statePin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let carrierDatabase: LiteRuntimeDatabase | null = null;
  let stateDatabase: LiteRuntimeDatabase | null = null;
  try {
    carrierPin = pinLiteRuntimeProtectedAuthorityDatabase(leaseCarrierPath);
    statePin = pinLiteRuntimeProtectedAuthorityDatabase(authorityStatePath);
    carrierDatabase = openLiteRuntimeProtectedAuthorityDatabase(carrierPin);
    stateDatabase = openLiteRuntimeProtectedAuthorityDatabase(statePin);
    configureOpenedAuthorityDatabase(carrierDatabase.db);
    configureOpenedAuthorityDatabase(stateDatabase.db);
    const carrierIdentity = assertCarrierIdentity(
      carrierDatabase.db,
      deploymentSlot,
      registration,
      carrierPin,
    );
    const replayed = replayDurableState(stateDatabase.db);
    assertRegistrationMatches(replayed.registration, registration);
    carrierDatabase.db.exec("BEGIN IMMEDIATE");
    try {
      insertCarrierWitness(
        carrierDatabase.db,
        buildCarrierWitness(replayed, statePin, "1", createdAt, null),
      );
      carrierDatabase.db.exec("COMMIT");
    } catch (error) {
      try { carrierDatabase.db.exec("ROLLBACK"); } catch { /* preserve first error */ }
      throw error;
    }
    assertLiteRuntimeProtectedAuthorityDatabasePinned(carrierPin);
    syncStateDatabaseFiles(leaseCarrierPath);
    assertCarrierWitnesses(carrierDatabase.db, carrierIdentity, replayed, statePin);
  } finally {
    closeDatabaseBestEffort(stateDatabase);
    closeDatabaseBestEffort(carrierDatabase);
    closePinBestEffort(statePin);
    closePinBestEffort(carrierPin);
  }

  return Object.freeze({
    contract_version:
      "aionis_lite_runtime_deployment_slot_provisioning_inspection_v1" as const,
    authority_scope: "caller_configured_authority_path_registration" as const,
    signing_eligible: false as const,
    deployment_slot: deploymentSlot,
    authority_state_path: authorityStatePath,
    lease_carrier_path: leaseCarrierPath,
    authority_instance_id: authorityInstanceId,
    carrier_instance_id: carrierInstanceId,
    database_realpath: runtimeInspection.database_realpath,
    database_instance_id: databaseInstanceId,
    database_file_device: String(runtimeInspection.database_device),
    database_file_inode: String(runtimeInspection.database_inode),
    first_binding_anchor_sha256: firstBindingAnchorSha256,
    registration_sha256: registration.registration_sha256,
    slot_path_mapping: "trusted_launcher_configuration_required" as const,
  });
}

function configureOpenedAuthorityDatabase(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA synchronous = EXTRA;
    PRAGMA fullfsync = ON;
    PRAGMA checkpoint_fullfsync = ON;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA busy_timeout = 0;
  `);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      `deployment-slot ${label} row shape is invalid`,
    );
  }
}

function readSingletonRegistration(db: SqliteDatabase): RegistrationRow {
  const rows = db.prepare(
    "SELECT * FROM lite_runtime_deployment_slot_registration ORDER BY singleton",
  ).all() as Array<Record<string, unknown>>;
  if (rows.length !== 1) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot durable state must contain one registration",
    );
  }
  const row = rows[0]!;
  const keys = [
    "singleton", "contract_version", "deployment_slot", "authority_instance_id",
    "carrier_instance_id", "lease_database_device", "lease_database_inode",
    "database_realpath", "database_instance_id", "database_file_device",
    "database_file_inode", "first_binding_anchor_sha256", "registration_sha256",
    "created_at",
  ] as const;
  assertExactKeys(row, keys, "registration");
  const registration = row as unknown as RegistrationRow;
  if (registration.singleton !== 1
    || registration.contract_version
      !== "aionis_lite_runtime_deployment_slot_registration_v1") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot registration singleton is invalid",
    );
  }
  assertBoundedId(registration.deployment_slot, "registered deployment slot");
  assertDigest(registration.authority_instance_id, "authority instance id");
  assertDigest(registration.carrier_instance_id, "carrier instance id");
  parseCanonicalU64(registration.lease_database_device, "lease database device");
  parseCanonicalU64(registration.lease_database_inode, "lease database inode");
  requireAbsolutePath(registration.database_realpath, "registered Runtime database path");
  if (realpathSync(registration.database_realpath) !== registration.database_realpath) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_database_mismatch",
      "deployment-slot Runtime database mapping is no longer canonical",
    );
  }
  assertDigest(registration.database_instance_id, "database instance id");
  parseCanonicalU64(registration.database_file_device, "database file device");
  parseCanonicalU64(registration.database_file_inode, "database file inode");
  assertDigest(registration.first_binding_anchor_sha256, "first-binding anchor");
  assertDigest(registration.registration_sha256, "registration digest");
  assertCanonicalTime(registration.created_at, "registration time");
  const { registration_sha256: _ignored, ...withoutDigest } = registration;
  if (sha256(registrationProjection(withoutDigest)) !== registration.registration_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot registration digest is invalid",
    );
  }
  return registration;
}

function assertRegistrationMatches(
  actual: RegistrationRow,
  expected: RegistrationRow,
): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot registration changed after provisioning",
    );
  }
}

function readCarrierIdentity(db: SqliteDatabase): CarrierIdentityRow {
  const rows = db.prepare(
    "SELECT * FROM lite_runtime_deployment_slot_lease_identity ORDER BY singleton",
  ).all() as Array<Record<string, unknown>>;
  if (rows.length !== 1) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot lease carrier must contain one identity",
    );
  }
  const row = rows[0]!;
  assertExactKeys(row, [
    "singleton", "contract_version", "deployment_slot", "authority_instance_id",
    "carrier_instance_id", "state_database_device", "state_database_inode",
    "registration_sha256", "created_at",
  ], "lease identity");
  const identity = row as unknown as CarrierIdentityRow;
  if (identity.singleton !== 1
    || identity.contract_version
      !== "aionis_lite_runtime_deployment_slot_lease_identity_v1") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot lease identity singleton is invalid",
    );
  }
  assertBoundedId(identity.deployment_slot, "lease deployment slot");
  assertDigest(identity.authority_instance_id, "lease authority instance id");
  assertDigest(identity.carrier_instance_id, "lease carrier instance id");
  parseCanonicalU64(identity.state_database_device, "registered state database device");
  parseCanonicalU64(identity.state_database_inode, "registered state database inode");
  assertDigest(identity.registration_sha256, "lease registration digest");
  assertCanonicalTime(identity.created_at, "lease carrier creation time");
  return identity;
}

function assertCarrierIdentity(
  db: SqliteDatabase,
  expectedDeploymentSlot: string,
  registration: RegistrationRow,
  pin: LiteRuntimeProtectedAuthorityDatabasePin,
): CarrierIdentityRow {
  assertDatabasePragmas(
    db,
    DEPLOYMENT_SLOT_LEASE_APPLICATION_ID,
    "wal",
    "lease carrier",
  );
  assertExactSchema(db, CARRIER_SCHEMA_OBJECTS, "lease carrier");
  const identity = readCarrierIdentity(db);
  const inspection = assertLiteRuntimeProtectedAuthorityDatabasePinned(pin);
  if (identity.deployment_slot !== expectedDeploymentSlot
    || registration.deployment_slot !== expectedDeploymentSlot) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_slot_mismatch",
      "deployment-slot lease carrier does not belong to the requested slot",
    );
  }
  if (identity.authority_instance_id !== registration.authority_instance_id
    || identity.carrier_instance_id !== registration.carrier_instance_id
    || identity.registration_sha256 !== registration.registration_sha256
    || String(inspection.database_device) !== registration.lease_database_device
    || String(inspection.database_inode) !== registration.lease_database_inode) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot lease carrier is not the registered physical carrier",
    );
  }
  return identity;
}

function canonicalPolicy(value: unknown): Readonly<{
  policy: ExternalExecutionPolicyV1;
  json: string;
  sha256: string;
}> {
  const policy = ExternalExecutionPolicyV1Schema.parse(value);
  const json = stableStringify(policy);
  if (Buffer.byteLength(json, "utf8") > MAX_CANONICAL_POLICY_BYTES) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot historical execution policy exceeds the canonical byte limit",
    );
  }
  return Object.freeze({ policy, json, sha256: externalExecutionPolicyDigest(policy) });
}

function parseStoredPolicy(row: CompletionRow): ExternalExecutionPolicyV1 {
  if (Buffer.byteLength(row.external_execution_policy_json, "utf8")
      > MAX_CANONICAL_POLICY_BYTES) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored historical policy is oversized",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(row.external_execution_policy_json) as unknown;
  } catch {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored historical policy is invalid JSON",
    );
  }
  const canonical = canonicalPolicy(value);
  if (canonical.json !== row.external_execution_policy_json
    || canonical.sha256 !== row.external_execution_policy_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored historical policy is non-canonical or digest-mismatched",
    );
  }
  return canonical.policy;
}

function rowsOf<T extends Record<string, unknown>>(
  db: SqliteDatabase,
  table: string,
): T[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as T[];
}

function sortCanonicalU64Rows<T>(
  rows: readonly T[],
  selector: (row: T) => string,
): T[] {
  return [...rows].sort((left, right) => {
    const leftValue = parseCanonicalU64(selector(left), "sortable integer");
    const rightValue = parseCanonicalU64(selector(right), "sortable integer");
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
}

function assertOperationRow(row: Record<string, unknown>): OperationRow {
  assertExactKeys(row, ["operation_id", "operation_request_sha256", "created_at"],
    "operation");
  const operation = row as unknown as OperationRow;
  assertBoundedId(operation.operation_id, "operation id");
  assertDigest(operation.operation_request_sha256, "operation request digest");
  assertCanonicalTime(operation.created_at, "operation creation time");
  return operation;
}

function assertLeaseEpochRow(row: Record<string, unknown>): LeaseEpochRow {
  assertExactKeys(row, ["lease_epoch", "lease_holder_token_sha256", "acquired_at"],
    "lease epoch");
  const lease = row as unknown as LeaseEpochRow;
  parseCanonicalU64(lease.lease_epoch, "lease epoch", true);
  assertDigest(lease.lease_holder_token_sha256, "lease holder token digest");
  assertCanonicalTime(lease.acquired_at, "lease acquisition time");
  return lease;
}

function assertReservationRow(row: Record<string, unknown>): ReservationRow {
  assertExactKeys(row, [
    "reservation_id", "operation_id", "checkpoint_generation", "lease_epoch",
    "lease_holder_token_sha256", "expected_previous_receipt_sha256", "reserved_at",
  ], "checkpoint reservation");
  const reservation = row as unknown as ReservationRow;
  assertDigest(reservation.reservation_id, "reservation id");
  assertBoundedId(reservation.operation_id, "reservation operation id");
  parseCanonicalU64(reservation.checkpoint_generation, "checkpoint generation", true);
  parseCanonicalU64(reservation.lease_epoch, "reservation lease epoch", true);
  assertDigest(reservation.lease_holder_token_sha256, "reservation lease token digest");
  if (reservation.expected_previous_receipt_sha256 !== null) {
    assertDigest(reservation.expected_previous_receipt_sha256,
      "expected previous receipt digest");
  }
  assertCanonicalTime(reservation.reserved_at, "reservation time");
  return reservation;
}

function assertAbandonmentRow(row: Record<string, unknown>): AbandonmentRow {
  assertExactKeys(row, [
    "reservation_id", "closed_by_lease_epoch", "reason", "abandoned_at",
  ], "reservation abandonment");
  const abandonment = row as unknown as AbandonmentRow;
  assertDigest(abandonment.reservation_id, "abandoned reservation id");
  parseCanonicalU64(abandonment.closed_by_lease_epoch,
    "abandonment closing lease epoch", true);
  if (abandonment.reason !== "lease_recovered"
    && abandonment.reason !== "lease_released") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot abandonment reason is invalid",
    );
  }
  assertCanonicalTime(abandonment.abandoned_at, "reservation abandonment time");
  return abandonment;
}

function assertCompletionRow(row: Record<string, unknown>): CompletionRow {
  assertExactKeys(row, [
    "reservation_id", "operation_id", "checkpoint_generation",
    "database_binding_receipt_sha256", "database_binding_receipt_json",
    "external_execution_policy_sha256", "external_execution_policy_json",
    "completed_at",
  ], "binding completion");
  const completion = row as unknown as CompletionRow;
  assertDigest(completion.reservation_id, "completed reservation id");
  assertBoundedId(completion.operation_id, "completion operation id");
  parseCanonicalU64(completion.checkpoint_generation,
    "completion checkpoint generation", true);
  assertDigest(completion.database_binding_receipt_sha256, "binding receipt digest");
  if (typeof completion.database_binding_receipt_json !== "string") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot completion receipt JSON is invalid",
    );
  }
  assertDigest(completion.external_execution_policy_sha256,
    "historical execution policy digest");
  if (typeof completion.external_execution_policy_json !== "string") {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot completion policy JSON is invalid",
    );
  }
  assertCanonicalTime(completion.completed_at, "binding completion time");
  return completion;
}

function verifyStoredCompletion(
  registration: RegistrationRow,
  reservation: ReservationRow,
  completion: CompletionRow,
  previousHead: DurableHead | null,
): DurableHead {
  if (completion.reservation_id !== reservation.reservation_id
    || completion.operation_id !== reservation.operation_id
    || completion.checkpoint_generation !== reservation.checkpoint_generation) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot completion does not match its generation reservation",
    );
  }
  const expectedPrevious = previousHead?.completion.database_binding_receipt_sha256 ?? null;
  if (reservation.expected_previous_receipt_sha256 !== expectedPrevious) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot reservation predecessor does not match the durable chain",
    );
  }
  let receipt: LearningRuntimeDatabaseBindingReceiptEnvelopeV1;
  let policy: ExternalExecutionPolicyV1;
  try {
    receipt = parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(
      completion.database_binding_receipt_json,
    );
    policy = parseStoredPolicy(completion);
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotAuthorityError) throw error;
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored completion failed canonical parsing",
    );
  }
  if (learningRuntimeDatabaseBindingReceiptDigest(receipt)
      !== completion.database_binding_receipt_sha256
    || learningRuntimeDatabaseBindingReceiptJson(receipt)
      !== completion.database_binding_receipt_json) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored binding receipt digest is invalid",
    );
  }
  const body = receipt.body;
  if (body.deployment_slot !== registration.deployment_slot
    || body.database_instance_id !== registration.database_instance_id
    || body.database_file_device !== registration.database_file_device
    || body.database_file_inode !== registration.database_file_inode
    || body.checkpoint_generation !== reservation.checkpoint_generation
    || body.issued_at < reservation.reserved_at
    || completion.completed_at < body.issued_at) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored binding receipt changed registered database authority",
    );
  }
  const chainExpectation: LearningRuntimeDatabaseBindingChainExpectationV1 = previousHead
    ? Object.freeze({
      chainKind: "successor" as const,
      previousReceipt: previousHead.receipt,
      previousExternalExecutionPolicy: previousHead.policy,
      previousRegisteredExternalExecutionPolicySha256:
        previousHead.completion.external_execution_policy_sha256,
      expectedPreviousReceiptSha256:
        previousHead.completion.database_binding_receipt_sha256,
      expectedCheckpointGeneration: reservation.checkpoint_generation,
    })
    : Object.freeze({
      chainKind: "first" as const,
      expectedFirstBindingAnchorSha256: registration.first_binding_anchor_sha256,
      expectedCheckpointGeneration: reservation.checkpoint_generation,
    });
  try {
    const verification =
      verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
        envelope: receipt,
        externalExecutionPolicy: policy,
        registeredExternalExecutionPolicySha256:
          completion.external_execution_policy_sha256,
        expectedDeploymentSlot: registration.deployment_slot,
        chainExpectation,
      });
    if (verification.receipt_sha256 !== completion.database_binding_receipt_sha256) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot completion cryptographic verification digest is invalid",
      );
    }
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotAuthorityError) throw error;
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot stored binding receipt failed predecessor verification",
    );
  }
  return Object.freeze({ completion, receipt, policy });
}

function replayDurableState(db: SqliteDatabase): ReplayedState {
  assertDatabasePragmas(
    db,
    DEPLOYMENT_SLOT_STATE_APPLICATION_ID,
    "wal",
    "durable state",
  );
  assertExactSchema(db, STATE_SCHEMA_OBJECTS, "durable state");
  const registration = readSingletonRegistration(db);

  const operationRows = rowsOf<Record<string, unknown>>(
    db,
    "lite_runtime_deployment_slot_operations",
  ).map(assertOperationRow);
  const operations = new Map(operationRows.map((row) => [row.operation_id, row]));
  if (operations.size !== operationRows.length) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot operation identities are not unique",
    );
  }

  const leaseEpochs = sortCanonicalU64Rows(
    rowsOf<Record<string, unknown>>(
      db,
      "lite_runtime_deployment_slot_lease_epochs",
    ).map(assertLeaseEpochRow),
    (row) => row.lease_epoch,
  );
  const leaseByEpoch = new Map<string, LeaseEpochRow>();
  for (let index = 0; index < leaseEpochs.length; index += 1) {
    const row = leaseEpochs[index]!;
    const previousLease = index === 0 ? null : leaseEpochs[index - 1]!;
    if (row.lease_epoch !== String(index + 1)
      || row.acquired_at < registration.created_at
      || (previousLease !== null && row.acquired_at < previousLease.acquired_at)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot lease epochs are not a complete monotonic sequence in time",
      );
    }
    leaseByEpoch.set(row.lease_epoch, row);
  }

  const reservations = sortCanonicalU64Rows(
    rowsOf<Record<string, unknown>>(
      db,
      "lite_runtime_deployment_slot_checkpoint_reservations",
    ).map(assertReservationRow),
    (row) => row.checkpoint_generation,
  );
  const reservationById = new Map<string, ReservationRow>();
  for (let index = 0; index < reservations.length; index += 1) {
    const reservation = reservations[index]!;
    const previousReservation = index === 0 ? null : reservations[index - 1]!;
    if (reservation.checkpoint_generation !== String(index + 1)
      || (previousReservation !== null
        && BigInt(reservation.lease_epoch) < BigInt(previousReservation.lease_epoch))) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot checkpoint reservations contain a missing, reused, or reordered generation",
      );
    }
    const operation = operations.get(reservation.operation_id);
    const lease = leaseByEpoch.get(reservation.lease_epoch);
    if (!operation
      || !lease
      || lease.lease_holder_token_sha256 !== reservation.lease_holder_token_sha256
      || operation.created_at !== reservation.reserved_at
      || reservation.reserved_at < lease.acquired_at) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot reservation is not bound to its operation and lease epoch",
      );
    }
    reservationById.set(reservation.reservation_id, reservation);
  }
  if (operations.size !== reservations.length) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot operation set does not exactly match reservations",
    );
  }

  const abandonmentRows = rowsOf<Record<string, unknown>>(
    db,
    "lite_runtime_deployment_slot_reservation_abandonments",
  ).map(assertAbandonmentRow);
  const abandonments = new Map(abandonmentRows.map((row) => [row.reservation_id, row]));
  if (abandonments.size !== abandonmentRows.length) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot abandonment identities are not unique",
    );
  }
  for (const abandonment of abandonmentRows) {
    const reservation = reservationById.get(abandonment.reservation_id);
    const closingLease = leaseByEpoch.get(abandonment.closed_by_lease_epoch);
    const reservationEpoch = reservation ? BigInt(reservation.lease_epoch) : null;
    const closingEpoch = closingLease
      ? BigInt(abandonment.closed_by_lease_epoch)
      : null;
    const closingRelationInvalid = abandonment.reason === "lease_released"
      ? closingEpoch !== reservationEpoch
      : closingEpoch === null
        || reservationEpoch === null
        || closingEpoch <= reservationEpoch;
    if (!reservation
      || !closingLease
      || closingRelationInvalid
      || (abandonment.reason === "lease_recovered"
        && abandonment.abandoned_at !== closingLease.acquired_at)
      || abandonment.abandoned_at < reservation.reserved_at
      || abandonment.abandoned_at < closingLease.acquired_at) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot abandonment is not bound to its exact closing lease",
      );
    }
  }

  const completionRows = rowsOf<Record<string, unknown>>(
    db,
    "lite_runtime_deployment_slot_binding_completions",
  ).map(assertCompletionRow);
  const completions = new Map(completionRows.map((row) => [row.reservation_id, row]));
  if (completions.size !== completionRows.length) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot completion identities are not unique",
    );
  }

  let activeReservation: ReservationRow | null = null;
  let head: DurableHead | null = null;
  let previousReservationTerminalAt = registration.created_at;
  for (let index = 0; index < reservations.length; index += 1) {
    const reservation = reservations[index]!;
    const abandonment = abandonments.get(reservation.reservation_id);
    const completion = completions.get(reservation.reservation_id);
    if (reservation.reserved_at < previousReservationTerminalAt) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot reservation chronology moved backward",
      );
    }
    if (abandonment && completion) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot reservation is both abandoned and completed",
      );
    }
    if (completion) {
      head = verifyStoredCompletion(registration, reservation, completion, head);
      previousReservationTerminalAt = completion.completed_at;
      continue;
    }
    const expectedPrevious = head?.completion.database_binding_receipt_sha256 ?? null;
    if (reservation.expected_previous_receipt_sha256 !== expectedPrevious) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot non-completed reservation has the wrong predecessor",
      );
    }
    if (!abandonment) {
      if (activeReservation !== null || index !== reservations.length - 1) {
        return authorityError(
          "lite_runtime_deployment_slot_authority_integrity_failed",
          "deployment-slot state contains multiple or non-terminal active reservations",
        );
      }
      activeReservation = reservation;
      previousReservationTerminalAt = reservation.reserved_at;
    } else {
      previousReservationTerminalAt = abandonment.abandoned_at;
    }
  }
  for (const reservationId of [...abandonments.keys(), ...completions.keys()]) {
    if (!reservationById.has(reservationId)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot terminal row references an unknown reservation",
      );
    }
  }
  const latestEventByLease = new Map(
    leaseEpochs.map((lease) => [lease.lease_epoch, lease.acquired_at]),
  );
  const recordLeaseEvent = (leaseEpoch: string, eventAt: string): void => {
    const existing = latestEventByLease.get(leaseEpoch);
    if (existing === undefined) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot semantic event references an unknown lease epoch",
      );
    }
    if (eventAt > existing) latestEventByLease.set(leaseEpoch, eventAt);
  };
  for (const reservation of reservations) {
    recordLeaseEvent(reservation.lease_epoch, reservation.reserved_at);
    const completion = completions.get(reservation.reservation_id);
    if (completion) recordLeaseEvent(reservation.lease_epoch, completion.completed_at);
    const abandonment = abandonments.get(reservation.reservation_id);
    if (abandonment) {
      recordLeaseEvent(abandonment.closed_by_lease_epoch, abandonment.abandoned_at);
    }
  }
  for (let index = 1; index < leaseEpochs.length; index += 1) {
    const previousLease = leaseEpochs[index - 1]!;
    const currentLease = leaseEpochs[index]!;
    if (latestEventByLease.get(previousLease.lease_epoch)! > currentLease.acquired_at) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot lease chronology crossed an earlier semantic event",
      );
    }
  }
  return Object.freeze({
    registration,
    operations,
    leaseEpochs: Object.freeze(leaseEpochs),
    reservations: Object.freeze(reservations),
    abandonments,
    completions,
    activeReservation,
    head,
  });
}

function semanticStateAtLeaseEpoch(
  replayed: ReplayedState,
  lastLeaseEpoch: bigint,
): Readonly<{
  semanticSha256: string;
  lastLeaseEpoch: string;
  lastCheckpointGeneration: string;
  lastReservationId: string | null;
  currentBindingReceiptSha256: string | null;
}> {
  const leaseEpochs = replayed.leaseEpochs.filter(
    (row) => BigInt(row.lease_epoch) <= lastLeaseEpoch,
  );
  const reservations = replayed.reservations.filter(
    (row) => BigInt(row.lease_epoch) <= lastLeaseEpoch,
  );
  const reservationIds = new Set(reservations.map((row) => row.reservation_id));
  const operations = reservations.map((row) => replayed.operations.get(row.operation_id)!);
  const abandonments = reservations.flatMap((row) => {
    const abandonment = replayed.abandonments.get(row.reservation_id);
    return abandonment
      && BigInt(abandonment.closed_by_lease_epoch) <= lastLeaseEpoch
      ? [abandonment]
      : [];
  });
  const completions = reservations.flatMap((row) => {
    const completion = replayed.completions.get(row.reservation_id);
    return completion && reservationIds.has(completion.reservation_id) ? [completion] : [];
  });
  const lastReservation = reservations.at(-1) ?? null;
  const currentCompletion = completions.at(-1) ?? null;
  const projection = Object.freeze({
    contract_version: "aionis_lite_runtime_deployment_slot_semantic_state_v1",
    registration: replayed.registration,
    lease_epochs: leaseEpochs,
    operations,
    reservations,
    abandonments,
    completions,
  });
  return Object.freeze({
    semanticSha256: sha256(stableStringify(projection)),
    lastLeaseEpoch: leaseEpochs.at(-1)?.lease_epoch ?? "0",
    lastCheckpointGeneration: lastReservation?.checkpoint_generation ?? "0",
    lastReservationId: lastReservation?.reservation_id ?? null,
    currentBindingReceiptSha256:
      currentCompletion?.database_binding_receipt_sha256 ?? null,
  });
}

function latestSemanticEventAt(
  replayed: ReplayedState,
  lastLeaseEpoch: bigint | null = null,
): string {
  let latest = replayed.registration.created_at;
  const includesLease = (leaseEpoch: string): boolean => lastLeaseEpoch === null
    || BigInt(leaseEpoch) <= lastLeaseEpoch;
  for (const lease of replayed.leaseEpochs) {
    if (includesLease(lease.lease_epoch) && lease.acquired_at > latest) {
      latest = lease.acquired_at;
    }
  }
  for (const reservation of replayed.reservations) {
    if (!includesLease(reservation.lease_epoch)) continue;
    if (reservation.reserved_at > latest) latest = reservation.reserved_at;
    const completion = replayed.completions.get(reservation.reservation_id);
    if (completion && completion.completed_at > latest) latest = completion.completed_at;
    const abandonment = replayed.abandonments.get(reservation.reservation_id);
    if (abandonment
      && includesLease(abandonment.closed_by_lease_epoch)
      && abandonment.abandoned_at > latest) {
      latest = abandonment.abandoned_at;
    }
  }
  return latest;
}

function assertCarrierWitnessRow(row: Record<string, unknown>): CarrierStateWitnessRow {
  assertExactKeys(row, [
    "witness_epoch", "previous_witness_sha256", "state_database_device",
    "state_database_inode",
    "registration_sha256", "last_lease_epoch", "last_checkpoint_generation",
    "last_reservation_id", "current_binding_receipt_sha256",
    "state_semantic_sha256", "witnessed_at", "witness_sha256",
  ], "carrier state witness");
  const witness = row as unknown as CarrierStateWitnessRow;
  parseCanonicalU64(witness.witness_epoch, "carrier witness epoch", true);
  if (witness.previous_witness_sha256 !== null) {
    assertDigest(witness.previous_witness_sha256, "previous carrier witness digest");
  }
  parseCanonicalU64(witness.state_database_device, "witnessed state device");
  parseCanonicalU64(witness.state_database_inode, "witnessed state inode");
  assertDigest(witness.registration_sha256, "witnessed registration digest");
  parseCanonicalU64(witness.last_lease_epoch, "witnessed lease epoch");
  parseCanonicalU64(
    witness.last_checkpoint_generation,
    "witnessed checkpoint generation",
  );
  if (witness.last_reservation_id !== null) {
    assertDigest(witness.last_reservation_id, "witnessed reservation id");
  }
  if (witness.current_binding_receipt_sha256 !== null) {
    assertDigest(
      witness.current_binding_receipt_sha256,
      "witnessed binding receipt digest",
    );
  }
  assertDigest(witness.state_semantic_sha256, "witnessed semantic state digest");
  assertCanonicalTime(witness.witnessed_at, "state witness time");
  assertDigest(witness.witness_sha256, "carrier witness digest");
  const { witness_sha256: _ignored, ...projection } = witness;
  if (sha256(stableStringify(projection)) !== witness.witness_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot carrier witness digest is invalid",
    );
  }
  return witness;
}

function readCarrierWitnesses(db: SqliteDatabase): CarrierStateWitnessRow[] {
  const witnesses = sortCanonicalU64Rows(
    rowsOf<Record<string, unknown>>(
      db,
      "lite_runtime_deployment_slot_state_witnesses",
    ).map(assertCarrierWitnessRow),
    (row) => row.witness_epoch,
  );
  if (witnesses.length === 0) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot carrier has no durable state witness",
    );
  }
  let previousWitnessSha256: string | null = null;
  for (let index = 0; index < witnesses.length; index += 1) {
    const witness = witnesses[index]!;
    if (witness.witness_epoch !== String(index + 1)
      || witness.previous_witness_sha256 !== previousWitnessSha256) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot carrier witnesses are not a complete hash-chained sequence",
      );
    }
    previousWitnessSha256 = witness.witness_sha256;
  }
  return witnesses;
}

function assertCarrierWitnesses(
  carrierDb: SqliteDatabase,
  carrierIdentity: CarrierIdentityRow,
  replayed: ReplayedState,
  statePin: LiteRuntimeProtectedAuthorityDatabasePin,
): CarrierStateWitnessRow {
  const stateInspection = assertLiteRuntimeProtectedAuthorityDatabasePinned(statePin);
  if (String(stateInspection.database_device) !== carrierIdentity.state_database_device
    || String(stateInspection.database_inode) !== carrierIdentity.state_database_inode
    || replayed.registration.registration_sha256 !== carrierIdentity.registration_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot durable state is not the carrier-registered physical database",
    );
  }
  const witnesses = readCarrierWitnesses(carrierDb);
  const latestStateLease = replayed.leaseEpochs.at(-1)?.lease_epoch ?? "0";
  let previousWitnessedAt = replayed.registration.created_at;
  let previousWitness: CarrierStateWitnessRow | null = null;
  for (const witness of witnesses) {
    const witnessedLease = witness.last_lease_epoch === "0"
      ? null
      : replayed.leaseEpochs.find(
        (row) => row.lease_epoch === witness.last_lease_epoch,
      ) ?? null;
    if (witness.state_database_device !== carrierIdentity.state_database_device
      || witness.state_database_inode !== carrierIdentity.state_database_inode
      || witness.registration_sha256 !== carrierIdentity.registration_sha256
      || BigInt(witness.last_lease_epoch) > BigInt(latestStateLease)
      || witness.witnessed_at < previousWitnessedAt
      || (previousWitness === null
        ? witness.last_lease_epoch !== "0"
          || witness.last_checkpoint_generation !== "0"
          || witness.last_reservation_id !== null
          || witness.current_binding_receipt_sha256 !== null
        : BigInt(witness.last_lease_epoch) <= BigInt(previousWitness.last_lease_epoch)
          || BigInt(witness.last_checkpoint_generation)
            < BigInt(previousWitness.last_checkpoint_generation))
      || (witnessedLease !== null
        && witness.witnessed_at < witnessedLease.acquired_at)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot durable state is older than or detached from its carrier witness",
      );
    }
    previousWitnessedAt = witness.witnessed_at;
    previousWitness = witness;
  }
  const latestWitness = witnesses.at(-1)!;
  const latestWitnessLease = BigInt(latestWitness.last_lease_epoch);
  const semantic = semanticStateAtLeaseEpoch(replayed, latestWitnessLease);
  const cutoffHasUnclosedReservation = replayed.reservations.some((reservation) => {
    if (BigInt(reservation.lease_epoch) > latestWitnessLease) return false;
    if (replayed.completions.has(reservation.reservation_id)) return false;
    const abandonment = replayed.abandonments.get(reservation.reservation_id);
    return !abandonment
      || BigInt(abandonment.closed_by_lease_epoch) > latestWitnessLease;
  });
  if (cutoffHasUnclosedReservation
    || latestWitness.witnessed_at
      < latestSemanticEventAt(replayed, latestWitnessLease)
    || semantic.lastLeaseEpoch !== latestWitness.last_lease_epoch
    || semantic.lastCheckpointGeneration !== latestWitness.last_checkpoint_generation
    || semantic.lastReservationId !== latestWitness.last_reservation_id
    || semantic.currentBindingReceiptSha256
      !== latestWitness.current_binding_receipt_sha256
    || semantic.semanticSha256 !== latestWitness.state_semantic_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot durable state rolled back or diverged from its carrier witness",
    );
  }
  return latestWitness;
}

function buildCarrierWitness(
  replayed: ReplayedState,
  statePin: LiteRuntimeProtectedAuthorityDatabasePin,
  witnessEpoch: string,
  witnessedAt: string,
  previousWitnessSha256: string | null,
): CarrierStateWitnessRow {
  const stateInspection = assertLiteRuntimeProtectedAuthorityDatabasePinned(statePin);
  const lastLeaseEpoch = replayed.leaseEpochs.at(-1)?.lease_epoch ?? "0";
  const semantic = semanticStateAtLeaseEpoch(replayed, BigInt(lastLeaseEpoch));
  const projection: Omit<CarrierStateWitnessRow, "witness_sha256"> = {
    witness_epoch: witnessEpoch,
    previous_witness_sha256: previousWitnessSha256,
    state_database_device: String(stateInspection.database_device),
    state_database_inode: String(stateInspection.database_inode),
    registration_sha256: replayed.registration.registration_sha256,
    last_lease_epoch: semantic.lastLeaseEpoch,
    last_checkpoint_generation: semantic.lastCheckpointGeneration,
    last_reservation_id: semantic.lastReservationId,
    current_binding_receipt_sha256: semantic.currentBindingReceiptSha256,
    state_semantic_sha256: semantic.semanticSha256,
    witnessed_at: witnessedAt,
  };
  return {
    ...projection,
    witness_sha256: sha256(stableStringify(projection)),
  };
}

function insertCarrierWitness(
  carrierDb: SqliteDatabase,
  witness: CarrierStateWitnessRow,
): void {
  carrierDb.prepare(
    `INSERT INTO lite_runtime_deployment_slot_state_witnesses
       (witness_epoch, previous_witness_sha256, state_database_device,
        state_database_inode,
        registration_sha256, last_lease_epoch, last_checkpoint_generation,
        last_reservation_id, current_binding_receipt_sha256,
        state_semantic_sha256, witnessed_at, witness_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    witness.witness_epoch,
    witness.previous_witness_sha256,
    witness.state_database_device,
    witness.state_database_inode,
    witness.registration_sha256,
    witness.last_lease_epoch,
    witness.last_checkpoint_generation,
    witness.last_reservation_id,
    witness.current_binding_receipt_sha256,
    witness.state_semantic_sha256,
    witness.witnessed_at,
    witness.witness_sha256,
  );
}

function assertRuntimeMapping(
  registration: RegistrationRow,
  runtimePin: LiteRuntimeProtectedAuthorityDatabasePin,
): void {
  const inspection = assertLiteRuntimeProtectedAuthorityDatabasePinned(runtimePin);
  if (inspection.database_realpath !== registration.database_realpath
    || String(inspection.database_device) !== registration.database_file_device
    || String(inspection.database_inode) !== registration.database_file_inode) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_database_mismatch",
      "deployment-slot Runtime database no longer matches its registered physical identity",
    );
  }
  if (readRuntimeDatabaseIdentity(runtimePin) !== registration.database_instance_id) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_database_mismatch",
      "deployment-slot Runtime database lineage identity changed",
    );
  }
}

function runStateTransaction<T>(
  stateDatabase: LiteRuntimeDatabase,
  statePin: LiteRuntimeProtectedAuthorityDatabasePin,
  authorityStatePath: string,
  fn: () => T,
): T {
  stateDatabase.db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    stateDatabase.db.exec("COMMIT");
    assertLiteRuntimeProtectedAuthorityDatabasePinned(statePin);
    syncStateDatabaseFiles(authorityStatePath);
    return result;
  } catch (error) {
    try { stateDatabase.db.exec("ROLLBACK"); } catch { /* preserve first error */ }
    throw error;
  }
}

function acquireCarrierWriterLock(
  database: LiteRuntimeDatabase,
  savepoint: string,
): void {
  try {
    database.db.exec("BEGIN IMMEDIATE");
    database.db.exec(`SAVEPOINT "${savepoint}"`);
  } catch (error) {
    try { database.db.exec("ROLLBACK"); } catch { /* preserve acquisition error */ }
    const message = error instanceof Error ? error.message : String(error);
    if (/busy|locked/iu.test(message)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_lease_contended",
        "deployment-slot exclusive lease is already held by another launcher",
      );
    }
    return authorityError(
      "lite_runtime_deployment_slot_authority_lease_lost",
      "deployment-slot lease carrier could not establish its retained writer lock",
    );
  }
}

function assertCarrierWriterLock(state: LeaseState): void {
  try {
    // The random savepoint belongs to the retained outer BEGIN IMMEDIATE. Any
    // raw COMMIT/ROLLBACK/restart loses it and invalidates the lease. This is
    // only a SQL transaction-continuity guard: POSIX lock liveness also
    // requires that no other descriptor for the carrier inode is closed in
    // this process, which the formal launcher must enforce by isolation.
    state.carrierDatabase.db.exec(`ROLLBACK TO SAVEPOINT "${state.sqliteSavepoint}"`);
  } catch {
    return authorityError(
      "lite_runtime_deployment_slot_authority_lease_lost",
      "deployment-slot carrier transaction or its secret liveness guard was lost",
    );
  }
}

function requiredLeaseState(
  capability: LiteRuntimeDeploymentSlotExclusiveLeaseCapability,
): LeaseState {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_lease_invalid",
      "deployment-slot lease capability is invalid",
    );
  }
  const state = leaseRegistry.get(capability);
  if (!state) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_lease_invalid",
      "deployment-slot lease capability is invalid",
    );
  }
  if (state.closed) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_lease_closed",
      "deployment-slot lease capability is closed",
    );
  }
  return state;
}

function completionFromRow(
  replayed: ReplayedState,
  completion: CompletionRow,
  exactReplay: boolean,
): LiteRuntimeDeploymentSlotBindingCompletion {
  const operation = replayed.operations.get(completion.operation_id);
  if (!operation) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot completion lost its operation",
    );
  }
  return Object.freeze({
    contract_version:
      "aionis_lite_runtime_deployment_slot_binding_completion_v1" as const,
    authority_scope: "configured_authority_path_chain_transition" as const,
    signing_eligible: false as const,
    exact_replay: exactReplay,
    deployment_slot: replayed.registration.deployment_slot,
    operation_id: completion.operation_id,
    operation_request_sha256: operation.operation_request_sha256,
    reservation_id: completion.reservation_id,
    checkpoint_generation: completion.checkpoint_generation,
    database_binding_receipt_sha256: completion.database_binding_receipt_sha256,
    database_binding_receipt_json: completion.database_binding_receipt_json,
    external_execution_policy_sha256: completion.external_execution_policy_sha256,
    external_execution_policy_json: completion.external_execution_policy_json,
    completed_at: completion.completed_at,
    rollback_resistance:
      "current_lineage_only_without_carrier_storage_rollback" as const,
    required_next_capabilities: NEXT_CAPABILITIES,
  });
}

function leaseInspection(
  state: Pick<LeaseState,
    "authorityStatePath" | "leaseCarrierPath" | "registration" | "leaseEpoch"
    | "leaseHolderTokenSha256">,
  replayed: ReplayedState,
): LiteRuntimeDeploymentSlotLeaseInspection {
  return Object.freeze({
    contract_version:
      "aionis_lite_runtime_deployment_slot_exclusive_lease_inspection_v1" as const,
    authority_scope:
      "configured_authority_path_conditional_process_live_exclusivity" as const,
    signing_eligible: false as const,
    deployment_slot: state.registration.deployment_slot,
    authority_state_path: state.authorityStatePath,
    lease_carrier_path: state.leaseCarrierPath,
    authority_instance_id: state.registration.authority_instance_id,
    carrier_instance_id: state.registration.carrier_instance_id,
    lease_epoch: state.leaseEpoch,
    lease_holder_token_sha256: state.leaseHolderTokenSha256,
    database_realpath: state.registration.database_realpath,
    database_instance_id: state.registration.database_instance_id,
    database_file_device: state.registration.database_file_device,
    database_file_inode: state.registration.database_file_inode,
    first_binding_anchor_sha256: state.registration.first_binding_anchor_sha256,
    current_database_binding_receipt_sha256:
      replayed.head?.completion.database_binding_receipt_sha256 ?? null,
    current_checkpoint_generation:
      replayed.head?.completion.checkpoint_generation ?? null,
    filesystem_locking_assumption:
      "trusted_single_host_local_locking_filesystem" as const,
    same_process_carrier_fd_isolation: "required_not_established" as const,
    slot_path_mapping: "trusted_launcher_configuration_required" as const,
    rollback_resistance:
      "clean_release_prefix_only_without_carrier_storage_rollback" as const,
    required_next_capabilities: NEXT_CAPABILITIES,
  });
}

/**
 * Acquires the retained SQLite writer lock for one configured authority-path
 * instance before opening the mapped Runtime database. Formal exclusivity also
 * requires a verified local-locking filesystem and an isolated carrier holder.
 * The lease has no TTL and performs no PID-based stale takeover.
 */
export function acquireLiteRuntimeDeploymentSlotExclusiveLease(args: Readonly<{
  authorityStatePath: string;
  deploymentSlot: string;
  now?: Date;
  randomBytesFactory?: (size: number) => Uint8Array;
}>): LiteRuntimeDeploymentSlotExclusiveLeaseCapability {
  const authorityStatePath = requireAbsolutePath(
    args.authorityStatePath,
    "authority state path",
  );
  const leaseCarrierPath = liteRuntimeDeploymentSlotLeaseCarrierPath(authorityStatePath);
  const deploymentSlot = assertBoundedId(args.deploymentSlot, "deployment slot");
  const acquiredAt = canonicalTime(args.now ?? new Date(), "lease acquisition time");
  const leaseHolderTokenSha256 = randomDigest(
    args.randomBytesFactory,
    "lease-holder token",
  );
  const sqliteSavepoint = `aionis_deployment_slot_${randomDigest(
    args.randomBytesFactory,
    "SQLite lease guard",
  )}`;

  let carrierPin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let statePin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let runtimePin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let carrierDatabase: LiteRuntimeDatabase | null = null;
  let stateDatabase: LiteRuntimeDatabase | null = null;
  let carrierLocked = false;
  try {
    carrierPin = pinLiteRuntimeProtectedAuthorityDatabase(leaseCarrierPath);
    if (assertLiteRuntimeProtectedAuthorityDatabasePinned(carrierPin).database_realpath
      !== leaseCarrierPath) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_filesystem_untrusted",
        "deployment-slot lease carrier path must be canonical",
      );
    }
    carrierDatabase = openLiteRuntimeProtectedAuthorityDatabase(carrierPin);
    configureOpenedAuthorityDatabase(carrierDatabase.db);
    assertDatabasePragmas(
      carrierDatabase.db,
      DEPLOYMENT_SLOT_LEASE_APPLICATION_ID,
      "wal",
      "lease carrier",
    );
    assertExactSchema(carrierDatabase.db, CARRIER_SCHEMA_OBJECTS, "lease carrier");
    const unlockedCarrierIdentity = readCarrierIdentity(carrierDatabase.db);
    if (unlockedCarrierIdentity.deployment_slot !== deploymentSlot) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_slot_mismatch",
        "deployment-slot lease carrier belongs to another slot",
      );
    }
    acquireCarrierWriterLock(carrierDatabase, sqliteSavepoint);
    carrierLocked = true;

    statePin = pinLiteRuntimeProtectedAuthorityDatabase(authorityStatePath);
    if (assertLiteRuntimeProtectedAuthorityDatabasePinned(statePin).database_realpath
      !== authorityStatePath) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_filesystem_untrusted",
        "deployment-slot durable state path must be canonical",
      );
    }
    stateDatabase = openLiteRuntimeProtectedAuthorityDatabase(statePin);
    configureOpenedAuthorityDatabase(stateDatabase.db);
    let replayed = replayDurableState(stateDatabase.db);
    const carrierIdentity = assertCarrierIdentity(
      carrierDatabase.db,
      deploymentSlot,
      replayed.registration,
      carrierPin,
    );
    assertCarrierWitnesses(
      carrierDatabase.db,
      carrierIdentity,
      replayed,
      statePin,
    );
    assertDisjointSqlitePathNamespaces([
      { label: "durable state", path: authorityStatePath },
      { label: "lease carrier", path: leaseCarrierPath },
      { label: "Runtime database", path: replayed.registration.database_realpath },
    ]);

    runtimePin = pinLiteRuntimeProtectedAuthorityDatabase(
      replayed.registration.database_realpath,
    );
    assertRuntimeMapping(replayed.registration, runtimePin);

    if (acquiredAt < latestSemanticEventAt(replayed)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot lease acquisition time would roll durable authority backward",
      );
    }

    const previousLeaseEpoch = replayed.leaseEpochs.length === 0
      ? 0n
      : parseCanonicalU64(
        replayed.leaseEpochs[replayed.leaseEpochs.length - 1]!.lease_epoch,
        "latest lease epoch",
        true,
      );
    const leaseEpoch = incrementU64(previousLeaseEpoch, "lease epoch");
    runStateTransaction(stateDatabase, statePin, authorityStatePath, () => {
      const inside = replayDurableState(stateDatabase!.db);
      const latestInside = inside.leaseEpochs.at(-1)?.lease_epoch ?? null;
      const latestOutside = replayed.leaseEpochs.at(-1)?.lease_epoch ?? null;
      if (latestInside !== latestOutside
        || inside.activeReservation?.reservation_id
          !== replayed.activeReservation?.reservation_id) {
        return authorityError(
          "lite_runtime_deployment_slot_authority_integrity_failed",
          "deployment-slot durable state changed during lease acquisition",
        );
      }
      stateDatabase!.db.prepare(
        `INSERT INTO lite_runtime_deployment_slot_lease_epochs
           (lease_epoch, lease_holder_token_sha256, acquired_at)
         VALUES (?, ?, ?)`,
      ).run(leaseEpoch, leaseHolderTokenSha256, acquiredAt);
      if (inside.activeReservation) {
        stateDatabase!.db.prepare(
          `INSERT INTO lite_runtime_deployment_slot_reservation_abandonments
             (reservation_id, closed_by_lease_epoch, reason, abandoned_at)
           VALUES (?, ?, 'lease_recovered', ?)`,
        ).run(inside.activeReservation.reservation_id, leaseEpoch, acquiredAt);
      }
    });
    replayed = replayDurableState(stateDatabase.db);
    if (replayed.activeReservation !== null
      || replayed.leaseEpochs.at(-1)?.lease_epoch !== leaseEpoch
      || replayed.leaseEpochs.at(-1)?.lease_holder_token_sha256
        !== leaseHolderTokenSha256) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_integrity_failed",
        "deployment-slot durable lease epoch did not commit exactly",
      );
    }
    const capability = Object.freeze(Object.create(null)) as
      LiteRuntimeDeploymentSlotExclusiveLeaseCapability;
    const state: LeaseState = {
      authorityStatePath,
      leaseCarrierPath,
      statePin,
      carrierPin,
      runtimeDatabasePin: runtimePin,
      stateDatabase,
      carrierDatabase,
      sqliteSavepoint,
      registration: replayed.registration,
      leaseEpoch,
      leaseHolderTokenSha256,
      inspection: undefined as unknown as LiteRuntimeDeploymentSlotLeaseInspection,
      activeReservationCapability: null,
      closed: false,
    };
    state.inspection = leaseInspection(state, replayed);
    leaseRegistry.set(capability, state);
    assertCarrierWriterLock(state);
    // Ownership has moved into the registry; cleanup below must not close it.
    carrierPin = null;
    statePin = null;
    runtimePin = null;
    carrierDatabase = null;
    stateDatabase = null;
    carrierLocked = false;
    return capability;
  } catch (error) {
    if (error instanceof LiteRuntimeDeploymentSlotAuthorityError) throw error;
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot authority acquisition failed closed",
    );
  } finally {
    if (carrierLocked && carrierDatabase) {
      try { carrierDatabase.db.exec("ROLLBACK"); } catch { /* cleanup */ }
    }
    closeDatabaseBestEffort(stateDatabase);
    closeDatabaseBestEffort(carrierDatabase);
    closePinBestEffort(runtimePin);
    closePinBestEffort(statePin);
    closePinBestEffort(carrierPin);
  }
}

function assertLeaseState(state: LeaseState): ReplayedState {
  assertCarrierWriterLock(state);
  assertLiteRuntimeProtectedAuthorityDatabasePinned(state.carrierPin);
  assertLiteRuntimeProtectedAuthorityDatabasePinned(state.statePin);
  assertRuntimeMapping(state.registration, state.runtimeDatabasePin);
  const replayed = replayDurableState(state.stateDatabase.db);
  const carrierIdentity = assertCarrierIdentity(
    state.carrierDatabase.db,
    state.registration.deployment_slot,
    replayed.registration,
    state.carrierPin,
  );
  assertCarrierWitnesses(
    state.carrierDatabase.db,
    carrierIdentity,
    replayed,
    state.statePin,
  );
  assertRegistrationMatches(replayed.registration, state.registration);
  const latestLease = replayed.leaseEpochs.at(-1);
  if (!latestLease
    || latestLease.lease_epoch !== state.leaseEpoch
    || latestLease.lease_holder_token_sha256 !== state.leaseHolderTokenSha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_lease_lost",
      "deployment-slot durable lease epoch is no longer current",
    );
  }
  return replayed;
}

/** Rechecks the carrier transaction, all three pins, exact schema and full chain. */
export function assertLiteRuntimeDeploymentSlotExclusiveLease(
  capability: LiteRuntimeDeploymentSlotExclusiveLeaseCapability,
): LiteRuntimeDeploymentSlotLeaseInspection {
  const state = requiredLeaseState(capability);
  const replayed = assertLeaseState(state);
  state.inspection = leaseInspection(state, replayed);
  return state.inspection;
}

/** Returns the most recently verified immutable inspection without new authority. */
export function inspectLiteRuntimeDeploymentSlotExclusiveLease(
  capability: LiteRuntimeDeploymentSlotExclusiveLeaseCapability,
): LiteRuntimeDeploymentSlotLeaseInspection {
  return requiredLeaseState(capability).inspection;
}

function requiredReservationState(
  capability: LiteRuntimeDeploymentSlotCheckpointReservationCapability,
): ReservationState {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_invalid",
      "deployment-slot checkpoint reservation capability is invalid",
    );
  }
  const state = reservationRegistry.get(capability);
  if (!state) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_invalid",
      "deployment-slot checkpoint reservation capability is invalid",
    );
  }
  if (state.consumed) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_consumed",
      "deployment-slot checkpoint reservation capability is already consumed",
    );
  }
  const leaseState = requiredLeaseState(state.leaseCapability);
  if (leaseState !== state.leaseState
    || leaseState.activeReservationCapability !== capability) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_invalid",
      "deployment-slot checkpoint reservation belongs to another lease or was revoked",
    );
  }
  return state;
}

function reservationInspection(
  state: LeaseState,
  operation: OperationRow,
  reservation: ReservationRow,
  expectedHead: DurableHead | null,
): LiteRuntimeDeploymentSlotReservationInspection {
  return Object.freeze({
    contract_version: (
      "aionis_lite_runtime_deployment_slot_checkpoint_reservation_inspection_v1"
    ) as const,
    authority_scope: "configured_authority_path_generation_and_chain_expectation" as const,
    signing_eligible: false as const,
    deployment_slot: state.registration.deployment_slot,
    operation_id: operation.operation_id,
    operation_request_sha256: operation.operation_request_sha256,
    reservation_id: reservation.reservation_id,
    checkpoint_generation: reservation.checkpoint_generation,
    lease_epoch: reservation.lease_epoch,
    expected_binding_chain: expectedHead
      ? Object.freeze({
        chain_kind: "successor" as const,
        previous_database_binding_receipt_sha256:
          expectedHead.completion.database_binding_receipt_sha256,
      })
      : Object.freeze({
        chain_kind: "first" as const,
        first_binding_anchor_sha256: state.registration.first_binding_anchor_sha256,
      }),
    database_instance_id: state.registration.database_instance_id,
    database_file_device: state.registration.database_file_device,
    database_file_inode: state.registration.database_file_inode,
    filesystem_locking_assumption:
      "trusted_single_host_local_locking_filesystem" as const,
    same_process_carrier_fd_isolation: "required_not_established" as const,
    slot_path_mapping: "trusted_launcher_configuration_required" as const,
    rollback_resistance:
      "clean_release_prefix_only_without_carrier_storage_rollback" as const,
    required_next_capabilities: RESERVATION_NEXT_CAPABILITIES,
  });
}

function findCompletionByOperation(
  replayed: ReplayedState,
  operationId: string,
): CompletionRow | null {
  for (const completion of replayed.completions.values()) {
    if (completion.operation_id === operationId) return completion;
  }
  return null;
}

/**
 * Durably burns the next generation in this configured authority instance
 * while its carrier lease remains held. Non-reuse is conditional on the
 * declared non-rollback authority boundary; a process crash alone cannot make
 * a committed generation reusable in the current lineage.
 */
export function reserveLiteRuntimeDeploymentSlotCheckpointGeneration(
  args: Readonly<{
    lease: LiteRuntimeDeploymentSlotExclusiveLeaseCapability;
    operationId: string;
    operationRequestSha256: string;
    now?: Date;
    randomBytesFactory?: (size: number) => Uint8Array;
  }>,
): LiteRuntimeDeploymentSlotCheckpointReservationResult {
  const leaseState = requiredLeaseState(args.lease);
  const operationId = assertBoundedId(args.operationId, "operation id");
  const operationRequestSha256 = assertDigest(
    args.operationRequestSha256,
    "operation request digest",
  );
  const reservedAt = canonicalTime(args.now ?? new Date(), "reservation time");
  let replayed = assertLeaseState(leaseState);
  const existingOperation = replayed.operations.get(operationId);
  if (existingOperation) {
    if (existingOperation.operation_request_sha256 !== operationRequestSha256) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_operation_conflict",
        "deployment-slot operation id was already bound to another request",
      );
    }
    const completion = findCompletionByOperation(replayed, operationId);
    if (completion) {
      return Object.freeze({
        kind: "completed_replay" as const,
        completion: completionFromRow(replayed, completion, true),
      });
    }
    if (leaseState.activeReservationCapability) {
      const active = requiredReservationState(leaseState.activeReservationCapability);
      if (active.operation.operation_id === operationId
        && active.operation.operation_request_sha256 === operationRequestSha256) {
        return Object.freeze({
          kind: "reserved" as const,
          reservation: leaseState.activeReservationCapability,
        });
      }
    }
    return authorityError(
      "lite_runtime_deployment_slot_authority_operation_generation_burned",
      "deployment-slot operation's generation was burned; retry requires a new operation id",
    );
  }
  if (replayed.activeReservation !== null
    || leaseState.activeReservationCapability !== null) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_invalid",
      "deployment-slot lease already owns an active checkpoint reservation",
    );
  }
  if (reservedAt < latestSemanticEventAt(replayed)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_integrity_failed",
      "deployment-slot reservation time would roll durable authority backward",
    );
  }
  const lastGeneration = replayed.reservations.length === 0
    ? 0n
    : parseCanonicalU64(
      replayed.reservations.at(-1)!.checkpoint_generation,
      "latest checkpoint generation",
      true,
    );
  const checkpointGeneration = incrementU64(lastGeneration, "checkpoint generation");
  const reservationId = randomDigest(args.randomBytesFactory, "reservation id");
  const expectedPreviousReceiptSha256 =
    replayed.head?.completion.database_binding_receipt_sha256 ?? null;
  const expectedHead = replayed.head;
  const operation: OperationRow = {
    operation_id: operationId,
    operation_request_sha256: operationRequestSha256,
    created_at: reservedAt,
  };
  const reservation: ReservationRow = {
    reservation_id: reservationId,
    operation_id: operationId,
    checkpoint_generation: checkpointGeneration,
    lease_epoch: leaseState.leaseEpoch,
    lease_holder_token_sha256: leaseState.leaseHolderTokenSha256,
    expected_previous_receipt_sha256: expectedPreviousReceiptSha256,
    reserved_at: reservedAt,
  };
  runStateTransaction(
    leaseState.stateDatabase,
    leaseState.statePin,
    leaseState.authorityStatePath,
    () => {
      const inside = replayDurableState(leaseState.stateDatabase.db);
      if (inside.activeReservation !== null
        || inside.reservations.at(-1)?.checkpoint_generation
          !== replayed.reservations.at(-1)?.checkpoint_generation
        || inside.head?.completion.database_binding_receipt_sha256
          !== replayed.head?.completion.database_binding_receipt_sha256
        || inside.operations.has(operationId)) {
        return authorityError(
          "lite_runtime_deployment_slot_authority_reservation_invalid",
          "deployment-slot durable state changed before generation reservation",
        );
      }
      assertCarrierWriterLock(leaseState);
      leaseState.stateDatabase.db.prepare(
        `INSERT INTO lite_runtime_deployment_slot_operations
           (operation_id, operation_request_sha256, created_at)
         VALUES (?, ?, ?)`,
      ).run(operationId, operationRequestSha256, reservedAt);
      leaseState.stateDatabase.db.prepare(
        `INSERT INTO lite_runtime_deployment_slot_checkpoint_reservations
           (reservation_id, operation_id, checkpoint_generation, lease_epoch,
            lease_holder_token_sha256, expected_previous_receipt_sha256, reserved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reservationId,
        operationId,
        checkpointGeneration,
        leaseState.leaseEpoch,
        leaseState.leaseHolderTokenSha256,
        expectedPreviousReceiptSha256,
        reservedAt,
      );
    },
  );
  replayed = assertLeaseState(leaseState);
  if (replayed.activeReservation?.reservation_id !== reservationId) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_invalid",
      "deployment-slot generation reservation did not commit exactly",
    );
  }
  const capability = Object.freeze(Object.create(null)) as
    LiteRuntimeDeploymentSlotCheckpointReservationCapability;
  const state: ReservationState = {
    leaseCapability: args.lease,
    leaseState,
    row: reservation,
    operation,
    expectedHead,
    inspection: reservationInspection(
      leaseState,
      operation,
      reservation,
      expectedHead,
    ),
    consumed: false,
  };
  reservationRegistry.set(capability, state);
  leaseState.activeReservationCapability = capability;
  return Object.freeze({ kind: "reserved" as const, reservation: capability });
}

/** Revalidates the live lease and exact durable reservation row. */
export function assertLiteRuntimeDeploymentSlotCheckpointGeneration(
  capability: LiteRuntimeDeploymentSlotCheckpointReservationCapability,
): LiteRuntimeDeploymentSlotReservationInspection {
  const state = requiredReservationState(capability);
  const replayed = assertLeaseState(state.leaseState);
  const active = replayed.activeReservation;
  if (!active
    || stableStringify(active) !== stableStringify(state.row)
    || replayed.head?.completion.database_binding_receipt_sha256
      !== state.expectedHead?.completion.database_binding_receipt_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_reservation_invalid",
      "deployment-slot checkpoint reservation no longer matches durable state",
    );
  }
  return state.inspection;
}

export function inspectLiteRuntimeDeploymentSlotCheckpointGeneration(
  capability: LiteRuntimeDeploymentSlotCheckpointReservationCapability,
): LiteRuntimeDeploymentSlotReservationInspection {
  return requiredReservationState(capability).inspection;
}

function verifyCompletionAgainstState(args: Readonly<{
  replayed: ReplayedState;
  reservation: ReservationState;
  envelope: unknown;
  policy: ExternalExecutionPolicyV1;
  policySha256: string;
}>): Readonly<{
  envelope: LearningRuntimeDatabaseBindingReceiptEnvelopeV1;
  envelopeJson: string;
  envelopeSha256: string;
}> {
  const active = args.replayed.activeReservation;
  if (!active || stableStringify(active) !== stableStringify(args.reservation.row)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_stale",
      "deployment-slot completion reservation is no longer the durable active generation",
    );
  }
  const expectedHead = args.replayed.head;
  if (expectedHead?.completion.database_binding_receipt_sha256
      !== args.reservation.expectedHead?.completion.database_binding_receipt_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_stale",
      "deployment-slot durable binding head changed after generation reservation",
    );
  }
  const chainExpectation: LearningRuntimeDatabaseBindingChainExpectationV1 = expectedHead
    ? Object.freeze({
      chainKind: "successor" as const,
      previousReceipt: expectedHead.receipt,
      previousExternalExecutionPolicy: expectedHead.policy,
      previousRegisteredExternalExecutionPolicySha256:
        expectedHead.completion.external_execution_policy_sha256,
      expectedPreviousReceiptSha256:
        expectedHead.completion.database_binding_receipt_sha256,
      expectedCheckpointGeneration: active.checkpoint_generation,
    })
    : Object.freeze({
      chainKind: "first" as const,
      expectedFirstBindingAnchorSha256:
        args.replayed.registration.first_binding_anchor_sha256,
      expectedCheckpointGeneration: active.checkpoint_generation,
    });
  let verification: ReturnType<
    typeof verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation
  >;
  try {
    verification = verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
      envelope: args.envelope,
      externalExecutionPolicy: args.policy,
      registeredExternalExecutionPolicySha256: args.policySha256,
      expectedDeploymentSlot: args.replayed.registration.deployment_slot,
      chainExpectation,
    });
  } catch {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot signed database binding failed durable-chain verification",
    );
  }
  const envelope = verification.receipt;
  const body = envelope.body;
  if (body.database_instance_id !== args.replayed.registration.database_instance_id
    || body.database_file_device !== args.replayed.registration.database_file_device
    || body.database_file_inode !== args.replayed.registration.database_file_inode
    || body.checkpoint_generation !== active.checkpoint_generation
    || body.issued_at < active.reserved_at) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot signed binding does not match the registered database and reservation",
    );
  }
  const envelopeJson = learningRuntimeDatabaseBindingReceiptJson(envelope);
  const envelopeSha256 = learningRuntimeDatabaseBindingReceiptDigest(envelope);
  if (envelopeSha256 !== verification.receipt_sha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot signed binding verification returned the wrong digest",
    );
  }
  return Object.freeze({ envelope, envelopeJson, envelopeSha256 });
}

/**
 * Re-verifies a complete launcher-signed receipt against the exact live
 * reservation and durable historical predecessor, then mints a private
 * one-shot completion capability. This function never signs caller bytes.
 */
export function prepareLiteRuntimeDeploymentSlotBindingCompletion(args: Readonly<{
  lease: LiteRuntimeDeploymentSlotExclusiveLeaseCapability;
  reservation: LiteRuntimeDeploymentSlotCheckpointReservationCapability;
  envelope: unknown;
  externalExecutionPolicy: ExternalExecutionPolicyV1;
  registeredExternalExecutionPolicySha256: string;
}>): LiteRuntimeDeploymentSlotPreparedBindingCompletionCapability {
  const leaseState = requiredLeaseState(args.lease);
  const reservationState = requiredReservationState(args.reservation);
  if (reservationState.leaseCapability !== args.lease
    || reservationState.leaseState !== leaseState) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot prepared completion crosses lease authority",
    );
  }
  assertLiteRuntimeDeploymentSlotCheckpointGeneration(args.reservation);
  const replayed = assertLeaseState(leaseState);
  const canonical = canonicalPolicy(args.externalExecutionPolicy);
  const registeredPolicySha256 = assertDigest(
    args.registeredExternalExecutionPolicySha256,
    "registered external execution policy digest",
  );
  if (canonical.sha256 !== registeredPolicySha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot current execution policy digest is not registered",
    );
  }
  const verified = verifyCompletionAgainstState({
    replayed,
    reservation: reservationState,
    envelope: args.envelope,
    policy: canonical.policy,
    policySha256: registeredPolicySha256,
  });
  const capability = Object.freeze(Object.create(null)) as
    LiteRuntimeDeploymentSlotPreparedBindingCompletionCapability;
  preparedCompletionRegistry.set(capability, {
    leaseCapability: args.lease,
    reservationCapability: args.reservation,
    reservationState,
    envelope: verified.envelope,
    envelopeJson: verified.envelopeJson,
    envelopeSha256: verified.envelopeSha256,
    policy: canonical.policy,
    policyJson: canonical.json,
    policySha256: canonical.sha256,
    expectedHeadSha256:
      replayed.head?.completion.database_binding_receipt_sha256 ?? null,
    consumed: false,
  });
  return capability;
}

function requiredPreparedCompletionState(
  capability: LiteRuntimeDeploymentSlotPreparedBindingCompletionCapability,
): PreparedCompletionState {
  if ((typeof capability !== "object" && typeof capability !== "function")
    || capability === null) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot prepared completion capability is invalid",
    );
  }
  const state = preparedCompletionRegistry.get(capability);
  if (!state || state.consumed) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot prepared completion capability is invalid or consumed",
    );
  }
  return state;
}

/**
 * Atomically appends the complete receipt and canonical historical policy to
 * durable slot state. The carrier lease remains held across this commit.
 */
export function commitLiteRuntimeDeploymentSlotBindingCompletion(args: Readonly<{
  lease: LiteRuntimeDeploymentSlotExclusiveLeaseCapability;
  reservation: LiteRuntimeDeploymentSlotCheckpointReservationCapability;
  preparedCompletion:
    LiteRuntimeDeploymentSlotPreparedBindingCompletionCapability;
  now?: Date;
}>): LiteRuntimeDeploymentSlotBindingCompletion {
  const leaseState = requiredLeaseState(args.lease);
  const reservationState = requiredReservationState(args.reservation);
  const prepared = requiredPreparedCompletionState(args.preparedCompletion);
  if (prepared.leaseCapability !== args.lease
    || prepared.reservationCapability !== args.reservation
    || prepared.reservationState !== reservationState
    || reservationState.leaseState !== leaseState) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot completion capabilities do not share one live authority scope",
    );
  }
  const completedAt = canonicalTime(args.now ?? new Date(), "completion time");
  if (completedAt < prepared.envelope.body.issued_at) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot completion time precedes the signed receipt",
    );
  }
  let replayed = assertLeaseState(leaseState);
  if ((replayed.head?.completion.database_binding_receipt_sha256 ?? null)
      !== prepared.expectedHeadSha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_stale",
      "deployment-slot prepared completion no longer extends the durable head",
    );
  }
  runStateTransaction(
    leaseState.stateDatabase,
    leaseState.statePin,
    leaseState.authorityStatePath,
    () => {
      const inside = replayDurableState(leaseState.stateDatabase.db);
      assertCarrierWriterLock(leaseState);
      const reverified = verifyCompletionAgainstState({
        replayed: inside,
        reservation: reservationState,
        envelope: prepared.envelope,
        policy: prepared.policy,
        policySha256: prepared.policySha256,
      });
      if (reverified.envelopeJson !== prepared.envelopeJson
        || reverified.envelopeSha256 !== prepared.envelopeSha256
        || (inside.head?.completion.database_binding_receipt_sha256 ?? null)
          !== prepared.expectedHeadSha256) {
        return authorityError(
          "lite_runtime_deployment_slot_authority_completion_stale",
          "deployment-slot prepared receipt changed before durable completion",
        );
      }
      leaseState.stateDatabase.db.prepare(
        `INSERT INTO lite_runtime_deployment_slot_binding_completions
           (reservation_id, operation_id, checkpoint_generation,
            database_binding_receipt_sha256, database_binding_receipt_json,
            external_execution_policy_sha256, external_execution_policy_json,
            completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reservationState.row.reservation_id,
        reservationState.operation.operation_id,
        reservationState.row.checkpoint_generation,
        prepared.envelopeSha256,
        prepared.envelopeJson,
        prepared.policySha256,
        prepared.policyJson,
        completedAt,
      );
    },
  );
  replayed = assertLeaseState(leaseState);
  const completion = replayed.completions.get(reservationState.row.reservation_id);
  if (!completion
    || completion.database_binding_receipt_sha256 !== prepared.envelopeSha256
    || replayed.head?.completion.database_binding_receipt_sha256
      !== prepared.envelopeSha256) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_completion_invalid",
      "deployment-slot binding completion did not become the exact durable head",
    );
  }
  prepared.consumed = true;
  reservationState.consumed = true;
  leaseState.activeReservationCapability = null;
  leaseState.inspection = leaseInspection(leaseState, replayed);
  return completionFromRow(replayed, completion, false);
}

/**
 * Releases the local carrier lock. A still-active reservation is first
 * append-only abandoned and remains burned in the current durable lineage.
 * Validation/state failures before witness finalization leave the lease live.
 * Once carrier finalization begins, an uncertain commit closes the in-process
 * capability and requires reacquisition plus full replay.
 */
export async function releaseLiteRuntimeDeploymentSlotExclusiveLease(
  capability: LiteRuntimeDeploymentSlotExclusiveLeaseCapability,
  options: Readonly<{ now?: Date }> = {},
): Promise<void> {
  const state = requiredLeaseState(capability);
  const releasedAt = canonicalTime(
    options.now ?? new Date(),
    "lease release time",
  );
  let replayed = assertLeaseState(state);
  if (releasedAt < latestSemanticEventAt(replayed)) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_release_failed",
      "deployment-slot lease release time would roll durable authority backward",
    );
  }
  if (replayed.activeReservation) {
    runStateTransaction(
      state.stateDatabase,
      state.statePin,
      state.authorityStatePath,
      () => {
        const inside = replayDurableState(state.stateDatabase.db);
        assertCarrierWriterLock(state);
        if (inside.activeReservation?.reservation_id
          !== replayed.activeReservation?.reservation_id) {
          return authorityError(
            "lite_runtime_deployment_slot_authority_release_failed",
            "deployment-slot active reservation changed before release",
          );
        }
        const activeReservation = inside.activeReservation;
        if (!activeReservation) {
          return authorityError(
            "lite_runtime_deployment_slot_authority_release_failed",
            "deployment-slot active reservation disappeared before release",
          );
        }
        state.stateDatabase.db.prepare(
          `INSERT INTO lite_runtime_deployment_slot_reservation_abandonments
             (reservation_id, closed_by_lease_epoch, reason, abandoned_at)
           VALUES (?, ?, 'lease_released', ?)`,
        ).run(activeReservation.reservation_id, state.leaseEpoch, releasedAt);
      },
    );
    replayed = assertLeaseState(state);
    if (replayed.activeReservation !== null) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_release_failed",
        "deployment-slot reservation abandonment did not commit before release",
      );
    }
    if (state.activeReservationCapability) {
      const reservation = reservationRegistry.get(state.activeReservationCapability);
      if (reservation) reservation.consumed = true;
      state.activeReservationCapability = null;
    }
  }

  replayed = assertLeaseState(state);
  const carrierIdentity = assertCarrierIdentity(
    state.carrierDatabase.db,
    state.registration.deployment_slot,
    replayed.registration,
    state.carrierPin,
  );
  const previousWitness = assertCarrierWitnesses(
    state.carrierDatabase.db,
    carrierIdentity,
    replayed,
    state.statePin,
  );
  const witnessEpoch = incrementU64(
    parseCanonicalU64(previousWitness.witness_epoch, "latest carrier witness epoch", true),
    "carrier witness epoch",
  );
  const witness = buildCarrierWitness(
    replayed,
    state.statePin,
    witnessEpoch,
    releasedAt,
    previousWitness.witness_sha256,
  );

  let releaseFailed = false;
  let carrierCommitted = false;
  try {
    assertCarrierWriterLock(state);
    insertCarrierWitness(state.carrierDatabase.db, witness);
    const insertedWitness = assertCarrierWitnesses(
      state.carrierDatabase.db,
      carrierIdentity,
      replayed,
      state.statePin,
    );
    if (stableStringify(insertedWitness) !== stableStringify(witness)) {
      return authorityError(
        "lite_runtime_deployment_slot_authority_release_failed",
        "deployment-slot carrier witness did not append exactly",
      );
    }
    // Do not invoke the secret savepoint guard after this insert: rolling back
    // to that savepoint would discard the witness being committed.
    state.carrierDatabase.db.exec("COMMIT");
    carrierCommitted = true;
    assertLiteRuntimeProtectedAuthorityDatabasePinned(state.carrierPin);
    syncStateDatabaseFiles(state.leaseCarrierPath);
  } catch {
    if (!carrierCommitted) {
      try { state.carrierDatabase.db.exec("ROLLBACK"); } catch { /* fail closed below */ }
    }
    releaseFailed = true;
  }
  try {
    await state.stateDatabase.close();
  } catch {
    releaseFailed = true;
  }
  try {
    await state.carrierDatabase.close();
  } catch {
    releaseFailed = true;
  }
  try {
    closeLiteRuntimeProtectedAuthorityDatabasePin(state.runtimeDatabasePin);
    closeLiteRuntimeProtectedAuthorityDatabasePin(state.statePin);
    closeLiteRuntimeProtectedAuthorityDatabasePin(state.carrierPin);
  } catch {
    releaseFailed = true;
  }
  state.closed = true;
  if (releaseFailed) {
    return authorityError(
      "lite_runtime_deployment_slot_authority_release_failed",
      "deployment-slot lease resources did not close cleanly",
    );
  }
}
