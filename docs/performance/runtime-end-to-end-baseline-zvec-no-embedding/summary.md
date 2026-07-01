# Aionis Runtime End-to-End Performance Baseline

Generated: 2026-07-01T03:44:14.981Z

This report measures the local Aionis product loop over real HTTP/SDK calls:

`/v1/guide (baseline) -> /v1/observe -> /v1/guide -> /v1/measure`

`/v1/feedback` is included when the guide exposes attributable memory ids for the referenced guide trace.

It does not include external LLM latency or external embedding provider latency. Embedding is disabled so the numbers isolate Runtime overhead.

Embedding profile: none

## Summary

| Profile | Iterations | Baseline Guide P50/P95 | Observe P50/P95 | After Guide P50/P95 | Feedback P50/P95 | Measure P50/P95 | Total Loop P50/P95 | Prompt chars P50/P95 | Max RSS | SQLite final |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| zvec | 24 | 6.215 / 15.012 ms | 6.778 / 15.864 ms | 6.688 / 16.368 ms | n/a | 1.167 / 1.777 ms | 20.696 / 47.996 ms | 192 / 192 | 73.219 MB | 5164 KB |

## Profile Notes

### zvec

- History-used rate: 0%
- Exposed memory IDs P50: 0
- Feedback attribution exercised: no
- Zvec bytes final: 0 KB

## Caveats

- Local-machine diagnostic baseline; do not compare across machines without rerunning.
- Embedding provider and LLM calls are disabled to isolate Runtime HTTP/SDK overhead.
- The no-embedding profile may not exercise feedback attribution because guide only accepts feedback for memory ids exposed by the referenced guide trace.
- Zvec, when present, is an optional candidate index profile; SQLite remains the truth source and governance still runs after candidate retrieval.
- This report measures product loop latency and resource footprint, not external task success rate.

## Raw Data

See `summary.json` in this directory for per-iteration rows.
