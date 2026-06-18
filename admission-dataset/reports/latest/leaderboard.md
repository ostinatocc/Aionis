# Aionis Admission Dataset Evaluation

Policy: `AIONIS_ADMISSION_POLICY_V1` (2026-06-17, deterministic_admission)

| Metric | Value |
|---|---:|
| Rows | 626 |
| Runs | 406 |
| Tasks | 406 |
| Task signatures | 55 |
| minimum rows for policy claim | 100 |
| enough rows for policy claim | yes |
| minimum task signatures for diversity claim | 6 |
| enough task signatures for diversity claim | yes |
| use_now positive rate | 41.1% |
| use_now negative rate | 51.7% |
| use_now unused rate | 7.1% |
| unused exposed rate | 4.6% |
| blocked / suppressed rows | 191 |
| rehydrate requested rows | 29 |
| policy metadata coverage | 100% |

## Buckets

| Dimension | Key | Rows | use_now | Positive use | Negative use | Unused exposed |
|---|---|---:|---:|---:|---:|---:|
| admission_action | use_now | 406 | 406 | 167 | 210 | 29 |
| outcome_label | negative_use | 210 | 210 | 0 | 210 | 0 |
| admission_action | do_not_use | 191 | 0 | 0 | 0 | 0 |
| outcome_label | blocked_or_suppressed | 191 | 0 | 0 | 0 | 0 |
| outcome_label | positive_use | 167 | 167 | 167 | 0 | 0 |
| admission_action | rehydrate | 29 | 0 | 0 | 0 | 0 |
| outcome_label | rehydrate_requested | 29 | 0 | 0 | 0 | 0 |
| outcome_label | unused_exposed | 29 | 29 | 0 | 0 | 29 |

## Risk Flags

- `use_now_negative_use_present`

## Recommendations

- `inspect_negative_use_rows_before_policy_change`
