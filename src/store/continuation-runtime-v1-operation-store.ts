import {
  assertCanonicalUtcMillis,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type CanonicalJson,
} from "../continuation/contract.js";
import { sha256Hex } from "../util/crypto.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  deriveContinuationRuntimeV1OperationResultV1,
} from "./continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1OperationResultDeclaration,
} from "./continuation-runtime-v1-operation-result-support.js";
import type {
  ContinuationRuntimeV1OperationResultV1,
} from "./continuation-runtime-v1-operation-result.js";

export const CONTINUATION_RUNTIME_V1_OPERATION_KINDS = Object.freeze([
  "record_observations",
  "create_continuation",
  "record_outcome",
  "authority_decision",
  "worker_completion",
] as const);

export type ContinuationRuntimeV1OperationKind =
  typeof CONTINUATION_RUNTIME_V1_OPERATION_KINDS[number];

export const CONTINUATION_RUNTIME_V1_OPERATION_ACTOR_KINDS = Object.freeze([
  "trusted_host",
  "operator",
  "worker",
] as const);

export type ContinuationRuntimeV1OperationActorKind =
  typeof CONTINUATION_RUNTIME_V1_OPERATION_ACTOR_KINDS[number];

declare const CONTINUATION_RUNTIME_V1_AUTHORITY_WRITE_CONTEXT_BRAND: unique symbol;

/**
 * Opaque authority for writes performed by one newly-created operation.
 *
 * The type is nominal only; runtime authority lives in a module-private
 * WeakMap. Casting or copying this value cannot create a valid context.
 */
export type ContinuationRuntimeV1AuthorityWriteContext = Readonly<{
  readonly [CONTINUATION_RUNTIME_V1_AUTHORITY_WRITE_CONTEXT_BRAND]: true;
}>;

export type ContinuationRuntimeV1AuthorityWriteBinding = Readonly<{
  transactionIdentity: symbol;
  tenantId: string;
  scope: string;
  operationKind: ContinuationRuntimeV1OperationKind;
  operationId: string;
  requestSha256: string;
  actorKind: ContinuationRuntimeV1OperationActorKind;
  actorPrincipalSha256: string;
}>;

/** Exact durable parent tuple for every operation-owned authority root. */
export type ContinuationRuntimeV1OperationLineageV1 = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: ContinuationRuntimeV1OperationKind;
  operation_id: string;
  request_sha256: string;
  actor_kind: ContinuationRuntimeV1OperationActorKind;
  actor_principal_sha256: string;
}>;

export function continuationRuntimeV1OperationLineage(
  binding: ContinuationRuntimeV1AuthorityWriteBinding,
): ContinuationRuntimeV1OperationLineageV1 {
  return canonicalContinuationClone({
    tenant_id: binding.tenantId,
    scope: binding.scope,
    operation_kind: binding.operationKind,
    operation_id: binding.operationId,
    request_sha256: binding.requestSha256,
    actor_kind: binding.actorKind,
    actor_principal_sha256: binding.actorPrincipalSha256,
  });
}

type AuthorityWriteContextRecord = {
  readonly database: ContinuationRuntimeV1Database;
  readonly binding: ContinuationRuntimeV1AuthorityWriteBinding;
  active: boolean;
  completionDeadline: string | null;
};

const AUTHORITY_WRITE_CONTEXTS = new WeakMap<object, AuthorityWriteContextRecord>();

function issueAuthorityWriteContext(args: {
  database: ContinuationRuntimeV1Database;
  binding: ContinuationRuntimeV1AuthorityWriteBinding;
}): ContinuationRuntimeV1AuthorityWriteContext {
  const currentIdentity = args.database.transaction.currentTransactionIdentity();
  if (currentIdentity === null || currentIdentity !== args.binding.transactionIdentity) {
    fail("authority_write_context_transaction_required");
  }
  const context = Object.freeze({}) as ContinuationRuntimeV1AuthorityWriteContext;
  AUTHORITY_WRITE_CONTEXTS.set(context, {
    database: args.database,
    binding: Object.freeze({ ...args.binding }),
    active: true,
    completionDeadline: null,
  });
  return context;
}

function expireAuthorityWriteContext(
  context: ContinuationRuntimeV1AuthorityWriteContext,
): void {
  const record = AUTHORITY_WRITE_CONTEXTS.get(context);
  if (record) record.active = false;
}

/**
 * Authenticates an opaque write context against the exact database and active
 * AsyncLocal transaction that issued it. Authority stores call this before
 * every mutation and use the returned request digest as their operation
 * binding.
 */
export function assertContinuationRuntimeV1AuthorityWriteContext(
  context: unknown,
  database: ContinuationRuntimeV1Database,
): ContinuationRuntimeV1AuthorityWriteBinding {
  if (context === null || typeof context !== "object") {
    fail("authority_write_context_unrecognized");
  }
  const record = AUTHORITY_WRITE_CONTEXTS.get(context);
  if (!record) {
    fail("authority_write_context_unrecognized");
  }
  if (!record.active) {
    throw new Error("continuation_runtime_v1_authority_write_context_expired");
  }
  if (record.database !== database) {
    fail("authority_write_context_database_mismatch");
  }
  const currentIdentity = database.transaction.currentTransactionIdentity();
  if (currentIdentity === null) {
    fail("authority_write_context_transaction_required");
  }
  if (currentIdentity !== record.binding.transactionIdentity) {
    fail("authority_write_context_transaction_mismatch");
  }
  return record.binding;
}

/**
 * Tightens the latest legal receipt-completion time for the current operation.
 *
 * A producer cannot know `completed_at`: the operation store creates it only
 * after every authority mutation and result derivation succeeds. Stores that
 * discover a durable protocol cutoff therefore register it on the opaque
 * context. The operation store checks the tightest registered cutoff before
 * inserting the receipt, inside the same transaction. Callers cannot forge a
 * context or relax an existing deadline.
 */
export function constrainContinuationRuntimeV1OperationCompletion(
  context: unknown,
  database: ContinuationRuntimeV1Database,
  deadline: string,
): void {
  assertCanonicalUtcMillis(deadline, "operation.completion_deadline");
  assertContinuationRuntimeV1AuthorityWriteContext(context, database);
  const record = AUTHORITY_WRITE_CONTEXTS.get(context as object);
  if (!record) {
    fail("authority_write_context_unrecognized");
  }
  if (record.completionDeadline === null
    || deadline < record.completionDeadline) {
    record.completionDeadline = deadline;
  }
}

export type ContinuationRuntimeV1OperationReceiptV1 = Readonly<{
  schema_version: "continuation_runtime_operation_receipt_v1";
  tenant_id: string;
  scope: string;
  operation_kind: ContinuationRuntimeV1OperationKind;
  operation_id: string;
  request_sha256: string;
  actor_kind: ContinuationRuntimeV1OperationActorKind;
  actor_principal_sha256: string;
  completed_at: string;
  result: ContinuationRuntimeV1OperationResultV1;
}>;

export type ContinuationRuntimeV1OperationExecution = Readonly<{
  status: "created" | "replayed";
  request_sha256: string;
  receipt_sha256: string;
  receipt: ContinuationRuntimeV1OperationReceiptV1;
}>;

export type ContinuationRuntimeV1OperationRecord = Readonly<{
  request: CanonicalJson;
  request_sha256: string;
  receipt_sha256: string;
  receipt: ContinuationRuntimeV1OperationReceiptV1;
}>;

export type ReadContinuationRuntimeV1OperationArgs = Readonly<{
  tenantId: string;
  scope: string;
  operationKind: ContinuationRuntimeV1OperationKind;
  operationId: string;
}>;

export type ExecuteContinuationRuntimeV1OperationArgs = Readonly<{
  tenantId: string;
  scope: string;
  operationKind: ContinuationRuntimeV1OperationKind;
  operationId: string;
  actorKind: ContinuationRuntimeV1OperationActorKind;
  actorPrincipalSha256: string;
  request: CanonicalJson;
  produce: (
    context: ContinuationRuntimeV1AuthorityWriteContext,
  ) => Promise<ContinuationRuntimeV1OperationResultV1>
    | ContinuationRuntimeV1OperationResultV1;
}>;

export type ContinuationRuntimeV1OperationStore = Readonly<{
  /**
   * Owns the outer write transaction. The producer runs while that transaction
   * is open and may perform only bounded authority mutations on this same
   * database. Network calls, model inference, embedding, ANN, verifier runs,
   * and other external computation must be represented by a durable job and
   * executed after commit.
   */
  execute(
    args: ExecuteContinuationRuntimeV1OperationArgs,
  ): Promise<ContinuationRuntimeV1OperationExecution>;

  /**
   * Reads an exact persisted receipt by operation identity. The stored request
   * digest is authority and is therefore never supplied by the caller.
   */
  read(
    args: ReadContinuationRuntimeV1OperationArgs,
  ): Promise<ContinuationRuntimeV1OperationRecord | null>;
}>;

type OperationRow = {
  actor_kind: unknown;
  actor_principal_sha256: unknown;
  request_sha256: unknown;
  request_json: unknown;
  receipt_sha256: unknown;
  receipt_json: unknown;
  completed_at: unknown;
};

const OPERATION_KIND_SET = new Set<string>(CONTINUATION_RUNTIME_V1_OPERATION_KINDS);
const ACTOR_KIND_SET = new Set<string>(CONTINUATION_RUNTIME_V1_OPERATION_ACTOR_KINDS);
const REQUEST_MAX_BYTES = 1_048_576;
const WORKER_REQUEST_MAX_BYTES = 8_388_608;
const RECEIPT_MAX_BYTES = 262_144;
const RECEIPT_KEYS = Object.freeze([
  "actor_kind",
  "actor_principal_sha256",
  "completed_at",
  "operation_id",
  "operation_kind",
  "request_sha256",
  "result",
  "schema_version",
  "scope",
  "tenant_id",
] as const);

function fail(reason: string): never {
  throw new Error(`continuation_runtime_v1_${reason}`);
}

function assertCanonicalText(
  value: unknown,
  field: string,
  maxBytes: number,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_operation_${field}_must_be_text`);
  }
  assertUnicodeScalarString(value, field);
  if (value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`operation_${field}_must_be_canonical_utf8_text`);
  }
}

function assertOperationKind(
  value: unknown,
): asserts value is ContinuationRuntimeV1OperationKind {
  if (typeof value !== "string" || !OPERATION_KIND_SET.has(value)) {
    throw new Error("continuation_runtime_v1_operation_kind_unknown");
  }
}

function expectedActorKind(
  operationKind: ContinuationRuntimeV1OperationKind,
): ContinuationRuntimeV1OperationActorKind {
  if (operationKind === "authority_decision") return "operator";
  if (operationKind === "worker_completion") return "worker";
  return "trusted_host";
}

function assertOperationActor(args: {
  operationKind: ContinuationRuntimeV1OperationKind;
  actorKind: unknown;
  actorPrincipalSha256: unknown;
}): asserts args is {
  operationKind: ContinuationRuntimeV1OperationKind;
  actorKind: ContinuationRuntimeV1OperationActorKind;
  actorPrincipalSha256: string;
} {
  if (typeof args.actorKind !== "string" || !ACTOR_KIND_SET.has(args.actorKind)) {
    throw new Error("continuation_runtime_v1_operation_actor_kind_unknown");
  }
  if (args.actorKind !== expectedActorKind(args.operationKind)) {
    throw new Error("continuation_runtime_v1_operation_actor_kind_mismatch");
  }
  if (typeof args.actorPrincipalSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(args.actorPrincipalSha256)) {
    throw new Error("continuation_runtime_v1_operation_actor_principal_sha256_invalid");
  }
}

function canonicalJsonWithin(
  value: unknown,
  maxBytes: number,
  field: string,
): string {
  const json = canonicalContinuationJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error(`continuation_runtime_v1_operation_${field}_too_large`);
  }
  return json;
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`continuation_runtime_v1_operation_receipt_corrupt:${field}`);
  }
}

function operationIdentity(args: {
  tenantId: unknown;
  scope: unknown;
  operationKind: unknown;
  operationId: unknown;
}): Readonly<{
  tenantId: string;
  scope: string;
  operationKind: ContinuationRuntimeV1OperationKind;
  operationId: string;
}> {
  assertCanonicalText(args.tenantId, "tenant_id", 256);
  assertCanonicalText(args.scope, "scope", 256);
  assertOperationKind(args.operationKind);
  assertCanonicalText(args.operationId, "operation_id", 256);
  return {
    tenantId: args.tenantId,
    scope: args.scope,
    operationKind: args.operationKind,
    operationId: args.operationId,
  };
}

function assertReadOperationIdentityShape(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("operation_read_identity_shape_invalid");
  }
  const expected = ["operationId", "operationKind", "scope", "tenantId"];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail("operation_read_identity_shape_invalid");
  }
}

function deepFreezeCanonical<T extends CanonicalJson>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeCanonical(child);
    Object.freeze(value);
  }
  return value;
}

function requestMaxBytes(
  operationKind: ContinuationRuntimeV1OperationKind,
): number {
  return operationKind === "worker_completion"
    ? WORKER_REQUEST_MAX_BYTES
    : REQUEST_MAX_BYTES;
}

function parsePersistedRequest(args: {
  row: OperationRow;
  operationKind: ContinuationRuntimeV1OperationKind;
}): Readonly<{
  requestSha256: string;
  request: CanonicalJson;
}> {
  const { row } = args;
  if (typeof row.request_sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(row.request_sha256)) {
    fail("operation_request_corrupt:request_sha256");
  }
  if (typeof row.request_json !== "string") {
    fail("operation_request_corrupt:request_json_type");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.request_json) as unknown;
  } catch {
    fail("operation_request_corrupt:request_json_parse");
  }
  let canonical: string;
  try {
    canonical = canonicalJsonWithin(
      parsed,
      requestMaxBytes(args.operationKind),
      "request",
    );
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_operation_request_corrupt:request_not_canonical",
      { cause: error },
    );
  }
  if (canonical !== row.request_json) {
    fail("operation_request_corrupt:request_json_encoding");
  }
  if (sha256Hex(canonical) !== row.request_sha256) {
    fail("operation_request_corrupt:request_digest");
  }
  return Object.freeze({
    requestSha256: row.request_sha256,
    request: deepFreezeCanonical(parsed as CanonicalJson),
  });
}

function parsePersistedReceipt(args: {
  database: ContinuationRuntimeV1Database;
  row: OperationRow;
  tenantId: string;
  scope: string;
  operationKind: ContinuationRuntimeV1OperationKind;
  operationId: string;
}): Readonly<{
  request: CanonicalJson;
  requestSha256: string;
  receiptSha256: string;
  receipt: ContinuationRuntimeV1OperationReceiptV1;
}> {
  const { row } = args;
  const persistedRequest = parsePersistedRequest({
    row,
    operationKind: args.operationKind,
  });
  const persistedActor = {
    operationKind: args.operationKind,
    actorKind: row.actor_kind,
    actorPrincipalSha256: row.actor_principal_sha256,
  };
  try {
    assertOperationActor(persistedActor);
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_operation_receipt_corrupt:actor",
      { cause: error },
    );
  }
  assertSha256(row.receipt_sha256, "receipt_sha256");
  if (typeof row.receipt_json !== "string") {
    fail("operation_receipt_corrupt:receipt_json_type");
  }
  if (typeof row.completed_at !== "string") {
    fail("operation_receipt_corrupt:completed_at_type");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_json) as unknown;
  } catch {
    fail("operation_receipt_corrupt:receipt_json_parse");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("operation_receipt_corrupt:receipt_envelope_type");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RECEIPT_KEYS.length
    || RECEIPT_KEYS.some((key) => !Object.hasOwn(record, key))) {
    fail("operation_receipt_corrupt:receipt_envelope_shape");
  }

  let canonical: string;
  try {
    canonical = canonicalJsonWithin(parsed, RECEIPT_MAX_BYTES, "receipt");
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_operation_receipt_corrupt:receipt_not_canonical",
      { cause: error },
    );
  }
  if (canonical !== row.receipt_json) {
    fail("operation_receipt_corrupt:receipt_json_encoding");
  }
  if (sha256Hex(canonical) !== row.receipt_sha256) {
    fail("operation_receipt_corrupt:receipt_digest");
  }
  try {
    assertCanonicalUtcMillis(row.completed_at, "completed_at");
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_operation_receipt_corrupt:completed_at",
      { cause: error },
    );
  }
  if (record.schema_version !== "continuation_runtime_operation_receipt_v1"
    || record.tenant_id !== args.tenantId
    || record.scope !== args.scope
    || record.operation_kind !== args.operationKind
    || record.operation_id !== args.operationId
    || record.actor_kind !== persistedActor.actorKind
    || record.actor_principal_sha256 !== persistedActor.actorPrincipalSha256
    || record.request_sha256 !== persistedRequest.requestSha256
    || record.request_sha256 !== row.request_sha256
    || record.completed_at !== row.completed_at) {
    fail("operation_receipt_corrupt:receipt_identity");
  }

  const derivedResult = deriveContinuationRuntimeV1OperationResultV1(
    args.database,
    {
      tenantId: args.tenantId,
      scope: args.scope,
      operationKind: args.operationKind,
      operationId: args.operationId,
      requestSha256: persistedRequest.requestSha256,
      actorKind: persistedActor.actorKind,
      actorPrincipalSha256: persistedActor.actorPrincipalSha256,
    },
    "replay",
    record.result,
  );
  try {
    assertContinuationRuntimeV1OperationResultDeclaration(
      record.result,
      derivedResult,
    );
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_operation_receipt_corrupt:result",
      { cause: error },
    );
  }

  return {
    request: persistedRequest.request,
    requestSha256: persistedRequest.requestSha256,
    receiptSha256: row.receipt_sha256,
    receipt: deepFreezeCanonical(parsed as ContinuationRuntimeV1OperationReceiptV1),
  };
}

export class ContinuationRuntimeV1OperationConflictError extends Error {
  readonly tenantId: string;
  readonly scope: string;
  readonly operationKind: ContinuationRuntimeV1OperationKind;
  readonly operationId: string;
  readonly storedRequestSha256: string;
  readonly receivedRequestSha256: string;

  constructor(args: {
    tenantId: string;
    scope: string;
    operationKind: ContinuationRuntimeV1OperationKind;
    operationId: string;
    storedRequestSha256: string;
    receivedRequestSha256: string;
  }) {
    super(
      "continuation_runtime_v1_operation_conflict",
    );
    this.name = "ContinuationRuntimeV1OperationConflictError";
    this.tenantId = args.tenantId;
    this.scope = args.scope;
    this.operationKind = args.operationKind;
    this.operationId = args.operationId;
    this.storedRequestSha256 = args.storedRequestSha256;
    this.receivedRequestSha256 = args.receivedRequestSha256;
  }
}

export class ContinuationRuntimeV1OperationActorConflictError extends Error {
  constructor() {
    super("continuation_runtime_v1_operation_actor_conflict");
    this.name = "ContinuationRuntimeV1OperationActorConflictError";
  }
}

export function createContinuationRuntimeV1OperationStore(
  database: ContinuationRuntimeV1Database,
): ContinuationRuntimeV1OperationStore {
  return {
    async execute(
      args: ExecuteContinuationRuntimeV1OperationArgs,
    ): Promise<ContinuationRuntimeV1OperationExecution> {
      if (typeof args?.produce !== "function") {
        throw new Error("continuation_runtime_v1_operation_producer_required");
      }
      if (database.transaction.inTransaction()) {
        fail("operation_must_own_outer_transaction");
      }
      const identity = operationIdentity(args);
      const actor = {
        operationKind: identity.operationKind,
        actorKind: args.actorKind,
        actorPrincipalSha256: args.actorPrincipalSha256,
      };
      assertOperationActor(actor);
      // Validate and hash caller-controlled bytes before BEGIN IMMEDIATE. The
      // transaction protects authority decisions, not potentially large JSON
      // parsing or hashing work.
      const requestJson = canonicalJsonWithin(
        args.request,
        requestMaxBytes(identity.operationKind),
        "request",
      );
      const requestSha256 = sha256Hex(requestJson);
      let issuedContext: ContinuationRuntimeV1AuthorityWriteContext | null = null;
      try {
        return await database.withTx(async () => {
          const row = database.db.prepare(
            `SELECT actor_kind, actor_principal_sha256, request_sha256, request_json,
                    receipt_sha256, receipt_json, completed_at
               FROM operations
              WHERE tenant_id = ?
                AND scope = ?
                AND operation_kind = ?
                AND operation_id = ?`,
          ).get(
            identity.tenantId,
            identity.scope,
            identity.operationKind,
            identity.operationId,
          ) as OperationRow | undefined;

          if (row) {
            const persisted = parsePersistedReceipt({
              database,
              row,
              ...identity,
            });
            if (persisted.requestSha256 !== requestSha256) {
              throw new ContinuationRuntimeV1OperationConflictError({
                ...identity,
                storedRequestSha256: persisted.requestSha256,
                receivedRequestSha256: requestSha256,
              });
            }
            if (row.actor_kind !== actor.actorKind
              || row.actor_principal_sha256 !== actor.actorPrincipalSha256) {
              throw new ContinuationRuntimeV1OperationActorConflictError();
            }
            return {
              status: "replayed",
              request_sha256: requestSha256,
              receipt_sha256: persisted.receiptSha256,
              receipt: persisted.receipt,
            };
          }

          const transactionIdentity = database.transaction.currentTransactionIdentity();
          if (transactionIdentity === null) {
            fail("authority_write_context_transaction_required");
          }
          issuedContext = issueAuthorityWriteContext({
            database,
            binding: {
              transactionIdentity,
              tenantId: identity.tenantId,
              scope: identity.scope,
              operationKind: identity.operationKind,
              operationId: identity.operationId,
              requestSha256,
              actorKind: actor.actorKind,
              actorPrincipalSha256: actor.actorPrincipalSha256,
            },
          });
          const declaredResult = await args.produce(issuedContext);
          const result = deriveContinuationRuntimeV1OperationResultV1(
            database,
            {
              tenantId: identity.tenantId,
              scope: identity.scope,
              operationKind: identity.operationKind,
              operationId: identity.operationId,
              requestSha256,
              actorKind: actor.actorKind,
              actorPrincipalSha256: actor.actorPrincipalSha256,
            },
            "before_receipt_insert",
          );
          assertContinuationRuntimeV1OperationResultDeclaration(
            declaredResult,
            result,
          );
          const completedAt = database.mintAuthorityTime(null);
          assertCanonicalUtcMillis(completedAt, "operation.completed_at");
          const contextRecord = AUTHORITY_WRITE_CONTEXTS.get(issuedContext);
          if (!contextRecord || !contextRecord.active) {
            fail("authority_write_context_expired");
          }
          if (contextRecord.completionDeadline !== null
            && completedAt > contextRecord.completionDeadline) {
            fail("operation_completion_deadline_exceeded");
          }
          const envelope = {
            schema_version: "continuation_runtime_operation_receipt_v1",
            tenant_id: identity.tenantId,
            scope: identity.scope,
            operation_kind: identity.operationKind,
            operation_id: identity.operationId,
            request_sha256: requestSha256,
            actor_kind: actor.actorKind,
            actor_principal_sha256: actor.actorPrincipalSha256,
            completed_at: completedAt,
            result,
          } as const;
          const receiptJson = canonicalJsonWithin(
            envelope,
            RECEIPT_MAX_BYTES,
            "receipt",
          );
          const receiptSha256 = sha256Hex(receiptJson);

          database.db.prepare(
             `INSERT INTO operations(
               tenant_id, scope, operation_kind, operation_id,
               actor_kind, actor_principal_sha256, request_sha256, request_json,
               receipt_sha256, receipt_json, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            identity.tenantId,
            identity.scope,
            identity.operationKind,
            identity.operationId,
            actor.actorKind,
            actor.actorPrincipalSha256,
            requestSha256,
            requestJson,
            receiptSha256,
            receiptJson,
            completedAt,
          );
          const persisted = parsePersistedReceipt({
            database,
            row: {
              actor_kind: actor.actorKind,
              actor_principal_sha256: actor.actorPrincipalSha256,
              request_sha256: requestSha256,
              request_json: requestJson,
              receipt_sha256: receiptSha256,
              receipt_json: receiptJson,
              completed_at: completedAt,
            },
            ...identity,
          });
          return {
            status: "created",
            request_sha256: requestSha256,
            receipt_sha256: persisted.receiptSha256,
            receipt: persisted.receipt,
          };
        });
      } finally {
        if (issuedContext !== null) expireAuthorityWriteContext(issuedContext);
      }
    },

    async read(
      args: ReadContinuationRuntimeV1OperationArgs,
    ): Promise<ContinuationRuntimeV1OperationRecord | null> {
      assertReadOperationIdentityShape(args);
      const identity = operationIdentity(args);
      return await database.read(() => {
        const row = database.db.prepare(
          `SELECT actor_kind, actor_principal_sha256, request_sha256, request_json,
                  receipt_sha256, receipt_json, completed_at
             FROM operations
            WHERE tenant_id = ?
              AND scope = ?
              AND operation_kind = ?
              AND operation_id = ?`,
        ).get(
          identity.tenantId,
          identity.scope,
          identity.operationKind,
          identity.operationId,
        ) as OperationRow | undefined;
        if (!row) return null;
        const persisted = parsePersistedReceipt({
          database,
          row,
          ...identity,
        });
        return Object.freeze({
          request: persisted.request,
          request_sha256: persisted.requestSha256,
          receipt_sha256: persisted.receiptSha256,
          receipt: persisted.receipt,
        });
      });
    },
  };
}
