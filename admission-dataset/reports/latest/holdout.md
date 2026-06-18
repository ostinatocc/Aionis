# Aionis Admission Dataset Holdout

Split 105 admission dataset rows by task_signature: train=70, holdout=35; holdout leader=aionis_recorded_policy.

| Split | Rows | Groups | Enough rows | Enough task signatures |
|---|---:|---:|---|---|
| Train | 70 | 5 | no | no |
| Holdout | 35 | 2 | no | no |

## Holdout Metrics

| Metric | Value |
|---|---:|
| use_now positive rate | 50.0% |
| use_now negative rate | 0.0% |
| unused exposed rate | 20.0% |
| blocked / suppressed rows | 14 |
| rehydrate requested rows | 7 |
| recorded policy holdout leader | yes |

## Holdout Policy Comparison

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 1.0000 | 100.0% | 0.0% | 50.0% | 14 | 0 |
| 2 | Always use | 0.4000 | 100.0% | 60.0% | 20.0% | 35 | 0 |
| 3 | Raw retrieval prompt proxy | 0.4000 | 100.0% | 60.0% | 20.0% | 35 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 7 |

## Caveats

- This report is an offline holdout validation over exported admission rows, not a counterfactual Agent rerun.
- Do not tune or promote an admission policy on the same holdout split used for the final claim.
- Holdout has fewer than 100 rows; treat as pipeline validation only.
- Holdout has fewer than 6 task signatures; do not claim cross-task generality.
