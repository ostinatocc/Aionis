# Recall ANN Provider Comparison

This is a recall-only comparison over real Lite stores. ANN providers only generate candidates; SQLite remains the fact source and governance still decides admission.

Output directory: `/Volumes/ziel/AionisRuntime-focused/docs/examples/recall-ann-provider-comparison`

| Provider | Recall@50 | Source coverage | Stale suppression | Failed blocking | Rehydrate | P50 ms | P95 ms | ANN cases | ANN ids |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| off | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | n/a | n/a | 0 | 0 |
| local | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | n/a | n/a | 17 | 32 |
| zvec | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | n/a | n/a | 17 | 32 |

Notes:
- `ann` source satisfies the semantic-source family because it is the semantic vector candidate implementation.
- Latency is local-machine diagnostic data. Use `--deterministic-latency` when committing stable fixture reports.
