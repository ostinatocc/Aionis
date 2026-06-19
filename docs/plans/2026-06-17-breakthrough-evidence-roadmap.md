# Breakthrough Evidence Roadmap

## Goal

Make Aionis provably better at memory admission, not merely broader as a
memory runtime.

The current Runtime already has the right product loop:

```text
observe -> guide -> agent action -> feedback -> measure -> snapshot / flight recorder
```

It also already exposes the data spine required for admission evidence:

- `AionisMemoryAdmissionRecord`
- SDK admission dataset JSONL helpers
- Memory Firewall for external candidates
- feedback attribution by `guide_trace_id` and `used_memory_ids`
- Agent Flight Recorder and operator snapshot replay surfaces

The missing product proof is not another subsystem. The missing proof is a
reproducible external result showing that Aionis makes better admission
decisions than raw retrieval, full-history transfer, summary memory, and
commodity memory backends under hard session cuts.

## Corrected Product Thesis

Do not describe Aionis as an empty judgment container. That is inaccurate: the
Runtime already has lifecycle, authority, scope, source, forgetting, rehydrate,
claim ledger, admission record, and flight-recorder surfaces.

The accurate thesis is:

> Aionis has a complete memory judgment loop. The next product step is to prove
> and improve judgment quality with external, repeatable evidence.

## Non-Goals

- Do not add a new Runtime core to run this roadmap.
- Do not mutate Runtime behavior from a single benchmark case.
- Do not turn Aionis into a model router or agent runner.
- Do not make end-to-end task success the only metric; it is too noisy to be
  the sole proof of memory governance.
- Do not delete speculative subsystems before mapping their product value,
  tests, and call sites.
- Do not build Cloud/SaaS control plane work before admission quality is
  externally credible.

## Phase 0: Prove The Problem Exists

### Purpose

Show that unmanaged memory transfer can hurt long-running coding agents, and
that Aionis reduces that harm across hard session boundaries.

This phase changes evaluation code and documentation only. It should not change
Runtime core logic.

### Evaluation Bed

Reuse the existing external-agent suite:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e
```

The suite already has:

- hard episode boundaries
- hand-audited trap manifests
- `no_memory`, `full_history`, and `aionis` arms
- Phase 1 and Phase 2 gradient reports
- detector-based wrong-branch scoring

Do not create a parallel benchmark unless this suite becomes unusable.

### Required Arms

Phase 0 minimum credible arms:

1. `no_memory`
2. `full_history`
3. `raw_retrieval` or `bm25_retrieval`
4. `mem0` or another commodity memory backend
5. `aionis`

`naive_summary`, `reflexion`, and `aionis_no_tree` are important but can wait
until the first five-arm run is stable.

### Primary Metrics

These are the Aionis-owned product metrics and must lead the report:

- `wrong_history_reuse_rate`
- `wrong_branch_action_rate`
- `repeated_failed_branch_steps`
- `stale_or_contested_direct_use_rate`
- `context_chars` and token cost
- `accepted_direction_rate`

### Secondary Metrics

These are required guardrails, but they should not be the only headline:

- `episode_2_success_rate`
- `first_correct_direction_step`
- `tool_call_count`
- `report_conflict_rate`
- `model_output_parse_failure_rate`

### Stop Conditions

Stop and diagnose before scaling if:

- detector hits require subjective judging
- the failed branch is too cheap, with mean rediscovery below five steps
- `full_history` and `aionis` are indistinguishable across dirty history levels
- Aionis lowers wrong-branch reuse but collapses accepted-direction rate
- the evidence stream gives Aionis structured labels that baselines cannot see

### Output Artifacts

Every run must produce:

```text
summary.json
summary.md
per_run_results.jsonl
failure_buckets.json
leaderboard.md
admission_dataset.jsonl
```

`admission_dataset.jsonl` should be produced from the existing SDK helpers when
the Aionis arm is present. It must not include full prompt payloads.

### Exit Standard

Phase 0 is successful only if the report can truthfully state a concrete
Aionis-owned advantage under hard episode cuts. The original target statement
was:

> In hard episode cuts with failed execution history, unmanaged memory transfer
> reuses wrong history more often than Aionis, while Aionis preserves accepted
> direction and keeps context cost controlled.

The 2026-06-19 five-arm external-agent rerun refined that claim. It did not
show that Aionis uniquely prevents wrong-branch writes: `full_history`,
`bm25_retrieval`, `mem0`, and `aionis` all reached 0% wrong writes in that run.
It did show a stronger and more stable product claim:

> Aionis preserves the accepted execution route with full-history-level safety
> while using far less prompt context than full-history transfer or generic
> memory retrieval.

Treat route-safe context compression as the current Phase 0 evidence win. If a
future run does not preserve accepted direction, does not reduce context cost,
or leaks failed/stale branch targets into direct-use context, bucket the failure
before changing Runtime behavior.

## Phase 1: Admission Judgment Dataset

### Purpose

Turn Aionis' feedback attribution loop into a labeled, versioned admission
dataset.

### Existing Foundation

This is already partially implemented:

- product contract: `AionisMemoryAdmissionRecord`
- SDK export helpers:
  - `memoryAdmissionDatasetRowsFromGuide`
  - `memoryAdmissionDatasetJsonlFromGuide`
  - `memoryAdmissionDatasetRowsFromRecord`
  - `memoryAdmissionDatasetJsonlFromRecords`
- feedback attribution guard:
  - feedback by `guide_trace_id`
  - feedback only to memory IDs exposed by that guide

### Label Taxonomy

Do not label every successful task as proof that every exposed memory was
useful. Use conservative labels:

- `positive_attributed`: exposed, reported used, outcome positive
- `negative_attributed`: exposed, reported used, outcome negative and bucketed
- `exposed_unused`: exposed but not reported used
- `correctly_suppressed`: suppressed and later confirmed unsafe or stale
- `possible_false_suppression`: suppressed but later needed
- `counterfactual_unknown`: not enough evidence
- `inconclusive`: host did not supply sufficient feedback

### Policy Evaluation

Before training anything, make the current policy measurable:

- admission precision by action bucket
- recall for failed/stale/contested memories
- calibration curve for any confidence field
- per-domain and per-memory-type breakdowns
- policy version comparison

LLM or learned policies may only propose candidates or soft rankings. They must
not bypass lifecycle, scope, source, suppression, rehydrate, or authority gates.

## Phase 2: Failed Branch As Counter-Evidence

### Purpose

Prove Aionis' sharpest execution-memory claim:

> A failed branch is counter-evidence, not reusable instruction text.

### Baselines

Compare:

1. raw retrieval
2. full history
3. Reflexion-style natural language reflection
4. Aionis failed-branch counter-evidence

### Primary Metrics

- repeated attempts on the same failed branch
- cross-session failed-branch leakage
- accepted-direction preservation
- task success as a guardrail
- token and context cost

This is the most likely public-facing experiment because the mechanism is clear
and hard for ordinary recall memory to copy.

## Phase 3: Complexity Freeze And Surface Map

### Purpose

Stop adding speculative mechanisms until evidence shows which ones matter.

### Freeze Rule

These surfaces should receive no new product features until Phase 0/1 evidence
requires them:

- runtime entropy expansion
- delegation learning expansion
- policy mutation expansion
- pattern trust expansion
- lifecycle shadow model expansion

Freeze does not mean delete. It means:

- keep tests passing
- fix correctness and security defects
- avoid new public API surface
- map call sites and product value before refactoring

### Refactor Targets

The current hot files are large enough to raise maintenance risk:

- `src/memory/product-output-assembler.ts`
- `src/routes/product-facade.ts`
- `src/store/lite-write-store.ts`
- `src/memory/product-output-contract.ts`

Refactoring should be driven by stable product seams, not line-count goals
alone.

## Phase 4: Productization After Evidence

Only start aggressive product packaging after Phase 0 and Phase 1 produce
credible numbers.

Preferred packaging:

- open source Runtime core, SDK, MCP, Memory Firewall interface, Flight Recorder
  report format, and benchmark harness
- hosted or managed policy calibration as the commercial layer
- public benchmark reports with reproducible fixtures

Keep Managed Server Edition scoped to a self-hostable service endpoint. Do not
build SaaS control plane, billing, dashboard, organization management, or SSO
until admission quality is already credible.

## Immediate Work Order

1. Update the external-agent E2E suite with this charter and output contract.
2. Add or stabilize `raw_retrieval` / `bm25_retrieval` as the next baseline arm.
3. Add `mem0` only after the raw retrieval arm is deterministic.
4. Export Aionis arm admission dataset JSONL from existing guide records.
5. Produce one five-arm report before changing Runtime policy.
6. Separately fix low-risk correctness issues, such as unifying claim-ledger
   transaction handling with the existing SQLite transaction runner.
