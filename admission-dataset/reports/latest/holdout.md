# Aionis Admission Dataset Holdout

Split 626 admission dataset rows by task_signature: train=441, holdout=185; holdout leader=aionis_recorded_policy.

| Split | Rows | Groups | Enough rows | Enough task signatures |
|---|---:|---:|---|---|
| Train | 441 | 38 | yes | yes |
| Holdout | 185 | 17 | yes | yes |

## Holdout Metrics

| Metric | Value |
|---|---:|
| use_now positive rate | 40.8% |
| use_now negative rate | 43.3% |
| unused exposed rate | 10.3% |
| blocked / suppressed rows | 46 |
| rehydrate requested rows | 19 |
| recorded policy holdout leader | yes |

## Holdout Policy Comparison

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5667 | 100.0% | 43.3% | 40.8% | 120 | 0 |
| 2 | Always use | 0.3676 | 100.0% | 63.2% | 26.5% | 185 | 0 |
| 3 | Raw retrieval prompt proxy | 0.3676 | 100.0% | 63.2% | 26.5% | 185 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 49 |

## Caveats

- This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.
- Do not tune or promote an admission policy on the same holdout split used for the final claim.
