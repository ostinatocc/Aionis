import stableStringify from "fast-json-stable-stringify";

import {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction,
} from "../../../../src/store/lite-runtime-applied-authority.js";
import type {
  LearningExternalBrokerSupervisorBindingReceiptEnvelopeV1,
  LearningExternalClaimReceiptEnvelopeV1,
  LearningExternalPreclaimHoldReceiptEnvelopeV1,
  LearningExternalRunReservationAuthorizationReceiptEnvelopeV1,
  LearningExternalSessionTerminationReceiptEnvelopeV1,
  LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1,
} from "../../../../src/memory/learning-external-authority.js";
import {
  learningExternalTicketConsumptionDigest,
  type LiteLearningAuthorityRow,
} from "../../../../src/store/lite-learning-confirmatory-authority.js";
import {
  liteLearningExternalAuthorityCanonicalContract,
  type LiteLearningExternalAuthorityOperationReceiptV1,
} from "../../../../src/store/lite-learning-external-authority.js";
import type { SqliteDatabase } from "../../../../src/store/sqlite.js";
import type {
  SqliteTransactionRunner,
} from "../../../../src/store/sqlite-transaction-runner.js";
import type { LiteRuntimeDatabase } from
  "../../../../src/store/lite-runtime-database.js";
import {
  assertLiteRuntimeProtectedAuthorityTransactionCapability,
  type LiteRuntimeProtectedAuthorityTransactionCapability,
} from "./lite-runtime-protected-authority-database.js";

const {
  CanonicalUtcMillisSchema,
  ExternalAuthorityOperationReceiptV1Schema,
  EXTERNAL_AUTHORITY_SCOPE,
  EXTERNAL_BINDING_COLUMNS,
  EXTERNAL_CLAIM_COLUMNS,
  EXTERNAL_CONSUMPTION_COLUMNS,
  EXTERNAL_HOLDOUT_MEMBER_COLUMNS,
  EXTERNAL_PRECLAIM_HOLD_COLUMNS,
  EXTERNAL_RESERVATION_COLUMNS,
  EXTERNAL_TERMINATION_COLUMNS,
  assertAuthorizationTimes,
  assertExactColumns,
  assertExactReplay,
  assertFreshSignedOperationWindow,
  assertHoldoutMembers,
  assertOperationReplay,
  assertReservationJsonAndDigest,
  assertReservationRevisionBindings,
  assertRevisionOpenForReservation,
  assertRunnerTicket,
  authorizedOperationRequestDigest,
  bindingRow,
  claimRow,
  operationRow,
  preclaimHoldRow,
  requiredString,
  reservationExperimentClosure,
  resolveTriggeringExternalTerminalFact,
  selectAuthorityRow,
  selectExactRow,
  sha256Bytes,
  signedRequestDigest,
  terminationRow,
  verifyConsumptionAuthorization,
  verifyReservationAuthorization,
} = liteLearningExternalAuthorityCanonicalContract;

/**
 * Private operator-side lifecycle writer. The focused Runtime imports only the
 * canonical verifier contract and never composes this database mutation access.
 */


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

function insertOperationReceipt(
  db: SqliteDatabase,
  transaction: SqliteTransactionRunner,
  receipt: LiteLearningExternalAuthorityOperationReceiptV1,
): void {
  const receiptJson = stableStringify(ExternalAuthorityOperationReceiptV1Schema.parse(receipt));
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction({
    db,
    transaction,
    tenantId: receipt.tenant_id,
    scope: receipt.scope,
    operationKind: receipt.operation_kind,
    operationId: receipt.operation_id,
    requestSha256: receipt.request_sha256,
    receiptJson,
    commitId: null,
    createdAt: receipt.recorded_at,
    actor: receipt.actor_id,
  });
}

function protectedRowResult(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
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
    insertOperationReceipt(args.db, args.transaction, args.receipt);
    return inserted;
  });
}

type ExternalTicketConsumptionMutationInput = Readonly<{
  consumption: LiteLearningAuthorityRow;
  runnerTicket: Uint8Array;
  authorization: LearningExternalTicketConsumptionAuthorizationReceiptEnvelopeV1;
}>;

function consumeExternalTicketMutation(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
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
    insertOperationReceipt(
      db,
      args.transaction,
      { ...expectedReceipt, request_sha256: requestSha256 },
    );
    return { consumption: inserted.row, replayed: false as const };
  });
}

function recordExternalPreclaimHoldMutation(args: {
  db: SqliteDatabase;
  transaction: SqliteTransactionRunner;
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
    transaction: args.transaction,
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

export type LiteLearningExternalRunAuthorityAccess = Readonly<{
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

export function createLiteLearningExternalRunAuthorityAccess(args: {
  database: LiteRuntimeDatabase;
  capability: LiteRuntimeProtectedAuthorityTransactionCapability;
}): LiteLearningExternalRunAuthorityAccess {
  const { db, transaction } = args.database;
  const assertMutationAuthority = (): void => {
    assertLiteRuntimeProtectedAuthorityTransactionCapability(
      args.capability,
      args.database,
    );
  };
  assertMutationAuthority();
  return {
    async reserveExternalRun(input) {
      assertMutationAuthority();
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
        insertOperationReceipt(
          db,
          transaction,
          { ...expectedReceipt, request_sha256: requestSha256 },
        );
        return { reservation: inserted.row, replayed: false };
      });
    },

    async consumeExternalTicket(input) {
      assertMutationAuthority();
      return consumeExternalTicketMutation({
        db,
        transaction,
        input,
        allowClosedRevision: false,
      });
    },

    async closeReservedExternalRun(input) {
      assertMutationAuthority();
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
          transaction,
          input: {
            consumption: input.consumption,
            runnerTicket: input.runnerTicket,
            authorization: input.consumptionAuthorization,
          },
          allowClosedRevision: true,
        });
        const hold = recordExternalPreclaimHoldMutation({
          db,
          transaction,
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
      assertMutationAuthority();
      return recordExternalPreclaimHoldMutation({
        db,
        transaction,
        receipt: input.receipt,
        requiredTriggeringTerminalFactSha256: null,
      });
    },

    async claimExternalRun(input) {
      assertMutationAuthority();
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
        transaction,
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
      assertMutationAuthority();
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
        transaction,
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
      assertMutationAuthority();
      const built = terminationRow(db, input.receipt);
      const operationId = requiredString(built.row, "terminate_operation_id");
      const requestSha256 = signedRequestDigest(
        "aionis_learning_external_session_termination_request_v1",
        input.receipt,
      );
      const result = protectedRowResult({
        db,
        transaction,
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
