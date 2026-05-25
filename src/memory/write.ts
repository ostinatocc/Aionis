import stableStringify from "fast-json-stable-stringify";
import type pg from "pg";
import { sha256Hex } from "../util/crypto.js";
import { assertDim, toVectorLiteral } from "../util/pgvector.js";
import { normalizeText } from "../util/normalize.js";
import { badRequest } from "../util/http.js";
import { type CapabilityFailureMode } from "../capability-contract.js";
import {
  assertWriteStoreAccessContract,
  createPostgresWriteStoreAccess,
  writeNodeFingerprint,
  type WriteNodeInsertArgs,
  type WriteStoreAccess,
} from "../store/write-access.js";
import { type AssociativeLinkTriggerOrigin } from "./associative-linking-types.js";
import { MemoryWriteRequest } from "./schemas.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { resolveTenantScope, toTenantScopeKey } from "./tenant.js";
import { distillWriteArtifacts, type WriteDistillationSummary } from "./write-distillation.js";
import {
  enrichPreparedNodeLifecycle,
  normalizeExecutionNativeSlots,
} from "./write-execution-native.js";
import {
  assertSingleScopeWrite,
  nodeEmbedText,
} from "./write-shared.js";
import { enqueuePostCommitWriteArtifacts } from "./write-post-commit.js";
import { prepareWriteBatch } from "./write-prepare-batch.js";
import { buildWriteDiff, buildWriteResult } from "./write-serialization.js";
import { applyShadowDualWrite } from "./write-shadow-dual.js";

export type WriteResult = {
  tenant_id?: string;
  scope?: string;
  commit_id: string;
  commit_uri?: string;
  commit_hash: string;
  nodes: Array<{ id: string; uri?: string; client_id?: string; type: string }>;
  edges: Array<{ id: string; uri?: string; type: string; src_id: string; dst_id: string }>;
  embedding_backfill?: { enqueued: true; pending_nodes: number };
  shadow_dual_write?: {
    enabled: boolean;
    strict: boolean;
    mirrored: boolean;
    copied?: { commits: number; nodes: number; edges: number; outbox: number };
    capability?: "shadow_mirror_v2";
    failure_mode?: CapabilityFailureMode;
    degraded_mode?: "capability_unsupported" | "mirror_failed";
    fallback_applied?: boolean;
    error?: string;
  };
  topic_cluster?:
    | {
        topic_commit_id: string | null;
        topic_commit_hash: string | null;
        processed_events: number;
        assigned: number;
        created_topics: number;
        promoted: number;
        strategy_requested: "online_knn" | "offline_hdbscan";
        strategy_executed: "online_knn" | "offline_hdbscan";
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
  shadowDualWriteEnabled: boolean;
  shadowDualWriteStrict: boolean;
  associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
};

type ApplyWriteOptions = ApplyPreparedWriteOptions & {
  write_access?: WriteStoreAccess;
};

type PlannedWriteNodeInsert = Omit<WriteNodeInsertArgs, "commitId">;

function allowsExistingNodeContentReuse(node: PreparedNode): boolean {
  if (typeof node.client_id !== "string") return false;
  return node.client_id.startsWith("workflow_projection:") || node.client_id.startsWith("session:");
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
      fallback_memory_lane: defaultLane,
      fallback_producer_agent_id: defaultProducerAgentId,
      fallback_owner_agent_id: defaultOwnerAgentId,
      fallback_owner_team_id: defaultOwnerTeamId,
    });
    for (const node of distilled.nodes) {
      node.slots = normalizeExecutionNativeSlots(node.type, node.slots ?? {}, node.title ?? null, node.text_summary ?? null);
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
  client: pg.PoolClient,
  prepared: PreparedWrite,
  opts: ApplyWriteOptions,
): Promise<WriteResult> {
  const writeAccess = opts.write_access ?? createPostgresWriteStoreAccess(client);
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
      commitId: commit_id,
    });
  }

  const result: WriteResult = buildWriteResult(prepared, commit_id, commitHash);
  await enqueuePostCommitWriteArtifacts(writeAccess, prepared, commit_id, result, {
    associativeLinkOrigin: opts.associativeLinkOrigin,
  });
  await applyShadowDualWrite(writeAccess, scope, commit_id, result, {
    enabled: opts.shadowDualWriteEnabled,
    strict: opts.shadowDualWriteStrict,
  });

  return result;
}
