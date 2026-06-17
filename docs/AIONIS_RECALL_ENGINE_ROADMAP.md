# Aionis Recall Engine Roadmap

Status: implementation roadmap for the Candidate Retrieval Engine below Aionis governance

Aionis does not win by being another vector database. It wins by separating
candidate retrieval from memory admission.

The Recall Engine answers:

```text
Which memories might matter, why were they retrieved, and from which source?
```

The governance layer still answers:

```text
Can this memory influence the Agent now?
Should it be direct use, inspect-only, blocked, or rehydrated?
```

This boundary is non-negotiable. Recall may improve candidate coverage,
ranking, latency, and traceability. Recall must not assign authority, mutate
lifecycle state, bypass source/scope gates, or decide `use_now`,
`inspect_before_use`, `do_not_use`, or `rehydrate`.

## Current Baseline

The current Lite Runtime exposes `RecallStoreAccess` as the store abstraction.
That is the right seam to evolve.

`RecallStoreAccess` capability v4 exposes candidate source traces. The current
Lite implementation fills source traces for semantic bounded scans, exact
recovery, keyword lexical recall, structured and execution-native signatures,
graph neighbor expansion, and recent hot working-set recall. ANN remains behind
the opt-in sidecar provider.

Today, `stage1CandidatesAnn` is still not a true ANN index. It is a bounded
SQLite candidate fetch followed by JavaScript vector parsing and cosine
ranking. This is acceptable for local Lite demos and focused tests, but it has
two limits:

1. large scopes increase recall latency
2. old or low-salience memories can miss the bounded candidate window even when
   they are semantically relevant

The first step is therefore not "install ANN". The first step is to measure
candidate retrieval quality and source coverage before changing behavior.

## Product Operating Mode

Route-level recall is selected by `RECALL_ENGINE_MODE`:

| Mode | Product meaning | Default |
|---|---|---|
| `semantic_scan` | Keep the current bounded semantic candidate path. | Lite |
| `hybrid` | Merge semantic, lexical, structured, and execution-native candidates before governance. | Server |

Hybrid mode changes candidate breadth only. It does not grant prompt authority,
does not change lifecycle state, and does not decide `use_now`,
`inspect_before_use`, `do_not_use`, or `rehydrate`.

Operational diagnostics live in
[AIONIS_RECALL_ENGINE_RUNBOOK.md](AIONIS_RECALL_ENGINE_RUNBOOK.md). Use the
runbook to classify a memory issue as candidate retrieval, admission,
rehydration, host prompt integration, or Agent compliance before changing
Runtime behavior.

## Candidate Source Model

Recall Engine v3 should expose candidate sources explicitly.

| Source | Purpose |
|---|---|
| `semantic` | Vector similarity over memory content. |
| `lexical` | Keyword, phrase, path, symbol, command, and BM25/FTS matches. |
| `structured` | Task signatures, workflow signatures, repo signatures, tool names, target files, acceptance checks. |
| `execution_native` | Execution-tree and workflow anchors: passed branches, failed branches, current active path, verifier outcomes. |
| `graph` | Neighbor expansion from already-selected candidates. |
| `recent` | Hot working set and recently activated state. |
| `exact_recovery` | Cold or low-salience exact semantic recovery when bounded recall misses. |
| `ann_sidecar` | Future local or hosted ANN candidate generation. |

Every candidate should carry source traces:

```json
{
  "memory_id": "mem_123",
  "sources": [
    { "kind": "semantic", "score": 0.84, "reason": "bounded_embedding_scan" },
    { "kind": "structured", "reason": "same_workflow_signature" }
  ]
}
```

The trace is for observability and scoring. It is not admission authority.

## Success Metrics

Recall Engine work should report these metrics before and after each retrieval
change:

| Metric | Meaning |
|---|---|
| `recall_at_50` | Expected relevant memories present in the top 50 candidates. |
| `candidate_source_coverage` | Required source families that produced candidates. |
| `use_now_precision_after_governance` | Direct-use precision after Aionis governance, when evaluated through the guide path. |
| `inspect_before_use_correctness` | Ambiguous or risky candidates land in inspect-only surfaces after governance. |
| `do_not_use_stale_suppression` | Stale memories are available as evidence but do not become direct-use context. |
| `failed_branch_blocking` | Failed branches are retrievable as counter-evidence and blocked from direct use after governance. |
| `rehydrate_hit_rate` | Memories that need raw evidence produce rehydrate candidates or pointers. |
| `p50_recall_latency_ms` | Median candidate retrieval latency. |
| `p95_recall_latency_ms` | Tail candidate retrieval latency. |
| `source_observability.stage1_sources` | Per-source candidate counts, case coverage, p50/p95 latency, and score summaries for semantic, lexical, structured, execution-native, exact recovery, graph, recent, and ANN families. |
| `source_observability.hybrid_merge` | Hybrid merge input/output counts, duplicate candidate count, source-family count, and merge latency. |
| `source_observability.candidate_overlap` | Candidate overlap between source families so retrieval changes can be diagnosed without changing governance. |
| `index_rebuild_time_ms` | Time to rebuild any sidecar index. |
| `embedding_backfill_delay_ms` | Delay between write and searchable embedding availability. |

Recall-only baseline runs may report governance-owned metrics as deferred or
proxy metrics. Full product evaluations must measure them through `/v1/guide`.

## Implementation Sequence

1. **Baseline eval**
   - Add a deterministic recall fixture over real Lite SQLite stores.
   - Report recall quality, source coverage, and latency before changing recall.

2. **RecallStoreAccess source contract**
   - Extend the access contract with source-aware candidate metadata.
   - Keep capability versioning explicit.

3. **Lexical and structured recall**
   - Add keyword candidates first because they are lower-risk than ANN.
   - The current Lite keyword source uses a maintained SQLite keyword index.
     A future FTS5 implementation can replace the backend without changing the
     `stage1LexicalCandidates` contract.
   - Add structured signature candidates for target files, task signatures,
     workflow signatures, error signatures, tool names, and acceptance checks.
   - Current status: first Lite structured source is implemented over the
     execution-native index. It is deterministic candidate generation only; it
     does not decide memory admission.

4. **Execution-native recall**
   - Strengthen execution-native candidate generation with task family, repo
     signature, file cluster, tool-chain signature, failure mode, verification
     signature, and active-path relations.
   - Current status: task family, repo signature, file cluster, target files,
     tool-chain signature, failure mode, verification signature, and acceptance
     check signature are materialized in `lite_memory_execution_native_index`
     and exposed through `stage1ExecutionNativeCandidates`.

5. **Hybrid merge**
   - Merge semantic, lexical, structured, execution-native, graph, recent, and
     exact-recovery candidates with source tracing.
   - Prefer RRF or a simple weighted merge before learned ranking.
   - Current status: first RRF hybrid merge is implemented for
     `stage1HybridCandidates` over semantic, lexical, structured,
     execution-native, graph, and recent sources. Recent candidates are used as
     a source-trace augment for already selected primary candidates, or as a
     fallback when no primary seeds exist; this keeps the hot working set from
     outranking semantic or structured evidence. Product recall paths select
     the route-level candidate engine through
     `RECALL_ENGINE_MODE=semantic_scan|hybrid`: Lite defaults to
     `semantic_scan`, while Server defaults to `hybrid` after the managed-server
     e2e proved source traces remain below governance and are replayable through
     Agent Flight Recorder without prompt payload leakage.

6. **Recall source observability**
   - Report per-source candidate counts, p50/p95 latency, hybrid merge shape,
     and candidate overlap in the recall eval summary.
   - Current status: `src/app/recall-observability.ts` exposes reusable source
     metrics helpers; `scripts/e2e/recall-engine-eval.ts` emits
     `source_observability` over real Lite stores. Deterministic eval runs fix
     `generated_at` and null latency fields for stable docs examples. The
     baseline fixture now requires source-family coverage for semantic,
     lexical, structured, execution-native, graph, recent, and exact recovery,
     and the checked-in baseline is at `recall_at_50=1` and
     `candidate_source_coverage=1`.

7. **Local ANN sidecar**
   - Add a local ANN adapter only after source-aware metrics exist.
   - SQLite remains the fact source. ANN is candidate generation only.
   - Candidate IDs must be checked against SQLite authority/scope/lifecycle
     facts before governance.
   - Current status: the first sidecar contract is implemented behind
     `RECALL_ANN_PROVIDER=off|local`. `off` is the default. The local
     implementation is an in-memory exact sidecar used to stabilize the adapter
     contract and tests before wiring a production ANN backend. When
     `RECALL_ANN_PROVIDER=local` is passed into Runtime services, semantic
     candidate generation can use the sidecar first and then re-check candidate
     IDs against SQLite scope, tier, visibility, and surface gates before
     returning `ann` source traces. Empty or unusable sidecar results fall back
     to the existing bounded SQLite scan.
   - Route-level status: ANN remains one semantic source within the recall
     engine. Hybrid mode changes candidate generation breadth only; Aionis
     admission still decides `use_now`, `inspect_before_use`, `do_not_use`, and
     `rehydrate`.
   - Backend evaluation status: USearch, sqlite-vec, and LanceDB are documented
     in `docs/research/2026-06-16-ann-backend-evaluation.md`. No backend
     dependency is committed yet. `scripts/research/ann-backend-probe.mjs`
     provides a manual, dependency-optional probe for local measurements.

8. **Flight Recorder and operator visibility**
   - Include recall source traces in operator snapshots and Flight Recorder.
   - Operators should see whether an Agent missed context because recall missed
     a candidate or because governance blocked it.
   - Current status: source traces from `RecallCandidate.sources` are carried
     into `AionisMemoryPacket.relevant_memories[].recall_sources`,
     `memory_decision_trace.memory_decisions[].recall_sources`,
     `memory_use_receipt.decision_summaries[].recall_sources`,
     `memory_admission_record.entries[].recall_sources`, operator snapshots via
     receipt/admission record, and Agent Flight Recorder replay fields. These
     traces are read-only observability and do not participate in admission.

## Hosted Server Shape

Managed Server Edition should use the same boundary:

```text
strong retrieval below
strict governance above
auditable memory influence throughout
```

Server deployments may later swap the local sidecar for a managed vector index
or search backend, but the product API should stay stable. The hosted service
can improve candidate generation without changing what memory is allowed to do
to the Agent.

## Non-Goals

- Do not make Aionis a vector DB wrapper.
- Do not expose raw retrieved candidates as Agent prompt by default.
- Do not let ANN or lexical recall promote memory to direct use.
- Do not weaken lifecycle, authority, scope, source, or rehydration gates.
- Do not optimize one benchmark case by adding task-specific retrieval rules.
