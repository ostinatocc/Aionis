# Admission Active Cross-Repo Tool E2E 40-Gate

Date: 2026-06-28

Status: product evidence report, route/completion gate passed; context-budget
gap superseded by the 2026-06-29 instrumented rerun

Update: the required instrumented rerun is recorded in
`docs/research/2026-06-29-admission-active-crossrepo-tool-e2e-initial-context-rerun.md`.
That rerun completed `40 / 40` records for both Aionis and Full History and
passed the context-budget gate using `initial_context_chars`.

## Purpose

This run validates `candidate_project_context_closed_loop_inspect` in active
mode against the cross-repository, tool-executing Agent gate. The goal is
specific: check whether the selected closed-loop admission policy can preserve
accepted route state and executable action completion across multiple repository
trap families and context hygiene levels.

This is a default-active review gate. It does not flip the Runtime default.

## Setup

- Harness: `external-agent-e2e` Phase 2 gradient runner.
- Agent: DeepSeek multi-step tool Agent.
- Runtime: local Aionis Lite Runtime.
- Admission candidate mode: `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active`.
- Embeddings: real MiniMax embeddings from the local Runtime environment.
- Arm: `aionis`.
- Scope: `10` base trap families across `4` context hygiene levels.
- Records: `40`.
- Tool execution: real temporary repository workdirs; the Agent wrote files and
  the harness scored the resulting working tree with deterministic detectors.

Report artifacts:

- summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active40-current-2026-06-28/summary.json`
- results:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active40-current-2026-06-28/phase2-gradient-results.jsonl`
- gate:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active40-current-2026-06-28/tool_e2e_gate.md`
- paired Full History comparison:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-current-2026-06-28/summary.md`
- paired gate:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-current-2026-06-28/tool_e2e_gate.md`

The first attempt stopped at `28 / 40` because a workdir report directory could
not be created. The run was resumed with the same report directory and completed
all `40` records. This was an eval filesystem issue, not a Runtime or policy
failure.

## Dataset

| Metric | Value |
|---|---:|
| Run ID | `phase2-gradient-2026-06-28T14-04-42-100Z` |
| Requested records | 40 |
| Completed records | 40 |
| Failed records | 0 |
| Base trap families | 10 |
| Context hygiene levels | 4 |
| Policy mode | `active` |

Base trap families:

- `microsoft-playwright-4859f65c1d92-source-trap-1`
- `microsoft-playwright-bc2960793c05-source-trap-2`
- `vercel-next.js-158c8b116e2a-source-trap-7`
- `vercel-next.js-4c3cdf61de11-source-trap-5`
- `vercel-next.js-83eea78b32ce-source-trap-2`
- `vercel-next.js-8ef4258ab9fa-source-trap-6`
- `vercel-next.js-a0dd23235851-source-trap-3`
- `vitejs-vite-4551a4b-banner-legacy-script`
- `vitejs-vite-5edd1d5-bundled-dev-refactor`
- `vitejs-vite-868f1411a6f4-source-trap-2`

## Gate Result

| Metric | Value | Gate |
|---|---:|---:|
| Runs | 40 | `>= 40` |
| Route write violations | 0 | `<= 0` |
| Route action violations | 0 | `<= 0` |
| Direction-attention violations | 0 | `<= 0` |
| Accepted-route rate | 100.0% | `>= 100.0%` |
| Action-completion rate | 100.0% | `>= 100.0%` |
| Terminal inspect exits | 0 | `<= 0` |
| Report-conflict exits | 0 | `<= 0` |
| Prompt tokens | 602,291 | informational |
| Completion tokens | 95,891 | informational |
| Initial context ratio vs Full History | not assessed | `<= 0.75` when Full History is present |
| Legacy prompt-token ratio vs Full History | not assessed | fallback only for older reports |

Gate decision:

- `eligible_for_default_active_review=true`
- status:
  `passes_cross_repository_tool_e2e_gate_ready_for_default_active_review`
- blocking reasons: none

This first gate used only the `aionis` arm, so it proves execution correctness
for the active candidate but does not prove context-budget superiority.

## Same-Manifest Full History Comparison

A follow-up run executed the same 40 records with the `full_history` arm:

- summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-fullhistory40-current-2026-06-28/summary.json`
- derived paired view:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-current-2026-06-28/summary.md`
- paired gate:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-current-2026-06-28/tool_e2e_gate.md`

| Arm | Runs | Accepted route | Action completion | Route write violations | Direction-attention violations | Prompt tokens | Initial context chars |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aionis active | 40 | 100.0% | 100.0% | 0 | 0 | 602,291 | not recorded |
| Full History | 40 | 22.5% | 22.5% | 0 | 0 | 375,207 | not recorded |

The paired gate was blocked by:

- `context_budget_not_better_than_full_history`

That blocker should not be interpreted as Full History being the better
execution context. In this run, Full History completed only `9 / 40` records;
most failed before producing parseable action JSON for the tool Agent. The
legacy gate compared total prompt tokens over the whole run, so a baseline that
fails early can look cheaper because it stops executing.

The gate code now prefers initial context size when the report records
`initial_context_chars` for each arm, and uses total prompt tokens only as a
legacy fallback. This report pair predates that instrumentation, so it must be
rerun before it can support a context-budget claim.

## Per-Level Result

| Level | Runs | Accepted route | Action completion | Terminal inspect | Report conflict | Prompt tokens |
|---|---:|---:|---:|---:|---:|---:|
| tidy | 10 | 100.0% | 100.0% | 0 | 0 | 156,872 |
| separated | 10 | 100.0% | 100.0% | 0 | 0 | 154,323 |
| implicit | 10 | 100.0% | 100.0% | 0 | 0 | 147,876 |
| buried | 10 | 100.0% | 100.0% | 0 | 0 | 143,220 |

## Interpretation

This closes the current cross-repository tool-executing route/completion gate
for the selected closed-loop admission candidate. The same-manifest Full
History comparison did not close the legacy total-token budget fallback because
the baseline failed most records. The candidate remains suitable for human
default-active review only if that review treats context-budget superiority as
unproven until the same manifest is rerun with initial-context instrumentation.

This result does not mean the Runtime default should be changed automatically.
The current product position remains:

- active candidate mode is an explicit operator-controlled mode;
- default Runtime mode remains `off`;
- external backend candidates remain shadow-only unless separately validated;
- broad context-budget superiority is not established by this gate; the same
  manifest needs to be rerun with `initial_context_chars` recorded for each arm.

## Product Decision

- The previous paired27 route-adherence blocker is resolved by the current
  40-record run.
- The selected candidate is ready for human review on execution correctness.
- The selected candidate is not ready for a broad context-budget claim until
  the same manifest is rerun with initial-context budget instrumentation.
- Do not silently enable default active mode in the Runtime.
- Do not turn individual trap content into Runtime rules.
- Keep context-budget claims tied to reports that include a Full History arm.

## Next Work

1. Review whether `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active` should remain
   explicit-only or become default for a named guide profile.
2. Rerun the same manifest with the instrumented runner so the gate can compare
   initial context size instead of legacy total prompt tokens.
3. If enabled beyond explicit active mode, ship rollback instructions and make
   the active projection visible in Flight Recorder and admission reports.
