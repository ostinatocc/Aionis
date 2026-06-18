# Aionis Admission Policy Comparison

Compared 4 admission policies over 776 rows; Aionis score=0.4604, raw retrieval proxy score=0.3299.

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.4604 | 100.0% | 54.0% | 40.8% | 556 | 0 |
| 2 | Always use | 0.3299 | 100.0% | 67.0% | 29.3% | 776 | 0 |
| 3 | Raw retrieval prompt proxy | 0.3299 | 100.0% | 67.0% | 29.3% | 776 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 227 |

## Dataset

- Rows: 776
- Minimum rows for policy claim: 100
- Enough rows for policy claim: yes
- Minimum task signatures for diversity claim: 6
- Enough task signatures for diversity claim: yes
- Positive use rows: 227
- Negative use rows: 300
- Blocked or suppressed rows: 191
- Rehydrate requested rows: 29

## Caveats

- This is an offline proxy comparison over admission dataset rows, not a counterfactual Agent rerun.
- Raw retrieval prompt proxy treats prompt-included candidates as direct-use memory because candidate ranks are not preserved in the dataset.
- Do not use this report to mutate Runtime gates without holdout validation.
