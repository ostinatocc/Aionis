# Ordinary Memory Retrieval Roadmap

Status: implementation roadmap for strengthening ordinary long-context QA recall

## Problem Statement

In ordinary long-context QA and MemoryData-style workloads, Aionis currently
loses more often because key factual evidence does not reach final guide
context.

The failure chain to diagnose is:

```text
gold evidence written
  -> candidate retrieval misses it or ranks it too low
  -> guide context omits it under budget
  -> Agent cannot answer exactly
```

This is different from the MGBench/governance problem. There, Aionis is strong
at keeping stale, invalidated, cross-scope, contested, or failed historical
memory from becoming direct-use context. Ordinary QA tests whether the right
facts are retrieved and packed in the first place.

## Product Invariants

- Aionis remains a state-adjudicated memory runtime, not a vector database.
- Stronger retrieval must not bypass admission.
- Candidate retrieval may propose memories and source traces.
- Governance still decides `use_now`, `inspect_before_use`, `do_not_use`, and
  `rehydrate`.
- All final context must remain auditable through receipt, guide trace, and
  Flight Recorder surfaces.
- Raw evidence must remain rehydratable when compact facts or summaries are not
  enough.
- Ordinary memory improvements must not weaken execution memory behavior.

## Four-Layer Plan

### 1. Memory Construction

Goal: make ordinary memory easier to retrieve for factual QA.

Current weakness: ordinary memory can be written as useful text but still lack
retrieval keys that represent how a future question will ask for it.

Add or strengthen these fields during ordinary memory write/distillation:

| Field | Purpose |
|---|---|
| `answerable_facts` | Short fact units that can answer a direct question. |
| `entities` | People, projects, services, repos, APIs, files, organizations, products. |
| `aliases` | Alternate names, abbreviations, casing variants, user nicknames. |
| `time_validity` | `valid_from`, `valid_until`, observed time, and whether the fact is current. |
| `source_spans` | Pointer to the raw event/text span that supports the fact. |
| `topic_keys` | Stable coarse topics for lexical and structured recall. |
| `question_keys` | Optional generated query-like keys for likely future asks. |
| `contradiction_keys` | Keys that help route newer/current facts against old facts. |

Implementation seam:

- Extend ordinary memory write preparation, not product API shape first.
- Keep raw observation evidence by default.
- Do not let generated facts overwrite source evidence.
- Put generated retrieval keys into slots/index metadata with schema versioning.

Initial tests:

- A fact write produces answerable facts and entities.
- Aliases are indexed without duplicating memory nodes.
- Time validity is preserved through write -> recall -> guide.
- Source span pointers are present for rehydrate-capable facts.

Success metrics:

- `gold_evidence_in_store = 1.0`
- `answerable_fact_coverage >= 0.9` on QA fixtures
- `source_span_coverage >= 0.9` for generated facts

### 2. Candidate Retrieval

Goal: improve coverage before governance.

Candidate retrieval should become multi-source:

```text
semantic
lexical / FTS / BM25
structured filters
graph neighbors
temporal query expansion
recent working set
exact recovery
optional ANN sidecar
```

Required candidate source families:

| Source | Role |
|---|---|
| `semantic` | Broad meaning match over memory text and answerable facts. |
| `lexical` | Exact names, keywords, paths, symbols, commands, IDs, and phrases. |
| `structured` | Entity, topic, scope, source, validity, memory kind, actor, project. |
| `graph` | Neighbor expansion from related facts, source evidence, and relations. |
| `temporal` | Current-state, changed-since, latest-known, and valid-at expansion. |
| `recent` | Hot working set for active tasks and recently used facts. |
| `ann` | Optional Zvec or future ANN sidecar for scalable semantic candidates. |

Implementation seam:

- Build on `RecallStoreAccess` source-aware candidates.
- Keep SQLite as the fact source in Lite.
- Zvec stays optional candidate generation, not the truth store.
- Every candidate carries `recall_sources`.
- Candidate IDs must be rechecked against SQLite scope, visibility, lifecycle,
  and authority facts before governance.

Eval checkpoints:

Measure each stage separately:

```text
gold evidence in store
gold evidence in semantic candidates
gold evidence in lexical candidates
gold evidence in structured candidates
gold evidence in graph/temporal candidates
gold evidence after hybrid merge
gold evidence after admission
gold evidence in final agent_context
```

Success metrics:

| Metric | Target for first gate |
|---|---|
| `candidate_recall_at_20` | >= 0.8 |
| `candidate_recall_at_50` | >= 0.9 |
| `source_family_coverage` | >= 0.8 |
| `gold_after_hybrid_merge` | >= 0.85 |
| `p95_candidate_latency_ms` | bounded and reported |

### 3. Reranking / Routing

Goal: move the right factual evidence high enough that guide packing can use it.

Retrieval coverage alone is not enough. Ordinary QA needs ranking and routing
that understand answerability, temporal state, and evidence coverage.

Add these capabilities in order:

| Capability | Purpose |
|---|---|
| `query_rewrite` | Normalize user questions into retrieval-friendly forms. |
| `multi_query` | Generate entity, topic, temporal, and constraint subqueries. |
| `time_aware_routing` | Prefer facts valid for the query time or current state. |
| `evidence_coverage_scoring` | Prefer candidates that contain or point to answer spans. |
| `optional_reranker` | Rerank top candidates with a local/API reranker when configured. |
| `abstention_signal` | Mark when retrieved evidence is insufficient instead of hallucinating. |

Implementation seam:

- Reranker is optional and provider-backed.
- Query rewrite must be bounded, traceable, and cacheable.
- Reranking output is still candidate metadata, not admission authority.
- Reranking must preserve source traces so Flight Recorder can explain why a
  memory was surfaced.

First reranking features:

- lexical/entity overlap score
- answerable fact match score
- source span availability score
- valid-time/current-state score
- contradiction/newer-evidence penalty
- source authority hint
- historical feedback utility hint

Success metrics:

| Metric | Target for first gate |
|---|---|
| `mrr` | improves over semantic-only baseline |
| `gold_in_top_8_after_rerank` | >= 0.75 |
| `answer_accuracy` | improves without increasing stale leakage |
| `stale_leak_rate` | does not regress |
| `context_chars` | remains materially below full history |

### 4. Aionis Governance

Goal: keep retrieval strong but governed.

After retrieval and reranking, all candidates still pass through Aionis:

```text
candidate memory
  -> lifecycle / authority / scope / source / feedback gates
  -> use_now | inspect_before_use | do_not_use | rehydrate
  -> receipt + guide trace + Flight Recorder
```

Governance responsibilities:

| Surface | Rule |
|---|---|
| `use_now` | Only current, sufficiently supported, task-relevant memory. |
| `inspect_before_use` | Relevant but ambiguous, contested, stale-risk, or under-evidenced memory. |
| `do_not_use` | Known stale, failed, contradicted, cross-scope, or unsafe memory. |
| `rehydrate` | Compact memory is relevant but insufficient to answer or act. |
| `receipt` | Every use/suppress/rehydrate decision is explainable. |

Governance must prevent strong retrieval from becoming strong pollution.

Regression tests:

- A stronger lexical hit for stale memory does not enter `use_now`.
- A high semantic score for contradicted memory remains inspect/block.
- A high reranker score cannot override scope or tenant boundaries.
- Rehydrate is requested when answerable fact is too compact to answer safely.
- Execution memory guide behavior does not regress when ordinary QA recall is
  enabled.

Success metrics:

| Metric | Target |
|---|---|
| `use_now_precision_after_governance` | no regression |
| `stale_direct_use_rate` | <= existing governance baseline |
| `do_not_use_enforcement` | no regression |
| `receipt_coverage` | 100% for exposed memory |
| `guide_trace_coverage` | 100% for exposed memory |

## Implementation Sequence

### Phase 0: Baseline and Diagnostics

Add `ordinary-memory-qa-recall-eval` before changing behavior.

Required report fields:

```json
{
  "gold_evidence_in_store": 1.0,
  "gold_in_semantic_candidates": 0.0,
  "gold_in_lexical_candidates": 0.0,
  "gold_after_hybrid_merge": 0.0,
  "gold_after_admission": 0.0,
  "gold_in_final_agent_context": 0.0,
  "answer_accuracy": 0.0,
  "context_chars": 0,
  "stale_leak_rate": 0.0,
  "source_family_coverage": 0.0
}
```

Exit gate:

- The eval can explain each miss as store, recall, ranking, admission, packing,
  rehydrate, or reader failure.

### Phase 1: Construction Keys

Add answerable facts, entities, aliases, topic keys, time validity, and source
spans for ordinary memory writes.

Exit gate:

- QA fixtures show higher lexical/structured source coverage.
- No product API breaking changes.

### Phase 2: Hybrid Ordinary Recall

Add FTS/BM25-style lexical recall and structured ordinary-memory filters.
Integrate with existing hybrid merge and source tracing.

Current implementation status:

- Lite lexical recall uses query-term coverage, field weighting, phrase bonus,
  and ordinary-memory evidence-field matches.
- SQLite lexical prefetch orders by query-term coverage before salience, so
  lower-salience facts can survive noisy working sets.
- Pure text ordinary hybrid recall protects high-confidence lexical evidence
  from recent-only noise while leaving semantic and execution-structured hybrid
  recall unchanged.
- `npm run -s recall:ordinary-memory` emits a real Lite-store baseline with
  construction coverage, top-5 evidence hit, top-1 hit, MRR, and slots-text
  source-hit metrics.

Exit gate:

- `candidate_recall_at_50` improves on QA fixtures.
- Source traces show which family recovered the gold evidence.

### Phase 3: Query Rewrite and Temporal Expansion

Add bounded query rewrite and temporal subqueries.

Exit gate:

- Time-sensitive QA improves without increasing stale direct-use.
- Rewritten queries are recorded in recall trace.

### Phase 4: Reranker and Evidence Coverage

Add optional reranker and evidence coverage score.

Exit gate:

- `gold_in_top_8_after_rerank` improves.
- `answer_accuracy` improves while context remains compact.
- Reranker cannot override governance.

### Phase 5: Product Integration

Expose ordinary QA recall diagnostics in guide trace, operator snapshot, and
Flight Recorder.

Exit gate:

- Operators can see whether a failed answer was caused by retrieval miss,
  ranking miss, admission suppression, context budget, rehydrate miss, or Agent
  reading failure.

## Non-Goals

- Do not make ANN or reranker mandatory.
- Do not let any external vector backend return prompt-ready memory directly.
- Do not tune only for MemoryData if it regresses execution memory or Aionis
  governance.
- Do not hide weak QA recall results behind compression metrics.

## Relationship to Existing Roadmaps

- `docs/AIONIS_RECALL_ENGINE_ROADMAP.md` remains the general Candidate
  Retrieval Engine roadmap.
- This document is narrower: ordinary long-context QA and MemoryData-style
  factual retrieval.
- `docs/AIONIS_SUBSTRATE_INTEGRATION.md` remains evidence storage and mirror
  integration, not ordinary QA ranking.
- Admission policy work remains responsible for deciding memory influence after
  candidates are retrieved.

## First Concrete Task

Create a real ordinary-memory QA recall eval over Lite stores:

```text
write ordinary facts
write stale/conflicting facts
write aliases and temporal variants
ask QA-style questions
measure source-stage gold evidence flow
call /v1/guide
score final context and exact answer evidence availability
```

This eval now acts as the first gate for ordinary-memory construction and
candidate retrieval changes. Runtime changes should continue to move through the
same staged evidence flow: prove the miss, improve one retrieval layer, then
rerun the eval before changing guide admission or governance.
