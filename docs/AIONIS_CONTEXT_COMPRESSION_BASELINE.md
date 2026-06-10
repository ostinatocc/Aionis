# Aionis Context Compression Baseline

Date: 2026-06-10

Runtime workspace: `/Volumes/ziel/AionisRuntime-focused`

Recorded Runtime head: `04257f2`

Eval workspace: `/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark`

## Scope

This baseline measures state-preserving, auditable context compression. It asks
whether Aionis can compile long execution history into shorter Agent context
while preserving the execution state that matters for the next step.

It measures:

1. current executable state retention
2. failed branch and `do_not_use` retention
3. stale, contested, and contradicted memory suppression
4. reusable procedure retention
5. rehydrate pointer precision and recall
6. memory-use audit coverage
7. downstream next-action accuracy when LLM scoring is enabled

It does not measure GitHub issue solve rate, host framework quality, broad
external task success, or whether Runtime core should change based on a single
eval run.

## Source Reports

The current baseline is defined by these two reports:

1. Deterministic 100-scenario run:
   `/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-06-10T07-58-39-156Z/summary.json`
2. LLM-scored 24-scenario subset:
   `/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-06-10T08-03-35-087Z/summary.json`

Both reports use the same fixture:
`/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/fixtures/github-git-history-scenarios-v0.1.json`

The fixture is built from real public GitHub commit metadata and history.
Failed, stale, contested, and rehydrate expectations are benchmark-adjudicated
controls layered on top of that source material; they are not claims about the
upstream repositories.

## Methodology

The Aionis arm uses the product path:

```text
observe -> guide -> measure -> operator snapshot
```

The comparison arms are:

1. `full_history`: the whole history is exposed as context.
2. `naive_summary`: ordinary compressed summary context.
3. `raw_retrieval`: top-k style recall without Aionis state governance.
4. `aionis`: governed execution-state context compiled through Runtime APIs.

Provider compaction remains an optional arm and is not part of this baseline.

## Deterministic 100-Scenario Baseline

| Arm | Mean context chars | Compression | Current state recall | Negative memory recall | Procedure retention | Stale leak | Forbidden leak | Premise firewall | Rehydrate R/P | Audit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full History | 2735.55 | 0.0% | 100.0% | 100.0% | 100.0% | 13.0% | 100.0% | 0.0% | 0.0% / 0.0% | 0.0% |
| Naive Summary | 1411.05 | 47.5% | 100.0% | 87.0% | 100.0% | 13.0% | 87.0% | 0.0% | 0.0% / 0.0% | 0.0% |
| Raw Retrieval | 2314.71 | 14.2% | 100.0% | 51.0% | 99.0% | 13.0% | 57.0% | 0.0% | 0.0% / 0.0% | 0.0% |
| Aionis | 610.95 | 77.2% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% | 100.0% / 100.0% | 100.0% |

Threshold status: `pass`.

## LLM-Scored 24-Scenario Subset

| Arm | Mean context chars | Compression | Stale leak | Forbidden leak | Audit | Downstream action accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full History | 2688.13 | 0.0% | 12.5% | 100.0% | 0.0% | 75.0% |
| Naive Summary | 1403.04 | 46.8% | 12.5% | 87.5% | 0.0% | 62.5% |
| Raw Retrieval | 2274.88 | 14.1% | 12.5% | 56.3% | 0.0% | 70.8% |
| Aionis | 606.63 | 76.9% | 0.0% | 0.0% | 100.0% | 95.8% |

Threshold status: `pass`.

## Product Interpretation

The accepted product claim from this baseline is:

Aionis can preserve executable state with materially shorter, safer, and more
auditable Agent context than full history, naive summary, or raw retrieval in
this state-preserving compression suite.

The accepted engineering conclusions are:

1. Execution-state context should remain a primary product path.
2. Query-aware rehydrate pointers are part of the baseline behavior.
3. Memory-use receipts and decision traces are required for product-grade audit.
4. Ordinary recall and raw retrieval are insufficient for failed-path, stale,
   contradicted, and rehydrate-sensitive execution memory.

The baseline does not justify these claims:

1. Aionis solves GitHub issues.
2. Aionis beats every memory system on external task success.
3. Runtime core should learn task-specific rules from the fixture.
4. External eval failures should be promoted into product policy without
   separate evidence.

## Reproduction Notes

The current reports were generated with:

1. owned local Runtime: `true`
2. embedding provider: `minimax`
3. blocked status: `false`
4. scenario type coverage: long-running continuation, failed branch avoidance,
   stale premise resistance, contradicted memory, procedure reuse, rehydration
   needed, multi-agent handoff, and sparse feedback

Future compression evaluations should preserve this document as the baseline
record and write new report paths and deltas in follow-up docs or changelog
entries instead of overwriting these numbers.
