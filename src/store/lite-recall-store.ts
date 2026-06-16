import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toVectorLiteral } from "../util/vector-literal.js";
import { hasNodeWorkflowAnchorSurface } from "../memory/node-execution-surface.js";
import { memoryNodeVisible } from "./memory-visibility.js";
import {
  RECALL_STORE_ACCESS_CAPABILITY_VERSION,
  adjustRecallCandidateSimilarityForTrust,
  normalizeRecallAllowedTiers,
  recallStage1BoundedScanLimit,
} from "./recall-access.js";
import type {
  RecallAuditInsertParams,
  RecallCandidate,
  RecallExecutionNativeParams,
  RecallHybridParams,
  RecallLexicalParams,
  RecallDebugEmbeddingRow,
  RecallEdgeRow,
  RecallNodeRow,
  RecallRuleDefRow,
  RecallStructuredParams,
  RecallStage1Params,
  RecallStage2EdgesParams,
  RecallStage2NodesParams,
  RecallStoreAccess,
  RecallStoreCapabilities,
} from "./recall-access.js";
import { createSqliteDatabase } from "./sqlite.js";

type LiteRecallNodeRow = {
  id: string;
  scope: string;
  type: string;
  tier: string;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots_json: string;
  raw_ref: string | null;
  evidence_ref: string | null;
  embedding_vector_json: string | null;
  embedding_model: string | null;
  embedding_status: string;
  salience: number;
  importance: number;
  confidence: number;
  created_at: string;
  commit_id: string | null;
};

type LiteRecallEdgeSourceRow = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight: number;
  confidence: number;
  decay_rate: number;
  metadata_json: string | null;
  created_at: string;
  commit_id: string | null;
};

type LiteRecallRuleRow = {
  rule_node_id: string;
  state: string;
  rule_scope: string;
  target_agent_id: string | null;
  target_team_id: string | null;
  if_json: string;
  then_json: string;
  exceptions_json: string;
};

type LiteRecallAuditRow = RecallAuditInsertParams & {
  created_at: string;
};

type LiteRecallKeywordRow = LiteRecallNodeRow & {
  lexical_title: string | null;
  lexical_text_summary: string | null;
  lexical_slots_text: string | null;
  lexical_searchable_text: string;
};

const STAGE1_RECALL_TYPES = ["event", "topic", "concept", "entity", "rule", "procedure", "self_model"] as const;
const SQLITE_IN_CHUNK_SIZE = 800;

export type LiteRecallStore = {
  createRecallAccess(): RecallStoreAccess;
  close(): Promise<void>;
  healthSnapshot(): { path: string; mode: "sqlite_recall_v1" };
};

function resolveRecallCapabilities(partial?: Partial<RecallStoreCapabilities>): RecallStoreCapabilities {
  return {
    debug_embeddings: partial?.debug_embeddings ?? true,
    audit_insert: partial?.audit_insert ?? true,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function appendRecallVisibilityWhere(
  where: string[],
  values: unknown[],
  consumerAgentId: string | null,
  consumerTeamId: string | null,
): void {
  const visibility: string[] = [
    "(memory_lane = 'shared' AND owner_team_id IS NULL)",
  ];
  if (consumerAgentId) {
    visibility.push("(memory_lane = 'shared' AND owner_agent_id = ?)");
    values.push(consumerAgentId);
    visibility.push("(memory_lane = 'private' AND owner_agent_id = ?)");
    values.push(consumerAgentId);
  }
  if (consumerTeamId) {
    visibility.push("(memory_lane = 'shared' AND owner_team_id = ?)");
    values.push(consumerTeamId);
    visibility.push("(memory_lane = 'private' AND owner_team_id = ?)");
    values.push(consumerTeamId);
  }
  where.push(`(${visibility.join(" OR ")})`);
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseEmbedding(raw: string | null | undefined): number[] | null {
  const parsed = parseJsonArray(raw);
  if (parsed.length === 0) return null;
  const numbers = parsed.map((v) => Number(v));
  if (numbers.some((v) => !Number.isFinite(v))) return null;
  return numbers;
}

function lexicalTerms(queryText: string): string[] {
  const tokens = queryText
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 12) break;
  }
  return out;
}

function lexicalMatchFields(row: Pick<LiteRecallKeywordRow, "lexical_title" | "lexical_text_summary" | "lexical_slots_text">, terms: string[]): string[] {
  const fields: Array<[string, string]> = [
    ["title", row.lexical_title ?? ""],
    ["text_summary", row.lexical_text_summary ?? ""],
    ["slots_text", row.lexical_slots_text ?? ""],
  ];
  const matched: string[] = [];
  for (const [field, value] of fields) {
    const lower = value.toLowerCase();
    if (terms.some((term) => lower.includes(term))) matched.push(field);
  }
  return matched;
}

function lexicalScore(row: LiteRecallKeywordRow, terms: string[], matchedFields: string[]): number {
  const searchable = row.lexical_searchable_text.toLowerCase();
  const matchedTermCount = terms.filter((term) => searchable.includes(term)).length;
  const fieldBonus = matchedFields.includes("title") ? 0.18 : matchedFields.includes("text_summary") ? 0.1 : 0;
  const raw = 0.35
    + Math.min(0.35, matchedTermCount * 0.08)
    + fieldBonus
    + Math.min(0.08, Math.max(0, row.salience) * 0.08)
    + Math.min(0.04, Math.max(0, row.confidence) * 0.04);
  return Math.max(0, Math.min(1, raw));
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 1;
  const similarity = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - similarity;
}

function candidateVisible(
  n: Pick<LiteRecallNodeRow, "memory_lane" | "owner_agent_id" | "owner_team_id">,
  consumerAgentId: string | null,
  consumerTeamId: string | null,
): boolean {
  return memoryNodeVisible(n, consumerAgentId, consumerTeamId);
}

function edgeSortDesc(a: LiteRecallEdgeSourceRow, b: LiteRecallEdgeSourceRow): number {
  return (b.weight - a.weight)
    || (b.confidence - a.confidence)
    || a.id.localeCompare(b.id);
}

function edgeToRecallRow(e: LiteRecallEdgeSourceRow): RecallEdgeRow {
  return {
    id: e.id,
    scope: e.scope,
    type: e.type,
    src_id: e.src_id,
    dst_id: e.dst_id,
    weight: e.weight,
    confidence: e.confidence,
    decay_rate: e.decay_rate,
    metadata: parseJsonObject(e.metadata_json),
    last_activated: null,
    created_at: e.created_at,
    commit_id: e.commit_id,
  };
}

function nodeToRecallRow(row: LiteRecallNodeRow, includeSlots: boolean): RecallNodeRow {
  const slots = parseJsonObject(row.slots_json);
  const topicState = row.type === "topic" ? String(slots.topic_state ?? "active") : null;
  const memberCountRaw = row.type === "topic" ? Number(slots.member_count ?? Number.NaN) : Number.NaN;
  return {
    id: row.id,
    scope: row.scope,
    type: row.type,
    tier: row.tier,
    memory_lane: row.memory_lane,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    title: row.title,
    text_summary: row.text_summary,
    slots: includeSlots ? slots : null,
    embedding_status: row.embedding_status,
    embedding_model: row.embedding_model,
    topic_state: topicState,
    member_count: Number.isFinite(memberCountRaw) ? memberCountRaw : null,
    raw_ref: row.raw_ref,
    evidence_ref: row.evidence_ref,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    last_activated: null,
    created_at: row.created_at,
    updated_at: row.created_at,
    commit_id: row.commit_id,
  };
}

function recallSurfaceAllowed(args: {
  db: ReturnType<typeof createSqliteDatabase>;
  scope: string;
  row: LiteRecallNodeRow;
  slots: Record<string, unknown>;
}): boolean {
  if (!(STAGE1_RECALL_TYPES as readonly string[]).includes(args.row.type)) return false;
  if (args.row.type === "procedure" && !hasNodeWorkflowAnchorSurface(args.slots)) return false;
  if ((args.row.type === "event" || args.row.type === "evidence")
    && String(args.slots.replay_learning_episode ?? "false") === "true"
    && String(args.slots.lifecycle_state ?? "active") === "archived") {
    return false;
  }
  if (args.row.type === "topic" && String(args.slots.topic_state ?? "active") !== "active") {
    return false;
  }
  if (args.row.type === "rule") {
    const def = args.db.prepare(`
      SELECT state
      FROM lite_memory_rule_defs
      WHERE scope = ? AND rule_node_id = ?
      LIMIT 1
    `).get(args.scope, args.row.id) as { state: string } | undefined;
    if (!def || (def.state !== "shadow" && def.state !== "active")) return false;
  }
  return true;
}

export function createLiteRecallStore(
  path: string,
  opts: { capabilities?: Partial<RecallStoreCapabilities> } = {},
): LiteRecallStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = createSqliteDatabase(path);
  const capabilities = resolveRecallCapabilities(opts.capabilities);

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS lite_memory_recall_audit (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      consumer_agent_id TEXT,
      consumer_team_id TEXT,
      query_sha256 TEXT NOT NULL,
      seed_count INTEGER NOT NULL,
      node_count INTEGER NOT NULL,
      edge_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_recall_audit_scope_created
      ON lite_memory_recall_audit(scope, created_at);

    CREATE TABLE IF NOT EXISTS lite_memory_keyword_index (
      scope TEXT NOT NULL,
      node_id TEXT NOT NULL,
      title TEXT,
      text_summary TEXT,
      slots_text TEXT NOT NULL,
      searchable_text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_keyword_scope_node
      ON lite_memory_keyword_index(scope, node_id);
  `);

  const fetchEdgesForNodeColumn = (
    column: "src_id" | "dst_id",
    ids: string[],
    params: RecallStage2EdgesParams,
    budget: number,
  ): LiteRecallEdgeSourceRow[] => {
    if (ids.length === 0 || budget <= 0) return [];
    const rows: LiteRecallEdgeSourceRow[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      const chunkRows = db.prepare(`
        SELECT id, scope, type, src_id, dst_id, weight, confidence, decay_rate, metadata_json, created_at, commit_id
        FROM lite_memory_edges
        WHERE scope = ?
          AND weight >= ?
          AND confidence >= ?
          AND ${column} IN (${placeholders(chunk.length)})
        ORDER BY weight DESC, confidence DESC, id ASC
        LIMIT ?
      `).all(
        params.scope,
        params.minEdgeWeight,
        params.minEdgeConfidence,
        ...chunk,
        budget,
      ) as LiteRecallEdgeSourceRow[];
      rows.push(...chunkRows);
    }
    return rows.sort(edgeSortDesc).slice(0, budget);
  };

  const fetchHopEdges = (
    ids: Set<string>,
    params: RecallStage2EdgesParams,
    budget: number,
  ): LiteRecallEdgeSourceRow[] => {
    if (ids.size === 0 || budget <= 0) return [];
    const idList = Array.from(ids);
    const fromSrc = fetchEdgesForNodeColumn("src_id", idList, params, budget);
    const fromDst = fetchEdgesForNodeColumn("dst_id", idList, params, budget);
    const merged = new Map<string, LiteRecallEdgeSourceRow>();
    for (const edge of fromSrc.concat(fromDst)) merged.set(edge.id, edge);
    return Array.from(merged.values()).sort(edgeSortDesc);
  };

  const stage1Candidates = async (
    params: RecallStage1Params,
    opts: {
      boundedScan: boolean;
      sourceKind: "semantic" | "exact_recovery";
      sourceReason: string;
      sourceIndexName: string;
    },
  ): Promise<RecallCandidate[]> => {
    const allowedTiers = normalizeRecallAllowedTiers(params.allowedTiers);
    const where = [
      "scope = ?",
      `tier IN (${placeholders(allowedTiers.length)})`,
      "embedding_status = 'ready'",
      "embedding_vector_json IS NOT NULL",
      `type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
    ];
    const values: unknown[] = [params.scope, ...allowedTiers, ...STAGE1_RECALL_TYPES];
    appendRecallVisibilityWhere(where, values, params.consumerAgentId, params.consumerTeamId);
    const limitClause = opts.boundedScan ? "LIMIT ?" : "";
    const limitValues = opts.boundedScan ? [recallStage1BoundedScanLimit(params)] : [];
    const rows = db.prepare(`
      SELECT
        id,
        scope,
        type,
        tier,
        memory_lane,
        producer_agent_id,
        owner_agent_id,
        owner_team_id,
        title,
        text_summary,
        slots_json,
        raw_ref,
        evidence_ref,
        embedding_vector_json,
        embedding_model,
        embedding_status,
        salience,
        importance,
        confidence,
        created_at,
        commit_id
      FROM lite_memory_nodes
      WHERE ${where.join("\n        AND ")}
      ORDER BY
        CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END,
        salience DESC,
        confidence DESC,
        created_at DESC,
        id DESC
      ${limitClause}
    `).all(...values, ...limitValues) as LiteRecallNodeRow[];

    const ranked: Array<{ row: LiteRecallNodeRow; distance: number }> = [];
    for (const row of rows) {
      const embedding = parseEmbedding(row.embedding_vector_json);
      if (!embedding) continue;
      if (!candidateVisible(row, params.consumerAgentId, params.consumerTeamId)) continue;
      ranked.push({ row, distance: cosineDistance(embedding, params.queryEmbedding) });
    }

    ranked.sort((a, b) => a.distance - b.distance || a.row.id.localeCompare(b.row.id));
    const knn = ranked.slice(0, Math.max(0, params.oversample));
    const out: Array<RecallCandidate & { distance: number }> = [];
    for (const item of knn) {
      const row = item.row;
      const slots = parseJsonObject(row.slots_json);
      if (!recallSurfaceAllowed({ db, scope: params.scope, row, slots })) continue;
      const similarity = adjustRecallCandidateSimilarityForTrust({
        type: row.type,
        slots,
        similarity: 1 - item.distance,
      });
      out.push({
        id: row.id,
        type: row.type,
        title: row.title,
        text_summary: row.text_summary,
        tier: row.tier,
        salience: row.salience,
        confidence: row.confidence,
        similarity,
        sources: [{
          kind: opts.sourceKind,
          score: similarity,
          reason: opts.sourceReason,
          matched_fields: ["embedding_vector_json"],
          index_name: opts.sourceIndexName,
        }],
        distance: item.distance,
      });
    }
    return out
      .sort((a, b) =>
        b.similarity - a.similarity
        || a.distance - b.distance
        || b.confidence - a.confidence
        || a.id.localeCompare(b.id))
      .slice(0, params.limit)
      .map(({ distance: _distance, ...candidate }) => candidate);
  };

  const stage1LexicalCandidates = async (params: RecallLexicalParams): Promise<RecallCandidate[]> => {
    const terms = lexicalTerms(params.queryText);
    if (terms.length === 0 || params.limit <= 0) return [];
    const where = [
      "k.scope = ?",
      `n.type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
      `(${terms.map(() => "LOWER(k.searchable_text) LIKE ? ESCAPE '\\'").join(" OR ")})`,
    ];
    const values: unknown[] = [
      params.scope,
      ...STAGE1_RECALL_TYPES,
      ...terms.map((term) => `%${escapeSqlLike(term)}%`),
    ];
    appendRecallVisibilityWhere(where, values, params.consumerAgentId, params.consumerTeamId);
    const rows = db.prepare(`
      SELECT
        n.id,
        n.scope,
        n.type,
        n.tier,
        n.memory_lane,
        n.producer_agent_id,
        n.owner_agent_id,
        n.owner_team_id,
        n.title,
        n.text_summary,
        n.slots_json,
        n.raw_ref,
        n.evidence_ref,
        n.embedding_vector_json,
        n.embedding_model,
        n.embedding_status,
        n.salience,
        n.importance,
        n.confidence,
        n.created_at,
        n.commit_id,
        k.title AS lexical_title,
        k.text_summary AS lexical_text_summary,
        k.slots_text AS lexical_slots_text,
        k.searchable_text AS lexical_searchable_text
      FROM lite_memory_keyword_index k
      JOIN lite_memory_nodes n
        ON n.scope = k.scope
       AND n.id = k.node_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY
        n.salience DESC,
        n.confidence DESC,
        n.created_at DESC,
        n.id DESC
      LIMIT ?
    `).all(...values, Math.max(params.limit * 8, params.limit)) as LiteRecallKeywordRow[];

    const out: RecallCandidate[] = [];
    for (const row of rows) {
      if (!candidateVisible(row, params.consumerAgentId, params.consumerTeamId)) continue;
      const slots = parseJsonObject(row.slots_json);
      if (!recallSurfaceAllowed({ db, scope: params.scope, row, slots })) continue;
      const matchedFields = lexicalMatchFields(row, terms);
      if (matchedFields.length === 0) continue;
      const score = adjustRecallCandidateSimilarityForTrust({
        type: row.type,
        slots,
        similarity: lexicalScore(row, terms, matchedFields),
      });
      out.push({
        id: row.id,
        type: row.type,
        title: row.title,
        text_summary: row.text_summary,
        tier: row.tier,
        salience: row.salience,
        confidence: row.confidence,
        similarity: score,
        sources: [{
          kind: "lexical",
          score,
          reason: "keyword_index_match",
          matched_fields: matchedFields,
          index_name: "lite_memory_keyword_index",
        }],
      });
    }
    return out
      .sort((a, b) =>
        b.similarity - a.similarity
        || b.salience - a.salience
        || b.confidence - a.confidence
        || a.id.localeCompare(b.id))
      .slice(0, params.limit);
  };
  const emptyStructuredCandidates = async (_params: RecallStructuredParams): Promise<RecallCandidate[]> => [];
  const emptyExecutionNativeCandidates = async (_params: RecallExecutionNativeParams): Promise<RecallCandidate[]> => [];
  const stage1HybridCandidates = async (params: RecallHybridParams): Promise<RecallCandidate[]> => {
    if (!params.queryEmbedding) return [];
    return stage1Candidates({
      queryEmbedding: params.queryEmbedding,
      scope: params.scope,
      oversample: params.oversample ?? params.limit,
      limit: params.limit,
      allowedTiers: params.allowedTiers,
      scanLimit: params.scanLimit,
      consumerAgentId: params.consumerAgentId,
      consumerTeamId: params.consumerTeamId,
    }, {
      boundedScan: true,
      sourceKind: "semantic",
      sourceReason: "bounded_embedding_scan",
      sourceIndexName: "lite_embedding_json_scan",
    });
  };

  return {
    createRecallAccess(): RecallStoreAccess {
      return {
        capability_version: RECALL_STORE_ACCESS_CAPABILITY_VERSION,
        capabilities,
        stage1CandidatesAnn: (params) => stage1Candidates(params, {
          boundedScan: true,
          sourceKind: "semantic",
          sourceReason: "bounded_embedding_scan",
          sourceIndexName: "lite_embedding_json_scan",
        }),
        stage1CandidatesExactRecovery: (params) => stage1Candidates(params, {
          boundedScan: false,
          sourceKind: "exact_recovery",
          sourceReason: "unbounded_exact_embedding_recovery",
          sourceIndexName: "lite_embedding_json_scan",
        }),
        stage1SemanticCandidates: (params) => stage1Candidates(params, {
          boundedScan: true,
          sourceKind: "semantic",
          sourceReason: "bounded_embedding_scan",
          sourceIndexName: "lite_embedding_json_scan",
        }),
        stage1LexicalCandidates,
        stage1StructuredCandidates: emptyStructuredCandidates,
        stage1ExecutionNativeCandidates: emptyExecutionNativeCandidates,
        stage1HybridCandidates,
        async stage2Edges(params: RecallStage2EdgesParams): Promise<RecallEdgeRow[]> {
          const seedSet = new Set(params.seedIds);
          if (params.neighborhoodHops === 1) {
            return fetchHopEdges(seedSet, params, params.hop1Budget)
              .slice(0, params.edgeFetchBudget)
              .map(edgeToRecallRow);
          }

          const hop1 = fetchHopEdges(seedSet, params, params.hop1Budget);
          const hopNodes = new Set<string>(params.seedIds);
          for (const edge of hop1) {
            hopNodes.add(edge.src_id);
            hopNodes.add(edge.dst_id);
          }
          return fetchHopEdges(hopNodes, params, params.hop2Budget)
            .slice(0, params.edgeFetchBudget)
            .map(edgeToRecallRow);
        },
        async stage2Nodes(params: RecallStage2NodesParams): Promise<RecallNodeRow[]> {
          if (params.nodeIds.length === 0) return [];
          const rows = db.prepare(`
            SELECT
              id,
              scope,
              type,
              tier,
              memory_lane,
              producer_agent_id,
              owner_agent_id,
              owner_team_id,
              title,
              text_summary,
              slots_json,
              raw_ref,
              evidence_ref,
              embedding_vector_json,
              embedding_model,
              embedding_status,
              salience,
              importance,
              confidence,
              created_at,
              commit_id
            FROM lite_memory_nodes
            WHERE scope = ?
              AND id IN (${placeholders(params.nodeIds.length)})
          `).all(params.scope, ...params.nodeIds) as LiteRecallNodeRow[];
          return rows
            .filter((row) => candidateVisible(row, params.consumerAgentId, params.consumerTeamId))
            .map((row) => nodeToRecallRow(row, params.includeSlots));
        },
        async ruleDefs(scope: string, ruleIds: string[]): Promise<RecallRuleDefRow[]> {
          if (ruleIds.length === 0) return [];
          const rows = db.prepare(`
            SELECT rule_node_id, state, rule_scope, target_agent_id, target_team_id, if_json, then_json, exceptions_json
            FROM lite_memory_rule_defs
            WHERE scope = ?
              AND rule_node_id IN (${placeholders(ruleIds.length)})
          `).all(scope, ...ruleIds) as LiteRecallRuleRow[];
          return rows.map((row) => ({
            rule_node_id: row.rule_node_id,
            state: row.state,
            rule_scope: row.rule_scope,
            target_agent_id: row.target_agent_id,
            target_team_id: row.target_team_id,
            if_json: parseJsonObject(row.if_json),
            then_json: parseJsonObject(row.then_json),
            exceptions_json: parseJsonArray(row.exceptions_json),
            positive_count: 0,
            negative_count: 0,
          }));
        },
        async debugEmbeddings(scope: string, ids: string[]): Promise<RecallDebugEmbeddingRow[]> {
          if (!capabilities.debug_embeddings) {
            throw new Error("recall capability unsupported: debug_embeddings");
          }
          if (ids.length === 0) return [];
          const rows = db.prepare(`
            SELECT id, embedding_vector_json
            FROM lite_memory_nodes
            WHERE scope = ?
              AND id IN (${placeholders(ids.length)})
              AND embedding_vector_json IS NOT NULL
          `).all(scope, ...ids) as Array<{ id: string; embedding_vector_json: string | null }>;
          return rows
            .map((row) => ({ id: row.id, embedding: parseEmbedding(row.embedding_vector_json) }))
            .filter((row) => !!row.embedding)
            .map((row) => ({
              id: row.id,
              embedding_text: toVectorLiteral(row.embedding as number[]),
            }));
        },
        async insertRecallAudit(params: RecallAuditInsertParams): Promise<void> {
          if (!capabilities.audit_insert) {
            throw new Error("recall capability unsupported: audit_insert");
          }
          const row: LiteRecallAuditRow = { ...params, created_at: nowIso() };
          db.prepare(`
            INSERT INTO lite_memory_recall_audit
              (scope, endpoint, consumer_agent_id, consumer_team_id, query_sha256, seed_count, node_count, edge_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            row.scope,
            row.endpoint,
            row.consumerAgentId,
            row.consumerTeamId,
            row.querySha256,
            row.seedCount,
            row.nodeCount,
            row.edgeCount,
            row.created_at,
          );
        },
      };
    },

    async close(): Promise<void> {
      db.close();
    },

    healthSnapshot() {
      return { path, mode: "sqlite_recall_v1" as const };
    },
  };
}
