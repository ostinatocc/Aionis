# Aionis Admission Candidate Policy Evaluation

Selected candidate_aionis_project_context_only on train; holdout calibration_score=0.7918, recorded=0.7739, eligible_for_manual_review=true.

| Split | Rows | Groups |
|---|---:|---:|
| Train | 118 | 12 |
| Holdout | 293 | 13 |

## Selected Policy

- Policy: `candidate_aionis_project_context_only`
- Eligible for manual review: yes
- Holdout calibration score: 0.7918
- Recorded holdout calibration score: 0.7739

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
| 1 | Aionis project-context direct-use only | 0.8305 | 100.0% | 20 | 0 | 0 | 8 | 0 |
| 2 | External current inspect-first | 0.8305 | 100.0% | 20 | 0 | 0 | 8 | 0 |
| 3 | Recorded policy baseline | 0.8136 | 100.0% | 20 | 0 | 8 | 0 | 0 |
| 4 | Advisory inspect-first | -0.0169 | 0.0% | 0 | 0 | 8 | 47 | 27 |

## Holdout Scores

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Aionis project-context direct-use only | 0.7918 | 100.0% | 61 | 0 | 0 | 21 | 0 |
| 2 | External current inspect-first | 0.7918 | 100.0% | 61 | 0 | 0 | 21 | 0 |
| 3 | Recorded policy baseline | 0.7739 | 100.0% | 61 | 0 | 21 | 0 | 0 |
| 4 | Advisory inspect-first | -0.0179 | 0.0% | 0 | 0 | 21 | 115 | 54 |

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
- Selected candidate did not reduce negative_use direct count; negative_use remains weak run-level supervision.
