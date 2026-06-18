# Aionis Admission Active Gray Closed-Loop 100-Row Gate

Date: 2026-06-18

This run validates the selected admission candidate policy in isolated active
gray mode for the `closed-loop-prior-fresh-2` profile. It uses a temporary
dataset outside the repository and does not change the default Runtime
configuration.

Active gray mode is expected to alter the `/v1/guide` Agent context by
downgrading selected `use_now` memories to `inspect_before_use`. It must not
mutate stored Runtime memory rows or upgrade hard-boundary actions.

## Run

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-active-gray-20260618-201156 \
  --iterations 4 \
  --chunk-prefix active-gray \
  --profile closed-loop-prior-fresh-2
```

Raw chunks and rows were kept outside the repository under `/tmp`. This document
records the aggregate report only.

## Dataset Gate

| Gate | Value | Pass |
|---|---:|---:|
| Iterations completed | 4 / 4 | yes |
| Final rows | 120 | yes |
| Minimum rows for policy claim | 100 | yes |
| Task signatures | 12 | yes |
| Minimum task signatures | 6 | yes |
| Failure count | 0 | yes |

## Active Guide Projection

| Metric | Value |
|---|---:|
| Projection mode | active |
| Guide calls | 120 |
| Projection present | 120 |
| Active source-map count | 48 |
| Shadow source-map count | 0 |
| Candidate downgrades applied | 48 |
| Agent prompt included count | 120 |
| Runtime mutation count | 0 |
| Hard-boundary upgrade count | 0 |

`agent_prompt_included_count = 120` is expected in active gray mode. The purpose
of the active run is to verify that prompt/context changes are bounded to the
candidate downgrade path while stored Runtime state and hard-boundary actions
remain unchanged.

## Exported Admission Rows

Because active projection has already changed the guide surface, the exported
admission rows represent the post-projection Runtime behavior.

| Metric | Recorded Runtime rows | Offline candidate shadow over active rows |
|---|---:|---:|
| Direct-use count | 72 | 72 |
| Inspect-before-use count | 48 | 48 |
| Positive direct count | 48 | 48 |
| Negative direct count | 24 | 24 |
| Direct-use negative rate | 33.3% | 33.3% |
| Direct-use positive precision proxy | 66.7% | 66.7% |

Delta after active projection:

- changed admission actions in offline shadow audit: `0`
- would downgrade additional `use_now`: `0`
- missed positive delta: `0`
- hard-boundary direct delta: `0`

## Interpretation

The active gray run matches the preceding online shadow direction for this
profile:

- active projection fired on the guide path;
- it applied `48` downgrade effects across `120` guide calls;
- it entered the Agent prompt as expected for active mode;
- it did not mutate stored Runtime state;
- it did not upgrade any hard-boundary action;
- after active projection, the offline candidate had no additional changes to
  propose over the exported rows.

This supports keeping the candidate eligible for isolated active gray testing on
the `closed-loop-prior-fresh-2` profile. It does not authorize default active
mode or external-backend active rollout. External-current candidates still need
task-level or real-Agent completion evidence before active mode is considered
for that product path.

