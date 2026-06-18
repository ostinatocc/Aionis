# Aionis Admission Dataset Holdout

Split 411 admission dataset rows by task_signature: train=118, holdout=293; holdout leader=aionis_recorded_policy.

| Split | Rows | Groups | Enough rows | Enough task signatures |
|---|---:|---:|---|---|
| Train | 118 | 12 | yes | yes |
| Holdout | 293 | 13 | yes | yes |

## Holdout Metrics

| Metric | Value |
|---|---:|
| use_now positive rate | 39.7% |
| use_now negative rate | 44.9% |
| unused exposed rate | 7.2% |
| blocked / suppressed rows | 136 |
| rehydrate requested rows | 21 |
| recorded policy holdout leader | yes |

## Holdout Policy Comparison

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5515 | 100.0% | 44.9% | 39.7% | 136 | 0 |
| 2 | Always use | 0.2560 | 100.0% | 74.4% | 18.4% | 293 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2560 | 100.0% | 74.4% | 18.4% | 293 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 54 |

## Caveats

- This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.
- Do not tune or promote an admission policy on the same holdout split used for the final claim.
