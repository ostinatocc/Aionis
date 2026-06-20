# External Agent E2E Five-Arm Full Run

Date: 2026-06-20

Latest scored run ID:
`phase2-gradient-five-arm-glm52-runnerfixed-2026-06-20`

This document records the 40-record, five-arm external-agent evidence baseline:
the DeepSeek route-contract target projection run after commit `bc1f081`, plus
the GLM executable-evidence policy reruns after commit `202f89c`.

Reports:

- Summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-route-contract-rerun-2026-06-19/summary.md`
- Machine summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-route-contract-rerun-2026-06-19/summary.json`
- Per-trap JSONL: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-route-contract-rerun-2026-06-19/phase2-gradient-results.jsonl`

Second-model rerun:

- Run ID: `phase2-gradient-five-arm-glm52-json-no-think-2026-06-19`
- Model: `glm-5.2`
- Provider endpoint: Volcano Ark OpenAI-compatible coding endpoint
- Summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-json-no-think-2026-06-19/summary.md`
- Machine summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-json-no-think-2026-06-19/summary.json`
- Per-trap JSONL: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-json-no-think-2026-06-19/phase2-gradient-results.jsonl`

Executable-evidence GLM rerun:

- Combined run ID:
  `phase2-gradient-five-arm-glm52-exec-evidence-policy-combined-2026-06-20`
- Model: `glm-5.2`
- Provider endpoint: Volcano Ark OpenAI-compatible coding endpoint
- Composition:
  - non-Playwright rows from
    `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-exec-evidence-policy-2026-06-20`
  - complete Playwright rerun rows from
    `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-exec-evidence-policy-playwright-2026-06-20`
- Combined summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-exec-evidence-policy-combined-2026-06-20/summary.md`
- Machine summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-exec-evidence-policy-combined-2026-06-20/summary.json`
- Combined JSONL:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-exec-evidence-policy-combined-2026-06-20/combined-results.jsonl`

Runner-fixed GLM full run:

- Run ID: `phase2-gradient-five-arm-glm52-runnerfixed-2026-06-20`
- Model: `glm-5.2`
- Provider endpoint: Volcano Ark OpenAI-compatible coding endpoint
- Summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-runnerfixed-2026-06-20/summary.md`
- Machine summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-runnerfixed-2026-06-20/summary.json`
- Per-trap JSONL:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-glm52-runnerfixed-2026-06-20/phase2-gradient-results.jsonl`

Previous pre-fix run:

- Run ID: `phase2-gradient-five-arm-scopekey-fixed-2026-06-19`
- Summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/summary.md`
- Machine summary: `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/phase2-gradient-five-arm-scopekey-fixed-2026-06-19/summary.json`

## DeepSeek Route-Contract Setup

The DeepSeek route-contract run used the full 40-record phase-2 gradient
manifest across five arms:

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

## DeepSeek Route-Contract Headline Results

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 40 | 5% | 90% | 12.5% | 422,883 | 205,987 |
| `full_history` | 40 | 0% | 0% | 100% | 985,523 | 104,101 |
| `bm25_retrieval` | 40 | 0% | 0% | 100% | 344,280 | 115,368 |
| `mem0` | 40 | 0% | 2.5% | 97.5% | 624,873 | 105,894 |
| `aionis` | 40 | 0% | 0% | 100% | 219,917 | 90,970 |

The supported claim from this run is route-safe context compression:

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

## GLM-5.2 Second-Model Rerun

The GLM-5.2 rerun used the same 40-record manifest and five arms. The adapter
required strict JSON response format plus disabled thinking mode; without that,
GLM sometimes returned prose in the no-memory arm. Two no-memory parse failures
were patched after the run with a narrow prose-action fallback for explicit
"search/read/examine" tool intent, then the report was regenerated from the
per-trap score summaries.

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Action completion | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 40 | 0% | 100% | 0% | 0% | 430,887 | 11,782 |
| `full_history` | 40 | 0% | 0% | 100% | 35% | 1,533,049 | 10,581 |
| `bm25_retrieval` | 40 | 0% | 0% | 100% | 40% | 427,910 | 10,090 |
| `mem0` | 40 | 0% | 5% | 95% | 25% | 948,555 | 10,624 |
| `aionis` | 40 | 0% | 0% | 100% | 2.5% | 316,368 | 9,439 |

GLM-5.2 confirms the route-safety result:

- Aionis had 0% wrong write and 0% wrong attention.
- Aionis matched `full_history` and `bm25_retrieval` at 100% accepted
  direction.
- Aionis used the least prompt context: 79.4% lower than `full_history`, 26.1%
  lower than `bm25_retrieval`, and 66.6% lower than `mem0`.

The GLM-5.2 rerun also exposes a model-specific actionability boundary:

- GLM was much more conservative than DeepSeek.
- Aionis frequently selected `rehydrate` after accepting the correct route,
  rather than directly creating or editing the active target.
- Therefore the GLM result should be read as evidence for route-safe governed
  context, not as evidence that the current compact context is always sufficient
  for direct execution by every model.

This is useful product evidence because it separates two layers:

- Route safety: Aionis stays on the accepted route with the shortest context.
- Executable action sufficiency: some models still need stronger rehydrate or
  patch evidence to act immediately.

## GLM-5.2 Executable-Evidence Policy Rerun

The 2026-06-20 GLM rerun used the same 40-record manifest and five arms, but
with the executable-evidence route policy and the agent configured to continue
after rehydrate when the accepted route and concrete patch evidence are
consistent.

The first full run stopped after 33 appended records when the local Runtime was
no longer listening during the Playwright segment. The Playwright subset was
rerun separately after restarting Runtime, then the report was composed as:

- `32` non-Playwright rows from the first run
- `8` complete Playwright rows from the Playwright rerun

This composition is explicit in the combined report. The composed report should
be read as the current GLM executable-evidence result; the interrupted raw run
should not be used directly for final metrics.

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Action completion | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 40 | 20% | 100% | 2.5% | 20% | 497,365 | 13,729 |
| `full_history` | 40 | 0% | 0% | 100% | 100% | 1,923,735 | 16,694 |
| `bm25_retrieval` | 40 | 0% | 0% | 100% | 100% | 702,308 | 15,956 |
| `mem0` | 40 | 0% | 0% | 97.5% | 100% | 1,303,033 | 16,154 |
| `aionis` | 40 | 0% | 0% | 100% | 100% | 617,609 | 16,948 |

Compared with the previous GLM rerun, Aionis changed from route-safe but
over-conservative to executable:

- wrong write stayed at `0%`;
- wrong attention stayed at `0%`;
- accepted direction stayed at `100%`;
- action completion improved from `2.5%` to `100%`.

This is not an Aionis-only improvement claim. In this run, `full_history`,
`bm25_retrieval`, and `mem0` also reached `100%` action completion. The fair
interpretation is:

> Under the executable-evidence / rehydrate-continue setting, Aionis reaches the
> same task-action completion as full-history and retrieval baselines while
> preserving 0% wrong attention and using substantially less context than
> `full_history` and `mem0`.

Prompt-token reduction for Aionis in this GLM rerun:

- 67.9% lower than `full_history`
- 12.1% lower than `bm25_retrieval`
- 52.6% lower than `mem0`

Total-token reduction for Aionis:

- 67.3% lower than `full_history`
- 11.7% lower than `bm25_retrieval`
- 51.9% lower than `mem0`

The tradeoff is also clear: Aionis used more prompt tokens than the previous
GLM run because it exposed stronger executable evidence, but that extra
evidence converted GLM from conservative route acceptance into concrete
create/edit actions.

## GLM-5.2 Runner-Fixed Full Run

The runner-fixed GLM run used the same 40-record manifest and five arms, with
the Phase 2 runner hardened so a failed arm is surfaced as an explicit failed
record instead of silently leaving a partial per-trap summary outside the
appended JSONL.

Run status:

- `run_status`: `complete_with_failures`
- Requested records: `40`
- Completed scored records: `39`
- Failed records: `1`
- Failed record: `microsoft-playwright-4859f65c1d92-source-trap-1__buried`

The one failed record was a `no_memory` arm parse failure:

- `full_history`, `bm25_retrieval`, `mem0`, and `aionis` completed for the
  same trap.
- The official by-arm table below uses the `39` scored rows emitted by the
  runner.
- A targeted same-case `no_memory` rerun with the correct Ark credential
  completed and triggered the `wrong-vendored-yauzl-route` and
  `rediscovery-vendored-yauzl-route` detectors by editing
  `packages/utils/third_party/yauzl/LICENSE`.
- That targeted rerun is diagnostic evidence only. It is not merged into the
  official 40-record summary unless the full report is regenerated by the
  runner.

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Action completion | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 39 | 35.9% | 100% | 20.5% | 35.9% | 485,146 | 13,470 |
| `full_history` | 39 | 0% | 0% | 100% | 100% | 2,060,529 | 17,025 |
| `bm25_retrieval` | 39 | 0% | 0% | 100% | 100% | 724,652 | 15,913 |
| `mem0` | 39 | 0% | 0% | 100% | 100% | 1,317,009 | 17,091 |
| `aionis` | 39 | 0% | 0% | 100% | 100% | 604,816 | 15,877 |

Compared with `full_history`, `bm25_retrieval`, and `mem0`, Aionis did not win
on correctness in this run; all four memory-bearing arms had `0%` wrong write,
`0%` wrong attention, `100%` accepted direction, and `100%` action completion
on the scored rows.

The stronger supported claim is context-cost robustness:

> Aionis matched the strongest memory-bearing arms on route safety and action
> completion while using far less prompt context.

Prompt-token reduction for Aionis in the runner-fixed GLM run:

- 70.6% lower than `full_history`
- 16.5% lower than `bm25_retrieval`
- 54.1% lower than `mem0`

The targeted failed-row rerun also reinforces the no-memory lower-bound result:
when the missing `no_memory` row is rerun directly, it touches the retired
vendored yauzl route. This should be read as `no_memory` instability and
wrong-branch susceptibility, not as an Aionis Runtime failure.

## Buried Level

The buried level is the clearest context-stress point because the history is
large and noisy.

The table below is from the runner-fixed GLM run. It has `9` scored buried rows
because the failed record was the `no_memory` arm of one buried trap.

| Arm | Runs | Wrong write | Wrong attention | Accepted direction | Action completion | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 9 | 44.4% | 100% | 44.4% | 44.4% | 108,694 | 3,123 |
| `full_history` | 9 | 0% | 0% | 100% | 100% | 1,183,803 | 4,256 |
| `bm25_retrieval` | 9 | 0% | 0% | 100% | 100% | 171,360 | 3,742 |
| `mem0` | 9 | 0% | 0% | 100% | 100% | 338,629 | 4,223 |
| `aionis` | 9 | 0% | 0% | 100% | 100% | 144,897 | 3,661 |

At the buried level, Aionis matched the strongest baselines on route safety while
using:

- 12.2% of the `full_history` prompt tokens
- 84.6% of the `bm25_retrieval` prompt tokens
- 42.8% of the `mem0` prompt tokens

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

Route-contract rerun result for the same trap:

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

Also supported by the 2026-06-20 GLM executable-evidence rerun:

> Aionis can make route-safe compact context executable for a conservative model
> when rehydrate results contain concrete patch evidence and the prompt contract
> tells the agent to continue consistent accepted-route work rather than report
> conflict.

Not supported by this run:

> Aionis uniquely prevents wrong-branch writes.

`full_history`, `bm25_retrieval`, `mem0`, and `aionis` all had 0% wrong writes
in the latest run. The stronger current evidence is not unique wrong-write
prevention; it is full-history-level route safety at much lower context cost.

## Next Checks

1. Repeat the executable-evidence run with DeepSeek under the same
   rehydrate-continue contract to separate Runtime contract effects from
   model-specific behavior.
2. Re-run Mem0 with its optional NLP dependencies installed before making
   public comparative claims about Mem0 itself.
3. Add another real repository family to test whether the route-safe compression
   result generalizes beyond the current manifest.
4. Keep single-case failures in eval reports and candidate analysis. Do not turn
   individual trap behavior into hard Runtime rules.
