import { resolveNodePatternExecutionSurface } from "../memory/node-execution-surface.js";

export const RECALL_STORE_ACCESS_CAPABILITY_VERSION = 2 as const;

export type RecallCandidate = {
  id: string;
  type: string;
  title: string | null;
  text_summary: string | null;
  tier: string;
  salience: number;
  confidence: number;
  similarity: number;
};

export type RecallStage1Params = {
  queryEmbedding: number[];
  scope: string;
  oversample: number;
  limit: number;
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
  stage2Edges(params: RecallStage2EdgesParams): Promise<RecallEdgeRow[]>;
  stage2Nodes(params: RecallStage2NodesParams): Promise<RecallNodeRow[]>;
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
  if (patternSurface.anchor_kind !== "pattern") return args.similarity;
  const patternState = patternSurface.pattern_state === "stable" ? "stable" : "provisional";
  if (patternSurface.promotion.counter_evidence_open) {
    return clampSimilarity(args.similarity - 0.12);
  }
  if (patternState === "stable") {
    return clampSimilarity(args.similarity + 0.08);
  }
  return clampSimilarity(args.similarity - 0.05);
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
    "stage2Edges",
    "stage2Nodes",
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
