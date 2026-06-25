# Zvec Recall Scale Comparison

This recall-only diagnostic uses real Lite SQLite stores plus optional ANN sidecars. It stresses the known bounded-scan failure mode: a semantically exact but low-salience memory can sit outside SQLite's prefetch window.

| Provider | Nodes | Queries | Recall@10 | Recall@50 | Rank-1 | P50 ms | P95 ms | Rebuild ms | ANN ids | SQLite truth |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| off | 4096 | 20 | 0.0000 | 0.0000 | 0.0000 | 20.2689 | 23.8985 | n/a | 0 | pass |
| local | 4096 | 20 | 1.0000 | 1.0000 | 1.0000 | 6.3150 | 8.8732 | 22.2582 | 1000 | pass |
| zvec | 4096 | 20 | 1.0000 | 1.0000 | 1.0000 | 5.7017 | 8.4015 | 558.0211 | 1000 | pass |

Interpretation:
- `off` is the bounded SQLite JSON-vector scan path.
- `local` and `zvec` use ANN only for candidate generation; final candidate rows are still loaded from SQLite truth.
- This is not an admission or governance benchmark. It isolates candidate retrieval under a large hot-memory scope.
