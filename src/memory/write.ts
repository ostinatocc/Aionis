import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { assertDim, toVectorLiteral } from "../util/vector-literal.js";
import { normalizeText } from "../util/normalize.js";
import { badRequest } from "../util/http.js";
import {
  assertWriteStoreAccessContract,
  writeNodeFingerprint,
  type WriteNodeInsertArgs,
  type WriteStoreAccess,
  type WriteLifecycleCandidateNodeRow,
} from "../store/write-access.js";
import { memoryNodeVisible } from "../store/memory-visibility.js";
import { type AssociativeLinkTriggerOrigin } from "./associative-linking-types.js";
import { MemoryWriteRequest } from "./schemas.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { resolveTenantScope } from "./tenant.js";
import { distillWriteArtifacts, type WriteDistillationSummary } from "./write-distillation.js";
import {
  enrichPreparedNodeLifecycle,
  normalizeExecutionNativeSlots,
} from "./write-execution-native.js";
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
import {
  assertSingleScopeWrite,
  nodeEmbedText,
} from "./write-shared.js";
import { enqueuePostCommitWriteArtifacts } from "./write-post-commit.js";
import { prepareWriteBatch } from "./write-prepare-batch.js";
import { buildWriteDiff, buildWriteResult } from "./write-serialization.js";

export type WriteResult = {
  tenant_id?: string;
  scope?: string;
  commit_id: string;
  commit_uri?: string;
  commit_hash: string;
  nodes: Array<{ id: string; uri?: string; client_id?: string; type: string }>;
  edges: Array<{ id: string; uri?: string; type: string; src_id: string; dst_id: string }>;
  embedding_backfill?: { enqueued: true; pending_nodes: number };
  topic_cluster?:
    | {
        topic_commit_id: string | null;
        topic_commit_hash: string | null;
        processed_events: number;
        assigned: number;
        created_topics: number;
        promoted: number;
        strategy_requested: "online_knn";
        strategy_executed: "online_knn";
        strategy_note: string | null;
        quality: { cohesion: number; coverage: number; orphan_rate_after: number; merge_rate_30d: number };
      }
    | { enqueued: true };
  warnings?: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  distillation?: WriteDistillationSummary;
};

type PrepareWriteOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
};

export type ApplyPreparedWriteOptions = PrepareWriteOptions & {
  associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
  lifecycleRelationCandidateProducer?: MemoryLifecycleRelationCandidateProducer;
};

type ApplyWriteOptions = ApplyPreparedWriteOptions & {
  write_access?: WriteStoreAccess;
};

type PlannedWriteNodeInsert = Omit<WriteNodeInsertArgs, "commitId">;

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

async function appendLifecycleRelationEdges(
  writeAccess: WriteStoreAccess,
  prepared: PreparedWrite,
  producer?: MemoryLifecycleRelationCandidateProducer,
): Promise<void> {
  const sourceIds = new Set(prepared.nodes.map((node) => node.id));
  if (sourceIds.size === 0) return;

  const existing = await writeAccess.lifecycleCandidateNodes(prepared.scope, 2000);
  const byId = new Map<string, LifecycleCandidateNode>();
  for (const row of existing) byId.set(row.id, lifecycleCandidateFromStore(row));
  const observedAt = new Date().toISOString();
  for (const node of prepared.nodes) byId.set(node.id, lifecycleCandidateFromPrepared(node, observedAt));

  const candidates = Array.from(byId.values());
  const entries = candidates.map((node, index) => lifecycleEntryFromCandidate(node, index));
  const deterministicAdjudicated = adjudicateMemoryLifecycle(entries);
  const candidateRelations = producer
    ? await producer({
        scope: prepared.scope,
        entries,
        source_memory_ids: Array.from(sourceIds),
        deterministic_relations: deterministicAdjudicated.relations,
      })
    : [];
  const adjudicated = candidateRelations.length > 0
    ? adjudicateMemoryLifecycle(entries, { candidate_relations: candidateRelations })
    : deterministicAdjudicated;
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

export type PreparedNode = {
  id: string;
  client_id?: string;
  scope: string;
  type: string;
  tier?: "hot" | "warm" | "cold" | "archive";
  memory_lane: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  title?: string;
  text_summary?: string;
  slots: Record<string, unknown>;
  raw_ref?: string;
  evidence_ref?: string;
  embedding?: number[];
  embedding_model?: string;
  embed_text?: string;
  salience?: number;
  importance?: number;
  confidence?: number;
};

export type PreparedEdge = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight?: number;
  confidence?: number;
  decay_rate?: number;
  metadata?: Record<string, unknown>;
};

export type PreparedWrite = {
  tenant_id: string;
  scope_public: string;
  scope: string;
  actor: string;
  memory_lane_default: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  parent_commit_id: string | null;
  input_sha256: string;
  model_version: string | null;
  prompt_version: string | null;
  redaction_meta: Record<string, number>;
  auto_embed_effective: boolean;
  force_reembed: boolean;
  nodes: PreparedNode[];
  edges: PreparedEdge[];
  requested_trigger_topic_cluster?: boolean;
  requested_topic_cluster_async?: boolean;
  distillation?: WriteDistillationSummary;
};

export type EffectiveWritePolicy = {
  trigger_topic_cluster: boolean;
  topic_cluster_async: boolean;
};

export function computeEffectiveWritePolicy(
  prepared: PreparedWrite,
  defaults: { autoTopicClusterOnWrite: boolean; topicClusterAsyncOnWrite: boolean },
): EffectiveWritePolicy {
  const hasEvents = prepared.nodes.some((n) => n.type === "event");
  const trigger =
    (prepared.requested_trigger_topic_cluster ?? defaults.autoTopicClusterOnWrite) && hasEvents;
  const asyncMode = prepared.requested_topic_cluster_async ?? defaults.topicClusterAsyncOnWrite;
  return { trigger_topic_cluster: trigger, topic_cluster_async: asyncMode };
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
    seenNodeIds,
  } = prepareWriteBatch(parsed, tenancy, defaultTenantId, opts);

  let distillation: WriteDistillationSummary | undefined;
  if (parsed.distill?.enabled) {
    const distilled = distillWriteArtifacts({
      scope,
      input_text: inputText ?? null,
      nodes,
      config: parsed.distill,
      default_memory_lane: defaultLane,
      default_producer_agent_id: defaultProducerAgentId,
      default_owner_agent_id: defaultOwnerAgentId,
      default_owner_team_id: defaultOwnerTeamId,
    });
    for (const node of distilled.nodes) {
      node.slots = normalizeExecutionNativeSlots(node.type, node.slots ?? {}, node.title ?? null, node.text_summary ?? null, {
        raw_ref: node.raw_ref ?? null,
        evidence_ref: node.evidence_ref ?? null,
      });
      const enrichedNode = enrichPreparedNodeLifecycle(node);
      const priorId = seenNodeIds.get(node.id);
      if (priorId) {
        badRequest("distillation_node_id_collision", "distillation generated duplicate node id within write batch", {
          node_id: node.id,
          existing_index: priorId.index,
          generated_type: node.type,
        });
      }
      seenNodeIds.set(node.id, { index: nodes.length, scope: node.scope });
      nodes.push(enrichedNode);
    }
    edges.push(...distilled.edges);
    distillation = distilled.summary;
  }

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
    force_reembed: parsed.force_reembed ?? false,
    nodes,
    edges,
    requested_trigger_topic_cluster: parsed.trigger_topic_cluster,
    requested_topic_cluster_async: parsed.topic_cluster_async,
    distillation,
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

  const localNodeIds = Array.from(new Set(nodes.map((n) => n.id)));
  const existingNodeFingerprints = await writeAccess.nodeFingerprintsByIds(localNodeIds);
  for (const n of nodes) {
    const existing = existingNodeFingerprints.get(n.id);
    if (existing && existing.scope !== n.scope) {
      throw new Error(`node id collision across scopes: id=${n.id} existing.scope=${existing.scope} requested.scope=${n.scope}`);
    }
  }

  await appendLifecycleRelationEdges(writeAccess, prepared, opts.lifecycleRelationCandidateProducer);

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

  const diff = buildWriteDiff(prepared, opts.piiRedaction);

  // Compute commit chain.
  let parentHash = "";
  if (prepared.parent_commit_id) {
    const parent = await writeAccess.parentCommitHash(scope, prepared.parent_commit_id);
    if (!parent) throw new Error(`parent_commit_id not found in scope ${scope}`);
    parentHash = parent;
  }

  const diffSha = sha256Hex(stableStringify(diff));
  const commitHash = sha256Hex(
    stableStringify({
      parentHash,
      inputSha: prepared.input_sha256,
      diffSha,
      scope,
      actor,
      model_version: prepared.model_version,
      prompt_version: prepared.prompt_version,
    }),
  );

  // Insert commit.
  const commit_id = await writeAccess.insertCommit({
    scope,
    parentCommitId: prepared.parent_commit_id,
    inputSha256: prepared.input_sha256,
    diffJson: JSON.stringify(diff),
    actor,
    modelVersion: prepared.model_version,
    promptVersion: prepared.prompt_version,
    commitHash,
  });

  // Insert nodes.
  for (const { node: n, insert } of plannedNodeInserts) {
    await writeAccess.insertNode({
      ...insert,
      commitId: commit_id,
    });

    // If this is a rule node, also create a rule def row (draft by default).
    if (n.type === "rule") {
      const slots = (n.slots ?? {}) as Record<string, unknown>;
      const stateRaw = typeof slots["rule_state"] === "string"
        ? String(slots["rule_state"]).trim().toLowerCase()
        : typeof slots["state"] === "string"
          ? String(slots["state"]).trim().toLowerCase()
          : "";
      const state = stateRaw === "shadow" || stateRaw === "active" || stateRaw === "disabled" ? stateRaw : "draft";
      const if_json = slots["if"] ?? {};
      const then_json = slots["then"] ?? {};
      const exceptions_json = slots["exceptions"] ?? [];
      const scopeRaw = typeof slots["rule_scope"] === "string" ? String(slots["rule_scope"]).trim().toLowerCase() : "";
      const ruleScope = scopeRaw === "team" || scopeRaw === "agent" ? scopeRaw : "global";
      const targetAgentId = typeof slots["target_agent_id"] === "string" ? String(slots["target_agent_id"]).trim() : "";
      const targetTeamId = typeof slots["target_team_id"] === "string" ? String(slots["target_team_id"]).trim() : "";
      if (ruleScope === "agent" && !targetAgentId) {
        throw new Error("agent-scoped rule requires slots.target_agent_id");
      }
      if (ruleScope === "team" && !targetTeamId) {
        throw new Error("team-scoped rule requires slots.target_team_id");
      }
      await writeAccess.insertRuleDef({
        scope: n.scope,
        ruleNodeId: n.id,
        state,
        ifJson: JSON.stringify(if_json),
        thenJson: JSON.stringify(then_json),
        exceptionsJson: JSON.stringify(exceptions_json),
        ruleScope,
        targetAgentId: targetAgentId || null,
        targetTeamId: targetTeamId || null,
        commitId: commit_id,
      });
    }
  }

  // Insert edges (upsert to keep ingestion idempotent).
  for (const e of edges) {
    await writeAccess.upsertEdge({
      id: e.id,
      scope: e.scope,
      type: e.type,
      srcId: e.src_id,
      dstId: e.dst_id,
      weight: e.weight ?? 0.5,
      confidence: e.confidence ?? 0.5,
      decayRate: e.decay_rate ?? 0.01,
      metadataJson: e.metadata ?? {},
      commitId: commit_id,
    });
  }

  const result: WriteResult = buildWriteResult(prepared, commit_id, commitHash);
  await enqueuePostCommitWriteArtifacts(writeAccess, prepared, commit_id, result, {
    associativeLinkOrigin: opts.associativeLinkOrigin,
  });

  return result;
}
