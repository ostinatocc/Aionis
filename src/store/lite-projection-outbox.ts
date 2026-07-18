import { randomUUID } from "node:crypto";

import { sha256Hex } from "../util/crypto.js";
import { assertDim } from "../util/vector-literal.js";
import type { LiteRuntimeDatabase } from "./lite-runtime-database.js";

export const LITE_PROJECTION_JOB_KINDS = ["embedding_generate", "ann_reconcile"] as const;
export type LiteProjectionJobKind = (typeof LITE_PROJECTION_JOB_KINDS)[number];
export type LiteProjectionJobStatus = "pending" | "running" | "retry" | "dead_letter" | "succeeded";

export type LiteEmbeddingProjectionPayload = {
  v: 1;
  tenant_id: string;
  scope: string;
  scope_key: string;
  commit_id: string;
  node_id: string;
  embed_text: string;
  embed_text_sha256: string;
  provider_name: string;
  provider_dim: number;
  force_reembed: boolean;
  recovery_origin: "semantic_commit" | "legacy_recovery";
};

export type LiteAnnProjectionPayload = {
  v: 1;
  scope_key: string;
  node_id: string;
  source_commit_id: string | null;
  action: "reconcile_from_sqlite_truth";
};

export type LiteProjectionJobRow = {
  scope: string;
  node_id: string;
  job_kind: LiteProjectionJobKind;
  generation: number;
  source_commit_id: string | null;
  payload_sha256: string;
  payload_json: string | null;
  status: LiteProjectionJobStatus;
  attempt_count: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type LiteProjectionJobClaim = LiteProjectionJobRow & {
  lease_owner: string;
  lease_token: string;
  lease_expires_at: string;
};

export type LiteEmbeddingProjectionJobClaim = LiteProjectionJobClaim & { job_kind: "embedding_generate" };
export type LiteAnnProjectionJobClaim = LiteProjectionJobClaim & { job_kind: "ann_reconcile" };

export type LiteProjectionBacklogSnapshot = {
  pending: number;
  running: number;
  retry: number;
  dead_letter: number;
  succeeded: number;
  provider_mismatch: number;
  oldest_available_at: string | null;
  oldest_lease_expiry: string | null;
  legacy_pending_unrecoverable: number;
};

export type LiteProjectionOutboxAccess = {
  enqueueEmbeddingProjection(args: {
    scope: string;
    nodeId: string;
    sourceCommitId: string;
    payload: LiteEmbeddingProjectionPayload;
  }): Promise<LiteProjectionJobRow>;
  enqueueAnnProjection(args: {
    scope: string;
    nodeId: string;
    sourceCommitId?: string | null;
  }): Promise<LiteProjectionJobRow>;
  markEmbeddingProjectionSatisfied(args: {
    scope: string;
    nodeId: string;
    sourceCommitId?: string | null;
    enqueueAnn: boolean;
  }): Promise<void>;
  refreshEmbeddingProjection(args: {
    scope: string;
    nodeId: string;
    sourceCommitId: string;
    /** Null rebinds an outstanding projection to a new non-text authority commit. */
    embedText: string | null;
  }): Promise<boolean>;
  claimProjectionJobs(args: {
    leaseOwner: string;
    leaseMs: number;
    limit: number;
    jobKinds?: LiteProjectionJobKind[];
    scopes?: string[];
    nodeIds?: string[];
    now?: Date;
  }): Promise<LiteProjectionJobClaim[]>;
  completeEmbeddingProjection(args: {
    claim: LiteEmbeddingProjectionJobClaim;
    embedding: number[];
    embeddingModel: string;
    enqueueAnn: boolean;
  }): Promise<"applied" | "node_missing" | "stale_claim" | "invalid_payload" | "source_changed">;
  completeAnnProjection(args: {
    claim: LiteAnnProjectionJobClaim;
  }): Promise<boolean>;
  requeueAnnProjectionAfterStaleSideEffect(args: {
    scope: string;
    nodeId: string;
  }): Promise<void>;
  retryProjectionJob(args: {
    claim: LiteProjectionJobClaim;
    error: string;
    retryAt: Date;
  }): Promise<boolean>;
  deadLetterProjectionJob(args: {
    claim: LiteProjectionJobClaim;
    error: string;
  }): Promise<boolean>;
  listProjectionJobs(args?: {
    statuses?: LiteProjectionJobStatus[];
    jobKinds?: LiteProjectionJobKind[];
    limit?: number;
  }): Promise<LiteProjectionJobRow[]>;
  projectionBacklogSnapshot(): LiteProjectionBacklogSnapshot;
};

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function clampLimit(value: number | undefined, max = 200): number {
  return Math.max(1, Math.min(max, Math.trunc(value ?? 20)));
}

function sanitizeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1000) || "projection_failed";
}

function projectionPayloadJson(payload: LiteEmbeddingProjectionPayload | LiteAnnProjectionPayload): string {
  return JSON.stringify(payload);
}

function projectionPayloadSha(payloadJson: string): string {
  return sha256Hex(payloadJson);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function statementChanges(value: unknown): number {
  return Number((value as { changes?: number } | null | undefined)?.changes ?? 0);
}

export function parseEmbeddingProjectionPayload(row: LiteProjectionJobRow): LiteEmbeddingProjectionPayload | null {
  if (row.job_kind !== "embedding_generate" || !row.payload_json) return null;
  if (projectionPayloadSha(row.payload_json) !== row.payload_sha256) return null;
  try {
    const value = JSON.parse(row.payload_json) as Partial<LiteEmbeddingProjectionPayload>;
    if (
      value.v !== 1
      || typeof value.tenant_id !== "string"
      || typeof value.scope !== "string"
      || value.scope_key !== row.scope
      || typeof value.commit_id !== "string"
      || value.commit_id !== row.source_commit_id
      || value.node_id !== row.node_id
      || typeof value.embed_text !== "string"
      || !value.embed_text.trim()
      || typeof value.embed_text_sha256 !== "string"
      || sha256Hex(value.embed_text) !== value.embed_text_sha256
      || typeof value.provider_name !== "string"
      || !value.provider_name.trim()
      || !Number.isInteger(value.provider_dim)
      || Number(value.provider_dim) <= 0
      || typeof value.force_reembed !== "boolean"
      || (value.recovery_origin !== "semantic_commit" && value.recovery_origin !== "legacy_recovery")
    ) {
      return null;
    }
    return value as LiteEmbeddingProjectionPayload;
  } catch {
    return null;
  }
}

export function parseAnnProjectionPayload(row: LiteProjectionJobRow): LiteAnnProjectionPayload | null {
  if (row.job_kind !== "ann_reconcile" || !row.payload_json) return null;
  if (projectionPayloadSha(row.payload_json) !== row.payload_sha256) return null;
  try {
    const value = JSON.parse(row.payload_json) as Partial<LiteAnnProjectionPayload>;
    if (
      value.v !== 1
      || value.scope_key !== row.scope
      || value.node_id !== row.node_id
      || value.action !== "reconcile_from_sqlite_truth"
      || (value.source_commit_id !== null && typeof value.source_commit_id !== "string")
      || value.source_commit_id !== row.source_commit_id
    ) {
      return null;
    }
    return value as LiteAnnProjectionPayload;
  } catch {
    return null;
  }
}

export function createLiteProjectionOutboxAccess(database: LiteRuntimeDatabase): LiteProjectionOutboxAccess {
  const { db, transaction } = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lite_memory_projection_jobs (
      scope TEXT NOT NULL,
      node_id TEXT NOT NULL,
      job_kind TEXT NOT NULL,
      generation INTEGER NOT NULL,
      source_commit_id TEXT,
      payload_sha256 TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, node_id, job_kind),
      CHECK (job_kind IN ('embedding_generate', 'ann_reconcile')),
      CHECK (status IN ('pending', 'running', 'retry', 'dead_letter', 'succeeded'))
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_projection_jobs_available
      ON lite_memory_projection_jobs(status, available_at, job_kind, updated_at);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_projection_jobs_lease
      ON lite_memory_projection_jobs(lease_expires_at)
      WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS idx_lite_memory_projection_jobs_scope_node
      ON lite_memory_projection_jobs(scope, node_id);
  `);

  const rowFor = (scope: string, nodeId: string, kind: LiteProjectionJobKind): LiteProjectionJobRow => {
    const row = db.prepare(
      `SELECT scope, node_id, job_kind, generation, source_commit_id,
              payload_sha256, payload_json, status, attempt_count, available_at,
              lease_owner, lease_token, lease_expires_at, last_error, created_at, updated_at
       FROM lite_memory_projection_jobs
       WHERE scope = ? AND node_id = ? AND job_kind = ?`,
    ).get(scope, nodeId, kind) as LiteProjectionJobRow | undefined;
    if (!row) throw new Error(`projection job was not persisted: ${kind}:${scope}:${nodeId}`);
    return row;
  };

  const enqueue = (args: {
    scope: string;
    nodeId: string;
    kind: LiteProjectionJobKind;
    sourceCommitId: string | null;
    payloadJson: string;
  }): LiteProjectionJobRow => {
    const ts = nowIso();
    db.prepare(
      `INSERT INTO lite_memory_projection_jobs
         (scope, node_id, job_kind, generation, source_commit_id,
          payload_sha256, payload_json, status, attempt_count, available_at,
          lease_owner, lease_token, lease_expires_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(scope, node_id, job_kind) DO UPDATE SET
         generation = lite_memory_projection_jobs.generation + 1,
         source_commit_id = excluded.source_commit_id,
         payload_sha256 = excluded.payload_sha256,
         payload_json = excluded.payload_json,
         status = 'pending',
         attempt_count = 0,
         available_at = excluded.available_at,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      args.scope,
      args.nodeId,
      args.kind,
      args.sourceCommitId,
      projectionPayloadSha(args.payloadJson),
      args.payloadJson,
      ts,
      ts,
      ts,
    );
    return rowFor(args.scope, args.nodeId, args.kind);
  };

  const enqueueAnn = (args: {
    scope: string;
    nodeId: string;
    sourceCommitId: string | null;
  }): LiteProjectionJobRow => {
    const payload: LiteAnnProjectionPayload = {
      v: 1,
      scope_key: args.scope,
      node_id: args.nodeId,
      source_commit_id: args.sourceCommitId,
      action: "reconcile_from_sqlite_truth",
    };
    return enqueue({
      scope: args.scope,
      nodeId: args.nodeId,
      kind: "ann_reconcile",
      sourceCommitId: args.sourceCommitId,
      payloadJson: projectionPayloadJson(payload),
    });
  };

  const claimMatches = (claim: LiteProjectionJobClaim): unknown[] => [
    claim.scope,
    claim.node_id,
    claim.job_kind,
    claim.generation,
    claim.lease_owner,
    claim.lease_token,
  ];

  return {
    async enqueueEmbeddingProjection(args): Promise<LiteProjectionJobRow> {
      if (!transaction.inTransaction()) {
        throw new Error("embedding projection must be enqueued inside the semantic SQLite transaction");
      }
      if (
        args.payload.v !== 1
        || args.payload.scope_key !== args.scope
        || args.payload.node_id !== args.nodeId
        || args.payload.commit_id !== args.sourceCommitId
        || !args.payload.tenant_id.trim()
        || !args.payload.scope.trim()
        || !args.payload.embed_text.trim()
        || sha256Hex(args.payload.embed_text) !== args.payload.embed_text_sha256
        || !args.payload.provider_name.trim()
        || !Number.isInteger(args.payload.provider_dim)
        || args.payload.provider_dim <= 0
      ) {
        throw new Error("invalid durable embedding projection payload");
      }
      const payloadJson = projectionPayloadJson(args.payload);
      const row = enqueue({
        scope: args.scope,
        nodeId: args.nodeId,
        kind: "embedding_generate",
        sourceCommitId: args.sourceCommitId,
        payloadJson,
      });
      db.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_status = CASE WHEN embedding_status = 'ready' THEN embedding_status ELSE 'pending' END,
             embedding_last_error = CASE WHEN embedding_status = 'ready' THEN embedding_last_error ELSE NULL END
         WHERE scope = ? AND id = ?`,
      ).run(args.scope, args.nodeId);
      return row;
    },

    async enqueueAnnProjection(args): Promise<LiteProjectionJobRow> {
      if (!transaction.inTransaction()) {
        throw new Error("ANN projection must be enqueued inside the SQLite mutation transaction");
      }
      return enqueueAnn({
        scope: args.scope,
        nodeId: args.nodeId,
        sourceCommitId: args.sourceCommitId ?? null,
      });
    },

    async markEmbeddingProjectionSatisfied(args): Promise<void> {
      if (!transaction.inTransaction()) {
        throw new Error("embedding projection completion must share the SQLite mutation transaction");
      }
      const ts = nowIso();
      db.prepare(
        `UPDATE lite_memory_projection_jobs
         SET status = 'succeeded', lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
             available_at = ?, updated_at = ?
         WHERE scope = ? AND node_id = ? AND job_kind = 'embedding_generate'`,
      ).run(ts, ts, args.scope, args.nodeId);
      if (args.enqueueAnn) {
        enqueueAnn({
          scope: args.scope,
          nodeId: args.nodeId,
          sourceCommitId: args.sourceCommitId ?? null,
        });
      }
    },

    async refreshEmbeddingProjection(args): Promise<boolean> {
      if (!transaction.inTransaction()) {
        throw new Error("embedding projection refresh must share the SQLite mutation transaction");
      }
      const current = db.prepare(
        `SELECT scope, node_id, job_kind, generation, source_commit_id,
                payload_sha256, payload_json, status, attempt_count, available_at,
                lease_owner, lease_token, lease_expires_at, last_error, created_at, updated_at
         FROM lite_memory_projection_jobs
         WHERE scope = ? AND node_id = ? AND job_kind = 'embedding_generate'`,
      ).get(args.scope, args.nodeId) as LiteProjectionJobRow | undefined;
      const prior = current ? parseEmbeddingProjectionPayload(current) : null;
      const embedText = args.embedText === null ? prior?.embed_text ?? "" : args.embedText.trim();
      if (!prior || !embedText) return false;
      const payload: LiteEmbeddingProjectionPayload = {
        ...prior,
        commit_id: args.sourceCommitId,
        embed_text: embedText,
        embed_text_sha256: sha256Hex(embedText),
      };
      enqueue({
        scope: args.scope,
        nodeId: args.nodeId,
        kind: "embedding_generate",
        sourceCommitId: args.sourceCommitId,
        payloadJson: projectionPayloadJson(payload),
      });
      return true;
    },

    async claimProjectionJobs(args): Promise<LiteProjectionJobClaim[]> {
      const leaseOwner = args.leaseOwner.trim();
      if (!leaseOwner) throw new Error("projection lease owner is required");
      const leaseMs = Math.max(1_000, Math.min(15 * 60_000, Math.trunc(args.leaseMs)));
      const limit = clampLimit(args.limit);
      const kinds = Array.from(new Set(args.jobKinds ?? LITE_PROJECTION_JOB_KINDS));
      const scopes = Array.from(new Set((args.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))).slice(0, 100);
      const nodeIds = Array.from(new Set((args.nodeIds ?? []).map((id) => id.trim()).filter(Boolean))).slice(0, 500);
      if (kinds.length === 0) return [];
      const now = args.now ?? new Date();
      const nowValue = nowIso(now);
      const leaseExpiry = nowIso(new Date(now.getTime() + leaseMs));

      return await database.withTx(async () => {
        const where = [
          `job_kind IN (${placeholders(kinds.length)})`,
          `((status IN ('pending', 'retry') AND available_at <= ?) OR (status = 'running' AND lease_expires_at <= ?))`,
        ];
        const values: unknown[] = [...kinds, nowValue, nowValue];
        if (scopes.length > 0) {
          where.push(`scope IN (${placeholders(scopes.length)})`);
          values.push(...scopes);
        }
        if (nodeIds.length > 0) {
          where.push(`node_id IN (${placeholders(nodeIds.length)})`);
          values.push(...nodeIds);
        }
        values.push(limit);
        const candidates = db.prepare(
          `SELECT scope, node_id, job_kind, generation
           FROM lite_memory_projection_jobs
           WHERE ${where.join(" AND ")}
           ORDER BY available_at ASC, updated_at ASC, scope ASC, node_id ASC, job_kind ASC
           LIMIT ?`,
        ).all(...values) as Array<{
          scope: string;
          node_id: string;
          job_kind: LiteProjectionJobKind;
          generation: number;
        }>;
        const claimed: LiteProjectionJobClaim[] = [];
        for (const candidate of candidates) {
          const leaseToken = randomUUID();
          const updated = db.prepare(
            `UPDATE lite_memory_projection_jobs
             SET status = 'running', attempt_count = attempt_count + 1,
                 lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
             WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
               AND ((status IN ('pending', 'retry') AND available_at <= ?)
                 OR (status = 'running' AND lease_expires_at <= ?))`,
          ).run(
            leaseOwner,
            leaseToken,
            leaseExpiry,
            nowValue,
            candidate.scope,
            candidate.node_id,
            candidate.job_kind,
            candidate.generation,
            nowValue,
            nowValue,
          );
          if (statementChanges(updated) !== 1) continue;
          claimed.push(rowFor(candidate.scope, candidate.node_id, candidate.job_kind) as LiteProjectionJobClaim);
        }
        return claimed;
      });
    },

    async completeEmbeddingProjection(args): Promise<"applied" | "node_missing" | "stale_claim" | "invalid_payload" | "source_changed"> {
      if (args.claim.job_kind !== "embedding_generate") {
        throw new Error("embedding projection completion requires an embedding_generate claim");
      }
      assertDim(args.embedding, 1536);
      return await database.withTx(async () => {
        const claim = args.claim;
        const current = db.prepare(
          `SELECT 1 AS ok FROM lite_memory_projection_jobs
           WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
             AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        ).get(...claimMatches(claim)) as { ok: number } | undefined;
        if (!current) return "stale_claim";
        const persistedJob = rowFor(claim.scope, claim.node_id, "embedding_generate");
        const payload = parseEmbeddingProjectionPayload(persistedJob);
        if (!payload) {
          db.prepare(
            `UPDATE lite_memory_projection_jobs
             SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL, last_error = 'invalid_embedding_projection_payload', updated_at = ?
             WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
               AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
          ).run(nowIso(), ...claimMatches(claim));
          db.prepare(
            `UPDATE lite_memory_nodes
             SET embedding_status = CASE WHEN embedding_status = 'ready' THEN embedding_status ELSE 'failed' END,
                 embedding_last_error = CASE WHEN embedding_status = 'ready' THEN embedding_last_error ELSE 'invalid_embedding_projection_payload' END
             WHERE scope = ? AND id = ?`,
          ).run(claim.scope, claim.node_id);
          return "invalid_payload";
        }
        if (args.embeddingModel.trim() !== payload.provider_name || args.embedding.length !== payload.provider_dim) {
          throw new Error("embedding projection result does not match the bound provider contract");
        }
        const node = db.prepare(
          `SELECT commit_id FROM lite_memory_nodes WHERE scope = ? AND id = ?`,
        ).get(claim.scope, claim.node_id) as { commit_id: string } | undefined;
        const ts = nowIso();
        if (!node) {
          db.prepare(
            `UPDATE lite_memory_projection_jobs
             SET status = 'succeeded', lease_owner = NULL,
                 lease_token = NULL, lease_expires_at = NULL,
                 last_error = 'node_missing', available_at = ?, updated_at = ?
             WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
               AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
          ).run(ts, ts, ...claimMatches(claim));
          return "node_missing";
        }
        if (node.commit_id !== payload.commit_id) {
          db.prepare(
            `UPDATE lite_memory_projection_jobs
             SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL, last_error = 'embedding_source_commit_changed', updated_at = ?
             WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
               AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
          ).run(nowIso(), ...claimMatches(claim));
          db.prepare(
            `UPDATE lite_memory_nodes
             SET embedding_status = CASE WHEN embedding_status = 'ready' THEN embedding_status ELSE 'failed' END,
                 embedding_last_error = CASE WHEN embedding_status = 'ready' THEN embedding_last_error ELSE 'embedding_source_commit_changed' END
             WHERE scope = ? AND id = ?`,
          ).run(claim.scope, claim.node_id);
          return "source_changed";
        }
        db.prepare(
          `UPDATE lite_memory_nodes
           SET embedding_vector_json = ?, embedding_model = ?,
               embedding_status = 'ready', embedding_last_error = NULL
           WHERE scope = ? AND id = ?`,
        ).run(JSON.stringify(args.embedding), args.embeddingModel, claim.scope, claim.node_id);
        db.prepare(
          `UPDATE lite_memory_projection_jobs
           SET status = 'succeeded', lease_owner = NULL,
               lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
               available_at = ?, updated_at = ?
           WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
             AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        ).run(ts, ts, ...claimMatches(claim));
        if (args.enqueueAnn) {
          enqueueAnn({
            scope: claim.scope,
            nodeId: claim.node_id,
            sourceCommitId: node.commit_id,
          });
        }
        return "applied";
      });
    },

    async completeAnnProjection(args): Promise<boolean> {
      if (args.claim.job_kind !== "ann_reconcile") {
        throw new Error("ANN projection completion requires an ann_reconcile claim");
      }
      return await database.withTx(async () => {
        const current = db.prepare(
          `SELECT 1 AS ok FROM lite_memory_projection_jobs
           WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
             AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        ).get(...claimMatches(args.claim)) as { ok: number } | undefined;
        if (!current) return false;
        const persistedJob = rowFor(args.claim.scope, args.claim.node_id, "ann_reconcile");
        if (!parseAnnProjectionPayload(persistedJob)) {
          db.prepare(
            `UPDATE lite_memory_projection_jobs
             SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL, last_error = 'invalid_ann_projection_payload', updated_at = ?
             WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
               AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
          ).run(nowIso(), ...claimMatches(args.claim));
          return false;
        }
        const ts = nowIso();
        const updated = db.prepare(
          `UPDATE lite_memory_projection_jobs
           SET status = 'succeeded', payload_json = NULL, lease_owner = NULL,
               lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
               available_at = ?, updated_at = ?
           WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
             AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        ).run(ts, ts, ...claimMatches(args.claim));
        return statementChanges(updated) === 1;
      });
    },

    async requeueAnnProjectionAfterStaleSideEffect(args): Promise<void> {
      await database.withTx(async () => {
        const node = db.prepare(
          `SELECT commit_id FROM lite_memory_nodes WHERE scope = ? AND id = ?`,
        ).get(args.scope, args.nodeId) as { commit_id: string } | undefined;
        enqueueAnn({
          scope: args.scope,
          nodeId: args.nodeId,
          sourceCommitId: node?.commit_id ?? null,
        });
      });
    },

    async retryProjectionJob(args): Promise<boolean> {
      return await database.withTx(async () => {
        const updated = db.prepare(
          `UPDATE lite_memory_projection_jobs
           SET status = 'retry', available_at = ?, lease_owner = NULL,
               lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
             AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        ).run(
          nowIso(args.retryAt),
          sanitizeError(args.error),
          nowIso(),
          ...claimMatches(args.claim),
        );
        if (statementChanges(updated) === 1 && args.claim.job_kind === "embedding_generate") {
          db.prepare(
            `UPDATE lite_memory_nodes
             SET embedding_status = CASE WHEN embedding_status = 'ready' THEN embedding_status ELSE 'pending' END,
                 embedding_last_error = CASE WHEN embedding_status = 'ready' THEN embedding_last_error ELSE ? END
             WHERE scope = ? AND id = ?`,
          ).run(sanitizeError(args.error), args.claim.scope, args.claim.node_id);
        }
        return statementChanges(updated) === 1;
      });
    },

    async deadLetterProjectionJob(args): Promise<boolean> {
      return await database.withTx(async () => {
        const error = sanitizeError(args.error);
        const updated = db.prepare(
          `UPDATE lite_memory_projection_jobs
           SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE scope = ? AND node_id = ? AND job_kind = ? AND generation = ?
             AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        ).run(error, nowIso(), ...claimMatches(args.claim));
        const completed = statementChanges(updated) === 1;
        if (completed && args.claim.job_kind === "embedding_generate") {
          db.prepare(
            `UPDATE lite_memory_nodes
             SET embedding_status = CASE WHEN embedding_status = 'ready' THEN embedding_status ELSE 'failed' END,
                 embedding_last_error = CASE WHEN embedding_status = 'ready' THEN embedding_last_error ELSE ? END
             WHERE scope = ? AND id = ?`,
          ).run(error, args.claim.scope, args.claim.node_id);
        }
        return completed;
      });
    },

    async listProjectionJobs(args = {}): Promise<LiteProjectionJobRow[]> {
      return await transaction.read(() => {
        const statuses = Array.from(new Set(args.statuses ?? []));
        const kinds = Array.from(new Set(args.jobKinds ?? []));
        const where: string[] = [];
        const values: unknown[] = [];
        if (statuses.length > 0) {
          where.push(`status IN (${placeholders(statuses.length)})`);
          values.push(...statuses);
        }
        if (kinds.length > 0) {
          where.push(`job_kind IN (${placeholders(kinds.length)})`);
          values.push(...kinds);
        }
        values.push(clampLimit(args.limit, 1000));
        return db.prepare(
          `SELECT scope, node_id, job_kind, generation, source_commit_id,
                  payload_sha256, payload_json, status, attempt_count, available_at,
                  lease_owner, lease_token, lease_expires_at, last_error, created_at, updated_at
           FROM lite_memory_projection_jobs
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY updated_at ASC, scope ASC, node_id ASC, job_kind ASC
           LIMIT ?`,
        ).all(...values) as LiteProjectionJobRow[];
      });
    },

    projectionBacklogSnapshot(): LiteProjectionBacklogSnapshot {
      const counts = database.readDb.prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry,
           SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN last_error LIKE 'embedding_provider_mismatch:%' THEN 1 ELSE 0 END) AS provider_mismatch,
           MIN(CASE WHEN status IN ('pending', 'retry') THEN available_at ELSE NULL END) AS oldest_available_at,
           MIN(CASE WHEN status = 'running' THEN lease_expires_at ELSE NULL END) AS oldest_lease_expiry
         FROM lite_memory_projection_jobs`,
      ).get() as {
        pending: number | null;
        running: number | null;
        retry: number | null;
        dead_letter: number | null;
        succeeded: number | null;
        provider_mismatch: number | null;
        oldest_available_at: string | null;
        oldest_lease_expiry: string | null;
      };
      const legacyPending = database.readDb.prepare(
        `SELECT COUNT(*) AS count
         FROM lite_memory_nodes AS node
         WHERE node.embedding_status = 'pending'
           AND (
             NOT EXISTS (
               SELECT 1 FROM lite_memory_projection_jobs AS job
               WHERE job.scope = node.scope AND job.node_id = node.id
                 AND job.job_kind = 'embedding_generate'
             )
             OR EXISTS (
               SELECT 1 FROM lite_memory_projection_jobs AS job
               WHERE job.scope = node.scope AND job.node_id = node.id
                 AND job.job_kind = 'embedding_generate'
                 AND job.status = 'succeeded'
             )
           )`,
      ).get() as { count: number };
      return {
        pending: counts.pending ?? 0,
        running: counts.running ?? 0,
        retry: counts.retry ?? 0,
        dead_letter: counts.dead_letter ?? 0,
        succeeded: counts.succeeded ?? 0,
        provider_mismatch: counts.provider_mismatch ?? 0,
        oldest_available_at: counts.oldest_available_at,
        oldest_lease_expiry: counts.oldest_lease_expiry,
        legacy_pending_unrecoverable: legacyPending.count,
      };
    },
  };
}
