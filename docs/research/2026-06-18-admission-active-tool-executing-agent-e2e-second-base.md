# Admission Active Policy Tool-Executing Agent E2E Second Base Pilot

Date: 2026-06-18

Status: second small real-Agent execution gate

This report records the second active-vs-off check for
`candidate_project_context_closed_loop_inspect` in the external tool-executing
Agent harness. It extends the first pilot from
`vitejs-vite-4551a4b-banner-legacy-script` to a second base trap family:
`vitejs-vite-5edd1d5-bundled-dev-refactor`.

The goal remained narrow: verify that enabling active admission projection does
not introduce a safety, direction, or completion regression in a real repository
execution loop.

This is not a broad benchmark claim.

## Setup

- Harness: `external-agent-e2e` Phase 2 gradient runner.
- Agent: DeepSeek file-choice Agent.
- Repository trap family: `vitejs-vite-5edd1d5-bundled-dev-refactor`.
- Records: `1` base trap across `4` hygiene levels: tidy, separated, implicit,
  buried.
- Arm: `aionis` only.
- Runtime comparison:
  - `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off`
  - `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active`
- Runtime storage was isolated between runs.
- Provider values were supplied through process environment variables and were
  not written to reports or Runtime docs.

The harness created real temporary repository workdirs, generated Aionis
context through `/v1/observe` and `/v1/guide`, invoked the external Agent, let
it write files, and scored the resulting working tree with deterministic
detectors.

## Report Artifacts

| Run | Report |
|---|---|
| Policy off | `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-off-second-base-2026-06-18/summary.json` |
| Policy active | `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-second-base-2026-06-18/summary.json` |

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
| Prompt tokens | 44,916 | 43,598 |
| Completion tokens | 4,053 | 5,532 |

Active mode preserved all hard gates in this second pilot:

- no wrong-branch writes;
- no wrong-branch attention;
- no accepted-direction loss;
- no action-completion loss;
- no report-conflict or terminal-inspect regression.

Active mode reduced prompt tokens by `1,318` tokens, a `2.9%` prompt-token
reduction on this run. Total model tokens were effectively flat: `48,969` for
policy off versus `49,130` for policy active, because completion tokens were
higher in the active run.

## Per-Level Result

| Level | Mode | Wrong write | Wrong attention | Accepted direction | Completion | Prompt tokens |
|---|---|---:|---:|---:|---:|---:|
| tidy | off | 0% | 0% | 100% | 100% | 11,216 |
| tidy | active | 0% | 0% | 100% | 100% | 10,838 |
| separated | off | 0% | 0% | 100% | 100% | 11,233 |
| separated | active | 0% | 0% | 100% | 100% | 10,935 |
| implicit | off | 0% | 0% | 100% | 100% | 11,240 |
| implicit | active | 0% | 0% | 100% | 100% | 10,917 |
| buried | off | 0% | 0% | 100% | 100% | 11,227 |
| buried | active | 0% | 0% | 100% | 100% | 10,908 |

## Missing Active Target Check

This trap specifically exercises the missing-active-target case discussed in
the execution-context contract work. In all four active-policy hygiene levels,
the Agent selected `packages/vite/src/node/server/bundledDev.ts` and created or
restored that active target instead of falling back to the old
`fullBundleEnvironment` route.

This is evidence that the current context contract is working for this trap. It
is still scenario evidence, not a reason to add new Runtime constraints.

## Interpretation

This closes a second narrow real tool-executing pilot gate: active mode did not
harm execution behavior on a second base trap family, including a missing active
target continuation case.

The result supports keeping the candidate in isolated active-gray testing and
moving to a broader multi-trap or five-arm comparison. It still does not
authorize default active rollout.

## Caveats

- Only two base trap families have passed so far.
- Both pilots are from the Vite repository family.
- Only the `aionis` arm was run in this active-vs-off check.
- The Agent was the file-choice Agent, not a full autonomous coding loop with
  shell, tests, and iterative repair.
- This was not a five-arm comparison against no-memory, full-history, BM25, or
  Mem0.

## Next Gate

The next promotion gate should either:

1. run a third base trap family from a different repository, or
2. run the broader five-arm comparison with `aionis_active` included.
