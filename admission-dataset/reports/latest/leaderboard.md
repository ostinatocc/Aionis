# Aionis Admission Dataset Evaluation

Policy: `AIONIS_ADMISSION_POLICY_V1` (2026-06-17, deterministic_admission)

| Metric | Value |
|---|---:|
| Rows | 536 |
| Runs | 316 |
| Tasks | 316 |
| Task signatures | 43 |
| minimum rows for policy claim | 100 |
| enough rows for policy claim | yes |
| minimum task signatures for diversity claim | 6 |
| enough task signatures for diversity claim | yes |
| use_now positive rate | 41.5% |
| use_now negative rate | 49.4% |
| use_now unused rate | 9.2% |
| unused exposed rate | 5.4% |
| blocked / suppressed rows | 191 |
| rehydrate requested rows | 29 |
| policy metadata coverage | 100% |

## Buckets

| Dimension | Key | Rows | use_now | Positive use | Negative use | Unused exposed |
|---|---|---:|---:|---:|---:|---:|
| admission_action | use_now | 316 | 316 | 131 | 156 | 29 |
| admission_action | do_not_use | 191 | 0 | 0 | 0 | 0 |
| outcome_label | blocked_or_suppressed | 191 | 0 | 0 | 0 | 0 |
| outcome_label | negative_use | 156 | 156 | 0 | 156 | 0 |
| outcome_label | positive_use | 131 | 131 | 131 | 0 | 0 |
| admission_action | rehydrate | 29 | 0 | 0 | 0 | 0 |
| outcome_label | rehydrate_requested | 29 | 0 | 0 | 0 | 0 |
| outcome_label | unused_exposed | 29 | 29 | 0 | 0 | 29 |

## Risk Flags

- `use_now_negative_use_present`

## Recommendations

- `inspect_negative_use_rows_before_policy_change`
