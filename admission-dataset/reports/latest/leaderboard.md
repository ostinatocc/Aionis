# Aionis Admission Dataset Evaluation

Policy: `AIONIS_ADMISSION_POLICY_V1` (2026-06-17, deterministic_admission)

| Metric | Value |
|---|---:|
| Rows | 436 |
| Runs | 216 |
| Tasks | 216 |
| Task signatures | 35 |
| minimum rows for policy claim | 100 |
| enough rows for policy claim | yes |
| minimum task signatures for diversity claim | 6 |
| enough task signatures for diversity claim | yes |
| use_now positive rate | 42.1% |
| use_now negative rate | 44.4% |
| use_now unused rate | 13.4% |
| unused exposed rate | 6.7% |
| blocked / suppressed rows | 191 |
| rehydrate requested rows | 29 |
| policy metadata coverage | 100% |

## Buckets

| Dimension | Key | Rows | use_now | Positive use | Negative use | Unused exposed |
|---|---|---:|---:|---:|---:|---:|
| admission_action | use_now | 216 | 216 | 91 | 96 | 29 |
| admission_action | do_not_use | 191 | 0 | 0 | 0 | 0 |
| outcome_label | blocked_or_suppressed | 191 | 0 | 0 | 0 | 0 |
| outcome_label | negative_use | 96 | 96 | 0 | 96 | 0 |
| outcome_label | positive_use | 91 | 91 | 91 | 0 | 0 |
| admission_action | rehydrate | 29 | 0 | 0 | 0 | 0 |
| outcome_label | rehydrate_requested | 29 | 0 | 0 | 0 | 0 |
| outcome_label | unused_exposed | 29 | 29 | 0 | 0 | 29 |

## Risk Flags

- `use_now_negative_use_present`

## Recommendations

- `inspect_negative_use_rows_before_policy_change`
