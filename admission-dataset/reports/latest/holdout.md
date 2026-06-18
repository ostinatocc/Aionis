# Aionis Admission Dataset Holdout

Split 375 admission dataset rows by task_signature: train=148, holdout=227; holdout leader=aionis_recorded_policy.

| Split | Rows | Groups | Enough rows | Enough task signatures |
|---|---:|---:|---|---|
| Train | 148 | 6 | yes | yes |
| Holdout | 227 | 7 | yes | yes |

## Holdout Metrics

| Metric | Value |
|---|---:|
| use_now positive rate | 41.9% |
| use_now negative rate | 41.9% |
| unused exposed rate | 7.5% |
| blocked / suppressed rows | 105 |
| rehydrate requested rows | 17 |
| recorded policy holdout leader | yes |

## Holdout Policy Comparison

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5810 | 100.0% | 41.9% | 41.9% | 105 | 0 |
| 2 | Always use | 0.2687 | 100.0% | 73.1% | 19.4% | 227 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2687 | 100.0% | 73.1% | 19.4% | 227 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 44 |

## Caveats

- This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.
- Do not tune or promote an admission policy on the same holdout split used for the final claim.
