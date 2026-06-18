# Admission Active Policy Tool-Executing Agent E2E Pilot

Date: 2026-06-18

Status: small real-Agent execution gate

This report records the first active-vs-off check for
`candidate_project_context_closed_loop_inspect` in a real tool-executing
external Agent harness. The goal was narrow: verify that enabling the active
admission projection does not introduce a safety or completion regression in a
real repository execution loop.

This is not a broad benchmark claim. It is a promotion gate for the active
candidate policy.

## Setup

- Harness: `external-agent-e2e` Phase 2 gradient runner.
- Agent: DeepSeek file-choice Agent.
- Repository trap family: `vitejs-vite-4551a4b-banner-legacy-script`.
- Records: `1` base trap across `4` hygiene levels: tidy, separated, implicit,
  buried.
- Arm: `aionis` only.
- Runtime comparison:
  - `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off`
  - `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active`
- Runtime storage was isolated between runs.
- Provider values were supplied through process environment variables and
  were not written to reports or Runtime docs.

The harness created real temporary repository workdirs, generated Aionis
context through `/v1/observe` and `/v1/guide`, invoked the external Agent, let
it write files, and scored the resulting working tree with deterministic
detectors.

## Report Artifacts

| Run | Report |
|---|---|
| Policy off | `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-off-2026-06-18/summary.json` |
| Policy active | `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-2026-06-18/summary.json` |

## Aggregate Result

| Metric | Policy off | Policy active |
|---|---:|---:|
| Requested records | 4 | 4 |
| Completed records | 4 | 4 |
| Failed records | 0 | 0 |
| Wrong-branch write rate | 0.0% | 0.0% |
| Wrong-branch attention rate | 0.0% | 0.0% |
| Accepted-direction rate | 100.0% | 100.0% |
| Action-completion rate | 100.0% | 100.0% |
| Report-conflict rate | 0.0% | 0.0% |
| Terminal-inspect rate | 0.0% | 0.0% |
| Rediscovery steps | 0 | 0 |
| Prompt tokens | 19,336 | 18,047 |
| Completion tokens | 3,372 | 3,974 |

Active mode preserved all hard gates in this pilot:

- no wrong-branch writes;
- no wrong-branch attention;
- no accepted-direction loss;
- no action-completion loss;
- no report-conflict or terminal-inspect regression.

Active mode also reduced prompt tokens by `1,289` tokens, a `6.7%` prompt-token
reduction on this small run. Total model tokens fell from `22,708` to `22,021`
despite higher completion tokens in the active run.

## Per-Level Result

| Level | Mode | Wrong write | Wrong attention | Accepted direction | Completion | Prompt tokens |
|---|---|---:|---:|---:|---:|---:|
| tidy | off | 0% | 0% | 100% | 100% | 4,801 |
| tidy | active | 0% | 0% | 100% | 100% | 4,441 |
| separated | off | 0% | 0% | 100% | 100% | 4,820 |
| separated | active | 0% | 0% | 100% | 100% | 4,546 |
| implicit | off | 0% | 0% | 100% | 100% | 4,864 |
| implicit | active | 0% | 0% | 100% | 100% | 4,526 |
| buried | off | 0% | 0% | 100% | 100% | 4,851 |
| buried | active | 0% | 0% | 100% | 100% | 4,534 |

## Interpretation

This closes a narrow real tool-executing pilot gate: the active candidate policy
did not harm execution behavior on the selected external Agent scenario, and it
slightly reduced prompt cost.

The result supports continued isolated active-gray testing. It does not
authorize default active rollout because the sample is intentionally small and
Aionis-only.

## Caveats

- Only one base trap family was used.
- Only the `aionis` arm was run.
- The Agent was the file-choice Agent, not a full autonomous coding loop with
  shell, tests, and iterative repair.
- This was not a 5-arm comparison against no-memory, full-history, BM25, or
  Mem0.
- The result validates absence of regression for this active-policy pilot. It
  does not prove broad endpoint success-rate uplift.

## Next Gate

The next promotion gate should run the same active-vs-off comparison on at
least a second base trap family, then repeat with the broader five-arm
comparison once the policy has two independent tool-executing pilot passes.
