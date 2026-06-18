# Aionis Admission Dataset Evaluation

Policy: `AIONIS_ADMISSION_POLICY_V1` (2026-06-17, deterministic_admission)

| Metric | Value |
|---|---:|
| Rows | 375 |
| Runs | 179 |
| Tasks | 179 |
| Task signatures | 13 |
| minimum rows for policy claim | 100 |
| enough rows for policy claim | yes |
| minimum task signatures for diversity claim | 6 |
| enough task signatures for diversity claim | yes |
| use_now positive rate | 45.3% |
| use_now negative rate | 45.3% |
| use_now unused rate | 9.5% |
| unused exposed rate | 4.5% |
| blocked / suppressed rows | 179 |
| rehydrate requested rows | 17 |
| policy metadata coverage | 100% |

## Buckets

| Dimension | Key | Rows | use_now | Positive use | Negative use | Unused exposed |
|---|---|---:|---:|---:|---:|---:|
| admission_action | do_not_use | 179 | 0 | 0 | 0 | 0 |
| admission_action | use_now | 179 | 179 | 81 | 81 | 17 |
| outcome_label | blocked_or_suppressed | 179 | 0 | 0 | 0 | 0 |
| outcome_label | negative_use | 81 | 81 | 0 | 81 | 0 |
| outcome_label | positive_use | 81 | 81 | 81 | 0 | 0 |
| admission_action | rehydrate | 17 | 0 | 0 | 0 | 0 |
| outcome_label | rehydrate_requested | 17 | 0 | 0 | 0 | 0 |
| outcome_label | unused_exposed | 17 | 17 | 0 | 0 | 17 |

## Risk Flags

- `use_now_negative_use_present`

## Recommendations

- `inspect_negative_use_rows_before_policy_change`
