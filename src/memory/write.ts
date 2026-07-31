import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { assertDim, toVectorLiteral } from "../util/vector-literal.js";
import { normalizeText } from "../util/normalize.js";
import { badRequest, HttpError } from "../util/http.js";
import {
  assertWriteStoreAccessContract,
  writeEdgeIdentityKey,
  writeNodeFingerprint,
  type WriteEdgeUpsertArgs,
  type WriteExistingEdgeState,
  type WriteExistingNodeState,
  type WriteExistingRuleDefState,
  type WriteNodeInsertArgs,
  type WriteRuleDefInsertArgs,
  type WriteStoreAccess,
  type WriteLifecycleCandidateNodeRow,
} from "../store/write-access.js";
import { memoryNodeVisible } from "../store/memory-visibility.js";
import { canonicalV2CommitHash } from "../store/write-commit-authority.js";
import { type AssociativeLinkTriggerOrigin } from "./associative-linking-types.js";
import { MemoryWriteRequest } from "./schemas.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { resolveTenantScope } from "./tenant.js";
import type {
  PreparedEdge,
  PreparedNode,
  PreparedWrite,
  WriteResult,
} from "./write-contract.js";
export type {
  PreparedEdge,
  PreparedNode,
  PreparedWrite,
  WriteResult,
} from "./write-contract.js";
import {
  resolveNodeAnchorKind,
  resolveNodeArchiveRelocationSurface,
  resolveNodeExecutionKind,
  resolveNodeSemanticForgettingSurface,
} from "./node-execution-surface.js";
import {
  adjudicateMemoryLifecycle,
  MEMORY_LIFECYCLE_RELATION_EVIDENCE_METADATA_KEY,
  memoryLifecycleRelationEdgeId,
  type AdjudicableMemoryEntry,
  type MemoryLifecycleRelationCandidateProducer,
} from "./memory-lifecycle-adjudicator.js";
import { assertAuthorityWriteReceipts } from "./authority-write-guard.js";
import {
  assertSingleScopeWrite,
  nodeEmbedText,
} from "./write-shared.js";
import { enqueuePostCommitWriteArtifacts } from "./write-post-commit.js";
import { prepareWriteBatch } from "./write-prepare-batch.js";
import {
  APPLIED_WRITE_MUTATION_DIGEST_VERSION,
  SELF_COMMIT_REFERENCE,
  buildCanonicalAppliedWriteMutation,
  buildWriteResult,
  canonicalAppliedMutationDigest,
  canonicalAppliedMutationJson,
  type CanonicalEdgeMutationV2,
  type CanonicalEdgeStateV2,
  type CanonicalNodeMutationV2,
  type CanonicalNodeStateV2,
  type CanonicalRequestedEdgeV2,
  type CanonicalRequestedNodeV2,
  type CanonicalRuleDefMutationV2,
  type CanonicalRuleDefStateV2,
} from "./write-serialization.js";

type PrepareWriteOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
};

export type ApplyPreparedWriteOptions = PrepareWriteOptions & {
  associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
  /** Optional optimistic fence supplied by a caller that projected from a known head. */
  expectedHeadRevision?: number;
};

type ApplyWriteOptions = ApplyPreparedWriteOptions & {
  write_access?: WriteStoreAccess;
};

type PlannedWriteNodeInsert = Omit<WriteNodeInsertArgs, "commitId">;

type PlannedWriteEdgeUpsert = Omit<WriteEdgeUpsertArgs, "commitId">;

type PlannedWriteRuleDefInsert = Omit<WriteRuleDefInsertArgs, "commitId">;

type AppliedNodePlan = {
  node: PreparedNode;
  insert: PlannedWriteNodeInsert;
  mutation: CanonicalNodeMutationV2 | null;
};

type AppliedEdgePlan = {
  edge: PreparedEdge;
  upsert: PlannedWriteEdgeUpsert;
  mutation: CanonicalEdgeMutationV2 | null;
  resolved: CanonicalEdgeStateV2;
};

type AppliedRuleDefPlan = {
  insert: PlannedWriteRuleDefInsert;
  mutation: CanonicalRuleDefMutationV2 | null;
};

function canonicalJsonFromPersisted(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Corrupt legacy rows still need an exact, hashable representation so an
    // authority repair cannot silently erase the bytes that were observed.
    return raw;
  }
}

function canonicalJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(stableStringify(value)) as Record<string, unknown>;
}

function requestedNodeState(insert: PlannedWriteNodeInsert): CanonicalRequestedNodeV2 {
  return {
    id: insert.id,
    scope: insert.scope,
    client_id: insert.clientId,
    type: insert.type,
    tier: insert.tier,
    title: insert.title,
    text_summary: insert.textSummary,
    slots_json: canonicalJsonFromPersisted(insert.slotsJson),
    raw_ref: insert.rawRef,
    evidence_ref: insert.evidenceRef,
    embedding_vector_json: canonicalJsonFromPersisted(insert.embeddingVector),
    embedding_model: insert.embeddingModel,
    memory_lane: insert.memoryLane,
    producer_agent_id: insert.producerAgentId,
    owner_agent_id: insert.ownerAgentId,
    owner_team_id: insert.ownerTeamId,
    embedding_status: insert.embeddingStatus,
    embedding_last_error: insert.embeddingLastError,
    salience: insert.salience,
    importance: insert.importance,
    confidence: insert.confidence,
    redaction_version: insert.redactionVersion,
  };
}

function requestedEdgeState(edge: PreparedEdge): CanonicalRequestedEdgeV2 {
  return {
    id: edge.id,
    scope: edge.scope,
    type: edge.type,
    src_id: edge.src_id,
    dst_id: edge.dst_id,
    weight: edge.weight ?? 0.5,
    confidence: edge.confidence ?? 0.5,
    decay_rate: edge.decay_rate ?? 0.01,
    metadata_json: canonicalJsonObject(edge.metadata ?? {}),
  };
}

function existingEdgeState(existing: WriteExistingEdgeState): CanonicalEdgeStateV2 {
  return {
    id: existing.id,
    scope: existing.scope,
    type: existing.type,
    src_id: existing.srcId,
    dst_id: existing.dstId,
    weight: existing.weight,
    confidence: existing.confidence,
    decay_rate: existing.decayRate,
    metadata_json: canonicalJsonObject(existing.metadataJson),
    commit_id: existing.commitId,
    created_at: existing.createdAt,
  };
}

function existingNodeState(existing: WriteExistingNodeState): CanonicalNodeStateV2 {
  return {
    id: existing.id,
    scope: existing.scope,
    client_id: existing.clientId,
    type: existing.type,
    tier: existing.tier,
    title: existing.title,
    text_summary: existing.textSummary,
    slots_json: canonicalJsonFromPersisted(existing.slotsJson),
    raw_ref: existing.rawRef,
    evidence_ref: existing.evidenceRef,
    embedding_vector_json: canonicalJsonFromPersisted(existing.embeddingVector),
    embedding_model: existing.embeddingModel,
    memory_lane: existing.memoryLane,
    producer_agent_id: existing.producerAgentId,
    owner_agent_id: existing.ownerAgentId,
    owner_team_id: existing.ownerTeamId,
    embedding_status: existing.embeddingStatus,
    embedding_last_error: existing.embeddingLastError,
    salience: existing.salience,
    importance: existing.importance,
    confidence: existing.confidence,
    redaction_version: existing.redactionVersion,
    commit_id: existing.commitId,
    created_at: existing.createdAt,
  };
}

function existingRuleDefState(existing: WriteExistingRuleDefState): CanonicalRuleDefStateV2 {
  return {
    rule_node_id: existing.ruleNodeId,
    scope: existing.scope,
    state: existing.state,
    if_json: existing.ifJson,
    then_json: existing.thenJson,
    exceptions_json: existing.exceptionsJson,
    rule_scope: existing.ruleScope,
    target_agent_id: existing.targetAgentId,
    target_team_id: existing.targetTeamId,
    positive_count: existing.positiveCount,
    negative_count: existing.negativeCount,
    commit_id: existing.commitId,
    created_at: existing.createdAt,
    updated_at: existing.updatedAt,
  };
}

function plannedRuleDefInsert(node: PreparedNode, appliedAt: string): PlannedWriteRuleDefInsert {
  const slots = (node.slots ?? {}) as Record<string, unknown>;
  const stateRaw = typeof slots.rule_state === "string"
    ? slots.rule_state.trim().toLowerCase()
    : typeof slots.state === "string"
      ? slots.state.trim().toLowerCase()
      : "";
  const state = stateRaw === "shadow" || stateRaw === "active" || stateRaw === "disabled"
    ? stateRaw
    : "draft";
  const ruleScopeRaw = typeof slots.rule_scope === "string" ? slots.rule_scope.trim().toLowerCase() : "";
  const ruleScope = ruleScopeRaw === "team" || ruleScopeRaw === "agent" ? ruleScopeRaw : "global";
  const targetAgentId = typeof slots.target_agent_id === "string" ? slots.target_agent_id.trim() : "";
  const targetTeamId = typeof slots.target_team_id === "string" ? slots.target_team_id.trim() : "";
  if (ruleScope === "agent" && !targetAgentId) {
    throw new Error("agent-scoped rule requires slots.target_agent_id");
  }
  if (ruleScope === "team" && !targetTeamId) {
    throw new Error("team-scoped rule requires slots.target_team_id");
  }
  return {
    scope: node.scope,
    ruleNodeId: node.id,
    state,
    ifJson: stableStringify(slots.if ?? {}),
    thenJson: stableStringify(slots.then ?? {}),
    exceptionsJson: stableStringify(slots.exceptions ?? []),
    ruleScope,
    targetAgentId: targetAgentId || null,
    targetTeamId: targetTeamId || null,
    createdAt: appliedAt,
    updatedAt: appliedAt,
  };
}

function requestedRuleDefState(insert: PlannedWriteRuleDefInsert): CanonicalRuleDefStateV2 {
  return {
    rule_node_id: insert.ruleNodeId,
    scope: insert.scope,
    state: insert.state,
    if_json: canonicalJsonFromPersisted(insert.ifJson),
    then_json: canonicalJsonFromPersisted(insert.thenJson),
    exceptions_json: canonicalJsonFromPersisted(insert.exceptionsJson),
    rule_scope: insert.ruleScope,
    target_agent_id: insert.targetAgentId,
    target_team_id: insert.targetTeamId,
    positive_count: 0,
    negative_count: 0,
    commit_id: SELF_COMMIT_REFERENCE,
    created_at: insert.createdAt,
    updated_at: insert.updatedAt,
  };
}

function assertExactAppliedState(
  label: "node" | "edge" | "rule_def",
  expected: unknown,
  actual: unknown,
): void {
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error(`memory_write_${label}_exact_read_after_mismatch`);
  }
}

function edgeContentEqual(left: CanonicalEdgeStateV2, right: CanonicalEdgeStateV2): boolean {
  return left.id === right.id
    && left.scope === right.scope
    && left.type === right.type
    && left.src_id === right.src_id
    && left.dst_id === right.dst_id
    && left.weight === right.weight
    && left.confidence === right.confidence
    && left.decay_rate === right.decay_rate
    && stableStringify(left.metadata_json) === stableStringify(right.metadata_json)
    && left.created_at === right.created_at;
}

function scopeHeadConflict(message: string, details: Record<string, unknown>): never {
  throw new HttpError(409, "scope_head_conflict", message, details);
}

function allowsExistingNodeContentReuse(node: PreparedNode): boolean {
  if (typeof node.client_id !== "string") return false;
  return node.client_id.startsWith("workflow_projection:") || node.client_id.startsWith("session:");
}

type LifecycleCandidateNode = {
  id: string;
  type: string;
  title?: string | null;
  text_summary?: string | null;
  slots: Record<string, unknown>;
  tier?: string | null;
  memory_lane?: "private" | "shared";
  owner_agent_id?: string | null;
  owner_team_id?: string | null;
  confidence?: number | null;
  salience?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function lifecycleCandidateFromPrepared(node: PreparedNode, observedAt: string): LifecycleCandidateNode {
  return {
    id: node.id,
    type: node.type,
    title: node.title ?? null,
    text_summary: node.text_summary ?? null,
    slots: node.slots ?? {},
    tier: node.tier ?? "hot",
    memory_lane: node.memory_lane,
    owner_agent_id: node.owner_agent_id ?? null,
    owner_team_id: node.owner_team_id ?? null,
    confidence: node.confidence ?? 0.5,
    salience: node.salience ?? 0.5,
    created_at: observedAt,
    updated_at: observedAt,
  };
}

function lifecycleCandidateFromStore(row: WriteLifecycleCandidateNodeRow): LifecycleCandidateNode {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    text_summary: row.text_summary,
    slots: row.slots,
    tier: row.tier,
    memory_lane: row.memory_lane,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    confidence: row.confidence,
    salience: row.salience,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function lifecycleStateFromCandidate(node: LifecycleCandidateNode): AdjudicableMemoryEntry["lifecycle_state"] {
  const semanticForgetting = resolveNodeSemanticForgettingSurface(node.slots);
  const archiveRelocation = resolveNodeArchiveRelocationSurface(node.slots);
  const lifecycle = typeof node.slots.lifecycle_state === "string" ? node.slots.lifecycle_state : null;
  const tier = node.tier ?? "";
  if (archiveRelocation.relocation_state === "cold_archive" || semanticForgetting.action === "archive" || tier === "archive") {
    return "archived";
  }
  if (semanticForgetting.action === "demote") return "demoted";
  if (semanticForgetting.action === "review") return "contested";
  if (lifecycle === "suppressed" || lifecycle === "disabled") return "suppressed";
  if (lifecycle === "contested") return "contested";
  if (lifecycle === "candidate" || Number(node.confidence ?? 0.5) < 0.6) return "candidate";
  if (tier === "cold" && node.slots.rehydration_default_mode) return "rehydration_candidate";
  return "active";
}

function lifecycleEntryFromCandidate(node: LifecycleCandidateNode, sourceIndex: number): AdjudicableMemoryEntry {
  const executionKind = resolveNodeExecutionKind(node.slots);
  const anchorKind = resolveNodeAnchorKind(node.slots);
  const confidence = Math.max(0, Math.min(1, Number(node.confidence ?? 0.5)));
  const lifecycleState = lifecycleStateFromCandidate(node);
  const domain: AdjudicableMemoryEntry["domain"] = executionKind || anchorKind ? "execution" : "general";
  const authority: AdjudicableMemoryEntry["authority"] =
    lifecycleState === "suppressed" || lifecycleState === "archived"
      ? "blocked"
      : lifecycleState === "active" && confidence >= 0.7
        ? "advisory"
        : "candidate";
  return {
    memory_id: node.id,
    title: node.title ?? null,
    summary: node.text_summary ?? node.title ?? node.id,
    domain,
    authority,
    confidence,
    salience: Math.max(0, Math.min(1, Number(node.salience ?? 0.5))),
    lifecycle_state: lifecycleState,
    scope_hint: domain === "execution"
      ? "execution memory; apply only within matching task or workflow scope"
      : "general cognitive memory; apply inside the current tenant and scope",
    observed_at: node.updated_at ?? node.created_at ?? null,
    source_index: sourceIndex,
  };
}

function candidateCanSeeTarget(source: LifecycleCandidateNode, target: LifecycleCandidateNode): boolean {
  if (target.memory_lane) {
    if (memoryNodeVisible({
      memory_lane: target.memory_lane,
      owner_agent_id: target.owner_agent_id ?? null,
      owner_team_id: target.owner_team_id ?? null,
    }, source.owner_agent_id ?? null, source.owner_team_id ?? null)) {
      return true;
    }
  }
  return !source.owner_agent_id && !source.owner_team_id && !target.owner_agent_id && !target.owner_team_id;
}

function edgeKey(edge: Pick<PreparedEdge, "scope" | "type" | "src_id" | "dst_id">): string {
  return `${edge.scope}\0${edge.type}\0${edge.src_id}\0${edge.dst_id}`;
}

export const MEMORY_LIFECYCLE_WRITE_HISTORY_LIMIT = 256;

export async function prepareMemoryWriteLifecycleRelations(
  writeAccess: WriteStoreAccess,
  prepared: PreparedWrite,
  producer?: MemoryLifecycleRelationCandidateProducer,
): Promise<void> {
  const batchIds = new Set(prepared.nodes.map((node) => node.id));
  if (batchIds.size === 0) return;
  const persistedBatchNodes = await writeAccess.nodeStatesByIds(
    prepared.scope,
    Array.from(batchIds),
  );
  const sourceIds = new Set(
    prepared.nodes
      .map((node) => node.id)
      .filter((nodeId) => !persistedBatchNodes.has(nodeId)),
  );
  if (sourceIds.size === 0) return;

  const existing = await writeAccess.lifecycleCandidateNodes(
    prepared.scope,
    MEMORY_LIFECYCLE_WRITE_HISTORY_LIMIT,
  );
  const byId = new Map<string, LifecycleCandidateNode>();
  for (const row of existing) {
    if (!batchIds.has(row.id)) byId.set(row.id, lifecycleCandidateFromStore(row));
  }
  const historicalTargetIds = new Set(byId.keys());
  const observedAt = new Date().toISOString();
  for (const node of prepared.nodes) {
    if (sourceIds.has(node.id)) {
      byId.set(node.id, lifecycleCandidateFromPrepared(node, observedAt));
    }
  }

  const candidates = Array.from(byId.values());
  const entries = candidates.map((node, index) => lifecycleEntryFromCandidate(node, index));
  const sourceMemoryIds = Array.from(sourceIds);
  const targetMemoryIds = Array.from(historicalTargetIds);
  const ruleCueHints = adjudicateMemoryLifecycle(entries, {
    source_memory_ids: sourceMemoryIds,
    target_memory_ids: targetMemoryIds,
  }).relations.filter((relation) => historicalTargetIds.has(relation.target_memory_id));
  if (!producer) return;

  const candidateRelations = (await producer({
    scope: prepared.scope,
    entries,
    source_memory_ids: sourceMemoryIds,
    deterministic_relations: ruleCueHints,
  })).filter((candidate) => (
    sourceIds.has(candidate.source_memory_id)
    && historicalTargetIds.has(candidate.target_memory_id)
  ));
  if (candidateRelations.length === 0) return;

  const adjudicated = adjudicateMemoryLifecycle(entries, {
    candidate_relations: candidateRelations,
    source_memory_ids: sourceMemoryIds,
    target_memory_ids: targetMemoryIds,
    infer_rule_cues: false,
  });
  if (adjudicated.relations.length === 0) return;

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const existingEdgeKeys = new Set(prepared.edges.map(edgeKey));
  for (const relation of adjudicated.relations) {
    if (!sourceIds.has(relation.source_memory_id)) continue;
    const source = candidateById.get(relation.source_memory_id);
    const target = candidateById.get(relation.target_memory_id);
    if (!source || !target || !candidateCanSeeTarget(source, target)) continue;
    const edge: PreparedEdge = {
      id: memoryLifecycleRelationEdgeId(prepared.scope, relation),
      scope: prepared.scope,
      type: relation.relation,
      src_id: relation.source_memory_id,
      dst_id: relation.target_memory_id,
      weight: 0.95,
      confidence: relation.confidence,
      decay_rate: 0,
      metadata: {
        [MEMORY_LIFECYCLE_RELATION_EVIDENCE_METADATA_KEY]: relation.evidence,
      },
    };
    const key = edgeKey(edge);
    if (existingEdgeKeys.has(key)) continue;
    existingEdgeKeys.add(key);
    prepared.edges.push(edge);
  }
}

export async function prepareMemoryWrite(
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: PrepareWriteOptions,
  embedder: EmbeddingProvider | null,
): Promise<PreparedWrite> {
  const parsed = MemoryWriteRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const actor = parsed.actor ?? "system";
  const {
    inputText,
    redactionMeta,
    defaultLane,
    defaultProducerAgentId,
    defaultOwnerAgentId,
    defaultOwnerTeamId,
    nodes,
    edges,
  } = prepareWriteBatch(parsed, tenancy, defaultTenantId, opts);

  assertSingleScopeWrite(scope, tenancy.scope, nodes, edges);

  // Embeddings are a derived artifact: we do NOT block /write.
  // If auto_embed is enabled and a provider is configured, we only compute an embed_text
  // that a worker can use to backfill embeddings asynchronously.
  const shouldAutoEmbed = (parsed.auto_embed ?? true) && !!embedder;
  if (shouldAutoEmbed) {
    for (const n of nodes) {
      if (n.embedding) continue;
      const t = nodeEmbedText(n, inputText);
      if (!t) continue;
      const norm = normalizeText(t, opts.maxTextLen);
      if (norm.length > 0) n.embed_text = norm;
    }
  }

  const inputSha = parsed.input_sha256 ?? sha256Hex(inputText!);

  return {
    scope,
    scope_public: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    actor,
    memory_lane_default: defaultLane,
    producer_agent_id: defaultProducerAgentId,
    owner_agent_id: defaultOwnerAgentId,
    owner_team_id: defaultOwnerTeamId,
    parent_commit_id: parsed.parent_commit_id ?? null,
    input_sha256: inputSha,
    model_version: parsed.model_version ?? null,
    prompt_version: parsed.prompt_version ?? null,
    redaction_meta: redactionMeta,
    auto_embed_effective: shouldAutoEmbed,
    embedding_provider_name: shouldAutoEmbed ? embedder?.name ?? null : null,
    embedding_provider_dim: shouldAutoEmbed ? embedder?.dim ?? null : null,
    force_reembed: parsed.force_reembed ?? false,
    nodes,
    edges,
  };
}

export async function applyMemoryWrite(
  prepared: PreparedWrite,
  opts: ApplyWriteOptions,
): Promise<WriteResult> {
  if (!opts.write_access) {
    throw new Error("applyMemoryWrite requires explicit write_access");
  }
  const writeAccess = opts.write_access;
  return applyPreparedMemoryWrite(writeAccess, prepared, opts);
}

export async function applyPreparedMemoryWrite(
  writeAccess: WriteStoreAccess,
  prepared: PreparedWrite,
  opts: ApplyPreparedWriteOptions,
): Promise<WriteResult> {
  assertWriteStoreAccessContract(writeAccess);
  const scope = prepared.scope;
  const actor = prepared.actor;
  const nodes = prepared.nodes;
  const edges = prepared.edges;

  // Each write batch must stay in a single scope because commit ids and URIs are scope-local.
  assertSingleScopeWrite(scope, prepared.scope_public, nodes, edges);
  const localNodeScope = new Map(nodes.map((n) => [n.id, n.scope]));
  const seenEdgeIdentities = new Map<string, number>();
  for (const [index, edge] of edges.entries()) {
    const identity = writeEdgeIdentityKey({
      type: edge.type,
      srcId: edge.src_id,
      dstId: edge.dst_id,
    });
    const firstIndex = seenEdgeIdentities.get(identity);
    if (firstIndex !== undefined) {
      badRequest("duplicate_edge_identity_in_batch", "write batch contains duplicate edge identity", {
        scope: prepared.scope_public,
        scope_key: scope,
        type: edge.type,
        src_id: edge.src_id,
        dst_id: edge.dst_id,
        first_index: firstIndex,
        duplicate_index: index,
      });
    }
    seenEdgeIdentities.set(identity, index);
  }

  const localNodeIds = Array.from(new Set(nodes.map((n) => n.id)));
  const existingNodeFingerprints = await writeAccess.nodeFingerprintsByIds(localNodeIds);
  for (const n of nodes) {
    const existing = existingNodeFingerprints.get(n.id);
    if (existing && existing.scope !== n.scope) {
      throw new Error(`node id collision across scopes: id=${n.id} existing.scope=${existing.scope} requested.scope=${n.scope}`);
    }
  }

  assertAuthorityWriteReceipts(nodes);

  const referencedExistingIds = Array.from(
    new Set(edges.flatMap((e) => [e.src_id, e.dst_id]).filter((id) => !localNodeScope.has(id))),
  );
  const existingScopes = await writeAccess.nodeScopesByIds(referencedExistingIds);

  for (const e of edges) {
    const srcScope = localNodeScope.get(e.src_id) ?? existingScopes.get(e.src_id);
    const dstScope = localNodeScope.get(e.dst_id) ?? existingScopes.get(e.dst_id);
    if (!srcScope) throw new Error(`edge src_id not found (any scope): ${e.src_id}`);
    if (!dstScope) throw new Error(`edge dst_id not found (any scope): ${e.dst_id}`);

    if (!opts.allowCrossScopeEdges && (srcScope !== e.scope || dstScope !== e.scope)) {
      throw new Error(
        `cross-scope edge not allowed: edge.scope=${e.scope} src.scope=${srcScope} dst.scope=${dstScope} (set ALLOW_CROSS_SCOPE_EDGES=true to override)`,
      );
    }
  }

  const plannedNodeInserts: Array<{ node: PreparedNode; insert: PlannedWriteNodeInsert }> = nodes.map((n) => {
    if (n.embedding) assertDim(n.embedding, 1536);

    const embedPlanned = prepared.auto_embed_effective && !n.embedding && !!n.embed_text;
    const embeddingStatus = n.embedding ? "ready" : embedPlanned ? "pending" : "failed";
    const embeddingLastError = n.embedding
      ? null
      : embedPlanned
        ? null
        : prepared.auto_embed_effective
          ? "no_embed_text"
          : "auto_embed_disabled_or_no_provider";
    const embeddingModel = n.embedding ? (n.embedding_model?.trim() ? n.embedding_model.trim() : "client") : null;

    return {
      node: n,
      insert: {
        id: n.id,
        scope: n.scope,
        clientId: n.client_id ?? null,
        type: n.type,
        tier: n.tier ?? "hot",
        title: n.title ?? null,
        textSummary: n.text_summary ?? null,
        slotsJson: JSON.stringify(n.slots ?? {}),
        rawRef: n.raw_ref ?? null,
        evidenceRef: n.evidence_ref ?? null,
        embeddingVector: n.embedding ? toVectorLiteral(n.embedding) : null,
        embeddingModel,
        memoryLane: n.memory_lane,
        producerAgentId: n.producer_agent_id ?? null,
        ownerAgentId: n.owner_agent_id ?? null,
        ownerTeamId: n.owner_team_id ?? null,
        embeddingStatus,
        embeddingLastError,
        salience: n.salience ?? 0.5,
        importance: n.importance ?? 0.5,
        confidence: n.confidence ?? 0.5,
        redactionVersion: 1,
      },
    };
  });

  for (const { node, insert } of plannedNodeInserts) {
    const existing = existingNodeFingerprints.get(node.id);
    if (!existing || existing.scope !== node.scope) continue;
    if (allowsExistingNodeContentReuse(node)) continue;
    const requestedFingerprint = writeNodeFingerprint(insert);
    if (existing.fingerprint !== requestedFingerprint) {
      badRequest("duplicate_node_id_conflict", "node id already exists with different persisted content", {
        node_id: node.id,
        client_id: node.client_id ?? null,
        scope: prepared.scope_public,
        scope_key: node.scope,
        type: node.type,
      });
    }
  }

  const existingNodeStates = await writeAccess.nodeStatesByIds(scope, localNodeIds);
  const ruleNodeIds = nodes.filter((node) => node.type === "rule").map((node) => node.id);
  const existingRuleDefStates = await writeAccess.ruleDefStatesByIds(scope, ruleNodeIds);
  const existingEdgeStates = await writeAccess.resolveEdgeStatesByIdentity({
    scope,
    identities: edges.map((edge) => ({
      type: edge.type,
      srcId: edge.src_id,
      dstId: edge.dst_id,
    })),
  });
  const authorityHead = await writeAccess.readScopeHead(scope);
  const currentRevision = authorityHead?.revision ?? 0;
  const currentCommitId = authorityHead?.commitId ?? null;

  if (opts.expectedHeadRevision !== undefined
    && (!Number.isSafeInteger(opts.expectedHeadRevision) || opts.expectedHeadRevision < 0)) {
    badRequest("invalid_expected_head_revision", "expectedHeadRevision must be a non-negative safe integer", {
      expected_revision: opts.expectedHeadRevision,
    });
  }
  if (opts.expectedHeadRevision !== undefined && opts.expectedHeadRevision !== currentRevision) {
    scopeHeadConflict("memory write was prepared from a stale scope head revision", {
      scope: prepared.scope_public,
      scope_key: scope,
      expected_revision: opts.expectedHeadRevision,
      current_revision: currentRevision,
      current_commit_id: currentCommitId,
    });
  }
  if (prepared.parent_commit_id !== null && prepared.parent_commit_id !== currentCommitId) {
    scopeHeadConflict("explicit parent_commit_id does not match the authoritative scope head", {
      scope: prepared.scope_public,
      scope_key: scope,
      requested_parent_commit_id: prepared.parent_commit_id,
      current_commit_id: currentCommitId,
      current_revision: currentRevision,
    });
  }

  const appliedAt = new Date().toISOString();
  const appliedNodePlans: AppliedNodePlan[] = plannedNodeInserts.map(({ node, insert }) => {
    const existing = existingNodeStates.get(node.id);
    if (existing) {
      return { node, insert, mutation: null };
    }
    const insertWithAuthorityTime: PlannedWriteNodeInsert = {
      ...insert,
      createdAt: appliedAt,
    };
    const requested = requestedNodeState(insertWithAuthorityTime);
    return {
      node,
      insert: insertWithAuthorityTime,
      mutation: {
        operation: "insert",
        requested,
        before: null,
        after: {
          ...requested,
          commit_id: SELF_COMMIT_REFERENCE,
          created_at: appliedAt,
        },
      },
    };
  });

  const appliedRuleDefPlans: AppliedRuleDefPlan[] = nodes
    .filter((node) => node.type === "rule")
    .map((node) => {
      const insert = plannedRuleDefInsert(node, appliedAt);
      const existingNode = existingNodeStates.get(node.id);
      const existingRuleDef = existingRuleDefStates.get(node.id);
      if (!existingNode && existingRuleDef) {
        throw new Error(`memory_write_rule_def_without_authoritative_node:${node.id}`);
      }
      if (existingRuleDef) return { insert, mutation: null };
      const requested = requestedRuleDefState(insert);
      return {
        insert,
        mutation: {
          operation: "insert",
          requested,
          before: null,
          after: requested,
        },
      };
    });

  const appliedEdgePlans: AppliedEdgePlan[] = edges.map((edge) => {
    const requested = requestedEdgeState(edge);
    const existingRaw = existingEdgeStates.get(writeEdgeIdentityKey({
      type: edge.type,
      srcId: edge.src_id,
      dstId: edge.dst_id,
    }));
    const before = existingRaw ? existingEdgeState(existingRaw) : null;
    const resolved: CanonicalEdgeStateV2 = before
      ? {
          ...before,
          weight: Math.max(before.weight, requested.weight),
          confidence: Math.max(before.confidence, requested.confidence),
          decay_rate: requested.decay_rate,
          metadata_json: requested.metadata_json,
          commit_id: SELF_COMMIT_REFERENCE,
        }
      : {
          ...requested,
          commit_id: SELF_COMMIT_REFERENCE,
          created_at: appliedAt,
        };
    const unchanged = before !== null && edgeContentEqual(before, {
      ...resolved,
      commit_id: before.commit_id,
    });
    const mutation: CanonicalEdgeMutationV2 | null = unchanged
      ? null
      : {
          operation: before ? "update" : "insert",
          requested,
          before,
          after: resolved,
        };
    return {
      edge,
      mutation,
      resolved: unchanged && before ? before : resolved,
      upsert: {
        id: resolved.id,
        scope: resolved.scope,
        type: resolved.type,
        srcId: resolved.src_id,
        dstId: resolved.dst_id,
        weight: resolved.weight,
        confidence: resolved.confidence,
        decayRate: resolved.decay_rate,
        metadataJson: resolved.metadata_json,
        createdAt: resolved.created_at,
      },
    };
  });

  const nodeMutations = appliedNodePlans
    .map((entry) => entry.mutation)
    .filter((entry): entry is CanonicalNodeMutationV2 => entry !== null);
  const edgeMutations = appliedEdgePlans
    .map((entry) => entry.mutation)
    .filter((entry): entry is CanonicalEdgeMutationV2 => entry !== null);
  const ruleDefMutations = appliedRuleDefPlans
    .map((entry) => entry.mutation)
    .filter((entry): entry is CanonicalRuleDefMutationV2 => entry !== null);
  const resolvedIds = {
    node_ids: new Map(nodes.map((node) => [node.id, node.id])),
    edge_ids: new Map(appliedEdgePlans.map(({ edge, resolved }) => [edge.id, resolved.id])),
  };

  // An exact replay that changes no authoritative node, edge, or rule-def state is a true
  // no-op. It returns the durable head receipt and does not manufacture a new
  // revision merely because the request was observed again.
  if (nodeMutations.length === 0 && edgeMutations.length === 0 && ruleDefMutations.length === 0) {
    if (!authorityHead) {
      badRequest("memory_write_no_applied_mutation", "memory write contains no authoritative state mutation", {
        scope: prepared.scope_public,
        scope_key: scope,
      });
    }
    return buildWriteResult(prepared, authorityHead.commitId, authorityHead.commitHash, resolvedIds);
  }

  const mutation = buildCanonicalAppliedWriteMutation(prepared, opts.piiRedaction, {
    applied_at: appliedAt,
    nodes: nodeMutations,
    edges: edgeMutations,
    rule_defs: ruleDefMutations,
  });
  const mutationDigest = canonicalAppliedMutationDigest(mutation);
  const diffJson = canonicalAppliedMutationJson(mutation);
  const parentCommitId = currentCommitId;
  const parentHash = authorityHead?.commitHash ?? "";
  const revision = currentRevision + 1;
  const legacyAnchorCommitId = authorityHead?.digestVersion === 1
    ? authorityHead.commitId
    : authorityHead?.legacyAnchorCommitId ?? null;
  const commitHash = canonicalV2CommitHash({
    digestVersion: APPLIED_WRITE_MUTATION_DIGEST_VERSION,
    revision,
    parentHash,
    inputSha256: prepared.input_sha256,
    mutationDigest,
    scope,
    actor,
    modelVersion: prepared.model_version,
    promptVersion: prepared.prompt_version,
  });

  // Insert commit.
  const commit_id = await writeAccess.insertCommit({
    scope,
    parentCommitId,
    inputSha256: prepared.input_sha256,
    diffJson,
    actor,
    modelVersion: prepared.model_version,
    promptVersion: prepared.prompt_version,
    commitHash,
    digestVersion: APPLIED_WRITE_MUTATION_DIGEST_VERSION,
    revision,
    mutationDigest,
    legacyAnchorCommitId,
    createdAt: appliedAt,
  });

  // Insert nodes.
  for (const { insert, mutation: nodeMutation } of appliedNodePlans) {
    if (!nodeMutation) continue;
    await writeAccess.insertNode({
      ...insert,
      commitId: commit_id,
    });
  }

  // Rule definitions are independently planned authority rows. This also
  // repairs a pre-existing rule node whose companion row is absent.
  for (const { insert, mutation: ruleDefMutation } of appliedRuleDefPlans) {
    if (!ruleDefMutation) continue;
    await writeAccess.insertRuleDef({
      ...insert,
      commitId: commit_id,
    });
  }

  // Upsert only applied edge mutations. Resolved values are used both for the
  // digest and the write, so MAX/replace behavior cannot diverge from evidence.
  for (const { mutation: edgeMutation, upsert } of appliedEdgePlans) {
    if (!edgeMutation) continue;
    await writeAccess.upsertEdge({
      ...upsert,
      commitId: commit_id,
    });
  }

  // Fail closed before advancing the head if SQLite did not persist the exact
  // canonical node/edge/rule-def rows bound into this commit's mutation digest.
  const persistedNodeStates = await writeAccess.nodeStatesByIds(
    scope,
    nodeMutations.map((entry) => entry.after.id),
  );
  for (const nodeMutation of nodeMutations) {
    const persisted = persistedNodeStates.get(nodeMutation.after.id);
    if (!persisted || persisted.commitId !== commit_id) {
      throw new Error("memory_write_node_exact_read_after_mismatch");
    }
    assertExactAppliedState("node", nodeMutation.after, {
      ...existingNodeState(persisted),
      commit_id: SELF_COMMIT_REFERENCE,
    });
  }

  const persistedEdgeStates = await writeAccess.resolveEdgeStatesByIdentity({
    scope,
    identities: edgeMutations.map((entry) => ({
      type: entry.after.type,
      srcId: entry.after.src_id,
      dstId: entry.after.dst_id,
    })),
  });
  for (const edgeMutation of edgeMutations) {
    const identity = writeEdgeIdentityKey({
      type: edgeMutation.after.type,
      srcId: edgeMutation.after.src_id,
      dstId: edgeMutation.after.dst_id,
    });
    const persisted = persistedEdgeStates.get(identity);
    if (!persisted || persisted.commitId !== commit_id) {
      throw new Error("memory_write_edge_exact_read_after_mismatch");
    }
    assertExactAppliedState("edge", edgeMutation.after, {
      ...existingEdgeState(persisted),
      commit_id: SELF_COMMIT_REFERENCE,
    });
  }

  const persistedRuleDefStates = await writeAccess.ruleDefStatesByIds(
    scope,
    ruleDefMutations.map((entry) => entry.after.rule_node_id),
  );
  for (const ruleDefMutation of ruleDefMutations) {
    const persisted = persistedRuleDefStates.get(ruleDefMutation.after.rule_node_id);
    if (!persisted || persisted.commitId !== commit_id) {
      throw new Error("memory_write_rule_def_exact_read_after_mismatch");
    }
    assertExactAppliedState("rule_def", ruleDefMutation.after, {
      ...existingRuleDefState(persisted),
      commit_id: SELF_COMMIT_REFERENCE,
    });
  }

  const cas = await writeAccess.compareAndSwapScopeHead({
    scope,
    commitId: commit_id,
    ...(opts.expectedHeadRevision !== undefined ? { expectedRevision: opts.expectedHeadRevision } : {}),
    expectedCommitId: currentCommitId,
  });
  if (cas.status === "conflict") {
    scopeHeadConflict("authoritative scope head changed before the write could commit", {
      scope: prepared.scope_public,
      scope_key: scope,
      expected_revision: opts.expectedHeadRevision ?? currentRevision,
      expected_commit_id: currentCommitId,
      current_revision: cas.current?.revision ?? 0,
      current_commit_id: cas.current?.commitId ?? null,
    });
  }

  const result: WriteResult = buildWriteResult(prepared, commit_id, commitHash, resolvedIds);
  await enqueuePostCommitWriteArtifacts(writeAccess, prepared, commit_id, result, {
    associativeLinkOrigin: opts.associativeLinkOrigin,
  });

  return result;
}
