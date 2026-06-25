import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionNativeV1 } from "../memory/schemas.js";
import {
  resolveNodeAnchorKind,
  resolveNodeAcceptanceChecks,
  resolveNodeCompressionLayer,
  resolveNodeErrorSignature,
  resolveNodeExecutionKind,
  resolveNodeNativeExecutionSurface,
  resolveNodePatternSignature,
  resolveNodePatternState,
  resolveNodeTargetFiles,
  resolveNodeTaskFamily,
  resolveNodeTaskSignature,
  resolveNodeWorkflowSignature,
} from "../memory/node-execution-surface.js";
import type {
  AssociationCandidateRecord,
  ListAssociationCandidatesForSourceArgs,
  MarkAssociationCandidatePromotedArgs,
  UpdateAssociationCandidateStatusArgs,
  UpsertAssociationCandidateArgs,
} from "../memory/associative-candidate-store.js";
import { stableUuid } from "../util/uuid.js";
import { assertDim } from "../util/vector-literal.js";
import { createSqliteTransactionRunner } from "./sqlite-transaction-runner.js";
import type {
  WriteCommitInsertArgs,
  WriteEdgeUpsertArgs,
  WriteNodeInsertArgs,
  WriteOutboxInsertArgs,
  WriteRuleDefInsertArgs,
  WriteStoreAccess,
  WriteExistingNodeFingerprint,
  WriteLifecycleCandidateNodeRow,
} from "./write-access.js";
import { WRITE_STORE_ACCESS_CAPABILITY_VERSION, writeNodeFingerprint } from "./write-access.js";
import { memoryNodeVisible } from "./memory-visibility.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

type LiteLatestNodeView = {
  id: string;
};

export type LiteFindNodeRow = {
  id: string;
  type: string;
  client_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots: Record<string, unknown>;
  tier: string;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  embedding_status: string | null;
  embedding_model: string | null;
  raw_ref: string | null;
  evidence_ref: string | null;
  salience: number;
  importance: number;
  confidence: number;
  last_activated: string | null;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
  topic_state: string | null;
  member_count: number | null;
};

export type LiteResolveNodeRow = LiteFindNodeRow & {
  commit_scope: string | null;
};

export type LiteResolveEdgeRow = {
  id: string;
  type: string;
  src_id: string;
  src_type: string;
  dst_id: string;
  dst_type: string;
  weight: number;
  confidence: number;
  decay_rate: number;
  last_activated: string | null;
  created_at: string;
  commit_id: string | null;
  commit_scope: string | null;
};

export type LiteResolveCommitRow = {
  id: string;
  parent_id: string | null;
  input_sha256: string;
  diff_json: unknown;
  actor: string;
  model_version: string | null;
  prompt_version: string | null;
  commit_hash: string;
  created_at: string;
  node_count: number;
  edge_count: number;
  decision_count: number;
};

export type LiteRuleCandidateRow = {
  rule_node_id: string;
  state: "draft" | "shadow" | "active" | "disabled";
  rule_scope: "global" | "team" | "agent";
  target_agent_id: string | null;
  target_team_id: string | null;
  rule_memory_lane: "private" | "shared";
  rule_owner_agent_id: string | null;
  rule_owner_team_id: string | null;
  if_json: Record<string, unknown>;
  then_json: Record<string, unknown>;
  exceptions_json: unknown[];
  positive_count: number;
  negative_count: number;
  rule_commit_id: string;
  rule_summary: string | null;
  rule_slots: Record<string, unknown>;
  updated_at: string;
};

export type LiteRuleDefSyncRow = {
  scope: string;
  rule_node_id: string;
  state: "draft" | "shadow" | "active" | "disabled";
  rule_scope: "global" | "team" | "agent";
  target_agent_id: string | null;
  target_team_id: string | null;
  if_json: Record<string, unknown>;
  then_json: Record<string, unknown>;
  exceptions_json: unknown[];
  positive_count: number;
  negative_count: number;
  commit_id: string | null;
  updated_at: string;
};

export type LiteExecutionDecisionRow = {
  id: string;
  scope: string;
  decision_kind: "tools_select";
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: unknown[];
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
  commit_id: string | null;
};

export type LiteResolveDecisionRow = LiteExecutionDecisionRow & {
  commit_scope: string | null;
};

export type LiteRuleFeedbackRow = {
  id: string;
  scope: string;
  rule_node_id: string;
  run_id: string | null;
  outcome: "positive" | "negative" | "neutral";
  note: string | null;
  source: "rule_feedback" | "tools_feedback";
  decision_id: string | null;
  commit_id: string | null;
  created_at: string;
};

export type LiteExecutionNativeNodeRow = LiteFindNodeRow & {
  execution_native: ExecutionNativeV1;
};

export type LiteWriteStore = WriteStoreAccess & {
  withTx<T>(fn: () => Promise<T>): Promise<T>;
  findNodes(args: {
    scope: string;
    id?: string | null;
    type?: string | null;
    clientId?: string | null;
    titleContains?: string | null;
    textContains?: string | null;
    memoryLane?: "private" | "shared" | null;
    slotsContains?: Record<string, unknown> | null;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ rows: LiteFindNodeRow[]; has_more: boolean }>;
  findExecutionNativeNodes(args: {
    scope: string;
    executionKind?: "distilled_evidence" | "distilled_fact" | "workflow_candidate" | "workflow_anchor" | "pattern_anchor" | "execution_native" | null;
    anchorKind?: "execution" | "workflow" | "pattern" | "decision" | null;
    patternState?: "provisional" | "stable" | null;
    taskSignature?: string | null;
    errorSignature?: string | null;
    workflowSignature?: string | null;
    patternSignature?: string | null;
    compressionLayer?: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | null;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ rows: LiteExecutionNativeNodeRow[]; has_more: boolean }>;
  findLatestNodeByClientId(
    scope: string,
    type: string,
    clientId: string,
  ): Promise<LiteLatestNodeView | null>;
  resolveNode(args: {
    scope: string;
    id: string;
    type: string;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
  }): Promise<LiteResolveNodeRow | null>;
  resolveEdge(args: {
    scope: string;
    id: string;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
  }): Promise<LiteResolveEdgeRow | null>;
  resolveCommit(args: {
    scope: string;
    id: string;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
  }): Promise<LiteResolveCommitRow | null>;
  resolveDecision(args: {
    scope: string;
    id: string;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
  }): Promise<LiteResolveDecisionRow | null>;
  listRuleCandidates(args: {
    scope: string;
    limit: number;
    states?: Array<"shadow" | "active">;
  }): Promise<LiteRuleCandidateRow[]>;
  getRuleDef(scope: string, ruleNodeId: string): Promise<LiteRuleDefSyncRow | null>;
  upsertRuleState(args: {
    scope: string;
    ruleNodeId: string;
    state: "draft" | "shadow" | "active" | "disabled";
    ifJson: Record<string, unknown>;
    thenJson: Record<string, unknown>;
    exceptionsJson: unknown[];
    ruleScope: "global" | "team" | "agent";
    targetAgentId: string | null;
    targetTeamId: string | null;
    positiveCount: number;
    negativeCount: number;
    commitId: string | null;
  }): Promise<LiteRuleDefSyncRow>;
  insertExecutionDecision(args: {
    id: string;
    scope: string;
    decisionKind: "tools_select";
    runId: string | null;
    selectedTool: string | null;
    candidatesJson: unknown[];
    contextSha256: string;
    policySha256: string;
    sourceRuleIds: string[];
    metadataJson: Record<string, unknown>;
    commitId: string | null;
  }): Promise<{ id: string; created_at: string }>;
  getExecutionDecision(args: {
    scope: string;
    id?: string | null;
    runId?: string | null;
  }): Promise<LiteExecutionDecisionRow | null>;
  listExecutionDecisionsByRun(args: {
    scope: string;
    runId: string;
    limit: number;
  }): Promise<{
    count: number;
    latest_created_at: string | null;
    rows: LiteExecutionDecisionRow[];
  }>;
  listExecutionRuns(args: {
    scope: string;
    limit: number;
  }): Promise<Array<{
    run_id: string;
    decision_count: number;
    latest_decision_at: string;
    latest_selected_tool: string | null;
    feedback_total: number;
    latest_feedback_at: string | null;
  }>>;
  findExecutionDecisionForFeedback(args: {
    scope: string;
    runId: string | null;
    selectedTool: string;
    candidatesJson: unknown[];
    contextSha256: string;
  }): Promise<LiteExecutionDecisionRow | null>;
  updateExecutionDecisionLink(args: {
    scope: string;
    id: string;
    runId?: string | null;
    commitId?: string | null;
  }): Promise<LiteExecutionDecisionRow | null>;
  latestCommit(scope: string): Promise<{ id: string; commit_hash: string } | null>;
  insertRuleFeedback(args: {
    id: string;
    scope: string;
    ruleNodeId: string;
    runId: string | null;
    outcome: "positive" | "negative" | "neutral";
    note: string | null;
    source: "rule_feedback" | "tools_feedback";
    decisionId: string | null;
    commitId: string | null;
    createdAt?: string | null;
  }): Promise<void>;
  listRuleFeedbackByRun(args: {
    scope: string;
    runId: string;
    limit: number;
  }): Promise<{
    total: number;
    positive: number;
    negative: number;
    neutral: number;
    linked_decision_count: number;
    tools_feedback_count: number;
    latest_feedback_at: string | null;
    rows: LiteRuleFeedbackRow[];
  }>;
  updateRuleFeedbackAggregates(args: {
    scope: string;
    outcome: "positive" | "negative" | "neutral";
    ruleNodeIds: string[];
  }): Promise<LiteRuleCandidateRow[]>;
  setNodeEmbeddingReady(args: {
    scope: string;
    id: string;
    embedding: number[];
    embeddingModel: string;
  }): Promise<void>;
  updateNodeAnchorState(args: {
    scope: string;
    id: string;
    slots: Record<string, unknown>;
    textSummary: string | null;
    salience: number;
    importance: number;
    confidence: number;
    tier?: string | null;
    commitId?: string | null;
  }): Promise<LiteFindNodeRow | null>;
  setNodeEmbeddingFailed(args: {
    scope: string;
    id: string;
    error: string;
  }): Promise<void>;
  close(): Promise<void>;
  healthSnapshot(): { path: string; mode: "sqlite_write_v1" };
};

export type LiteWriteAnnSync = {
  syncNode(scope: string, nodeId: string): Promise<unknown>;
  deleteNode(nodeId: string): Promise<unknown>;
};

export type LiteWriteStoreOptions = {
  annSync?: LiteWriteAnnSync | null;
};

type LiteWritePostCommitContext = {
  callbacks: Array<() => Promise<void>>;
};

function nowIso(): string {
  return new Date().toISOString();
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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

type LiteExecutionDecisionDbRow = {
  id: string;
  scope: string;
  decision_kind: "tools_select";
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: string;
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids_json: string;
  metadata_json: string;
  commit_id: string | null;
  created_at: string;
};

type LiteExecutionNativeIndexRow = {
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

type LiteMemoryNodeDbRow = {
  id: string;
  type: string;
  client_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots_json: string;
  tier: string;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  embedding_status: string | null;
  embedding_model: string | null;
  raw_ref: string | null;
  evidence_ref: string | null;
  salience: number;
  importance: number;
  confidence: number;
  created_at: string;
  commit_id: string | null;
};

const LITE_EXECUTION_DECISION_SELECT_SQL = `SELECT
   id,
   scope,
   decision_kind,
   run_id,
   selected_tool,
   candidates_json,
   context_sha256,
   policy_sha256,
   source_rule_ids_json,
   metadata_json,
   commit_id,
   created_at
 FROM lite_memory_execution_decisions`;

function decodeExecutionDecisionRow(row: LiteExecutionDecisionDbRow): LiteExecutionDecisionRow {
  return {
    id: row.id,
    scope: row.scope,
    decision_kind: row.decision_kind,
    run_id: row.run_id,
    selected_tool: row.selected_tool,
    candidates_json: parseJsonArray(row.candidates_json),
    context_sha256: row.context_sha256,
    policy_sha256: row.policy_sha256,
    source_rule_ids: parseJsonArray(row.source_rule_ids_json).map((value) => String(value)),
    metadata_json: parseJsonObject(row.metadata_json),
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
}

function decodeLiteFindNodeRow(row: LiteMemoryNodeDbRow): LiteFindNodeRow {
  const slots = parseJsonObject(row.slots_json);
  return {
    id: row.id,
    type: row.type,
    client_id: row.client_id,
    title: row.title,
    text_summary: row.text_summary,
    slots,
    tier: row.tier,
    memory_lane: row.memory_lane,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    embedding_status: row.embedding_status,
    embedding_model: row.embedding_model,
    raw_ref: row.raw_ref,
    evidence_ref: row.evidence_ref,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    last_activated: null,
    created_at: row.created_at,
    updated_at: row.created_at,
    commit_id: row.commit_id,
    topic_state: row.type === "topic" ? String(slots.topic_state ?? "active") : null,
    member_count: row.type === "topic" && Number.isFinite(Number(slots.member_count))
      ? Number(slots.member_count)
      : null,
  };
}

function appendVisibilityWhere(args: {
  where: string[];
  params: unknown[];
  consumerAgentId: string | null;
  consumerTeamId: string | null;
}): void {
  const visibility: string[] = ["(memory_lane = 'shared' AND owner_team_id IS NULL)"];
  if (args.consumerAgentId) {
    visibility.push("(memory_lane = 'shared' AND owner_agent_id = ?)");
    args.params.push(args.consumerAgentId);
    visibility.push("(memory_lane = 'private' AND owner_agent_id = ?)");
    args.params.push(args.consumerAgentId);
  }
  if (args.consumerTeamId) {
    visibility.push("(memory_lane = 'shared' AND owner_team_id = ?)");
    args.params.push(args.consumerTeamId);
    visibility.push("(memory_lane = 'private' AND owner_team_id = ?)");
    args.params.push(args.consumerTeamId);
  }
  args.where.push(`(${visibility.join(" OR ")})`);
}

function appendVisibilityWhereForAlias(args: {
  where: string[];
  params: unknown[];
  alias: string;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
}): void {
  const column = (name: string) => `${args.alias}.${name}`;
  const visibility: string[] = [`(${column("memory_lane")} = 'shared' AND ${column("owner_team_id")} IS NULL)`];
  if (args.consumerAgentId) {
    visibility.push(`(${column("memory_lane")} = 'shared' AND ${column("owner_agent_id")} = ?)`);
    args.params.push(args.consumerAgentId);
    visibility.push(`(${column("memory_lane")} = 'private' AND ${column("owner_agent_id")} = ?)`);
    args.params.push(args.consumerAgentId);
  }
  if (args.consumerTeamId) {
    visibility.push(`(${column("memory_lane")} = 'shared' AND ${column("owner_team_id")} = ?)`);
    args.params.push(args.consumerTeamId);
    visibility.push(`(${column("memory_lane")} = 'private' AND ${column("owner_team_id")} = ?)`);
    args.params.push(args.consumerTeamId);
  }
  args.where.push(`(${visibility.join(" OR ")})`);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function uniqueNonEmptyStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function joinIndexList(values: readonly string[]): string | null {
  const out = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return out.length > 0 ? out.join("\n") : null;
}

function executionNativeIndexRowFromNode(row: LiteFindNodeRow): LiteExecutionNativeIndexRow | null {
  const executionNative = resolveNodeNativeExecutionSurface(row.slots);
  if (!executionNative) return null;
  const anchor = recordOrNull(row.slots.anchor_v1);
  const executionOutcome = recordOrNull(executionNative.outcome);
  const anchorOutcome = recordOrNull(anchor?.outcome);
  const targetFiles = resolveNodeTargetFiles({ slots: row.slots });
  const acceptanceChecks = resolveNodeAcceptanceChecks({ slots: row.slots });
  return {
    execution_kind: resolveNodeExecutionKind(row.slots),
    anchor_kind: resolveNodeAnchorKind(row.slots),
    pattern_state: resolveNodePatternState(row.slots),
    task_signature: resolveNodeTaskSignature({ slots: row.slots }),
    task_family: resolveNodeTaskFamily({ slots: row.slots }),
    error_signature: resolveNodeErrorSignature(row.slots),
    workflow_signature: resolveNodeWorkflowSignature({ slots: row.slots }),
    pattern_signature: resolveNodePatternSignature(row.slots),
    repo_signature: firstNonEmptyString(row.slots.repo_signature, executionNative.repo_signature, anchor?.repo_signature),
    file_cluster: firstNonEmptyString(row.slots.file_cluster, executionNative.file_cluster, anchor?.file_cluster),
    target_files_text: joinIndexList(targetFiles),
    tool_chain_signature: firstNonEmptyString(
      row.slots.tool_chain_signature,
      executionNative.tool_chain_signature,
      anchor?.tool_chain_signature,
      uniqueNonEmptyStringList(row.slots.tool_set).join(" "),
      uniqueNonEmptyStringList(executionNative.tool_set).join(" "),
      uniqueNonEmptyStringList(anchor?.tool_set).join(" "),
    ),
    failure_mode: firstNonEmptyString(row.slots.failure_mode, executionNative.failure_mode, anchor?.failure_mode),
    verification_signature: firstNonEmptyString(
      row.slots.verification_signature,
      executionNative.verification_signature,
      anchor?.verification_signature,
      executionOutcome?.verification_signature,
      anchorOutcome?.verification_signature,
    ),
    acceptance_check_signature: firstNonEmptyString(
      row.slots.acceptance_check_signature,
      executionNative.acceptance_check_signature,
      anchor?.acceptance_check_signature,
      executionOutcome?.acceptance_check_signature,
      anchorOutcome?.acceptance_check_signature,
      acceptanceChecks[0],
    ),
    compression_layer: resolveNodeCompressionLayer({ type: row.type, slots: row.slots }),
  };
}

const LITE_MEMORY_NODE_SELECT_COLUMNS_SQL = `SELECT
   id,
   type,
   client_id,
   title,
   text_summary,
   slots_json,
   tier,
   memory_lane,
   producer_agent_id,
   owner_agent_id,
   owner_team_id,
   embedding_status,
   embedding_model,
   raw_ref,
   evidence_ref,
   salience,
   importance,
   confidence,
   created_at,
   commit_id`;

const LITE_MEMORY_NODE_SELECT_SQL = `${LITE_MEMORY_NODE_SELECT_COLUMNS_SQL}
 FROM lite_memory_nodes`;

function nodeVisible(
  row: { memory_lane: "private" | "shared"; owner_agent_id: string | null; owner_team_id: string | null },
  consumerAgentId: string | null,
  consumerTeamId: string | null,
): boolean {
  return memoryNodeVisible(row, consumerAgentId, consumerTeamId);
}

function commitVisible(
  db: SqliteDatabase,
  scope: string,
  commitId: string,
  consumerAgentId: string | null,
  consumerTeamId: string | null,
): boolean {
  const hiddenCount = Number(
    (
      db.prepare(
        `SELECT count(*) AS count
         FROM lite_memory_nodes
         WHERE scope = ?
           AND commit_id = ?
           AND NOT (
             (memory_lane = 'shared' AND owner_team_id IS NULL)
             OR (? IS NOT NULL AND memory_lane = 'shared' AND owner_agent_id = ?)
             OR (? IS NOT NULL AND memory_lane = 'shared' AND owner_team_id = ?)
             OR (? IS NOT NULL AND memory_lane = 'private' AND owner_agent_id = ?)
             OR (? IS NOT NULL AND memory_lane = 'private' AND owner_team_id = ?)
           )`,
      ).get(
        scope,
        commitId,
        consumerAgentId,
        consumerAgentId,
        consumerTeamId,
        consumerTeamId,
        consumerAgentId,
        consumerAgentId,
        consumerTeamId,
        consumerTeamId,
      ) as { count: number } | undefined
    )?.count ?? 0,
  );
  return hiddenCount === 0;
}

function decisionSourceRulesVisible(
  db: SqliteDatabase,
  scope: string,
  sourceRuleIds: string[],
  consumerAgentId: string | null,
  consumerTeamId: string | null,
): boolean {
  if (sourceRuleIds.length === 0) return true;
  for (const ruleId of sourceRuleIds) {
    const row = db.prepare(
      `SELECT memory_lane, owner_agent_id, owner_team_id
       FROM lite_memory_nodes
       WHERE scope = ? AND id = ?
       LIMIT 1`,
    ).get(scope, ruleId) as { memory_lane: "private" | "shared"; owner_agent_id: string | null; owner_team_id: string | null } | undefined;
    if (row && !nodeVisible(row, consumerAgentId, consumerTeamId)) return false;
  }
  return true;
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((value, index) => jsonContains(actual[index], value));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>)
    .every(([key, value]) => jsonContains((actual as Record<string, unknown>)[key], value));
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function sqliteJsonPathForTopLevelKey(key: string): string | null {
  if (!/^[A-Za-z0-9_]+$/.test(key)) return null;
  return `$.${key}`;
}

function buildSimpleSlotsSqlFilters(slotsContains: Record<string, unknown> | null | undefined): {
  where: string[];
  params: unknown[];
} {
  if (!slotsContains) return { where: [], params: [] };
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(slotsContains)) {
    const path = sqliteJsonPathForTopLevelKey(key);
    if (!path) continue;
    if (value === null) {
      where.push(`json_type(slots_json, '${path}') = 'null'`);
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      where.push(`json_extract(slots_json, '${path}') = ?`);
      params.push(value);
      continue;
    }
    if (typeof value === "boolean") {
      where.push(`json_extract(slots_json, '${path}') = ?`);
      params.push(value ? 1 : 0);
    }
  }
  return { where, params };
}

const LITE_MEMORY_KEYWORD_SLOT_KEYS = new Set([
  "acceptance_check_signature",
  "acceptance_checks",
  "anchor_kind",
  "compression_layer",
  "continuation_hint",
  "error_signature",
  "execution_kind",
  "execution_outcome_role",
  "failure_mode",
  "file_cluster",
  "lifecycle_hint",
  "pattern_signature",
  "repo_signature",
  "selected_tool",
  "service_lifecycle_constraints",
  "summary_kind",
  "target_files",
  "task_family",
  "task_signature",
  "tool_chain_signature",
  "tool_set",
  "verification_signature",
  "workflow_signature",
  "workflow_steps",
]);

const LITE_MEMORY_KEYWORD_NESTED_SLOT_KEYS = [
  "anchor_v1",
  "execution_contract_v1",
  "execution_native_v1",
  "execution_observation_v1",
  "execution_result_summary",
  "recovery_contract_v1",
  "runtime_signal_ledger_v1",
] as const;

function collectSearchableStrings(value: unknown, out: string[], limit = 96): void {
  if (out.length >= limit) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSearchableStrings(item, out, limit);
      if (out.length >= limit) break;
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase().includes("secret") || key.toLowerCase().includes("token") || key.toLowerCase().includes("key")) {
        continue;
      }
      collectSearchableStrings(nested, out, limit);
      if (out.length >= limit) break;
    }
  }
}

function buildLiteMemoryKeywordSlotsText(slots: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(slots)) {
    if (LITE_MEMORY_KEYWORD_SLOT_KEYS.has(key)) {
      collectSearchableStrings(value, out);
    }
  }
  for (const key of LITE_MEMORY_KEYWORD_NESTED_SLOT_KEYS) {
    if (slots[key]) collectSearchableStrings(slots[key], out);
  }
  return Array.from(new Set(out.map((value) => value.trim()).filter(Boolean))).join("\n");
}

export function createLiteWriteStore(path: string, opts: LiteWriteStoreOptions = {}): LiteWriteStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = createSqliteDatabase(path);
  const annSync = opts.annSync ?? null;
  const postCommitStorage = new AsyncLocalStorage<LiteWritePostCommitContext>();
  const transaction = createSqliteTransactionRunner({
    begin: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  });

  const runAnnSideEffect = async (callback: () => Promise<void>): Promise<void> => {
    try {
      await callback();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.emitWarning(`Aionis ANN sidecar sync failed: ${message}`, {
        code: "AIONIS_ANN_SYNC_FAILED",
      });
    }
  };

  const scheduleAnnSideEffect = async (callback: () => Promise<void>): Promise<void> => {
    if (!annSync) return;
    const context = postCommitStorage.getStore();
    if (context) {
      context.callbacks.push(callback);
      return;
    }
    await runAnnSideEffect(callback);
  };

  const scheduleAnnNodeSync = async (scope: string, nodeId: string): Promise<void> => {
    await scheduleAnnSideEffect(() => annSync!.syncNode(scope, nodeId).then(() => undefined));
  };

  const scheduleAnnNodeDelete = async (nodeId: string): Promise<void> => {
    await scheduleAnnSideEffect(() => annSync!.deleteNode(nodeId).then(() => undefined));
  };

  const flushPostCommitSideEffects = async (callbacks: Array<() => Promise<void>>): Promise<void> => {
    for (const callback of callbacks) await runAnnSideEffect(callback);
  };
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS lite_memory_commits (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      parent_commit_id TEXT,
      input_sha256 TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      model_version TEXT,
      prompt_version TEXT,
      commit_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_commits_scope_created
      ON lite_memory_commits(scope, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_nodes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      client_id TEXT,
      type TEXT NOT NULL,
      tier TEXT NOT NULL,
      title TEXT,
      text_summary TEXT,
      slots_json TEXT NOT NULL,
      raw_ref TEXT,
      evidence_ref TEXT,
      embedding_vector_json TEXT,
      embedding_model TEXT,
      memory_lane TEXT NOT NULL,
      producer_agent_id TEXT,
      owner_agent_id TEXT,
      owner_team_id TEXT,
      embedding_status TEXT NOT NULL,
      embedding_last_error TEXT,
      salience REAL NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      redaction_version INTEGER NOT NULL,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope ON lite_memory_nodes(scope);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_created ON lite_memory_nodes(scope, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_commit ON lite_memory_nodes(scope, commit_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_status ON lite_memory_nodes(scope, embedding_status);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_recall_stage1
      ON lite_memory_nodes(scope, tier, embedding_status, type, salience DESC, confidence DESC, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_created ON lite_memory_nodes(scope, type, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_client ON lite_memory_nodes(scope, client_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_client_created ON lite_memory_nodes(scope, type, client_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_summary_kind_created
      ON lite_memory_nodes(scope, type, json_extract(slots_json, '$.summary_kind'), created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_nodes_scope_type_summary_tool_created
      ON lite_memory_nodes(scope, type, json_extract(slots_json, '$.summary_kind'), json_extract(slots_json, '$.selected_tool'), created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_execution_native_index (
      scope TEXT NOT NULL,
      node_id TEXT NOT NULL,
      execution_kind TEXT,
      anchor_kind TEXT,
      pattern_state TEXT,
      task_signature TEXT,
      task_family TEXT,
      error_signature TEXT,
      workflow_signature TEXT,
      pattern_signature TEXT,
      repo_signature TEXT,
      file_cluster TEXT,
      target_files_text TEXT,
      tool_chain_signature TEXT,
      failure_mode TEXT,
      verification_signature TEXT,
      acceptance_check_signature TEXT,
      compression_layer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_created
      ON lite_memory_execution_native_index(scope, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_kind_created
      ON lite_memory_execution_native_index(scope, execution_kind, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_workflow_created
      ON lite_memory_execution_native_index(scope, workflow_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_task_created
      ON lite_memory_execution_native_index(scope, task_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_error_created
      ON lite_memory_execution_native_index(scope, error_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_pattern_created
      ON lite_memory_execution_native_index(scope, pattern_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_layer_created
      ON lite_memory_execution_native_index(scope, compression_layer, created_at DESC, node_id DESC);

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
    CREATE INDEX IF NOT EXISTS idx_lite_memory_keyword_scope_updated
      ON lite_memory_keyword_index(scope, updated_at DESC, node_id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_rule_defs (
      rule_node_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      state TEXT NOT NULL,
      if_json TEXT NOT NULL,
      then_json TEXT NOT NULL,
      exceptions_json TEXT NOT NULL,
      rule_scope TEXT NOT NULL,
      target_agent_id TEXT,
      target_team_id TEXT,
      positive_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_rule_defs_scope_created
      ON lite_memory_rule_defs(scope, created_at DESC, rule_node_id ASC);

    CREATE TABLE IF NOT EXISTS lite_memory_edges (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      weight REAL NOT NULL,
      confidence REAL NOT NULL,
      decay_rate REAL NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope, type, src_id, dst_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope ON lite_memory_edges(scope);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope_commit ON lite_memory_edges(scope, commit_id);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope_src_weight_conf
      ON lite_memory_edges(scope, src_id, weight DESC, confidence DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_edges_scope_dst_weight_conf
      ON lite_memory_edges(scope, dst_id, weight DESC, confidence DESC, id ASC);

    CREATE TABLE IF NOT EXISTS lite_memory_association_candidates (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      relation_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      feature_summary_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      source_commit_id TEXT,
      worker_run_id TEXT,
      promoted_edge_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope, src_id, dst_id, relation_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_association_candidates_scope_src_score
      ON lite_memory_association_candidates(scope, src_id, score DESC, confidence DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_outbox (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      job_key TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope, event_type, job_key)
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_outbox_scope_commit ON lite_memory_outbox(scope, commit_id);

    CREATE TABLE IF NOT EXISTS lite_memory_execution_decisions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      decision_kind TEXT NOT NULL,
      run_id TEXT,
      selected_tool TEXT,
      candidates_json TEXT NOT NULL,
      context_sha256 TEXT NOT NULL,
      policy_sha256 TEXT NOT NULL,
      source_rule_ids_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_decisions_scope_created
      ON lite_memory_execution_decisions(scope, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_decisions_scope_run_created
      ON lite_memory_execution_decisions(scope, run_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_decisions_scope_tool_context_created
      ON lite_memory_execution_decisions(scope, selected_tool, context_sha256, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS lite_memory_rule_feedback (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      rule_node_id TEXT NOT NULL,
      run_id TEXT,
      outcome TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL,
      decision_id TEXT,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lite_memory_rule_feedback_scope_run_created
      ON lite_memory_rule_feedback(scope, run_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_rule_feedback_scope_rule_created
      ON lite_memory_rule_feedback(scope, rule_node_id, created_at DESC, id DESC);
  `);
  try {
    db.exec("ALTER TABLE lite_memory_rule_defs ADD COLUMN positive_count INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists in initialized databases.
  }
  try {
    db.exec("ALTER TABLE lite_memory_rule_defs ADD COLUMN negative_count INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists in initialized databases.
  }
  try {
    db.exec(`ALTER TABLE lite_memory_rule_defs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '${nowIso()}'`);
  } catch {
    // Column already exists in initialized databases.
  }
  try {
    db.exec("ALTER TABLE lite_memory_edges ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists in initialized databases.
  }
  const executionNativeAddedColumns = [
    "task_family TEXT",
    "repo_signature TEXT",
    "file_cluster TEXT",
    "target_files_text TEXT",
    "tool_chain_signature TEXT",
    "failure_mode TEXT",
    "verification_signature TEXT",
    "acceptance_check_signature TEXT",
  ];
  for (const columnDef of executionNativeAddedColumns) {
    try {
      db.exec(`ALTER TABLE lite_memory_execution_native_index ADD COLUMN ${columnDef}`);
    } catch {
      // Column already exists in initialized databases.
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_family_created
      ON lite_memory_execution_native_index(scope, task_family, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_repo_created
      ON lite_memory_execution_native_index(scope, repo_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_failure_created
      ON lite_memory_execution_native_index(scope, failure_mode, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_verification_created
      ON lite_memory_execution_native_index(scope, verification_signature, created_at DESC, node_id DESC);
    CREATE INDEX IF NOT EXISTS idx_lite_memory_execution_native_scope_acceptance_created
      ON lite_memory_execution_native_index(scope, acceptance_check_signature, created_at DESC, node_id DESC);
  `);

  const deleteExecutionNativeIndexRow = (scope: string, nodeId: string): void => {
    db.prepare(
      `DELETE FROM lite_memory_execution_native_index
       WHERE scope = ?
         AND node_id = ?`,
    ).run(scope, nodeId);
  };

  const deleteKeywordIndexRow = (scope: string, nodeId: string): void => {
    db.prepare(
      `DELETE FROM lite_memory_keyword_index
       WHERE scope = ?
         AND node_id = ?`,
    ).run(scope, nodeId);
  };

  const syncKeywordIndexFromNode = (scope: string, nodeId: string): void => {
    const row = db.prepare(
      `${LITE_MEMORY_NODE_SELECT_SQL}
       WHERE scope = ?
         AND id = ?
       LIMIT 1`,
    ).get(scope, nodeId) as LiteMemoryNodeDbRow | undefined;
    if (!row) {
      deleteKeywordIndexRow(scope, nodeId);
      return;
    }
    const slots = parseJsonObject(row.slots_json);
    const slotsText = buildLiteMemoryKeywordSlotsText(slots);
    const searchableText = [row.title, row.text_summary, slotsText]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n");
    if (!searchableText) {
      deleteKeywordIndexRow(scope, nodeId);
      return;
    }
    db.prepare(
      `INSERT INTO lite_memory_keyword_index
        (scope, node_id, title, text_summary, slots_text, searchable_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, node_id) DO UPDATE SET
         title = excluded.title,
         text_summary = excluded.text_summary,
         slots_text = excluded.slots_text,
         searchable_text = excluded.searchable_text,
         updated_at = excluded.updated_at`,
    ).run(
      scope,
      nodeId,
      row.title,
      row.text_summary,
      slotsText,
      searchableText,
      nowIso(),
    );
  };

  const syncExecutionNativeIndexFromNode = (scope: string, nodeId: string): void => {
    const row = db.prepare(
      `${LITE_MEMORY_NODE_SELECT_SQL}
       WHERE scope = ?
         AND id = ?
       LIMIT 1`,
    ).get(scope, nodeId) as LiteMemoryNodeDbRow | undefined;
    if (!row) {
      deleteExecutionNativeIndexRow(scope, nodeId);
      return;
    }
    const decoded = decodeLiteFindNodeRow(row);
    const indexRow = executionNativeIndexRowFromNode(decoded);
    if (!indexRow) {
      deleteExecutionNativeIndexRow(scope, nodeId);
      return;
    }
    db.prepare(
      `INSERT INTO lite_memory_execution_native_index
        (scope, node_id, execution_kind, anchor_kind, pattern_state, task_signature, error_signature,
         workflow_signature, pattern_signature, task_family, repo_signature, file_cluster, target_files_text,
         tool_chain_signature, failure_mode, verification_signature, acceptance_check_signature, compression_layer,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, node_id) DO UPDATE SET
         execution_kind = excluded.execution_kind,
         anchor_kind = excluded.anchor_kind,
         pattern_state = excluded.pattern_state,
         task_signature = excluded.task_signature,
         error_signature = excluded.error_signature,
         workflow_signature = excluded.workflow_signature,
         pattern_signature = excluded.pattern_signature,
         task_family = excluded.task_family,
         repo_signature = excluded.repo_signature,
         file_cluster = excluded.file_cluster,
         target_files_text = excluded.target_files_text,
         tool_chain_signature = excluded.tool_chain_signature,
         failure_mode = excluded.failure_mode,
         verification_signature = excluded.verification_signature,
         acceptance_check_signature = excluded.acceptance_check_signature,
         compression_layer = excluded.compression_layer,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ).run(
      scope,
      nodeId,
      indexRow.execution_kind,
      indexRow.anchor_kind,
      indexRow.pattern_state,
      indexRow.task_signature,
      indexRow.error_signature,
      indexRow.workflow_signature,
      indexRow.pattern_signature,
      indexRow.task_family,
      indexRow.repo_signature,
      indexRow.file_cluster,
      indexRow.target_files_text,
      indexRow.tool_chain_signature,
      indexRow.failure_mode,
      indexRow.verification_signature,
      indexRow.acceptance_check_signature,
      indexRow.compression_layer,
      decoded.created_at,
      nowIso(),
    );
  };

  const rebuildExecutionNativeIndex = (): void => {
    db.prepare("DELETE FROM lite_memory_execution_native_index").run();
    const rows = db.prepare(
      `SELECT scope, id
       FROM lite_memory_nodes
       WHERE slots_json LIKE ? ESCAPE '\\'`,
    ).all(`%"${escapeSqlLike("execution_native_v1")}"%`) as Array<{ scope: string; id: string }>;
    for (const row of rows) {
      syncExecutionNativeIndexFromNode(row.scope, row.id);
    }
  };

  rebuildExecutionNativeIndex();

  const rebuildKeywordIndex = (): void => {
    db.prepare("DELETE FROM lite_memory_keyword_index").run();
    const rows = db.prepare(
      `SELECT scope, id
       FROM lite_memory_nodes`,
    ).all() as Array<{ scope: string; id: string }>;
    for (const row of rows) {
      syncKeywordIndexFromNode(row.scope, row.id);
    }
  };

  rebuildKeywordIndex();

  return {
    capability_version: WRITE_STORE_ACCESS_CAPABILITY_VERSION,

    async withTx<T>(fn: () => Promise<T>): Promise<T> {
      const existingContext = postCommitStorage.getStore();
      if (existingContext) return await transaction.run(fn);

      const context: LiteWritePostCommitContext = { callbacks: [] };
      const out = await postCommitStorage.run(context, () => transaction.run(fn));
      await flushPostCommitSideEffects(context.callbacks);
      return out;
    },

    async findNodes(args): Promise<{ rows: LiteFindNodeRow[]; has_more: boolean }> {
      const where: string[] = ["scope = ?"];
      const params: unknown[] = [args.scope];
      if (args.id) {
        where.push("id = ?");
        params.push(args.id);
      }
      if (args.type) {
        where.push("type = ?");
        params.push(args.type);
      }
      if (args.clientId) {
        where.push("client_id = ?");
        params.push(args.clientId);
      }
      if (args.titleContains) {
        where.push("LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'");
        params.push(`%${escapeSqlLike(args.titleContains.toLowerCase())}%`);
      }
      if (args.textContains) {
        where.push("LOWER(COALESCE(text_summary, '')) LIKE ? ESCAPE '\\'");
        params.push(`%${escapeSqlLike(args.textContains.toLowerCase())}%`);
      }
      if (args.memoryLane) {
        where.push("memory_lane = ?");
        params.push(args.memoryLane);
      }
      const consumerAgentId = args.consumerAgentId ?? null;
      const consumerTeamId = args.consumerTeamId ?? null;
      appendVisibilityWhere({ where, params, consumerAgentId, consumerTeamId });
      const slotsSql = buildSimpleSlotsSqlFilters(args.slotsContains);
      where.push(...slotsSql.where);
      params.push(...slotsSql.params);
      const requiresSlotsJsonVerification = !!args.slotsContains;
      const limitOffsetSql = requiresSlotsJsonVerification ? "" : " LIMIT ? OFFSET ?";
      const queryParams = requiresSlotsJsonVerification
        ? params
        : [...params, args.limit + 1, args.offset];
      const rows = db.prepare(
        `${LITE_MEMORY_NODE_SELECT_SQL}
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC${limitOffsetSql}`,
      ).all(...queryParams) as LiteMemoryNodeDbRow[];
      const filtered = rows
        .map(decodeLiteFindNodeRow)
        .filter((row) => !args.slotsContains || jsonContains(row.slots, args.slotsContains));
      const slice = requiresSlotsJsonVerification
        ? filtered.slice(args.offset, args.offset + args.limit + 1)
        : filtered;
      const hasMore = slice.length > args.limit;
      return {
        rows: hasMore ? slice.slice(0, args.limit) : slice,
        has_more: hasMore,
      };
    },

    async findExecutionNativeNodes(args): Promise<{ rows: LiteExecutionNativeNodeRow[]; has_more: boolean }> {
      const where: string[] = ["i.scope = ?"];
      const params: unknown[] = [args.scope];
      if (args.executionKind) {
        where.push("i.execution_kind = ?");
        params.push(args.executionKind);
      }
      if (args.anchorKind) {
        where.push("i.anchor_kind = ?");
        params.push(args.anchorKind);
      }
      if (args.patternState) {
        where.push("i.pattern_state = ?");
        params.push(args.patternState);
      }
      if (args.taskSignature) {
        where.push("i.task_signature = ?");
        params.push(args.taskSignature);
      }
      if (args.errorSignature) {
        where.push("i.error_signature = ?");
        params.push(args.errorSignature);
      }
      if (args.workflowSignature) {
        where.push("i.workflow_signature = ?");
        params.push(args.workflowSignature);
      }
      if (args.patternSignature) {
        where.push("i.pattern_signature = ?");
        params.push(args.patternSignature);
      }
      if (args.compressionLayer) {
        where.push("i.compression_layer = ?");
        params.push(args.compressionLayer);
      }
      appendVisibilityWhereForAlias({
        where,
        params,
        alias: "n",
        consumerAgentId: args.consumerAgentId ?? null,
        consumerTeamId: args.consumerTeamId ?? null,
      });
      const rows = db.prepare(
        `${LITE_MEMORY_NODE_SELECT_COLUMNS_SQL}
         FROM (
           SELECT n.*
           FROM lite_memory_execution_native_index i
           JOIN lite_memory_nodes n
             ON n.scope = i.scope
            AND n.id = i.node_id
           WHERE ${where.join(" AND ")}
           ORDER BY i.created_at DESC, i.node_id DESC
           LIMIT ? OFFSET ?
         )`,
      ).all(...params, args.limit + 1, args.offset) as LiteMemoryNodeDbRow[];
      const decoded = rows
        .map(decodeLiteFindNodeRow)
        .map((row) => {
          const executionNative = resolveNodeNativeExecutionSurface(row.slots);
          if (!executionNative) return null;
          return {
            ...row,
            execution_native: executionNative as ExecutionNativeV1,
          } satisfies LiteExecutionNativeNodeRow;
        })
        .filter((row): row is LiteExecutionNativeNodeRow => !!row);
      const hasMore = rows.length > args.limit;
      return {
        rows: hasMore ? decoded.slice(0, args.limit) : decoded,
        has_more: hasMore,
      };
    },

    async findLatestNodeByClientId(scope: string, type: string, clientId: string): Promise<LiteLatestNodeView | null> {
      const row = db.prepare(
        `SELECT id
         FROM lite_memory_nodes
         WHERE scope = ? AND type = ? AND client_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(scope, type, clientId) as LiteLatestNodeView | undefined;
      return row ?? null;
    },

    async resolveNode(args): Promise<LiteResolveNodeRow | null> {
      const { rows } = await this.findNodes({
        scope: args.scope,
        id: args.id,
        type: args.type,
        consumerAgentId: args.consumerAgentId ?? null,
        consumerTeamId: args.consumerTeamId ?? null,
        limit: 1,
        offset: 0,
      });
      const row = rows[0];
      return row ? { ...row, commit_scope: args.scope } : null;
    },

    async resolveEdge(args): Promise<LiteResolveEdgeRow | null> {
      const row = db.prepare(
        `SELECT
           e.id,
           e.type,
           e.src_id,
           s.type AS src_type,
           s.memory_lane AS src_memory_lane,
           s.owner_agent_id AS src_owner_agent_id,
           s.owner_team_id AS src_owner_team_id,
           e.dst_id,
           d.type AS dst_type,
           d.memory_lane AS dst_memory_lane,
           d.owner_agent_id AS dst_owner_agent_id,
           d.owner_team_id AS dst_owner_team_id,
           e.weight,
           e.confidence,
           e.decay_rate,
           e.created_at,
           e.commit_id
         FROM lite_memory_edges e
         JOIN lite_memory_nodes s ON s.id = e.src_id AND s.scope = e.scope
         JOIN lite_memory_nodes d ON d.id = e.dst_id AND d.scope = e.scope
         WHERE e.scope = ? AND e.id = ?
         LIMIT 1`,
      ).get(args.scope, args.id) as (
        Omit<LiteResolveEdgeRow, "last_activated" | "commit_scope">
        & {
          src_memory_lane: "private" | "shared";
          src_owner_agent_id: string | null;
          src_owner_team_id: string | null;
          dst_memory_lane: "private" | "shared";
          dst_owner_agent_id: string | null;
          dst_owner_team_id: string | null;
        }
      ) | undefined;
      if (!row) return null;
      if (
        !nodeVisible(
          {
            memory_lane: row.src_memory_lane,
            owner_agent_id: row.src_owner_agent_id,
            owner_team_id: row.src_owner_team_id,
          },
          args.consumerAgentId ?? null,
          args.consumerTeamId ?? null,
        )
        || !nodeVisible(
          {
            memory_lane: row.dst_memory_lane,
            owner_agent_id: row.dst_owner_agent_id,
            owner_team_id: row.dst_owner_team_id,
          },
          args.consumerAgentId ?? null,
          args.consumerTeamId ?? null,
        )
      ) {
        return null;
      }
      return {
        ...row,
        last_activated: null,
        commit_scope: args.scope,
      };
    },

    async resolveCommit(args): Promise<LiteResolveCommitRow | null> {
      const row = db.prepare(
        `SELECT
           c.id,
           c.parent_commit_id AS parent_id,
           c.input_sha256,
           c.diff_json,
           c.actor,
           c.model_version,
           c.prompt_version,
           c.commit_hash,
           c.created_at,
           (SELECT count(*) FROM lite_memory_nodes n WHERE n.scope = c.scope AND n.commit_id = c.id) AS node_count,
           (SELECT count(*) FROM lite_memory_edges e WHERE e.scope = c.scope AND e.commit_id = c.id) AS edge_count
         FROM lite_memory_commits c
         WHERE c.scope = ? AND c.id = ?
         LIMIT 1`,
      ).get(args.scope, args.id) as {
        id: string;
        parent_id: string | null;
        input_sha256: string;
        diff_json: string;
        actor: string;
        model_version: string | null;
        prompt_version: string | null;
        commit_hash: string;
        created_at: string;
        node_count: number;
        edge_count: number;
      } | undefined;
      if (!row) return null;
      if (!commitVisible(db, args.scope, row.id, args.consumerAgentId ?? null, args.consumerTeamId ?? null)) return null;
      let diffJson: unknown = {};
      try {
        diffJson = JSON.parse(row.diff_json);
      } catch {
        diffJson = {};
      }
      return {
        id: row.id,
        parent_id: row.parent_id,
        input_sha256: row.input_sha256,
        diff_json: diffJson,
        actor: row.actor,
        model_version: row.model_version,
        prompt_version: row.prompt_version,
        commit_hash: row.commit_hash,
        created_at: row.created_at,
        node_count: Number(row.node_count ?? 0),
        edge_count: Number(row.edge_count ?? 0),
        decision_count: Number(
          (
            db.prepare(
              `SELECT count(*) AS count
               FROM lite_memory_execution_decisions
               WHERE scope = ?
                 AND commit_id = ?`,
            ).get(args.scope, row.id) as { count: number } | undefined
          )?.count ?? 0,
        ),
      };
    },

    async resolveDecision(args): Promise<LiteResolveDecisionRow | null> {
      const row = db.prepare(
        `${LITE_EXECUTION_DECISION_SELECT_SQL}
         WHERE scope = ?
           AND id = ?
         LIMIT 1`,
      ).get(args.scope, args.id) as LiteExecutionDecisionDbRow | undefined;
      if (!row) return null;
      const decoded = decodeExecutionDecisionRow(row);
      if (
        (row.commit_id && !commitVisible(db, args.scope, row.commit_id, args.consumerAgentId ?? null, args.consumerTeamId ?? null))
        || !decisionSourceRulesVisible(
          db,
          args.scope,
          decoded.source_rule_ids,
          args.consumerAgentId ?? null,
          args.consumerTeamId ?? null,
        )
      ) {
        return null;
      }
      return {
        ...decoded,
        commit_scope: row.commit_id ? args.scope : null,
      };
    },

    async listRuleCandidates(args): Promise<LiteRuleCandidateRow[]> {
      const allowedStates = new Set((args.states && args.states.length > 0 ? args.states : ["shadow", "active"]).map(String));
      const rows = db.prepare(
        `SELECT
           d.rule_node_id,
           d.state,
           d.rule_scope,
           d.target_agent_id,
         d.target_team_id,
         d.if_json,
         d.then_json,
         d.exceptions_json,
         d.positive_count,
         d.negative_count,
          d.commit_id,
          d.updated_at,
          n.memory_lane,
          n.owner_agent_id,
          n.owner_team_id,
           n.text_summary,
           n.slots_json
         FROM lite_memory_rule_defs d
         JOIN lite_memory_nodes n ON n.id = d.rule_node_id AND n.scope = d.scope
         WHERE d.scope = ?
         ORDER BY d.created_at DESC, d.rule_node_id ASC`,
      ).all(args.scope) as Array<{
        rule_node_id: string;
        state: "draft" | "shadow" | "active" | "disabled";
        rule_scope: "global" | "team" | "agent";
        target_agent_id: string | null;
        target_team_id: string | null;
        if_json: string;
        then_json: string;
        exceptions_json: string;
        positive_count: number;
        negative_count: number;
        commit_id: string;
        updated_at: string;
        memory_lane: "private" | "shared";
        owner_agent_id: string | null;
        owner_team_id: string | null;
        text_summary: string | null;
        slots_json: string;
      }>;
      return rows
        .filter((row) => allowedStates.has(row.state) && (row.state === "shadow" || row.state === "active"))
        .slice(0, Math.max(0, args.limit))
        .map((row) => ({
          rule_node_id: row.rule_node_id,
          state: row.state,
          rule_scope: row.rule_scope,
          target_agent_id: row.target_agent_id,
          target_team_id: row.target_team_id,
          rule_memory_lane: row.memory_lane,
          rule_owner_agent_id: row.owner_agent_id,
          rule_owner_team_id: row.owner_team_id,
          if_json: parseJsonObject(row.if_json),
          then_json: parseJsonObject(row.then_json),
          exceptions_json: parseJsonArray(row.exceptions_json),
          positive_count: Number(row.positive_count ?? 0),
          negative_count: Number(row.negative_count ?? 0),
          rule_commit_id: row.commit_id,
          rule_summary: row.text_summary,
          rule_slots: parseJsonObject(row.slots_json),
          updated_at: row.updated_at,
        }));
    },

    async getRuleDef(scope: string, ruleNodeId: string): Promise<LiteRuleDefSyncRow | null> {
      const row = db.prepare(
        `SELECT
           scope,
           rule_node_id,
           state,
           rule_scope,
           target_agent_id,
           target_team_id,
           if_json,
           then_json,
           exceptions_json,
           positive_count,
           negative_count,
           commit_id,
           updated_at
         FROM lite_memory_rule_defs
         WHERE scope = ?
           AND rule_node_id = ?
         LIMIT 1`,
      ).get(scope, ruleNodeId) as {
        scope: string;
        rule_node_id: string;
        state: "draft" | "shadow" | "active" | "disabled";
        rule_scope: "global" | "team" | "agent";
        target_agent_id: string | null;
        target_team_id: string | null;
        if_json: string;
        then_json: string;
        exceptions_json: string;
        positive_count: number;
        negative_count: number;
        commit_id: string | null;
        updated_at: string;
      } | undefined;
      if (!row) return null;
      return {
        scope: row.scope,
        rule_node_id: row.rule_node_id,
        state: row.state,
        rule_scope: row.rule_scope,
        target_agent_id: row.target_agent_id,
        target_team_id: row.target_team_id,
        if_json: parseJsonObject(row.if_json),
        then_json: parseJsonObject(row.then_json),
        exceptions_json: parseJsonArray(row.exceptions_json),
        positive_count: Number(row.positive_count ?? 0),
        negative_count: Number(row.negative_count ?? 0),
        commit_id: row.commit_id,
        updated_at: row.updated_at,
      };
    },

    async upsertRuleState(args): Promise<LiteRuleDefSyncRow> {
      const createdAt = nowIso();
      const updatedAt = createdAt;
      db.prepare(
        `INSERT INTO lite_memory_rule_defs
          (rule_node_id, scope, state, if_json, then_json, exceptions_json, rule_scope, target_agent_id, target_team_id, positive_count, negative_count, commit_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_node_id) DO UPDATE SET
           state = excluded.state,
           if_json = excluded.if_json,
           then_json = excluded.then_json,
           exceptions_json = excluded.exceptions_json,
           rule_scope = excluded.rule_scope,
           target_agent_id = excluded.target_agent_id,
           target_team_id = excluded.target_team_id,
           commit_id = excluded.commit_id,
           updated_at = excluded.updated_at
         WHERE lite_memory_rule_defs.scope = excluded.scope`,
      ).run(
        args.ruleNodeId,
        args.scope,
        args.state,
        stringifyJson(args.ifJson),
        stringifyJson(args.thenJson),
        stringifyJson(args.exceptionsJson),
        args.ruleScope,
        args.targetAgentId,
        args.targetTeamId,
        args.positiveCount,
        args.negativeCount,
        args.commitId,
        createdAt,
        updatedAt,
      );
      const row = await this.getRuleDef(args.scope, args.ruleNodeId);
      if (!row) {
        throw new Error("lite_rule_def_upsert_failed");
      }
      return row;
    },

    async insertExecutionDecision(args): Promise<{ id: string; created_at: string }> {
      const createdAt = nowIso();
      db.prepare(
        `INSERT OR REPLACE INTO lite_memory_execution_decisions
          (id, scope, decision_kind, run_id, selected_tool, candidates_json, context_sha256, policy_sha256,
           source_rule_ids_json, metadata_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.id,
        args.scope,
        args.decisionKind,
        args.runId,
        args.selectedTool,
        stringifyJson(args.candidatesJson),
        args.contextSha256,
        args.policySha256,
        stringifyJson(args.sourceRuleIds),
        stringifyJson(args.metadataJson),
        args.commitId,
        createdAt,
      );
      return { id: args.id, created_at: createdAt };
    },

    async getExecutionDecision(args): Promise<LiteExecutionDecisionRow | null> {
      const row = args.id
        ? db.prepare(
            `${LITE_EXECUTION_DECISION_SELECT_SQL}
             WHERE scope = ?
               AND id = ?
             LIMIT 1`,
          ).get(args.scope, args.id)
        : db.prepare(
            `${LITE_EXECUTION_DECISION_SELECT_SQL}
             WHERE scope = ?
               AND run_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
          ).get(args.scope, args.runId ?? null);
      if (!row) return null;
      return decodeExecutionDecisionRow(row as LiteExecutionDecisionDbRow);
    },

    async listExecutionDecisionsByRun(args): Promise<{
      count: number;
      latest_created_at: string | null;
      rows: LiteExecutionDecisionRow[];
    }> {
      const stats = db.prepare(
        `SELECT
           COUNT(*) AS count,
           MAX(created_at) AS latest_created_at
         FROM lite_memory_execution_decisions
         WHERE scope = ?
           AND run_id = ?`,
      ).get(args.scope, args.runId) as {
        count: number;
        latest_created_at: string | null;
      };
      const rows = db.prepare(
        `${LITE_EXECUTION_DECISION_SELECT_SQL}
         WHERE scope = ?
           AND run_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).all(args.scope, args.runId, Math.max(1, args.limit)) as LiteExecutionDecisionDbRow[];
      return {
        count: Number(stats?.count ?? 0),
        latest_created_at: stats?.latest_created_at ?? null,
        rows: rows.map(decodeExecutionDecisionRow),
      };
    },

    async listExecutionRuns(args): Promise<Array<{
      run_id: string;
      decision_count: number;
      latest_decision_at: string;
      latest_selected_tool: string | null;
      feedback_total: number;
      latest_feedback_at: string | null;
    }>> {
      const rows = db.prepare(
        `SELECT
           d.run_id AS run_id,
           COUNT(*) AS decision_count,
           MAX(d.created_at) AS latest_decision_at,
           (
             SELECT d2.selected_tool
             FROM lite_memory_execution_decisions d2
             WHERE d2.scope = d.scope
               AND d2.run_id = d.run_id
             ORDER BY d2.created_at DESC, d2.id DESC
             LIMIT 1
           ) AS latest_selected_tool,
           COALESCE((
             SELECT COUNT(*)
             FROM lite_memory_rule_feedback f
             WHERE f.scope = d.scope
               AND f.run_id = d.run_id
           ), 0) AS feedback_total,
           (
             SELECT MAX(f.created_at)
             FROM lite_memory_rule_feedback f
             WHERE f.scope = d.scope
               AND f.run_id = d.run_id
           ) AS latest_feedback_at
         FROM lite_memory_execution_decisions d
         WHERE d.scope = ?
           AND d.run_id IS NOT NULL
         GROUP BY d.run_id
         ORDER BY latest_decision_at DESC, d.run_id DESC
         LIMIT ?`,
      ).all(args.scope, Math.max(1, args.limit)) as Array<{
        run_id: string;
        decision_count: number;
        latest_decision_at: string;
        latest_selected_tool: string | null;
        feedback_total: number;
        latest_feedback_at: string | null;
      }>;
      return rows.map((row) => ({
        run_id: row.run_id,
        decision_count: Number(row.decision_count ?? 0),
        latest_decision_at: row.latest_decision_at,
        latest_selected_tool: row.latest_selected_tool ?? null,
        feedback_total: Number(row.feedback_total ?? 0),
        latest_feedback_at: row.latest_feedback_at ?? null,
      }));
    },

    async findExecutionDecisionForFeedback(args): Promise<LiteExecutionDecisionRow | null> {
      const rows = db.prepare(
        `${LITE_EXECUTION_DECISION_SELECT_SQL}
         WHERE scope = ?
           AND selected_tool = ?
           AND context_sha256 = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
      ).all(args.scope, args.selectedTool, args.contextSha256) as LiteExecutionDecisionDbRow[];
      const wanted = stringifyJson(args.candidatesJson);
      const matched = rows
        .filter((row) => (args.runId ? row.run_id === args.runId : true))
        .find((row) => row.candidates_json === wanted);
      if (!matched) return null;
      return decodeExecutionDecisionRow(matched);
    },

    async updateExecutionDecisionLink(args): Promise<LiteExecutionDecisionRow | null> {
      const updates: string[] = [];
      const params: Array<string | null> = [];
      if (args.runId !== undefined) {
        updates.push("run_id = ?");
        params.push(args.runId);
      }
      if (args.commitId !== undefined) {
        updates.push("commit_id = ?");
        params.push(args.commitId);
      }
      if (updates.length === 0) {
        return await this.getExecutionDecision({ scope: args.scope, id: args.id });
      }
      params.push(args.scope, args.id);
      db.prepare(
        `UPDATE lite_memory_execution_decisions
         SET ${updates.join(", ")}
         WHERE scope = ?
           AND id = ?`,
      ).run(...params);
      return await this.getExecutionDecision({ scope: args.scope, id: args.id });
    },

    async latestCommit(scope: string): Promise<{ id: string; commit_hash: string } | null> {
      const row = db.prepare(
        `SELECT id, commit_hash
         FROM lite_memory_commits
         WHERE scope = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      ).get(scope) as { id: string; commit_hash: string } | undefined;
      return row ?? null;
    },

    async insertRuleFeedback(args): Promise<void> {
      db.prepare(
        `INSERT OR REPLACE INTO lite_memory_rule_feedback
          (id, scope, rule_node_id, run_id, outcome, note, source, decision_id, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.id,
        args.scope,
        args.ruleNodeId,
        args.runId,
        args.outcome,
        args.note,
        args.source,
        args.decisionId,
        args.commitId,
        args.createdAt ?? nowIso(),
      );
    },

    async listRuleFeedbackByRun(args): Promise<{
      total: number;
      positive: number;
      negative: number;
      neutral: number;
      linked_decision_count: number;
      tools_feedback_count: number;
      latest_feedback_at: string | null;
      rows: LiteRuleFeedbackRow[];
    }> {
      const stats = db.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN outcome = 'positive' THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN outcome = 'negative' THEN 1 ELSE 0 END) AS negative,
           SUM(CASE WHEN outcome = 'neutral' THEN 1 ELSE 0 END) AS neutral,
           SUM(CASE WHEN decision_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_decision_count,
           SUM(CASE WHEN source = 'tools_feedback' THEN 1 ELSE 0 END) AS tools_feedback_count,
           MAX(created_at) AS latest_feedback_at
         FROM lite_memory_rule_feedback
         WHERE scope = ?
           AND run_id = ?`,
      ).get(args.scope, args.runId) as {
        total: number;
        positive: number | null;
        negative: number | null;
        neutral: number | null;
        linked_decision_count: number | null;
        tools_feedback_count: number | null;
        latest_feedback_at: string | null;
      };
      const rows = db.prepare(
        `SELECT
           id,
           scope,
           rule_node_id,
           run_id,
           outcome,
           note,
           source,
           decision_id,
           commit_id,
           created_at
         FROM lite_memory_rule_feedback
         WHERE scope = ?
           AND run_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).all(args.scope, args.runId, Math.max(1, args.limit)) as LiteRuleFeedbackRow[];
      return {
        total: Number(stats?.total ?? 0),
        positive: Number(stats?.positive ?? 0),
        negative: Number(stats?.negative ?? 0),
        neutral: Number(stats?.neutral ?? 0),
        linked_decision_count: Number(stats?.linked_decision_count ?? 0),
        tools_feedback_count: Number(stats?.tools_feedback_count ?? 0),
        latest_feedback_at: stats?.latest_feedback_at ?? null,
        rows,
      };
    },

    async updateRuleFeedbackAggregates(args): Promise<LiteRuleCandidateRow[]> {
      const nextUpdatedAt = nowIso();
      for (const ruleNodeId of args.ruleNodeIds) {
        db.prepare(
          `UPDATE lite_memory_rule_defs
           SET
             positive_count = positive_count + ?,
             negative_count = negative_count + ?,
             updated_at = ?
           WHERE scope = ?
             AND rule_node_id = ?`,
        ).run(
          args.outcome === "positive" ? 1 : 0,
          args.outcome === "negative" ? 1 : 0,
          nextUpdatedAt,
          args.scope,
          ruleNodeId,
        );
      }
      return await this.listRuleCandidates({
        scope: args.scope,
        limit: Math.max(1, args.ruleNodeIds.length),
        states: ["shadow", "active"],
      }).then((rows) => rows.filter((row) => args.ruleNodeIds.includes(row.rule_node_id)));
    },

    async nodeScopesByIds(ids: string[]): Promise<Map<string, string>> {
      if (ids.length === 0) return new Map();
      const sql = `SELECT id, scope FROM lite_memory_nodes WHERE id IN (${ids.map(() => "?").join(",")})`;
      const rows = db.prepare(sql).all(...ids) as Array<{ id: string; scope: string }>;
      return new Map(rows.map((row) => [row.id, row.scope]));
    },

    async nodeFingerprintsByIds(ids: string[]): Promise<Map<string, WriteExistingNodeFingerprint>> {
      if (ids.length === 0) return new Map();
      const sql = `
        SELECT
          id,
          scope,
          client_id,
          type,
          tier,
          title,
          text_summary,
          slots_json,
          raw_ref,
          evidence_ref,
          embedding_vector_json AS embedding_vector,
          embedding_model,
          memory_lane,
          producer_agent_id,
          owner_agent_id,
          owner_team_id,
          embedding_status,
          embedding_last_error,
          salience,
          importance,
          confidence,
          redaction_version
        FROM lite_memory_nodes
        WHERE id IN (${ids.map(() => "?").join(",")})
      `;
      const rows = db.prepare(sql).all(...ids) as Array<{
        id: string;
        scope: string;
        client_id: string | null;
        type: string;
        tier: string;
        title: string | null;
        text_summary: string | null;
        slots_json: string;
        raw_ref: string | null;
        evidence_ref: string | null;
        embedding_vector: string | null;
        embedding_model: string | null;
        memory_lane: "private" | "shared";
        producer_agent_id: string | null;
        owner_agent_id: string | null;
        owner_team_id: string | null;
        embedding_status: "pending" | "ready" | "failed";
        embedding_last_error: string | null;
        salience: number;
        importance: number;
        confidence: number;
        redaction_version: number;
      }>;
      return new Map(
        rows.map((row) => [
          row.id,
          {
            scope: row.scope,
            fingerprint: writeNodeFingerprint({
              id: row.id,
              scope: row.scope,
              clientId: row.client_id,
              type: row.type,
              tier: row.tier,
              title: row.title,
              textSummary: row.text_summary,
              slotsJson: row.slots_json,
              rawRef: row.raw_ref,
              evidenceRef: row.evidence_ref,
              embeddingVector: row.embedding_vector,
              embeddingModel: row.embedding_model,
              memoryLane: row.memory_lane,
              producerAgentId: row.producer_agent_id,
              ownerAgentId: row.owner_agent_id,
              ownerTeamId: row.owner_team_id,
              embeddingStatus: row.embedding_status,
              embeddingLastError: row.embedding_last_error,
              salience: row.salience,
              importance: row.importance,
              confidence: row.confidence,
              redactionVersion: row.redaction_version,
            }),
          },
        ]),
      );
    },

    async lifecycleCandidateNodes(scope: string, limit: number): Promise<WriteLifecycleCandidateNodeRow[]> {
      const boundedLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
      const rows = db.prepare(`
        SELECT
          id,
          type,
          title,
          text_summary,
          slots_json,
          tier,
          memory_lane,
          owner_agent_id,
          owner_team_id,
          salience,
          confidence,
          created_at
        FROM lite_memory_nodes
        WHERE scope = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(scope, boundedLimit) as Array<{
        id: string;
        type: string;
        title: string | null;
        text_summary: string | null;
        slots_json: string;
        tier: string;
        memory_lane: "private" | "shared";
        owner_agent_id: string | null;
        owner_team_id: string | null;
        salience: number;
        confidence: number;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        text_summary: row.text_summary,
        slots: parseJsonObject(row.slots_json),
        tier: row.tier,
        memory_lane: row.memory_lane,
        owner_agent_id: row.owner_agent_id,
        owner_team_id: row.owner_team_id,
        salience: row.salience,
        confidence: row.confidence,
        created_at: row.created_at,
        updated_at: row.created_at,
      }));
    },

    async parentCommitHash(scope: string, parentCommitId: string): Promise<string | null> {
      const row = db.prepare(
        `SELECT commit_hash FROM lite_memory_commits WHERE scope = ? AND id = ? LIMIT 1`,
      ).get(scope, parentCommitId) as { commit_hash: string } | undefined;
      return row?.commit_hash ?? null;
    },

    async insertCommit(args: WriteCommitInsertArgs): Promise<string> {
      const existing = db.prepare(
        `SELECT id FROM lite_memory_commits WHERE commit_hash = ? LIMIT 1`,
      ).get(args.commitHash) as { id: string } | undefined;
      if (existing?.id) return existing.id;
      const id = stableUuid(`lite:commit:${args.commitHash}`);
      db.prepare(
        `INSERT OR IGNORE INTO lite_memory_commits
          (id, scope, parent_commit_id, input_sha256, diff_json, actor, model_version, prompt_version, commit_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        args.scope,
        args.parentCommitId,
        args.inputSha256,
        args.diffJson,
        args.actor,
        args.modelVersion,
        args.promptVersion,
        args.commitHash,
        nowIso(),
      );
      return id;
    },

    async insertNode(args: WriteNodeInsertArgs): Promise<void> {
      db.prepare(
        `INSERT OR IGNORE INTO lite_memory_nodes
          (id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
           embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
           embedding_status, embedding_last_error, salience, importance, confidence, redaction_version, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.id,
        args.scope,
        args.clientId,
        args.type,
        args.tier,
        args.title,
        args.textSummary,
        args.slotsJson,
        args.rawRef,
        args.evidenceRef,
        args.embeddingVector,
        args.embeddingModel,
        args.memoryLane,
        args.producerAgentId,
        args.ownerAgentId,
        args.ownerTeamId,
        args.embeddingStatus,
        args.embeddingLastError,
        args.salience,
        args.importance,
        args.confidence,
        args.redactionVersion,
        args.commitId,
        nowIso(),
      );
      syncExecutionNativeIndexFromNode(args.scope, args.id);
      syncKeywordIndexFromNode(args.scope, args.id);
      await scheduleAnnNodeSync(args.scope, args.id);
    },

    async insertRuleDef(args: WriteRuleDefInsertArgs): Promise<void> {
      const ts = nowIso();
      db.prepare(
        `INSERT OR IGNORE INTO lite_memory_rule_defs
          (rule_node_id, scope, state, if_json, then_json, exceptions_json, rule_scope, target_agent_id, target_team_id, positive_count, negative_count, commit_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      ).run(
        args.ruleNodeId,
        args.scope,
        args.state,
        args.ifJson,
        args.thenJson,
        args.exceptionsJson,
        args.ruleScope,
        args.targetAgentId,
        args.targetTeamId,
        args.commitId,
        ts,
        ts,
      );
    },

    async upsertEdge(args: WriteEdgeUpsertArgs): Promise<void> {
      db.prepare(
        `INSERT INTO lite_memory_edges
          (id, scope, type, src_id, dst_id, weight, confidence, decay_rate, metadata_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, type, src_id, dst_id) DO UPDATE SET
           weight = MAX(lite_memory_edges.weight, excluded.weight),
           confidence = MAX(lite_memory_edges.confidence, excluded.confidence),
           metadata_json = excluded.metadata_json,
           commit_id = excluded.commit_id`,
      ).run(
        args.id,
        args.scope,
        args.type,
        args.srcId,
        args.dstId,
        args.weight,
        args.confidence,
        args.decayRate,
        stringifyJson(args.metadataJson),
        args.commitId,
        nowIso(),
      );
    },

    async readyEmbeddingNodeIds(scope: string, ids: string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const sql = `
        SELECT id
        FROM lite_memory_nodes
        WHERE scope = ?
          AND id IN (${ids.map(() => "?").join(",")})
          AND embedding_status = 'ready'
          AND embedding_vector_json IS NOT NULL
      `;
      const rows = db.prepare(sql).all(scope, ...ids) as Array<{ id: string }>;
      return new Set(rows.map((row) => row.id));
    },

    async insertOutboxEvent(args: WriteOutboxInsertArgs): Promise<void> {
      db.prepare(
        `INSERT OR IGNORE INTO lite_memory_outbox
          (scope, commit_id, event_type, job_key, payload_sha256, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.scope,
        args.commitId,
        args.eventType,
        args.jobKey,
        args.payloadSha256,
        args.payloadJson,
        nowIso(),
      );
    },

    async upsertAssociationCandidates(args: UpsertAssociationCandidateArgs[]): Promise<void> {
      if (args.length === 0) return;
      const stmt = db.prepare(
        `INSERT INTO lite_memory_association_candidates
          (id, scope, src_id, dst_id, relation_kind, status, score, confidence,
           feature_summary_json, evidence_json, source_commit_id, worker_run_id, promoted_edge_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, src_id, dst_id, relation_kind) DO UPDATE SET
           status = CASE
             WHEN lite_memory_association_candidates.status = 'promoted' AND excluded.status = 'shadow'
               THEN lite_memory_association_candidates.status
             ELSE excluded.status
           END,
           score = excluded.score,
           confidence = excluded.confidence,
           feature_summary_json = excluded.feature_summary_json,
           evidence_json = excluded.evidence_json,
           source_commit_id = excluded.source_commit_id,
           worker_run_id = excluded.worker_run_id,
           promoted_edge_id = CASE
             WHEN lite_memory_association_candidates.status = 'promoted' AND excluded.status = 'shadow'
               THEN lite_memory_association_candidates.promoted_edge_id
             ELSE excluded.promoted_edge_id
           END,
           updated_at = excluded.updated_at`,
      );
      for (const candidate of args) {
        const ts = nowIso();
        stmt.run(
          stableUuid(`${candidate.scope}:assoc:${candidate.src_id}:${candidate.dst_id}:${candidate.relation_kind}`),
          candidate.scope,
          candidate.src_id,
          candidate.dst_id,
          candidate.relation_kind,
          candidate.status,
          candidate.score,
          candidate.confidence,
          stringifyJson(candidate.feature_summary_json),
          stringifyJson(candidate.evidence_json),
          candidate.source_commit_id,
          candidate.worker_run_id,
          candidate.promoted_edge_id,
          ts,
          ts,
        );
      }
    },

    async listAssociationCandidatesForSource(
      args: ListAssociationCandidatesForSourceArgs,
    ): Promise<AssociationCandidateRecord[]> {
      const limit = Math.max(1, Math.min(200, Math.trunc(args.limit ?? 50)));
      const statuses = Array.isArray(args.statuses) ? args.statuses : [];
      const statusFilter = statuses.length > 0;
      const params: unknown[] = [args.scope, args.src_id];
      let sql = `
        SELECT
          id,
          scope,
          src_id,
          dst_id,
          relation_kind,
          status,
          score,
          confidence,
          feature_summary_json,
          evidence_json,
          source_commit_id,
          worker_run_id,
          promoted_edge_id,
          created_at,
          updated_at
        FROM lite_memory_association_candidates
        WHERE scope = ?
          AND src_id = ?
      `;
      if (statusFilter) {
        sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
        params.push(...statuses);
      }
      params.push(limit);
      sql += ` ORDER BY score DESC, confidence DESC, updated_at DESC LIMIT ?`;
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        scope: string;
        src_id: string;
        dst_id: string;
        relation_kind: AssociationCandidateRecord["relation_kind"];
        status: AssociationCandidateRecord["status"];
        score: number;
        confidence: number;
        feature_summary_json: string;
        evidence_json: string;
        source_commit_id: string | null;
        worker_run_id: string | null;
        promoted_edge_id: string | null;
        created_at: string;
        updated_at: string;
      }>;
      return rows.map((row) => ({
        ...row,
        feature_summary_json: parseJsonObject(row.feature_summary_json),
        evidence_json: parseJsonObject(row.evidence_json),
      }));
    },

    async markAssociationCandidatePromoted(args: MarkAssociationCandidatePromotedArgs): Promise<void> {
      db.prepare(
        `UPDATE lite_memory_association_candidates
         SET status = 'promoted',
             promoted_edge_id = ?,
             updated_at = ?
         WHERE scope = ?
           AND src_id = ?
           AND dst_id = ?
           AND relation_kind = ?`,
      ).run(
        args.promoted_edge_id,
        nowIso(),
        args.scope,
        args.src_id,
        args.dst_id,
        args.relation_kind,
      );
    },

    async updateAssociationCandidateStatus(args: UpdateAssociationCandidateStatusArgs): Promise<void> {
      db.prepare(
        `UPDATE lite_memory_association_candidates
         SET status = ?,
             promoted_edge_id = COALESCE(?, promoted_edge_id),
             updated_at = ?
         WHERE scope = ?
           AND src_id = ?
           AND dst_id = ?
           AND relation_kind = ?`,
      ).run(
        args.status,
        args.promoted_edge_id ?? null,
        nowIso(),
        args.scope,
        args.src_id,
        args.dst_id,
        args.relation_kind,
      );
    },

    async appendAfterTopicClusterEventIds(scope: string, commitId: string, eventIdsJson: string): Promise<void> {
      let nextIds: unknown[] = [];
      try {
        const parsed = JSON.parse(eventIdsJson);
        nextIds = Array.isArray(parsed) ? parsed : [];
      } catch {
        nextIds = [];
      }
      const rows = db.prepare(
        `SELECT row_id, payload_json
         FROM lite_memory_outbox
         WHERE scope = ? AND commit_id = ? AND event_type = 'embed_nodes'`,
      ).all(scope, commitId) as Array<{ row_id: number; payload_json: string }>;
      for (const row of rows) {
        const payload = parseJsonObject(row.payload_json);
        const current = Array.isArray(payload.after_topic_cluster_event_ids) ? payload.after_topic_cluster_event_ids : [];
        const merged = [...new Set([...current, ...nextIds])];
        payload.after_topic_cluster_event_ids = merged;
        db.prepare(
          `UPDATE lite_memory_outbox SET payload_json = ? WHERE row_id = ?`,
        ).run(stringifyJson(payload), row.row_id);
      }
    },

    async setNodeEmbeddingReady(args): Promise<void> {
      assertDim(args.embedding, 1536);
      db.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_vector_json = ?,
             embedding_model = ?,
             embedding_status = 'ready',
             embedding_last_error = NULL
         WHERE scope = ?
           AND id = ?`,
      ).run(
        stringifyJson(args.embedding),
        args.embeddingModel,
        args.scope,
        args.id,
      );
      await scheduleAnnNodeSync(args.scope, args.id);
    },

    async updateNodeAnchorState(args): Promise<LiteFindNodeRow | null> {
      const updates = [
        "slots_json = ?",
        "text_summary = ?",
        "salience = ?",
        "importance = ?",
        "confidence = ?",
        "commit_id = COALESCE(?, commit_id)",
      ];
      const params: unknown[] = [
        stringifyJson(args.slots),
        args.textSummary,
        args.salience,
        args.importance,
        args.confidence,
        args.commitId ?? null,
      ];
      if (args.tier) {
        updates.push("tier = ?");
        params.push(args.tier);
      }
      params.push(args.scope, args.id);
      db.prepare(
        `UPDATE lite_memory_nodes
         SET ${updates.join(", ")}
         WHERE scope = ?
           AND id = ?`,
      ).run(...params);
      syncExecutionNativeIndexFromNode(args.scope, args.id);
      syncKeywordIndexFromNode(args.scope, args.id);
      await scheduleAnnNodeSync(args.scope, args.id);
      const { rows } = await this.findNodes({
        scope: args.scope,
        id: args.id,
        limit: 1,
        offset: 0,
      });
      return rows[0] ?? null;
    },

    async setNodeEmbeddingFailed(args): Promise<void> {
      db.prepare(
        `UPDATE lite_memory_nodes
         SET embedding_status = 'failed',
             embedding_last_error = ?
         WHERE scope = ?
           AND id = ?`,
      ).run(
        args.error,
        args.scope,
        args.id,
      );
      await scheduleAnnNodeDelete(args.id);
    },

    async close(): Promise<void> {
      db.close();
    },

    healthSnapshot() {
      return { path, mode: "sqlite_write_v1" as const };
    },
  };
}
