# Aionis Runtime End-to-End Performance Baseline

Generated: 2026-07-01T03:17:10.490Z

This report measures the local Aionis product loop over real HTTP/SDK calls:

`/v1/guide (baseline) -> /v1/observe -> /v1/guide -> /v1/measure`

`/v1/feedback` is included when the guide exposes attributable memory ids for the referenced guide trace.

It does not include external LLM latency. It does include openai/openai/text-embedding-3-large embedding latency for write/guide surfaces.

Embedding profile: openai / openai/text-embedding-3-large

## Summary

| Profile | Iterations | Baseline Guide P50/P95 | Observe P50/P95 | After Guide P50/P95 | Feedback P50/P95 | Measure P50/P95 | Total Loop P50/P95 | Prompt chars P50/P95 | Max RSS | SQLite final |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| runtime | 24 | 493.464 / 748.782 ms | 455.552 / 1571.115 ms | 47.885 / 68.585 ms | 6.623 / 10.096 ms | 2.849 / 7.47 ms | 1079.058 / 2163.294 ms | 1462 / 1463 | 47.672 MB | 5856 KB |

## Profile Notes

### runtime

- History-used rate: 100%
- Exposed memory IDs P50: 8
- Feedback attribution exercised: yes
- Zvec bytes final: n/a

## Caveats

- Local-machine diagnostic baseline; do not compare across machines without rerunning.
- LLM calls are disabled; openai/openai/text-embedding-3-large embedding provider latency is included for write and guide surfaces.
- Feedback attribution is measured only when the guide exposes memory ids for the referenced guide trace.
- Zvec, when present, is an optional candidate index profile; SQLite remains the truth source and governance still runs after candidate retrieval.
- This report measures product loop latency and resource footprint, not external task success rate.

## Raw Data

See `summary.json` in this directory for per-iteration rows.
