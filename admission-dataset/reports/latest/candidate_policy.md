# Aionis Admission Candidate Policy Evaluation

Selected candidate_project_context_closed_loop_inspect on train; holdout calibration_score=0.7934, recorded=0.7631, eligible_for_manual_review=true.

| Split | Rows | Groups |
|---|---:|---:|
| Train | 131 | 17 |
| Holdout | 305 | 18 |

## Selected Policy

- Policy: `candidate_project_context_closed_loop_inspect`
- Eligible for manual review: yes
- Holdout calibration score: 0.7934
- Recorded holdout calibration score: 0.7631

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
| 1 | Project context + closed-loop inspect-first | 0.8244 | 100.0% | 23 | 0 | 0 | 14 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.8091 | 100.0% | 23 | 0 | 8 | 6 | 0 |
| 3 | Aionis project-context direct-use only | 0.7786 | 100.0% | 29 | 0 | 0 | 8 | 0 |
| 4 | External current inspect-first | 0.7786 | 100.0% | 29 | 0 | 0 | 8 | 0 |
| 5 | Recorded policy baseline | 0.7633 | 100.0% | 29 | 0 | 8 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0153 | 0.0% | 0 | 0 | 8 | 60 | 31 |

## Holdout Scores

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Project context + closed-loop inspect-first | 0.7934 | 100.0% | 63 | 0 | 0 | 25 | 0 |
| 2 | Aionis project-context direct-use only | 0.7803 | 100.0% | 67 | 0 | 0 | 21 | 0 |
| 3 | External current inspect-first | 0.7803 | 100.0% | 67 | 0 | 0 | 21 | 0 |
| 4 | Closed-loop contradicted inspect-first | 0.7762 | 100.0% | 63 | 0 | 21 | 4 | 0 |
| 5 | Recorded policy baseline | 0.7631 | 100.0% | 67 | 0 | 21 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0172 | 0.0% | 0 | 0 | 21 | 127 | 60 |

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
