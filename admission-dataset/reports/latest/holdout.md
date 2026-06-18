# Aionis Admission Dataset Holdout

Split 436 admission dataset rows by task_signature: train=261, holdout=175; holdout leader=aionis_recorded_policy.

| Split | Rows | Groups | Enough rows | Enough task signatures |
|---|---:|---:|---|---|
| Train | 261 | 24 | yes | yes |
| Holdout | 175 | 11 | yes | yes |

## Holdout Metrics

| Metric | Value |
|---|---:|
| use_now positive rate | 37.4% |
| use_now negative rate | 39.8% |
| unused exposed rate | 10.9% |
| blocked / suppressed rows | 73 |
| rehydrate requested rows | 19 |
| recorded policy holdout leader | yes |

## Holdout Policy Comparison

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.6024 | 100.0% | 39.8% | 37.4% | 83 | 0 |
| 2 | Always use | 0.2857 | 100.0% | 71.4% | 17.7% | 175 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2857 | 100.0% | 71.4% | 17.7% | 175 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 31 |

## Caveats

- This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.
- Do not tune or promote an admission policy on the same holdout split used for the final claim.
