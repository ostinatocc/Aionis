# External Agent E2E Five-Arm Full Run

Date: 2026-06-19

Latest stable run ID: `phase2-gradient-five-arm-route-contract-rerun-2026-06-19`

This document records the current 40-record, five-arm external-agent evidence
baseline after the route-contract target projection fix in commit `bc1f081`.

Reports:

- Summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-route-contract-rerun-2026-06-19/summary.md`
- Machine summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-route-contract-rerun-2026-06-19/summary.json`
- Per-trap JSONL: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-route-contract-rerun-2026-06-19/phase2-gradient-results.jsonl`

Previous pre-fix run:

- Run ID: `phase2-gradient-five-arm-scopekey-fixed-2026-06-19`
- Summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/summary.md`
- Machine summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/summary.json`

## Setup

The latest run used the full 40-record phase-2 gradient manifest across five
arms:

- `no_memory`
- `full_history`
- `bm25_retrieval`
- `mem0`
- `aionis`

The Agent command was the real DeepSeek multi-step runner. The reported model
was `deepseek-v4-flash`.

Runtime status:

- Aionis Runtime Lite on `http://127.0.0.1:3019`
- Runtime embedding provider: MiniMax external runtime
- Requested records: `40`
- Completed records: `40`
- Failed records: `0`

Mem0 caveats:

- `spaCy` was not installed, so Mem0 NLP enrichment was unavailable.
- `fastembed` was not installed, so Mem0 BM25 keyword search was disabled.
- Mem0 results should be read as this exact local configuration, not as a tuned
  hosted Mem0 deployment.

Evaluation boundary:

- This is an external-agent route-safety and context-cost evaluation.
- It is not a broad claim about final GitHub issue success rate.
- It measures whether the next session stays on the accepted execution route,
  avoids wrong branch attention/write, and controls prompt-token cost under
  hard episode cuts.

## Latest Headline Results

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 40 | 5% | 90% | 12.5% | 422,883 | 205,987 |
| `full_history` | 40 | 0% | 0% | 100% | 985,523 | 104,101 |
| `bm25_retrieval` | 40 | 0% | 0% | 100% | 344,280 | 115,368 |
| `mem0` | 40 | 0% | 2.5% | 97.5% | 624,873 | 105,894 |
| `aionis` | 40 | 0% | 0% | 100% | 219,917 | 90,970 |

The latest supported claim is route-safe context compression:

> Aionis matched `full_history` and `bm25_retrieval` on accepted-direction and
> wrong-attention safety while using substantially less prompt context.

Prompt-token reduction for Aionis:

- 77.7% lower than `full_history`
- 36.1% lower than `bm25_retrieval`
- 64.8% lower than `mem0`
- 48.0% lower than `no_memory`

Total-token reduction for Aionis:

- 71.5% lower than `full_history`
- 32.4% lower than `bm25_retrieval`
- 57.5% lower than `mem0`

## Buried Level

The buried level is the clearest context-stress point because the history is
large and noisy.

| Arm | Runs | Wrong attention | Accepted direction | Terminal inspect | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 10 | 90% | 10% | 70% | 116,755 | 60,725 |
| `full_history` | 10 | 0% | 100% | 0% | 583,065 | 22,113 |
| `bm25_retrieval` | 10 | 0% | 100% | 0% | 112,370 | 31,887 |
| `mem0` | 10 | 0% | 100% | 20% | 214,361 | 32,451 |
| `aionis` | 10 | 0% | 100% | 0% | 59,200 | 25,042 |

At the buried level, Aionis matched the strongest baselines on route safety while
using:

- 10.2% of the `full_history` prompt tokens
- 52.7% of the `bm25_retrieval` prompt tokens
- 27.6% of the `mem0` prompt tokens

## Route-Contract Regression

The previous pre-fix run had one Aionis miss:

`vercel-next.js-158c8b116e2a-source-trap-7__implicit`

Pre-fix Aionis result:

- `wrong_branch_write_hit`: `false`
- `wrong_branch_attention_hit`: `true`
- `accepted_direction_hit`: `false`
- `primary_file`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`
- `active_target`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`

Root cause:

- Episode 1 first explored the old single-file route
  `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`.
- Episode 1 later accepted the split module route:
  - `turbopack/crates/turbopack-ecmascript/src/analyzer/mod.rs`
  - `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known/kinds.rs`
  - `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known/mod.rs`
- The compiled Aionis prompt exposed only coarse `target_files: src/analyzer`
  and a compact workflow line.
- The route-contract builder required exact target-file matches, so coarse
  recovered targets such as `src/analyzer` did not match concrete execution
  memory targets such as
  `.../src/analyzer/well_known/mod.rs`.

Fix in commit `bc1f081`:

- Route-contract target matching now accepts exact, parent-child, and
  path-segment relationships for explicit recovered targets.
- Agent context target surfaces now include structured direct-use memory
  `target_files`, filtered through denied or contested path targets.
- Raw guide lines such as `Workflow trusted: Background repository activity...`
  are no longer promoted into direct `use_now` surfaces.

Latest rerun result for the same trap:

- `wrong_branch_write_hit`: `false`
- `wrong_branch_attention_hit`: `false`
- `accepted_direction_hit`: `true`
- `primary_file`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known/mod.rs`
- `active_target`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known/mod.rs`
- `evidence_source`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`
- `action`: `rehydrate`
- `prompt_tokens`: `2,659`

This confirms that the route-contract projection fix removed the previous
Aionis miss without introducing a new wrong-attention or wrong-write regression.

## Interpretation

Supported:

> Aionis keeps long-running coding agents on the accepted execution route with
> far smaller governed context than full-history transfer or generic memory
> retrieval.

Also supported:

> Aionis can carry route state through hard episode cuts without exposing failed
> or stale branch targets as direct action context.

Not supported by this run:

> Aionis uniquely prevents wrong-branch writes.

`full_history`, `bm25_retrieval`, `mem0`, and `aionis` all had 0% wrong writes
in the latest run. The stronger current evidence is not unique wrong-write
prevention; it is full-history-level route safety at much lower context cost.

## Next Checks

1. Repeat this 40-record run with a second model or seed to separate model
   stochasticity from Runtime behavior.
2. Re-run Mem0 with its optional NLP dependencies installed before making
   public comparative claims about Mem0 itself.
3. Add another real repository family to test whether the route-safe compression
   result generalizes beyond the current manifest.
4. Keep single-case failures in eval reports and candidate analysis. Do not turn
   individual trap behavior into hard Runtime rules.
