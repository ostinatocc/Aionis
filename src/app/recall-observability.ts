import type { RecallCandidate, RecallCandidateSourceKind } from "../store/recall-access.js";

const RECALL_SOURCE_KINDS: readonly RecallCandidateSourceKind[] = [
  "semantic",
  "lexical",
  "structured",
  "execution_native",
  "graph",
  "recent",
  "exact_recovery",
  "ann",
];

function normalizeAionisUri(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s.startsWith("aionis://")) return null;
  return s;
}

function selectedMemoryLayers(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const layer = String((item as Record<string, unknown>).compression_layer ?? "").trim();
    if (!layer) continue;
    out.add(layer);
  }
  return Array.from(out).sort();
}

function normalizeSelectionPolicy(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const preferredLayers = Array.isArray(raw.preferred_layers)
    ? raw.preferred_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const secondaryLayers = Array.isArray(raw.secondary_layers)
    ? raw.secondary_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const trustAnchorLayers = Array.isArray(raw.trust_anchor_layers)
    ? raw.trust_anchor_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const requestedAllowedLayers = Array.isArray(raw.requested_allowed_layers)
    ? raw.requested_allowed_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  return {
    name: typeof raw.name === "string" ? raw.name : null,
    preferred_layers: preferredLayers,
    secondary_layers: secondaryLayers,
    trust_anchor_layers: trustAnchorLayers,
    source: typeof raw.source === "string" ? raw.source : "unknown",
    requested_allowed_layers: requestedAllowedLayers,
  };
}

function normalizeSelectionStats(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const retrievedMemoryLayers = Array.isArray(raw.retrieved_memory_layers)
    ? raw.retrieved_memory_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const selectedMemoryLayers = Array.isArray(raw.selected_memory_layers)
    ? raw.selected_memory_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const filteredByLayer =
    raw.filtered_by_layer && typeof raw.filtered_by_layer === "object" && !Array.isArray(raw.filtered_by_layer)
      ? Object.fromEntries(
          Object.entries(raw.filtered_by_layer as Record<string, unknown>)
            .map(([key, value]) => [String(key), Number(value)])
            .filter(([, value]) => Number.isFinite(value) && Number(value) > 0),
        )
      : {};
  const retrievalFilteredByLayer =
    raw.retrieval_filtered_by_layer &&
    typeof raw.retrieval_filtered_by_layer === "object" &&
    !Array.isArray(raw.retrieval_filtered_by_layer)
      ? Object.fromEntries(
          Object.entries(raw.retrieval_filtered_by_layer as Record<string, unknown>)
            .map(([key, value]) => [String(key), Number(value)])
            .filter(([, value]) => Number.isFinite(value) && Number(value) > 0),
        )
      : {};
  const retrievedUnlayeredCount = Number(raw.retrieved_unlayered_count ?? 0);
  const selectedUnlayeredCount = Number(raw.selected_unlayered_count ?? 0);
  const retrievalFilteredByLayerPolicyCount = Number(raw.retrieval_filtered_by_layer_policy_count ?? 0);
  const filteredByLayerPolicyCount = Number(raw.filtered_by_layer_policy_count ?? 0);
  return {
    retrieved_memory_layers: retrievedMemoryLayers,
    retrieved_unlayered_count: Number.isFinite(retrievedUnlayeredCount) ? Math.max(0, Math.trunc(retrievedUnlayeredCount)) : 0,
    selected_memory_layers: selectedMemoryLayers,
    selected_unlayered_count: Number.isFinite(selectedUnlayeredCount) ? Math.max(0, Math.trunc(selectedUnlayeredCount)) : 0,
    retrieval_filtered_by_layer_policy_count: Number.isFinite(retrievalFilteredByLayerPolicyCount)
      ? Math.max(0, Math.trunc(retrievalFilteredByLayerPolicyCount))
      : 0,
    retrieval_filtered_by_layer: retrievalFilteredByLayer,
    filtered_by_layer_policy_count: Number.isFinite(filteredByLayerPolicyCount)
      ? Math.max(0, Math.trunc(filteredByLayerPolicyCount))
      : 0,
    filtered_by_layer: filteredByLayer,
  };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round4(sorted[idx] ?? 0);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function elapsedMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round4(Math.max(0, parsed)) : null;
}

function candidateIds(candidates: readonly RecallCandidate[]): Set<string> {
  return new Set(candidates.map((candidate) => candidate.id));
}

function candidateScore(candidate: RecallCandidate, kind: RecallCandidateSourceKind): number | null {
  const sourceScore = candidate.sources?.find((source) => source.kind === kind)?.score;
  if (typeof sourceScore === "number" && Number.isFinite(sourceScore)) return Math.max(0, Math.min(1, sourceScore));
  return Number.isFinite(candidate.similarity) ? Math.max(0, Math.min(1, candidate.similarity)) : null;
}

function sourceCandidateMetric(args: {
  kind: RecallCandidateSourceKind;
  candidates: readonly RecallCandidate[];
  elapsed_ms?: number | null;
}) {
  const ids = candidateIds(args.candidates);
  const scores = args.candidates
    .map((candidate) => candidateScore(candidate, args.kind))
    .filter((value): value is number => value !== null);
  return {
    kind: args.kind,
    candidate_count: args.candidates.length,
    unique_candidate_count: ids.size,
    elapsed_ms: elapsedMs(args.elapsed_ms),
    mean_score: mean(scores),
    max_score: scores.length > 0 ? round4(Math.max(...scores)) : null,
  };
}

export type RecallSourceObservabilityInput = {
  sources: Array<{
    kind: RecallCandidateSourceKind;
    candidates: readonly RecallCandidate[];
    elapsed_ms?: number | null;
  }>;
  hybrid_merge?: {
    input_candidates: readonly RecallCandidate[];
    output_candidates: readonly RecallCandidate[];
    elapsed_ms?: number | null;
  } | null;
};

export type RecallSourceObservabilityMetrics = ReturnType<typeof buildRecallSourceObservabilityMetrics>;

export function buildRecallSourceObservabilityMetrics(args: RecallSourceObservabilityInput) {
  const sourceByKind = new Map<RecallCandidateSourceKind, {
    kind: RecallCandidateSourceKind;
    candidates: readonly RecallCandidate[];
    elapsed_ms?: number | null;
  }>();
  for (const source of args.sources) {
    sourceByKind.set(source.kind, source);
  }
  const stage1Sources = Object.fromEntries(RECALL_SOURCE_KINDS.map((kind) => {
    const source = sourceByKind.get(kind);
    return [kind, sourceCandidateMetric({
      kind,
      candidates: source?.candidates ?? [],
      elapsed_ms: source?.elapsed_ms ?? null,
    })];
  })) as Record<RecallCandidateSourceKind, ReturnType<typeof sourceCandidateMetric>>;

  const candidateOverlap: Array<{
    source_a: RecallCandidateSourceKind;
    source_b: RecallCandidateSourceKind;
    overlap_count: number;
  }> = [];
  for (let leftIndex = 0; leftIndex < RECALL_SOURCE_KINDS.length; leftIndex += 1) {
    const left = RECALL_SOURCE_KINDS[leftIndex]!;
    const leftIds = candidateIds(sourceByKind.get(left)?.candidates ?? []);
    if (leftIds.size === 0) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < RECALL_SOURCE_KINDS.length; rightIndex += 1) {
      const right = RECALL_SOURCE_KINDS[rightIndex]!;
      const rightIds = candidateIds(sourceByKind.get(right)?.candidates ?? []);
      if (rightIds.size === 0) continue;
      let overlapCount = 0;
      for (const id of leftIds) {
        if (rightIds.has(id)) overlapCount += 1;
      }
      if (overlapCount > 0) {
        candidateOverlap.push({ source_a: left, source_b: right, overlap_count: overlapCount });
      }
    }
  }

  const hybridInput = args.hybrid_merge?.input_candidates ?? [];
  const hybridOutput = args.hybrid_merge?.output_candidates ?? [];
  const hybridInputUnique = candidateIds(hybridInput);
  const hybridOutputUnique = candidateIds(hybridOutput);
  return {
    stage1_sources: stage1Sources,
    hybrid_merge: {
      input_count: hybridInput.length,
      input_unique_count: hybridInputUnique.size,
      output_count: hybridOutput.length,
      output_unique_count: hybridOutputUnique.size,
      duplicate_candidate_count: Math.max(0, hybridInput.length - hybridInputUnique.size),
      source_family_count: args.sources.filter((source) => source.candidates.length > 0).length,
      elapsed_ms: elapsedMs(args.hybrid_merge?.elapsed_ms),
    },
    candidate_overlap: candidateOverlap,
  };
}

export type RecallSourceObservabilitySummary = ReturnType<typeof summarizeRecallSourceObservabilityMetrics>;

export function summarizeRecallSourceObservabilityMetrics(metrics: readonly RecallSourceObservabilityMetrics[]) {
  const stage1Sources = Object.fromEntries(RECALL_SOURCE_KINDS.map((kind) => {
    const perCase = metrics.map((metric) => metric.stage1_sources[kind]);
    const candidateCounts = perCase.map((entry) => entry.candidate_count);
    const latencies = perCase
      .map((entry) => entry.elapsed_ms)
      .filter((value): value is number => typeof value === "number");
    return [kind, {
      case_count: metrics.length,
      cases_with_candidates: perCase.filter((entry) => entry.candidate_count > 0).length,
      total_candidates: candidateCounts.reduce((sum, value) => sum + value, 0),
      mean_candidates_per_case: mean(candidateCounts) ?? 0,
      p50_latency_ms: percentile(latencies, 50),
      p95_latency_ms: percentile(latencies, 95),
    }];
  }));

  const hybridLatencies = metrics
    .map((metric) => metric.hybrid_merge.elapsed_ms)
    .filter((value): value is number => typeof value === "number");
  const overlapByPair = new Map<string, {
    source_a: RecallCandidateSourceKind;
    source_b: RecallCandidateSourceKind;
    case_count: number;
    total_overlap_count: number;
  }>();
  for (const metric of metrics) {
    for (const overlap of metric.candidate_overlap) {
      const key = `${overlap.source_a}:${overlap.source_b}`;
      const next = overlapByPair.get(key) ?? {
        source_a: overlap.source_a,
        source_b: overlap.source_b,
        case_count: 0,
        total_overlap_count: 0,
      };
      next.case_count += 1;
      next.total_overlap_count += overlap.overlap_count;
      overlapByPair.set(key, next);
    }
  }

  return {
    stage1_sources: stage1Sources as Record<RecallCandidateSourceKind, {
      case_count: number;
      cases_with_candidates: number;
      total_candidates: number;
      mean_candidates_per_case: number;
      p50_latency_ms: number | null;
      p95_latency_ms: number | null;
    }>,
    hybrid_merge: {
      case_count: metrics.length,
      total_input_count: metrics.reduce((sum, metric) => sum + metric.hybrid_merge.input_count, 0),
      total_output_count: metrics.reduce((sum, metric) => sum + metric.hybrid_merge.output_count, 0),
      total_duplicate_candidate_count: metrics.reduce((sum, metric) => sum + metric.hybrid_merge.duplicate_candidate_count, 0),
      p50_latency_ms: percentile(hybridLatencies, 50),
      p95_latency_ms: percentile(hybridLatencies, 95),
    },
    candidate_overlap: Array.from(overlapByPair.values())
      .sort((left, right) =>
        right.total_overlap_count - left.total_overlap_count
        || left.source_a.localeCompare(right.source_a)
        || left.source_b.localeCompare(right.source_b))
      .map((entry) => ({
        ...entry,
        mean_overlap_per_case: metrics.length > 0 ? round4(entry.total_overlap_count / metrics.length) : 0,
      })),
  };
}

export function collectRecallTrajectoryUriLinks(args: { recall: any; tools?: any; max_per_type?: number }) {
  const cap = Math.max(1, Math.min(200, Number(args.max_per_type ?? 32)));
  const out = {
    nodes: [] as string[],
    edges: [] as string[],
    commits: [] as string[],
    decisions: [] as string[],
  };
  const seen = {
    nodes: new Set<string>(),
    edges: new Set<string>(),
    commits: new Set<string>(),
    decisions: new Set<string>(),
  };
  const totals = {
    nodes: new Set<string>(),
    edges: new Set<string>(),
    commits: new Set<string>(),
    decisions: new Set<string>(),
  };

  const add = (kind: keyof typeof out, raw: unknown) => {
    const uri = normalizeAionisUri(raw);
    if (!uri) return;
    totals[kind].add(uri);
    if (out[kind].length >= cap) return;
    if (seen[kind].has(uri)) return;
    seen[kind].add(uri);
    out[kind].push(uri);
  };

  const recall = args.recall ?? {};
  const seeds = Array.isArray(recall?.seeds) ? recall.seeds : [];
  for (const seed of seeds) add("nodes", (seed as any)?.uri);

  const ranked = Array.isArray(recall?.ranked) ? recall.ranked : [];
  for (const node of ranked) add("nodes", (node as any)?.uri);

  const subgraphNodes = Array.isArray(recall?.subgraph?.nodes) ? recall.subgraph.nodes : [];
  for (const node of subgraphNodes) add("nodes", (node as any)?.uri);

  const subgraphEdges = Array.isArray(recall?.subgraph?.edges) ? recall.subgraph.edges : [];
  for (const edge of subgraphEdges) {
    add("edges", (edge as any)?.uri);
    add("commits", (edge as any)?.commit_uri);
  }

  const contextItems = Array.isArray(recall?.context?.items) ? recall.context.items : [];
  for (const item of contextItems) add("nodes", (item as any)?.uri);

  const citations = Array.isArray(recall?.context?.citations) ? recall.context.citations : [];
  for (const citation of citations) {
    add("nodes", (citation as any)?.uri);
    add("commits", (citation as any)?.commit_uri);
  }

  const tools = args.tools ?? {};
  add("decisions", tools?.decision?.decision_uri);
  add("decisions", tools?.decision_uri);
  add("commits", tools?.decision?.commit_uri);
  add("commits", tools?.commit_uri);

  const chainDecision = out.decisions[0];
  const chainCommit = out.commits[0];
  const chainNode = out.nodes[0];
  const chainEdge = out.edges[0];

  return {
    ...out,
    counts: {
      nodes: totals.nodes.size,
      edges: totals.edges.size,
      commits: totals.commits.size,
      decisions: totals.decisions.size,
    },
    ...(chainDecision
      ? {
          chain: {
            decision_uri: chainDecision,
            ...(chainCommit ? { commit_uri: chainCommit } : {}),
            ...(chainNode ? { node_uri: chainNode } : {}),
            ...(chainEdge ? { edge_uri: chainEdge } : {}),
          },
        }
      : {}),
  };
}

export function buildRecallObservability(args: {
  timings: Record<string, number>;
  inflight_wait_ms: number;
  context_items?: unknown;
  selection_policy?: unknown;
  selection_stats?: unknown;
  explicit_mode?: {
    mode?: string | null;
    profile?: string;
    applied?: boolean;
    reason?: string;
    source?: string;
  } | null;
  adaptive_profile: { profile: string; applied: boolean; reason: string };
  adaptive_hard_cap: { applied: boolean; reason: string };
  runtime_entropy_defaults?: {
    applied: boolean;
    reason: string;
    controls_version?: string | null;
    recall_breadth?: string | null;
    defaults?: Record<string, unknown>;
  } | null;
  runtime_entropy_verifier_defaults?: {
    applied: boolean;
    reason: string;
    controls_version?: string | null;
    verifier_schedule?: string | null;
    runtime_verifier_required?: boolean | null;
    defaults?: Record<string, unknown>;
  } | null;
  class_aware?: {
    workload_class?: string | null;
    profile?: string;
    applied?: boolean;
    reason?: string;
    signals?: string[];
    enabled?: boolean;
    source?: string;
  } | null;
  stage1?: {
    mode?: "ann" | "exact_recovery";
    ann_seed_count?: number;
    final_seed_count?: number;
    exact_recovery_enabled?: boolean;
    exact_recovery_attempted?: boolean;
  } | null;
  neighborhood_counts?: { nodes?: number; edges?: number } | null;
}) {
  const stageTimings = {
    stage1_candidates_ann_ms: args.timings["stage1_candidates_ann"] ?? 0,
    stage1_candidates_exact_recovery_ms: args.timings["stage1_candidates_exact_recovery"] ?? 0,
    stage2_edges_ms: args.timings["stage2_edges"] ?? 0,
    stage2_nodes_ms: args.timings["stage2_nodes"] ?? 0,
    stage2_spread_ms: args.timings["stage2_spread"] ?? 0,
    stage3_context_ms: args.timings["stage3_context"] ?? 0,
    rule_defs_ms: args.timings["rule_defs"] ?? 0,
    audit_insert_ms: args.timings["audit_insert"] ?? 0,
    debug_embeddings_ms: args.timings["debug_embeddings"] ?? 0,
  };
  const memoryLayers = selectedMemoryLayers(args.context_items);
  const selectionPolicy = normalizeSelectionPolicy(args.selection_policy);
  const selectionStats = normalizeSelectionStats(args.selection_stats);
  return {
    stage_timings_ms: stageTimings,
    inflight_wait_ms: args.inflight_wait_ms,
    adaptive: {
      explicit_mode: args.explicit_mode
        ? {
            mode: args.explicit_mode.mode ?? null,
            profile: args.explicit_mode.profile ?? null,
            applied: args.explicit_mode.applied ?? false,
            reason: args.explicit_mode.reason ?? "unknown",
            source: args.explicit_mode.source ?? "unknown",
          }
        : null,
      class_aware: args.class_aware
        ? {
            workload_class: args.class_aware.workload_class ?? null,
            profile: args.class_aware.profile ?? null,
            applied: args.class_aware.applied ?? false,
            reason: args.class_aware.reason ?? "unknown",
            signals: Array.isArray(args.class_aware.signals) ? args.class_aware.signals : [],
            enabled: args.class_aware.enabled ?? false,
            source: args.class_aware.source ?? "unknown",
          }
        : null,
      profile: {
        profile: args.adaptive_profile.profile,
        applied: args.adaptive_profile.applied,
        reason: args.adaptive_profile.reason,
      },
      hard_cap: {
        applied: args.adaptive_hard_cap.applied,
        reason: args.adaptive_hard_cap.reason,
      },
      runtime_entropy_defaults: args.runtime_entropy_defaults
        ? {
            applied: args.runtime_entropy_defaults.applied,
            reason: args.runtime_entropy_defaults.reason,
            controls_version: args.runtime_entropy_defaults.controls_version ?? null,
            recall_breadth: args.runtime_entropy_defaults.recall_breadth ?? null,
            defaults:
              args.runtime_entropy_defaults.defaults &&
              typeof args.runtime_entropy_defaults.defaults === "object"
                ? args.runtime_entropy_defaults.defaults
                : {},
          }
        : null,
      runtime_entropy_verifier_defaults: args.runtime_entropy_verifier_defaults
        ? {
            applied: args.runtime_entropy_verifier_defaults.applied,
            reason: args.runtime_entropy_verifier_defaults.reason,
            controls_version: args.runtime_entropy_verifier_defaults.controls_version ?? null,
            verifier_schedule: args.runtime_entropy_verifier_defaults.verifier_schedule ?? null,
            runtime_verifier_required:
              args.runtime_entropy_verifier_defaults.runtime_verifier_required ?? null,
            defaults:
              args.runtime_entropy_verifier_defaults.defaults &&
              typeof args.runtime_entropy_verifier_defaults.defaults === "object"
                ? args.runtime_entropy_verifier_defaults.defaults
                : {},
          }
        : null,
    },
    stage1: args.stage1 ?? null,
    neighborhood_counts: args.neighborhood_counts ?? null,
    memory_layers: {
      retrieved_layers: selectionStats?.retrieved_memory_layers ?? [],
      selected_layers: selectionStats?.selected_memory_layers ?? memoryLayers,
      retrieved_unlayered_count: selectionStats?.retrieved_unlayered_count ?? 0,
      selected_unlayered_count: selectionStats?.selected_unlayered_count ?? 0,
      retrieval_filtered_by_layer_policy_count: selectionStats?.retrieval_filtered_by_layer_policy_count ?? 0,
      retrieval_filtered_by_layer: selectionStats?.retrieval_filtered_by_layer ?? {},
      filtered_by_layer_policy_count: selectionStats?.filtered_by_layer_policy_count ?? 0,
      filtered_by_layer: selectionStats?.filtered_by_layer ?? {},
      selection_policy: selectionPolicy,
    },
  };
}
