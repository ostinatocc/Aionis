import { readFileSync } from "node:fs";
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
import { assertAuthorityWriteReceipts } from "../memory/authority-write-guard.js";
import {
  authorityNodeEmbeddingText,
  EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON,
} from "../memory/node-embedding-freshness.js";
import type {
  AssociationCandidateRecord,
  ListAssociationCandidatesForSourceArgs,
  MarkAssociationCandidatePromotedArgs,
  UpdateAssociationCandidateStatusArgs,
  UpsertAssociationCandidateArgs,
} from "../memory/associative-candidate-store.js";
import { stableUuid } from "../util/uuid.js";
import { assertDim } from "../util/vector-literal.js";
import type { AuthorityReceiptResolvedKeyring } from
  "../util/authority-receipt-keys.js";
import { createLiteRuntimeDatabase, type LiteRuntimeDatabase } from "./lite-runtime-database.js";
import {
  assertLiteRuntimeSchemaPreflight,
  assertLiteRuntimeSchemaContractShape,
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
  recordCurrentLiteRuntimeWriteSchema,
  WRITE_SCHEMA_V5,
  WRITE_SCHEMA_V6,
  WRITE_SCHEMA_V7,
  WRITE_SCHEMA_V8,
  WRITE_SCHEMA_V9,
  WRITE_SCHEMA_V10,
  WRITE_SCHEMA_V11,
} from "./lite-runtime-schema.js";
import {
  compareAndSwapLiteMemoryScopeHead,
  insertLiteMemoryCommitV2InCurrentTransaction,
  migrateLiteMemoryCommitAuthorityV5,
  readLiteMemoryScopeHead,
} from "./lite-memory-commit-authority.js";
import {
  appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction,
} from "./lite-runtime-applied-authority.js";
import { authorityFenceForRuntimeTransaction } from
  "./lite-runtime-authority-transaction-fence.js";
import {
  beginLiteRuntimeOwnedSchemaMigration,
  type LiteRuntimeOwnedSchemaMigration,
} from "./lite-runtime-authority-transaction-fence.js";
import { migrateLiteRuntimeAuthorityAdoptionV6 } from
  "./lite-runtime-authority-adoption.js";
import { migrateLiteExecutionEpisodeV7 } from
  "./lite-execution-episode-schema.js";
import { migrateLiteExecutionVerifierLaunchV8 } from
  "./lite-execution-verifier-launch-schema.js";
import { migrateLiteExecutionSemanticEventsV9 } from
  "./lite-execution-semantic-event-schema.js";
import { migrateLiteExecutionSessionV10 } from
  "./lite-execution-session-schema.js";
import { migrateLiteRuntimeIdentitySchema } from "./lite-runtime-identity.js";
import {
  createLiteProjectionOutboxAccess,
  type LiteProjectionBacklogSnapshot,
  type LiteProjectionOutboxAccess,
} from "./lite-projection-outbox.js";
import type {
  SqliteTransactionRunner,
  SqliteTransactionRunOptions,
} from "./sqlite-transaction-runner.js";
import type {
  WriteCommitInsertArgs,
  WriteEdgeUpsertArgs,
  WriteNodeInsertArgs,
  WriteOutboxInsertArgs,
  WriteOutboxEventType,
  WriteRuleDefInsertArgs,
  WriteStoreAccess,
  WriteExistingEdgeState,
  WriteExistingNodeFingerprint,
  WriteExistingNodeState,
  WriteExistingRuleDefState,
  WriteLifecycleCandidateNodeRow,
} from "./write-access.js";
import {
  WRITE_STORE_ACCESS_CAPABILITY_VERSION,
  writeEdgeIdentityKey,
  writeNodeFingerprint,
} from "./write-access.js";
import {
  assertLiteMemoryPendingCommitClaimsAuthorityRow,
  assertLiteMemoryCommitV2SelfIntegrity,
} from
  "./lite-memory-commit-integrity.js";
import { memoryNodeVisible } from "./memory-visibility.js";
import { ignoreSqliteDuplicateColumnError, type SqliteDatabase } from "./sqlite.js";

const LITE_WRITE_BASE_V2_SCHEMA_SQL = readFileSync(
  new URL("./sql/lite-write-base-v2.sql", import.meta.url),
  "utf8",
);

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
  rule_memory_lane: "private" | "shared";
  rule_owner_agent_id: string | null;
  rule_owner_team_id: string | null;
  if_json: Record<string, unknown>;
  then_json: Record<string, unknown>;
  exceptions_json: unknown[];
  rule_slots: Record<string, unknown>;
  positive_count: number;
  negative_count: number;
  commit_id: string | null;
  created_at: string;
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

export type LiteOutboxEventRow = {
  row_id: number;
  scope: string;
  commit_id: string;
  event_type: WriteOutboxEventType;
  job_key: string;
  payload_sha256: string;
  payload_json: string;
  created_at: string;
};

export type LiteWriteOperationRow = {
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string | null;
  created_at: string;
};

const LITE_WRITE_OPERATION_RESERVED_SCOPE = "learning_external_authority_v1";
const LITE_WRITE_OPERATION_RESERVED_SCOPE_ERROR =
  "lite_write_operation_reserved_scope:learning_external_authority_v1";

export type LiteProductGuideReceiptRow = {
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  run_id: string | null;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  query_sha256: string;
  context_sha256: string;
  ledger_sha256: string;
  ledger_json: string;
  commit_id: string;
  created_at: string;
};

/**
 * Historical v1 rows are accepted only through this explicitly named seam.
 * It exists for schema-migration fixtures and test/evaluation data setup; it
 * is deliberately absent from the production WriteStoreAccess capability.
 */
export type LegacyV1CommitMigrationOrTestFixtureArgs = {
  scope: string;
  parentCommitId: string | null;
  inputSha256: string;
  diffJson: string;
  actor: string;
  modelVersion: string | null;
  promptVersion: string | null;
  commitHash: string;
  createdAt?: string;
};

export type LiteWriteStore = WriteStoreAccess & LiteProjectionOutboxAccess & {
  insertLegacyV1CommitForMigrationOrTestFixture(
    args: LegacyV1CommitMigrationOrTestFixtureArgs,
  ): Promise<string>;
  withTx<T>(fn: () => Promise<T>, options?: SqliteTransactionRunOptions): Promise<T>;
  afterCommit(fn: () => Promise<void>): Promise<void>;
  transactionRunner(): SqliteTransactionRunner;
  authorityTransactionChangeCount(): number;
  annSyncEnabled(): boolean;
  getWriteOperation(args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
  }): Promise<LiteWriteOperationRow | null>;
  listWriteOperations(args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    createdAtLte?: string | null;
    limit: number;
    offset?: number;
  }): Promise<LiteWriteOperationRow[]>;
  insertWriteOperation(args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
    requestSha256: string;
    receiptJson: string;
    commitId?: string | null;
    createdAt?: string;
    authorityActor?: string;
  }): Promise<LiteWriteOperationRow>;
  insertWriteOperationEnclosedByPendingCommit(args: {
    tenantId: string;
    scope: string;
    operationKind: string;
    operationId: string;
    requestSha256: string;
    receiptJson: string;
    commitId: string | null;
    createdAt: string;
    authorityCommitId: string;
  }): Promise<LiteWriteOperationRow>;
  insertProductGuideReceipt(args: {
    tenantId: string;
    scope: string;
    guideTraceId: string;
    runId?: string | null;
    consumerAgentId?: string | null;
    consumerTeamId?: string | null;
    querySha256: string;
    contextSha256: string;
    ledgerSha256: string;
    ledgerJson: string;
    commitId: string;
  }): Promise<LiteProductGuideReceiptRow>;
  getProductGuideReceipt(args: {
    tenantId: string;
    scope: string;
    guideTraceId: string;
  }): Promise<LiteProductGuideReceiptRow | null>;
  listProductGuideReceipts(args: {
    tenantId: string;
    scope: string;
    runId?: string | null;
    limit: number;
  }): Promise<LiteProductGuideReceiptRow[]>;
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
    operatorView?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ rows: LiteFindNodeRow[]; has_more: boolean }>;
  findExecutionNativeNodes(args: {
    scope: string;
    executionKind?: "distilled_evidence" | "distilled_fact" | "workflow_candidate" | "workflow_anchor" | "pattern_anchor" | "execution_native" | null;
    anchorKind?: "execution" | "workflow" | "pattern" | "decision" | null;
    patternState?: "provisional" | "stable" | null;
    taskSignature?: string | null;
    taskFamily?: string | null;
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
    createdAt?: string;
    updatedAt?: string;
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
    createdAt?: string;
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
  latestCommit(scope: string): Promise<{
    id: string;
    commit_hash: string;
    revision: number;
    digest_version: 1 | 2;
    persisted_head: boolean;
  } | null>;
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
  getRuleFeedback(scope: string, id: string): Promise<LiteRuleFeedbackRow | null>;
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
  toolRunLifecycleRowidCutoffs(args: {
    scope: string;
    runId: string;
  }): Promise<{
    decision_rowid_cutoff: number;
    feedback_rowid_cutoff: number;
  }>;
  updateRuleFeedbackAggregates(args: {
    scope: string;
    outcome: "positive" | "negative" | "neutral";
    ruleNodeIds: string[];
    commitId?: string | null;
    updatedAt?: string;
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
  listOutboxEvents(args: {
    eventType: WriteOutboxEventType;
    limit: number;
  }): Promise<LiteOutboxEventRow[]>;
  deleteOutboxEvent(rowId: number): Promise<void>;
  close(): Promise<void>;
  healthSnapshot(): {
    path: string;
    mode: "sqlite_write_v1";
    projections: LiteProjectionBacklogSnapshot;
  };
};

export type LiteWriteAnnSync = {
  syncNode(scope: string, nodeId: string): Promise<unknown>;
  deleteNode(nodeId: string): Promise<unknown>;
};

export type LiteWriteStoreOptions = {
  annSync?: LiteWriteAnnSync | null;
  annProjectionEnabled?: boolean;
  schemaMigrationFaultInjector?: (phase: LiteWriteSchemaMigrationPhase) => void;
  authorityReceiptKeyring?: AuthorityReceiptResolvedKeyring;
  /** @internal CI/evaluation fixture escape hatch; never enable in Runtime. */
  allowLegacyV1Fixtures?: boolean;
};

export type LiteWriteSchemaMigrationPhase =
  | "after_v2_structures"
  | "after_shared_measurement_structures"
  | "after_authority_identity"
  | "after_learning_ledger_structures"
  | "after_commit_authority_structures"
  | "after_authority_adoption_structures"
  | "after_execution_episode_structures"
  | "after_execution_verifier_launch_structures"
  | "after_execution_semantic_event_structures"
  | "after_execution_session_structures"
  | "after_v3_shape_verification"
  | "before_metadata_update"
  | "after_metadata_update_before_commit";

export type LiteWriteStoreFromDatabaseOptions = LiteWriteStoreOptions & {
  closeDatabaseOnClose?: boolean;
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

function parseJsonAuthorityValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Keep corrupt legacy bytes observable so exact authority verification
    // fails closed instead of silently projecting a default value.
    return raw;
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
  "ordinary_memory_v1",
  "execution_result_summary",
  "recovery_contract_v1",
  "runtime_signal_ledger_v1",
] as const;

function skipSearchableNestedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes("secret")
    || lower.includes("token")
    || lower === "key"
    || lower.endsWith("_key")
    || lower.includes("api_key")
    || lower.includes("apikey")
    || lower.includes("access_key")
    || lower.includes("private_key");
}

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
      if (skipSearchableNestedKey(key)) {
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

const SCHEMA_MIGRATION_PRESERVATION_TABLES = [
  "lite_memory_commits",
  "lite_memory_nodes",
  "lite_memory_edges",
  "lite_product_guide_receipts",
  "lite_runtime_write_operations",
  "lite_memory_rule_feedback",
] as const;

function sqlitePragmaValue(db: SqliteDatabase, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

function prepareLiteRuntimeWriteConnection(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  const journalMode = String(sqlitePragmaValue(db, "journal_mode") ?? "").toLowerCase();
  const synchronous = Number(sqlitePragmaValue(db, "synchronous"));
  const foreignKeys = Number(sqlitePragmaValue(db, "foreign_keys"));
  if (journalMode !== "wal" || synchronous !== 2 || foreignKeys !== 1) {
    throw new Error(
      `lite_runtime_sqlite_pragma_verification_failed:${JSON.stringify({ journalMode, synchronous, foreignKeys })}`,
    );
  }
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table);
}

function removeObsoleteProductSchemaV11(db: SqliteDatabase): void {
  db.exec("DROP TABLE IF EXISTS lite_execution_learning_links");
}

function migrationPreservationCounts(db: SqliteDatabase): Record<string, number> {
  return Object.fromEntries(SCHEMA_MIGRATION_PRESERVATION_TABLES.map((table) => [
    table,
    tableExists(db, table)
      ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
      : 0,
  ]));
}

function assertMigrationPreservedRows(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
  expectedCommitIncrease = 0,
): void {
  for (const table of SCHEMA_MIGRATION_PRESERVATION_TABLES) {
    const expected = (before[table] ?? 0)
      + (table === "lite_memory_commits" ? expectedCommitIncrease : 0);
    if (expected !== (after[table] ?? 0)) {
      throw new Error(
        `lite_runtime_schema_migration_row_count_changed:${table}:${expected}:${after[table] ?? 0}`,
      );
    }
  }
}

export function createLiteWriteStore(path: string, opts: LiteWriteStoreOptions = {}): LiteWriteStore {
  const database = createLiteRuntimeDatabase(path);
  try {
    return createLiteWriteStoreFromDatabase(database, { ...opts, closeDatabaseOnClose: true });
  } catch (error) {
    void database.close();
    throw error;
  }
}

export function createLiteWriteStoreFromDatabase(
  database: LiteRuntimeDatabase,
  opts: LiteWriteStoreFromDatabaseOptions = {},
): LiteWriteStore {
  const { path, db, transaction } = database;
  const annSync = opts.annSync ?? null;
  const annProjectionEnabled = opts.annProjectionEnabled ?? annSync !== null;
  const closeDatabaseOnClose = opts.closeDatabaseOnClose ?? false;
  const allowLegacyV1Fixtures = opts.allowLegacyV1Fixtures === true;

  const initialSchema = assertLiteRuntimeSchemaPreflight(db);
  prepareLiteRuntimeWriteConnection(db);
  let schemaMigrationOpen = false;
  let schemaMigration: LiteRuntimeOwnedSchemaMigration | null = null;
  let migrationSourceVersion: number | null = null;
  let migrationBeforeCounts: Record<string, number> | null = null;
  if (initialSchema.classification !== "current") {
    schemaMigration = beginLiteRuntimeOwnedSchemaMigration(db);
    schemaMigrationOpen = true;
    try {
      const lockedSchema = assertLiteRuntimeSchemaPreflight(db);
      if (lockedSchema.classification === "current") {
        schemaMigration.commit();
        schemaMigration = null;
        schemaMigrationOpen = false;
      } else {
        migrationSourceVersion = lockedSchema.detected_version;
        migrationBeforeCounts = migrationPreservationCounts(db);
      }
    } catch (error) {
      if (schemaMigrationOpen) {
        try {
          schemaMigration?.rollback();
        } finally {
          schemaMigration = null;
          schemaMigrationOpen = false;
        }
      }
      throw error;
    }
  }

  const rollbackSchemaMigration = (error: unknown): never => {
    if (schemaMigrationOpen) {
      try {
        schemaMigration?.rollback();
      } finally {
        schemaMigration = null;
        schemaMigrationOpen = false;
      }
    }
    throw error;
  };

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
    await transaction.afterCommit(() => runAnnSideEffect(callback));
  };

  const scheduleAnnNodeSync = async (scope: string, nodeId: string): Promise<void> => {
    await scheduleAnnSideEffect(() => annSync!.syncNode(scope, nodeId).then(() => undefined));
  };

  const scheduleAnnNodeDelete = async (nodeId: string): Promise<void> => {
    await scheduleAnnSideEffect(() => annSync!.deleteNode(nodeId).then(() => undefined));
  };

  if (schemaMigrationOpen && (migrationSourceVersion === null || migrationSourceVersion === 2)) {
    try {
      db.exec(LITE_WRITE_BASE_V2_SCHEMA_SQL);
  try {
    db.exec("ALTER TABLE lite_memory_rule_defs ADD COLUMN positive_count INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    ignoreSqliteDuplicateColumnError(err);
  }
  try {
    db.exec("ALTER TABLE lite_memory_rule_defs ADD COLUMN negative_count INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    ignoreSqliteDuplicateColumnError(err);
  }
  try {
    db.exec(`ALTER TABLE lite_memory_rule_defs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '${nowIso()}'`);
  } catch (err) {
    ignoreSqliteDuplicateColumnError(err);
  }
  try {
    db.exec("ALTER TABLE lite_memory_edges ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  } catch (err) {
    ignoreSqliteDuplicateColumnError(err);
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
    } catch (err) {
      ignoreSqliteDuplicateColumnError(err);
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
    } catch (error) {
      rollbackSchemaMigration(error);
    }
  }

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

  let projectionOutbox!: ReturnType<typeof createLiteProjectionOutboxAccess>;
  try {
    rebuildExecutionNativeIndex();
    rebuildKeywordIndex();

    projectionOutbox = createLiteProjectionOutboxAccess(database);
    if (schemaMigrationOpen) {
      if (migrationSourceVersion === null || migrationSourceVersion === 2) {
        opts.schemaMigrationFaultInjector?.("after_v2_structures");
      }

      if (
        migrationSourceVersion === null
        || migrationSourceVersion < 5
      ) {
        migrateLiteMemoryCommitAuthorityV5(db);
      }
      opts.schemaMigrationFaultInjector?.("after_commit_authority_structures");

      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V5);
      assertMigrationPreservedRows(
        migrationBeforeCounts ?? {},
        migrationPreservationCounts(db),
      );

      if (!schemaMigration) {
        throw new Error("lite_runtime_schema_migration_authority_session_missing");
      }
      let adoptionAppendedCommitCount = 0;
      if (
        migrationSourceVersion === null
        || migrationSourceVersion < 6
      ) {
        const adoptionMigration = migrateLiteRuntimeAuthorityAdoptionV6({
          db,
          authorityFence: schemaMigration.authorityFence,
        });
        adoptionAppendedCommitCount = adoptionMigration.appendedCommitCount;
      }
      opts.schemaMigrationFaultInjector?.("after_authority_adoption_structures");
      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V6);
      assertMigrationPreservedRows(
        migrationBeforeCounts ?? {},
        migrationPreservationCounts(db),
        adoptionAppendedCommitCount,
      );

      migrateLiteExecutionEpisodeV7(db);
      opts.schemaMigrationFaultInjector?.("after_execution_episode_structures");
      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V7);
      assertMigrationPreservedRows(
        migrationBeforeCounts ?? {},
        migrationPreservationCounts(db),
        adoptionAppendedCommitCount,
      );

      migrateLiteExecutionVerifierLaunchV8(db);
      opts.schemaMigrationFaultInjector?.(
        "after_execution_verifier_launch_structures",
      );
      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V8);
      assertMigrationPreservedRows(
        migrationBeforeCounts ?? {},
        migrationPreservationCounts(db),
        adoptionAppendedCommitCount,
      );

      migrateLiteExecutionSemanticEventsV9(db);
      opts.schemaMigrationFaultInjector?.(
        "after_execution_semantic_event_structures",
      );
      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V9);
      assertMigrationPreservedRows(
        migrationBeforeCounts ?? {},
        migrationPreservationCounts(db),
        adoptionAppendedCommitCount,
      );

      migrateLiteExecutionSessionV10(db);
      opts.schemaMigrationFaultInjector?.(
        "after_execution_session_structures",
      );
      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V10);
      assertMigrationPreservedRows(
        migrationBeforeCounts ?? {},
        migrationPreservationCounts(db),
        adoptionAppendedCommitCount,
      );
      removeObsoleteProductSchemaV11(db);
      migrateLiteRuntimeIdentitySchema(db);
      opts.schemaMigrationFaultInjector?.("after_authority_identity");
      assertLiteRuntimeSchemaContractShape(db, WRITE_SCHEMA_V11);
      opts.schemaMigrationFaultInjector?.("after_v3_shape_verification");
      opts.schemaMigrationFaultInjector?.("before_metadata_update");

      recordCurrentLiteRuntimeWriteSchema(db);
      opts.schemaMigrationFaultInjector?.("after_metadata_update_before_commit");

      const migratedSchema = inspectLiteRuntimeSchema(db);
      if (migratedSchema.classification !== "current"
        || migratedSchema.detected_version !== LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
        throw new Error(`lite_runtime_schema_migration_verification_failed:${JSON.stringify(migratedSchema)}`);
      }
      schemaMigration.commit();
      schemaMigration = null;
      schemaMigrationOpen = false;
    }

  } catch (error) {
    rollbackSchemaMigration(error);
  }

  let writeStoreClosed = false;
  let writeStoreClosing: Promise<void> | null = null;
  const pendingV2CommitsByTransaction = new Map<symbol, Set<string>>();
  const trackPendingV2Commit = (commitId: string): void => {
    const identity = transaction.currentTransactionIdentity();
    if (identity === null) {
      throw new Error("lite_memory_pending_v2_commit_requires_transaction_identity");
    }
    let pending = pendingV2CommitsByTransaction.get(identity);
    if (!pending) {
      pending = new Set<string>();
      pendingV2CommitsByTransaction.set(identity, pending);
      transaction.beforeCommit(() => {
        const unresolved = [...pending!];
        pendingV2CommitsByTransaction.delete(identity);
        if (unresolved.length > 0) {
          throw new Error(
            `lite_memory_pending_v2_commit_not_published:${unresolved.join(",")}`,
          );
        }
      });
      transaction.afterRollback(() => {
        pendingV2CommitsByTransaction.delete(identity);
      });
    }
    pending.add(commitId);
  };
  const runWriteTransaction = async <T>(
    fn: () => Promise<T>,
    options?: SqliteTransactionRunOptions,
  ): Promise<T> => {
    if (writeStoreClosed || writeStoreClosing !== null) {
      throw new Error("lite_write_store_closing");
    }
    return await transaction.run(fn, options);
  };
  const runStoreRead = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    if (writeStoreClosed || writeStoreClosing !== null) {
      throw new Error("lite_write_store_closing");
    }
    return await transaction.read(fn);
  };
  return {
    capability_version: WRITE_STORE_ACCESS_CAPABILITY_VERSION,
    ...projectionOutbox,

    async withTx<T>(fn: () => Promise<T>, options?: SqliteTransactionRunOptions): Promise<T> {
      return await runWriteTransaction(fn, options);
    },

    async afterCommit(fn): Promise<void> {
      await transaction.afterCommit(fn);
    },

    transactionRunner(): SqliteTransactionRunner {
      return transaction;
    },

    authorityTransactionChangeCount(): number {
      if (!transaction.inTransaction()) {
        throw new Error("authority_transaction_change_count_requires_shared_transaction");
      }
      const row = db.prepare("SELECT total_changes() AS count").get() as { count: number };
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("authority_transaction_change_count_invalid");
      }
      return count;
    },

    annSyncEnabled(): boolean {
      return annProjectionEnabled;
    },

    async getWriteOperation(args): Promise<LiteWriteOperationRow | null> {
      return await runStoreRead(() => (
        db.prepare(
          `SELECT tenant_id, scope, operation_kind, operation_id,
                  request_sha256, receipt_json, commit_id, created_at
           FROM lite_runtime_write_operations
           WHERE tenant_id = ?
             AND scope = ?
             AND operation_kind = ?
             AND operation_id = ?`,
        ).get(
          args.tenantId,
          args.scope,
          args.operationKind,
          args.operationId,
        ) as LiteWriteOperationRow | undefined
      ) ?? null);
    },

    async listWriteOperations(args): Promise<LiteWriteOperationRow[]> {
      return await runStoreRead(() => {
        const where = [
          "tenant_id = ?",
          "scope = ?",
          "operation_kind = ?",
        ];
        const params: unknown[] = [
          args.tenantId,
          args.scope,
          args.operationKind,
        ];
        if (args.createdAtLte) {
          where.push("created_at <= ?");
          params.push(args.createdAtLte);
        }
        return db.prepare(
          `SELECT tenant_id, scope, operation_kind, operation_id,
                  request_sha256, receipt_json, commit_id, created_at
           FROM lite_runtime_write_operations
           WHERE ${where.join(" AND ")}
           ORDER BY created_at ASC, operation_id ASC
           LIMIT ? OFFSET ?`,
        ).all(
          ...params,
          Math.max(1, Math.min(10_000, Math.trunc(args.limit))),
          Math.max(0, Math.trunc(args.offset ?? 0)),
        ) as LiteWriteOperationRow[];
      });
    },

    async insertWriteOperation(args): Promise<LiteWriteOperationRow> {
      if (args.scope === LITE_WRITE_OPERATION_RESERVED_SCOPE) {
        throw new Error(LITE_WRITE_OPERATION_RESERVED_SCOPE_ERROR);
      }
      if (!transaction.inTransaction()) {
        throw new Error("Runtime write operation receipt must be inserted inside the shared Runtime transaction");
      }
      const createdAt = args.createdAt ?? nowIso();
      return appendLiteRuntimeWriteOperationAuthorityInCurrentTransaction({
        db,
        transaction,
        tenantId: args.tenantId,
        scope: args.scope,
        operationKind: args.operationKind,
        operationId: args.operationId,
        requestSha256: args.requestSha256,
        receiptJson: args.receiptJson,
        commitId: args.commitId ?? null,
        createdAt,
        actor: args.authorityActor,
      }).row;
    },

    async insertWriteOperationEnclosedByPendingCommit(args): Promise<LiteWriteOperationRow> {
      if (args.scope === LITE_WRITE_OPERATION_RESERVED_SCOPE) {
        throw new Error(LITE_WRITE_OPERATION_RESERVED_SCOPE_ERROR);
      }
      if (!transaction.inTransaction()) {
        throw new Error("Runtime enclosed operation receipt must be inserted inside the shared Runtime transaction");
      }
      const row: LiteWriteOperationRow = {
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_kind: args.operationKind,
        operation_id: args.operationId,
        request_sha256: args.requestSha256,
        receipt_json: args.receiptJson,
        commit_id: args.commitId,
        created_at: args.createdAt,
      };
      const identity = {
        tenant_id: args.tenantId,
        scope: args.scope,
        operation_kind: args.operationKind,
        operation_id: args.operationId,
      };
      assertLiteMemoryPendingCommitClaimsAuthorityRow({
        db,
        scope: args.scope,
        commitId: args.authorityCommitId,
        table: "lite_runtime_write_operations",
        identity,
        persistedRow: row,
      });
      db.prepare(
        `INSERT INTO lite_runtime_write_operations
           (tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.tenant_id,
        row.scope,
        row.operation_kind,
        row.operation_id,
        row.request_sha256,
        row.receipt_json,
        row.commit_id,
        row.created_at,
      );
      return row;
    },

    async insertProductGuideReceipt(args): Promise<LiteProductGuideReceiptRow> {
      if (!transaction.inTransaction()) {
        throw new Error("product guide receipt must be inserted inside the shared Runtime transaction");
      }
      const latest = db.prepare(
        `SELECT created_at
         FROM lite_product_guide_receipts
         WHERE tenant_id = ? AND scope = ?
         ORDER BY created_at DESC, guide_trace_id DESC
         LIMIT 1`,
      ).get(args.tenantId, args.scope) as { created_at: string } | undefined;
      const latestMs = latest ? Date.parse(latest.created_at) : Number.NaN;
      const createdAt = new Date(Math.max(
        Date.now(),
        Number.isFinite(latestMs) ? latestMs + 1 : 0,
      )).toISOString();
      db.prepare(
        `INSERT INTO lite_product_guide_receipts
           (tenant_id, scope, guide_trace_id, run_id, consumer_agent_id, consumer_team_id,
            query_sha256, context_sha256, ledger_sha256, ledger_json, commit_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.tenantId,
        args.scope,
        args.guideTraceId,
        args.runId ?? null,
        args.consumerAgentId ?? null,
        args.consumerTeamId ?? null,
        args.querySha256,
        args.contextSha256,
        args.ledgerSha256,
        args.ledgerJson,
        args.commitId,
        createdAt,
      );
      return {
        tenant_id: args.tenantId,
        scope: args.scope,
        guide_trace_id: args.guideTraceId,
        run_id: args.runId ?? null,
        consumer_agent_id: args.consumerAgentId ?? null,
        consumer_team_id: args.consumerTeamId ?? null,
        query_sha256: args.querySha256,
        context_sha256: args.contextSha256,
        ledger_sha256: args.ledgerSha256,
        ledger_json: args.ledgerJson,
        commit_id: args.commitId,
        created_at: createdAt,
      };
    },

    async getProductGuideReceipt(args): Promise<LiteProductGuideReceiptRow | null> {
      return await runStoreRead(() => (
        db.prepare(
          `SELECT tenant_id, scope, guide_trace_id, run_id, consumer_agent_id, consumer_team_id,
                  query_sha256, context_sha256, ledger_sha256, ledger_json, commit_id, created_at
           FROM lite_product_guide_receipts
           WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
        ).get(args.tenantId, args.scope, args.guideTraceId) as LiteProductGuideReceiptRow | undefined
      ) ?? null);
    },

    async listProductGuideReceipts(args): Promise<LiteProductGuideReceiptRow[]> {
      return await runStoreRead(() => {
        const where = ["tenant_id = ?", "scope = ?"];
        const params: unknown[] = [args.tenantId, args.scope];
        if (args.runId) {
          where.push("run_id = ?");
          params.push(args.runId);
        }
        return db.prepare(
          `SELECT tenant_id, scope, guide_trace_id, run_id, consumer_agent_id, consumer_team_id,
                  query_sha256, context_sha256, ledger_sha256, ledger_json, commit_id, created_at
           FROM lite_product_guide_receipts
           WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, guide_trace_id DESC
           LIMIT ?`,
        ).all(...params, Math.max(1, Math.min(1000, args.limit))) as LiteProductGuideReceiptRow[];
      });
    },

    async findNodes(args): Promise<{ rows: LiteFindNodeRow[]; has_more: boolean }> {
      return await runStoreRead(() => {
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
      if (!args.operatorView) {
        const consumerAgentId = args.consumerAgentId ?? null;
        const consumerTeamId = args.consumerTeamId ?? null;
        appendVisibilityWhere({ where, params, consumerAgentId, consumerTeamId });
      }
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
      });
    },

    async findExecutionNativeNodes(args): Promise<{ rows: LiteExecutionNativeNodeRow[]; has_more: boolean }> {
      return await runStoreRead(() => {
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
      if (args.taskFamily) {
        where.push("i.task_family = ?");
        params.push(args.taskFamily);
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
      });
    },

    async findLatestNodeByClientId(scope: string, type: string, clientId: string): Promise<LiteLatestNodeView | null> {
      return await runStoreRead(() => {
      const row = db.prepare(
        `SELECT id
         FROM lite_memory_nodes
         WHERE scope = ? AND type = ? AND client_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(scope, type, clientId) as LiteLatestNodeView | undefined;
      return row ?? null;
      });
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
      return await runStoreRead(() => {
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
      });
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
           d.scope,
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
           d.created_at,
           d.updated_at,
           n.memory_lane,
           n.owner_agent_id,
           n.owner_team_id,
           n.slots_json
         FROM lite_memory_rule_defs d
         JOIN lite_memory_nodes n ON n.id = d.rule_node_id AND n.scope = d.scope
         WHERE d.scope = ?
           AND d.rule_node_id = ?
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
        created_at: string;
        updated_at: string;
        memory_lane: "private" | "shared";
        owner_agent_id: string | null;
        owner_team_id: string | null;
        slots_json: string;
      } | undefined;
      if (!row) return null;
      return {
        scope: row.scope,
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
        rule_slots: parseJsonObject(row.slots_json),
        positive_count: Number(row.positive_count ?? 0),
        negative_count: Number(row.negative_count ?? 0),
        commit_id: row.commit_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    },

    async upsertRuleState(args): Promise<LiteRuleDefSyncRow> {
      const createdAt = args.createdAt ?? nowIso();
      const updatedAt = args.updatedAt ?? createdAt;
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
      const createdAt = args.createdAt ?? nowIso();
      db.prepare(
        `INSERT INTO lite_memory_execution_decisions
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

    async latestCommit(scope: string) {
      return await runStoreRead(() => {
        const head = readLiteMemoryScopeHead(db, scope);
        return head
          ? {
              id: head.commitId,
              commit_hash: head.commitHash,
              revision: head.revision,
              digest_version: head.digestVersion,
              persisted_head: head.persisted,
            }
          : null;
      });
    },

    async insertRuleFeedback(args): Promise<void> {
      db.prepare(
        `INSERT INTO lite_memory_rule_feedback
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

    async getRuleFeedback(scope, id): Promise<LiteRuleFeedbackRow | null> {
      return await runStoreRead(() => {
        const row = db.prepare(
          `SELECT id, scope, rule_node_id, run_id, outcome, note, source,
                  decision_id, commit_id, created_at
           FROM lite_memory_rule_feedback
           WHERE scope = ? AND id = ?
           LIMIT 1`,
        ).get(scope, id) as LiteRuleFeedbackRow | undefined;
        return row ?? null;
      });
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
      return await runStoreRead(() => {
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
      });
    },

    async toolRunLifecycleRowidCutoffs(args) {
      return await runStoreRead(() => {
        const decision = db.prepare(
          `SELECT COALESCE(MAX(rowid), 0) AS rowid_cutoff
           FROM lite_memory_execution_decisions
           WHERE scope = ? AND run_id = ?`,
        ).get(args.scope, args.runId) as { rowid_cutoff: number };
        const feedback = db.prepare(
          `SELECT COALESCE(MAX(rowid), 0) AS rowid_cutoff
           FROM lite_memory_rule_feedback
           WHERE scope = ? AND run_id = ?`,
        ).get(args.scope, args.runId) as { rowid_cutoff: number };
        const decisionRowidCutoff = Number(decision.rowid_cutoff);
        const feedbackRowidCutoff = Number(feedback.rowid_cutoff);
        if (!Number.isSafeInteger(decisionRowidCutoff) || decisionRowidCutoff < 1
          || !Number.isSafeInteger(feedbackRowidCutoff) || feedbackRowidCutoff < 0) {
          throw new Error("tool run lifecycle rowid cutoffs are invalid");
        }
        return {
          decision_rowid_cutoff: decisionRowidCutoff,
          feedback_rowid_cutoff: feedbackRowidCutoff,
        };
      });
    },

    async updateRuleFeedbackAggregates(args): Promise<LiteRuleCandidateRow[]> {
      const nextUpdatedAt = args.updatedAt ?? nowIso();
      for (const ruleNodeId of args.ruleNodeIds) {
        db.prepare(
          `UPDATE lite_memory_rule_defs
           SET
             positive_count = positive_count + ?,
             negative_count = negative_count + ?,
             commit_id = COALESCE(?, commit_id),
             updated_at = ?
           WHERE scope = ?
             AND rule_node_id = ?`,
        ).run(
          args.outcome === "positive" ? 1 : 0,
          args.outcome === "negative" ? 1 : 0,
          args.commitId ?? null,
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

    async nodeStatesByIds(
      scope: string,
      ids: string[],
    ): Promise<Map<string, WriteExistingNodeState>> {
      if (ids.length === 0) return new Map();
      return await runStoreRead(() => {
        const out = new Map<string, WriteExistingNodeState>();
        const uniqueIds = Array.from(new Set(ids));
        for (let offset = 0; offset < uniqueIds.length; offset += 400) {
          const chunk = uniqueIds.slice(offset, offset + 400);
          const rows = db.prepare(
            `SELECT id, scope, client_id, type, tier, title, text_summary, slots_json,
                    raw_ref, evidence_ref, embedding_vector_json, embedding_model,
                    memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
                    embedding_status, embedding_last_error, salience, importance,
                    confidence, redaction_version, commit_id, created_at
             FROM lite_memory_nodes
             WHERE scope = ?
               AND id IN (${chunk.map(() => "?").join(",")})`,
          ).all(scope, ...chunk) as Array<{
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
            embedding_vector_json: string | null;
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
            commit_id: string;
            created_at: string;
          }>;
          for (const row of rows) {
            out.set(row.id, {
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
              embeddingVector: row.embedding_vector_json,
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
              commitId: row.commit_id,
              createdAt: row.created_at,
            });
          }
        }
        return out;
      });
    },

    async ruleDefStatesByIds(
      scope: string,
      ruleNodeIds: string[],
    ): Promise<Map<string, WriteExistingRuleDefState>> {
      if (ruleNodeIds.length === 0) return new Map();
      return await runStoreRead(() => {
        const out = new Map<string, WriteExistingRuleDefState>();
        const uniqueIds = Array.from(new Set(ruleNodeIds));
        for (let offset = 0; offset < uniqueIds.length; offset += 400) {
          const chunk = uniqueIds.slice(offset, offset + 400);
          const rows = db.prepare(
            `SELECT rule_node_id, scope, state, if_json, then_json,
                    exceptions_json, rule_scope, target_agent_id,
                    target_team_id, positive_count, negative_count,
                    commit_id, created_at, updated_at
             FROM lite_memory_rule_defs
             WHERE scope = ?
               AND rule_node_id IN (${chunk.map(() => "?").join(",")})`,
          ).all(scope, ...chunk) as Array<{
            rule_node_id: string;
            scope: string;
            state: "draft" | "shadow" | "active" | "disabled";
            if_json: string;
            then_json: string;
            exceptions_json: string;
            rule_scope: "global" | "agent" | "team";
            target_agent_id: string | null;
            target_team_id: string | null;
            positive_count: number;
            negative_count: number;
            commit_id: string;
            created_at: string;
            updated_at: string;
          }>;
          for (const row of rows) {
            out.set(row.rule_node_id, {
              ruleNodeId: row.rule_node_id,
              scope: row.scope,
              state: row.state,
              ifJson: parseJsonAuthorityValue(row.if_json),
              thenJson: parseJsonAuthorityValue(row.then_json),
              exceptionsJson: parseJsonAuthorityValue(row.exceptions_json),
              ruleScope: row.rule_scope,
              targetAgentId: row.target_agent_id,
              targetTeamId: row.target_team_id,
              positiveCount: Number(row.positive_count),
              negativeCount: Number(row.negative_count),
              commitId: row.commit_id,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            });
          }
        }
        return out;
      });
    },

    async resolveEdgeStatesByIdentity(args): Promise<Map<string, WriteExistingEdgeState>> {
      if (args.identities.length === 0) return new Map();
      return await runStoreRead(() => {
        const out = new Map<string, WriteExistingEdgeState>();
        const unique = new Map(args.identities.map((identity) => [writeEdgeIdentityKey(identity), identity]));
        const identities = Array.from(unique.values());
        for (let offset = 0; offset < identities.length; offset += 250) {
          const chunk = identities.slice(offset, offset + 250);
          const predicates = chunk.map(() => "(type = ? AND src_id = ? AND dst_id = ?)").join(" OR ");
          const params = chunk.flatMap((identity) => [identity.type, identity.srcId, identity.dstId]);
          const rows = db.prepare(
            `SELECT id, scope, type, src_id, dst_id, weight, confidence,
                    decay_rate, metadata_json, commit_id, created_at
             FROM lite_memory_edges
             WHERE scope = ?
               AND (${predicates})`,
          ).all(args.scope, ...params) as Array<{
            id: string;
            scope: string;
            type: string;
            src_id: string;
            dst_id: string;
            weight: number;
            confidence: number;
            decay_rate: number;
            metadata_json: string;
            commit_id: string;
            created_at: string;
          }>;
          for (const row of rows) {
            const decoded: WriteExistingEdgeState = {
              id: row.id,
              scope: row.scope,
              type: row.type,
              srcId: row.src_id,
              dstId: row.dst_id,
              weight: row.weight,
              confidence: row.confidence,
              decayRate: row.decay_rate,
              metadataJson: parseJsonObject(row.metadata_json),
              commitId: row.commit_id,
              createdAt: row.created_at,
            };
            out.set(writeEdgeIdentityKey(decoded), decoded);
          }
        }
        return out;
      });
    },

    async lifecycleCandidateNodes(scope: string, limit: number): Promise<WriteLifecycleCandidateNodeRow[]> {
      return await runStoreRead(() => {
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
      });
    },

    async readScopeHead(scope) {
      return await runStoreRead(() => readLiteMemoryScopeHead(db, scope));
    },

    async compareAndSwapScopeHead(args) {
      const result = compareAndSwapLiteMemoryScopeHead({
        db,
        authorityFence: authorityFenceForRuntimeTransaction(transaction),
        request: args,
      });
      if (result.status === "advanced") {
        const identity = transaction.currentTransactionIdentity();
        if (identity !== null) {
          pendingV2CommitsByTransaction.get(identity)?.delete(args.commitId);
        }
      }
      return result;
    },

    async parentCommitHash(scope: string, parentCommitId: string): Promise<string | null> {
      const row = db.prepare(
        `SELECT commit_hash FROM lite_memory_commits WHERE scope = ? AND id = ? LIMIT 1`,
      ).get(scope, parentCommitId) as { commit_hash: string } | undefined;
      return row?.commit_hash ?? null;
    },

    async insertCommit(args: WriteCommitInsertArgs): Promise<string> {
      const commitId = insertLiteMemoryCommitV2InCurrentTransaction({
        db,
        authorityFence: authorityFenceForRuntimeTransaction(transaction),
        commit: args,
      });
      const persistedHead = db.prepare(
        `SELECT revision FROM lite_memory_scope_heads WHERE scope = ?`,
      ).get(args.scope) as { revision: number } | undefined;
      if (!persistedHead || persistedHead.revision < args.revision) {
        trackPendingV2Commit(commitId);
      }
      return commitId;
    },

    async insertLegacyV1CommitForMigrationOrTestFixture(
      args: LegacyV1CommitMigrationOrTestFixtureArgs,
    ): Promise<string> {
      if (!allowLegacyV1Fixtures) {
        throw new Error("lite_memory_legacy_v1_fixture_writes_disabled");
      }
      if (readLiteMemoryScopeHead(db, args.scope)?.persisted === true) {
        throw new Error(`lite_memory_commit_v1_after_v2_head_forbidden:${args.scope}`);
      }
      const existing = db.prepare(
        `SELECT id
         FROM lite_memory_commits
         WHERE commit_hash = ?
         LIMIT 1`,
      ).get(args.commitHash) as { id: string } | undefined;
      if (existing?.id) return existing.id;

      const id = stableUuid(`lite:commit:${args.commitHash}`);
      db.prepare(
        `INSERT OR IGNORE INTO lite_memory_commits
          (id, scope, parent_commit_id, input_sha256, diff_json, actor,
           model_version, prompt_version, commit_hash, created_at,
           digest_version, revision, mutation_digest, legacy_anchor_commit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL)`,
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
        args.createdAt ?? nowIso(),
      );
      return id;
    },

    async insertNode(args: WriteNodeInsertArgs): Promise<void> {
      await runWriteTransaction(async () => {
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
          args.createdAt ?? nowIso(),
        );
        syncExecutionNativeIndexFromNode(args.scope, args.id);
        syncKeywordIndexFromNode(args.scope, args.id);
        if (annProjectionEnabled) {
          await projectionOutbox.enqueueAnnProjection({
            scope: args.scope,
            nodeId: args.id,
            sourceCommitId: args.commitId,
          });
        }
        await scheduleAnnNodeSync(args.scope, args.id);
      });
    },

    async insertRuleDef(args: WriteRuleDefInsertArgs): Promise<void> {
      db.prepare(
        `INSERT INTO lite_memory_rule_defs
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
        args.createdAt,
        args.updatedAt,
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
           decay_rate = excluded.decay_rate,
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
        args.createdAt ?? nowIso(),
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

    async listOutboxEvents(args): Promise<LiteOutboxEventRow[]> {
      const limit = Math.max(1, Math.min(200, Math.trunc(args.limit)));
      const rows = db.prepare(
        `SELECT row_id, scope, commit_id, event_type, job_key, payload_sha256, payload_json, created_at
         FROM lite_memory_outbox
         WHERE event_type = ?
         ORDER BY created_at ASC, row_id ASC
         LIMIT ?`,
      ).all(args.eventType, limit) as LiteOutboxEventRow[];
      return rows;
    },

    async deleteOutboxEvent(rowId: number): Promise<void> {
      db.prepare(
        `DELETE FROM lite_memory_outbox WHERE row_id = ?`,
      ).run(rowId);
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

    async setNodeEmbeddingReady(args): Promise<void> {
      assertDim(args.embedding, 1536);
      await runWriteTransaction(async () => {
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
        const node = db.prepare(
          `SELECT commit_id FROM lite_memory_nodes WHERE scope = ? AND id = ?`,
        ).get(args.scope, args.id) as { commit_id: string } | undefined;
        await projectionOutbox.markEmbeddingProjectionSatisfied({
          scope: args.scope,
          nodeId: args.id,
          sourceCommitId: node?.commit_id ?? null,
          enqueueAnn: annProjectionEnabled,
        });
        await scheduleAnnNodeSync(args.scope, args.id);
      });
    },

    async updateNodeAnchorState(args): Promise<LiteFindNodeRow | null> {
      return await runWriteTransaction(async () => {
      const { rows: existingRows } = await this.findNodes({
        scope: args.scope,
        id: args.id,
        operatorView: true,
        limit: 1,
        offset: 0,
      });
      const existing = existingRows[0];
      if (!existing) return null;
      const embeddingSourceTextChanged = existing.text_summary !== args.textSummary;
      assertAuthorityWriteReceipts([{
        id: existing.id,
        client_id: existing.client_id ?? undefined,
        scope: args.scope,
        type: existing.type,
        slots: args.slots,
      }]);

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
      if (embeddingSourceTextChanged) {
        updates.push(
          "embedding_vector_json = NULL",
          "embedding_model = NULL",
          "embedding_status = 'pending'",
          "embedding_last_error = ?",
        );
        params.push(EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON);
      }
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
      const updatedNode = db.prepare(
        `SELECT commit_id FROM lite_memory_nodes WHERE scope = ? AND id = ?`,
      ).get(args.scope, args.id) as { commit_id: string } | undefined;
      const refreshedEmbedText = authorityNodeEmbeddingText({
        textSummary: args.textSummary,
        title: existing.title,
      });
      const outstandingProjectionNeedsSourceRebind = !embeddingSourceTextChanged
        && existing.embedding_status === "pending";
      if ((embeddingSourceTextChanged || outstandingProjectionNeedsSourceRebind)
        && updatedNode
        && refreshedEmbedText) {
        await projectionOutbox.refreshEmbeddingProjection({
          scope: args.scope,
          nodeId: args.id,
          sourceCommitId: updatedNode.commit_id,
          embedText: embeddingSourceTextChanged ? refreshedEmbedText : null,
        });
      }
      if (annProjectionEnabled) {
        await projectionOutbox.enqueueAnnProjection({
          scope: args.scope,
          nodeId: args.id,
          sourceCommitId: updatedNode?.commit_id ?? null,
        });
      }
      await scheduleAnnNodeSync(args.scope, args.id);
      const { rows } = await this.findNodes({
        scope: args.scope,
        id: args.id,
        limit: 1,
        offset: 0,
      });
      return rows[0] ?? null;
      });
    },

    async setNodeEmbeddingFailed(args): Promise<void> {
      await runWriteTransaction(async () => {
        db.prepare(
          `UPDATE lite_memory_nodes
           SET embedding_vector_json = NULL,
               embedding_model = NULL,
               embedding_status = 'failed',
               embedding_last_error = ?
           WHERE scope = ?
             AND id = ?`,
        ).run(
          args.error,
          args.scope,
          args.id,
        );
        const node = db.prepare(
          `SELECT commit_id FROM lite_memory_nodes WHERE scope = ? AND id = ?`,
        ).get(args.scope, args.id) as { commit_id: string } | undefined;
        if (annProjectionEnabled) {
          await projectionOutbox.enqueueAnnProjection({
            scope: args.scope,
            nodeId: args.id,
            sourceCommitId: node?.commit_id ?? null,
          });
        }
        await scheduleAnnNodeDelete(args.id);
      });
    },

    async close(): Promise<void> {
      if (writeStoreClosed) return;
      if (writeStoreClosing !== null) return await writeStoreClosing;
      writeStoreClosing = (async () => {
        try {
          await transaction.sealAndRun(async () => undefined);
        } finally {
          if (closeDatabaseOnClose) await database.close();
          writeStoreClosed = true;
        }
      })();
      return await writeStoreClosing;
    },

    healthSnapshot() {
      return {
        path,
        mode: "sqlite_write_v1" as const,
        projections: projectionOutbox.projectionBacklogSnapshot(),
      };
    },
  };
}
