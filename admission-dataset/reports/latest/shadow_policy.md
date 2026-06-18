# Aionis Admission Shadow Policy Report

Shadow policy candidate_project_context_closed_loop_inspect would change 175/776 recorded admission actions, downgrade 175 direct-use memories, and preserve all Runtime hard boundaries.

## Policy

- Candidate policy: `candidate_project_context_closed_loop_inspect`
- Runtime mutation: false
- Agent prompt included: false
- Label leakage guard: true
- Hard actions preserved: true

## Recorded vs Shadow

| Arm | Direct use | Positive direct | Negative direct | Unused direct | Hard-boundary direct | Missed positive | Negative direct rate | Positive precision proxy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Recorded | 556 | 227 | 300 | 29 | 0 | 0 | 54.0% | 40.8% |
| Shadow | 381 | 227 | 154 | 0 | 0 | 0 | 40.4% | 59.6% |

## Delta

| Metric | Value |
|---|---:|
| Changed actions | 175 |
| Would downgrade use_now | 175 |
| Direct-use delta | -175 |
| Negative direct delta | -146 |
| Unused direct delta | -29 |
| Missed positive delta | 0 |
| Hard-boundary direct delta | 0 |

## Dataset

- Rows: 776
- Task signatures: 55
- Runs: 556
- Guide traces: 556

## Guards

- Used fields: `admission_action`, `source_backend`, `memory_type`, `closed_loop_effect_state`, `repeated_negative_posture`
- Forbidden decision fields: `outcome_label`, `feedback_outcome`, `attribution_strength`, `agent_used`, `title`, `task_signature`, `run_id`, `task_id`, `guide_trace_id`, `memory_id`, `prompt_char_count`

## Caveats

- This is a dataset-level shadow audit. It does not enable the candidate policy in Runtime guide outputs.
- Outcome labels are used only for offline evaluation metrics, never for the candidate action decision.
