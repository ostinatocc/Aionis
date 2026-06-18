# Aionis Admission Candidate Policy Evaluation

Selected candidate_project_context_closed_loop_inspect on train; holdout calibration_score=0.7971, recorded=0.729, eligible_for_manual_review=true.

| Split | Rows | Groups |
|---|---:|---:|
| Train | 191 | 21 |
| Holdout | 345 | 22 |

## Selected Policy

- Policy: `candidate_project_context_closed_loop_inspect`
- Eligible for manual review: yes
- Holdout calibration score: 0.7971
- Recorded holdout calibration score: 0.7290

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
| 1 | Project context + closed-loop inspect-first | 0.8115 | 100.0% | 36 | 0 | 0 | 39 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.8024 | 100.0% | 36 | 0 | 7 | 32 | 0 |
| 3 | Aionis project-context direct-use only | 0.6440 | 100.0% | 68 | 0 | 0 | 7 | 0 |
| 4 | External current inspect-first | 0.6440 | 100.0% | 68 | 0 | 0 | 7 | 0 |
| 5 | Recorded policy baseline | 0.6349 | 100.0% | 68 | 0 | 7 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0091 | 0.0% | 0 | 0 | 7 | 123 | 55 |

## Holdout Scores

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Project context + closed-loop inspect-first | 0.7971 | 100.0% | 70 | 0 | 0 | 40 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.7812 | 100.0% | 70 | 0 | 22 | 18 | 0 |
| 3 | Aionis project-context direct-use only | 0.7449 | 100.0% | 88 | 0 | 0 | 22 | 0 |
| 4 | External current inspect-first | 0.7449 | 100.0% | 88 | 0 | 0 | 22 | 0 |
| 5 | Recorded policy baseline | 0.7290 | 100.0% | 88 | 0 | 22 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0159 | 0.0% | 0 | 0 | 22 | 164 | 76 |

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
