import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import type { AssociativeCandidateStoreAccess } from "../memory/associative-candidate-store.js";

export const WRITE_STORE_ACCESS_CAPABILITY_VERSION = 9 as const;

export type WriteCommitInsertArgs = {
  scope: string;
  parentCommitId: string | null;
  inputSha256: string;
  diffJson: string;
  actor: string;
  modelVersion: string | null;
  promptVersion: string | null;
  commitHash: string;
  digestVersion: 2;
  revision: number;
  mutationDigest: string;
  legacyAnchorCommitId: string | null;
  createdAt: string;
};

export type WriteNodeInsertArgs = {
  id: string;
  scope: string;
  clientId: string | null;
  type: string;
  tier: string;
  title: string | null;
  textSummary: string | null;
  slotsJson: string;
  rawRef: string | null;
  evidenceRef: string | null;
  embeddingVector: string | null;
  embeddingModel: string | null;
  memoryLane: "private" | "shared";
  producerAgentId: string | null;
  ownerAgentId: string | null;
  ownerTeamId: string | null;
  embeddingStatus: "pending" | "ready" | "failed";
  embeddingLastError: string | null;
  salience: number;
  importance: number;
  confidence: number;
  redactionVersion: number;
  commitId: string;
  /** v2 canonical writes provide the authority timestamp explicitly. */
  createdAt?: string;
};

export type WriteNodeFingerprintInput = Omit<WriteNodeInsertArgs, "commitId">;

export type WriteExistingNodeFingerprint = {
  scope: string;
  fingerprint: string;
};

export type WriteExistingNodeState = {
  id: string;
  scope: string;
  clientId: string | null;
  type: string;
  tier: string;
  title: string | null;
  textSummary: string | null;
  slotsJson: string;
  rawRef: string | null;
  evidenceRef: string | null;
  embeddingVector: string | null;
  embeddingModel: string | null;
  memoryLane: "private" | "shared";
  producerAgentId: string | null;
  ownerAgentId: string | null;
  ownerTeamId: string | null;
  embeddingStatus: "pending" | "ready" | "failed";
  embeddingLastError: string | null;
  salience: number;
  importance: number;
  confidence: number;
  redactionVersion: number;
  commitId: string;
  createdAt: string;
};

export type WriteLifecycleCandidateNodeRow = {
  id: string;
  type: string;
  title: string | null;
  text_summary: string | null;
  slots: Record<string, unknown>;
  tier: string;
  memory_lane: "private" | "shared";
  owner_agent_id: string | null;
  owner_team_id: string | null;
  salience: number;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export type WriteRuleDefInsertArgs = {
  scope: string;
  ruleNodeId: string;
  state: "draft" | "shadow" | "active" | "disabled";
  ifJson: string;
  thenJson: string;
  exceptionsJson: string;
  ruleScope: "global" | "agent" | "team";
  targetAgentId: string | null;
  targetTeamId: string | null;
  commitId: string;
  /** v2 canonical writes bind both authority timestamps to applied_at. */
  createdAt: string;
  updatedAt: string;
};

export type WriteExistingRuleDefState = {
  ruleNodeId: string;
  scope: string;
  state: "draft" | "shadow" | "active" | "disabled";
  ifJson: unknown;
  thenJson: unknown;
  exceptionsJson: unknown;
  ruleScope: "global" | "agent" | "team";
  targetAgentId: string | null;
  targetTeamId: string | null;
  positiveCount: number;
  negativeCount: number;
  commitId: string;
  createdAt: string;
  updatedAt: string;
};

export type WriteEdgeUpsertArgs = {
  id: string;
  scope: string;
  type: string;
  srcId: string;
  dstId: string;
  weight: number;
  confidence: number;
  decayRate: number;
  metadataJson: Record<string, unknown>;
  commitId: string;
  /** v2 canonical writes provide the authority timestamp explicitly. */
  createdAt?: string;
};

export type WriteEdgeIdentity = {
  type: string;
  srcId: string;
  dstId: string;
};

export type WriteExistingEdgeState = WriteEdgeIdentity & {
  id: string;
  scope: string;
  weight: number;
  confidence: number;
  decayRate: number;
  metadataJson: Record<string, unknown>;
  commitId: string;
  createdAt: string;
};

export function writeEdgeIdentityKey(identity: WriteEdgeIdentity): string {
  return `${identity.type}\0${identity.srcId}\0${identity.dstId}`;
}

export type WriteScopeHead = {
  scope: string;
  commitId: string;
  commitHash: string;
  revision: number;
  digestVersion: 1 | 2;
  legacyAnchorCommitId: string | null;
  persisted: boolean;
  updatedAt: string;
};

export type CompareAndSwapWriteScopeHeadArgs = {
  scope: string;
  commitId: string;
  /** Omit to bind to the current authority head inside the transaction. */
  expectedRevision?: number;
  /** When present, also fences the exact legacy or v2 commit identity. */
  expectedCommitId?: string | null;
};

export type CompareAndSwapWriteScopeHeadResult =
  | { status: "advanced"; head: WriteScopeHead }
  | { status: "conflict"; current: WriteScopeHead | null };

export type WriteOutboxInsertArgs = {
  scope: string;
  commitId: string;
  eventType: WriteOutboxEventType;
  jobKey: string;
  payloadSha256: string;
  payloadJson: string;
};

export type WriteOutboxEventType =
  | "associative_link";

export interface WriteStoreAccess extends AssociativeCandidateStoreAccess {
  readonly capability_version: typeof WRITE_STORE_ACCESS_CAPABILITY_VERSION;
  nodeScopesByIds(ids: string[]): Promise<Map<string, string>>;
  nodeFingerprintsByIds(ids: string[]): Promise<Map<string, WriteExistingNodeFingerprint>>;
  nodeStatesByIds(scope: string, ids: string[]): Promise<Map<string, WriteExistingNodeState>>;
  ruleDefStatesByIds(scope: string, ruleNodeIds: string[]): Promise<Map<string, WriteExistingRuleDefState>>;
  resolveEdgeStatesByIdentity(args: {
    scope: string;
    identities: readonly WriteEdgeIdentity[];
  }): Promise<Map<string, WriteExistingEdgeState>>;
  lifecycleCandidateNodes(scope: string, limit: number): Promise<WriteLifecycleCandidateNodeRow[]>;
  readScopeHead(scope: string): Promise<WriteScopeHead | null>;
  compareAndSwapScopeHead(
    args: CompareAndSwapWriteScopeHeadArgs,
  ): Promise<CompareAndSwapWriteScopeHeadResult>;
  parentCommitHash(scope: string, parentCommitId: string): Promise<string | null>;
  insertCommit(args: WriteCommitInsertArgs): Promise<string>;
  insertNode(args: WriteNodeInsertArgs): Promise<void>;
  insertRuleDef(args: WriteRuleDefInsertArgs): Promise<void>;
  upsertEdge(args: WriteEdgeUpsertArgs): Promise<void>;
  readyEmbeddingNodeIds(scope: string, ids: string[]): Promise<Set<string>>;
  insertOutboxEvent(args: WriteOutboxInsertArgs): Promise<void>;
}

function parseJsonForFingerprint(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function writeNodeFingerprint(input: WriteNodeFingerprintInput): string {
  return sha256Hex(
    stableStringify({
      id: input.id,
      scope: input.scope,
      clientId: input.clientId,
      type: input.type,
      tier: input.tier,
      title: input.title,
      textSummary: input.textSummary,
      slots: parseJsonForFingerprint(input.slotsJson),
      rawRef: input.rawRef,
      evidenceRef: input.evidenceRef,
      memoryLane: input.memoryLane,
      producerAgentId: input.producerAgentId,
      ownerAgentId: input.ownerAgentId,
      ownerTeamId: input.ownerTeamId,
      salience: input.salience,
      importance: input.importance,
      confidence: input.confidence,
      redactionVersion: input.redactionVersion,
    }),
  );
}

export function assertWriteStoreAccessContract(access: WriteStoreAccess): void {
  if (access.capability_version !== WRITE_STORE_ACCESS_CAPABILITY_VERSION) {
    throw new Error(
      `write access capability version mismatch: expected=${WRITE_STORE_ACCESS_CAPABILITY_VERSION} got=${String(
        (access as any).capability_version,
      )}`,
    );
  }
  const requiredMethods = [
    "nodeScopesByIds",
    "nodeFingerprintsByIds",
    "nodeStatesByIds",
    "ruleDefStatesByIds",
    "resolveEdgeStatesByIdentity",
    "lifecycleCandidateNodes",
    "readScopeHead",
    "compareAndSwapScopeHead",
    "parentCommitHash",
    "insertCommit",
    "insertNode",
    "insertRuleDef",
    "upsertEdge",
    "readyEmbeddingNodeIds",
    "insertOutboxEvent",
    "upsertAssociationCandidates",
    "listAssociationCandidatesForSource",
    "markAssociationCandidatePromoted",
    "updateAssociationCandidateStatus",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof (access as any)[method] !== "function") {
      throw new Error(`write access missing required method: ${method}`);
    }
  }
}
