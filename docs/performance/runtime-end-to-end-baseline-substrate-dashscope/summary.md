# Aionis Runtime End-to-End Performance Baseline

Generated: 2026-07-01T03:48:43.142Z

This report measures the local Aionis product loop over real HTTP/SDK calls:

`/v1/guide (baseline) -> /v1/observe -> /v1/guide -> /v1/measure`

`/v1/feedback` is included when the guide exposes attributable memory ids for the referenced guide trace.

It does not include external LLM latency. It does include dashscope/text-embedding-v4 embedding latency for write/guide surfaces.

Embedding profile: dashscope / text-embedding-v4

## Summary

| Profile | Iterations | Baseline Guide P50/P95 | Observe P50/P95 | Substrate Sync P50/P95 | After Guide P50/P95 | Feedback P50/P95 | Measure P50/P95 | Total Loop P50/P95 | Prompt chars P50/P95 | Max RSS | SQLite final |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| substrate | 24 | 270.616 / 336.24 ms | 236.168 / 308.016 ms | 14.579 / 24.517 ms | 46.133 / 61.319 ms | 5.471 / 6.917 ms | 2.81 / 3.373 ms | 567.972 / 697.654 ms | 1475 / 1476 | 71.813 MB | 5900 KB |

## Profile Notes

### substrate

- History-used rate: 100%
- Exposed memory IDs P50: 8
- Feedback attribution exercised: yes
- Zvec bytes final: n/a

## Caveats

- Local-machine diagnostic baseline; do not compare across machines without rerunning.
- LLM calls are disabled; dashscope/text-embedding-v4 embedding provider latency is included for write and guide surfaces.
- Feedback attribution is measured only when the guide exposes memory ids for the referenced guide trace.
- Zvec, when present, is an optional candidate index profile; SQLite remains the truth source and governance still runs after candidate retrieval.
- This report measures product loop latency and resource footprint, not external task success rate.

## Raw Data

See `summary.json` in this directory for per-iteration rows.
