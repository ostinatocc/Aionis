import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { buildAionisUri } from "./uri.js";
import type { PreparedWrite, WriteResult } from "./write-contract.js";

export const APPLIED_WRITE_MUTATION_DIGEST_VERSION = 2 as const;
export const SELF_COMMIT_REFERENCE = "$self" as const;

export type CanonicalCommitReference = string | typeof SELF_COMMIT_REFERENCE;

export type CanonicalNodeStateV2 = {
  id: string;
  scope: string;
  client_id: string | null;
  type: string;
  tier: string;
  title: string | null;
  text_summary: string | null;
  /** Canonical decoded value of the persisted slots_json column. */
  slots_json: unknown;
  raw_ref: string | null;
  evidence_ref: string | null;
  /** Canonical decoded value of the persisted embedding_vector_json column. */
  embedding_vector_json: unknown | null;
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
  commit_id: CanonicalCommitReference;
  created_at: string;
};

export type CanonicalEdgeStateV2 = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight: number;
  confidence: number;
  decay_rate: number;
  metadata_json: Record<string, unknown>;
  commit_id: CanonicalCommitReference;
  created_at: string;
};

export type CanonicalRequestedNodeV2 = Omit<CanonicalNodeStateV2, "commit_id" | "created_at">;
export type CanonicalRequestedEdgeV2 = Omit<CanonicalEdgeStateV2, "commit_id" | "created_at">;

export type CanonicalRuleDefStateV2 = {
  rule_node_id: string;
  scope: string;
  state: "draft" | "shadow" | "active" | "disabled";
  /** Canonical decoded value of the persisted if_json column. */
  if_json: unknown;
  /** Canonical decoded value of the persisted then_json column. */
  then_json: unknown;
  /** Canonical decoded value of the persisted exceptions_json column. */
  exceptions_json: unknown;
  rule_scope: "global" | "agent" | "team";
  target_agent_id: string | null;
  target_team_id: string | null;
  positive_count: number;
  negative_count: number;
  commit_id: CanonicalCommitReference;
  created_at: string;
  updated_at: string;
};

export type CanonicalNodeMutationV2 = {
  operation: "insert";
  requested: CanonicalRequestedNodeV2;
  before: null;
  after: CanonicalNodeStateV2;
};

export type CanonicalEdgeMutationV2 = {
  operation: "insert" | "update";
  requested: CanonicalRequestedEdgeV2;
  before: CanonicalEdgeStateV2 | null;
  after: CanonicalEdgeStateV2;
};

export type CanonicalRuleDefMutationV2 = {
  operation: "insert";
  /** The requested insert is the full 14-column authority row. */
  requested: CanonicalRuleDefStateV2;
  before: null;
  after: CanonicalRuleDefStateV2;
};

export type CanonicalAppliedWriteMutationV2 = {
  contract: "aionis_applied_write_mutation_v2";
  digest_version: typeof APPLIED_WRITE_MUTATION_DIGEST_VERSION;
  applied_at: string;
  redaction: Record<string, number>;
  policy: {
    node_identity: "id";
    node_existing: "no_op_if_identical_otherwise_reject";
    node_commit_id: "self_on_insert";
    node_created_at: "allocate_on_insert";
    edge_identity: "scope_type_src_dst";
    edge_id: "preserve_existing";
    edge_weight: "monotonic_max";
    edge_confidence: "monotonic_max";
    edge_decay_rate: "replace";
    edge_metadata: "replace";
    edge_commit_id: "self_on_applied_mutation";
    edge_created_at: "allocate_on_insert_preserve_on_update";
    rule_def_identity: "scope_rule_node_id";
    rule_def_existing: "no_op_if_present_insert_if_missing";
    rule_def_commit_id: "self_on_insert";
    rule_def_created_at: "bind_applied_at";
    rule_def_updated_at: "bind_applied_at";
    rule_def_counters: "initialize_zero";
    unchanged_mutation: "no_op";
  };
  nodes: CanonicalNodeMutationV2[];
  edges: CanonicalEdgeMutationV2[];
  rule_defs: CanonicalRuleDefMutationV2[];
};

export type CanonicalAppliedWriteMutationPlan = {
  applied_at: string;
  nodes: CanonicalNodeMutationV2[];
  edges: CanonicalEdgeMutationV2[];
  rule_defs: CanonicalRuleDefMutationV2[];
};

function compareCanonicalMutationKey(leftKey: string, rightKey: string, left: unknown, right: unknown): number {
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  const leftState = stableStringify(left);
  const rightState = stableStringify(right);
  return leftState < rightState ? -1 : leftState > rightState ? 1 : 0;
}

function compareCanonicalNodeIdentity(left: CanonicalNodeMutationV2, right: CanonicalNodeMutationV2): number {
  return compareCanonicalMutationKey(
    `${left.after.scope}\0${left.after.id}`,
    `${right.after.scope}\0${right.after.id}`,
    left.after,
    right.after,
  );
}

function compareCanonicalEdgeIdentity(left: CanonicalEdgeMutationV2, right: CanonicalEdgeMutationV2): number {
  return compareCanonicalMutationKey(
    `${left.after.scope}\0${left.after.type}\0${left.after.src_id}\0${left.after.dst_id}`,
    `${right.after.scope}\0${right.after.type}\0${right.after.src_id}\0${right.after.dst_id}`,
    left.after,
    right.after,
  );
}

function compareCanonicalRuleDefIdentity(
  left: CanonicalRuleDefMutationV2,
  right: CanonicalRuleDefMutationV2,
): number {
  return compareCanonicalMutationKey(
    `${left.after.scope}\0${left.after.rule_node_id}`,
    `${right.after.scope}\0${right.after.rule_node_id}`,
    left.after,
    right.after,
  );
}

export function buildCanonicalAppliedWriteMutation(
  prepared: PreparedWrite,
  piiRedaction: boolean,
  plan: CanonicalAppliedWriteMutationPlan,
): CanonicalAppliedWriteMutationV2 {
  return {
    contract: "aionis_applied_write_mutation_v2",
    digest_version: APPLIED_WRITE_MUTATION_DIGEST_VERSION,
    applied_at: plan.applied_at,
    redaction: piiRedaction ? prepared.redaction_meta : {},
    policy: {
      node_identity: "id",
      node_existing: "no_op_if_identical_otherwise_reject",
      node_commit_id: "self_on_insert",
      node_created_at: "allocate_on_insert",
      edge_identity: "scope_type_src_dst",
      edge_id: "preserve_existing",
      edge_weight: "monotonic_max",
      edge_confidence: "monotonic_max",
      edge_decay_rate: "replace",
      edge_metadata: "replace",
      edge_commit_id: "self_on_applied_mutation",
      edge_created_at: "allocate_on_insert_preserve_on_update",
      rule_def_identity: "scope_rule_node_id",
      rule_def_existing: "no_op_if_present_insert_if_missing",
      rule_def_commit_id: "self_on_insert",
      rule_def_created_at: "bind_applied_at",
      rule_def_updated_at: "bind_applied_at",
      rule_def_counters: "initialize_zero",
      unchanged_mutation: "no_op",
    },
    nodes: [...plan.nodes].sort(compareCanonicalNodeIdentity),
    edges: [...plan.edges].sort(compareCanonicalEdgeIdentity),
    rule_defs: [...plan.rule_defs].sort(compareCanonicalRuleDefIdentity),
  };
}

export function canonicalAppliedMutationJson(mutation: CanonicalAppliedWriteMutationV2): string {
  return stableStringify(mutation);
}

export function canonicalAppliedMutationDigest(mutation: CanonicalAppliedWriteMutationV2): string {
  return sha256Hex(canonicalAppliedMutationJson(mutation));
}

export function buildWriteResult(
  prepared: PreparedWrite,
  commitId: string,
  commitHash: string,
  resolved?: {
    node_ids?: Map<string, string>;
    edge_ids?: Map<string, string>;
  },
): WriteResult {
  return {
    tenant_id: prepared.tenant_id,
    scope: prepared.scope_public,
    commit_id: commitId,
    commit_uri: buildAionisUri({
      tenant_id: prepared.tenant_id,
      scope: prepared.scope_public,
      type: "commit",
      id: commitId,
    }),
    commit_hash: commitHash,
    nodes: prepared.nodes.map((node) => ({
      id: resolved?.node_ids?.get(node.id) ?? node.id,
      uri: buildAionisUri({
        tenant_id: prepared.tenant_id,
        scope: prepared.scope_public,
        type: node.type,
        id: resolved?.node_ids?.get(node.id) ?? node.id,
      }),
      client_id: node.client_id,
      type: node.type,
    })),
    edges: prepared.edges.map((edge) => ({
      id: resolved?.edge_ids?.get(edge.id) ?? edge.id,
      uri: buildAionisUri({
        tenant_id: prepared.tenant_id,
        scope: prepared.scope_public,
        type: "edge",
        id: resolved?.edge_ids?.get(edge.id) ?? edge.id,
      }),
      type: edge.type,
      src_id: edge.src_id,
      dst_id: edge.dst_id,
    })),
  };
}
