import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import type { WriteExistingNodeState } from "../store/write-access.js";
import type {
  CanonicalAuthorityMutationVerificationV2,
  CanonicalAuthorityTableMutationV2,
} from "../store/write-commit-authority.js";
import { SELF_COMMIT_REFERENCE } from "./write-serialization.js";
import stableStringify from "fast-json-stable-stringify";
import {
  nodeAuthorityStateAfterPatchV2,
  type NodeAuthorityPatchV2,
  type NodeAuthorityStateV2,
} from "./node-embedding-freshness.js";

export { nodeAuthorityStateAfterPatchV2 } from "./node-embedding-freshness.js";
export type { NodeAuthorityPatchV2, NodeAuthorityStateV2 } from "./node-embedding-freshness.js";

export type NodeAuthorityHeadFence = {
  expectedHeadRevision: number;
  expectedHeadCommitId: string | null;
};

export const NODE_AUTHORITY_UPDATE_SIDE_EFFECTS = [
  "refresh_execution_native_index",
  "refresh_keyword_index",
  "refresh_embedding_projection",
  "enqueue_ann_projection_when_enabled",
] as const;

const REQUESTED_STATE_KEYS = new Set([
  "tier",
  "slots_json",
  "text_summary",
  "salience",
  "importance",
  "confidence",
]);

function parseCanonicalJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

export async function captureNodeAuthorityHeadFence(
  store: Pick<LiteWriteStore, "readScopeHead">,
  scope: string,
  opts: {
    expectedHeadRevision?: number;
    expectedHeadCommitId?: string | null;
  },
): Promise<NodeAuthorityHeadFence> {
  const head = await store.readScopeHead(scope);
  return {
    expectedHeadRevision: opts.expectedHeadRevision ?? head?.revision ?? 0,
    expectedHeadCommitId: Object.prototype.hasOwnProperty.call(opts, "expectedHeadCommitId")
      ? opts.expectedHeadCommitId ?? null
      : head?.commitId ?? null,
  };
}

export function nodeAuthorityStateV2(row: WriteExistingNodeState): NodeAuthorityStateV2 {
  return {
    id: row.id,
    scope: row.scope,
    client_id: row.clientId,
    type: row.type,
    tier: row.tier,
    title: row.title,
    text_summary: row.textSummary,
    slots_json: parseCanonicalJson(row.slotsJson),
    raw_ref: row.rawRef,
    evidence_ref: row.evidenceRef,
    embedding_vector_json: row.embeddingVector === null ? null : parseCanonicalJson(row.embeddingVector),
    embedding_model: row.embeddingModel,
    memory_lane: row.memoryLane,
    producer_agent_id: row.producerAgentId,
    owner_agent_id: row.ownerAgentId,
    owner_team_id: row.ownerTeamId,
    embedding_status: row.embeddingStatus,
    embedding_last_error: row.embeddingLastError,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    redaction_version: row.redactionVersion,
    commit_id: row.commitId,
    created_at: row.createdAt,
  };
}

export function buildNodeAuthorityMutationV2(args: {
  before: WriteExistingNodeState;
  patch: NodeAuthorityPatchV2;
  requestedEvidence?: Record<string, unknown>;
}): CanonicalAuthorityTableMutationV2 {
  const before = nodeAuthorityStateV2(args.before);
  const requestedEvidence = args.requestedEvidence ?? {};
  for (const key of Object.keys(requestedEvidence)) {
    if (REQUESTED_STATE_KEYS.has(key)) {
      throw new Error(`node_authority_requested_evidence_key_reserved:${key}`);
    }
  }
  const after = nodeAuthorityStateAfterPatchV2({ before, patch: args.patch });
  return {
    table: "lite_memory_nodes",
    identity: { scope: args.before.scope, id: args.patch.id },
    operation: "update",
    before,
    requested: {
      tier: after.tier,
      slots_json: after.slots_json,
      text_summary: after.text_summary,
      salience: after.salience,
      importance: after.importance,
      confidence: after.confidence,
      ...requestedEvidence,
    },
    after,
  };
}

export function normalizeNodeAuthorityStateV2(
  row: WriteExistingNodeState,
  commitId: string,
): NodeAuthorityStateV2 {
  const state = nodeAuthorityStateV2(row);
  return {
    ...state,
    commit_id: state.commit_id === commitId ? SELF_COMMIT_REFERENCE : state.commit_id,
  };
}

export async function applyNodeAuthorityPatchesV2(args: {
  store: Pick<LiteWriteStore, "updateNodeAnchorState">;
  scope: string;
  patches: readonly NodeAuthorityPatchV2[];
  commitId: string;
}): Promise<void> {
  for (const patch of args.patches) {
    await args.store.updateNodeAnchorState({
      scope: args.scope,
      id: patch.id,
      ...(patch.tier ? { tier: patch.tier } : {}),
      slots: patch.slots,
      textSummary: patch.textSummary,
      salience: patch.salience,
      importance: patch.importance,
      confidence: patch.confidence,
      commitId: args.commitId,
    });
  }
}

export async function verifyNodeAuthorityPatchesV2(args: {
  store: Pick<LiteWriteStore, "nodeStatesByIds">;
  scope: string;
  patches: readonly NodeAuthorityPatchV2[];
  commitId: string;
  errorLabel: string;
}): Promise<CanonicalAuthorityMutationVerificationV2[]> {
  const states = await args.store.nodeStatesByIds(args.scope, args.patches.map((patch) => patch.id));
  return args.patches.map((patch) => {
    const state = states.get(patch.id);
    if (!state) throw new Error(`${args.errorLabel}_verification_target_missing:${patch.id}`);
    return {
      table: "lite_memory_nodes",
      identity: { scope: args.scope, id: patch.id },
      after: normalizeNodeAuthorityStateV2(state, args.commitId),
    };
  });
}

export function assertNodeDecisionRowMatchesAuthorityState(
  row: LiteFindNodeRow,
  state: WriteExistingNodeState,
  errorLabel: string,
): void {
  const decisionState = {
    id: row.id,
    type: row.type,
    tier: row.tier,
    title: row.title,
    text_summary: row.text_summary,
    slots: row.slots,
    raw_ref: row.raw_ref,
    evidence_ref: row.evidence_ref,
    memory_lane: row.memory_lane,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
  const authorityState = {
    id: state.id,
    type: state.type,
    tier: state.tier,
    title: state.title,
    text_summary: state.textSummary,
    slots: parseCanonicalJson(state.slotsJson),
    raw_ref: state.rawRef,
    evidence_ref: state.evidenceRef,
    memory_lane: state.memoryLane,
    producer_agent_id: state.producerAgentId,
    owner_agent_id: state.ownerAgentId,
    owner_team_id: state.ownerTeamId,
    salience: state.salience,
    importance: state.importance,
    confidence: state.confidence,
    commit_id: state.commitId,
    created_at: state.createdAt,
  };
  if (stableStringify(decisionState) !== stableStringify(authorityState)) {
    throw new Error(`${errorLabel}:${row.id}`);
  }
}
