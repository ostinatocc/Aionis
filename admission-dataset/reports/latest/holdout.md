# Aionis Admission Dataset Holdout

Split 536 admission dataset rows by task_signature: train=342, holdout=194; holdout leader=aionis_recorded_policy.

| Split | Rows | Groups | Enough rows | Enough task signatures |
|---|---:|---:|---|---|
| Train | 342 | 30 | yes | yes |
| Holdout | 194 | 13 | yes | yes |

## Holdout Metrics

| Metric | Value |
|---|---:|
| use_now positive rate | 40.2% |
| use_now negative rate | 41.2% |
| unused exposed rate | 9.8% |
| blocked / suppressed rows | 73 |
| rehydrate requested rows | 19 |
| recorded policy holdout leader | yes |

## Holdout Policy Comparison

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5882 | 100.0% | 41.2% | 40.2% | 102 | 0 |
| 2 | Always use | 0.3093 | 100.0% | 69.1% | 21.1% | 194 | 0 |
| 3 | Raw retrieval prompt proxy | 0.3093 | 100.0% | 69.1% | 21.1% | 194 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 41 |

## Caveats

- This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.
- Do not tune or promote an admission policy on the same holdout split used for the final claim.
