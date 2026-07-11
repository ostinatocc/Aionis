# v0.3.4 State Compression and Memory Firewall Checkpoint

Decision: **the v0.3.4 regression is resolved on the fix branch**. Memory
governance and safety remain intact, and the corrected prompt projection is
smaller than both the released build and the frozen pre-refactor comparator.

## Frozen A/B result

| Metric | `ca4725d` comparator | `v0.3.4` | Fix `e5cc4dc` |
| --- | ---: | ---: | ---: |
| Scenarios | 24 | 24 | 24 |
| Blocked scenarios | 0 | 0 | 0 |
| Mean Aionis context chars | 868.79 | 1181.75 | 742.38 |
| Mean compression ratio | 20.80% | 5.31% | 32.44% |
| Current-state recall | 100% | 100% | 100% |
| Use-now recall | 100% | 100% | 100% |
| Negative-memory recall | 100% | 100% | 100% |
| Procedure retention | 100% | 100% | 100% |
| Stale leak | 0% | 0% | 0% |
| Forbidden leak | 0% | 0% | 0% |
| Rehydrate recall | 100% | 100% | 100% |
| Audit coverage | 100% | 100% | 100% |

Raw reports:

- Release: `/Volumes/ziel/new.aionis/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-07-11T06-19-26-323Z`
- Comparator: `/Volumes/ziel/new.aionis/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-07-11T06-22-07-251Z`
- Fix: `/Volumes/ziel/new.aionis/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-07-11T06-47-19-839Z`

The fixed projection reduces mean context characters by 37.18% versus the
release and by 14.55% versus the pre-refactor comparator. The quality and
safety surfaces are unchanged. The small fixture means none of the arms meets
the plan's absolute 70% compression target; the defensible result here is the
same-run relative A/B.

## Root cause

The benchmark requests `context_compaction_profile=aggressive`. Two refactor
parity defects caused the regression:

1. Guide service explicitly supplied `render_detail=standard`, overriding the
   compiler's `aggressive -> contract` fallback.
2. The centralized contract renderer used non-compact limits for a standard
   agent mode and treated generic reference evidence as accepted evidence.

Observed output contract change:

- Comparator: `AIONIS_CTX v2`
- Release: `AIONIS_AGENT_CONTEXT v1`

The fix restores compiler-owned render selection, preserves aggressive mode
during active inspect projection, applies compact contract limits, and only
emits accepted-reference evidence for accepted outcomes.

## Memory Firewall result

The deterministic 12-case gate passes and exactly matches the documented
historical baseline:

| Metric | Mem0 raw | Mem0 + Aionis Firewall |
| --- | ---: | ---: |
| Wrong direct-use case rate | 83.33% | 0% |
| Primary route chosen | 33.33% | 100% |
| Current route recall | 100% | 100% |
| Audit coverage | 0% | 100% |
| Mean prompt chars | 541.17 | 721.83 |

Raw report:

- Release: `/Volumes/ziel/new.aionis/AionisRuntime-evals/product-mem0-firewall-ab/reports/mem0-firewall-ab-2026-07-11T06-21-35-593Z.json`
- Fix: `/Volumes/ziel/new.aionis/AionisRuntime-evals/product-mem0-firewall-ab/reports/mem0-firewall-ab-2026-07-11T06-49-34-604Z.json`

## Gate disposition

The local regression is resolved on `fix/v0.3.4-aggressive-compaction` at
`e5cc4dc`. After the final full Runtime verification, external Agent/MGBench
readiness and cost estimation may proceed. Paid-model execution still requires
explicit approval.
