import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import {
  ExecutionSessionBindingV1Schema,
  ExecutionSessionHandoffReceiptV1Schema,
  ExecutionSessionLeaseEventV1Schema,
  ExecutionSessionLeaseV1Schema,
  executionSessionHandoffReceiptDigest,
  executionSessionLeaseDigest,
  executionSessionLeaseEventDigest,
  type ExecutionSessionBindingV1,
  type ExecutionSessionHandoffReceiptV1,
  type ExecutionSessionLeaseEventKindV1,
  type ExecutionSessionLeaseEventV1,
  type ExecutionSessionLeaseV1,
} from "../execution/agent-session.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";
import type { SqliteDatabase } from "./sqlite.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

type SessionRow = Readonly<{
  tenant_id: string;
  scope: string;
  session_key: string;
  continuation_id: string;
  episode_id: string;
  public_scope: string;
  goal_sha256: string;
  task_envelope_sha256: string;
  subject_identity_sha256: string;
  binding_json: string;
  lease_id: string;
  holder_id: string;
  lease_revision: number;
  lease_status: "active" | "released" | "expired";
  lease_expires_at: string | null;
  current_state_sha256: string;
  last_event_id: string;
  last_event_sha256: string;
  lease_sha256: string;
  created_at: string;
  updated_at: string;
}>;

type LeaseEventRow = Readonly<{
  event_json: string;
  request_sha256: string;
}>;

type HandoffRow = Readonly<{
  receipt_json: string;
}>;

export class ExecutionSessionLeaseStoreError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "ExecutionSessionLeaseStoreError";
    this.code = code;
  }
}

export type ExecutionSessionLeaseOperationResultV1 = Readonly<{
  lease: ExecutionSessionLeaseV1;
  event: ExecutionSessionLeaseEventV1;
  handoff_receipt: ExecutionSessionHandoffReceiptV1 | null;
  replayed: boolean;
}>;

type SessionIdentity = Readonly<{
  tenantId: string;
  scope: string;
  sessionKey: string;
}>;

type LeaseCasIdentity = SessionIdentity & Readonly<{
  operationId: string;
  holderId: string;
  expectedLeaseId: string;
  expectedLeaseRevision: number;
  currentStateSha256: string;
}>;

export type LiteExecutionSessionLeaseStore = Readonly<{
  transactionRunner(): SqliteTransactionRunner;
  get(identity: SessionIdentity): Promise<ExecutionSessionLeaseV1 | null>;
  getByEpisode(args: Readonly<{
    tenantId: string;
    scope: string;
    episodeId: string;
  }>): Promise<ExecutionSessionLeaseV1 | null>;
  acquire(args: Readonly<{
    binding: Omit<ExecutionSessionBindingV1, "created_at">;
    operationId: string;
    holderId: string;
    leaseTtlMs: number;
    currentStateSha256: string;
  }>): Promise<ExecutionSessionLeaseOperationResultV1>;
  renew(
    args: LeaseCasIdentity & Readonly<{
      leaseTtlMs: number;
      operationRequestSha256: string;
      allowExpiredAtCompletion?: boolean;
    }>,
  ): Promise<ExecutionSessionLeaseOperationResultV1>;
  handoff(
    args: LeaseCasIdentity & Readonly<{
      toHolderId: string;
      evidenceRefs: readonly string[];
      leaseTtlMs: number;
    }>,
  ): Promise<ExecutionSessionLeaseOperationResultV1>;
  release(
    args: LeaseCasIdentity,
  ): Promise<ExecutionSessionLeaseOperationResultV1>;
  expire(args: SessionIdentity & Readonly<{
    operationId: string;
    expectedLeaseId: string;
    expectedLeaseRevision: number;
  }>): Promise<ExecutionSessionLeaseOperationResultV1>;
  assertActive(args: SessionIdentity & Readonly<{
    holderId: string;
    leaseId: string;
    leaseRevision: number;
  }>): Promise<ExecutionSessionLeaseV1>;
  listEvents(identity: SessionIdentity):
    Promise<readonly ExecutionSessionLeaseEventV1[]>;
}>;

function fail(code: string): never {
  throw new ExecutionSessionLeaseStoreError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicId(prefix: string, material: unknown): string {
  return `${prefix}_${sha256(stableStringify(material))}`;
}

function requestDigest(material: unknown): string {
  return sha256(stableStringify(material));
}

function assertId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || Buffer.byteLength(value, "utf8") > 256
  ) {
    fail(`execution_session_${label}_invalid`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`execution_session_${label}_invalid`);
  }
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("execution_session_lease_revision_invalid");
  }
}

function assertLeaseTtl(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < MIN_LEASE_TTL_MS
    || Number(value) > MAX_LEASE_TTL_MS
  ) {
    fail("execution_session_lease_ttl_invalid");
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`execution_session_${label}_invalid`);
  }
  return parsed;
}

function leaseExpiry(now: string, ttlMs: number): string {
  assertLeaseTtl(ttlMs);
  return new Date(parseTimestamp(now, "recorded_at") + ttlMs).toISOString();
}

function bindingFromRow(row: SessionRow): ExecutionSessionBindingV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.binding_json);
  } catch {
    return fail("execution_session_binding_corrupt");
  }
  const binding = ExecutionSessionBindingV1Schema.parse(parsed);
  if (
    binding.tenant_id !== row.tenant_id
    || binding.store_scope !== row.scope
    || binding.public_scope !== row.public_scope
    || binding.session_key !== row.session_key
    || binding.continuation_id !== row.continuation_id
    || binding.episode_id !== row.episode_id
    || binding.goal_sha256 !== row.goal_sha256
    || binding.task_envelope_sha256 !== row.task_envelope_sha256
    || binding.subject_identity_sha256 !== row.subject_identity_sha256
    || binding.created_at !== row.created_at
  ) {
    return fail("execution_session_binding_corrupt");
  }
  return binding;
}

function leaseFromRow(row: SessionRow): ExecutionSessionLeaseV1 {
  const material = {
    contract_version: "execution_session_lease_v1" as const,
    binding: bindingFromRow(row),
    lease_id: row.lease_id,
    holder_id: row.holder_id,
    lease_revision: row.lease_revision,
    status: row.lease_status,
    expires_at: row.lease_expires_at,
    current_state_sha256: row.current_state_sha256,
    last_event_id: row.last_event_id,
    last_event_sha256: row.last_event_sha256,
    updated_at: row.updated_at,
  };
  const lease = ExecutionSessionLeaseV1Schema.parse({
    ...material,
    lease_sha256: executionSessionLeaseDigest(material),
  });
  if (lease.lease_sha256 !== row.lease_sha256) {
    return fail("execution_session_lease_head_corrupt");
  }
  return lease;
}

function eventFromRow(row: LeaseEventRow): ExecutionSessionLeaseEventV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json);
  } catch {
    return fail("execution_session_lease_event_corrupt");
  }
  const event = ExecutionSessionLeaseEventV1Schema.parse(parsed);
  if (event.request_sha256 !== row.request_sha256) {
    return fail("execution_session_lease_event_corrupt");
  }
  return event;
}

function handoffFromRow(row: HandoffRow):
  ExecutionSessionHandoffReceiptV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_json);
  } catch {
    return fail("execution_session_handoff_receipt_corrupt");
  }
  return ExecutionSessionHandoffReceiptV1Schema.parse(parsed);
}

function sameBinding(
  actual: ExecutionSessionBindingV1,
  expected: Omit<ExecutionSessionBindingV1, "created_at">,
): boolean {
  const { created_at: _createdAt, ...material } = actual;
  return stableStringify(material) === stableStringify(expected);
}

function activeAt(lease: ExecutionSessionLeaseV1, now: string): boolean {
  return lease.status === "active"
    && lease.expires_at !== null
    && parseTimestamp(lease.expires_at, "lease_expiry")
      > parseTimestamp(now, "recorded_at");
}

function eventForOperation(
  db: SqliteDatabase,
  identity: SessionIdentity,
  operationId: string,
): LeaseEventRow | null {
  return db.prepare(
    `SELECT event_json, request_sha256
     FROM lite_execution_session_lease_events
     WHERE tenant_id = ? AND scope = ? AND operation_id = ?`,
  ).get(
    identity.tenantId,
    identity.scope,
    operationId,
  ) as LeaseEventRow | undefined ?? null;
}

function sessionRow(
  db: SqliteDatabase,
  identity: SessionIdentity,
): SessionRow | null {
  return db.prepare(
    `SELECT *
     FROM lite_execution_sessions
     WHERE tenant_id = ? AND scope = ? AND session_key = ?`,
  ).get(
    identity.tenantId,
    identity.scope,
    identity.sessionKey,
  ) as SessionRow | undefined ?? null;
}

function handoffForEvent(
  db: SqliteDatabase,
  event: ExecutionSessionLeaseEventV1,
): ExecutionSessionHandoffReceiptV1 | null {
  if (!event.handoff_receipt_id) return null;
  const row = db.prepare(
    `SELECT receipt_json
     FROM lite_execution_session_handoff_receipts
     WHERE tenant_id = ? AND scope = ? AND receipt_id = ?`,
  ).get(
    event.tenant_id,
    event.store_scope,
    event.handoff_receipt_id,
  ) as HandoffRow | undefined;
  return row ? handoffFromRow(row) : fail(
    "execution_session_handoff_receipt_missing",
  );
}

function replayedOperation(
  db: SqliteDatabase,
  identity: SessionIdentity,
  operationId: string,
  expectedRequestSha256: string,
): ExecutionSessionLeaseOperationResultV1 | null {
  const row = eventForOperation(db, identity, operationId);
  if (!row) return null;
  if (row.request_sha256 !== expectedRequestSha256) {
    return fail("execution_session_operation_conflict");
  }
  const event = eventFromRow(row);
  if (
    event.session_key !== identity.sessionKey
    || event.tenant_id !== identity.tenantId
    || event.store_scope !== identity.scope
  ) {
    return fail("execution_session_operation_conflict");
  }
  const head = sessionRow(db, identity);
  if (!head) return fail("execution_session_missing");
  return Object.freeze({
    lease: leaseFromRow(head),
    event,
    handoff_receipt: handoffForEvent(db, event),
    replayed: true,
  });
}

function createEvent(args: Readonly<{
  binding: ExecutionSessionBindingV1;
  eventKind: ExecutionSessionLeaseEventKindV1;
  operationId: string;
  requestSha256: string;
  previousEventSha256: string | null;
  leaseId: string;
  leaseRevision: number;
  holderId: string;
  previousHolderId: string | null;
  expiresAt: string | null;
  currentStateSha256: string;
  handoffReceiptId: string | null;
  recordedAt: string;
}>): ExecutionSessionLeaseEventV1 {
  const eventId = deterministicId("esl_evt", {
    contract_version: "execution_session_lease_event_identity_v1",
    tenant_id: args.binding.tenant_id,
    store_scope: args.binding.store_scope,
    session_key: args.binding.session_key,
    lease_revision: args.leaseRevision,
    operation_id: args.operationId,
    request_sha256: args.requestSha256,
  });
  const material = {
    contract_version: "execution_session_lease_event_v1" as const,
    event_id: eventId,
    tenant_id: args.binding.tenant_id,
    store_scope: args.binding.store_scope,
    session_key: args.binding.session_key,
    continuation_id: args.binding.continuation_id,
    episode_id: args.binding.episode_id,
    event_kind: args.eventKind,
    operation_id: args.operationId,
    request_sha256: args.requestSha256,
    previous_event_sha256: args.previousEventSha256,
    lease_id: args.leaseId,
    lease_revision: args.leaseRevision,
    holder_id: args.holderId,
    previous_holder_id: args.previousHolderId,
    expires_at: args.expiresAt,
    current_state_sha256: args.currentStateSha256,
    handoff_receipt_id: args.handoffReceiptId,
    recorded_at: args.recordedAt,
  };
  return ExecutionSessionLeaseEventV1Schema.parse({
    ...material,
    event_sha256: executionSessionLeaseEventDigest(material),
  });
}

function buildLease(args: Readonly<{
  binding: ExecutionSessionBindingV1;
  event: ExecutionSessionLeaseEventV1;
  status: "active" | "released" | "expired";
}>): ExecutionSessionLeaseV1 {
  const material = {
    contract_version: "execution_session_lease_v1" as const,
    binding: args.binding,
    lease_id: args.event.lease_id,
    holder_id: args.event.holder_id,
    lease_revision: args.event.lease_revision,
    status: args.status,
    expires_at: args.event.expires_at,
    current_state_sha256: args.event.current_state_sha256,
    last_event_id: args.event.event_id,
    last_event_sha256: args.event.event_sha256,
    updated_at: args.event.recorded_at,
  };
  return ExecutionSessionLeaseV1Schema.parse({
    ...material,
    lease_sha256: executionSessionLeaseDigest(material),
  });
}

function insertEvent(
  db: SqliteDatabase,
  event: ExecutionSessionLeaseEventV1,
): void {
  db.prepare(
    `INSERT INTO lite_execution_session_lease_events (
       tenant_id, scope, session_key, continuation_id, episode_id,
       event_id, event_kind, operation_id, request_sha256,
       previous_event_sha256, event_sha256, lease_id, lease_revision,
       holder_id, previous_holder_id, expires_at, current_state_sha256,
       handoff_receipt_id, event_json, recorded_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    event.tenant_id,
    event.store_scope,
    event.session_key,
    event.continuation_id,
    event.episode_id,
    event.event_id,
    event.event_kind,
    event.operation_id,
    event.request_sha256,
    event.previous_event_sha256,
    event.event_sha256,
    event.lease_id,
    event.lease_revision,
    event.holder_id,
    event.previous_holder_id,
    event.expires_at,
    event.current_state_sha256,
    event.handoff_receipt_id,
    stableStringify(event),
    event.recorded_at,
  );
}

function insertSession(
  db: SqliteDatabase,
  lease: ExecutionSessionLeaseV1,
): void {
  const binding = lease.binding;
  db.prepare(
    `INSERT INTO lite_execution_sessions (
       tenant_id, scope, session_key, continuation_id, episode_id,
       public_scope, goal_sha256, task_envelope_sha256,
       subject_identity_sha256, binding_json, lease_id, holder_id,
       lease_revision, lease_status, lease_expires_at,
       current_state_sha256, last_event_id, last_event_sha256,
       lease_sha256, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    binding.tenant_id,
    binding.store_scope,
    binding.session_key,
    binding.continuation_id,
    binding.episode_id,
    binding.public_scope,
    binding.goal_sha256,
    binding.task_envelope_sha256,
    binding.subject_identity_sha256,
    stableStringify(binding),
    lease.lease_id,
    lease.holder_id,
    lease.lease_revision,
    lease.status,
    lease.expires_at,
    lease.current_state_sha256,
    lease.last_event_id,
    lease.last_event_sha256,
    lease.lease_sha256,
    binding.created_at,
    lease.updated_at,
  );
}

function updateSessionCas(
  db: SqliteDatabase,
  previous: ExecutionSessionLeaseV1,
  next: ExecutionSessionLeaseV1,
): void {
  const result = db.prepare(
    `UPDATE lite_execution_sessions
     SET lease_id = ?,
         holder_id = ?,
         lease_revision = ?,
         lease_status = ?,
         lease_expires_at = ?,
         current_state_sha256 = ?,
         last_event_id = ?,
         last_event_sha256 = ?,
         lease_sha256 = ?,
         updated_at = ?
     WHERE tenant_id = ?
       AND scope = ?
       AND session_key = ?
       AND lease_id = ?
       AND lease_revision = ?
       AND last_event_sha256 = ?
       AND lease_sha256 = ?`,
  ).run(
    next.lease_id,
    next.holder_id,
    next.lease_revision,
    next.status,
    next.expires_at,
    next.current_state_sha256,
    next.last_event_id,
    next.last_event_sha256,
    next.lease_sha256,
    next.updated_at,
    previous.binding.tenant_id,
    previous.binding.store_scope,
    previous.binding.session_key,
    previous.lease_id,
    previous.lease_revision,
    previous.last_event_sha256,
    previous.lease_sha256,
  ) as { changes: number };
  if (result.changes !== 1) {
    fail("execution_session_lease_cas_conflict");
  }
}

function assertCas(
  lease: ExecutionSessionLeaseV1,
  args: Readonly<{
    holderId: string;
    expectedLeaseId: string;
    expectedLeaseRevision: number;
  }>,
): void {
  if (
    lease.holder_id !== args.holderId
    || lease.lease_id !== args.expectedLeaseId
    || lease.lease_revision !== args.expectedLeaseRevision
  ) {
    fail("execution_session_lease_cas_conflict");
  }
}

function operationResult(
  lease: ExecutionSessionLeaseV1,
  event: ExecutionSessionLeaseEventV1,
  handoffReceipt: ExecutionSessionHandoffReceiptV1 | null = null,
): ExecutionSessionLeaseOperationResultV1 {
  return Object.freeze({
    lease,
    event,
    handoff_receipt: handoffReceipt,
    replayed: false,
  });
}

export function createLiteExecutionSessionLeaseStore(
  database: LiteRuntimeDatabase,
  options: Readonly<{ now?: () => string }> = {},
): LiteExecutionSessionLeaseStore {
  const { db, transaction } = database;
  const now = options.now ?? (() => new Date().toISOString());

  function requireTransaction(): void {
    if (!transaction.inTransaction()) {
      fail("execution_session_transaction_required");
    }
  }

  function canonicalIdentity(identity: SessionIdentity): SessionIdentity {
    assertId(identity.tenantId, "tenant_id");
    assertId(identity.scope, "scope");
    assertId(identity.sessionKey, "session_key");
    return identity;
  }

  async function readHead(
    identity: SessionIdentity,
  ): Promise<ExecutionSessionLeaseV1 | null> {
    const canonical = canonicalIdentity(identity);
    return await transaction.read(() => {
      const row = sessionRow(db, canonical);
      return row ? leaseFromRow(row) : null;
    });
  }

  return {
    transactionRunner(): SqliteTransactionRunner {
      return transaction;
    },

    async get(identity) {
      return await readHead(identity);
    },

    async getByEpisode(args) {
      assertId(args.tenantId, "tenant_id");
      assertId(args.scope, "scope");
      assertId(args.episodeId, "episode_id");
      return await transaction.read(() => {
        const row = db.prepare(
          `SELECT *
           FROM lite_execution_sessions
           WHERE tenant_id = ? AND scope = ? AND episode_id = ?
           LIMIT 1`,
        ).get(
          args.tenantId,
          args.scope,
          args.episodeId,
        ) as SessionRow | undefined;
        return row ? leaseFromRow(row) : null;
      });
    },

    async acquire(args) {
      requireTransaction();
      const rawBinding = {
        ...args.binding,
        created_at: now(),
      };
      const parsedBinding = ExecutionSessionBindingV1Schema.parse(rawBinding);
      assertId(args.operationId, "operation_id");
      assertId(args.holderId, "holder_id");
      assertLeaseTtl(args.leaseTtlMs);
      assertSha256(args.currentStateSha256, "current_state_sha256");
      const identity = canonicalIdentity({
        tenantId: parsedBinding.tenant_id,
        scope: parsedBinding.store_scope,
        sessionKey: parsedBinding.session_key,
      });
      const digest = requestDigest({
        contract_version: "execution_session_acquire_request_v1",
        binding: args.binding,
        operation_id: args.operationId,
        holder_id: args.holderId,
        lease_ttl_ms: args.leaseTtlMs,
        current_state_sha256: args.currentStateSha256,
      });
      const replayed = replayedOperation(
        db,
        identity,
        args.operationId,
        digest,
      );
      if (replayed) return replayed;

      const recordedAt = now();
      const expiresAt = leaseExpiry(recordedAt, args.leaseTtlMs);
      const existingRow = sessionRow(db, identity);
      if (!existingRow) {
        const binding = ExecutionSessionBindingV1Schema.parse({
          ...args.binding,
          created_at: recordedAt,
        });
        const leaseId = deterministicId("esl", {
          contract_version: "execution_session_lease_identity_v1",
          session_key: binding.session_key,
          continuation_id: binding.continuation_id,
          lease_revision: 1,
          operation_id: args.operationId,
        });
        const event = createEvent({
          binding,
          eventKind: "acquired",
          operationId: args.operationId,
          requestSha256: digest,
          previousEventSha256: null,
          leaseId,
          leaseRevision: 1,
          holderId: args.holderId,
          previousHolderId: null,
          expiresAt,
          currentStateSha256: args.currentStateSha256,
          handoffReceiptId: null,
          recordedAt,
        });
        const lease = buildLease({ binding, event, status: "active" });
        insertSession(db, lease);
        insertEvent(db, event);
        return operationResult(lease, event);
      }

      const previous = leaseFromRow(existingRow);
      if (!sameBinding(previous.binding, args.binding)) {
        return fail("execution_session_binding_conflict");
      }
      if (
        activeAt(previous, recordedAt)
        && previous.holder_id !== args.holderId
      ) {
        return fail("execution_session_active_lease_conflict");
      }
      const eventKind: ExecutionSessionLeaseEventKindV1 =
        activeAt(previous, recordedAt) ? "renewed" : "taken_over";
      const revision = previous.lease_revision + 1;
      const leaseId = eventKind === "renewed"
        ? previous.lease_id
        : deterministicId("esl", {
          contract_version: "execution_session_lease_identity_v1",
          session_key: previous.binding.session_key,
          continuation_id: previous.binding.continuation_id,
          lease_revision: revision,
          operation_id: args.operationId,
        });
      const event = createEvent({
        binding: previous.binding,
        eventKind,
        operationId: args.operationId,
        requestSha256: digest,
        previousEventSha256: previous.last_event_sha256,
        leaseId,
        leaseRevision: revision,
        holderId: args.holderId,
        previousHolderId: previous.holder_id,
        expiresAt,
        currentStateSha256: args.currentStateSha256,
        handoffReceiptId: null,
        recordedAt,
      });
      const lease = buildLease({
        binding: previous.binding,
        event,
        status: "active",
      });
      updateSessionCas(db, previous, lease);
      insertEvent(db, event);
      return operationResult(lease, event);
    },

    async renew(args) {
      requireTransaction();
      const identity = canonicalIdentity(args);
      assertId(args.operationId, "operation_id");
      assertId(args.holderId, "holder_id");
      assertId(args.expectedLeaseId, "lease_id");
      assertRevision(args.expectedLeaseRevision);
      assertLeaseTtl(args.leaseTtlMs);
      assertSha256(args.currentStateSha256, "current_state_sha256");
      assertSha256(
        args.operationRequestSha256,
        "operation_request_sha256",
      );
      if (
        args.allowExpiredAtCompletion !== undefined
        && typeof args.allowExpiredAtCompletion !== "boolean"
      ) {
        return fail(
          "execution_session_expired_completion_policy_invalid",
        );
      }
      const digest = requestDigest({
        contract_version: "execution_session_renew_request_v1",
        ...identity,
        operation_id: args.operationId,
        holder_id: args.holderId,
        expected_lease_id: args.expectedLeaseId,
        expected_lease_revision: args.expectedLeaseRevision,
        lease_ttl_ms: args.leaseTtlMs,
        current_state_sha256: args.currentStateSha256,
        operation_request_sha256: args.operationRequestSha256,
        allow_expired_at_completion:
          args.allowExpiredAtCompletion === true,
      });
      const replayed = replayedOperation(
        db,
        identity,
        args.operationId,
        digest,
      );
      if (replayed) return replayed;
      const row = sessionRow(db, identity);
      if (!row) return fail("execution_session_missing");
      const previous = leaseFromRow(row);
      assertCas(previous, args);
      const recordedAt = now();
      if (
        !activeAt(previous, recordedAt)
        && !(
          args.allowExpiredAtCompletion === true
          && previous.status === "active"
        )
      ) {
        return fail("execution_session_lease_expired");
      }
      const event = createEvent({
        binding: previous.binding,
        eventKind: "renewed",
        operationId: args.operationId,
        requestSha256: digest,
        previousEventSha256: previous.last_event_sha256,
        leaseId: previous.lease_id,
        leaseRevision: previous.lease_revision + 1,
        holderId: previous.holder_id,
        previousHolderId: previous.holder_id,
        expiresAt: leaseExpiry(recordedAt, args.leaseTtlMs),
        currentStateSha256: args.currentStateSha256,
        handoffReceiptId: null,
        recordedAt,
      });
      const lease = buildLease({
        binding: previous.binding,
        event,
        status: "active",
      });
      updateSessionCas(db, previous, lease);
      insertEvent(db, event);
      return operationResult(lease, event);
    },

    async handoff(args) {
      requireTransaction();
      const identity = canonicalIdentity(args);
      assertId(args.operationId, "operation_id");
      assertId(args.holderId, "holder_id");
      assertId(args.toHolderId, "to_holder_id");
      assertId(args.expectedLeaseId, "lease_id");
      assertRevision(args.expectedLeaseRevision);
      assertLeaseTtl(args.leaseTtlMs);
      assertSha256(args.currentStateSha256, "current_state_sha256");
      const evidenceRefs = [...new Set(args.evidenceRefs)];
      if (
        evidenceRefs.length !== args.evidenceRefs.length
        || evidenceRefs.length > 256
      ) {
        return fail("execution_session_handoff_evidence_invalid");
      }
      for (const ref of evidenceRefs) assertId(ref, "handoff_evidence_ref");
      const digest = requestDigest({
        contract_version: "execution_session_handoff_request_v1",
        ...identity,
        operation_id: args.operationId,
        holder_id: args.holderId,
        to_holder_id: args.toHolderId,
        expected_lease_id: args.expectedLeaseId,
        expected_lease_revision: args.expectedLeaseRevision,
        evidence_refs: evidenceRefs,
        lease_ttl_ms: args.leaseTtlMs,
        current_state_sha256: args.currentStateSha256,
      });
      const replayed = replayedOperation(
        db,
        identity,
        args.operationId,
        digest,
      );
      if (replayed) return replayed;
      const row = sessionRow(db, identity);
      if (!row) return fail("execution_session_missing");
      const previous = leaseFromRow(row);
      assertCas(previous, args);
      const recordedAt = now();
      if (!activeAt(previous, recordedAt)) {
        return fail("execution_session_lease_expired");
      }
      if (args.toHolderId === previous.holder_id) {
        return fail("execution_session_handoff_same_holder");
      }
      if (previous.current_state_sha256 !== args.currentStateSha256) {
        return fail("execution_session_state_head_stale");
      }
      const receiptId = deterministicId("esh", {
        contract_version: "execution_session_handoff_identity_v1",
        session_key: previous.binding.session_key,
        from_lease_revision: previous.lease_revision,
        operation_id: args.operationId,
      });
      const receiptMaterial = {
        contract_version: "execution_session_handoff_receipt_v1" as const,
        receipt_id: receiptId,
        tenant_id: previous.binding.tenant_id,
        store_scope: previous.binding.store_scope,
        session_key: previous.binding.session_key,
        continuation_id: previous.binding.continuation_id,
        episode_id: previous.binding.episode_id,
        from_holder_id: previous.holder_id,
        to_holder_id: args.toHolderId,
        from_lease_revision: previous.lease_revision,
        state_sha256: args.currentStateSha256,
        evidence_refs: evidenceRefs,
        created_at: recordedAt,
      };
      const receipt = ExecutionSessionHandoffReceiptV1Schema.parse({
        ...receiptMaterial,
        receipt_sha256:
          executionSessionHandoffReceiptDigest(receiptMaterial),
      });
      db.prepare(
        `INSERT INTO lite_execution_session_handoff_receipts (
           tenant_id, scope, receipt_id, session_key, continuation_id,
           episode_id, from_holder_id, to_holder_id,
           from_lease_revision, state_sha256, evidence_refs_json,
           receipt_json, receipt_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receipt.tenant_id,
        receipt.store_scope,
        receipt.receipt_id,
        receipt.session_key,
        receipt.continuation_id,
        receipt.episode_id,
        receipt.from_holder_id,
        receipt.to_holder_id,
        receipt.from_lease_revision,
        receipt.state_sha256,
        stableStringify(receipt.evidence_refs),
        stableStringify(receipt),
        receipt.receipt_sha256,
        receipt.created_at,
      );
      const revision = previous.lease_revision + 1;
      const leaseId = deterministicId("esl", {
        contract_version: "execution_session_lease_identity_v1",
        session_key: previous.binding.session_key,
        continuation_id: previous.binding.continuation_id,
        lease_revision: revision,
        operation_id: args.operationId,
      });
      const event = createEvent({
        binding: previous.binding,
        eventKind: "handed_off",
        operationId: args.operationId,
        requestSha256: digest,
        previousEventSha256: previous.last_event_sha256,
        leaseId,
        leaseRevision: revision,
        holderId: args.toHolderId,
        previousHolderId: previous.holder_id,
        expiresAt: leaseExpiry(recordedAt, args.leaseTtlMs),
        currentStateSha256: args.currentStateSha256,
        handoffReceiptId: receipt.receipt_id,
        recordedAt,
      });
      const lease = buildLease({
        binding: previous.binding,
        event,
        status: "active",
      });
      updateSessionCas(db, previous, lease);
      insertEvent(db, event);
      return operationResult(lease, event, receipt);
    },

    async release(args) {
      requireTransaction();
      const identity = canonicalIdentity(args);
      assertId(args.operationId, "operation_id");
      assertId(args.holderId, "holder_id");
      assertId(args.expectedLeaseId, "lease_id");
      assertRevision(args.expectedLeaseRevision);
      assertSha256(args.currentStateSha256, "current_state_sha256");
      const digest = requestDigest({
        contract_version: "execution_session_release_request_v1",
        ...identity,
        operation_id: args.operationId,
        holder_id: args.holderId,
        expected_lease_id: args.expectedLeaseId,
        expected_lease_revision: args.expectedLeaseRevision,
        current_state_sha256: args.currentStateSha256,
      });
      const replayed = replayedOperation(
        db,
        identity,
        args.operationId,
        digest,
      );
      if (replayed) return replayed;
      const row = sessionRow(db, identity);
      if (!row) return fail("execution_session_missing");
      const previous = leaseFromRow(row);
      assertCas(previous, args);
      const recordedAt = now();
      if (!activeAt(previous, recordedAt)) {
        return fail("execution_session_lease_expired");
      }
      const event = createEvent({
        binding: previous.binding,
        eventKind: "released",
        operationId: args.operationId,
        requestSha256: digest,
        previousEventSha256: previous.last_event_sha256,
        leaseId: previous.lease_id,
        leaseRevision: previous.lease_revision + 1,
        holderId: previous.holder_id,
        previousHolderId: previous.holder_id,
        expiresAt: null,
        currentStateSha256: args.currentStateSha256,
        handoffReceiptId: null,
        recordedAt,
      });
      const lease = buildLease({
        binding: previous.binding,
        event,
        status: "released",
      });
      updateSessionCas(db, previous, lease);
      insertEvent(db, event);
      return operationResult(lease, event);
    },

    async expire(args) {
      requireTransaction();
      const identity = canonicalIdentity(args);
      assertId(args.operationId, "operation_id");
      assertId(args.expectedLeaseId, "lease_id");
      assertRevision(args.expectedLeaseRevision);
      const digest = requestDigest({
        contract_version: "execution_session_expire_request_v1",
        ...identity,
        operation_id: args.operationId,
        expected_lease_id: args.expectedLeaseId,
        expected_lease_revision: args.expectedLeaseRevision,
      });
      const replayed = replayedOperation(
        db,
        identity,
        args.operationId,
        digest,
      );
      if (replayed) return replayed;
      const row = sessionRow(db, identity);
      if (!row) return fail("execution_session_missing");
      const previous = leaseFromRow(row);
      if (
        previous.lease_id !== args.expectedLeaseId
        || previous.lease_revision !== args.expectedLeaseRevision
      ) {
        return fail("execution_session_lease_cas_conflict");
      }
      const recordedAt = now();
      if (previous.status !== "active" || activeAt(previous, recordedAt)) {
        return fail("execution_session_lease_not_expirable");
      }
      const event = createEvent({
        binding: previous.binding,
        eventKind: "expired",
        operationId: args.operationId,
        requestSha256: digest,
        previousEventSha256: previous.last_event_sha256,
        leaseId: previous.lease_id,
        leaseRevision: previous.lease_revision + 1,
        holderId: previous.holder_id,
        previousHolderId: previous.holder_id,
        expiresAt: previous.expires_at,
        currentStateSha256: previous.current_state_sha256,
        handoffReceiptId: null,
        recordedAt,
      });
      const lease = buildLease({
        binding: previous.binding,
        event,
        status: "expired",
      });
      updateSessionCas(db, previous, lease);
      insertEvent(db, event);
      return operationResult(lease, event);
    },

    async assertActive(args) {
      const identity = canonicalIdentity(args);
      assertId(args.holderId, "holder_id");
      assertId(args.leaseId, "lease_id");
      assertRevision(args.leaseRevision);
      const lease = await readHead(identity);
      if (!lease) return fail("execution_session_missing");
      if (
        lease.holder_id !== args.holderId
        || lease.lease_id !== args.leaseId
        || lease.lease_revision !== args.leaseRevision
      ) {
        return fail("execution_session_lease_cas_conflict");
      }
      if (!activeAt(lease, now())) {
        return fail("execution_session_lease_expired");
      }
      return lease;
    },

    async listEvents(identity) {
      const canonical = canonicalIdentity(identity);
      return await transaction.read(() => {
        const rows = db.prepare(
          `SELECT event_json, request_sha256
           FROM lite_execution_session_lease_events
           WHERE tenant_id = ? AND scope = ? AND session_key = ?
           ORDER BY lease_revision`,
        ).all(
          canonical.tenantId,
          canonical.scope,
          canonical.sessionKey,
        ) as LeaseEventRow[];
        return Object.freeze(rows.map(eventFromRow));
      });
    },
  };
}
