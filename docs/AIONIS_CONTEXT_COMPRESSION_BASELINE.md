# Aionis Context Compression Baseline

Date: 2026-06-10

Runtime workspace: `/Volumes/ziel/AionisRuntime-focused`

Recorded Runtime heads:

1. `04257f2` for the original deterministic and LLM-scored compression reports.
2. `14b285d` for the 200-scenario unlabelled lifecycle holdout and real Agent
   downstream demo.

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

The current baseline is defined by these reports:

1. Deterministic 100-scenario run:
   `/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-06-10T07-58-39-156Z/summary.json`
2. LLM-scored 24-scenario subset:
   `/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-06-10T08-03-35-087Z/summary.json`
3. Unlabelled lifecycle 200-scenario paraphrase holdout:
   `/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/unlabelled-lifecycle-2026-06-10T12-26-37-752Z/summary.json`
4. Real LLM downstream Agent demo:
   `/Volumes/ziel/AionisRuntime-focused/.tmp/runtime-agent-e2e/suite-2026-06-10T12-48-41-477Z-e4bc3df7.summary.json`

The first two reports use the same fixture:
`/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/fixtures/github-git-history-scenarios-v0.1.json`

The 200-scenario holdout uses:
`/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/fixtures/github-git-history-holdout-200-v0.1.json`

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

## Unlabelled Lifecycle 200-Scenario Holdout

This run removes structured memory kind and lifecycle labels from the input
history, scrubs lifecycle cue wording, and uses a paraphrase holdout. The goal
is to check whether Runtime can infer useful lifecycle posture from execution
history structure instead of relying on pre-labelled memory rows.

| Arm | Scenarios | Current state recall | Use-now recall | Negative recall | Stale recall | Procedure retention | Rehydrate recall | Forbidden direct-use | Stale direct-use |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Builtin textual inference | 200 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Aionis Runtime unlabelled | 200 | 96.5% | 96.8% | 98.0% | 100.0% | 97.0% | 100.0% | 2.0% | 0.0% |

Scenario coverage is balanced across long-running continuation, failed branch
avoidance, stale premise resistance, contradicted memory, procedure reuse,
rehydration needed, multi-agent handoff, and sparse feedback.

Threshold status: `informational pass with failure buckets`.

Important failure bucket: 4 of 200 Runtime scenarios still leaked forbidden
direct-use, and 15 of 200 had at least one recall miss. These are evaluation
evidence and must not be converted into Runtime rules unless repeated
cross-suite evidence shows the same general failure.

## Real LLM Downstream Agent Demo

This run is not a compression benchmark arm. It is a downstream product demo
that gives a real LLM one of three contexts: no prior memory, raw long context,
or Aionis execution context. The Agent must choose the next action from a small
allowed set after Runtime writes branch-aware execution history.

Run id:
`suite-2026-06-10T12-48-41-477Z-e4bc3df7`

| Group | Trials | Success | Failed branch leakage | Evidence-backed outcomes | Avg request chars | Avg total tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 9 | 0.0% | 0.0% | 0.0% | 2045.33 | 629.44 |
| Long context | 9 | 100.0% | 0.0% | 0.0% | 3773.67 | 1092.44 |
| Aionis | 9 | 100.0% | 0.0% | 100.0% | 3491.00 | 1192.56 |

Product demo gate:

| Metric | Result |
| --- | ---: |
| Aionis success rate | 100.0% |
| Aionis failed branch leakage | 0.0% |
| Aionis evidence-backed feedback | 100.0% |
| Route-separated execution rows | 6 / 6 |
| Summary-only guarded rows | 3 / 3 |
| Execution context compression vs raw long history | 24.4% |

Threshold status: `pass`.

Accepted interpretation: Aionis can give a real LLM shorter execution-state
context than raw long history while preserving the active branch, suppressing
failed branch direct use, and recording feedback attribution. The run does not
claim Aionis owns the external task execution layer.

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
5. Unlabelled execution-like history can be governed through Runtime lifecycle
   inference, but the 200-scenario holdout still leaves explicit failure
   buckets that should be tracked before broader claims.
6. The real Agent demo is valid product evidence for downstream context effects,
   not a broad benchmark result.

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

The 200-scenario holdout was generated from public GitHub commit metadata with
balanced scenario types. The real Agent demo was run with `deepseek-v4-flash`
for chat completions and `minimax` embeddings through the local Runtime e2e
scripts. API keys are not stored in this repository, and `.tmp` report artifacts
are intentionally not committed.
