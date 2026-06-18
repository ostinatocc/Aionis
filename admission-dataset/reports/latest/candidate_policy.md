# Aionis Admission Candidate Policy Evaluation

Selected candidate_project_context_closed_loop_inspect on train; holdout calibration_score=0.7952, recorded=0.6356, eligible_for_manual_review=true.

| Split | Rows | Groups |
|---|---:|---:|
| Train | 294 | 27 |
| Holdout | 332 | 28 |

## Selected Policy

- Policy: `candidate_project_context_closed_loop_inspect`
- Eligible for manual review: yes
- Holdout calibration score: 0.7952
- Recorded holdout calibration score: 0.6356

## Holdout Promotion Gate

| Gate | Result |
|---|---|
| no hard-boundary regression | yes |
| train candidate supported | yes |
| train calibration score not worse | yes |
| no negative-use count regression | yes |
| no positive-capture regression | yes |
| calibration score improved | yes |
| changed actions on holdout | yes |

## Train Leaderboard

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Project context + closed-loop inspect-first | 0.8095 | 100.0% | 56 | 0 | 0 | 47 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.8018 | 100.0% | 56 | 0 | 9 | 38 | 0 |
| 3 | Aionis project-context direct-use only | 0.6803 | 100.0% | 94 | 0 | 0 | 9 | 0 |
| 4 | External current inspect-first | 0.6803 | 100.0% | 94 | 0 | 0 | 9 | 0 |
| 5 | Recorded policy baseline | 0.6727 | 100.0% | 94 | 0 | 9 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0076 | 0.0% | 0 | 0 | 9 | 176 | 82 |

## Holdout Scores

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Project context + closed-loop inspect-first | 0.7952 | 100.0% | 68 | 0 | 0 | 68 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.7802 | 100.0% | 68 | 0 | 20 | 48 | 0 |
| 3 | Aionis project-context direct-use only | 0.6506 | 100.0% | 116 | 0 | 0 | 20 | 0 |
| 4 | External current inspect-first | 0.6506 | 100.0% | 116 | 0 | 0 | 20 | 0 |
| 5 | Recorded policy baseline | 0.6356 | 100.0% | 116 | 0 | 20 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0150 | 0.0% | 0 | 0 | 20 | 201 | 85 |

## Guards

- Runtime mutation: false
- Agent prompt included: false
- Label leakage guard: true
- Hard actions preserved: true
- Forbidden decision fields: `outcome_label`, `feedback_outcome`, `attribution_strength`, `agent_used`, `title`, `task_signature`, `run_id`, `task_id`, `guide_trace_id`, `memory_id`, `prompt_char_count`

## Caveats

- This is an offline candidate-policy evaluation over exported admission rows, not a counterfactual Agent rerun.
- Candidate decisions are restricted to label-safe fields and cannot upgrade do_not_use or rehydrate rows to direct use.
- A candidate marked eligible is eligible for manual review only; it must not mutate Runtime gates by itself.
