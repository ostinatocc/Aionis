# Aionis Admission Policy Comparison

Compared 4 admission policies over 436 rows; Aionis score=0.5556, raw retrieval proxy score=0.2752.

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5556 | 100.0% | 44.4% | 42.1% | 216 | 0 |
| 2 | Always use | 0.2752 | 100.0% | 72.5% | 20.9% | 436 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2752 | 100.0% | 72.5% | 20.9% | 436 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 91 |

## Dataset

- Rows: 436
- Minimum rows for policy claim: 100
- Enough rows for policy claim: yes
- Minimum task signatures for diversity claim: 6
- Enough task signatures for diversity claim: yes
- Positive use rows: 91
- Negative use rows: 96
- Blocked or suppressed rows: 191
- Rehydrate requested rows: 29

## Caveats

- This is an offline proxy comparison over admission dataset rows, not a counterfactual Agent rerun.
- Raw retrieval prompt proxy treats prompt-included candidates as direct-use memory because candidate ranks are not preserved in the dataset.
- Do not use this report to mutate Runtime gates without holdout validation.
