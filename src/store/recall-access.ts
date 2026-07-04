import {
  resolveNodeAnchorKind,
  resolveNodeExecutionContractTrust,
  resolveNodeExecutionOutcomeRole,
  resolveNodePatternExecutionSurface,
} from "../memory/node-execution-surface.js";

export const RECALL_STORE_ACCESS_CAPABILITY_VERSION = 4 as const;

export type RecallCandidateSourceKind =
  | "semantic"
  | "lexical"
  | "structured"
  | "execution_native"
  | "graph"
  | "recent"
  | "exact_recovery"
  | "ann"
  | "substrate";

export type RecallCandidateSource = {
  kind: RecallCandidateSourceKind;
  score: number;
  reason: string;
  matched_fields?: string[];
  index_name?: string;
};

export type RecallCandidate = {
  id: string;
  type: string;
  title: string | null;
  text_summary: string | null;
  tier: string;
  salience: number;
  confidence: number;
  similarity: number;
  sources?: RecallCandidateSource[];
};

export type RecallMemoryTier = "hot" | "warm" | "cold" | "archive";

export const RECALL_MEMORY_TIERS: readonly RecallMemoryTier[] = ["hot", "warm", "cold", "archive"];
export const DEFAULT_RECALL_STAGE1_ALLOWED_TIERS: readonly RecallMemoryTier[] = ["hot", "warm"];
export const EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS: readonly RecallMemoryTier[] = ["hot", "warm", "cold"];
export const RECALL_STAGE1_BOUNDED_SCAN_FLOOR = 2048;
export const RECALL_STAGE1_OVERSAMPLE_SCAN_MULTIPLIER = 32;
export const RECALL_STAGE1_LIMIT_SCAN_MULTIPLIER = 64;

export function recallStage1BoundedScanLimit(params: {
  oversample: number;
  limit: number;
  scanLimit?: number | null;
}): number {
  if (typeof params.scanLimit === "number" && Number.isFinite(params.scanLimit)) {
    return Math.max(1, Math.trunc(params.scanLimit));
  }
  return Math.max(
    RECALL_STAGE1_BOUNDED_SCAN_FLOOR,
    Math.max(0, params.oversample) * RECALL_STAGE1_OVERSAMPLE_SCAN_MULTIPLIER,
    Math.max(0, params.limit) * RECALL_STAGE1_LIMIT_SCAN_MULTIPLIER,
  );
}

export function normalizeRecallAllowedTiers(
  input: readonly RecallMemoryTier[] | undefined,
  fallback: readonly RecallMemoryTier[] = DEFAULT_RECALL_STAGE1_ALLOWED_TIERS,
): RecallMemoryTier[] {
  const seen = new Set<RecallMemoryTier>();
  for (const tier of input ?? fallback) {
    if (!RECALL_MEMORY_TIERS.includes(tier) || seen.has(tier)) continue;
    seen.add(tier);
  }
  return seen.size > 0 ? Array.from(seen) : [...fallback];
}

export type RecallStage1Params = {
  queryEmbedding: number[];
  scope: string;
  oversample: number;
  limit: number;
  allowedTiers?: RecallMemoryTier[];
  scanLimit?: number | null;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export type RecallLexicalParams = {
  queryText: string;
  scope: string;
  limit: number;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export type RecallStructuredParams = {
  scope: string;
  limit: number;
  taskSignature?: string | null;
  workflowSignature?: string | null;
  errorSignature?: string | null;
  patternSignature?: string | null;
  taskFamily?: string | null;
  repoSignature?: string | null;
  fileCluster?: string | null;
  toolChainSignature?: string | null;
  failureMode?: string | null;
  verificationSignature?: string | null;
  acceptanceCheckSignature?: string | null;
  targetFiles?: string[];
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export type RecallExecutionNativeParams = RecallStructuredParams;

export type RecallHybridParams = {
  scope: string;
  limit: number;
  queryEmbedding?: number[] | null;
  queryText?: string | null;
  structured?: Omit<RecallStructuredParams, "scope" | "limit" | "consumerAgentId" | "consumerTeamId"> | null;
  graphSeedIds?: string[] | null;
  oversample?: number;
  allowedTiers?: RecallMemoryTier[];
  scanLimit?: number | null;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export type RecallGraphParams = {
  scope: string;
  seedIds: string[];
  limit: number;
  allowedTiers?: RecallMemoryTier[];
  neighborhoodHops?: 1 | 2;
  minEdgeWeight?: number;
  minEdgeConfidence?: number;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export type RecallRecentParams = {
  scope: string;
  limit: number;
  allowedTiers?: RecallMemoryTier[];
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export type RecallEdgeRow = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight: number;
  confidence: number;
  decay_rate: number;
  metadata: Record<string, unknown>;
  last_activated: string | null;
  created_at: string;
  commit_id: string | null;
};

export type RecallNodeRow = {
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
  slots: any;
  embedding_status: string;
  embedding_model: string | null;
  topic_state: string | null;
  member_count: number | null;
  raw_ref: string | null;
  evidence_ref: string | null;
  salience: number;
  importance: number;
  confidence: number;
  last_activated: string | null;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
};

export type RecallStage2EdgesParams = {
  seedIds: string[];
  scope: string;
  neighborhoodHops: 1 | 2;
  minEdgeWeight: number;
  minEdgeConfidence: number;
  hop1Budget: number;
  hop2Budget: number;
  edgeFetchBudget: number;
};

export type RecallStage2NodesParams = {
  scope: string;
  nodeIds: string[];
  consumerAgentId: string | null;
  consumerTeamId: string | null;
  includeSlots: boolean;
};

export type RecallRuleDefRow = {
  rule_node_id: string;
  state: string;
  rule_scope: string;
  target_agent_id: string | null;
  target_team_id: string | null;
  if_json: any;
  then_json: any;
  exceptions_json: any;
  positive_count: number | null;
  negative_count: number | null;
};

export type RecallDebugEmbeddingRow = {
  id: string;
  embedding_text: string;
};

export type RecallAuditInsertParams = {
  scope: string;
  endpoint: "recall" | "recall_text" | "planning_context" | "context_assemble";
  consumerAgentId: string | null;
  consumerTeamId: string | null;
  querySha256: string;
  seedCount: number;
  nodeCount: number;
  edgeCount: number;
};

export type RecallAssociativeNodeRow = {
  id: string;
  scope: string;
  type: string;
  memory_lane: "private" | "shared";
  owner_agent_id: string | null;
  owner_team_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots: Record<string, unknown>;
  embedding_text: string | null;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
};

export type RecallStoreCapabilities = {
  debug_embeddings: boolean;
  audit_insert: boolean;
};

export interface RecallStoreAccess {
  readonly capability_version: typeof RECALL_STORE_ACCESS_CAPABILITY_VERSION;
  readonly capabilities: RecallStoreCapabilities;
  stage1CandidatesAnn(params: RecallStage1Params): Promise<RecallCandidate[]>;
  stage1CandidatesExactRecovery(params: RecallStage1Params): Promise<RecallCandidate[]>;
  stage1SemanticCandidates(params: RecallStage1Params): Promise<RecallCandidate[]>;
  stage1LexicalCandidates(params: RecallLexicalParams): Promise<RecallCandidate[]>;
  stage1StructuredCandidates(params: RecallStructuredParams): Promise<RecallCandidate[]>;
  stage1ExecutionNativeCandidates(params: RecallExecutionNativeParams): Promise<RecallCandidate[]>;
  stage1GraphCandidates(params: RecallGraphParams): Promise<RecallCandidate[]>;
  stage1RecentCandidates(params: RecallRecentParams): Promise<RecallCandidate[]>;
  stage1HybridCandidates(params: RecallHybridParams): Promise<RecallCandidate[]>;
  stage2Edges(params: RecallStage2EdgesParams): Promise<RecallEdgeRow[]>;
  stage2Nodes(params: RecallStage2NodesParams): Promise<RecallNodeRow[]>;
  listAssociativeNodesByIds(scope: string, nodeIds: string[]): Promise<RecallAssociativeNodeRow[]>;
  listAssociativeCandidatePool(scope: string, excludeNodeIds: string[], limit: number): Promise<RecallAssociativeNodeRow[]>;
  ruleDefs(scope: string, ruleIds: string[]): Promise<RecallRuleDefRow[]>;
  debugEmbeddings(scope: string, ids: string[]): Promise<RecallDebugEmbeddingRow[]>;
  insertRecallAudit(params: RecallAuditInsertParams): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function clampSimilarity(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function adjustRecallCandidateSimilarityForTrust(args: {
  type: string;
  slots: unknown;
  similarity: number;
}): number {
  const slots = asRecord(args.slots);
  const patternSurface = resolveNodePatternExecutionSurface({ slots });
  if (patternSurface.anchor_kind === "pattern") {
    const patternState = patternSurface.pattern_state === "stable" ? "stable" : "provisional";
    if (patternSurface.promotion.counter_evidence_open) {
      return clampSimilarity(args.similarity - 0.12);
    }
    if (patternState === "stable") {
      return clampSimilarity(args.similarity + 0.08);
    }
    return clampSimilarity(args.similarity - 0.05);
  }

  if (resolveNodeAnchorKind(slots) === "workflow") {
    const outcomeRole = resolveNodeExecutionOutcomeRole(slots);
    const contractTrust = resolveNodeExecutionContractTrust({ slots });
    let adjusted = args.similarity;
    if (outcomeRole === "passed_solution") adjusted += 0.16;
    else if (outcomeRole === "failed_branch" || outcomeRole === "blocked") adjusted -= 0.24;
    else if (contractTrust === "advisory" || contractTrust === "observational" || contractTrust == null) adjusted -= 0.08;
    if (contractTrust === "authoritative") adjusted += 0.06;
    return clampSimilarity(adjusted);
  }
  return args.similarity;
}

export function assertRecallStoreAccessContract(access: RecallStoreAccess): void {
  if (access.capability_version !== RECALL_STORE_ACCESS_CAPABILITY_VERSION) {
    throw new Error(
      `recall access capability version mismatch: expected=${RECALL_STORE_ACCESS_CAPABILITY_VERSION} got=${String(
        (access as any).capability_version,
      )}`,
    );
  }
  const requiredMethods = [
    "stage1CandidatesAnn",
    "stage1CandidatesExactRecovery",
    "stage1SemanticCandidates",
    "stage1LexicalCandidates",
    "stage1StructuredCandidates",
    "stage1ExecutionNativeCandidates",
    "stage1GraphCandidates",
    "stage1RecentCandidates",
    "stage1HybridCandidates",
    "stage2Edges",
    "stage2Nodes",
    "listAssociativeNodesByIds",
    "listAssociativeCandidatePool",
    "ruleDefs",
    "debugEmbeddings",
    "insertRecallAudit",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof (access as any)[method] !== "function") {
      throw new Error(`recall access missing required method: ${method}`);
    }
  }
  const capabilities = (access as any).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("recall access missing required capabilities object");
  }
  if (typeof capabilities.debug_embeddings !== "boolean") {
    throw new Error("recall access capabilities.debug_embeddings must be boolean");
  }
  if (typeof capabilities.audit_insert !== "boolean") {
    throw new Error("recall access capabilities.audit_insert must be boolean");
  }
}
