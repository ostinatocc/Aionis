# Admission Active Cross-Repo Tool E2E Initial-Context Rerun

Date: 2026-06-29

Status: product evidence report, route/completion/context-budget gate passed

## Purpose

This rerun validates `candidate_project_context_closed_loop_inspect` in active
mode against the cross-repository, tool-executing Agent gate after adding
initial-context instrumentation. The purpose is narrow: verify that the active
candidate preserves accepted route state and executable action completion while
keeping the compiled initial Agent context materially smaller than Full History.

This report does not change Runtime defaults automatically.

## Setup

- Harness: `external-agent-e2e` Phase 2 gradient runner.
- Agent: Ark GLM-5.2 through an OpenAI-compatible chat-completions endpoint.
- Runtime: local Aionis Lite Runtime from the current Runtime repository.
- Admission candidate mode: `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active`.
- Embeddings: real MiniMax embeddings from the local Runtime environment.
- Arms: `aionis`, `full_history`.
- Scope: `10` base trap families across `4` context hygiene levels.
- Records: `40` records per arm.
- Tool execution: real temporary repository workdirs; the Agent wrote files and
  the harness scored the resulting working tree with deterministic detectors.
- Budget metric: `initial_context_chars`, recorded before the first tool step.

Report artifacts:

- summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-initialctx-arkglm52-2026-06-29T00-49-09/summary.json`
- results:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-initialctx-arkglm52-2026-06-29T00-49-09/phase2-gradient-results.jsonl`
- gate:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-initialctx-arkglm52-2026-06-29T00-49-09/tool_e2e_gate.md`

## Dataset

| Metric | Value |
|---|---:|
| Requested records | 40 |
| Completed records | 40 |
| Failed records | 0 |
| Base trap families | 10 |
| Context hygiene levels | 4 |
| Policy mode | `active` |

## Main Result

| Arm | Runs | Accepted route | Action completion | Terminal inspect | Report conflict | Initial context chars | Prompt tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aionis active | 40 | 100.0% | 100.0% | 0 | 0 | 203,242 | 674,833 |
| Full History | 40 | 100.0% | 100.0% | 0 | 0 | 1,352,256 | 2,114,192 |

Aionis used `15.0%` of the Full History initial context size, an `85.0%`
reduction, while preserving the same accepted-route and action-completion
rates in this run. Total prompt tokens were also lower: Aionis used `31.9%` of
the Full History prompt tokens.

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
| Initial context ratio vs Full History | 15.0% | `<= 75.0%` |
| Context budget metric | `initial_context_chars` | initial context preferred |
| Candidate policy mode declared | yes | required |

Gate decision:

- `eligible_for_default_active_review=true`
- status:
  `passes_cross_repository_tool_e2e_gate_ready_for_default_active_review`
- blocking reasons: none

## Interpretation

This rerun closes the previous budget-metric gap. The earlier same-manifest
Full History comparison was not a fair budget comparison because Full History
completed only `9 / 40` records and therefore stopped early. This instrumented
rerun completed `40 / 40` records for both arms and compared the context each
Agent received before taking its first tool action.

The result supports a narrower product claim:

> In this cross-repository tool-executing continuation eval, Aionis preserved
> route and action completion while compiling a much shorter initial execution
> context than Full History.

This report does not prove broad coding-Agent success across all tasks and
does not enable Runtime defaults automatically. It supports human review of the
active candidate for a named guide profile.

## Product Decision

- The selected candidate is ready for human default-active review.
- The current Runtime default remains explicit opt-in until that review is
  completed.
- Future material changes to guide rendering, lifecycle inference, execution
  memory rendering, or candidate-policy evaluation should rerun this gate.
