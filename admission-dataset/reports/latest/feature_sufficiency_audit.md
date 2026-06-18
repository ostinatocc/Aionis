# Aionis Admission Feature Sufficiency Audit

Found 1 positive/negative direct-use feature collision signature(s); negative_direct_risk cannot be reduced safely with the current label-safe feature set without a positive-capture tradeoff.

## Dataset

| Metric | Value |
|---|---:|
| rows | 536 |
| use_now rows | 316 |
| prior-state signal rows | 75 |
| repeated-negative posture rows | 25 |
| label-safe signatures | 5 |
| mixed-outcome signatures | 1 |
| positive/negative collision signatures | 1 |

## Findings

- Has positive/negative collision: yes
- Negative direct risk separable with current label-safe features: no
- Needs new prior-state feature or positive-capture tradeoff: yes

## Top Collisions

| Rows | Positive | Negative | Unused | Outcomes | Sample task signatures |
|---:|---:|---:|---:|---|---|
| 212 | 106 | 106 | 0 | `negative_use`, `positive_use` | `admission-dataset-export:positive-supported`, `admission-dataset-export:negative-attributed`, `admission-dataset-export:positive-feature-flag`, `admission-dataset-export:negative-migration-candidate`, `admission-dataset-export:positive-reviewer-handoff`, `admission-dataset-export:negative-test-stabilization`, `admission-dataset-export:positive-cache-boundary`, `admission-dataset-export:negative-secret-rotation` |

## Signature Features

- `admission_action`
- `memory_origin`
- `source_backend`
- `domain`
- `memory_type`
- `lifecycle_state`
- `authority`
- `decision_kind`
- `actionable`
- `prompt_included`
- `history_used`
- `actionable_history_used`
- `reason_codes`
- `evidence_count`
- `prior_supported_use_count`
- `prior_contradicted_use_count`
- `prior_rehydrate_requested_count`
- `closed_loop_effect_state`
- `repeated_negative_posture`

## Excluded Fields

- `outcome_label`
- `feedback_outcome`
- `attribution_strength`
- `agent_used`
- `title`
- `task_signature`
- `run_id`
- `task_id`
- `guide_trace_id`
- `memory_id`
- `evidence_ids`
- `prompt_char_count`
- `policy_id`
- `policy_version`
- `policy_mode`
- `runtime_version`

## Recommendations

- Do not add task-name or title based rules to reduce negative_direct_risk; that would overfit the dataset.
- Increase closed-loop-prior coverage across fresh task signatures; prior-state signal is present but still too sparse to break the dominant no_prior collision.
- Keep current candidate policies at manual-review/eval level until the added feature is observed on fresh holdout groups.

## Caveats

- This is an offline feature sufficiency audit over exported admission rows, not a Runtime policy change.
- The signature deliberately excludes outcome labels, feedback outcome, attribution strength, prompt text, task names, titles, and raw memory payload.
- A positive/negative collision means a label-safe deterministic policy over the current feature set cannot separate those labels without affecting both classes.
