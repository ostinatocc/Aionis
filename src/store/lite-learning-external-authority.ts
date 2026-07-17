import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  ExternalExecutionPolicyV1Schema,
  RequiredExternalInputsV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "../memory/learning-episode-ledger.js";
import {
  LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
  LearningExternalCleanQuiesceReceiptBodyV1Schema,
  LearningExternalClaimReceiptBodyV1Schema,
  LearningExternalLauncherSpawnReceiptBodyV1Schema,
  LearningExternalImmutableInputManifestV1Schema,
  LearningExternalPreclaimHoldReceiptBodyV1Schema,
  LearningExternalRunReservationAuthorizationReceiptBodyV1Schema,
  LearningExternalRunReservationAuthorizationReceiptEnvelopeV1Schema,
  LearningExternalSessionTerminationReceiptBodyV1Schema,
  LearningExternalSignedReceiptEnvelopeV1Schema,
  LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema,
  LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1Schema,
  LearningExternalRetryPolicyV1Schema,
  LearningExternalPreclaimHoldRowV1Schema,
  LearningExternalRunClaimRowV1Schema,
  LearningExternalSessionTerminationRowV1Schema,
  LearningExternalSupervisorBindingRowV1Schema,
  learningExternalBrokerServiceActorId,
  learningExternalPreclaimHoldOperationId,
  learningExternalPreclaimHoldRowDigest,
  learningExternalReceiptDigest,
  learningExternalRunClaimOperationId,
  learningExternalRunClaimRowDigest,
  learningExternalSessionTerminationOperationId,
  learningExternalSessionTerminationRowDigest,
  learningExternalSupervisorBindingOperationId,
  learningExternalSupervisorBindingRowDigest,
  verifyLearningExternalReceipt,
  type LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1,
  type LearningExternalClaimReceiptEnvelopeV1,
  type LearningExternalPreclaimHoldReceiptEnvelopeV1,
  type LearningExternalRunReservationAuthorizationReceiptEnvelopeV1,
  type LearningExternalSessionTerminationReceiptEnvelopeV1,
  type LearningExternalSignedReceiptEnvelopeV1,
  type LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1,
} from "../memory/learning-external-authority.js";
import {
  learningExternalRunReservationDigest,
  learningExternalTicketConsumptionDigest,
  type LiteLearningAuthorityRow,
  type LiteLearningSqlValue,
} from "./lite-learning-confirmatory-authority.js";
import {
  LearningExternalLifecycleAuthorityProjectionV1Schema,
  type LearningExternalLifecycleAuthorityProjectionV1,
} from "../memory/learning-external-evidence.js";
import { resolveProtectedApplicabilityAuthorityFromDatabase } from
  "./lite-learning-experiment-applicability.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const BoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});
const CanonicalUtcMillisSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .datetime({ offset: false, precision: 3 });

const RequiredEvidenceSeriesV1Schema = z.object({
  offline_paired: BoundedIdSchema,
  production_shadow: BoundedIdSchema,
  tool_e2e: BoundedIdSchema,
  runtime_integrity: BoundedIdSchema,
}).strict();

const ExternalAuthorityOperationReceiptV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_authority_operation_receipt_v1"),
  tenant_id: BoundedIdSchema,
  scope: z.literal("learning_external_authority_v1"),
  operation_kind: z.enum([
    "learning_external_run_reservation_v1",
    "learning_external_ticket_consumption_v1",
    "learning_external_preclaim_hold_v1",
    "learning_external_run_claim_v1",
    "learning_external_supervisor_binding_v1",
    "learning_external_session_termination_v1",
  ]),
  operation_id: BoundedIdSchema,
  actor_id: BoundedIdSchema,
  request_sha256: DigestSha256Schema,
  authority_table: z.enum([
    "lite_learning_external_run_reservations",
    "lite_learning_external_ticket_consumptions",
    "lite_learning_external_preclaim_holds",
    "lite_learning_external_run_claims",
    "lite_learning_external_supervisor_bindings",
    "lite_learning_external_session_terminations",
  ]),
  authority_ref_id: BoundedIdSchema,
  authority_record_sha256: DigestSha256Schema,
  broker_authorization_receipt_sha256: DigestSha256Schema.nullable(),
  broker_authorization_receipt: LearningExternalSignedReceiptEnvelopeV1Schema.nullable(),
  recorded_at: CanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  const expectedTable = {
    learning_external_run_reservation_v1: "lite_learning_external_run_reservations",
    learning_external_ticket_consumption_v1: "lite_learning_external_ticket_consumptions",
    learning_external_preclaim_hold_v1: "lite_learning_external_preclaim_holds",
    learning_external_run_claim_v1: "lite_learning_external_run_claims",
    learning_external_supervisor_binding_v1: "lite_learning_external_supervisor_bindings",
    learning_external_session_termination_v1: "lite_learning_external_session_terminations",
  } as const;
  if (value.authority_table !== expectedTable[value.operation_kind]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority_table"],
      message: "External authority operation kind and table disagree",
    });
  }
  const requiresAuthorization = value.operation_kind === "learning_external_run_reservation_v1"
    || value.operation_kind === "learning_external_ticket_consumption_v1";
  if (requiresAuthorization !== (value.broker_authorization_receipt !== null)
    || requiresAuthorization !== (value.broker_authorization_receipt_sha256 !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_authorization_receipt"],
      message: "Reserve and consume operations alone require a broker-signed authorization",
    });
  }
  if (value.broker_authorization_receipt !== null
    && value.broker_authorization_receipt_sha256
      !== learningExternalReceiptDigest(value.broker_authorization_receipt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["broker_authorization_receipt_sha256"],
      message: "Broker authorization digest mismatch",
    });
  }
});

export type LiteLearningExternalAuthorityOperationReceiptV1 = z.infer<
  typeof ExternalAuthorityOperationReceiptV1Schema
>;

const EXTERNAL_AUTHORITY_SCOPE = "learning_external_authority_v1" as const;

const EXTERNAL_RESERVATION_COLUMNS = [
  "tenant_id", "reservation_id", "artifact_kind", "evidence_series_id", "task_family",
  "candidate_policy_id", "candidate_policy_version", "candidate_policy_implementation_sha256",
  "candidate_policy_config_sha256", "applicable_experiment_id", "applicable_experiment_revision",
  "gate_policy_id", "gate_policy_version", "gate_policy_config_sha256",
  "applicability_manifest_sha256", "harness_bundle_sha256", "source_snapshot_sha256",
  "case_set_sha256", "holdout_membership_projection_sha256", "sealed_holdout_ref_sha256",
  "sealed_holdout_ciphertext_sha256", "execution_profile_sha256", "model_identity_sha256",
  "immutable_model_snapshot_sha256", "tool_manifest_sha256", "execution_order_sha256",
  "retry_policy_sha256", "retry_policy_json", "immutable_input_manifest_sha256",
  "immutable_input_manifest_json", "expected_runner_principal_sha256",
  "credential_broker_policy_sha256", "service_launcher_policy_sha256",
  "service_launcher_binary_sha256", "service_launcher_key_id", "supervisor_executable_sha256",
  "supervisor_argv_policy_sha256", "supervisor_sandbox_policy_sha256",
  "credential_session_class", "run_id", "reserve_operation_id", "runner_ticket_sha256",
  "reservation_sha256", "reserved_at",
] as const;

const EXTERNAL_HOLDOUT_MEMBER_COLUMNS = [
  "tenant_id", "reservation_id", "task_family", "case_ordinal", "case_identity_sha256",
  "task_id_sha256", "content_workflow_sha256", "store_scope_sha256", "source_event_sha256",
  "source_evidence_sha256", "member_record_sha256", "created_at",
] as const;

const EXTERNAL_CONSUMPTION_COLUMNS = [
  "tenant_id", "consumption_id", "reservation_id", "runner_ticket_sha256",
  "runner_principal_sha256", "broker_process_nonce_sha256", "consume_operation_id",
  "consumed_at", "consumption_sha256",
] as const;

const EXTERNAL_PRECLAIM_HOLD_COLUMNS = [
  "tenant_id", "hold_id", "reservation_id", "ticket_consumption_id", "hold_reason",
  "triggering_terminal_fact_sha256", "zero_effects_proof_sha256",
  "broker_preclaim_hold_receipt_sha256", "broker_preclaim_hold_receipt_json",
  "broker_preclaim_hold_receipt_signature", "hold_actor_id", "hold_operation_id",
  "held_at", "hold_sha256",
] as const;

const EXTERNAL_CLAIM_COLUMNS = [
  "tenant_id", "claim_id", "reservation_id", "ticket_consumption_id",
  "ticket_consumption_sha256", "runner_principal_sha256", "runner_execution_nonce_sha256",
  "credential_broker_receipt_sha256", "credential_broker_policy_sha256",
  "credential_broker_binary_sha256", "credential_broker_key_id",
  "credential_broker_receipt_json", "credential_broker_receipt_signature",
  "credential_session_id_sha256", "supervisor_bind_expires_at",
  "credential_session_expires_at", "credential_session_heartbeat_seconds",
  "credential_session_max_calls", "claim_operation_id", "claimed_at", "claim_sha256",
] as const;

const EXTERNAL_BINDING_COLUMNS = [
  "tenant_id", "binding_id", "reservation_id", "ticket_consumption_id", "claim_id",
  "credential_session_id_sha256", "runner_principal_sha256",
  "supervisor_process_identity_sha256", "supervisor_executable_sha256",
  "supervisor_argv_sha256", "inherited_channel_sha256", "service_launcher_receipt_sha256",
  "service_launcher_policy_sha256", "service_launcher_binary_sha256", "service_launcher_key_id",
  "supervisor_sandbox_policy_sha256", "broker_binding_receipt_sha256",
  "broker_binding_receipt_json", "broker_binding_receipt_signature", "bind_operation_id",
  "bound_at", "binding_sha256",
] as const;

const EXTERNAL_TERMINATION_COLUMNS = [
  "tenant_id", "termination_id", "reservation_id", "ticket_consumption_id", "claim_id",
  "supervisor_binding_id", "credential_session_id_sha256", "termination_reason",
  "broker_quiesce_receipt_sha256", "runner_output_manifest_sha256",
  "terminal_run_manifest_sha256", "attempt_chain_sha256",
  "credential_broker_policy_sha256", "credential_broker_binary_sha256",
  "credential_broker_key_id", "broker_terminal_receipt_sha256",
  "broker_terminal_receipt_json", "broker_terminal_receipt_signature",
  "termination_actor_id", "terminate_operation_id", "terminated_at", "termination_sha256",
] as const;

const EXTERNAL_ROLE_BY_ARTIFACT_KIND = {
  offline_paired_rerun: "offline_paired",
  production_shadow_gate: "production_shadow",
  tool_e2e_gate: "tool_e2e",
} as const;

type ExternalArtifactKind = keyof typeof EXTERNAL_ROLE_BY_ARTIFACT_KIND;
type ExternalRoleName = (typeof EXTERNAL_ROLE_BY_ARTIFACT_KIND)[ExternalArtifactKind];

type RevisionAuthority = Readonly<{
  row: LiteLearningAuthorityRow;
  databaseInstanceId: string;
  externalPolicy: ExternalExecutionPolicyV1;
  roleName: ExternalRoleName;
  role: ExternalExecutionPolicyV1["roles"][ExternalRoleName];
}>;

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRunnerTicket(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 4_096) {
    throw new Error("external runner ticket must contain 32 to 4096 opaque bytes");
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(row: LiteLearningAuthorityRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function requiredInteger(row: LiteLearningAuthorityRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Missing integer ${field}`);
  }
  return value;
}

function canonicalJson(raw: LiteLearningSqlValue, field: string): unknown {
  if (typeof raw !== "string") throw new Error(`${field} must be canonical JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (stableStringify(parsed) !== raw) throw new Error(`${field} must be canonical JSON text`);
  return parsed;
}

function canonicalRowWithoutDigest(
  row: LiteLearningAuthorityRow,
  digestField: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function learningExternalHoldoutMemberDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalRowWithoutDigest(row, "member_record_sha256")));
}

export function learningExternalHoldoutCaseSetDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  return sha256Text(stableStringify([...rows]
    .sort((left, right) => requiredInteger(left, "case_ordinal") - requiredInteger(right, "case_ordinal"))
    .map((row) => requiredString(row, "case_identity_sha256"))));
}

export function learningExternalHoldoutMembershipProjectionDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  return sha256Text(stableStringify([...rows]
    .sort((left, right) => requiredInteger(left, "case_ordinal") - requiredInteger(right, "case_ordinal"))
    .map((row) => ({
      case_ordinal: requiredInteger(row, "case_ordinal"),
      case_identity_sha256: requiredString(row, "case_identity_sha256"),
      task_id_sha256: requiredString(row, "task_id_sha256"),
      content_workflow_sha256: requiredString(row, "content_workflow_sha256"),
      store_scope_sha256: requiredString(row, "store_scope_sha256"),
      source_event_sha256: requiredString(row, "source_event_sha256"),
      source_evidence_sha256: requiredString(row, "source_evidence_sha256"),
      member_record_sha256: requiredString(row, "member_record_sha256"),
    }))));
}

export function learningExternalHoldoutExecutionOrderDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  return sha256Text(stableStringify([...rows]
    .sort((left, right) => requiredInteger(left, "case_ordinal") - requiredInteger(right, "case_ordinal"))
    .map((row) => ({
      case_ordinal: requiredInteger(row, "case_ordinal"),
      case_identity_sha256: requiredString(row, "case_identity_sha256"),
    }))));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
  }
  return Object.is(left, right);
}

function assertExactColumns(
  table: string,
  row: LiteLearningAuthorityRow,
  expectedColumns: readonly string[],
): void {
  const actual = Object.keys(row).sort();
  const expected = [...expectedColumns].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`${table} row shape mismatch`);
  }
}

function selectExactRow(
  db: SqliteDatabase,
  table: string,
  replayKeys: readonly string[],
  row: LiteLearningAuthorityRow,
): Record<string, unknown> | null {
  const where = replayKeys.map((field) => `${field} IS ?`).join(" AND ");
  return (db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`).get(
    ...replayKeys.map((field) => row[field]),
  ) as Record<string, unknown> | undefined) ?? null;
}

function assertExactReplay(
  table: string,
  existing: Readonly<Record<string, unknown>>,
  row: LiteLearningAuthorityRow,
): void {
  for (const [field, expected] of Object.entries(row)) {
    if (!valuesEqual(existing[field], expected)) {
      throw new Error(`learning_external_authority_replay_conflict:${table}.${field}`);
    }
  }
}

function insertExactRow(
  db: SqliteDatabase,
  table: string,
  columns: readonly string[],
  replayKeys: readonly string[],
  row: LiteLearningAuthorityRow,
): { row: Record<string, unknown>; replayed: boolean } {
  assertExactColumns(table, row, columns);
  const existing = selectExactRow(db, table, replayKeys, row);
  if (existing) {
    assertExactReplay(table, existing, row);
    return { row: existing, replayed: true };
  }
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((field) => row[field]));
  const inserted = selectExactRow(db, table, replayKeys, row);
  if (!inserted) throw new Error(`learning_external_authority_insert_missing:${table}`);
  return { row: inserted, replayed: false };
}

let savepointSequence = 0;

function withSavepoint<T>(db: SqliteDatabase, fn: () => T): T {
  savepointSequence += 1;
  const savepoint = `learning_external_authority_${savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

function assertStoreTransaction(transaction: SqliteTransactionRunner): void {
  if (!transaction.inTransaction()) {
    throw new Error("external learning authority mutations require the shared Runtime transaction");
  }
}

function operationRow(db: SqliteDatabase, args: {
  tenantId: string;
  operationKind: string;
  operationId: string;
}): Record<string, unknown> | null {
  const found = db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
  ).get(args.tenantId, EXTERNAL_AUTHORITY_SCOPE, args.operationKind, args.operationId);
  return (found as Record<string, unknown> | undefined) ?? null;
}

function parseOperationReceipt(raw: unknown): LiteLearningExternalAuthorityOperationReceiptV1 {
  if (typeof raw !== "string") throw new Error("external authority operation receipt is missing");
  const parsed = canonicalJson(raw, "external authority operation receipt");
  const receipt = ExternalAuthorityOperationReceiptV1Schema.parse(parsed);
  if (stableStringify(receipt) !== raw) {
    throw new Error("external authority operation receipt is not schema-canonical");
  }
  return receipt;
}

function insertOperationReceipt(db: SqliteDatabase, receipt: LiteLearningExternalAuthorityOperationReceiptV1): void {
  const receiptJson = stableStringify(ExternalAuthorityOperationReceiptV1Schema.parse(receipt));
  db.prepare(
    `INSERT INTO lite_runtime_write_operations
       (tenant_id, scope, operation_kind, operation_id, request_sha256,
        receipt_json, commit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    receipt.tenant_id,
    receipt.scope,
    receipt.operation_kind,
    receipt.operation_id,
    receipt.request_sha256,
    receiptJson,
    receipt.recorded_at,
  );
}

function resolveRevisionAuthority(
  db: SqliteDatabase,
  reservation: LiteLearningAuthorityRow,
): RevisionAuthority {
  const artifactKind = requiredString(reservation, "artifact_kind") as ExternalArtifactKind;
  const roleName = EXTERNAL_ROLE_BY_ARTIFACT_KIND[artifactKind];
  if (!roleName) throw new Error("unsupported external reservation artifact kind");
  const revision = db.prepare(
    `SELECT * FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(
    reservation.tenant_id,
    reservation.applicable_experiment_id,
    reservation.applicable_experiment_revision,
  ) as LiteLearningAuthorityRow | undefined;
  if (!revision) throw new Error("external reservation experiment revision is unresolved");
  if (revision.evidence_intent !== "confirmatory") {
    throw new Error("external reservation requires a confirmatory experiment revision");
  }
  const externalPolicy = ExternalExecutionPolicyV1Schema.parse(canonicalJson(
    revision.external_execution_policy_json,
    "external execution policy",
  ));
  if (externalExecutionPolicyDigest(externalPolicy) !== revision.external_execution_policy_sha256) {
    throw new Error("external reservation policy digest mismatch");
  }
  const identity = db.prepare(
    "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
  ).get() as { database_instance_id: string } | undefined;
  if (!identity
    || externalPolicy.runtime_authority_attestor.expected_database_instance_id
      !== identity.database_instance_id) {
    throw new Error("external reservation policy database lineage mismatch");
  }
  return {
    row: revision,
    databaseInstanceId: identity.database_instance_id,
    externalPolicy,
    roleName,
    role: externalPolicy.roles[roleName],
  };
}

type ExternalReservationExperimentClosure = Readonly<{
  close_sha256: string;
  created_at: string;
}>;

function reservationExperimentClosure(
  db: SqliteDatabase,
  reservation: LiteLearningAuthorityRow,
): ExternalReservationExperimentClosure | null {
  return (db.prepare(
    `SELECT close_sha256, created_at FROM lite_learning_experiment_closures
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ? LIMIT 1`,
  ).get(
    reservation.tenant_id,
    reservation.applicable_experiment_id,
    reservation.applicable_experiment_revision,
  ) as ExternalReservationExperimentClosure | undefined) ?? null;
}

function assertRevisionOpenForReservation(db: SqliteDatabase, reservation: LiteLearningAuthorityRow): void {
  if (reservationExperimentClosure(db, reservation)) {
    throw new Error("external reservation experiment revision is closed");
  }
}

function resolveTriggeringExternalTerminalFact(args: {
  db: SqliteDatabase;
  reservation: LiteLearningAuthorityRow;
  triggeringTerminalFactSha256: string;
}): Readonly<{ recorded_at: string }> {
  DigestSha256Schema.parse(args.triggeringTerminalFactSha256);
  const rows = args.db.prepare(
    `SELECT 'preclaim_hold' AS fact_kind,
            hold.hold_id AS fact_id,
            hold.held_at AS recorded_at,
            source.applicable_experiment_id,
            source.applicable_experiment_revision,
            source.reservation_id
     FROM lite_learning_external_preclaim_holds AS hold
     JOIN lite_learning_external_run_reservations AS source
       ON source.tenant_id = hold.tenant_id
      AND source.reservation_id = hold.reservation_id
     WHERE hold.tenant_id = ? AND hold.hold_sha256 = ?
     UNION ALL
     SELECT 'session_termination' AS fact_kind,
            termination.termination_id AS fact_id,
            termination.terminated_at AS recorded_at,
            source.applicable_experiment_id,
            source.applicable_experiment_revision,
            source.reservation_id
     FROM lite_learning_external_session_terminations AS termination
     JOIN lite_learning_external_run_reservations AS source
       ON source.tenant_id = termination.tenant_id
      AND source.reservation_id = termination.reservation_id
     WHERE termination.tenant_id = ?
       AND termination.termination_sha256 = ?
       AND termination.termination_reason <> 'passed'`,
  ).all(
    args.reservation.tenant_id,
    args.triggeringTerminalFactSha256,
    args.reservation.tenant_id,
    args.triggeringTerminalFactSha256,
  ) as Array<Record<string, unknown>>;
  if (rows.length !== 1) {
    throw new Error("external close-reserved-run triggering terminal fact is unresolved or ambiguous");
  }
  const row = rows[0]!;
  if (row.applicable_experiment_id !== args.reservation.applicable_experiment_id
    || row.applicable_experiment_revision !== args.reservation.applicable_experiment_revision
    || row.reservation_id === args.reservation.reservation_id) {
    throw new Error("external close-reserved-run triggering fact is outside the reservation attempt");
  }
  if (typeof row.recorded_at !== "string" || row.recorded_at.length === 0) {
    throw new Error("external close-reserved-run triggering fact time is missing");
  }
  const factId = row.fact_id;
  if (typeof factId !== "string" || factId.length === 0) {
    throw new Error("external close-reserved-run triggering fact identity is missing");
  }
  if (row.fact_kind === "preclaim_hold") {
    const hold = selectAuthorityRow(args.db, "lite_learning_external_preclaim_holds", [
      ["tenant_id", args.reservation.tenant_id],
      ["hold_id", factId],
    ]);
    if (!hold || hold.hold_sha256 !== args.triggeringTerminalFactSha256) {
      throw new Error("external close-reserved-run triggering hold changed during resolution");
    }
    assertProtectedPreclaimHoldAuthorityRow(args.db, hold);
  } else if (row.fact_kind === "session_termination") {
    const termination = selectAuthorityRow(
      args.db,
      "lite_learning_external_session_terminations",
      [
        ["tenant_id", args.reservation.tenant_id],
        ["termination_id", factId],
      ],
    );
    if (!termination
      || termination.termination_sha256 !== args.triggeringTerminalFactSha256
      || termination.termination_reason === "passed") {
      throw new Error("external close-reserved-run triggering termination changed during resolution");
    }
    assertProtectedTerminationAuthorityRow(args.db, termination);
  } else {
    throw new Error("external close-reserved-run triggering terminal fact kind is invalid");
  }
  return { recorded_at: row.recorded_at };
}

function assertReservationRevisionBindings(
  db: SqliteDatabase,
  reservation: LiteLearningAuthorityRow,
  options: { fresh: boolean },
): RevisionAuthority {
  if (options.fresh) assertRevisionOpenForReservation(db, reservation);
  const authority = resolveRevisionAuthority(db, reservation);
  const revision = authority.row;
  const role = authority.role;
  const series = RequiredEvidenceSeriesV1Schema.parse(canonicalJson(
    revision.required_evidence_series_json,
    "required evidence series",
  ));
  const externalInputs = RequiredExternalInputsV1Schema.parse(canonicalJson(
    revision.required_external_inputs_json,
    "required external inputs",
  ));
  const applicabilityAuthority = resolveProtectedApplicabilityAuthorityFromDatabase({
    db,
    tenantId: requiredString(reservation, "tenant_id"),
    experimentId: requiredString(reservation, "applicable_experiment_id"),
    experimentRevision: requiredInteger(reservation, "applicable_experiment_revision"),
  });
  if (reservation.applicability_manifest_sha256
    !== applicabilityAuthority.manifestSha256) {
    throw new Error("external reservation applicability manifest binding mismatch");
  }
  const requiredInput = externalInputs[authority.roleName];
  const config = canonicalJson(revision.config_json, "experiment revision config");
  const taskFamily = config && typeof config === "object" && !Array.isArray(config)
    && typeof (config as Record<string, unknown>).task_family === "string"
    ? (config as Record<string, unknown>).task_family
    : null;
  const expectedBindings: ReadonlyArray<readonly [string, unknown]> = [
    ["evidence_series_id", series[authority.roleName]],
    ["task_family", taskFamily],
    ["candidate_policy_id", revision.candidate_policy_id],
    ["candidate_policy_version", revision.candidate_policy_version],
    ["candidate_policy_implementation_sha256", revision.candidate_policy_implementation_sha256],
    ["candidate_policy_config_sha256", revision.candidate_policy_config_sha256],
    ["gate_policy_id", revision.gate_policy_id],
    ["gate_policy_version", revision.gate_policy_version],
    ["gate_policy_config_sha256", revision.gate_policy_config_sha256],
    ["retry_policy_sha256", requiredInput.retry_policy_sha256],
    ["immutable_input_manifest_sha256", requiredInput.immutable_input_manifest_sha256],
    ["run_id", requiredInput.planned_run_id],
    ["expected_runner_principal_sha256", role.runner_principal_sha256],
    ["credential_broker_policy_sha256", role.broker_policy_sha256],
    ["service_launcher_policy_sha256", role.service_launcher_policy_sha256],
    ["service_launcher_binary_sha256", role.service_launcher_binary_sha256],
    ["service_launcher_key_id", role.service_launcher_key_id],
    ["supervisor_executable_sha256", role.supervisor_executable_sha256],
    ["supervisor_argv_policy_sha256", role.supervisor_argv_policy_sha256],
    ["supervisor_sandbox_policy_sha256", role.supervisor_sandbox_policy_sha256],
    ["credential_session_class", role.credential_session_class],
  ];
  for (const [field, expected] of expectedBindings) {
    if (!valuesEqual(reservation[field], expected)) {
      throw new Error(`external reservation revision binding mismatch: ${field}`);
    }
  }
  return authority;
}

function assertReservationJsonAndDigest(reservation: LiteLearningAuthorityRow): void {
  const retryPolicy = LearningExternalRetryPolicyV1Schema.parse(canonicalJson(
    reservation.retry_policy_json,
    "external retry policy",
  ));
  const inputManifest = LearningExternalImmutableInputManifestV1Schema.parse(canonicalJson(
    reservation.immutable_input_manifest_json,
    "external immutable input manifest",
  ));
  if (sha256Text(stableStringify(retryPolicy)) !== reservation.retry_policy_sha256
    || sha256Text(stableStringify(inputManifest)) !== reservation.immutable_input_manifest_sha256) {
    throw new Error("external reservation canonical manifest digest mismatch");
  }
  for (const [field, expected] of Object.entries(inputManifest)) {
    if (field !== "contract_version" && !valuesEqual(reservation[field], expected)) {
      throw new Error(`external reservation immutable input binding mismatch: ${field}`);
    }
  }
  if (learningExternalRunReservationDigest(reservation) !== reservation.reservation_sha256) {
    throw new Error("external reservation record digest mismatch");
  }
  CanonicalUtcMillisSchema.parse(reservation.reserved_at);
}

function assertHoldoutMembers(
  reservation: LiteLearningAuthorityRow,
  members: readonly LiteLearningAuthorityRow[],
): void {
  const offline = reservation.artifact_kind === "offline_paired_rerun";
  if (!offline && members.length !== 0) {
    throw new Error("non-offline external reservation cannot include holdout members");
  }
  if (!offline) return;
  if (members.length !== 96) throw new Error("offline external reservation requires exactly 96 holdout members");
  const ordinals = new Set<number>();
  for (const member of members) {
    assertExactColumns(
      "lite_learning_external_holdout_members",
      member,
      EXTERNAL_HOLDOUT_MEMBER_COLUMNS,
    );
    const ordinal = requiredInteger(member, "case_ordinal");
    if (ordinal < 0 || ordinal > 95 || ordinals.has(ordinal)) {
      throw new Error("offline external reservation holdout ordinals must be exactly 0 through 95");
    }
    ordinals.add(ordinal);
    if (member.tenant_id !== reservation.tenant_id
      || member.reservation_id !== reservation.reservation_id
      || member.task_family !== reservation.task_family
      || member.created_at !== reservation.reserved_at
      || learningExternalHoldoutMemberDigest(member) !== member.member_record_sha256) {
      throw new Error("offline external holdout member binding mismatch");
    }
  }
  if (ordinals.size !== 96
    || learningExternalHoldoutCaseSetDigest(members) !== reservation.case_set_sha256
    || learningExternalHoldoutMembershipProjectionDigest(members)
      !== reservation.holdout_membership_projection_sha256
    || learningExternalHoldoutExecutionOrderDigest(members) !== reservation.execution_order_sha256) {
    throw new Error("offline external holdout projection digest mismatch");
  }
}

function canonicalHoldoutMemberDigests(
  members: readonly LiteLearningAuthorityRow[],
): readonly LiteLearningSqlValue[] {
  return [...members]
    .sort((left, right) => requiredInteger(left, "case_ordinal") - requiredInteger(right, "case_ordinal"))
    .map((member) => member.member_record_sha256);
}

function reservationAuthorityRequestDigest(args: {
  reservation: LiteLearningAuthorityRow;
  members: readonly LiteLearningAuthorityRow[];
  runnerTicketSha256: string;
}): string {
  return sha256Text(stableStringify({
    contract_version: "aionis_learning_external_reservation_authority_request_v1",
    reservation: args.reservation,
    holdout_member_sha256s: canonicalHoldoutMemberDigests(args.members),
    runner_ticket_sha256: args.runnerTicketSha256,
  }));
}

function consumptionAuthorityRequestDigest(args: {
  consumption: LiteLearningAuthorityRow;
  reservationSha256: string;
  runnerTicketSha256: string;
}): string {
  return sha256Text(stableStringify({
    contract_version: "aionis_learning_external_ticket_consumption_authority_request_v1",
    consumption: args.consumption,
    reservation_sha256: args.reservationSha256,
    runner_ticket_sha256: args.runnerTicketSha256,
  }));
}

function authorizedOperationRequestDigest(args: {
  contractVersion: string;
  authorization: LearningExternalSignedReceiptEnvelopeV1;
  authorityRequestSha256: string;
}): string {
  return sha256Text(stableStringify({
    contract_version: args.contractVersion,
    authority_request_sha256: args.authorityRequestSha256,
    broker_authorization_receipt: args.authorization,
  }));
}

function assertAuthorizationTimes(args: {
  authorizedAt: string;
  expiresAt: string;
  recordedAt: string;
  fresh: boolean;
}): void {
  const authorizedAt = Date.parse(CanonicalUtcMillisSchema.parse(args.authorizedAt));
  const expiresAt = Date.parse(CanonicalUtcMillisSchema.parse(args.expiresAt));
  const recordedAt = Date.parse(CanonicalUtcMillisSchema.parse(args.recordedAt));
  if (args.authorizedAt !== args.recordedAt
    || recordedAt < authorizedAt
    || recordedAt > expiresAt) {
    throw new Error("external broker authorization does not bind the recorded operation time");
  }
  if (args.fresh) {
    const now = Date.now();
    if (authorizedAt > now + 5_000 || now > expiresAt) {
      throw new Error("external broker authorization is not currently valid");
    }
  }
}

function assertFreshSignedOperationWindow(args: {
  recordedAt: string;
  expiresAt: string;
  label: string;
}): void {
  const recordedAt = Date.parse(CanonicalUtcMillisSchema.parse(args.recordedAt));
  const expiresAt = Date.parse(CanonicalUtcMillisSchema.parse(args.expiresAt));
  const now = Date.now();
  if (recordedAt > now + 5_000 || now > expiresAt) {
    throw new Error(`${args.label} is not currently valid`);
  }
}

function assertAuthorizationBindings(
  body: Readonly<Record<string, unknown>>,
  bindings: readonly (readonly [string, unknown])[],
): void {
  for (const [field, expected] of bindings) {
    if (!valuesEqual(body[field], expected)) {
      throw new Error(`external broker authorization binding mismatch: ${field}`);
    }
  }
}

function verifyReservationAuthorization(args: {
  authority: RevisionAuthority;
  reservation: LiteLearningAuthorityRow;
  members: readonly LiteLearningAuthorityRow[];
  runnerTicketSha256: string;
  authorization: LearningExternalRunReservationAuthorizationReceiptEnvelopeV1;
  fresh: boolean;
}): Readonly<{
  authorization: LearningExternalRunReservationAuthorizationReceiptEnvelopeV1;
  authorizationSha256: string;
  authorityRequestSha256: string;
  actorId: string;
}> {
  const verified = verifyLearningExternalReceipt({
    bodySchema: LearningExternalRunReservationAuthorizationReceiptBodyV1Schema,
    envelope: args.authorization,
    expectedPublicKeyBase64: args.authority.role.broker_public_key_base64,
  });
  const body = verified.body;
  const authorityRequestSha256 = reservationAuthorityRequestDigest({
    reservation: args.reservation,
    members: args.members,
    runnerTicketSha256: args.runnerTicketSha256,
  });
  assertBrokerAuthorityBindings(body, args.authority);
  assertAuthorizationBindings(body, [
    ["tenant_id", args.reservation.tenant_id],
    ["database_instance_id", args.authority.databaseInstanceId],
    ["reservation_id", args.reservation.reservation_id],
    ["artifact_kind", args.reservation.artifact_kind],
    ["evidence_series_id", args.reservation.evidence_series_id],
    ["external_role", args.authority.roleName],
    ["applicable_experiment_id", args.reservation.applicable_experiment_id],
    ["applicable_experiment_revision", args.reservation.applicable_experiment_revision],
    ["run_id", args.reservation.run_id],
    ["expected_runner_principal_sha256", args.reservation.expected_runner_principal_sha256],
    ["reserve_operation_id", args.reservation.reserve_operation_id],
    ["reservation_sha256", args.reservation.reservation_sha256],
    ["runner_ticket_sha256", args.runnerTicketSha256],
    ["authority_request_sha256", authorityRequestSha256],
  ]);
  assertAuthorizationTimes({
    authorizedAt: body.authorized_at,
    expiresAt: body.authorization_expires_at,
    recordedAt: requiredString(args.reservation, "reserved_at"),
    fresh: args.fresh,
  });
  return {
    authorization: verified,
    authorizationSha256: learningExternalReceiptDigest(verified),
    authorityRequestSha256,
    actorId: learningExternalBrokerServiceActorId(body),
  };
}

function verifyConsumptionAuthorization(args: {
  authority: RevisionAuthority;
  reservation: LiteLearningAuthorityRow;
  consumption: LiteLearningAuthorityRow;
  runnerTicketSha256: string;
  authorization: LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1;
  fresh: boolean;
}): Readonly<{
  authorization: LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1;
  authorizationSha256: string;
  authorityRequestSha256: string;
  actorId: string;
}> {
  const verified = verifyLearningExternalReceipt({
    bodySchema: LearningExternalTicketConsumptionAuthorizationReceiptBodyV1Schema,
    envelope: args.authorization,
    expectedPublicKeyBase64: args.authority.role.broker_public_key_base64,
  });
  const body = verified.body;
  const authorityRequestSha256 = consumptionAuthorityRequestDigest({
    consumption: args.consumption,
    reservationSha256: requiredString(args.reservation, "reservation_sha256"),
    runnerTicketSha256: args.runnerTicketSha256,
  });
  assertBrokerAuthorityBindings(body, args.authority);
  assertAuthorizationBindings(body, [
    ["tenant_id", args.consumption.tenant_id],
    ["database_instance_id", args.authority.databaseInstanceId],
    ["reservation_id", args.reservation.reservation_id],
    ["consumption_id", args.consumption.consumption_id],
    ["artifact_kind", args.reservation.artifact_kind],
    ["evidence_series_id", args.reservation.evidence_series_id],
    ["external_role", args.authority.roleName],
    ["applicable_experiment_id", args.reservation.applicable_experiment_id],
    ["applicable_experiment_revision", args.reservation.applicable_experiment_revision],
    ["run_id", args.reservation.run_id],
    ["consume_operation_id", args.consumption.consume_operation_id],
    ["reservation_sha256", args.reservation.reservation_sha256],
    ["consumption_sha256", args.consumption.consumption_sha256],
    ["runner_ticket_sha256", args.runnerTicketSha256],
    ["runner_principal_sha256", args.consumption.runner_principal_sha256],
    ["broker_process_nonce_sha256", args.consumption.broker_process_nonce_sha256],
    ["authority_request_sha256", authorityRequestSha256],
  ]);
  assertAuthorizationTimes({
    authorizedAt: body.authorized_at,
    expiresAt: body.authorization_expires_at,
    recordedAt: requiredString(args.consumption, "consumed_at"),
    fresh: args.fresh,
  });
  return {
    authorization: verified,
    authorizationSha256: learningExternalReceiptDigest(verified),
    authorityRequestSha256,
    actorId: learningExternalBrokerServiceActorId(body),
  };
}

function assertOperationReplay(args: {
  operation: Record<string, unknown>;
  requestSha256: string;
  expectedReceipt: Omit<LiteLearningExternalAuthorityOperationReceiptV1, "request_sha256">;
}): LiteLearningExternalAuthorityOperationReceiptV1 {
  if (args.operation.request_sha256 !== args.requestSha256) {
    throw new Error("learning_external_authority_operation_conflict");
  }
  const receipt = parseOperationReceipt(args.operation.receipt_json);
  const expected = { ...args.expectedReceipt, request_sha256: args.requestSha256 };
  if (stableStringify(receipt) !== stableStringify(expected)
    || args.operation.tenant_id !== receipt.tenant_id
    || args.operation.scope !== receipt.scope
    || args.operation.operation_kind !== receipt.operation_kind
    || args.operation.operation_id !== receipt.operation_id
    || args.operation.created_at !== receipt.recorded_at
    || args.operation.commit_id !== null) {
    throw new Error("learning_external_authority_operation_receipt_conflict");
  }
  return receipt;
}

type ExternalLifecyclePrefix = Readonly<{
  reservation: LiteLearningAuthorityRow;
  consumption: LiteLearningAuthorityRow;
  authority: RevisionAuthority;
}>;

function selectAuthorityRow(
  db: SqliteDatabase,
  table: string,
  keys: readonly [string, LiteLearningSqlValue][],
): LiteLearningAuthorityRow | null {
  const where = keys.map(([field]) => `${field} IS ?`).join(" AND ");
  const projection = table === "lite_learning_external_run_reservations"
    ? EXTERNAL_RESERVATION_COLUMNS.join(", ")
    : "*";
  return (db.prepare(`SELECT ${projection} FROM ${table} WHERE ${where} LIMIT 1`).get(
    ...keys.map(([, value]) => value),
  ) as LiteLearningAuthorityRow | undefined) ?? null;
}

function resolveLifecyclePrefix(db: SqliteDatabase, body: Readonly<{
  tenant_id: string;
  reservation_id: string;
  ticket_consumption_id: string;
}>): ExternalLifecyclePrefix {
  const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
    ["tenant_id", body.tenant_id],
    ["reservation_id", body.reservation_id],
  ]);
  const consumption = selectAuthorityRow(db, "lite_learning_external_ticket_consumptions", [
    ["tenant_id", body.tenant_id],
    ["consumption_id", body.ticket_consumption_id],
  ]);
  if (!reservation || !consumption
    || consumption.reservation_id !== reservation.reservation_id
    || consumption.runner_ticket_sha256 !== reservation.runner_ticket_sha256
    || consumption.runner_principal_sha256 !== reservation.expected_runner_principal_sha256
    || learningExternalTicketConsumptionDigest(consumption) !== consumption.consumption_sha256) {
    throw new Error("external signed authority lifecycle prefix mismatch");
  }
  assertReservationJsonAndDigest(reservation);
  const authority = assertReservationRevisionBindings(db, reservation, { fresh: false });
  return { reservation, consumption, authority };
}

function assertBrokerAuthorityBindings(
  body: Readonly<{
    broker_policy_sha256: string;
    broker_binary_sha256: string;
    broker_public_key_sha256: string;
    broker_key_id: string;
  }>,
  authority: RevisionAuthority,
): void {
  const role = authority.role;
  if (body.broker_policy_sha256 !== role.broker_policy_sha256
    || body.broker_binary_sha256 !== role.broker_binary_sha256
    || body.broker_public_key_sha256 !== role.broker_public_key_sha256
    || body.broker_key_id !== role.broker_key_id) {
    throw new Error("external signed receipt broker authority mismatch");
  }
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(CanonicalUtcMillisSchema.parse(timestamp)) + (seconds * 1_000)).toISOString();
}

function signedRequestDigest(
  contractVersion: string,
  envelope: LearningExternalSignedReceiptEnvelopeV1,
  extra: Record<string, unknown> = {},
): string {
  return sha256Text(stableStringify({
    contract_version: contractVersion,
    receipt: envelope,
    ...extra,
  }));
}

function protectedRowResult(args: {
  db: SqliteDatabase;
  table: string;
  columns: readonly string[];
  replayKeys: readonly string[];
  row: LiteLearningAuthorityRow;
  receipt: LiteLearningExternalAuthorityOperationReceiptV1;
}): { row: Record<string, unknown>; replayed: boolean } {
  const existingOperation = operationRow(args.db, {
    tenantId: args.receipt.tenant_id,
    operationKind: args.receipt.operation_kind,
    operationId: args.receipt.operation_id,
  });
  if (existingOperation) {
    const { request_sha256: requestSha256, ...expectedReceipt } = args.receipt;
    assertOperationReplay({
      operation: existingOperation,
      requestSha256,
      expectedReceipt,
    });
    const existing = selectExactRow(args.db, args.table, args.replayKeys, args.row);
    if (!existing) throw new Error(`${args.table} operation replay row is missing`);
    assertExactReplay(args.table, existing, args.row);
    return { row: existing, replayed: true };
  }
  return withSavepoint(args.db, () => {
    const inserted = insertExactRow(
      args.db,
      args.table,
      args.columns,
      args.replayKeys,
      args.row,
    );
    if (inserted.replayed) {
      throw new Error(`${args.table} exists without its protected operation receipt`);
    }
    insertOperationReceipt(args.db, args.receipt);
    return inserted;
  });
}

function preclaimHoldRow(
  db: SqliteDatabase,
  receipt: LearningExternalPreclaimHoldReceiptEnvelopeV1,
): { row: LiteLearningAuthorityRow; receiptSha256: string; actorId: string } {
  const prefix = resolveLifecyclePrefix(db, receipt.body);
  const verified = verifyLearningExternalReceipt({
    bodySchema: LearningExternalPreclaimHoldReceiptBodyV1Schema,
    envelope: receipt,
    expectedPublicKeyBase64: prefix.authority.role.broker_public_key_base64,
  });
  const body = verified.body;
  assertBrokerAuthorityBindings(body, prefix.authority);
  if (body.ticket_consumption_sha256 !== prefix.consumption.consumption_sha256
    || body.held_at < String(prefix.consumption.consumed_at)) {
    throw new Error("external pre-claim hold consumption or time mismatch");
  }
  if (body.journal_phase === "validating_sealed_input"
    && prefix.reservation.artifact_kind !== "offline_paired_rerun") {
    throw new Error("sealed-input validation holds require an offline paired reservation");
  }
  if (db.prepare(
    `SELECT 1 FROM lite_learning_external_run_claims
     WHERE tenant_id = ? AND reservation_id = ? LIMIT 1`,
  ).get(body.tenant_id, body.reservation_id)) {
    throw new Error("external pre-claim hold cannot coexist with a claim");
  }
  const receiptSha256 = learningExternalReceiptDigest(verified);
  const actorId = learningExternalBrokerServiceActorId(body);
  const base = {
    tenant_id: body.tenant_id,
    hold_id: body.hold_id,
    reservation_id: body.reservation_id,
    ticket_consumption_id: body.ticket_consumption_id,
    hold_reason: body.hold_reason,
    triggering_terminal_fact_sha256: body.triggering_terminal_fact_sha256,
    zero_effects_proof_sha256: body.zero_effects_proof_sha256,
    broker_preclaim_hold_receipt_sha256: receiptSha256,
    broker_preclaim_hold_receipt_json: stableStringify(body),
    broker_preclaim_hold_receipt_signature: verified.signature_base64,
    hold_actor_id: actorId,
    hold_operation_id: learningExternalPreclaimHoldOperationId({
      tenantId: body.tenant_id,
      receiptSha256,
    }),
    held_at: body.held_at,
    hold_sha256: "0".repeat(64),
  } satisfies LiteLearningAuthorityRow;
  const row = {
    ...base,
    hold_sha256: learningExternalPreclaimHoldRowDigest(base),
  } satisfies LiteLearningAuthorityRow;
  LearningExternalPreclaimHoldRowV1Schema.parse(row);
  return { row, receiptSha256, actorId };
}

function claimRow(
  db: SqliteDatabase,
  receipt: LearningExternalClaimReceiptEnvelopeV1,
): { row: LiteLearningAuthorityRow; receiptSha256: string; actorId: string } {
  const prefix = resolveLifecyclePrefix(db, receipt.body);
  const verified = verifyLearningExternalReceipt({
    bodySchema: LearningExternalClaimReceiptBodyV1Schema,
    envelope: receipt,
    expectedPublicKeyBase64: prefix.authority.role.broker_public_key_base64,
  });
  const body = verified.body;
  const role = prefix.authority.role;
  assertBrokerAuthorityBindings(body, prefix.authority);
  if (body.ticket_consumption_sha256 !== prefix.consumption.consumption_sha256
    || body.runner_ticket_sha256 !== prefix.reservation.runner_ticket_sha256
    || body.runner_principal_sha256 !== prefix.reservation.expected_runner_principal_sha256
    || body.credential_scope_sha256 !== role.credential_scope_sha256
    || body.credential_session_class !== role.credential_session_class
    || body.supervisor_bind_expires_at !== addSeconds(
      body.claimed_at,
      role.supervisor_bind_ttl_seconds,
    )
    || body.credential_session_expires_at !== addSeconds(
      body.claimed_at,
      role.credential_session_hard_ttl_seconds,
    )
    || body.credential_session_heartbeat_seconds !== role.credential_session_heartbeat_seconds
    || body.credential_session_max_calls !== role.credential_session_max_calls
    || body.per_call_capability_ttl_seconds !== role.per_call_capability_ttl_seconds
    || body.post_quiesce_finalize_ttl_seconds !== role.post_quiesce_finalize_ttl_seconds
    || body.claimed_at < String(prefix.consumption.consumed_at)) {
    throw new Error("external claim receipt does not match its frozen reservation policy");
  }
  if (db.prepare(
    `SELECT 1 FROM lite_learning_external_preclaim_holds
     WHERE tenant_id = ? AND reservation_id = ? LIMIT 1`,
  ).get(body.tenant_id, body.reservation_id)) {
    throw new Error("external claim cannot coexist with a pre-claim hold");
  }
  const receiptSha256 = learningExternalReceiptDigest(verified);
  const actorId = learningExternalBrokerServiceActorId(body);
  const operationId = learningExternalRunClaimOperationId({
    tenantId: body.tenant_id,
    receiptSha256,
  });
  const base = {
    tenant_id: body.tenant_id,
    claim_id: body.claim_id,
    reservation_id: body.reservation_id,
    ticket_consumption_id: body.ticket_consumption_id,
    ticket_consumption_sha256: body.ticket_consumption_sha256,
    runner_principal_sha256: body.runner_principal_sha256,
    runner_execution_nonce_sha256: body.runner_execution_nonce_sha256,
    credential_broker_receipt_sha256: receiptSha256,
    credential_broker_policy_sha256: body.broker_policy_sha256,
    credential_broker_binary_sha256: body.broker_binary_sha256,
    credential_broker_key_id: body.broker_key_id,
    credential_broker_receipt_json: stableStringify(body),
    credential_broker_receipt_signature: verified.signature_base64,
    credential_session_id_sha256: body.credential_session_id_sha256,
    supervisor_bind_expires_at: body.supervisor_bind_expires_at,
    credential_session_expires_at: body.credential_session_expires_at,
    credential_session_heartbeat_seconds: body.credential_session_heartbeat_seconds,
    credential_session_max_calls: body.credential_session_max_calls,
    claim_operation_id: operationId,
    claimed_at: body.claimed_at,
    claim_sha256: "0".repeat(64),
  } satisfies LiteLearningAuthorityRow;
  const row = {
    ...base,
    claim_sha256: learningExternalRunClaimRowDigest(base),
  } satisfies LiteLearningAuthorityRow;
  LearningExternalRunClaimRowV1Schema.parse(row);
  return { row, receiptSha256, actorId };
}

function bindingRow(
  db: SqliteDatabase,
  receipt: LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1,
): { row: LiteLearningAuthorityRow; receiptSha256: string; actorId: string } {
  const prefix = resolveLifecyclePrefix(db, receipt.body);
  const claim = selectAuthorityRow(db, "lite_learning_external_run_claims", [
    ["tenant_id", receipt.body.tenant_id],
    ["claim_id", receipt.body.claim_id],
  ]);
  if (!claim) throw new Error("external supervisor binding claim is unresolved");
  const verified = verifyLearningExternalReceipt({
    bodySchema: LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema,
    envelope: receipt,
    expectedPublicKeyBase64: prefix.authority.role.broker_public_key_base64,
  });
  const body = verified.body;
  const policy = prefix.authority.externalPolicy;
  const role = prefix.authority.role;
  assertBrokerAuthorityBindings(body, prefix.authority);
  verifyLearningExternalReceipt({
    bodySchema: LearningExternalLauncherSpawnReceiptBodyV1Schema,
    envelope: body.service_launcher_receipt,
    expectedPublicKeyBase64:
      policy.runtime_authority_attestor.service_launcher_public_key_base64,
  });
  if (body.reservation_id !== claim.reservation_id
    || body.ticket_consumption_id !== claim.ticket_consumption_id
    || body.credential_session_id_sha256 !== claim.credential_session_id_sha256
    || body.runner_principal_sha256 !== claim.runner_principal_sha256
    || body.service_launcher_policy_sha256 !== role.service_launcher_policy_sha256
    || body.service_launcher_binary_sha256 !== role.service_launcher_binary_sha256
    || body.service_launcher_public_key_sha256
      !== policy.runtime_authority_attestor.service_launcher_public_key_sha256
    || body.service_launcher_key_id !== role.service_launcher_key_id
    || body.supervisor_executable_sha256 !== role.supervisor_executable_sha256
    || body.supervisor_argv_policy_sha256 !== role.supervisor_argv_policy_sha256
    || body.supervisor_sandbox_policy_sha256 !== role.supervisor_sandbox_policy_sha256
    || body.service_launcher_receipt.body.spawned_at < String(claim.claimed_at)
    || body.bound_at < String(claim.claimed_at)
    || body.bound_at > String(claim.supervisor_bind_expires_at)) {
    throw new Error("external supervisor binding does not match its claim or launcher policy");
  }
  const receiptSha256 = learningExternalReceiptDigest(verified);
  const actorId = learningExternalBrokerServiceActorId(body);
  const base = {
    tenant_id: body.tenant_id,
    binding_id: body.binding_id,
    reservation_id: body.reservation_id,
    ticket_consumption_id: body.ticket_consumption_id,
    claim_id: body.claim_id,
    credential_session_id_sha256: body.credential_session_id_sha256,
    runner_principal_sha256: body.runner_principal_sha256,
    supervisor_process_identity_sha256: body.supervisor_process_identity_sha256,
    supervisor_executable_sha256: body.supervisor_executable_sha256,
    supervisor_argv_sha256: body.supervisor_argv_sha256,
    inherited_channel_sha256: body.inherited_channel_sha256,
    service_launcher_receipt_sha256: body.service_launcher_receipt_sha256,
    service_launcher_policy_sha256: body.service_launcher_policy_sha256,
    service_launcher_binary_sha256: body.service_launcher_binary_sha256,
    service_launcher_key_id: body.service_launcher_key_id,
    supervisor_sandbox_policy_sha256: body.supervisor_sandbox_policy_sha256,
    broker_binding_receipt_sha256: receiptSha256,
    broker_binding_receipt_json: stableStringify(body),
    broker_binding_receipt_signature: verified.signature_base64,
    bind_operation_id: learningExternalSupervisorBindingOperationId({
      tenantId: body.tenant_id,
      claimId: body.claim_id,
      receiptSha256,
    }),
    bound_at: body.bound_at,
    binding_sha256: "0".repeat(64),
  } satisfies LiteLearningAuthorityRow;
  const row = {
    ...base,
    binding_sha256: learningExternalSupervisorBindingRowDigest(base),
  } satisfies LiteLearningAuthorityRow;
  LearningExternalSupervisorBindingRowV1Schema.parse(row);
  return { row, receiptSha256, actorId };
}

function terminationRow(
  db: SqliteDatabase,
  receipt: LearningExternalSessionTerminationReceiptEnvelopeV1,
): { row: LiteLearningAuthorityRow; receiptSha256: string; actorId: string } {
  const prefix = resolveLifecyclePrefix(db, receipt.body);
  const claim = selectAuthorityRow(db, "lite_learning_external_run_claims", [
    ["tenant_id", receipt.body.tenant_id],
    ["claim_id", receipt.body.claim_id],
  ]);
  if (!claim) throw new Error("external session termination claim is unresolved");
  const verified = verifyLearningExternalReceipt({
    bodySchema: LearningExternalSessionTerminationReceiptBodyV1Schema,
    envelope: receipt,
    expectedPublicKeyBase64: prefix.authority.role.broker_public_key_base64,
  });
  const body = verified.body;
  const role = prefix.authority.role;
  assertBrokerAuthorityBindings(body, prefix.authority);
  const committedBinding = selectAuthorityRow(db, "lite_learning_external_supervisor_bindings", [
    ["tenant_id", body.tenant_id],
    ["claim_id", body.claim_id],
  ]);
  if (body.reservation_id !== claim.reservation_id
    || body.ticket_consumption_id !== claim.ticket_consumption_id
    || body.credential_session_id_sha256 !== claim.credential_session_id_sha256
    || body.broker_policy_sha256 !== claim.credential_broker_policy_sha256
    || body.broker_binary_sha256 !== claim.credential_broker_binary_sha256
    || body.broker_key_id !== claim.credential_broker_key_id
    || (committedBinding?.binding_id ?? null) !== body.supervisor_binding_id
    || body.terminated_at < String(claim.claimed_at)
    || (committedBinding !== null
      && body.terminated_at < String(committedBinding.bound_at))) {
    throw new Error("external session termination does not preserve its committed claim prefix");
  }
  if (body.termination_reason === "lease_expired"
    && body.terminated_at < String(claim.credential_session_expires_at)) {
    throw new Error("external lease-expired termination precedes the frozen hard expiry");
  }
  if (body.broker_quiesce_receipt !== null) {
    const quiesce = verifyLearningExternalReceipt({
      bodySchema: LearningExternalCleanQuiesceReceiptBodyV1Schema,
      envelope: body.broker_quiesce_receipt,
      expectedPublicKeyBase64: role.broker_public_key_base64,
    });
    assertBrokerAuthorityBindings(quiesce.body, prefix.authority);
    if (quiesce.body.finalize_deadline_at !== addSeconds(
      quiesce.body.quiesced_at,
      role.post_quiesce_finalize_ttl_seconds,
    )) {
      throw new Error("external quiesce receipt finalization deadline policy mismatch");
    }
    if (committedBinding !== null
      && quiesce.body.quiesced_at < String(committedBinding.bound_at)) {
      throw new Error("external clean quiesce precedes the committed supervisor binding");
    }
    if (quiesce.body.quiesced_at > String(claim.credential_session_expires_at)) {
      throw new Error("external clean quiesce followed the frozen credential hard expiry");
    }
    if (["passed", "failed", "inconclusive"].includes(body.termination_reason)
      && body.terminated_at > quiesce.body.finalize_deadline_at) {
      throw new Error("normal external termination exceeded its frozen finalization deadline");
    }
  }
  const receiptSha256 = learningExternalReceiptDigest(verified);
  const actorId = learningExternalBrokerServiceActorId(body);
  const base = {
    tenant_id: body.tenant_id,
    termination_id: body.termination_id,
    reservation_id: body.reservation_id,
    ticket_consumption_id: body.ticket_consumption_id,
    claim_id: body.claim_id,
    supervisor_binding_id: body.supervisor_binding_id,
    credential_session_id_sha256: body.credential_session_id_sha256,
    termination_reason: body.termination_reason,
    broker_quiesce_receipt_sha256: body.broker_quiesce_receipt_sha256,
    runner_output_manifest_sha256: body.runner_output_manifest_sha256,
    terminal_run_manifest_sha256: body.terminal_run_manifest_sha256,
    attempt_chain_sha256: body.attempt_chain_sha256,
    credential_broker_policy_sha256: body.broker_policy_sha256,
    credential_broker_binary_sha256: body.broker_binary_sha256,
    credential_broker_key_id: body.broker_key_id,
    broker_terminal_receipt_sha256: receiptSha256,
    broker_terminal_receipt_json: stableStringify(body),
    broker_terminal_receipt_signature: verified.signature_base64,
    termination_actor_id: actorId,
    terminate_operation_id: learningExternalSessionTerminationOperationId({
      tenantId: body.tenant_id,
      receiptSha256,
    }),
    terminated_at: body.terminated_at,
    termination_sha256: "0".repeat(64),
  } satisfies LiteLearningAuthorityRow;
  const row = {
    ...base,
    termination_sha256: learningExternalSessionTerminationRowDigest(base),
  } satisfies LiteLearningAuthorityRow;
  LearningExternalSessionTerminationRowV1Schema.parse(row);
  return { row, receiptSha256, actorId };
}

type ExternalTicketConsumptionMutationInput = Readonly<{
  consumption: LiteLearningAuthorityRow;
  runnerTicket: Uint8Array;
  authorization: LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1;
}>;

function consumeExternalTicketMutation(args: {
  db: SqliteDatabase;
  input: ExternalTicketConsumptionMutationInput;
  allowClosedRevision: boolean;
}): { consumption: Record<string, unknown>; replayed: false } {
  const { db, input } = args;
  assertRunnerTicket(input.runnerTicket);
  assertExactColumns(
    "lite_learning_external_ticket_consumptions",
    input.consumption,
    EXTERNAL_CONSUMPTION_COLUMNS,
  );
  const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
    ["tenant_id", input.consumption.tenant_id],
    ["reservation_id", input.consumption.reservation_id],
  ]);
  if (!reservation) throw new Error("external ticket consumption reservation is unresolved");
  const closure = reservationExperimentClosure(db, reservation);
  if (closure && !args.allowClosedRevision) {
    throw new Error("closed external reservation requires atomic close-reserved-run");
  }
  const authority = assertReservationRevisionBindings(db, reservation, { fresh: false });
  assertReservationJsonAndDigest(reservation);
  const runnerTicketSha256 = sha256Bytes(input.runnerTicket);
  if (runnerTicketSha256 !== reservation.runner_ticket_sha256
    || input.consumption.runner_ticket_sha256 !== reservation.runner_ticket_sha256
    || input.consumption.runner_principal_sha256 !== reservation.expected_runner_principal_sha256) {
    throw new Error("external ticket consumption reservation or raw ticket mismatch");
  }
  if (learningExternalTicketConsumptionDigest(input.consumption)
    !== input.consumption.consumption_sha256) {
    throw new Error("external ticket consumption record digest mismatch");
  }
  CanonicalUtcMillisSchema.parse(input.consumption.consumed_at);
  if (String(input.consumption.consumed_at) < String(reservation.reserved_at)) {
    throw new Error("external ticket consumption precedes its reservation");
  }
  const brokerAuthorization = verifyConsumptionAuthorization({
    authority,
    reservation,
    consumption: input.consumption,
    runnerTicketSha256,
    authorization: input.authorization,
    fresh: false,
  });
  const operationId = requiredString(input.consumption, "consume_operation_id");
  const requestSha256 = authorizedOperationRequestDigest({
    contractVersion: "aionis_learning_external_ticket_consumption_request_v1",
    authorization: brokerAuthorization.authorization,
    authorityRequestSha256: brokerAuthorization.authorityRequestSha256,
  });
  const expectedReceipt = {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1" as const,
    tenant_id: requiredString(input.consumption, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_ticket_consumption_v1" as const,
    operation_id: operationId,
    actor_id: brokerAuthorization.actorId,
    authority_table: "lite_learning_external_ticket_consumptions" as const,
    authority_ref_id: requiredString(input.consumption, "consumption_id"),
    authority_record_sha256: requiredString(input.consumption, "consumption_sha256"),
    broker_authorization_receipt_sha256: brokerAuthorization.authorizationSha256,
    broker_authorization_receipt: brokerAuthorization.authorization,
    recorded_at: requiredString(input.consumption, "consumed_at"),
  };
  if (operationRow(db, {
    tenantId: expectedReceipt.tenant_id,
    operationKind: expectedReceipt.operation_kind,
    operationId,
  })) {
    throw new Error("external ticket consumption raw-ticket replay is forbidden");
  }
  assertAuthorizationTimes({
    authorizedAt: brokerAuthorization.authorization.body.authorized_at,
    expiresAt: brokerAuthorization.authorization.body.authorization_expires_at,
    recordedAt: requiredString(input.consumption, "consumed_at"),
    fresh: true,
  });
  return withSavepoint(db, () => {
    const inserted = insertExactRow(
      db,
      "lite_learning_external_ticket_consumptions",
      EXTERNAL_CONSUMPTION_COLUMNS,
      ["tenant_id", "consumption_id"],
      input.consumption,
    );
    if (inserted.replayed) {
      throw new Error("external ticket consumption exists without its protected operation receipt");
    }
    insertOperationReceipt(db, { ...expectedReceipt, request_sha256: requestSha256 });
    return { consumption: inserted.row, replayed: false as const };
  });
}

function recordExternalPreclaimHoldMutation(args: {
  db: SqliteDatabase;
  receipt: LearningExternalPreclaimHoldReceiptEnvelopeV1;
  requiredTriggeringTerminalFactSha256: string | null;
}): { hold: Record<string, unknown>; replayed: boolean } {
  const built = preclaimHoldRow(args.db, args.receipt);
  const operatorAbort = built.row.hold_reason === "operator_abort";
  if (args.requiredTriggeringTerminalFactSha256 === null) {
    if (operatorAbort) {
      throw new Error("operator-abort hold requires atomic close-reserved-run");
    }
  } else if (!operatorAbort
    || built.row.triggering_terminal_fact_sha256 !== args.requiredTriggeringTerminalFactSha256) {
    throw new Error("external close-reserved-run hold does not bind the triggering terminal fact");
  }
  const operationId = requiredString(built.row, "hold_operation_id");
  const requestSha256 = signedRequestDigest(
    "aionis_learning_external_preclaim_hold_request_v1",
    args.receipt,
  );
  const result = protectedRowResult({
    db: args.db,
    table: "lite_learning_external_preclaim_holds",
    columns: EXTERNAL_PRECLAIM_HOLD_COLUMNS,
    replayKeys: ["tenant_id", "hold_id"],
    row: built.row,
    receipt: {
      contract_version: "aionis_learning_external_authority_operation_receipt_v1",
      tenant_id: requiredString(built.row, "tenant_id"),
      scope: EXTERNAL_AUTHORITY_SCOPE,
      operation_kind: "learning_external_preclaim_hold_v1",
      operation_id: operationId,
      actor_id: built.actorId,
      request_sha256: requestSha256,
      authority_table: "lite_learning_external_preclaim_holds",
      authority_ref_id: requiredString(built.row, "hold_id"),
      authority_record_sha256: requiredString(built.row, "hold_sha256"),
      broker_authorization_receipt_sha256: null,
      broker_authorization_receipt: null,
      recorded_at: requiredString(built.row, "held_at"),
    },
  });
  return { hold: result.row, replayed: result.replayed };
}

export type LiteLearningExternalAuthorityAccess = Readonly<{
  reserveExternalRun(args: {
    reservation: LiteLearningAuthorityRow;
    holdoutMembers?: readonly LiteLearningAuthorityRow[];
    runnerTicket: Uint8Array;
    authorization: LearningExternalRunReservationAuthorizationReceiptEnvelopeV1;
  }): Promise<{ reservation: Record<string, unknown>; replayed: boolean }>;
  consumeExternalTicket(args: {
    consumption: LiteLearningAuthorityRow;
    runnerTicket: Uint8Array;
    authorization: LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1;
  }): Promise<{ consumption: Record<string, unknown>; replayed: boolean }>;
  closeReservedExternalRun(args: {
    consumption: LiteLearningAuthorityRow;
    runnerTicket: Uint8Array;
    consumptionAuthorization: LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1;
    holdReceipt: LearningExternalPreclaimHoldReceiptEnvelopeV1;
    triggeringTerminalFactSha256: string;
  }): Promise<{
    consumption: Record<string, unknown>;
    hold: Record<string, unknown>;
    replayed: false;
  }>;
  recordExternalPreclaimHold(args: {
    receipt: LearningExternalPreclaimHoldReceiptEnvelopeV1;
  }): Promise<{ hold: Record<string, unknown>; replayed: boolean }>;
  claimExternalRun(args: {
    receipt: LearningExternalClaimReceiptEnvelopeV1;
  }): Promise<{ claim: Record<string, unknown>; replayed: boolean }>;
  bindExternalSupervisor(args: {
    receipt: LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1;
  }): Promise<{ binding: Record<string, unknown>; replayed: boolean }>;
  terminateExternalSession(args: {
    receipt: LearningExternalSessionTerminationReceiptEnvelopeV1;
  }): Promise<{ termination: Record<string, unknown>; replayed: boolean }>;
}>;

export function createLiteLearningExternalAuthorityAccess(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
}): LiteLearningExternalAuthorityAccess {
  const { db, transaction } = args;
  return {
    async reserveExternalRun(input) {
      assertStoreTransaction(transaction);
      assertRunnerTicket(input.runnerTicket);
      assertExactColumns(
        "lite_learning_external_run_reservations",
        input.reservation,
        EXTERNAL_RESERVATION_COLUMNS,
      );
      const authority = assertReservationRevisionBindings(db, input.reservation, { fresh: false });
      assertReservationJsonAndDigest(input.reservation);
      const members = input.holdoutMembers ?? [];
      assertHoldoutMembers(input.reservation, members);
      const runnerTicketSha256 = sha256Bytes(input.runnerTicket);
      if (runnerTicketSha256 !== input.reservation.runner_ticket_sha256) {
        throw new Error("external reservation raw runner ticket digest mismatch");
      }
      const brokerAuthorization = verifyReservationAuthorization({
        authority,
        reservation: input.reservation,
        members,
        runnerTicketSha256,
        authorization: input.authorization,
        fresh: false,
      });
      const operationId = requiredString(input.reservation, "reserve_operation_id");
      const requestSha256 = authorizedOperationRequestDigest({
        contractVersion: "aionis_learning_external_reservation_request_v1",
        authorization: brokerAuthorization.authorization,
        authorityRequestSha256: brokerAuthorization.authorityRequestSha256,
      });
      const expectedReceipt = {
        contract_version: "aionis_learning_external_authority_operation_receipt_v1" as const,
        tenant_id: requiredString(input.reservation, "tenant_id"),
        scope: EXTERNAL_AUTHORITY_SCOPE,
        operation_kind: "learning_external_run_reservation_v1" as const,
        operation_id: operationId,
        actor_id: brokerAuthorization.actorId,
        authority_table: "lite_learning_external_run_reservations" as const,
        authority_ref_id: requiredString(input.reservation, "reservation_id"),
        authority_record_sha256: requiredString(input.reservation, "reservation_sha256"),
        broker_authorization_receipt_sha256: brokerAuthorization.authorizationSha256,
        broker_authorization_receipt: brokerAuthorization.authorization,
        recorded_at: requiredString(input.reservation, "reserved_at"),
      };
      const existingOperation = operationRow(db, {
        tenantId: expectedReceipt.tenant_id,
        operationKind: expectedReceipt.operation_kind,
        operationId,
      });
      if (existingOperation) {
        assertOperationReplay({ operation: existingOperation, requestSha256, expectedReceipt });
        const existing = selectExactRow(db, "lite_learning_external_run_reservations", [
          "tenant_id", "reservation_id",
        ], input.reservation);
        if (!existing) throw new Error("external reservation replay row is missing");
        assertExactReplay("lite_learning_external_run_reservations", existing, input.reservation);
        const persistedMembers = db.prepare(
          `SELECT ${EXTERNAL_HOLDOUT_MEMBER_COLUMNS.join(", ")}
           FROM lite_learning_external_holdout_members
           WHERE tenant_id = ? AND reservation_id = ?
           ORDER BY case_ordinal`,
        ).all(input.reservation.tenant_id, input.reservation.reservation_id) as LiteLearningAuthorityRow[];
        assertHoldoutMembers(input.reservation, persistedMembers);
        if (persistedMembers.length !== members.length) {
          throw new Error("external reservation replay holdout member count mismatch");
        }
        for (const member of members) {
          const persisted = selectExactRow(db, "lite_learning_external_holdout_members", [
            "tenant_id", "reservation_id", "case_ordinal",
          ], member);
          if (!persisted) throw new Error("external reservation replay holdout member is missing");
          assertExactReplay("lite_learning_external_holdout_members", persisted, member);
        }
        return { reservation: existing, replayed: true };
      }
      assertRevisionOpenForReservation(db, input.reservation);
      assertAuthorizationTimes({
        authorizedAt: brokerAuthorization.authorization.body.authorized_at,
        expiresAt: brokerAuthorization.authorization.body.authorization_expires_at,
        recordedAt: requiredString(input.reservation, "reserved_at"),
        fresh: true,
      });
      return withSavepoint(db, () => {
        const inserted = insertExactRow(
          db,
          "lite_learning_external_run_reservations",
          EXTERNAL_RESERVATION_COLUMNS,
          ["tenant_id", "reservation_id"],
          input.reservation,
        );
        if (inserted.replayed) {
          throw new Error("external reservation row exists without its protected operation receipt");
        }
        for (const member of members) {
          insertExactRow(
            db,
            "lite_learning_external_holdout_members",
            EXTERNAL_HOLDOUT_MEMBER_COLUMNS,
            ["tenant_id", "reservation_id", "case_ordinal"],
            member,
          );
        }
        insertOperationReceipt(db, { ...expectedReceipt, request_sha256: requestSha256 });
        return { reservation: inserted.row, replayed: false };
      });
    },

    async consumeExternalTicket(input) {
      assertStoreTransaction(transaction);
      return consumeExternalTicketMutation({ db, input, allowClosedRevision: false });
    },

    async closeReservedExternalRun(input) {
      assertStoreTransaction(transaction);
      const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
        ["tenant_id", input.consumption.tenant_id],
        ["reservation_id", input.consumption.reservation_id],
      ]);
      if (!reservation) throw new Error("external close-reserved-run reservation is unresolved");
      const triggeringFact = resolveTriggeringExternalTerminalFact({
        db,
        reservation,
        triggeringTerminalFactSha256: input.triggeringTerminalFactSha256,
      });
      const consumedAt = requiredString(input.consumption, "consumed_at");
      if (input.holdReceipt.body.tenant_id !== input.consumption.tenant_id
        || input.holdReceipt.body.reservation_id !== input.consumption.reservation_id
        || input.holdReceipt.body.ticket_consumption_id !== input.consumption.consumption_id
        || input.holdReceipt.body.ticket_consumption_sha256 !== input.consumption.consumption_sha256
        || input.holdReceipt.body.held_at < consumedAt
        || consumedAt < triggeringFact.recorded_at) {
        throw new Error("external close-reserved-run chain or time mismatch");
      }
      return withSavepoint(db, () => {
        const consumption = consumeExternalTicketMutation({
          db,
          input: {
            consumption: input.consumption,
            runnerTicket: input.runnerTicket,
            authorization: input.consumptionAuthorization,
          },
          allowClosedRevision: true,
        });
        const hold = recordExternalPreclaimHoldMutation({
          db,
          receipt: input.holdReceipt,
          requiredTriggeringTerminalFactSha256: input.triggeringTerminalFactSha256,
        });
        if (hold.replayed) {
          throw new Error("external close-reserved-run hold unexpectedly replayed");
        }
        return {
          consumption: consumption.consumption,
          hold: hold.hold,
          replayed: false as const,
        };
      });
    },

    async recordExternalPreclaimHold(input) {
      assertStoreTransaction(transaction);
      return recordExternalPreclaimHoldMutation({
        db,
        receipt: input.receipt,
        requiredTriggeringTerminalFactSha256: null,
      });
    },

    async claimExternalRun(input) {
      assertStoreTransaction(transaction);
      const built = claimRow(db, input.receipt);
      const operationId = requiredString(built.row, "claim_operation_id");
      const requestSha256 = signedRequestDigest(
        "aionis_learning_external_claim_request_v1",
        input.receipt,
      );
      if (!operationRow(db, {
        tenantId: requiredString(built.row, "tenant_id"),
        operationKind: "learning_external_run_claim_v1",
        operationId,
      })) {
        const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
          ["tenant_id", built.row.tenant_id],
          ["reservation_id", built.row.reservation_id],
        ]);
        if (!reservation) throw new Error("external claim reservation is unresolved");
        assertRevisionOpenForReservation(db, reservation);
        assertFreshSignedOperationWindow({
          recordedAt: requiredString(built.row, "claimed_at"),
          expiresAt: requiredString(built.row, "supervisor_bind_expires_at"),
          label: "external claim receipt",
        });
      }
      const result = protectedRowResult({
        db,
        table: "lite_learning_external_run_claims",
        columns: EXTERNAL_CLAIM_COLUMNS,
        replayKeys: ["tenant_id", "claim_id"],
        row: built.row,
        receipt: {
          contract_version: "aionis_learning_external_authority_operation_receipt_v1",
          tenant_id: requiredString(built.row, "tenant_id"),
          scope: EXTERNAL_AUTHORITY_SCOPE,
          operation_kind: "learning_external_run_claim_v1",
          operation_id: operationId,
          actor_id: built.actorId,
          request_sha256: requestSha256,
          authority_table: "lite_learning_external_run_claims",
          authority_ref_id: requiredString(built.row, "claim_id"),
          authority_record_sha256: requiredString(built.row, "claim_sha256"),
          broker_authorization_receipt_sha256: null,
          broker_authorization_receipt: null,
          recorded_at: requiredString(built.row, "claimed_at"),
        },
      });
      return { claim: result.row, replayed: result.replayed };
    },

    async bindExternalSupervisor(input) {
      assertStoreTransaction(transaction);
      const built = bindingRow(db, input.receipt);
      const operationId = requiredString(built.row, "bind_operation_id");
      const requestSha256 = signedRequestDigest(
        "aionis_learning_external_supervisor_binding_request_v1",
        input.receipt,
      );
      if (!operationRow(db, {
        tenantId: requiredString(built.row, "tenant_id"),
        operationKind: "learning_external_supervisor_binding_v1",
        operationId,
      })) {
        const claim = selectAuthorityRow(db, "lite_learning_external_run_claims", [
          ["tenant_id", built.row.tenant_id],
          ["claim_id", built.row.claim_id],
        ]);
        if (!claim) throw new Error("external binding claim is unresolved");
        const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
          ["tenant_id", built.row.tenant_id],
          ["reservation_id", built.row.reservation_id],
        ]);
        if (!reservation) throw new Error("external binding reservation is unresolved");
        const closure = reservationExperimentClosure(db, reservation);
        if (closure && (String(built.row.bound_at) > closure.created_at
          || String(claim.claimed_at) > closure.created_at)) {
          throw new Error("external supervisor binding was not authorized before experiment closure");
        }
        assertFreshSignedOperationWindow({
          recordedAt: requiredString(built.row, "bound_at"),
          expiresAt: requiredString(claim, "supervisor_bind_expires_at"),
          label: "external supervisor binding receipt",
        });
        if (db.prepare(
          `SELECT 1 FROM lite_learning_external_session_terminations
           WHERE tenant_id = ? AND claim_id = ? LIMIT 1`,
        ).get(built.row.tenant_id, built.row.claim_id)) {
          throw new Error("external supervisor binding cannot follow session termination");
        }
      }
      const result = protectedRowResult({
        db,
        table: "lite_learning_external_supervisor_bindings",
        columns: EXTERNAL_BINDING_COLUMNS,
        replayKeys: ["tenant_id", "binding_id"],
        row: built.row,
        receipt: {
          contract_version: "aionis_learning_external_authority_operation_receipt_v1",
          tenant_id: requiredString(built.row, "tenant_id"),
          scope: EXTERNAL_AUTHORITY_SCOPE,
          operation_kind: "learning_external_supervisor_binding_v1",
          operation_id: operationId,
          actor_id: built.actorId,
          request_sha256: requestSha256,
          authority_table: "lite_learning_external_supervisor_bindings",
          authority_ref_id: requiredString(built.row, "binding_id"),
          authority_record_sha256: requiredString(built.row, "binding_sha256"),
          broker_authorization_receipt_sha256: null,
          broker_authorization_receipt: null,
          recorded_at: requiredString(built.row, "bound_at"),
        },
      });
      return { binding: result.row, replayed: result.replayed };
    },

    async terminateExternalSession(input) {
      assertStoreTransaction(transaction);
      const built = terminationRow(db, input.receipt);
      const operationId = requiredString(built.row, "terminate_operation_id");
      const requestSha256 = signedRequestDigest(
        "aionis_learning_external_session_termination_request_v1",
        input.receipt,
      );
      const result = protectedRowResult({
        db,
        table: "lite_learning_external_session_terminations",
        columns: EXTERNAL_TERMINATION_COLUMNS,
        replayKeys: ["tenant_id", "termination_id"],
        row: built.row,
        receipt: {
          contract_version: "aionis_learning_external_authority_operation_receipt_v1",
          tenant_id: requiredString(built.row, "tenant_id"),
          scope: EXTERNAL_AUTHORITY_SCOPE,
          operation_kind: "learning_external_session_termination_v1",
          operation_id: operationId,
          actor_id: built.actorId,
          request_sha256: requestSha256,
          authority_table: "lite_learning_external_session_terminations",
          authority_ref_id: requiredString(built.row, "termination_id"),
          authority_record_sha256: requiredString(built.row, "termination_sha256"),
          broker_authorization_receipt_sha256: null,
          broker_authorization_receipt: null,
          recorded_at: requiredString(built.row, "terminated_at"),
        },
      });
      return { termination: result.row, replayed: result.replayed };
    },
  };
}

function assertCommittedOperationReceipt(
  db: SqliteDatabase,
  receipt: LiteLearningExternalAuthorityOperationReceiptV1,
): void {
  const operation = operationRow(db, {
    tenantId: receipt.tenant_id,
    operationKind: receipt.operation_kind,
    operationId: receipt.operation_id,
  });
  if (!operation) throw new Error("external authority protected operation receipt is missing");
  const { request_sha256: requestSha256, ...expectedReceipt } = receipt;
  assertOperationReplay({ operation, requestSha256, expectedReceipt });
}

function reservationOperationReceipt(
  db: SqliteDatabase,
  reservation: LiteLearningAuthorityRow,
  members: readonly LiteLearningAuthorityRow[],
): LiteLearningExternalAuthorityOperationReceiptV1 {
  const operationId = requiredString(reservation, "reserve_operation_id");
  const operation = operationRow(db, {
    tenantId: requiredString(reservation, "tenant_id"),
    operationKind: "learning_external_run_reservation_v1",
    operationId,
  });
  if (!operation) throw new Error("external reservation protected operation receipt is missing");
  const stored = parseOperationReceipt(operation.receipt_json);
  const authorization = LearningExternalRunReservationAuthorizationReceiptEnvelopeV1Schema.parse(
    stored.broker_authorization_receipt,
  );
  const verified = verifyReservationAuthorization({
    authority: resolveRevisionAuthority(db, reservation),
    reservation,
    members,
    runnerTicketSha256: requiredString(reservation, "runner_ticket_sha256"),
    authorization,
    fresh: false,
  });
  const requestSha256 = authorizedOperationRequestDigest({
    contractVersion: "aionis_learning_external_reservation_request_v1",
    authorization: verified.authorization,
    authorityRequestSha256: verified.authorityRequestSha256,
  });
  const receipt: LiteLearningExternalAuthorityOperationReceiptV1 = {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: requiredString(reservation, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_run_reservation_v1",
    operation_id: operationId,
    actor_id: verified.actorId,
    request_sha256: requestSha256,
    authority_table: "lite_learning_external_run_reservations",
    authority_ref_id: requiredString(reservation, "reservation_id"),
    authority_record_sha256: requiredString(reservation, "reservation_sha256"),
    broker_authorization_receipt_sha256: verified.authorizationSha256,
    broker_authorization_receipt: verified.authorization,
    recorded_at: requiredString(reservation, "reserved_at"),
  };
  assertCommittedOperationReceipt(db, receipt);
  return receipt;
}

function consumptionOperationReceipt(
  db: SqliteDatabase,
  consumption: LiteLearningAuthorityRow,
): LiteLearningExternalAuthorityOperationReceiptV1 {
  const operationId = requiredString(consumption, "consume_operation_id");
  const operation = operationRow(db, {
    tenantId: requiredString(consumption, "tenant_id"),
    operationKind: "learning_external_ticket_consumption_v1",
    operationId,
  });
  if (!operation) throw new Error("external consumption protected operation receipt is missing");
  const stored = parseOperationReceipt(operation.receipt_json);
  const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
    ["tenant_id", consumption.tenant_id],
    ["reservation_id", consumption.reservation_id],
  ]);
  if (!reservation) throw new Error("external consumption reservation is unresolved");
  const authorization = LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1Schema.parse(
    stored.broker_authorization_receipt,
  );
  const verified = verifyConsumptionAuthorization({
    authority: resolveRevisionAuthority(db, reservation),
    reservation,
    consumption,
    runnerTicketSha256: requiredString(consumption, "runner_ticket_sha256"),
    authorization,
    fresh: false,
  });
  const requestSha256 = authorizedOperationRequestDigest({
    contractVersion: "aionis_learning_external_ticket_consumption_request_v1",
    authorization: verified.authorization,
    authorityRequestSha256: verified.authorityRequestSha256,
  });
  const receipt: LiteLearningExternalAuthorityOperationReceiptV1 = {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: requiredString(consumption, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_ticket_consumption_v1",
    operation_id: operationId,
    actor_id: verified.actorId,
    request_sha256: requestSha256,
    authority_table: "lite_learning_external_ticket_consumptions",
    authority_ref_id: requiredString(consumption, "consumption_id"),
    authority_record_sha256: requiredString(consumption, "consumption_sha256"),
    broker_authorization_receipt_sha256: verified.authorizationSha256,
    broker_authorization_receipt: verified.authorization,
    recorded_at: requiredString(consumption, "consumed_at"),
  };
  assertCommittedOperationReceipt(db, receipt);
  return receipt;
}

function preclaimEnvelopeFromRow(row: LiteLearningAuthorityRow): LearningExternalPreclaimHoldReceiptEnvelopeV1 {
  return {
    body: LearningExternalPreclaimHoldReceiptBodyV1Schema.parse(canonicalJson(
      row.broker_preclaim_hold_receipt_json,
      "broker pre-claim hold receipt",
    )),
    signature_algorithm: "ed25519-v1",
    signature_base64: requiredString(row, "broker_preclaim_hold_receipt_signature"),
  };
}

function claimEnvelopeFromRow(row: LiteLearningAuthorityRow): LearningExternalClaimReceiptEnvelopeV1 {
  return {
    body: LearningExternalClaimReceiptBodyV1Schema.parse(canonicalJson(
      row.credential_broker_receipt_json,
      "credential broker claim receipt",
    )),
    signature_algorithm: "ed25519-v1",
    signature_base64: requiredString(row, "credential_broker_receipt_signature"),
  };
}

function bindingEnvelopeFromRow(
  row: LiteLearningAuthorityRow,
): LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1 {
  return {
    body: LearningExternalBrokerSupervisorBindingReceiptBodyV1Schema.parse(canonicalJson(
      row.broker_binding_receipt_json,
      "broker supervisor binding receipt",
    )),
    signature_algorithm: "ed25519-v1",
    signature_base64: requiredString(row, "broker_binding_receipt_signature"),
  };
}

function terminationEnvelopeFromRow(
  row: LiteLearningAuthorityRow,
): LearningExternalSessionTerminationReceiptEnvelopeV1 {
  return {
    body: LearningExternalSessionTerminationReceiptBodyV1Schema.parse(canonicalJson(
      row.broker_terminal_receipt_json,
      "broker terminal receipt",
    )),
    signature_algorithm: "ed25519-v1",
    signature_base64: requiredString(row, "broker_terminal_receipt_signature"),
  };
}

function assertProtectedPreclaimHoldAuthorityRow(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
): void {
  LearningExternalPreclaimHoldRowV1Schema.parse(row);
  const envelope = preclaimEnvelopeFromRow(row);
  const rebuilt = preclaimHoldRow(db, envelope);
  assertExactReplay("lite_learning_external_preclaim_holds", row, rebuilt.row);
  assertCommittedOperationReceipt(db, {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: requiredString(row, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_preclaim_hold_v1",
    operation_id: requiredString(row, "hold_operation_id"),
    actor_id: rebuilt.actorId,
    request_sha256: signedRequestDigest(
      "aionis_learning_external_preclaim_hold_request_v1",
      envelope,
    ),
    authority_table: "lite_learning_external_preclaim_holds",
    authority_ref_id: requiredString(row, "hold_id"),
    authority_record_sha256: requiredString(row, "hold_sha256"),
    broker_authorization_receipt_sha256: null,
    broker_authorization_receipt: null,
    recorded_at: requiredString(row, "held_at"),
  });
}

function assertProtectedTerminationAuthorityRow(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
): LiteLearningExternalAuthorityOperationReceiptV1 {
  LearningExternalSessionTerminationRowV1Schema.parse(row);
  const envelope = terminationEnvelopeFromRow(row);
  const rebuilt = terminationRow(db, envelope);
  assertExactReplay("lite_learning_external_session_terminations", row, rebuilt.row);
  const receipt: LiteLearningExternalAuthorityOperationReceiptV1 = {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: requiredString(row, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_session_termination_v1",
    operation_id: requiredString(row, "terminate_operation_id"),
    actor_id: rebuilt.actorId,
    request_sha256: signedRequestDigest(
      "aionis_learning_external_session_termination_request_v1",
      envelope,
    ),
    authority_table: "lite_learning_external_session_terminations",
    authority_ref_id: requiredString(row, "termination_id"),
    authority_record_sha256: requiredString(row, "termination_sha256"),
    broker_authorization_receipt_sha256: null,
    broker_authorization_receipt: null,
    recorded_at: requiredString(row, "terminated_at"),
  };
  assertCommittedOperationReceipt(db, receipt);
  return receipt;
}

function claimOperationReceipt(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
): LiteLearningExternalAuthorityOperationReceiptV1 {
  LearningExternalRunClaimRowV1Schema.parse(row);
  const envelope = claimEnvelopeFromRow(row);
  const rebuilt = claimRow(db, envelope);
  assertExactReplay("lite_learning_external_run_claims", row, rebuilt.row);
  const receipt: LiteLearningExternalAuthorityOperationReceiptV1 = {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: requiredString(row, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_run_claim_v1",
    operation_id: requiredString(row, "claim_operation_id"),
    actor_id: rebuilt.actorId,
    request_sha256: signedRequestDigest(
      "aionis_learning_external_claim_request_v1",
      envelope,
    ),
    authority_table: "lite_learning_external_run_claims",
    authority_ref_id: requiredString(row, "claim_id"),
    authority_record_sha256: requiredString(row, "claim_sha256"),
    broker_authorization_receipt_sha256: null,
    broker_authorization_receipt: null,
    recorded_at: requiredString(row, "claimed_at"),
  };
  assertCommittedOperationReceipt(db, receipt);
  return receipt;
}

function bindingOperationReceipt(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
): LiteLearningExternalAuthorityOperationReceiptV1 {
  LearningExternalSupervisorBindingRowV1Schema.parse(row);
  const envelope = bindingEnvelopeFromRow(row);
  const rebuilt = bindingRow(db, envelope);
  assertExactReplay("lite_learning_external_supervisor_bindings", row, rebuilt.row);
  const receipt: LiteLearningExternalAuthorityOperationReceiptV1 = {
    contract_version: "aionis_learning_external_authority_operation_receipt_v1",
    tenant_id: requiredString(row, "tenant_id"),
    scope: EXTERNAL_AUTHORITY_SCOPE,
    operation_kind: "learning_external_supervisor_binding_v1",
    operation_id: requiredString(row, "bind_operation_id"),
    actor_id: rebuilt.actorId,
    request_sha256: signedRequestDigest(
      "aionis_learning_external_supervisor_binding_request_v1",
      envelope,
    ),
    authority_table: "lite_learning_external_supervisor_bindings",
    authority_ref_id: requiredString(row, "binding_id"),
    authority_record_sha256: requiredString(row, "binding_sha256"),
    broker_authorization_receipt_sha256: null,
    broker_authorization_receipt: null,
    recorded_at: requiredString(row, "bound_at"),
  };
  assertCommittedOperationReceipt(db, receipt);
  return receipt;
}

export type LiteLearningExternalNormalLifecycleSnapshot = Readonly<{
  tenantId: string;
  databaseInstanceId: string;
  roleName: ExternalRoleName;
  frozenRole: ExternalExecutionPolicyV1["roles"][ExternalRoleName];
  frozenRuntimeAuthorityAttestor: ExternalExecutionPolicyV1["runtime_authority_attestor"];
  experimentRevision: LiteLearningAuthorityRow;
  reservation: LiteLearningAuthorityRow;
  holdoutMembers: readonly LiteLearningAuthorityRow[];
  consumption: LiteLearningAuthorityRow;
  claim: LiteLearningAuthorityRow;
  binding: LiteLearningAuthorityRow;
  termination: LiteLearningAuthorityRow;
  operations: Readonly<{
    reservation: LiteLearningExternalAuthorityOperationReceiptV1;
    consumption: LiteLearningExternalAuthorityOperationReceiptV1;
    claim: LiteLearningExternalAuthorityOperationReceiptV1;
    binding: LiteLearningExternalAuthorityOperationReceiptV1;
    termination: LiteLearningExternalAuthorityOperationReceiptV1;
  }>;
  lifecycleAuthorityProjection: LearningExternalLifecycleAuthorityProjectionV1;
}>;

function requiredLifecycleRowByReservation(
  db: SqliteDatabase,
  table: "lite_learning_external_ticket_consumptions"
    | "lite_learning_external_run_claims"
    | "lite_learning_external_supervisor_bindings"
    | "lite_learning_external_session_terminations",
  tenantId: string,
  reservationId: string,
): LiteLearningAuthorityRow {
  const columns = {
    lite_learning_external_ticket_consumptions: EXTERNAL_CONSUMPTION_COLUMNS,
    lite_learning_external_run_claims: EXTERNAL_CLAIM_COLUMNS,
    lite_learning_external_supervisor_bindings: EXTERNAL_BINDING_COLUMNS,
    lite_learning_external_session_terminations: EXTERNAL_TERMINATION_COLUMNS,
  }[table];
  const rows = db.prepare(
    `SELECT ${columns.join(", ")} FROM ${table}
     WHERE tenant_id = ? AND reservation_id = ? LIMIT 2`,
  ).all(tenantId, reservationId) as LiteLearningAuthorityRow[];
  if (rows.length !== 1) {
    throw new Error(`external normal lifecycle requires exactly one ${table} row`);
  }
  return rows[0]!;
}

function lifecycleOperationProjection(
  receipt: LiteLearningExternalAuthorityOperationReceiptV1,
): Readonly<{
  scope: "learning_external_authority_v1";
  operation_kind: LiteLearningExternalAuthorityOperationReceiptV1["operation_kind"];
  operation_id: string;
  operation_request_sha256: string;
  authority_record_sha256: string;
}> {
  return {
    scope: receipt.scope,
    operation_kind: receipt.operation_kind,
    operation_id: receipt.operation_id,
    operation_request_sha256: receipt.request_sha256,
    authority_record_sha256: receipt.authority_record_sha256,
  };
}

/**
 * Resolve one completed external evidence lifecycle through the exact validators
 * used by the protected mutation and whole-ledger reopen paths. This deliberately
 * performs no independent signature verification: every returned row and receipt
 * has already passed the existing frozen revision/key/lineage checks above.
 */
export function resolveLiteLearningExternalNormalLifecycleSnapshot(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    reservationId: string;
    evidenceBindingSha256: string;
  }>,
): LiteLearningExternalNormalLifecycleSnapshot {
  BoundedIdSchema.parse(args.tenantId);
  BoundedIdSchema.parse(args.reservationId);
  DigestSha256Schema.parse(args.evidenceBindingSha256);

  const reservation = selectAuthorityRow(db, "lite_learning_external_run_reservations", [
    ["tenant_id", args.tenantId],
    ["reservation_id", args.reservationId],
  ]);
  if (!reservation) throw new Error("external normal lifecycle reservation is unresolved");
  const authority = assertReservationRevisionBindings(db, reservation, { fresh: false });
  assertReservationJsonAndDigest(reservation);

  const holdoutMembers = db.prepare(
    `SELECT ${EXTERNAL_HOLDOUT_MEMBER_COLUMNS.join(", ")}
     FROM lite_learning_external_holdout_members
     WHERE tenant_id = ? AND reservation_id = ?
     ORDER BY case_ordinal`,
  ).all(args.tenantId, args.reservationId) as LiteLearningAuthorityRow[];
  assertHoldoutMembers(reservation, holdoutMembers);

  const unexpectedHold = db.prepare(
    `SELECT hold_id FROM lite_learning_external_preclaim_holds
     WHERE tenant_id = ? AND reservation_id = ? LIMIT 1`,
  ).get(args.tenantId, args.reservationId);
  if (unexpectedHold) {
    throw new Error("external evidence requires a normal lifecycle without a pre-claim hold");
  }

  const consumption = requiredLifecycleRowByReservation(
    db,
    "lite_learning_external_ticket_consumptions",
    args.tenantId,
    args.reservationId,
  );
  const claim = requiredLifecycleRowByReservation(
    db,
    "lite_learning_external_run_claims",
    args.tenantId,
    args.reservationId,
  );
  const binding = requiredLifecycleRowByReservation(
    db,
    "lite_learning_external_supervisor_bindings",
    args.tenantId,
    args.reservationId,
  );
  const termination = requiredLifecycleRowByReservation(
    db,
    "lite_learning_external_session_terminations",
    args.tenantId,
    args.reservationId,
  );
  if (termination.termination_reason !== "passed"
    && termination.termination_reason !== "failed"
    && termination.termination_reason !== "inconclusive") {
    throw new Error("external evidence requires a normal terminal status");
  }
  if (consumption.consumption_id !== claim.ticket_consumption_id
    || claim.claim_id !== binding.claim_id
    || binding.binding_id !== termination.supervisor_binding_id
    || consumption.consumption_id !== termination.ticket_consumption_id
    || claim.claim_id !== termination.claim_id) {
    throw new Error("external normal lifecycle row chain is inconsistent");
  }

  const operations = {
    reservation: reservationOperationReceipt(db, reservation, holdoutMembers),
    consumption: consumptionOperationReceipt(db, consumption),
    claim: claimOperationReceipt(db, claim),
    binding: bindingOperationReceipt(db, binding),
    termination: assertProtectedTerminationAuthorityRow(db, termination),
  } as const;

  const lifecycleAuthorityProjection = LearningExternalLifecycleAuthorityProjectionV1Schema.parse({
    contract_version: "aionis_learning_external_lifecycle_authority_projection_v1",
    evidence_binding_sha256: args.evidenceBindingSha256,
    artifact_kind: requiredString(reservation, "artifact_kind"),
    tenant_id: args.tenantId,
    database_instance_id: authority.databaseInstanceId,
    reservation: {
      authority_table: "lite_learning_external_run_reservations",
      fact_id: requiredString(reservation, "reservation_id"),
      fact_sha256: requiredString(reservation, "reservation_sha256"),
      protected_operation: lifecycleOperationProjection(operations.reservation),
    },
    ticket_consumption: {
      authority_table: "lite_learning_external_ticket_consumptions",
      fact_id: requiredString(consumption, "consumption_id"),
      fact_sha256: requiredString(consumption, "consumption_sha256"),
      protected_operation: lifecycleOperationProjection(operations.consumption),
    },
    claim: {
      authority_table: "lite_learning_external_run_claims",
      fact_id: requiredString(claim, "claim_id"),
      fact_sha256: requiredString(claim, "claim_sha256"),
      protected_operation: lifecycleOperationProjection(operations.claim),
    },
    supervisor_binding: {
      authority_table: "lite_learning_external_supervisor_bindings",
      fact_id: requiredString(binding, "binding_id"),
      fact_sha256: requiredString(binding, "binding_sha256"),
      protected_operation: lifecycleOperationProjection(operations.binding),
    },
    session_termination: {
      authority_table: "lite_learning_external_session_terminations",
      fact_id: requiredString(termination, "termination_id"),
      fact_sha256: requiredString(termination, "termination_sha256"),
      termination_reason: requiredString(termination, "termination_reason"),
      broker_terminal_receipt_sha256: requiredString(
        termination,
        "broker_terminal_receipt_sha256",
      ),
      broker_quiesce_receipt_sha256: requiredString(
        termination,
        "broker_quiesce_receipt_sha256",
      ),
      runner_output_manifest_sha256: requiredString(
        termination,
        "runner_output_manifest_sha256",
      ),
      terminal_run_manifest_sha256: requiredString(
        termination,
        "terminal_run_manifest_sha256",
      ),
      attempt_chain_sha256: requiredString(termination, "attempt_chain_sha256"),
      terminated_at: requiredString(termination, "terminated_at"),
      protected_operation: lifecycleOperationProjection(operations.termination),
    },
    service_launcher_receipt_sha256: requiredString(binding, "service_launcher_receipt_sha256"),
  });

  return {
    tenantId: args.tenantId,
    databaseInstanceId: authority.databaseInstanceId,
    roleName: authority.roleName,
    frozenRole: authority.role,
    frozenRuntimeAuthorityAttestor: authority.externalPolicy.runtime_authority_attestor,
    experimentRevision: authority.row,
    reservation,
    holdoutMembers,
    consumption,
    claim,
    binding,
    termination,
    operations,
    lifecycleAuthorityProjection,
  };
}

function assertNoOrphanExternalAuthorityOperations(db: SqliteDatabase): void {
  const operations = db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE scope = ?
     ORDER BY tenant_id, operation_kind, operation_id`,
  ).all(EXTERNAL_AUTHORITY_SCOPE) as Array<Record<string, unknown>>;
  const authorityRef = {
    lite_learning_external_run_reservations: ["reservation_id", "reservation_sha256", "reserve_operation_id"],
    lite_learning_external_ticket_consumptions: ["consumption_id", "consumption_sha256", "consume_operation_id"],
    lite_learning_external_preclaim_holds: ["hold_id", "hold_sha256", "hold_operation_id"],
    lite_learning_external_run_claims: ["claim_id", "claim_sha256", "claim_operation_id"],
    lite_learning_external_supervisor_bindings: ["binding_id", "binding_sha256", "bind_operation_id"],
    lite_learning_external_session_terminations: ["termination_id", "termination_sha256", "terminate_operation_id"],
  } as const;
  for (const operation of operations) {
    // Evidence ingestion shares this already protected scope so the generic
    // write API and append-only triggers cannot bypass it. Its richer receipt
    // is verified bidirectionally by the dedicated ingestion reopen verifier.
    if (operation.operation_kind === "learning_evidence_ingest_v1") continue;
    const receipt = parseOperationReceipt(operation.receipt_json);
    const mapping = authorityRef[receipt.authority_table];
    const row = selectAuthorityRow(db, receipt.authority_table, [
      ["tenant_id", receipt.tenant_id],
      [mapping[0], receipt.authority_ref_id],
    ]);
    if (!row
      || row[mapping[1]] !== receipt.authority_record_sha256
      || row[mapping[2]] !== receipt.operation_id
      || operation.request_sha256 !== receipt.request_sha256
      || operation.tenant_id !== receipt.tenant_id
      || operation.scope !== receipt.scope
      || operation.operation_kind !== receipt.operation_kind
      || operation.operation_id !== receipt.operation_id
      || operation.created_at !== receipt.recorded_at
      || operation.commit_id !== null) {
      throw new Error("orphan or mismatched external authority operation receipt");
    }
  }
}

export function assertLiteLearningExternalAuthorityIntegrity(db: SqliteDatabase): void {
  const reservations = db.prepare(
    `SELECT ${EXTERNAL_RESERVATION_COLUMNS.join(", ")}
     FROM lite_learning_external_run_reservations
     ORDER BY tenant_id, reservation_id`,
  ).all() as LiteLearningAuthorityRow[];
  for (const reservation of reservations) {
    assertReservationRevisionBindings(db, reservation, { fresh: false });
    assertReservationJsonAndDigest(reservation);
    const members = db.prepare(
      `SELECT ${EXTERNAL_HOLDOUT_MEMBER_COLUMNS.join(", ")}
       FROM lite_learning_external_holdout_members
       WHERE tenant_id = ? AND reservation_id = ?
       ORDER BY case_ordinal`,
    ).all(reservation.tenant_id, reservation.reservation_id) as LiteLearningAuthorityRow[];
    assertHoldoutMembers(reservation, members);
    reservationOperationReceipt(db, reservation, members);
  }
  const orphanMembers = db.prepare(
    `SELECT COUNT(*) AS count
     FROM lite_learning_external_holdout_members AS member
     WHERE NOT EXISTS (
       SELECT 1 FROM lite_learning_external_run_reservations AS reservation
       WHERE reservation.tenant_id = member.tenant_id
         AND reservation.reservation_id = member.reservation_id
     )`,
  ).get() as { count: number };
  if (Number(orphanMembers.count) !== 0) {
    throw new Error("orphan external holdout member");
  }

  const consumptions = db.prepare(
    `SELECT ${EXTERNAL_CONSUMPTION_COLUMNS.join(", ")}
     FROM lite_learning_external_ticket_consumptions
     ORDER BY tenant_id, consumption_id`,
  ).all() as LiteLearningAuthorityRow[];
  for (const consumption of consumptions) {
    resolveLifecyclePrefix(db, {
      tenant_id: requiredString(consumption, "tenant_id"),
      reservation_id: requiredString(consumption, "reservation_id"),
      ticket_consumption_id: requiredString(consumption, "consumption_id"),
    });
    consumptionOperationReceipt(db, consumption);
  }

  const holds = db.prepare(
    `SELECT ${EXTERNAL_PRECLAIM_HOLD_COLUMNS.join(", ")}
     FROM lite_learning_external_preclaim_holds
     ORDER BY tenant_id, hold_id`,
  ).all() as LiteLearningAuthorityRow[];
  for (const row of holds) {
    assertProtectedPreclaimHoldAuthorityRow(db, row);
  }

  const claims = db.prepare(
    `SELECT ${EXTERNAL_CLAIM_COLUMNS.join(", ")}
     FROM lite_learning_external_run_claims
     ORDER BY tenant_id, claim_id`,
  ).all() as LiteLearningAuthorityRow[];
  for (const row of claims) {
    claimOperationReceipt(db, row);
  }

  const bindings = db.prepare(
    `SELECT ${EXTERNAL_BINDING_COLUMNS.join(", ")}
     FROM lite_learning_external_supervisor_bindings
     ORDER BY tenant_id, binding_id`,
  ).all() as LiteLearningAuthorityRow[];
  for (const row of bindings) {
    bindingOperationReceipt(db, row);
  }

  const terminations = db.prepare(
    `SELECT ${EXTERNAL_TERMINATION_COLUMNS.join(", ")}
     FROM lite_learning_external_session_terminations
     ORDER BY tenant_id, termination_id`,
  ).all() as LiteLearningAuthorityRow[];
  for (const row of terminations) {
    assertProtectedTerminationAuthorityRow(db, row);
  }

  assertNoOrphanExternalAuthorityOperations(db);
}
