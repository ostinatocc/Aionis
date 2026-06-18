# Aionis Admission Second Guide Active Gray Gate

Date: 2026-06-18

This run validates the selected admission candidate policy in isolated active
gray mode on the second `/v1/guide` profile, `closed-loop-prior-fresh`.

The preceding shadow gate for this profile passed the 100-row online guide
shadow gate. This active gray run checks whether the same candidate can change
the prompt-facing guide surface while staying within the downgrade-only Runtime
boundary.

## Run

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-active-gray-fresh-20260618-205203 \
  --iterations 6 \
  --chunk-prefix active-gray-fresh \
  --profile closed-loop-prior-fresh
```

Raw chunks and rows were kept outside the repository under `/tmp`. This
document records the aggregate report only.

## Dataset Gate

| Gate | Value | Pass |
|---|---:|---:|
| Iterations completed | 6 / 6 | yes |
| Final rows | 120 | yes |
| Minimum rows for policy claim | 100 | yes |
| Task signatures | 8 | yes |
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

`agent_prompt_included_count = 120` is expected in active gray mode. Active gray
changes the guide prompt/context surface, but it must not mutate stored Runtime
memory state or upgrade hard-boundary decisions.

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

The second guide profile passed isolated active gray:

- active projection fired on every guide call;
- it applied `48` downgrade effects across `120` guide calls;
- it entered the Agent prompt as expected for active mode;
- it did not mutate stored Runtime state;
- it did not upgrade any hard-boundary action;
- after active projection, the offline candidate had no additional changes to
  propose over the exported rows.

This closes the second guide-profile active gray gate. It still does not
authorize default active mode, external-backend active rollout, or broad product
claims. The next check is the real-Agent admission rerun for this same active
gray dataset.

