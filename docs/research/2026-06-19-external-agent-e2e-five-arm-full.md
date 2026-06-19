# External Agent E2E Five-Arm Full Run

Date: 2026-06-19

Run ID: `phase2-gradient-five-arm-scopekey-fixed-2026-06-19`

Reports:

- Summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/summary.md`
- Machine summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/summary.json`
- Per-trap JSONL: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/phase2-gradient-results.jsonl`

## Setup

This run used the full 40-record phase-2 gradient manifest across five arms:

- `no_memory`
- `full_history`
- `bm25_retrieval`
- `mem0`
- `aionis`

The Agent command was the real DeepSeek multi-step runner. The reported model was
`deepseek-v4-flash`.

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

## Headline Results

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Prompt tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 40 | 0% | 97.5% | 5% | 398,558 |
| `full_history` | 40 | 0% | 0% | 100% | 1,129,007 |
| `bm25_retrieval` | 40 | 0% | 0% | 100% | 323,619 |
| `mem0` | 40 | 0% | 0% | 97.5% | 638,987 |
| `aionis` | 40 | 0% | 2.5% | 97.5% | 217,868 |

Aionis did not uniquely win on wrong-write avoidance. In this run,
`full_history`, `bm25_retrieval`, `mem0`, and `aionis` all had 0% wrong writes.
The stronger supported claim is route-safe context compression: Aionis preserved
the accepted execution route in 39/40 runs with the lowest prompt-token cost.

Overall Aionis prompt-token cost:

- 19.3% of `full_history`
- 34.1% of `mem0`
- 67.3% of `bm25_retrieval`
- 54.7% of `no_memory`

## Buried Level

The buried level is the clearest stress point because history volume is high.

| Arm | Runs | Wrong attention | Accepted direction | Terminal inspect | Prompt tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 10 | 100% | 0% | 60% | 104,126 |
| `full_history` | 10 | 0% | 100% | 0% | 681,096 |
| `bm25_retrieval` | 10 | 0% | 100% | 0% | 80,141 |
| `mem0` | 10 | 0% | 90% | 20% | 197,046 |
| `aionis` | 10 | 0% | 100% | 0% | 57,330 |

In buried cases, Aionis matched `full_history` and `bm25_retrieval` on accepted
direction while using far less prompt context. `full_history` used 11.88x the
Aionis prompt tokens at this level.

## Aionis Miss

The only Aionis miss was:

`vercel-next.js-158c8b116e2a-source-trap-7__implicit`

Observed Aionis decision:

- `primary_file`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`
- `active_target`: `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`
- `action`: `rehydrate`
- `wrong_branch_write_hit`: `false`
- `wrong_branch_attention_hit`: `true`
- `accepted_direction_hit`: `false`

Forensic notes:

- Episode 1 first explored the old single-file route
  `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known.rs`.
- Episode 1 later accepted the split module route:
  - `turbopack/crates/turbopack-ecmascript/src/analyzer/mod.rs`
  - `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known/kinds.rs`
  - `turbopack/crates/turbopack-ecmascript/src/analyzer/well_known/mod.rs`
- The compiled Aionis prompt exposed only coarse `target_files: src/analyzer`
  and a compact workflow line. It did not render the detailed active targets in
  the route contract.
- Root cause was prompt/route-contract projection, not an unsafe write. The
  route contract builder required exact target-file matches, so coarse recovered
  targets such as `src/analyzer` did not match concrete execution-memory targets
  such as `.../src/analyzer/well_known/mod.rs`.

Runtime follow-up:

- Route-contract target matching now accepts exact, parent/child, and path-segment
  relationships for explicit recovered targets.
- Agent context target surfaces now include structured direct-use memory
  `target_files`, filtered through denied/contested path targets.
- Raw guide `Workflow trusted: Background repository activity...` lines are no
  longer promoted into direct `use_now` surfaces.

## Interpretation

The supported product claim after this run is:

> Aionis keeps long-running agents on the accepted execution route with much
> smaller governed context than full-history or generic memory retrieval.

The unsupported or weaker claim is:

> Aionis uniquely prevents wrong-branch writes.

That claim did not separate from the stronger baselines in this run because
`full_history`, `bm25_retrieval`, and `mem0` also had 0% wrong writes.

## Next Checks

1. Re-run the same 40-record manifest after the route-contract projection fix.
   The main regression target is the previous Aionis miss above.
2. Keep the 5-arm comparison unchanged for the rerun. Do not tune the manifest.
3. Track both accepted-direction and prompt-token cost. Aionis should preserve
   0% wrong writes, improve the implicit miss, and keep the buried-level context
   advantage.

