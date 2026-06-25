import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toVectorLiteral } from "../util/vector-literal.js";
import { hasNodeWorkflowAnchorSurface } from "../memory/node-execution-surface.js";
import { mergeRecallCandidatesByRrf } from "../memory/recall-hybrid-merge.js";
import { memoryNodeVisible } from "./memory-visibility.js";
import { AnnIndexDimensionError, type AionisLocalAnnIndex, type AnnSearchResult, type AnnVectorRecord } from "./ann/ann-index.js";
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
  RecallGraphParams,
  RecallHybridParams,
  RecallLexicalParams,
  RecallDebugEmbeddingRow,
  RecallEdgeRow,
  RecallNodeRow,
  RecallRecentParams,
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

type LiteRecallStructuredRow = LiteRecallNodeRow & {
  execution_kind: string | null;
  anchor_kind: string | null;
  pattern_state: string | null;
  task_signature: string | null;
  task_family: string | null;
  error_signature: string | null;
  workflow_signature: string | null;
  pattern_signature: string | null;
  repo_signature: string | null;
  file_cluster: string | null;
  target_files_text: string | null;
  tool_chain_signature: string | null;
  failure_mode: string | null;
  verification_signature: string | null;
  acceptance_check_signature: string | null;
  compression_layer: string | null;
};

type LiteRecallAnnRebuildRow = LiteRecallNodeRow & {
  embedding_vector_json: string;
  embedding_model: string;
};

type StructuredSignal = {
  field: string;
  column: keyof Pick<
    LiteRecallStructuredRow,
    | "task_signature"
    | "task_family"
    | "error_signature"
    | "workflow_signature"
    | "pattern_signature"
    | "repo_signature"
    | "file_cluster"
    | "target_files_text"
    | "tool_chain_signature"
    | "failure_mode"
    | "verification_signature"
    | "acceptance_check_signature"
  >;
  value: string;
  reason: string;
  like: boolean;
};

const STAGE1_RECALL_TYPES = ["event", "topic", "concept", "entity", "rule", "procedure", "self_model"] as const;
const SQLITE_IN_CHUNK_SIZE = 800;
const DEFAULT_RECALL_ALLOWED_TIERS_FOR_RECENT = ["hot", "warm"] as const;
const STRUCTURED_RECALL_PREFETCH_FLOOR = 256;
const STRUCTURED_RECALL_PREFETCH_MULTIPLIER = 32;

export type LiteRecallStore = {
  createRecallAccess(): RecallStoreAccess;
  rebuildAnnIndex(): Promise<{ indexed: number; skipped: number }>;
  close(): Promise<void>;
  healthSnapshot(): { path: string; mode: "sqlite_recall_v1" };
};

type LiteRecallAnnOptions = {
  index: AionisLocalAnnIndex;
  rebuildOnStart?: boolean;
  maxCandidates?: number;
  sourceReason?: string;
  indexName?: string;
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

function vectorHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function stringSlot(slots: Record<string, unknown>, key: string): string | null {
  const value = slots[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function annVectorRecordFromRow(row: LiteRecallAnnRebuildRow): { record: AnnVectorRecord; vector: number[] } | null {
  const vector = parseEmbedding(row.embedding_vector_json);
  if (!vector) return null;
  const slots = parseJsonObject(row.slots_json);
  return {
    record: {
      node_id: row.id,
      scope: row.scope,
      tenant_id: null,
      embedding_model: row.embedding_model,
      embedding_dim: vector.length,
      vector_hash: vectorHash(row.embedding_vector_json),
      tier: row.tier,
      memory_lane: row.memory_lane,
      owner_agent_id: row.owner_agent_id,
      owner_team_id: row.owner_team_id,
      lifecycle_state: stringSlot(slots, "lifecycle_state"),
      authority_state: stringSlot(slots, "authority_state"),
      updated_at: row.created_at,
    },
    vector,
  };
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

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function uniqueStrings(values: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = nonEmptyString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function structuredSignals(params: RecallStructuredParams): StructuredSignal[] {
  const exact: Array<[string, StructuredSignal["column"], unknown, string]> = [
    ["task_signature", "task_signature", params.taskSignature, "same_task_signature"],
    ["workflow_signature", "workflow_signature", params.workflowSignature, "same_workflow_signature"],
    ["error_signature", "error_signature", params.errorSignature, "same_error_signature"],
    ["pattern_signature", "pattern_signature", params.patternSignature, "same_pattern_signature"],
    ["task_family", "task_family", params.taskFamily, "same_task_family"],
    ["repo_signature", "repo_signature", params.repoSignature, "same_repo_signature"],
    ["file_cluster", "file_cluster", params.fileCluster, "same_file_cluster"],
    ["tool_chain_signature", "tool_chain_signature", params.toolChainSignature, "same_tool_chain_signature"],
    ["failure_mode", "failure_mode", params.failureMode, "same_failure_mode"],
    ["verification_signature", "verification_signature", params.verificationSignature, "same_verification_signature"],
    ["acceptance_check_signature", "acceptance_check_signature", params.acceptanceCheckSignature, "same_acceptance_check_signature"],
  ];
  const out: StructuredSignal[] = [];
  for (const [field, column, value, reason] of exact) {
    const normalized = nonEmptyString(value);
    if (!normalized) continue;
    out.push({ field, column, value: normalized, reason, like: false });
  }
  for (const targetFile of uniqueStrings(params.targetFiles)) {
    out.push({
      field: "target_files",
      column: "target_files_text",
      value: targetFile,
      reason: "matching_target_file",
      like: true,
    });
  }
  return out;
}

function structuredMatchedFields(row: LiteRecallStructuredRow, signals: StructuredSignal[]): string[] {
  const matched: string[] = [];
  for (const signal of signals) {
    const value = row[signal.column];
    if (typeof value !== "string") continue;
    if (signal.like) {
      if (value.toLowerCase().includes(signal.value.toLowerCase())) matched.push(signal.field);
      continue;
    }
    if (value === signal.value) matched.push(signal.field);
  }
  return Array.from(new Set(matched));
}

function structuredReason(signals: StructuredSignal[], matchedFields: string[]): string {
  const priority = [
    "workflow_signature",
    "task_signature",
    "target_files",
    "failure_mode",
    "verification_signature",
    "acceptance_check_signature",
    "repo_signature",
    "task_family",
  ];
  const field = priority.find((candidate) => matchedFields.includes(candidate)) ?? matchedFields[0];
  return signals.find((signal) => signal.field === field)?.reason ?? "structured_signature_match";
}

function structuredScore(row: LiteRecallStructuredRow, matchedFields: string[], sourceKind: "structured" | "execution_native"): number {
  const base = sourceKind === "execution_native" ? 0.54 : 0.48;
  const raw = base
    + Math.min(0.3, matchedFields.length * 0.07)
    + Math.min(0.08, Math.max(0, row.salience) * 0.08)
    + Math.min(0.06, Math.max(0, row.confidence) * 0.06);
  return Math.max(0, Math.min(1, raw));
}

function structuredRecallPrefetchLimit(limit: number): number {
  return Math.max(
    STRUCTURED_RECALL_PREFETCH_FLOOR,
    Math.max(0, limit) * STRUCTURED_RECALL_PREFETCH_MULTIPLIER,
    Math.max(0, limit),
  );
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
  opts: { capabilities?: Partial<RecallStoreCapabilities>; ann?: LiteRecallAnnOptions | null } = {},
): LiteRecallStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = createSqliteDatabase(path);
  const capabilities = resolveRecallCapabilities(opts.capabilities);
  const ann = opts.ann ?? null;
  const annMaxCandidates = Math.max(1, Math.min(10000, Math.trunc(ann?.maxCandidates ?? 200)));
  const annSourceReason = ann?.sourceReason ?? "local_ann_index";
  const annIndexName = ann?.indexName ?? "aionis_local_ann";
  let annRebuilt = false;
  let annRebuildPromise: Promise<{ indexed: number; skipped: number }> | null = null;

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

  const rebuildAnnIndex = async (): Promise<{ indexed: number; skipped: number }> => {
    if (!ann) return { indexed: 0, skipped: 0 };
    let indexed = 0;
    let skipped = 0;
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
      WHERE embedding_status = 'ready'
        AND embedding_vector_json IS NOT NULL
        AND embedding_model IS NOT NULL
    `).all() as LiteRecallAnnRebuildRow[];

    async function* records() {
      for (const row of rows) {
        const item = annVectorRecordFromRow(row);
        if (!item) {
          skipped += 1;
          continue;
        }
        indexed += 1;
        yield item;
      }
    }

    await ann.index.rebuild(records());
    annRebuilt = true;
    return { indexed, skipped };
  };

  const ensureAnnReady = async (): Promise<void> => {
    if (!ann || !ann.rebuildOnStart || annRebuilt) return;
    annRebuildPromise ??= rebuildAnnIndex();
    await annRebuildPromise;
  };

  const embeddingModelsForAnnSearch = (
    params: RecallStage1Params,
    allowedTiers: string[],
  ): string[] => {
    const where = [
      "scope = ?",
      `tier IN (${placeholders(allowedTiers.length)})`,
      "embedding_status = 'ready'",
      "embedding_vector_json IS NOT NULL",
      "embedding_model IS NOT NULL",
      `type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
    ];
    const values: unknown[] = [params.scope, ...allowedTiers, ...STAGE1_RECALL_TYPES];
    appendRecallVisibilityWhere(where, values, params.consumerAgentId, params.consumerTeamId);
    const rows = db.prepare(`
      SELECT DISTINCT embedding_model
      FROM lite_memory_nodes
      WHERE ${where.join("\n        AND ")}
      ORDER BY embedding_model ASC
    `).all(...values) as Array<{ embedding_model: string | null }>;
    return rows
      .map((row) => row.embedding_model?.trim() ?? "")
      .filter((model) => model.length > 0);
  };

  const rowsForAnnResults = (
    params: RecallStage1Params,
    allowedTiers: string[],
    results: AnnSearchResult[],
  ): LiteRecallNodeRow[] => {
    if (results.length === 0) return [];
    const ids = Array.from(new Set(results.map((result) => result.node_id))).filter((id) => id.trim().length > 0);
    if (ids.length === 0) return [];
    const rows: LiteRecallNodeRow[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      const where = [
        "scope = ?",
        `id IN (${placeholders(chunk.length)})`,
        `tier IN (${placeholders(allowedTiers.length)})`,
        "embedding_status = 'ready'",
        "embedding_vector_json IS NOT NULL",
        `type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
      ];
      const values: unknown[] = [params.scope, ...chunk, ...allowedTiers, ...STAGE1_RECALL_TYPES];
      appendRecallVisibilityWhere(where, values, params.consumerAgentId, params.consumerTeamId);
      rows.push(...db.prepare(`
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
        WHERE ${where.join("\n          AND ")}
      `).all(...values) as LiteRecallNodeRow[]);
    }
    return rows;
  };

  const rowsForCandidateIds = (
    params: {
      scope: string;
      ids: string[];
      allowedTiers?: string[];
      consumerAgentId: string | null;
      consumerTeamId: string | null;
    },
  ): LiteRecallNodeRow[] => {
    const ids = Array.from(new Set(params.ids.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return [];
    const allowedTiers = params.allowedTiers ?? [...DEFAULT_RECALL_ALLOWED_TIERS_FOR_RECENT];
    const rows: LiteRecallNodeRow[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      const where = [
        "scope = ?",
        `id IN (${placeholders(chunk.length)})`,
        `tier IN (${placeholders(allowedTiers.length)})`,
        `type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
      ];
      const values: unknown[] = [params.scope, ...chunk, ...allowedTiers, ...STAGE1_RECALL_TYPES];
      appendRecallVisibilityWhere(where, values, params.consumerAgentId, params.consumerTeamId);
      rows.push(...db.prepare(`
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
        WHERE ${where.join("\n          AND ")}
      `).all(...values) as LiteRecallNodeRow[]);
    }
    const rank = new Map(ids.map((id, index) => [id, index]));
    return rows.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  };

  const stage1CandidatesFromAnnSidecar = async (params: RecallStage1Params): Promise<RecallCandidate[] | null> => {
    if (!ann || params.limit <= 0) return null;
    await ensureAnnReady();
    const allowedTiers = normalizeRecallAllowedTiers(params.allowedTiers);
    const candidateLimit = Math.max(params.limit, Math.min(annMaxCandidates, Math.max(params.oversample, params.limit)));
    const byId = new Map<string, AnnSearchResult>();
    for (const model of embeddingModelsForAnnSearch(params, allowedTiers)) {
      try {
        const results = await ann.index.search({
          scope: params.scope,
          embeddingModel: model,
          vector: params.queryEmbedding,
          limit: candidateLimit,
          filters: { tier: allowedTiers },
        });
        for (const result of results) {
          const existing = byId.get(result.node_id);
          if (!existing || result.score > existing.score) byId.set(result.node_id, result);
        }
      } catch (err) {
        if (err instanceof AnnIndexDimensionError) continue;
        throw err;
      }
    }
    if (byId.size === 0) return [];
    const rows = rowsForAnnResults(params, allowedTiers, Array.from(byId.values()));
    const out: RecallCandidate[] = [];
    for (const row of rows) {
      const annResult = byId.get(row.id);
      if (!annResult) continue;
      if (!candidateVisible(row, params.consumerAgentId, params.consumerTeamId)) continue;
      const slots = parseJsonObject(row.slots_json);
      if (!recallSurfaceAllowed({ db, scope: params.scope, row, slots })) continue;
      const similarity = adjustRecallCandidateSimilarityForTrust({
        type: row.type,
        slots,
        similarity: annResult.score,
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
          kind: "ann",
          score: similarity,
          reason: annSourceReason,
          matched_fields: ["embedding_vector_json"],
          index_name: annIndexName,
        }],
      });
    }
    return out
      .sort((a, b) =>
        b.similarity - a.similarity
        || (byId.get(b.id)?.score ?? 0) - (byId.get(a.id)?.score ?? 0)
        || b.confidence - a.confidence
        || a.id.localeCompare(b.id))
      .slice(0, params.limit);
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
  const stage1StructuredLikeCandidates = async (
    params: RecallStructuredParams,
    sourceKind: "structured" | "execution_native",
  ): Promise<RecallCandidate[]> => {
    if (params.limit <= 0) return [];
    const signals = structuredSignals(params);
    if (signals.length === 0) return [];
    const signalWhere: string[] = [];
    const signalValues: unknown[] = [];
    for (const signal of signals) {
      if (signal.like) {
        signalWhere.push(`LOWER(i.${signal.column}) LIKE ? ESCAPE '\\'`);
        signalValues.push(`%${escapeSqlLike(signal.value.toLowerCase())}%`);
      } else {
        signalWhere.push(`i.${signal.column} = ?`);
        signalValues.push(signal.value);
      }
    }
    const where = [
      "i.scope = ?",
      `n.type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
      `(${signalWhere.join(" OR ")})`,
    ];
    const values: unknown[] = [params.scope, ...STAGE1_RECALL_TYPES, ...signalValues];
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
        i.execution_kind,
        i.anchor_kind,
        i.pattern_state,
        i.task_signature,
        i.task_family,
        i.error_signature,
        i.workflow_signature,
        i.pattern_signature,
        i.repo_signature,
        i.file_cluster,
        i.target_files_text,
        i.tool_chain_signature,
        i.failure_mode,
        i.verification_signature,
        i.acceptance_check_signature,
        i.compression_layer
      FROM lite_memory_execution_native_index i
      JOIN lite_memory_nodes n
        ON n.scope = i.scope
       AND n.id = i.node_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY
        n.salience DESC,
        n.confidence DESC,
        n.created_at DESC,
        n.id DESC
      LIMIT ?
    `).all(...values, structuredRecallPrefetchLimit(params.limit)) as LiteRecallStructuredRow[];

    const out: RecallCandidate[] = [];
    for (const row of rows) {
      if (!candidateVisible(row, params.consumerAgentId, params.consumerTeamId)) continue;
      const slots = parseJsonObject(row.slots_json);
      if (!recallSurfaceAllowed({ db, scope: params.scope, row, slots })) continue;
      const matchedFields = structuredMatchedFields(row, signals);
      if (matchedFields.length === 0) continue;
      const score = adjustRecallCandidateSimilarityForTrust({
        type: row.type,
        slots,
        similarity: structuredScore(row, matchedFields, sourceKind),
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
          kind: sourceKind,
          score,
          reason: sourceKind === "execution_native"
            ? structuredReason(signals, matchedFields).replace(/^same_/, "execution_native_same_")
            : structuredReason(signals, matchedFields),
          matched_fields: matchedFields,
          index_name: "lite_memory_execution_native_index",
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
  const stage1StructuredCandidates = async (params: RecallStructuredParams): Promise<RecallCandidate[]> =>
    stage1StructuredLikeCandidates(params, "structured");
  const stage1ExecutionNativeCandidates = async (params: RecallExecutionNativeParams): Promise<RecallCandidate[]> =>
    stage1StructuredLikeCandidates(params, "execution_native");
  const stage1GraphCandidates = async (params: RecallGraphParams): Promise<RecallCandidate[]> => {
    const seedIds = Array.from(new Set(params.seedIds.map((id) => id.trim()).filter(Boolean)));
    if (params.limit <= 0 || seedIds.length === 0) return [];
    const allowedTiers = normalizeRecallAllowedTiers(params.allowedTiers, DEFAULT_RECALL_ALLOWED_TIERS_FOR_RECENT);
    const edgeBudget = Math.max(params.limit * 8, params.limit);
    const edges = fetchHopEdges(new Set(seedIds), {
      seedIds,
      scope: params.scope,
      neighborhoodHops: params.neighborhoodHops ?? 1,
      minEdgeWeight: params.minEdgeWeight ?? 0.1,
      minEdgeConfidence: params.minEdgeConfidence ?? 0.1,
      hop1Budget: edgeBudget,
      hop2Budget: edgeBudget,
      edgeFetchBudget: edgeBudget,
    }, edgeBudget);
    if (edges.length === 0) return [];
    const scores = new Map<string, { score: number; fields: Set<string> }>();
    for (const edge of edges) {
      const score = Math.max(0, Math.min(1, (edge.weight + edge.confidence) / 2));
      for (const id of [edge.src_id, edge.dst_id]) {
        const prev = scores.get(id);
        if (!prev || score > prev.score) {
          scores.set(id, {
            score,
            fields: new Set([`edge:${edge.type}`, seedIds.includes(edge.src_id) ? "src_id" : "dst_id"]),
          });
        } else {
          prev.fields.add(`edge:${edge.type}`);
        }
      }
    }
    const rows = rowsForCandidateIds({
      scope: params.scope,
      ids: Array.from(scores.keys()),
      allowedTiers,
      consumerAgentId: params.consumerAgentId,
      consumerTeamId: params.consumerTeamId,
    });
    const out: RecallCandidate[] = [];
    for (const row of rows) {
      if (!candidateVisible(row, params.consumerAgentId, params.consumerTeamId)) continue;
      const slots = parseJsonObject(row.slots_json);
      if (!recallSurfaceAllowed({ db, scope: params.scope, row, slots })) continue;
      const scoreInfo = scores.get(row.id);
      if (!scoreInfo) continue;
      const score = adjustRecallCandidateSimilarityForTrust({
        type: row.type,
        slots,
        similarity: scoreInfo.score,
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
          kind: "graph",
          score,
          reason: "edge_neighbor_expansion",
          matched_fields: Array.from(scoreInfo.fields).sort(),
          index_name: "lite_memory_edges",
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
  const stage1RecentCandidates = async (params: RecallRecentParams): Promise<RecallCandidate[]> => {
    if (params.limit <= 0) return [];
    const allowedTiers = normalizeRecallAllowedTiers(params.allowedTiers, DEFAULT_RECALL_ALLOWED_TIERS_FOR_RECENT);
    const where = [
      "scope = ?",
      `tier IN (${placeholders(allowedTiers.length)})`,
      `type IN (${placeholders(STAGE1_RECALL_TYPES.length)})`,
    ];
    const values: unknown[] = [params.scope, ...allowedTiers, ...STAGE1_RECALL_TYPES];
    appendRecallVisibilityWhere(where, values, params.consumerAgentId, params.consumerTeamId);
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
        COALESCE(json_extract(slots_json, '$.last_activated_at'), created_at) DESC,
        salience DESC,
        confidence DESC,
        id DESC
      LIMIT ?
    `).all(...values, Math.max(params.limit * 4, params.limit)) as LiteRecallNodeRow[];
    const out: RecallCandidate[] = [];
    for (const row of rows) {
      if (!candidateVisible(row, params.consumerAgentId, params.consumerTeamId)) continue;
      const slots = parseJsonObject(row.slots_json);
      if (!recallSurfaceAllowed({ db, scope: params.scope, row, slots })) continue;
      const score = adjustRecallCandidateSimilarityForTrust({
        type: row.type,
        slots,
        similarity: Math.max(0, Math.min(1, 0.45 + row.salience * 0.3 + row.confidence * 0.25)),
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
          kind: "recent",
          score,
          reason: "hot_working_set",
          matched_fields: ["last_activated_at", "created_at", "tier", "salience"],
          index_name: "lite_memory_nodes_scope_created",
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
  const stage1SemanticCandidates = async (params: RecallStage1Params): Promise<RecallCandidate[]> => {
    const annCandidates = await stage1CandidatesFromAnnSidecar(params);
    if (annCandidates && annCandidates.length > 0) return annCandidates;
    return stage1Candidates(params, {
      boundedScan: true,
      sourceKind: "semantic",
      sourceReason: "bounded_embedding_scan",
      sourceIndexName: "lite_embedding_json_scan",
    });
  };
  const stage1HybridCandidates = async (params: RecallHybridParams): Promise<RecallCandidate[]> => {
    if (params.limit <= 0) return [];
    const perSourceLimit = Math.max(params.limit, params.limit * 4);
    const semantic = params.queryEmbedding
      ? await stage1SemanticCandidates({
          queryEmbedding: params.queryEmbedding,
          scope: params.scope,
          oversample: params.oversample ?? perSourceLimit,
          limit: perSourceLimit,
          allowedTiers: params.allowedTiers,
          scanLimit: params.scanLimit,
          consumerAgentId: params.consumerAgentId,
          consumerTeamId: params.consumerTeamId,
        })
      : [];
    const lexical = params.queryText
      ? await stage1LexicalCandidates({
          queryText: params.queryText,
          scope: params.scope,
          limit: perSourceLimit,
          consumerAgentId: params.consumerAgentId,
          consumerTeamId: params.consumerTeamId,
        })
      : [];
    const structuredParams = params.structured
      ? {
          ...params.structured,
          scope: params.scope,
          limit: perSourceLimit,
          consumerAgentId: params.consumerAgentId,
          consumerTeamId: params.consumerTeamId,
        }
      : null;
    const structured = structuredParams ? await stage1StructuredCandidates(structuredParams) : [];
    const executionNative = structuredParams ? await stage1ExecutionNativeCandidates(structuredParams) : [];
    const seedIds = Array.from(new Set([
      ...(params.graphSeedIds ?? []),
      ...semantic.map((candidate) => candidate.id),
      ...lexical.map((candidate) => candidate.id),
      ...structured.map((candidate) => candidate.id),
      ...executionNative.map((candidate) => candidate.id),
    ])).slice(0, perSourceLimit);
    const graph = seedIds.length > 0
      ? await stage1GraphCandidates({
          scope: params.scope,
          seedIds,
          limit: perSourceLimit,
          allowedTiers: params.allowedTiers,
          consumerAgentId: params.consumerAgentId,
          consumerTeamId: params.consumerTeamId,
        })
      : [];
    const recent = await stage1RecentCandidates({
      scope: params.scope,
      limit: perSourceLimit,
      allowedTiers: params.allowedTiers,
      consumerAgentId: params.consumerAgentId,
      consumerTeamId: params.consumerTeamId,
    });
    const recentForHybrid = seedIds.length > 0
      ? recent.filter((candidate) => seedIds.includes(candidate.id))
      : recent;
    return mergeRecallCandidatesByRrf({
      semantic,
      lexical,
      structured,
      executionNative,
      graph,
      recent: recentForHybrid,
      limit: params.limit,
    });
  };

  return {
    createRecallAccess(): RecallStoreAccess {
      return {
        capability_version: RECALL_STORE_ACCESS_CAPABILITY_VERSION,
        capabilities,
        stage1CandidatesAnn: stage1SemanticCandidates,
        stage1CandidatesExactRecovery: (params) => stage1Candidates(params, {
          boundedScan: false,
          sourceKind: "exact_recovery",
          sourceReason: "unbounded_exact_embedding_recovery",
          sourceIndexName: "lite_embedding_json_scan",
        }),
        stage1SemanticCandidates,
        stage1LexicalCandidates,
        stage1StructuredCandidates,
        stage1ExecutionNativeCandidates,
        stage1GraphCandidates,
        stage1RecentCandidates,
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

    rebuildAnnIndex,

    async close(): Promise<void> {
      await ann?.index.close?.();
      db.close();
    },

    healthSnapshot() {
      return { path, mode: "sqlite_recall_v1" as const };
    },
  };
}
