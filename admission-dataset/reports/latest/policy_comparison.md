# Aionis Admission Policy Comparison

Compared 4 admission policies over 105 rows; Aionis score=0.5714, raw retrieval proxy score=0.2667.

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5714 | 100.0% | 42.9% | 42.9% | 49 | 0 |
| 2 | Always use | 0.2667 | 100.0% | 73.3% | 20.0% | 105 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2667 | 100.0% | 73.3% | 20.0% | 105 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 21 |

## Dataset

- Rows: 105
- Minimum rows for policy claim: 100
- Enough rows for policy claim: yes
- Minimum task signatures for diversity claim: 6
- Enough task signatures for diversity claim: yes
- Positive use rows: 21
- Negative use rows: 21
- Blocked or suppressed rows: 49
- Rehydrate requested rows: 7

## Caveats

- This is an offline proxy comparison over admission dataset rows, not a counterfactual Agent rerun.
- Raw retrieval prompt proxy treats prompt-included candidates as direct-use memory because candidate ranks are not preserved in the dataset.
- Do not use this report to mutate Runtime gates without holdout validation.
