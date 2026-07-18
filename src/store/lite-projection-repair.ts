import { statSync } from "node:fs";
import { resolve } from "node:path";

import { nodeEmbedText } from "../memory/write-shared.js";
import { normalizeText } from "../util/normalize.js";
import { sha256Hex } from "../util/crypto.js";
import {
  parseAnnProjectionPayload,
  parseEmbeddingProjectionPayload,
  type LiteProjectionJobKind,
  type LiteProjectionJobRow,
  type LiteProjectionJobStatus,
} from "./lite-projection-outbox.js";
import { createLiteRuntimeDatabase } from "./lite-runtime-database.js";
import { createLiteWriteStoreFromDatabase } from "./lite-write-store.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export type LiteProjectionRepairJobSummary = Omit<LiteProjectionJobRow, "payload_json"> & {
  payload_present: boolean;
  payload_valid: boolean;
  source_commit_matches: boolean | null;
};

export type LiteLegacyEmbeddingCandidate = {
  scope: string;
  node_id: string;
  node_type: string;
  source_commit_id: string;
  recoverable: boolean;
  recovery_text_source: "text_summary" | "title" | null;
  reason: string | null;
};

export type LiteProjectionRepairState = {
  contract_version: "aionis_lite_projection_repair_state_v1";
  path: string;
  jobs: LiteProjectionRepairJobSummary[];
  legacy_pending: LiteLegacyEmbeddingCandidate[];
  totals: {
    jobs: number;
    dead_letters: number;
    legacy_pending: number;
    legacy_recoverable: number;
    legacy_unrecoverable: number;
  };
};

export type LiteProjectionRepairResult = {
  contract_version: "aionis_lite_projection_repair_result_v1";
  path: string;
  repaired: {
    legacy_embedding: number;
    dead_letter_embedding: number;
    dead_letter_ann: number;
    unrecoverable_marked_failed: number;
  };
  skipped: Array<{
    scope: string;
    node_id: string;
    job_kind: LiteProjectionJobKind;
    reason: string;
  }>;
  after: LiteProjectionRepairState;
};

type ProjectionNodeRow = {
  scope: string;
  id: string;
  type: string;
  title: string | null;
  text_summary: string | null;
  commit_id: string;
};

function assertDatabasePath(path: string): string {
  const absolute = resolve(path);
  if (!statSync(absolute).isFile()) throw new Error(`SQLite database path is not a file: ${absolute}`);
  return absolute;
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(5000, Math.trunc(value ?? 200)));
}

function recoveryText(node: ProjectionNodeRow, maxTextLen: number): {
  text: string | null;
  source: "text_summary" | "title" | null;
} {
  const raw = nodeEmbedText({
    id: node.id,
    scope: node.scope,
    type: node.type,
    ...(node.title ? { title: node.title } : {}),
    ...(node.text_summary ? { text_summary: node.text_summary } : {}),
  }, undefined);
  if (!raw?.trim()) return { text: null, source: null };
  const text = normalizeText(raw, maxTextLen);
  if (!text) return { text: null, source: null };
  return {
    text,
    source: node.text_summary?.trim() === raw.trim() ? "text_summary" : "title",
  };
}

function tenantScopeFromKey(scopeKey: string, defaultTenantId: string): {
  tenantId: string;
  publicScope: string;
} {
  const match = scopeKey.match(/^tenant:([a-zA-Z0-9._-]+)::scope:(.+)$/s);
  if (!match) return { tenantId: defaultTenantId, publicScope: scopeKey };
  return { tenantId: match[1], publicScope: match[2] };
}

function jobFilters(args: {
  statuses?: LiteProjectionJobStatus[];
  jobKinds?: LiteProjectionJobKind[];
  scope?: string;
  nodeId?: string;
}): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const statuses = Array.from(new Set(args.statuses ?? []));
  const kinds = Array.from(new Set(args.jobKinds ?? []));
  if (statuses.length > 0) {
    where.push(`job.status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  if (kinds.length > 0) {
    where.push(`job.job_kind IN (${placeholders(kinds.length)})`);
    params.push(...kinds);
  }
  if (args.scope) {
    where.push("job.scope = ?");
    params.push(args.scope);
  }
  if (args.nodeId) {
    where.push("job.node_id = ?");
    params.push(args.nodeId);
  }
  return { where, params };
}

function listJobs(
  db: SqliteDatabase,
  args: {
    statuses?: LiteProjectionJobStatus[];
    jobKinds?: LiteProjectionJobKind[];
    scope?: string;
    nodeId?: string;
    limit?: number;
  },
): LiteProjectionRepairJobSummary[] {
  if (!tableExists(db, "lite_memory_projection_jobs")) return [];
  const filter = jobFilters(args);
  const rows = db.prepare(
    `SELECT job.scope, job.node_id, job.job_kind, job.generation,
            job.source_commit_id, job.payload_sha256, job.payload_json,
            job.status, job.attempt_count, job.available_at, job.lease_owner,
            job.lease_token, job.lease_expires_at, job.last_error,
            job.created_at, job.updated_at,
            node.commit_id AS current_node_commit_id
     FROM lite_memory_projection_jobs AS job
     LEFT JOIN lite_memory_nodes AS node
       ON node.scope = job.scope AND node.id = job.node_id
     ${filter.where.length > 0 ? `WHERE ${filter.where.join(" AND ")}` : ""}
     ORDER BY job.updated_at ASC, job.scope ASC, job.node_id ASC, job.job_kind ASC
     LIMIT ?`,
  ).all(...filter.params, boundedLimit(args.limit)) as Array<LiteProjectionJobRow & {
    current_node_commit_id: string | null;
  }>;
  return rows.map((row) => {
    const payloadValid = row.job_kind === "embedding_generate"
      ? parseEmbeddingProjectionPayload(row) !== null
      : row.status === "succeeded" && row.payload_json === null
        ? true
        : parseAnnProjectionPayload(row) !== null;
    const sourceCommitMatches = row.job_kind === "embedding_generate"
      ? row.current_node_commit_id !== null && row.current_node_commit_id === row.source_commit_id
      : null;
    const { current_node_commit_id: _currentNodeCommitId, payload_json: payloadJson, ...job } = row;
    return {
      ...job,
      payload_present: payloadJson !== null,
      payload_valid: payloadValid,
      source_commit_matches: sourceCommitMatches,
    };
  });
}

function legacyCandidates(
  db: SqliteDatabase,
  args: { scope?: string; nodeId?: string; limit?: number; maxTextLen?: number },
): LiteLegacyEmbeddingCandidate[] {
  if (!tableExists(db, "lite_memory_nodes")) return [];
  const hasProjectionTable = tableExists(db, "lite_memory_projection_jobs");
  const where = ["node.embedding_status = 'pending'"];
  const params: unknown[] = [];
  if (hasProjectionTable) {
    where.push(
      `(NOT EXISTS (
          SELECT 1 FROM lite_memory_projection_jobs AS job
          WHERE job.scope = node.scope
            AND job.node_id = node.id
            AND job.job_kind = 'embedding_generate'
        ) OR EXISTS (
          SELECT 1 FROM lite_memory_projection_jobs AS job
          WHERE job.scope = node.scope
            AND job.node_id = node.id
            AND job.job_kind = 'embedding_generate'
            AND job.status = 'succeeded'
        ))`,
    );
  }
  if (args.scope) {
    where.push("node.scope = ?");
    params.push(args.scope);
  }
  if (args.nodeId) {
    where.push("node.id = ?");
    params.push(args.nodeId);
  }
  const rows = db.prepare(
    `SELECT node.scope, node.id, node.type, node.title, node.text_summary, node.commit_id
     FROM lite_memory_nodes AS node
     WHERE ${where.join(" AND ")}
     ORDER BY node.created_at ASC, node.scope ASC, node.id ASC
     LIMIT ?`,
  ).all(...params, boundedLimit(args.limit)) as ProjectionNodeRow[];
  return rows.map((node) => {
    const recovered = recoveryText(node, args.maxTextLen ?? 8000);
    return {
      scope: node.scope,
      node_id: node.id,
      node_type: node.type,
      source_commit_id: node.commit_id,
      recoverable: recovered.text !== null,
      recovery_text_source: recovered.source,
      reason: recovered.text === null ? "missing_text_summary_and_title" : null,
    };
  });
}

export async function inspectLiteProjectionRepairState(args: {
  path: string;
  statuses?: LiteProjectionJobStatus[];
  jobKinds?: LiteProjectionJobKind[];
  scope?: string;
  nodeId?: string;
  limit?: number;
  maxTextLen?: number;
}): Promise<LiteProjectionRepairState> {
  const absolute = assertDatabasePath(args.path);
  const db = createSqliteDatabase(absolute);
  try {
    const jobs = listJobs(db, args);
    const legacyPending = legacyCandidates(db, args);
    return {
      contract_version: "aionis_lite_projection_repair_state_v1",
      path: absolute,
      jobs,
      legacy_pending: legacyPending,
      totals: {
        jobs: jobs.length,
        dead_letters: jobs.filter((job) => job.status === "dead_letter").length,
        legacy_pending: legacyPending.length,
        legacy_recoverable: legacyPending.filter((candidate) => candidate.recoverable).length,
        legacy_unrecoverable: legacyPending.filter((candidate) => !candidate.recoverable).length,
      },
    };
  } finally {
    db.close();
  }
}

export async function repairLiteProjectionState(args: {
  path: string;
  providerName?: string;
  providerDim?: number;
  defaultTenantId?: string;
  scope?: string;
  nodeId?: string;
  limit?: number;
  maxTextLen?: number;
  repairLegacy?: boolean;
  repairDeadLetters?: boolean;
  repairEmbedding?: boolean;
  repairAnn?: boolean;
  markUnrecoverableFailed?: boolean;
}): Promise<LiteProjectionRepairResult> {
  const absolute = assertDatabasePath(args.path);
  const limit = boundedLimit(args.limit);
  const maxTextLen = Math.max(1, Math.trunc(args.maxTextLen ?? 8000));
  const repairLegacy = args.repairLegacy ?? true;
  const repairDeadLetters = args.repairDeadLetters ?? true;
  const repairEmbedding = args.repairEmbedding ?? true;
  const repairAnn = args.repairAnn ?? true;
  const database = createLiteRuntimeDatabase(absolute);
  const store = createLiteWriteStoreFromDatabase(database, {
    closeDatabaseOnClose: true,
    annProjectionEnabled: false,
  });

  const operation = await (async () => {
    try {
      return await store.withTx(async () => {
      const legacyRows = repairLegacy && repairEmbedding
        ? database.db.prepare(
            `SELECT node.scope, node.id, node.type, node.title, node.text_summary, node.commit_id
             FROM lite_memory_nodes AS node
             WHERE node.embedding_status = 'pending'
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM lite_memory_projection_jobs AS job
                   WHERE job.scope = node.scope
                     AND job.node_id = node.id
                     AND job.job_kind = 'embedding_generate'
                 )
                 OR EXISTS (
                   SELECT 1 FROM lite_memory_projection_jobs AS job
                   WHERE job.scope = node.scope
                     AND job.node_id = node.id
                     AND job.job_kind = 'embedding_generate'
                     AND job.status = 'succeeded'
                 )
               )
               ${args.scope ? "AND node.scope = ?" : ""}
               ${args.nodeId ? "AND node.id = ?" : ""}
             ORDER BY node.created_at ASC, node.scope ASC, node.id ASC
             LIMIT ?`,
          ).all(
            ...(args.scope ? [args.scope] : []),
            ...(args.nodeId ? [args.nodeId] : []),
            limit,
          ) as ProjectionNodeRow[]
        : [];

      const deadEmbeddingRows = repairDeadLetters && repairEmbedding
        ? database.db.prepare(
            `SELECT job.scope, job.node_id AS id, node.type, node.title,
                    node.text_summary, node.commit_id
             FROM lite_memory_projection_jobs AS job
             LEFT JOIN lite_memory_nodes AS node
               ON node.scope = job.scope AND node.id = job.node_id
             WHERE job.status = 'dead_letter'
               AND job.job_kind = 'embedding_generate'
               ${args.scope ? "AND job.scope = ?" : ""}
               ${args.nodeId ? "AND job.node_id = ?" : ""}
             ORDER BY job.updated_at ASC, job.scope ASC, job.node_id ASC
             LIMIT ?`,
          ).all(
            ...(args.scope ? [args.scope] : []),
            ...(args.nodeId ? [args.nodeId] : []),
            limit,
          ) as Array<ProjectionNodeRow & { type: string | null; commit_id: string | null }>
        : [];

      const deadAnnRows = repairDeadLetters && repairAnn
        ? database.db.prepare(
            `SELECT job.scope, job.node_id, node.commit_id
             FROM lite_memory_projection_jobs AS job
             LEFT JOIN lite_memory_nodes AS node
               ON node.scope = job.scope AND node.id = job.node_id
             WHERE job.status = 'dead_letter'
               AND job.job_kind = 'ann_reconcile'
               ${args.scope ? "AND job.scope = ?" : ""}
               ${args.nodeId ? "AND job.node_id = ?" : ""}
             ORDER BY job.updated_at ASC, job.scope ASC, job.node_id ASC
             LIMIT ?`,
          ).all(
            ...(args.scope ? [args.scope] : []),
            ...(args.nodeId ? [args.nodeId] : []),
            limit,
          ) as Array<{ scope: string; node_id: string; commit_id: string | null }>
        : [];

      const skipped: LiteProjectionRepairResult["skipped"] = [];
      const embeddingPlans: Array<{
        source: "legacy" | "dead_letter";
        node: ProjectionNodeRow;
        text: string;
      }> = [];
      const unrecoverableLegacyNodes: ProjectionNodeRow[] = [];
      for (const [source, rows] of [
        ["legacy", legacyRows],
        ["dead_letter", deadEmbeddingRows],
      ] as const) {
        for (const node of rows) {
          if (!node.type || !node.commit_id) {
            skipped.push({
              scope: node.scope,
              node_id: node.id,
              job_kind: "embedding_generate",
              reason: "node_missing",
            });
            continue;
          }
          const recovered = recoveryText(node as ProjectionNodeRow, maxTextLen);
          if (!recovered.text) {
            if (source === "legacy" && args.markUnrecoverableFailed) {
              unrecoverableLegacyNodes.push(node as ProjectionNodeRow);
              continue;
            }
            skipped.push({
              scope: node.scope,
              node_id: node.id,
              job_kind: "embedding_generate",
              reason: "missing_text_summary_and_title",
            });
            continue;
          }
          embeddingPlans.push({ source, node: node as ProjectionNodeRow, text: recovered.text });
        }
      }

      const providerName = args.providerName?.trim() ?? "";
      const providerDim = Number(args.providerDim ?? 0);
      if (embeddingPlans.length > 0 && (!providerName || providerDim !== 1536)) {
        throw new Error(
          "embedding projection repair requires --provider-name and --provider-dim 1536 before any repair is applied",
        );
      }

      let legacyEmbedding = 0;
      let deadLetterEmbedding = 0;
      let deadLetterAnn = 0;
      let unrecoverableMarkedFailed = 0;
      for (const plan of embeddingPlans) {
          const scopeRef = tenantScopeFromKey(plan.node.scope, args.defaultTenantId?.trim() || "default");
          await store.enqueueEmbeddingProjection({
            scope: plan.node.scope,
            nodeId: plan.node.id,
            sourceCommitId: plan.node.commit_id,
            payload: {
              v: 1,
              tenant_id: scopeRef.tenantId,
              scope: scopeRef.publicScope,
              scope_key: plan.node.scope,
              commit_id: plan.node.commit_id,
              node_id: plan.node.id,
              embed_text: plan.text,
              embed_text_sha256: sha256Hex(plan.text),
              provider_name: providerName,
              provider_dim: providerDim,
              force_reembed: true,
              recovery_origin: "legacy_recovery",
            },
          });
          if (plan.source === "legacy") legacyEmbedding += 1;
          else deadLetterEmbedding += 1;
      }
      for (const job of deadAnnRows) {
          await store.enqueueAnnProjection({
            scope: job.scope,
            nodeId: job.node_id,
            sourceCommitId: job.commit_id,
          });
          deadLetterAnn += 1;
      }
      for (const node of unrecoverableLegacyNodes) {
          await store.setNodeEmbeddingFailed({
            scope: node.scope,
            id: node.id,
            error: "legacy_embedding_source_text_unavailable",
          });
          unrecoverableMarkedFailed += 1;
      }
      return {
        legacyEmbedding,
        deadLetterEmbedding,
        deadLetterAnn,
        unrecoverableMarkedFailed,
        skipped,
      };
      });
    } finally {
      await store.close();
    }
  })();

  return {
    contract_version: "aionis_lite_projection_repair_result_v1",
    path: absolute,
    repaired: {
      legacy_embedding: operation.legacyEmbedding,
      dead_letter_embedding: operation.deadLetterEmbedding,
      dead_letter_ann: operation.deadLetterAnn,
      unrecoverable_marked_failed: operation.unrecoverableMarkedFailed,
    },
    skipped: operation.skipped,
    after: await inspectLiteProjectionRepairState({
      path: absolute,
      statuses: ["pending", "retry", "running", "dead_letter"],
      ...(args.scope ? { scope: args.scope } : {}),
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
      limit,
      maxTextLen,
    }),
  };
}
