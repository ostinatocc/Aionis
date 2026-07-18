import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";

export type CanonicalV2CommitHashArgs = {
  digestVersion: 2;
  revision: number;
  parentHash: string;
  inputSha256: string;
  mutationDigest: string;
  scope: string;
  actor: string;
  modelVersion: string | null;
  promptVersion: string | null;
};

/** One pure commit-hash implementation shared by the planner and SQLite fence. */
export function canonicalV2CommitHash(args: CanonicalV2CommitHashArgs): string {
  return sha256Hex(stableStringify({
    digest_version: args.digestVersion,
    revision: args.revision,
    parent_hash: args.parentHash,
    input_sha256: args.inputSha256,
    mutation_digest: args.mutationDigest,
    scope: args.scope,
    actor: args.actor,
    model_version: args.modelVersion,
    prompt_version: args.promptVersion,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || keys.some((key) => !allowed.has(key))) {
    throw new Error(`lite_memory_commit_v2_${label}_keys_invalid`);
  }
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type AppliedAuthorityTableContract = Readonly<{
  identityKeys: readonly string[];
  rowKeys: readonly string[];
  operations: readonly ("insert" | "update")[];
}>;

/**
 * Closed registry for generic authority writes. A table is not eligible for
 * generic mutation merely because its name starts with `lite_`: every
 * persisted row column must be represented in the canonical evidence.
 */
export const APPLIED_AUTHORITY_TABLE_CONTRACTS = {
  lite_memory_execution_decisions: {
    identityKeys: ["scope", "id"],
    rowKeys: [
      "id", "scope", "decision_kind", "run_id", "selected_tool",
      "candidates_json", "context_sha256", "policy_sha256",
      "source_rule_ids_json", "metadata_json", "commit_id", "created_at",
    ],
    operations: ["insert", "update"],
  },
  lite_memory_nodes: {
    identityKeys: ["scope", "id"],
    rowKeys: [
      "id", "scope", "client_id", "type", "tier", "title", "text_summary",
      "slots_json", "raw_ref", "evidence_ref", "embedding_vector_json",
      "embedding_model", "memory_lane", "producer_agent_id", "owner_agent_id",
      "owner_team_id", "embedding_status", "embedding_last_error", "salience",
      "importance", "confidence", "redaction_version", "commit_id", "created_at",
    ],
    operations: ["insert", "update"],
  },
  lite_memory_rule_defs: {
    identityKeys: ["scope", "rule_node_id"],
    rowKeys: [
      "rule_node_id", "scope", "state", "if_json", "then_json",
      "exceptions_json", "rule_scope", "target_agent_id", "target_team_id",
      "positive_count", "negative_count", "commit_id", "created_at", "updated_at",
    ],
    operations: ["insert", "update"],
  },
  lite_memory_rule_feedback: {
    identityKeys: ["scope", "id"],
    rowKeys: [
      "id", "scope", "rule_node_id", "run_id", "outcome", "note", "source",
      "decision_id", "commit_id", "created_at",
    ],
    operations: ["insert"],
  },
} as const satisfies Record<string, AppliedAuthorityTableContract>;

function authorityTableContract(table: string): AppliedAuthorityTableContract {
  const contract = (APPLIED_AUTHORITY_TABLE_CONTRACTS as Record<
    string,
    AppliedAuthorityTableContract | undefined
  >)[table];
  if (!contract) throw new Error("lite_memory_commit_v2_authority_table_not_registered");
  return contract;
}

function assertAuthorityIdentityAndRow(args: {
  table: string;
  identity: Record<string, unknown>;
  row: Record<string, unknown>;
  label: string;
}): void {
  const contract = authorityTableContract(args.table);
  assertExactKeys(args.identity, contract.identityKeys, [], `${args.label}_identity`);
  assertExactKeys(args.row, contract.rowKeys, [], `${args.label}_row`);
  for (const key of contract.identityKeys) {
    if (stableStringify(args.identity[key]) !== stableStringify(args.row[key])) {
      throw new Error(`lite_memory_commit_v2_${args.label}_identity_row_mismatch`);
    }
  }
}

export type CanonicalAuthorityTableMutationV2 = {
  table: string;
  identity: Record<string, unknown>;
  operation: "insert" | "update";
  before: Record<string, unknown> | null;
  requested?: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type CanonicalAppliedAuthorityMutationV2 = {
  contract: "aionis_applied_authority_mutation_v2";
  digest_version: 2;
  applied_at: string;
  authority_kind: string;
  policy: {
    commit_reference: "$self";
    verification: "read_after_exact_match";
    no_op: "return_current_head";
  };
  mutations: CanonicalAuthorityTableMutationV2[];
};

export type CanonicalAuthorityMutationVerificationV2 = Pick<
  CanonicalAuthorityTableMutationV2,
  "table" | "identity" | "after"
>;

export function materializeSelfCommitReferences<T>(value: T, commitId: string): T {
  if (value === "$self") return commitId as T;
  if (Array.isArray(value)) {
    return value.map((entry) => materializeSelfCommitReferences(entry, commitId)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      materializeSelfCommitReferences(entry, commitId),
    ])) as T;
  }
  return value;
}

export function normalizeSelfCommitReferences<T>(value: T, commitId: string): T {
  if (value === commitId) return "$self" as T;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSelfCommitReferences(entry, commitId)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      normalizeSelfCommitReferences(entry, commitId),
    ])) as T;
  }
  return value;
}

export function canonicalAuthorityMutationIdentityKey(
  mutation: Pick<CanonicalAuthorityTableMutationV2, "table" | "identity">,
): string {
  return `${mutation.table}\0${stableStringify(mutation.identity)}`;
}

function sortedUniqueAuthorityMutations(
  mutations: readonly CanonicalAuthorityTableMutationV2[],
): CanonicalAuthorityTableMutationV2[] {
  if (mutations.length === 0) {
    throw new Error("lite_memory_commit_v2_authority_mutations_required");
  }
  for (const [index, mutation] of mutations.entries()) {
    const contract = authorityTableContract(mutation.table);
    if (!contract.operations.includes(mutation.operation)) {
      throw new Error(`lite_memory_commit_v2_authority_operation_invalid:${index}`);
    }
    if ((mutation.operation === "insert" && mutation.before !== null)
      || (mutation.operation === "update" && !isRecord(mutation.before))) {
      throw new Error(`lite_memory_commit_v2_authority_before_invalid:${index}`);
    }
    assertAuthorityIdentityAndRow({
      table: mutation.table,
      identity: mutation.identity,
      row: mutation.after,
      label: "authority_after",
    });
    if (mutation.after.commit_id !== "$self") {
      throw new Error(`lite_memory_commit_v2_authority_after_invalid:${index}`);
    }
    if (mutation.before) {
      assertAuthorityIdentityAndRow({
        table: mutation.table,
        identity: mutation.identity,
        row: mutation.before,
        label: "authority_before",
      });
    }
  }
  const sorted = [...mutations].sort((left, right) => compareCanonicalText(
    canonicalAuthorityMutationIdentityKey(left),
    canonicalAuthorityMutationIdentityKey(right),
  ));
  for (let index = 1; index < sorted.length; index += 1) {
    if (canonicalAuthorityMutationIdentityKey(sorted[index - 1]!)
      === canonicalAuthorityMutationIdentityKey(sorted[index]!)) {
      throw new Error("lite_memory_commit_v2_authority_mutation_identity_duplicate");
    }
  }
  return sorted;
}

export function buildCanonicalAppliedAuthorityMutationV2(args: {
  appliedAt: string;
  authorityKind: string;
  mutations: readonly CanonicalAuthorityTableMutationV2[];
}): CanonicalAppliedAuthorityMutationV2 {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(args.authorityKind)) {
    throw new Error("lite_memory_commit_v2_authority_kind_invalid");
  }
  return {
    contract: "aionis_applied_authority_mutation_v2",
    digest_version: 2,
    applied_at: args.appliedAt,
    authority_kind: args.authorityKind,
    policy: {
      commit_reference: "$self",
      verification: "read_after_exact_match",
      no_op: "return_current_head",
    },
    mutations: sortedUniqueAuthorityMutations(args.mutations),
  };
}

export function canonicalAuthorityMutationVerificationProjection(
  mutations: readonly CanonicalAuthorityTableMutationV2[],
): CanonicalAuthorityMutationVerificationV2[] {
  return sortedUniqueAuthorityMutations(mutations).map((mutation) => ({
    table: mutation.table,
    identity: mutation.identity,
    after: mutation.after,
  }));
}

export function canonicalizeAuthorityMutationVerificationV2(
  values: readonly CanonicalAuthorityMutationVerificationV2[],
): CanonicalAuthorityMutationVerificationV2[] {
  if (values.length === 0) {
    throw new Error("lite_memory_commit_v2_authority_verification_required");
  }
  const sorted = [...values].sort((left, right) => compareCanonicalText(
    canonicalAuthorityMutationIdentityKey(left),
    canonicalAuthorityMutationIdentityKey(right),
  ));
  for (const [index, value] of sorted.entries()) {
    if (typeof value.table !== "string"
      || !isRecord(value.identity)
      || !isRecord(value.after)
      || value.after.commit_id !== "$self") {
      throw new Error(`lite_memory_commit_v2_authority_verification_invalid:${index}`);
    }
    assertAuthorityIdentityAndRow({
      table: value.table,
      identity: value.identity,
      row: value.after,
      label: "authority_verification",
    });
    if (index > 0 && canonicalAuthorityMutationIdentityKey(sorted[index - 1]!)
      === canonicalAuthorityMutationIdentityKey(value)) {
      throw new Error("lite_memory_commit_v2_authority_verification_identity_duplicate");
    }
  }
  return sorted;
}

function assertAuthorityMutationContract(parsed: Record<string, unknown>): void {
  assertExactKeys(
    parsed,
    ["contract", "digest_version", "applied_at", "authority_kind", "policy", "mutations"],
    [],
    "authority_contract",
  );
  if (typeof parsed.authority_kind !== "string"
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(parsed.authority_kind)) {
    throw new Error("lite_memory_commit_v2_authority_kind_invalid");
  }
  if (!isRecord(parsed.policy)) {
    throw new Error("lite_memory_commit_v2_authority_policy_invalid");
  }
  assertExactKeys(
    parsed.policy,
    ["commit_reference", "verification", "no_op"],
    [],
    "authority_policy",
  );
  if (parsed.policy.commit_reference !== "$self"
    || parsed.policy.verification !== "read_after_exact_match"
    || parsed.policy.no_op !== "return_current_head") {
    throw new Error("lite_memory_commit_v2_authority_policy_invalid");
  }
  if (!Array.isArray(parsed.mutations) || parsed.mutations.length === 0) {
    throw new Error("lite_memory_commit_v2_authority_mutations_required");
  }
  const keys: string[] = [];
  for (const [index, value] of parsed.mutations.entries()) {
    if (!isRecord(value)) {
      throw new Error(`lite_memory_commit_v2_authority_mutation_invalid:${index}`);
    }
    assertExactKeys(
      value,
      ["table", "identity", "operation", "before", "after"],
      ["requested"],
      "authority_mutation",
    );
    if (typeof value.table !== "string") {
      throw new Error(`lite_memory_commit_v2_authority_table_invalid:${index}`);
    }
    const tableContract = authorityTableContract(value.table);
    if (!isRecord(value.identity)) {
      throw new Error(`lite_memory_commit_v2_authority_identity_invalid:${index}`);
    }
    if ((value.operation !== "insert" && value.operation !== "update")
      || !tableContract.operations.includes(value.operation)) {
      throw new Error(`lite_memory_commit_v2_authority_operation_invalid:${index}`);
    }
    if ((value.operation === "insert" && value.before !== null)
      || (value.operation === "update" && !isRecord(value.before))) {
      throw new Error(`lite_memory_commit_v2_authority_before_invalid:${index}`);
    }
    if (Object.prototype.hasOwnProperty.call(value, "requested") && !isRecord(value.requested)) {
      throw new Error(`lite_memory_commit_v2_authority_requested_invalid:${index}`);
    }
    if (!isRecord(value.after) || value.after.commit_id !== "$self") {
      throw new Error(`lite_memory_commit_v2_authority_after_invalid:${index}`);
    }
    assertAuthorityIdentityAndRow({
      table: value.table,
      identity: value.identity,
      row: value.after,
      label: "authority_after",
    });
    if (isRecord(value.before)) {
      assertAuthorityIdentityAndRow({
        table: value.table,
        identity: value.identity,
        row: value.before,
        label: "authority_before",
      });
    }
    keys.push(canonicalAuthorityMutationIdentityKey({
      table: value.table,
      identity: value.identity,
    }));
  }
  const sorted = [...keys].sort(compareCanonicalText);
  if (new Set(keys).size !== keys.length || stableStringify(keys) !== stableStringify(sorted)) {
    throw new Error("lite_memory_commit_v2_authority_mutation_order_invalid");
  }
}

function assertMemoryWriteMutationContract(parsed: Record<string, unknown>, expectedScope: string): void {
  assertExactKeys(
    parsed,
    ["contract", "digest_version", "applied_at", "redaction", "policy", "nodes", "edges", "rule_defs"],
    [],
    "write_contract",
  );
  if (!isRecord(parsed.redaction) || !isRecord(parsed.policy)
    || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || !Array.isArray(parsed.rule_defs)
    || parsed.nodes.length + parsed.edges.length + parsed.rule_defs.length === 0) {
    throw new Error("lite_memory_commit_v2_diff_contract_invalid");
  }
  assertExactKeys(
    parsed.policy,
    [
      "node_identity",
      "node_existing",
      "node_commit_id",
      "node_created_at",
      "edge_identity",
      "edge_id",
      "edge_weight",
      "edge_confidence",
      "edge_decay_rate",
      "edge_metadata",
      "edge_commit_id",
      "edge_created_at",
      "rule_def_identity",
      "rule_def_existing",
      "rule_def_commit_id",
      "rule_def_created_at",
      "rule_def_updated_at",
      "rule_def_counters",
      "unchanged_mutation",
    ],
    [],
    "write_policy",
  );
  const expectedPolicy = {
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
  };
  if (stableStringify(parsed.policy) !== stableStringify(expectedPolicy)) {
    throw new Error("lite_memory_commit_v2_write_policy_invalid");
  }
  const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
  const finiteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
  const exactRequestedState = (
    requested: Record<string, unknown>,
    after: Record<string, unknown>,
  ): boolean => {
    const { commit_id: _commitId, created_at: _createdAt, ...persistedBusinessState } = after;
    return stableStringify(requested) === stableStringify(persistedBusinessState);
  };
  const assertCanonicalIdentityOrder = (identities: string[], label: string): void => {
    const sorted = [...identities].sort(compareCanonicalText);
    if (new Set(identities).size !== identities.length
      || stableStringify(identities) !== stableStringify(sorted)) {
      throw new Error(`lite_memory_commit_v2_${label}_mutation_order_invalid`);
    }
  };

  const nodeRequestedKeys = [
    "id", "scope", "client_id", "type", "tier", "title", "text_summary",
    "slots_json", "raw_ref", "evidence_ref", "embedding_vector_json",
    "embedding_model", "memory_lane", "producer_agent_id", "owner_agent_id",
    "owner_team_id", "embedding_status", "embedding_last_error", "salience",
    "importance", "confidence", "redaction_version",
  ] as const;
  const nodeAfterKeys = [...nodeRequestedKeys, "commit_id", "created_at"] as const;
  const nodeIdentities: string[] = [];
  for (const [index, value] of parsed.nodes.entries()) {
    if (!isRecord(value)) throw new Error(`lite_memory_commit_v2_node_mutation_invalid:${index}`);
    assertExactKeys(value, ["operation", "requested", "before", "after"], [], "node_mutation");
    if (value.operation !== "insert" || value.before !== null
      || !isRecord(value.requested) || !isRecord(value.after)) {
      throw new Error(`lite_memory_commit_v2_node_mutation_invalid:${index}`);
    }
    assertExactKeys(value.requested, nodeRequestedKeys, [], "node_requested");
    assertExactKeys(value.after, nodeAfterKeys, [], "node_after");
    const after = value.after;
    if (after.commit_id !== "$self" || after.created_at !== parsed.applied_at
      || !exactRequestedState(value.requested, after)
      || typeof after.id !== "string" || after.id.length === 0
      || after.scope !== expectedScope
      || typeof after.type !== "string" || after.type.length === 0
      || typeof after.tier !== "string" || after.tier.length === 0
      || !nullableString(after.client_id)
      || !nullableString(after.title)
      || !nullableString(after.text_summary)
      || !isRecord(after.slots_json)
      || !nullableString(after.raw_ref)
      || !nullableString(after.evidence_ref)
      || (after.embedding_vector_json !== null && !Array.isArray(after.embedding_vector_json))
      || !nullableString(after.embedding_model)
      || (after.memory_lane !== "private" && after.memory_lane !== "shared")
      || !nullableString(after.producer_agent_id)
      || !nullableString(after.owner_agent_id)
      || !nullableString(after.owner_team_id)
      || !["pending", "ready", "failed"].includes(String(after.embedding_status))
      || !nullableString(after.embedding_last_error)
      || !finiteNumber(after.salience)
      || !finiteNumber(after.importance)
      || !finiteNumber(after.confidence)
      || !Number.isSafeInteger(after.redaction_version)
      || Number(after.redaction_version) < 0) {
      throw new Error(`lite_memory_commit_v2_node_mutation_invalid:${index}`);
    }
    nodeIdentities.push(`${after.scope}\0${after.id}`);
  }
  assertCanonicalIdentityOrder(nodeIdentities, "node");

  const edgeRequestedKeys = [
    "id", "scope", "type", "src_id", "dst_id", "weight", "confidence",
    "decay_rate", "metadata_json",
  ] as const;
  const edgeAfterKeys = [...edgeRequestedKeys, "commit_id", "created_at"] as const;
  const edgeIdentities: string[] = [];
  for (const [index, value] of parsed.edges.entries()) {
    if (!isRecord(value)) throw new Error(`lite_memory_commit_v2_edge_mutation_invalid:${index}`);
    assertExactKeys(value, ["operation", "requested", "before", "after"], [], "edge_mutation");
    if ((value.operation !== "insert" && value.operation !== "update")
      || !isRecord(value.requested) || !isRecord(value.after)
      || (value.operation === "insert" && value.before !== null)
      || (value.operation === "update" && !isRecord(value.before))) {
      throw new Error(`lite_memory_commit_v2_edge_mutation_invalid:${index}`);
    }
    assertExactKeys(value.requested, edgeRequestedKeys, [], "edge_requested");
    assertExactKeys(value.after, edgeAfterKeys, [], "edge_after");
    if (isRecord(value.before)) assertExactKeys(value.before, edgeAfterKeys, [], "edge_before");
    const requested = value.requested;
    const after = value.after;
    const before = isRecord(value.before) ? value.before : null;
    const validIdentity = typeof requested.id === "string" && requested.id.length > 0
      && requested.scope === expectedScope
      && typeof requested.type === "string" && requested.type.length > 0
      && typeof requested.src_id === "string" && requested.src_id.length > 0
      && typeof requested.dst_id === "string" && requested.dst_id.length > 0
      && after.scope === requested.scope
      && after.type === requested.type
      && after.src_id === requested.src_id
      && after.dst_id === requested.dst_id;
    const validValues = finiteNumber(requested.weight)
      && finiteNumber(requested.confidence)
      && finiteNumber(requested.decay_rate)
      && isRecord(requested.metadata_json)
      && after.commit_id === "$self"
      && finiteNumber(after.weight)
      && finiteNumber(after.confidence)
      && finiteNumber(after.decay_rate)
      && isRecord(after.metadata_json);
    const validInsert = value.operation !== "insert" || (
      after.created_at === parsed.applied_at
      && exactRequestedState(requested, after)
    );
    const validUpdate = value.operation !== "update" || (!!before
      && typeof before.id === "string" && before.id.length > 0
      && before.scope === requested.scope
      && before.type === requested.type
      && before.src_id === requested.src_id
      && before.dst_id === requested.dst_id
      && typeof before.commit_id === "string" && before.commit_id.length > 0
      && before.commit_id !== "$self"
      && typeof before.created_at === "string" && before.created_at.length > 0
      && finiteNumber(before.weight)
      && finiteNumber(before.confidence)
      && finiteNumber(before.decay_rate)
      && isRecord(before.metadata_json)
      && after.id === before.id
      && after.created_at === before.created_at
      && after.weight === Math.max(Number(before.weight), Number(requested.weight))
      && after.confidence === Math.max(Number(before.confidence), Number(requested.confidence))
      && after.decay_rate === requested.decay_rate
      && stableStringify(after.metadata_json) === stableStringify(requested.metadata_json));
    if (!validIdentity || !validValues || !validInsert || !validUpdate) {
      throw new Error(`lite_memory_commit_v2_edge_mutation_invalid:${index}`);
    }
    edgeIdentities.push(`${after.scope}\0${after.type}\0${after.src_id}\0${after.dst_id}`);
  }
  assertCanonicalIdentityOrder(edgeIdentities, "edge");

  const ruleDefRowKeys = [
    "rule_node_id", "scope", "state", "if_json", "then_json",
    "exceptions_json", "rule_scope", "target_agent_id", "target_team_id",
    "positive_count", "negative_count", "commit_id", "created_at", "updated_at",
  ] as const;
  const ruleDefIdentities: string[] = [];
  for (const [index, value] of parsed.rule_defs.entries()) {
    if (!isRecord(value)) throw new Error(`lite_memory_commit_v2_rule_def_mutation_invalid:${index}`);
    assertExactKeys(value, ["operation", "requested", "before", "after"], [], "rule_def_mutation");
    if (value.operation !== "insert" || value.before !== null
      || !isRecord(value.requested) || !isRecord(value.after)) {
      throw new Error(`lite_memory_commit_v2_rule_def_mutation_invalid:${index}`);
    }
    assertExactKeys(value.requested, ruleDefRowKeys, [], "rule_def_requested");
    assertExactKeys(value.after, ruleDefRowKeys, [], "rule_def_after");
    if (value.requested.commit_id !== "$self" || value.after.commit_id !== "$self"
      || value.requested.created_at !== parsed.applied_at
      || value.requested.updated_at !== parsed.applied_at
      || value.after.created_at !== parsed.applied_at
      || value.after.updated_at !== parsed.applied_at
      || value.requested.positive_count !== 0
      || value.requested.negative_count !== 0
      || stableStringify(value.requested) !== stableStringify(value.after)
      || value.after.scope !== expectedScope
      || typeof value.after.rule_node_id !== "string"
      || value.after.rule_node_id.length === 0
      || !["draft", "shadow", "active", "disabled"].includes(String(value.after.state))
      || !["global", "agent", "team"].includes(String(value.after.rule_scope))
      || (value.after.target_agent_id !== null && typeof value.after.target_agent_id !== "string")
      || (value.after.target_team_id !== null && typeof value.after.target_team_id !== "string")
      || !Number.isSafeInteger(value.after.positive_count)
      || Number(value.after.positive_count) < 0
      || !Number.isSafeInteger(value.after.negative_count)
      || Number(value.after.negative_count) < 0
      || (value.after.rule_scope === "agent"
        && (typeof value.after.target_agent_id !== "string" || value.after.target_agent_id.length === 0))
      || (value.after.rule_scope === "team"
        && (typeof value.after.target_team_id !== "string" || value.after.target_team_id.length === 0))) {
      throw new Error(`lite_memory_commit_v2_rule_def_mutation_invalid:${index}`);
    }
    ruleDefIdentities.push(`${value.after.scope}\0${value.after.rule_node_id}`);
  }
  const sortedRuleDefIdentities = [...ruleDefIdentities].sort(compareCanonicalText);
  if (new Set(ruleDefIdentities).size !== ruleDefIdentities.length
    || stableStringify(ruleDefIdentities) !== stableStringify(sortedRuleDefIdentities)) {
    throw new Error("lite_memory_commit_v2_rule_def_mutation_order_invalid");
  }
}

/**
 * Rejects semantically equivalent but byte-distinct JSON and binds the stored
 * mutation digest to the exact canonical UTF-8 diff bytes.
 */
export function assertCanonicalV2MutationJson(args: {
  diffJson: string;
  mutationDigest: string;
  createdAt: string;
  scope: string;
}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.diffJson) as unknown;
  } catch {
    throw new Error("lite_memory_commit_v2_diff_json_invalid");
  }
  if (!isRecord(parsed)) {
    throw new Error("lite_memory_commit_v2_diff_json_object_required");
  }
  if (stableStringify(parsed) !== args.diffJson) {
    throw new Error("lite_memory_commit_v2_diff_json_noncanonical");
  }
  if (parsed.digest_version !== 2
    || (parsed.contract !== "aionis_applied_write_mutation_v2"
      && parsed.contract !== "aionis_applied_authority_mutation_v2")) {
    throw new Error("lite_memory_commit_v2_diff_contract_invalid");
  }
  if (parsed.contract === "aionis_applied_write_mutation_v2") {
    assertMemoryWriteMutationContract(parsed, args.scope);
  } else {
    assertAuthorityMutationContract(parsed);
  }
  if (parsed.applied_at !== args.createdAt) {
    throw new Error("lite_memory_commit_v2_diff_created_at_mismatch");
  }
  const expectedMutationDigest = sha256Hex(args.diffJson);
  if (args.mutationDigest !== expectedMutationDigest) {
    throw new Error("lite_memory_commit_v2_mutation_digest_mismatch");
  }
  return parsed;
}
