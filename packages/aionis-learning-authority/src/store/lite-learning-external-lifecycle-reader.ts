import type { ExternalExecutionPolicyV1 } from
  "../../../../src/memory/learning-episode-ledger.js";
import {
  liteLearningExternalAuthorityCanonicalContract,
  type LiteLearningExternalAuthorityOperationReceiptV1,
} from "../../../../src/store/lite-learning-external-authority.js";
import type { LiteLearningAuthorityRow } from
  "../../../../src/store/lite-learning-confirmatory-authority.js";
import type { SqliteDatabase } from "../../../../src/store/sqlite.js";
import {
  LearningExternalLifecycleAuthorityProjectionV1Schema,
  type LearningExternalLifecycleAuthorityProjectionV1,
} from "../memory/learning-external-evidence.js";

const {
  BoundedIdSchema,
  DigestSha256Schema,
  EXTERNAL_BINDING_COLUMNS,
  EXTERNAL_CLAIM_COLUMNS,
  EXTERNAL_CONSUMPTION_COLUMNS,
  EXTERNAL_HOLDOUT_MEMBER_COLUMNS,
  EXTERNAL_TERMINATION_COLUMNS,
  assertHoldoutMembers,
  assertProtectedTerminationAuthorityRow,
  assertReservationJsonAndDigest,
  assertReservationRevisionBindings,
  bindingOperationReceipt,
  claimOperationReceipt,
  consumptionOperationReceipt,
  requiredString,
  reservationOperationReceipt,
  selectAuthorityRow,
} = liteLearningExternalAuthorityCanonicalContract;

type ExternalRoleName = keyof ExternalExecutionPolicyV1["roles"];

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
 * Operator-side read model for one completed external evidence lifecycle. Every
 * row and receipt is resolved through the canonical Runtime reopen validators;
 * the focused daemon never composes this evidence-assembly surface.
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
