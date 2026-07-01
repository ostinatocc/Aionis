# Aionis Evidence Index

Status: current v0.3 evidence map

Date: 2026-07-01

This index points to the evidence that currently supports Aionis' public product
claims. It is intentionally an index, not a replacement for the source reports.
Each claim below should remain tied to a committed report, a public benchmark
release, or a reproducible runbook.

## Product Claims Supported Today

| Claim | Current evidence | Source |
|---|---:|---|
| Shorter, governed execution context can preserve continuation state. | 40/40 external continuation tasks completed; 61.4% fewer prompt tokens than Full History; 40.7% fewer prompt tokens than Mem0. | [`docs/research/2026-06-28-aionis-evaluation-evidence-report.md`](research/2026-06-28-aionis-evaluation-evidence-report.md) |
| Buried history can be kept usable without exposing the full raw history. | On buried histories, 100% completion with 83.0% fewer prompt tokens than Full History. | [`docs/research/2026-06-28-aionis-evaluation-evidence-report.md`](research/2026-06-28-aionis-evaluation-evidence-report.md) |
| State-preserving compression keeps current state, stale filtering, rehydrate pointers, and audit coverage visible. | 76.9% compression, 100% current-state recall, 0% stale leak, 100% rehydrate, 100% audit, 95.8% downstream action accuracy on the LLM-scored subset. | [`docs/AIONIS_CONTEXT_COMPRESSION_BASELINE.md`](AIONIS_CONTEXT_COMPRESSION_BASELINE.md) |
| MGBench product path recovers active state with governed output. | MGBench v0.1.1 strict ID-neutral + Zvec ANN: 40/40 product-positive, 100% active-state recovery, 0/40 unsafe direct-use, 100% rehydrate, 100% trace. | [`docs/research/2026-06-28-aionis-evaluation-evidence-report.md`](research/2026-06-28-aionis-evaluation-evidence-report.md), [MGBench DOI](https://doi.org/10.5281/zenodo.20793097) |
| Ordinary factual recall has improved beyond the initial weak recall baseline. | MemoryData 50-sample replay: exact answer 43/50 -> 48/50; evidence coverage 47/50 -> 50/50; Substrate source trace 50/50. | `/Volumes/ziel/AionisRuntime-evals/memorydata-slices/reports/aionis-memorydata-runtime-substrate-0-1-10-guide-replay-full-2026-06-30T08-55-24-533Z.json` |
| Runtime governance overhead is small compared with embedding-provider latency. | Runtime-only product loop P50/P95: 21.3/45.5 ms. With real embeddings, total P50 moves to 0.5-1.1s. Substrate mirror adds roughly 12-15 ms P50. | [`docs/performance/AIONIS_RUNTIME_PERFORMANCE_BASELINE.md`](performance/AIONIS_RUNTIME_PERFORMANCE_BASELINE.md) |
| External Agent host integration works outside the Runtime test harness. | Two separate Claude Code sessions: Aionis injected prior active route state into episode 2, recorded tool outcomes, and the project tests passed. | [`docs/AIONIS_EXTERNAL_CLAUDE_CODE_LONGFLOW.md`](AIONIS_EXTERNAL_CLAUDE_CODE_LONGFLOW.md), [`docs/examples/external-claude-code-longflow-result.json`](examples/external-claude-code-longflow-result.json) |
| Admission policy can be measured and improved as a data flywheel. | 411-row admission dataset baseline with offline policy comparison; active gray and real-Agent rerun reports exist under research docs. | [`docs/research/2026-06-18-admission-dataset-batch-baseline.md`](research/2026-06-18-admission-dataset-batch-baseline.md), [`docs/research/2026-06-18-admission-active-gray-real-agent-rerun.md`](research/2026-06-18-admission-active-gray-real-agent-rerun.md) |

## Evidence Categories

### External Agent Context Stability

Primary artifact:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/external-credibility-five-arm-all40-rehydrate-mem0deps-2026-06-28/
```

Committed summary:

```text
docs/research/2026-06-28-aionis-evaluation-evidence-report.md
```

Use this evidence for claims about compact continuation context and token cost.
Do not use it as a broad GitHub issue-solving benchmark.

### MGBench

Public benchmark release:

```text
https://github.com/ostinatocc/MGBench/releases/tag/v0.1.1
DOI: 10.5281/zenodo.20793097
```

Primary local reports:

```text
/Volumes/ziel/MGBench/reports/aionis-v0.3-context-reliability/summary.md
/Volumes/ziel/MGBench/reports/aionis-v0.3-context-reliability/summary.json
```

Use this evidence for memory governance under interference, active-state
recovery, rehydrate coverage, and trace coverage.

### State-Preserving Context Compression

Committed summary:

```text
docs/AIONIS_CONTEXT_COMPRESSION_BASELINE.md
```

Primary eval reports:

```text
/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-06-10T07-58-39-156Z/summary.json
/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/state-compression-2026-06-10T08-03-35-087Z/summary.json
/Volumes/ziel/AionisRuntime-evals/state-preserving-compression-benchmark/reports/unlabelled-lifecycle-2026-06-10T12-26-37-752Z/summary.json
```

Use this evidence for state-preserving compression, rehydrate pointers, audit
coverage, and context cleanliness.

### Ordinary Memory / MemoryData

Committed Runtime recall gate:

```text
docs/examples/ordinary-memory-retrieval-baseline-summary.json
```

External MemoryData replay:

```text
/Volumes/ziel/AionisRuntime-evals/memorydata-slices/reports/aionis-memorydata-runtime-substrate-0-1-10-guide-replay-full-2026-06-30T08-55-24-533Z.json
```

Use this evidence for ordinary factual recall improvements. Keep it separate
from execution-memory claims: MemoryData-style QA is a recall/ranking workload,
while execution memory is a governed state-continuation workload.

### Runtime Performance

Committed summary:

```text
docs/performance/AIONIS_RUNTIME_PERFORMANCE_BASELINE.md
```

Run command:

```bash
npm run -s runtime:perf:baseline
```

Use this evidence for local Runtime overhead and provider-latency analysis.
Embedding providers dominate the measured loop latency; Substrate and Zvec are
not the main latency drivers in the current local baseline.

### External Claude Code Case

Committed case:

```text
docs/AIONIS_EXTERNAL_CLAUDE_CODE_LONGFLOW.md
docs/examples/external-claude-code-longflow-result.json
```

Use this evidence to show that Aionis can operate beside a real external Agent
host. It is a product case, not a benchmark.

## Claim Hygiene

Use:

- "Aionis compiles shorter, cleaner, auditable execution context."
- "Aionis preserves active state across sessions while exposing admission
  decisions and rehydrate pointers."
- "Aionis can govern memory candidates from its own Runtime, Substrate, or
  external memory systems before they enter Agent context."

Avoid using any single diagnostic run as a broad product claim. When a result is
diagnostic, keep it in diagnostics. When a result is product-path, cite the exact
report and scenario count.

