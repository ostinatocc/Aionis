import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AionisClaimWriteSchema, type AionisClaimWrite } from "../memory/claim-ledger-contract.js";
import type {
  ClaimLedgerAccess,
  ClaimLedgerEventRow,
  ClaimLedgerRow,
  ClaimLedgerStatus,
} from "./memory-store.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.js";
import { createSqliteTransactionRunner, type SqliteTransactionRunner } from "./sqlite-transaction-runner.js";

export type LiteClaimLedgerStore = {
  createClaimLedgerAccess(): ClaimLedgerAccess;
  close(): Promise<void>;
  healthSnapshot(): { path: string; mode: "sqlite_claim_ledger_v1" };
};

type WriteClaimArgs = {
  scope: string;
  tenantId: string;
  claim: AionisClaimWrite;
  now?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function jsonColumnValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function claimIdFor(args: { tenantId: string; scope: string; clientId?: string | null }): string {
  if (!args.clientId) return `claim_${randomUUID()}`;
  const hash = createHash("sha256")
    .update(JSON.stringify({ tenant_id: args.tenantId, scope: args.scope, client_id: args.clientId }))
    .digest("hex")
    .slice(0, 32);
  return `claim_${hash}`;
}

function eventIdFor(args: { scope: string; claimId: string; type: string; at: string; reason: string }): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(args))
    .digest("hex")
    .slice(0, 32);
  return `claim_event_${hash}`;
}

function normalizeLimit(limit: number, fallback = 50): number {
  return Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : fallback;
}

function statusForClaim(claim: AionisClaimWrite): ClaimLedgerStatus {
  if (claim.authority === "blocked") return "retired";
  if (claim.conflict_policy === "manual_or_inspect") return "contested";
  return "active";
}

function rowFromUnknown(row: unknown): ClaimLedgerRow {
  const next = row as ClaimLedgerRow;
  return {
    ...next,
    confidence: Number(next.confidence),
  };
}

function eventFromUnknown(row: unknown): ClaimLedgerEventRow {
  return row as ClaimLedgerEventRow;
}

function migrate(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS lite_claim_ledger_claims (
      claim_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      client_id TEXT,
      subject_key TEXT NOT NULL,
      predicate TEXT NOT NULL,
      slot_key TEXT,
      value_json TEXT NOT NULL,
      value_text TEXT,
      claim_kind TEXT NOT NULL,
      conflict_policy TEXT NOT NULL,
      authority TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      source_memory_id TEXT,
      evidence_refs_json TEXT NOT NULL,
      supersedes_claim_ids_json TEXT NOT NULL,
      superseded_by_claim_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    DROP INDEX IF EXISTS idx_lite_claim_ledger_scope_client;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_lite_claim_ledger_tenant_scope_client
      ON lite_claim_ledger_claims(tenant_id, scope, client_id)
      WHERE client_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_lite_claim_ledger_live_slot
      ON lite_claim_ledger_claims(tenant_id, scope, slot_key, status, valid_until, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_lite_claim_ledger_subject
      ON lite_claim_ledger_claims(tenant_id, scope, subject_key, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS lite_claim_ledger_events (
      event_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lite_claim_ledger_events_claim
      ON lite_claim_ledger_events(scope, claim_id, created_at);
  `);
}

function claimAccessForDb(db: SqliteDatabase, transaction: SqliteTransactionRunner): ClaimLedgerAccess {
  const getByScopeClientStmt = db.prepare(`
    SELECT * FROM lite_claim_ledger_claims
    WHERE tenant_id = ? AND scope = ? AND client_id = ?
    LIMIT 1
  `);
  const getByIdStmt = db.prepare(`
    SELECT * FROM lite_claim_ledger_claims
    WHERE tenant_id = ? AND scope = ? AND claim_id = ?
    LIMIT 1
  `);
  const supersedableStmt = db.prepare(`
    SELECT * FROM lite_claim_ledger_claims
    WHERE tenant_id = ?
      AND scope = ?
      AND slot_key = ?
      AND status IN ('active', 'contested')
      AND valid_until IS NULL
    ORDER BY created_at DESC
  `);
  const updateSupersededStmt = db.prepare(`
    UPDATE lite_claim_ledger_claims
    SET status = 'superseded',
        valid_until = ?,
        superseded_by_claim_id = ?,
        updated_at = ?
    WHERE scope = ? AND claim_id = ?
  `);
  const insertClaimStmt = db.prepare(`
    INSERT INTO lite_claim_ledger_claims (
      claim_id, scope, tenant_id, client_id, subject_key, predicate, slot_key,
      value_json, value_text, claim_kind, conflict_policy, authority, confidence,
      status, valid_from, valid_until, source_memory_id, evidence_refs_json,
      supersedes_claim_ids_json, superseded_by_claim_id, metadata_json, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const insertEventStmt = db.prepare(`
    INSERT OR IGNORE INTO lite_claim_ledger_events (
      event_id, scope, tenant_id, claim_id, event_type, reason_code, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function insertEvent(args: {
    scope: string;
    tenantId: string;
    claimId: string;
    eventType: string;
    reasonCode: string;
    details: Record<string, unknown>;
    at: string;
  }): void {
    insertEventStmt.run(
      eventIdFor({
        scope: args.scope,
        claimId: args.claimId,
        type: args.eventType,
        at: args.at,
        reason: args.reasonCode,
      }),
      args.scope,
      args.tenantId,
      args.claimId,
      args.eventType,
      args.reasonCode,
      jsonColumnValue(args.details),
      args.at,
    );
  }

  return {
    async writeClaim(args: WriteClaimArgs): Promise<ClaimLedgerRow> {
      const parsed = AionisClaimWriteSchema.parse(args.claim);
      const at = args.now ?? nowIso();
      const validFrom = parsed.valid_from ?? at;
      const clientId = parsed.client_id ?? null;

      return await transaction.run(async () => {
        if (clientId) {
          const existing = getByScopeClientStmt.get(args.tenantId, args.scope, clientId);
          if (existing) return rowFromUnknown(existing);
        }

        const claimId = claimIdFor({ tenantId: args.tenantId, scope: args.scope, clientId });
        const status = statusForClaim(parsed);
        const supersededRows = parsed.conflict_policy === "singleton_latest" && parsed.slot_key && status === "active"
          ? supersedableStmt.all(args.tenantId, args.scope, parsed.slot_key).map(rowFromUnknown)
          : [];

        for (const row of supersededRows) {
          updateSupersededStmt.run(at, claimId, at, args.scope, row.claim_id);
          insertEvent({
            scope: args.scope,
            tenantId: row.tenant_id,
            claimId: row.claim_id,
            eventType: "claim_superseded",
            reasonCode: "singleton_latest_replaced",
            details: { superseded_by_claim_id: claimId, slot_key: parsed.slot_key },
            at,
          });
        }

        insertClaimStmt.run(
          claimId,
          args.scope,
          args.tenantId,
          clientId,
          parsed.subject_key,
          parsed.predicate,
          parsed.slot_key ?? null,
          jsonColumnValue(parsed.value),
          parsed.value_text ?? null,
          parsed.claim_kind,
          parsed.conflict_policy,
          parsed.authority,
          parsed.confidence,
          status,
          validFrom,
          null,
          parsed.source_memory_id ?? null,
          jsonColumnValue(parsed.evidence_refs),
          jsonColumnValue(supersededRows.map((row) => row.claim_id)),
          null,
          jsonColumnValue(parsed.metadata),
          at,
          at,
        );
        insertEvent({
          scope: args.scope,
          tenantId: args.tenantId,
          claimId,
          eventType: "claim_written",
          reasonCode: status === "active" ? "claim_active" : status === "contested" ? "claim_contested" : "claim_retired",
          details: {
            conflict_policy: parsed.conflict_policy,
            authority: parsed.authority,
            supersedes_claim_ids: supersededRows.map((row) => row.claim_id),
          },
          at,
        });

        const inserted = getByIdStmt.get(args.tenantId, args.scope, claimId);
        if (!inserted) throw new Error("claim ledger write did not return inserted claim");
        return rowFromUnknown(inserted);
      });
    },

    async findLiveClaims(args): Promise<{ rows: ClaimLedgerRow[] }> {
      const where = ["scope = ?", "status IN ('active', 'contested')", "valid_until IS NULL"];
      const values: unknown[] = [args.scope];
      if (args.tenantId) {
        where.unshift("tenant_id = ?");
        values.unshift(args.tenantId);
      }
      if (args.subjectKey) {
        where.push("subject_key = ?");
        values.push(args.subjectKey);
      }
      if (args.slotKey) {
        where.push("slot_key = ?");
        values.push(args.slotKey);
      }
      const rows = db.prepare(`
        SELECT * FROM lite_claim_ledger_claims
        WHERE ${where.join(" AND ")}
        ORDER BY valid_from DESC, created_at DESC
        LIMIT ?
      `).all(...values, normalizeLimit(args.limit)).map(rowFromUnknown);
      return { rows };
    },

    async findSupersededClaims(args): Promise<{ rows: ClaimLedgerRow[] }> {
      const where = ["scope = ?", "slot_key = ?", "status = 'superseded'"];
      const values: unknown[] = [args.scope, args.slotKey];
      if (args.tenantId) {
        where.unshift("tenant_id = ?");
        values.unshift(args.tenantId);
      }
      const rows = db.prepare(`
        SELECT * FROM lite_claim_ledger_claims
        WHERE ${where.join(" AND ")}
        ORDER BY valid_until DESC, created_at DESC
        LIMIT ?
      `).all(...values, normalizeLimit(args.limit)).map(rowFromUnknown);
      return { rows };
    },

    async getClaim(args): Promise<ClaimLedgerRow | null> {
      const row = args.tenantId
        ? getByIdStmt.get(args.tenantId, args.scope, args.claimId)
        : db.prepare(`
          SELECT * FROM lite_claim_ledger_claims
          WHERE scope = ? AND claim_id = ?
          LIMIT 1
        `).get(args.scope, args.claimId);
      return row ? rowFromUnknown(row) : null;
    },

    async listEvents(args): Promise<{ rows: ClaimLedgerEventRow[] }> {
      const limit = normalizeLimit(args.limit);
      const where = ["scope = ?"];
      const values: unknown[] = [args.scope];
      if (args.tenantId) {
        where.unshift("tenant_id = ?");
        values.unshift(args.tenantId);
      }
      if (args.claimId) {
        where.push("claim_id = ?");
        values.push(args.claimId);
      }
      const rows = db.prepare(`
        SELECT * FROM lite_claim_ledger_events
        WHERE ${where.join(" AND ")}
        ORDER BY created_at ASC
        LIMIT ?
      `).all(...values, limit).map(eventFromUnknown);
      return { rows };
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}

export function createLiteClaimLedgerStore(path: string): LiteClaimLedgerStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = createSqliteDatabase(path);
  migrate(db);
  const transaction = createSqliteTransactionRunner({
    begin: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  });
  return {
    createClaimLedgerAccess(): ClaimLedgerAccess {
      return claimAccessForDb(db, transaction);
    },
    async close(): Promise<void> {
      db.close();
    },
    healthSnapshot(): { path: string; mode: "sqlite_claim_ledger_v1" } {
      return { path, mode: "sqlite_claim_ledger_v1" };
    },
  };
}
