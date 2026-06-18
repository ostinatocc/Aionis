# Aionis Admission Dataset Evaluation

Policy: `AIONIS_ADMISSION_POLICY_V1` (2026-06-17, deterministic_admission)

| Metric | Value |
|---|---:|
| Rows | 105 |
| Runs | 49 |
| Tasks | 49 |
| Task signatures | 7 |
| minimum rows for policy claim | 100 |
| enough rows for policy claim | yes |
| minimum task signatures for diversity claim | 6 |
| enough task signatures for diversity claim | yes |
| use_now positive rate | 42.9% |
| use_now negative rate | 42.9% |
| use_now unused rate | 14.3% |
| unused exposed rate | 6.7% |
| blocked / suppressed rows | 49 |
| rehydrate requested rows | 7 |
| policy metadata coverage | 100% |

## Buckets

| Dimension | Key | Rows | use_now | Positive use | Negative use | Unused exposed |
|---|---|---:|---:|---:|---:|---:|
| admission_action | do_not_use | 49 | 0 | 0 | 0 | 0 |
| admission_action | use_now | 49 | 49 | 21 | 21 | 7 |
| outcome_label | blocked_or_suppressed | 49 | 0 | 0 | 0 | 0 |
| outcome_label | negative_use | 21 | 21 | 0 | 21 | 0 |
| outcome_label | positive_use | 21 | 21 | 21 | 0 | 0 |
| admission_action | rehydrate | 7 | 0 | 0 | 0 | 0 |
| outcome_label | rehydrate_requested | 7 | 0 | 0 | 0 | 0 |
| outcome_label | unused_exposed | 7 | 7 | 0 | 0 | 7 |

## Risk Flags

- `use_now_negative_use_present`

## Recommendations

- `inspect_negative_use_rows_before_policy_change`
