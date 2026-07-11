# Aionis Runtime Performance Baseline

Generated: 2026-07-01

This report summarizes local end-to-end Runtime measurements over real HTTP/SDK
calls:

```text
/v1/guide baseline -> /v1/observe -> optional Substrate mirror -> /v1/guide -> /v1/feedback -> /v1/measure
```

No external LLM generation is included. When an embedding provider is enabled,
the measured loop includes real embedding provider latency for write and guide
surfaces.

## Test Environment

| Item | Value |
|---|---|
| Host | local macOS / darwin arm64 |
| Node | v24.12.0 |
| CPU count | 8 |
| Iterations | 24 measured, 4 warmup |
| Rate limits | disabled |
| Runtime store | Lite SQLite |

## Headline

Aionis Runtime overhead is small. The dominant latency source is the embedding
provider.

Runtime-only, no-embedding loop P50/P95 is 21.3 / 45.5 ms. With real embedding
providers, total loop P50 moves into the 0.5-1.1 second range. Substrate mirror
adds roughly 12-15 ms P50. Zvec changes candidate generation behavior and storage
footprint, but does not dominate latency in these small local runs.

## 2026-07-10 Complexity Exit A/B

The complexity-reduction exit review reran the same Runtime-only command in
the refactored worktree and a clean pre-refactor `ca4725d` worktree under the
same current machine conditions:

| Revision | Total P50 | Total P95 |
|---|---:|---:|
| Pre-refactor `ca4725d` | 79.924 ms | 238.709 ms |
| Refactored `3060ca1` | 78.004 ms | 245.123 ms |
| Change | -2.40% | +2.69% |

Both percent changes are within the 10% exit budget. The July 1 absolute
21.344 / 45.521 ms baseline remains useful historical evidence, but it is not
the exit comparator: current ambient machine conditions produced much higher
absolute latency in both worktrees.

## 2026-07-11 Temporary Transport Removal A/B

The temporary-transport exit comparison used the same Runtime-only,
no-embedding workload in the current worktree and the pre-phase `421ca12`
checkpoint. Each run used 24 measured iterations after 4 warmups on the same
darwin arm64 host with Node v24.12.0, disabled rate limits, no LLM calls, and
Lite SQLite. The order was reversed in a second round to expose order or
ambient-machine effects.

| Round and order | Revision | Total P50 | Total P95 |
|---|---|---:|---:|
| 1, current first | Pre-phase `421ca12` | 181.074 ms | 334.297 ms |
| 1, current first | Current `1a46455` + verification fix | 92.313 ms | 267.684 ms |
| 1 change |  | -49.02% | -19.93% |
| 2, baseline first | Pre-phase `421ca12` | 174.913 ms | 314.186 ms |
| 2, baseline first | Current `1a46455` + verification fix | 150.824 ms | 312.650 ms |
| 2 change |  | -13.77% | -0.49% |

Neither order showed a regression. The more conservative reversed-order round
shows P50 improving 13.77% and P95 effectively flat at -0.49%; therefore the
phase satisfies the no-more-than-10% regression gate. Absolute timings vary
substantially between adjacent local runs, so this evidence supports a
non-regression conclusion rather than a stable throughput claim.

## 2026-07-11 v0.3.4 Post-Release A/B

The stable `v0.3.4` tag (`aa04a10`) was compared with frozen pre-refactor
`ca4725d` in two order-controlled Runtime-only rounds on the same Apple M3,
Node v24.12.0 host. Each revision used 24 measured iterations after 4 warmups,
Lite SQLite, disabled rate limits, and no embedding or LLM calls.

| Round and order | Revision | Total P50 | Total P95 | Total P99 |
|---|---|---:|---:|---:|
| 1, release first | `v0.3.4` | 93.869 ms | 230.109 ms | 324.766 ms |
| 1, release first | `ca4725d` | 91.189 ms | 282.455 ms | 303.169 ms |
| 1 change |  | +2.94% | -18.53% | +7.12% |
| 2, baseline first | `ca4725d` | 90.691 ms | 251.570 ms | 262.934 ms |
| 2, baseline first | `v0.3.4` | 89.407 ms | 235.823 ms | 279.848 ms |
| 2 change |  | -1.42% | -6.26% | +6.43% |

Both orderings pass the 10% P50/P95 regression budget. P99 remains inside 10%
but is not the committed gate. Maximum RSS changed direction with run order and
is classified as inconclusive. Full artifacts are under
`docs/performance/v0.3.4-post-release/`.

## Summary Matrix

| Configuration | Embedding model | Total P50 | Total P95 | Total P99 | History used | Exposed IDs P50 | Feedback attribution |
|---|---|---:|---:|---:|---:|---:|---|
| Runtime only | none | 21.3 ms | 45.5 ms | 48.1 ms | 0% | 0 | no |
| Runtime | DashScope `text-embedding-v4` | 577.8 ms | 662.4 ms | 663.6 ms | 100% | 8 | yes |
| Runtime + Zvec | DashScope `text-embedding-v4` | 543.5 ms | 696.7 ms | 736.6 ms | 100% | 8 | yes |
| Runtime + Substrate sidecar | DashScope `text-embedding-v4` | 568.0 ms | 697.7 ms | 743.8 ms | 100% | 8 | yes |
| Runtime + Zvec + Substrate sidecar | DashScope `text-embedding-v4` | 618.8 ms | 1277.1 ms | 3979.2 ms | 100% | 8 | yes |
| Runtime | MiniMax `embo-01` | 713.7 ms | 1012.4 ms | 1089.6 ms | 100% | 8 | yes |
| Runtime | OpenRouter `google/gemini-embedding-2` | 851.7 ms | 1391.7 ms | 1450.8 ms | 100% | 8 | yes |
| Runtime | OpenRouter `openai/text-embedding-3-large` | 1079.1 ms | 2163.3 ms | 12061.8 ms | 100% | 8 | yes |

## Endpoint Breakdown

| Configuration | Baseline guide P50/P95 | Observe P50/P95 | Substrate sync P50/P95 | After guide P50/P95 | Measure P50/P95 |
|---|---:|---:|---:|---:|---:|
| Runtime only | 6.5 / 14.1 ms | 7.2 / 15.1 ms | n/a | 6.8 / 15.2 ms | 1.2 / 2.1 ms |
| Runtime + DashScope | 267.1 / 339.3 ms | 223.2 / 253.1 ms | n/a | 59.5 / 84.2 ms | 3.9 / 5.2 ms |
| Runtime + Zvec + DashScope | 268.8 / 379.6 ms | 230.5 / 270.2 ms | n/a | 40.0 / 71.4 ms | 2.6 / 3.6 ms |
| Runtime + Substrate + DashScope | 270.6 / 336.2 ms | 236.2 / 308.0 ms | 14.6 / 24.5 ms | 46.1 / 61.3 ms | 2.8 / 3.4 ms |
| Runtime + Zvec + Substrate + DashScope | 285.8 / 656.0 ms | 276.5 / 941.2 ms | 11.6 / 16.2 ms | 44.7 / 61.6 ms | 3.0 / 3.5 ms |
| Runtime + MiniMax | 341.4 / 533.4 ms | 291.0 / 425.9 ms | n/a | 50.1 / 69.6 ms | 2.9 / 4.8 ms |
| Runtime + OpenRouter Gemini | 406.8 / 517.7 ms | 391.5 / 625.7 ms | n/a | 53.0 / 73.6 ms | 3.0 / 3.4 ms |
| Runtime + OpenRouter OpenAI large | 493.5 / 748.8 ms | 455.6 / 1571.1 ms | n/a | 47.9 / 68.6 ms | 2.8 / 7.5 ms |

## Resource Footprint

| Configuration | Max RSS | SQLite final | Zvec final |
|---|---:|---:|---:|
| Runtime only | 71.8 MB | 5.0 MB | n/a |
| Runtime + DashScope | 60.7 MB | 5.8 MB | n/a |
| Runtime + Zvec + DashScope | 72.1 MB | 5.7 MB | 5.6 MB |
| Runtime + Substrate + DashScope | 71.8 MB | 5.8 MB | n/a |
| Runtime + Zvec + Substrate + DashScope | 73.6 MB | 5.8 MB | 5.6 MB |
| Runtime + MiniMax | 72.2 MB | 5.8 MB | n/a |
| Runtime + OpenRouter Gemini | 88.0 MB | 5.5 MB | n/a |
| Runtime + OpenRouter OpenAI large | 47.7 MB | 5.7 MB | n/a |

## Interpretation

- Runtime-only overhead is tens of milliseconds. The product loop is not CPU-bound
  by Aionis governance in this local baseline.
- Embedding provider latency is the primary cost. DashScope `text-embedding-v4`
  was the fastest and most stable provider in this run.
- Substrate sidecar mirroring is cheap in this local loop: about 12-15 ms P50 and
  under 25 ms P95. It does not materially change the product-loop latency profile.
- Zvec adds a persisted candidate index and about 5.6 MB of local index data in
  this run. In the small local workload, it does not dominate latency.
- The full local stack (`Runtime + Zvec + Substrate + DashScope`) works end to
  end with feedback attribution and history use enabled. Its P95 was higher in
  this run because upstream embedding calls had a longer tail; Substrate sync
  itself stayed around 16 ms P95.
- OpenRouter Gemini was usable but slower than DashScope and MiniMax. OpenRouter
  OpenAI large showed the largest long tail in this run.

## Source Reports

- `docs/performance/runtime-end-to-end-baseline-runtime-no-embedding/summary.json`
- `docs/performance/runtime-end-to-end-baseline/summary.json`
- `docs/performance/runtime-end-to-end-baseline-zvec-dashscope/summary.json`
- `docs/performance/runtime-end-to-end-baseline-substrate-dashscope/summary.json`
- `docs/performance/runtime-end-to-end-baseline-zvec-substrate-dashscope/summary.json`
- `docs/performance/runtime-end-to-end-baseline-minimax/summary.json`
- `docs/performance/runtime-end-to-end-baseline-openrouter-gemini-embedding-2/summary.json`
- `docs/performance/runtime-end-to-end-baseline-openrouter-openai-large/summary.json`

## Caveats

- These are local-machine diagnostic measurements, not a hosted service SLA.
- The workload is a small repeated product-loop workload, not a large production
  corpus stress test.
- Provider numbers include real network calls and can change with upstream load,
  region, quota, and routing.
- Zvec was exercised as an optional candidate index. Runtime SQLite remained the
  truth source and Aionis governance still ran after candidate retrieval.
- Substrate was exercised as a sidecar mirror and candidate source. It did not
  replace Runtime storage or policy.
