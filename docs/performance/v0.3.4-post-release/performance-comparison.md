# Aionis v0.3.4 Post-Release Runtime Performance A/B

Environment: Apple M3, Darwin arm64, Node v24.12.0, 24 measured iterations and
4 warmups per revision, Runtime-only Lite SQLite profile, no embedding or LLM
calls. Release `v0.3.4` (`aa04a10`) is compared with pre-refactor `ca4725d`.

| Round and order | Revision | Total P50 | Total P95 | Total P99 |
|---|---|---:|---:|---:|
| 1, release first | `v0.3.4` | 93.869 ms | 230.109 ms | 324.766 ms |
| 1, release first | `ca4725d` | 91.189 ms | 282.455 ms | 303.169 ms |
| 1 change |  | +2.94% | -18.53% | +7.12% |
| 2, baseline first | `ca4725d` | 90.691 ms | 251.570 ms | 262.934 ms |
| 2, baseline first | `v0.3.4` | 89.407 ms | 235.823 ms | 279.848 ms |
| 2 change |  | -1.42% | -6.26% | +6.43% |

## Decision

**Pass.** Both orderings stay inside the 10% P50/P95 regression budget. The
conservative reversed-order round improves P50 by 1.42% and P95 by 6.26%.
P99 is 6-7% higher in both rounds but remains inside 10% and is not the
committed release gate.

Context output is identical in both comparisons: 192 prompt characters, 48
estimated prompt tokens, no exposed memory in the no-embedding workload, and
zero history-use rate. Final SQLite size differs by less than 3% in either
direction.

Maximum RSS is order-sensitive: the release was 39.90% higher when it ran
first and 9.11% lower when it ran second. This two-round high-water metric is
therefore inconclusive rather than evidence of a stable memory regression.
