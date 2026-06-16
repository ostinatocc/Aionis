import { performance } from "node:perf_hooks";
import { assertDim, toVectorLiteral } from "../util/vector-literal.js";
import {
  assertRecallStoreAccessContract,
  DEFAULT_RECALL_STAGE1_ALLOWED_TIERS,
  EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS,
  normalizeRecallAllowedTiers,
  recallStage1BoundedScanLimit,
  type RecallCandidate,
  type RecallEdgeRow,
  type RecallMemoryTier,
  type RecallNodeRow,
  type RecallStoreAccess,
} from "../store/recall-access.js";
import { MemoryRecallRequest, type MemoryRecallInput } from "./schemas.js";
import { buildContext } from "./context.js";
import { sha256Hex } from "../util/crypto.js";
import { badRequest } from "../util/http.js";
import { resolveTenantScope } from "./tenant.js";
import { resolveMemoryLayerPolicy } from "./layer-policy.js";
import {
  buildActionRecallPacket,
  type ActionRecallPacket,
} from "./recall-action-packet.js";
import {
  allowedLayersForPolicy,
  isDraftTopic,
  parseVectorText,
  resolveCompressionLayer,
} from "./recall-debug-layer-helpers.js";
import { prioritizeRankedForActionRecall, spreadActivation } from "./recall-ranking.js";
import {
  createRecallUriBuilders,
  toRecallEdgeDto,
  toRecallNodeDto,
} from "./recall-serialization.js";
import { buildRuntimeToolHintsFromAnchorNodes } from "./runtime-tool-hints.js";
import { buildAionisMemoryPacket } from "./product-output-assembler.js";

export type RecallAuth = {
  allow_debug_embeddings: boolean;
};

export type RecallTelemetry = {
  timing?: (stage: string, ms: number) => void;
};

export type MemoryRecallOptions = {
  stage1_exact_recovery_on_empty?: boolean;
  recall_access?: RecallStoreAccess;
  unsafe_allow_drop_trust_anchors?: boolean;
  unsafe_apply_layer_policy_to_retrieval?: boolean;
  internal_allow_l4_selection?: boolean;
};

type NodeRow = RecallNodeRow;
type EdgeRow = RecallEdgeRow;

type Stage1TierBudgetDebug = {
  cold_policy: "exact_recovery_on_empty";
  ann_allowed_tiers: RecallMemoryTier[];
  ann_scan_cap: number;
  exact_recovery_allowed_tiers: RecallMemoryTier[];
  exact_recovery_scan_cap: number | null;
  ann_seed_tier_counts: Record<RecallMemoryTier, number>;
  final_seed_tier_counts: Record<RecallMemoryTier, number>;
};

function isActionRecallEndpoint(endpoint: "recall" | "recall_text" | "planning_context" | "context_assemble"): boolean {
  return endpoint === "planning_context" || endpoint === "context_assemble";
}

function routeForRecallEndpoint(endpoint: "recall" | "recall_text" | "planning_context" | "context_assemble"): string {
  if (endpoint === "recall_text") return "/v1/memory/recall_text";
  if (endpoint === "planning_context") return "/v1/memory/planning/context";
  if (endpoint === "context_assemble") return "/v1/memory/context/assemble";
  return "/v1/memory/recall";
}

function countCandidateTiers(candidates: RecallCandidate[]): Record<RecallMemoryTier, number> {
  const counts: Record<RecallMemoryTier, number> = { hot: 0, warm: 0, cold: 0, archive: 0 };
  for (const candidate of candidates) {
    if (candidate.tier === "hot" || candidate.tier === "warm" || candidate.tier === "cold" || candidate.tier === "archive") {
      counts[candidate.tier] += 1;
    }
  }
  return counts;
}

function recallSourcesByMemoryId(candidates: RecallCandidate[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const candidate of candidates) {
    if (!candidate.sources || candidate.sources.length === 0) continue;
    out[candidate.id] = candidate.sources;
  }
  return out;
}

function compactProducerIds(nodes: Array<{ producer_agent_id?: string | null }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of nodes) {
    const id = typeof node.producer_agent_id === "string" ? node.producer_agent_id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, 24);
}

function enforceHardContract(parsed: MemoryRecallInput, auth: RecallAuth) {
  // A: Debug embeddings are a privileged, bounded debug channel. Never allow as a default.
  if (parsed.include_embeddings) {
    if (!parsed.return_debug) badRequest("debug_embeddings_requires_return_debug", "include_embeddings requires return_debug=true");
    if (!auth.allow_debug_embeddings) {
      badRequest("debug_embeddings_not_allowed", "include_embeddings requires X-Admin-Token (or localhost in dev)");
    }
    if (parsed.limit > 20) badRequest("debug_embeddings_limit_too_high", "debug embeddings mode requires limit <= 20");
  }
}

export async function memoryRecallParsed(
  parsed: MemoryRecallInput,
  defaultScope: string,
  defaultTenantId: string,
  auth: RecallAuth,
  telemetry?: RecallTelemetry,
  endpoint: "recall" | "recall_text" | "planning_context" | "context_assemble" = "recall",
  options?: MemoryRecallOptions,
) {
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const { buildNodeUri, buildEdgeUri, buildCommitUri } = createRecallUriBuilders({
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
  });
  const consumerAgentId = parsed.consumer_agent_id?.trim() || null;
  const consumerTeamId = parsed.consumer_team_id?.trim() || null;
  const layerPolicy = resolveMemoryLayerPolicy(endpoint, parsed.memory_layer_preference ?? null, {
    unsafe_allow_drop_trust_anchors: options?.unsafe_allow_drop_trust_anchors === true,
    internal_allow_l4_selection: options?.internal_allow_l4_selection === true,
  });
  const stage1ExactRecoveryOnEmpty = options?.stage1_exact_recovery_on_empty ?? true;
  assertDim(parsed.query_embedding, 1536);

  enforceHardContract(parsed, auth);

  async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      const ms = performance.now() - t0;
      telemetry?.timing?.(stage, ms);
    }
  }

  const oversample = Math.max(parsed.limit, Math.min(1000, parsed.limit * 5));
  const recallAccess = options?.recall_access ?? null;
  if (!recallAccess) {
    throw new Error("memoryRecallParsed requires explicit recall_access");
  }
  assertRecallStoreAccessContract(recallAccess);

  const annAllowedTiers = normalizeRecallAllowedTiers(DEFAULT_RECALL_STAGE1_ALLOWED_TIERS);
  const exactRecoveryAllowedTiers = normalizeRecallAllowedTiers(EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS);
  const annScanCap = recallStage1BoundedScanLimit({ oversample, limit: parsed.limit });

  // Stage 1 (primary): ANN kNN candidate fetch (fast path).
  const stage1Ann = await timed("stage1_candidates_ann", () =>
    recallAccess.stage1CandidatesAnn({
      queryEmbedding: parsed.query_embedding,
      scope,
      oversample,
      limit: parsed.limit,
      allowedTiers: annAllowedTiers,
      scanLimit: annScanCap,
      consumerAgentId,
      consumerTeamId,
    }),
  );

  let seeds = stage1Ann;
  const stage1AnnSeedCount = seeds.length;
  const stage1ExactRecoveryAttempted = stage1AnnSeedCount === 0 && stage1ExactRecoveryOnEmpty;
  let stage1Mode: "ann" | "exact_recovery" = "ann";

  if (stage1ExactRecoveryAttempted) {
    const stage1Exact = await timed("stage1_candidates_exact_recovery", () =>
      recallAccess.stage1CandidatesExactRecovery({
        queryEmbedding: parsed.query_embedding,
        scope,
        oversample,
        limit: parsed.limit,
        allowedTiers: exactRecoveryAllowedTiers,
        scanLimit: null,
        consumerAgentId,
        consumerTeamId,
      }),
    );
    seeds = stage1Exact;
    stage1Mode = "exact_recovery";
  }

  const outSeeds = seeds.map((s) => {
    const uri = buildNodeUri(s.id, s.type);
    if (!uri) return s;
    return { ...s, uri };
  });

  const seedIds = seeds.map((s) => s.id);
  const stage1TierBudgetDebug: Stage1TierBudgetDebug = {
    cold_policy: "exact_recovery_on_empty",
    ann_allowed_tiers: annAllowedTiers,
    ann_scan_cap: annScanCap,
    exact_recovery_allowed_tiers: exactRecoveryAllowedTiers,
    exact_recovery_scan_cap: null,
    ann_seed_tier_counts: countCandidateTiers(stage1Ann),
    final_seed_tier_counts: countCandidateTiers(seeds),
  };

  if (seedIds.length === 0) {
    const aionisMemoryPacket = buildAionisMemoryPacket({
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      actor: {
        consumer_agent_id: consumerAgentId,
        consumer_team_id: consumerTeamId,
        producer_agent_ids: [],
      },
      query: {
        source: endpoint === "recall" ? "embedding" : "text",
        embedding_dims: parsed.query_embedding.length,
      },
      nodes: [],
      context_items: [],
      ranked: [],
      recall_sources_by_memory_id: recallSourcesByMemoryId(seeds),
      source_map: {
        routes_used: [routeForRecallEndpoint(endpoint)],
      },
    });
    return {
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
      seeds: outSeeds,
      subgraph: { nodes: [], edges: [] },
      ranked: [],
      context: {
        text: "",
        items: [],
        citations: [],
        selection_policy: layerPolicy,
        selection_stats: {
          retrieved_memory_layers: [],
          retrieved_unlayered_count: 0,
          selected_memory_layers: [],
          selected_unlayered_count: 0,
          retrieval_filtered_by_layer_policy_count: 0,
          retrieval_filtered_by_layer: {},
          filtered_by_layer_policy_count: 0,
          filtered_by_layer: {},
        },
      },
      runtime_tool_hints: [],
      action_recall_packet: {
        packet_version: "action_recall_v1",
        recommended_workflows: [],
        candidate_workflows: [],
        candidate_patterns: [],
        trusted_patterns: [],
        contested_patterns: [],
        rehydration_candidates: [],
        supporting_knowledge: [],
      },
      aionis_memory_packet: aionisMemoryPacket,
      ...(parsed.return_debug
        ? {
            debug: {
              neighborhood_counts: { nodes: 0, edges: 0 },
              embeddings: undefined,
              stage1: {
                mode: stage1Mode,
                ann_seed_count: stage1AnnSeedCount,
                final_seed_count: 0,
                tier_budget: stage1TierBudgetDebug,
                exact_recovery_enabled: stage1ExactRecoveryOnEmpty,
                exact_recovery_attempted: stage1ExactRecoveryAttempted,
              },
            },
          }
        : {}),
    };
  }

  // Stage 2: fetch 1-2 hop neighborhood edges/nodes.
  // Contract/perf rules (B/C):
  // - never select/return embedding here
  // - explicit column list only
  // Hard bound on how much neighborhood data we even consider.
  // Note: request max_edges is already hard-capped to 100 by schema. We still budget stage-2 fetch work.
  const EDGE_FETCH_BUDGET = Math.min(1000, Math.max(parsed.max_edges * 5, parsed.max_edges));
  const HOP1_BUDGET = Math.max(50, Math.min(500, EDGE_FETCH_BUDGET));
  const HOP2_BUDGET = Math.max(50, Math.min(500, EDGE_FETCH_BUDGET));
  const minEdgeWeight = Math.max(0, Math.min(1, parsed.min_edge_weight ?? 0));
  const minEdgeConf = Math.max(0, Math.min(1, parsed.min_edge_confidence ?? 0));

  const neighborhoodEdges = await timed("stage2_edges", () =>
    recallAccess.stage2Edges({
      seedIds,
      scope,
      neighborhoodHops: parsed.neighborhood_hops as 1 | 2,
      minEdgeWeight,
      minEdgeConfidence: minEdgeConf,
      hop1Budget: HOP1_BUDGET,
      hop2Budget: HOP2_BUDGET,
      edgeFetchBudget: EDGE_FETCH_BUDGET,
    }),
  );

  // Derive node ids directly from the edge rows to avoid repeating the neighborhood CTE in a second query.
  const nodeScore = new Map<string, number>();
  const nodeIdSet = new Set<string>(seedIds);
  for (const e of neighborhoodEdges) {
    nodeIdSet.add(e.src_id);
    nodeIdSet.add(e.dst_id);
    const s = e.weight * e.confidence;
    nodeScore.set(e.src_id, (nodeScore.get(e.src_id) ?? 0) + s);
    nodeScore.set(e.dst_id, (nodeScore.get(e.dst_id) ?? 0) + s);
  }

  // Budget node fetch work too; keep seeds, then highest-incident nodes.
  const NODE_FETCH_BUDGET = Math.min(800, Math.max(parsed.max_nodes * 4, parsed.max_nodes));
  let nodeIds = Array.from(nodeIdSet);
  if (nodeIds.length > NODE_FETCH_BUDGET) {
    const scored = nodeIds
      .filter((id) => !seedIds.includes(id))
      .map((id) => ({ id, s: nodeScore.get(id) ?? 0 }))
      .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
      .map((x) => x.id);
    nodeIds = seedIds.concat(scored.slice(0, Math.max(0, NODE_FETCH_BUDGET - seedIds.length)));
  }

  const wantSlots = parsed.include_slots || parsed.include_slots_preview;
  const needInternalSlots = true;
  const neighborhoodNodes = await timed("stage2_nodes", () =>
    recallAccess.stage2Nodes({
      scope,
      nodeIds,
      consumerAgentId,
      consumerTeamId,
      includeSlots: wantSlots || needInternalSlots,
    }),
  );

  const nodeMapAll = new Map<string, NodeRow>();
  for (const n of neighborhoodNodes) nodeMapAll.set(n.id, n);
  // Filter edges to only those with both endpoints present in our node fetch budget.
  let filteredSeeds = seeds;
  let filteredSeedIds = seedIds;
  let filteredNodeMapAll = nodeMapAll;
  let edgesAll: EdgeRow[] = neighborhoodEdges.filter((e) => nodeMapAll.has(e.src_id) && nodeMapAll.has(e.dst_id));
  let retrievalFilteredCount = 0;
  const retrievalFilteredByLayer = new Map<string, number>();
  const retrievalAllowedLayers =
    options?.unsafe_apply_layer_policy_to_retrieval === true ? allowedLayersForPolicy(layerPolicy) : null;
  if (retrievalAllowedLayers) {
    for (const node of nodeMapAll.values()) {
      const layer = resolveCompressionLayer(node);
      if (!layer || !retrievalAllowedLayers.has(layer)) {
        const key = layer ?? "unknown";
        retrievalFilteredCount += 1;
        retrievalFilteredByLayer.set(key, (retrievalFilteredByLayer.get(key) ?? 0) + 1);
      }
    }
    filteredNodeMapAll = new Map(
      Array.from(nodeMapAll.entries()).filter(([, node]) => {
        const layer = resolveCompressionLayer(node);
        return !!layer && retrievalAllowedLayers.has(layer);
      }),
    );
    filteredSeeds = seeds.filter((seed) => filteredNodeMapAll.has(seed.id));
    filteredSeedIds = filteredSeeds.map((seed) => seed.id);
    edgesAll = edgesAll.filter((e) => filteredNodeMapAll.has(e.src_id) && filteredNodeMapAll.has(e.dst_id));
  }

  // Scoring excludes draft topics (they shouldn't influence activation/ranking),
  // but draft topics may still appear in the returned subgraph for explainability.
  const draftTopicIds = new Set(Array.from(filteredNodeMapAll.values()).filter(isDraftTopic).map((n) => n.id));
  const notReadyIds = new Set(Array.from(filteredNodeMapAll.values()).filter((n) => n.embedding_status !== "ready").map((n) => n.id));
  const nodeMapForScoring = new Map(filteredNodeMapAll);
  for (const id of draftTopicIds) nodeMapForScoring.delete(id);
  for (const id of notReadyIds) nodeMapForScoring.delete(id);
  const edgesForScoring = edgesAll.filter((e) => !draftTopicIds.has(e.src_id) && !draftTopicIds.has(e.dst_id));
  const edgesForScoringReady = edgesForScoring.filter((e) => !notReadyIds.has(e.src_id) && !notReadyIds.has(e.dst_id));

  // Score via spreading activation.
  const rankedAllBase = spreadActivation(filteredSeeds, nodeMapForScoring, edgesForScoringReady, parsed.neighborhood_hops);
  const rankedAll = isActionRecallEndpoint(endpoint)
    ? prioritizeRankedForActionRecall(rankedAllBase, filteredNodeMapAll)
    : rankedAllBase;
  const ranked = rankedAll.slice(0, parsed.ranked_limit).map((r) => {
    const node = nodeMapAll.get(r.id);
    if (!node) return r;
    const uri = buildNodeUri(node.id, node.type);
    if (!uri) return r;
    return { ...r, uri };
  });

  // Build the returned subgraph under hard caps (contract):
  // - nodes: max_nodes (always)
  // - edges: max_edges (always; schema already caps to 100)
  // Explainability: draft topics never affect scoring, but we may swap a few in so edges aren't "mysteriously missing".
  const seedSet = new Set(filteredSeedIds);
  const coreIds: string[] = [];
  const prioritizedCoreIds = isActionRecallEndpoint(endpoint)
    ? Array.from(new Set(rankedAll.map((entry) => entry.id).concat(filteredSeedIds)))
    : filteredSeedIds;
  for (const id of prioritizedCoreIds) {
    if (coreIds.length >= parsed.max_nodes) break;
    const n = filteredNodeMapAll.get(id);
    if (!n || n.embedding_status !== "ready") continue;
    if (!coreIds.includes(id)) coreIds.push(id);
  }
  for (const r of rankedAll) {
    if (coreIds.length >= parsed.max_nodes) break;
    const n = filteredNodeMapAll.get(r.id);
    if (!n || n.embedding_status !== "ready") continue;
    if (!coreIds.includes(r.id)) coreIds.push(r.id);
  }

  // Score connected draft topics (only via strong edge types) and swap them in for the lowest-priority non-seed nodes.
  const draftScore = new Map<string, number>();
  const coreSet = new Set(coreIds);
  for (const e of edgesAll) {
    if (e.type !== "part_of" && e.type !== "derived_from") continue;
    const aIn = coreSet.has(e.src_id);
    const bIn = coreSet.has(e.dst_id);
    if (!aIn && !bIn) continue;
    const other = aIn ? e.dst_id : e.src_id;
    if (!draftTopicIds.has(other)) continue;
    draftScore.set(other, (draftScore.get(other) ?? 0) + e.weight * e.confidence);
  }

  const DRAFT_BUDGET = Math.min(10, Math.max(0, Math.floor(parsed.max_nodes / 5)));
  const removable: string[] = [];
  for (let i = coreIds.length - 1; i >= 0; i--) {
    const id = coreIds[i];
    if (!seedSet.has(id)) removable.push(id);
  }

  const draftCandidates = Array.from(draftScore.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => {
      if (coreSet.has(id)) return false;
      const n = filteredNodeMapAll.get(id);
      return !!n && n.embedding_status === "ready";
    });

  // Prefer appending draft topics if we have room; otherwise replace the lowest-priority non-seed nodes.
  let draftsToAdd: string[] = [];
  let outIdsOrdered: string[] = [];
  if (coreIds.length < parsed.max_nodes) {
    const room = parsed.max_nodes - coreIds.length;
    draftsToAdd = draftCandidates.slice(0, Math.min(DRAFT_BUDGET, room));
    outIdsOrdered = coreIds.concat(draftsToAdd);
  } else {
    const maxDrafts = Math.min(DRAFT_BUDGET, removable.length);
    draftsToAdd = draftCandidates.slice(0, maxDrafts);
    const toRemove = new Set(removable.slice(0, draftsToAdd.length));
    outIdsOrdered = coreIds.filter((id) => !toRemove.has(id)).concat(draftsToAdd);
  }
  const outIdSet = new Set(outIdsOrdered);

  const outNodeRows = outIdsOrdered.map((id) => filteredNodeMapAll.get(id)).filter(Boolean) as NodeRow[];
  const outEdgeRows = edgesAll
    .filter((e) => outIdSet.has(e.src_id) && outIdSet.has(e.dst_id))
    .sort((a, b) => (b.weight * b.confidence) - (a.weight * a.confidence))
    .slice(0, parsed.max_edges);
  const runtimeToolHints = buildRuntimeToolHintsFromAnchorNodes({
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    nodes: outNodeRows,
  });

  // Fetch rule defs for context building.
  const ruleIds = outNodeRows.filter((n) => n.type === "rule").map((n) => n.id);
  const ruleDefMap = new Map<string, any>();
  if (ruleIds.length) {
    const rr = await timed("rule_defs", () => recallAccess.ruleDefs(scope, ruleIds));
    for (const row of rr) ruleDefMap.set(row.rule_node_id, row);
  }

  const { text: context_text, items: context_items, citations, compaction: context_compaction, selection_stats } = buildContext(
    rankedAll,
    filteredNodeMapAll,
    ruleDefMap,
    {
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      context_token_budget: parsed.context_token_budget,
      context_char_budget: parsed.context_char_budget,
      context_compaction_profile: parsed.context_compaction_profile,
      layer_policy: layerPolicy,
      internal_allow_l4_preview:
        options?.internal_allow_l4_selection === true && (endpoint === "planning_context" || endpoint === "context_assemble"),
    },
  );
  const retrievalFilteredByLayerOut = Object.fromEntries(
    Array.from(retrievalFilteredByLayer.entries()).sort((a, b) => a[0].localeCompare(b[0])),
  );
  const selectionStatsOut = {
    ...selection_stats,
    retrieval_filtered_by_layer_policy_count: retrievalFilteredCount,
    retrieval_filtered_by_layer: retrievalFilteredByLayerOut,
  };
  const actionRecallPacket = buildActionRecallPacket({
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    nodes: outNodeRows,
    runtimeToolHints: runtimeToolHints as unknown as Array<Record<string, unknown>>,
    contextItems: context_items as unknown as Array<Record<string, unknown>>,
  });
  const aionisMemoryPacket = buildAionisMemoryPacket({
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: {
      consumer_agent_id: consumerAgentId,
      consumer_team_id: consumerTeamId,
      producer_agent_ids: compactProducerIds(outNodeRows),
    },
    query: {
      source: endpoint === "recall" ? "embedding" : "text",
      embedding_dims: parsed.query_embedding.length,
    },
    nodes: outNodeRows,
    context_items,
    ranked,
    recall_sources_by_memory_id: recallSourcesByMemoryId(seeds),
    lifecycle_edges: edgesAll,
    source_map: {
      routes_used: [routeForRecallEndpoint(endpoint)],
    },
  });

  // DTO serialization (B): stable and compact by default.
  const outNodes = outNodeRows.map((node) => toRecallNodeDto(node, parsed, buildNodeUri));
  const outEdges = outEdgeRows.map((edge) =>
    toRecallEdgeDto(edge, parsed.include_meta, buildEdgeUri, buildCommitUri),
  );

  // Debug-only: include a *bounded* embedding preview for seed nodes.
  // Hard constraints:
  // - max 5 nodes
  // - preview first 16 dims only
  // - include sha256 of full vector string for integrity checks
  let embedding_debug: any = undefined;
  if (parsed.return_debug && parsed.include_embeddings) {
    if (!recallAccess.capabilities.debug_embeddings) {
      badRequest(
        "debug_embeddings_backend_unsupported",
        "include_embeddings is not supported by current backend capability (debug_embeddings=false)",
        {
          capability: "debug_embeddings",
          degraded_mode: "feature_disabled",
        },
      );
    }
    const MAX_EMBED_NODES = 5;
    const PREVIEW_DIMS = 16;
    const ids = seedIds.slice(0, MAX_EMBED_NODES);
    const er = await timed("debug_embeddings", () => recallAccess.debugEmbeddings(scope, ids));
    embedding_debug = er.map((row) => {
      let parsedVec: { dims: number; preview: number[] };
      try {
        parsedVec = parseVectorText(row.embedding_text, PREVIEW_DIMS);
      } catch (e: any) {
        badRequest("debug_embeddings_parse_error", "failed to parse embedding vector text", {
          node_id: row.id,
          message: String(e?.message ?? e),
        });
      }
      return {
        node_id: row.id,
        dims: parsedVec.dims,
        sha256: sha256Hex(row.embedding_text),
        preview: parsedVec.preview,
      };
    });

    const MAX_DEBUG_BYTES = 64 * 1024;
    const debugBytes = Buffer.byteLength(JSON.stringify(embedding_debug), "utf8");
    if (debugBytes > MAX_DEBUG_BYTES) {
      badRequest("debug_embeddings_too_large", `debug embeddings exceed max_debug_bytes (${MAX_DEBUG_BYTES})`);
    }
  }

  if (recallAccess.capabilities.audit_insert) {
    await timed("audit_insert", async () => {
      try {
        await recallAccess.insertRecallAudit({
          scope,
          endpoint,
          consumerAgentId,
          consumerTeamId,
          querySha256: sha256Hex(toVectorLiteral(parsed.query_embedding)),
          seedCount: seeds.length,
          nodeCount: outNodes.length,
          edgeCount: outEdges.length,
        });
      } catch {
        // Best-effort audit; do not block recall path.
      }
    });
  }

  return {
    scope: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    seeds: outSeeds,
    subgraph: { nodes: outNodes, edges: outEdges },
    ranked,
      context: {
        text: context_text,
        items: context_items,
        citations,
        selection_policy: layerPolicy,
        selection_stats: selectionStatsOut,
      },
      runtime_tool_hints: runtimeToolHints,
      action_recall_packet: actionRecallPacket,
      aionis_memory_packet: aionisMemoryPacket,
    ...(parsed.return_debug
      ? {
          debug: {
            neighborhood_counts: { nodes: nodeMapAll.size, edges: edgesAll.length },
            embeddings: embedding_debug,
            context_compaction,
            stage1: {
              mode: stage1Mode,
              ann_seed_count: stage1AnnSeedCount,
              final_seed_count: seeds.length,
              tier_budget: stage1TierBudgetDebug,
              exact_recovery_enabled: stage1ExactRecoveryOnEmpty,
              exact_recovery_attempted: stage1ExactRecoveryAttempted,
            },
          },
        }
      : {}),
  };
}

export async function memoryRecall(
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  auth: RecallAuth,
) {
  const parsed = MemoryRecallRequest.parse(body);
  return memoryRecallParsed(parsed, defaultScope, defaultTenantId, auth);
}
