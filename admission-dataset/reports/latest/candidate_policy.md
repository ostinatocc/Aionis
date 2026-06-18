# Aionis Admission Candidate Policy Evaluation

Selected candidate_project_context_closed_loop_inspect on train; holdout calibration_score=0.8009, recorded=0.5803, eligible_for_manual_review=true.

| Split | Rows | Groups |
|---|---:|---:|
| Train | 309 | 27 |
| Holdout | 467 | 28 |

## Selected Policy

- Policy: `candidate_project_context_closed_loop_inspect`
- Eligible for manual review: yes
- Holdout calibration score: 0.8009
- Recorded holdout calibration score: 0.5803

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
| 1 | Project context + closed-loop inspect-first | 0.8026 | 100.0% | 61 | 0 | 0 | 57 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.7953 | 100.0% | 61 | 0 | 9 | 48 | 0 |
| 3 | Aionis project-context direct-use only | 0.6472 | 100.0% | 109 | 0 | 0 | 9 | 0 |
| 4 | External current inspect-first | 0.6472 | 100.0% | 109 | 0 | 0 | 9 | 0 |
| 5 | Recorded policy baseline | 0.6399 | 100.0% | 109 | 0 | 9 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0073 | 0.0% | 0 | 0 | 9 | 191 | 82 |

## Holdout Scores

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Project context + closed-loop inspect-first | 0.8009 | 100.0% | 93 | 0 | 0 | 118 | 0 |
| 2 | Closed-loop contradicted inspect-first | 0.7902 | 100.0% | 93 | 0 | 20 | 98 | 0 |
| 3 | Aionis project-context direct-use only | 0.5910 | 100.0% | 191 | 0 | 0 | 20 | 0 |
| 4 | External current inspect-first | 0.5910 | 100.0% | 191 | 0 | 0 | 20 | 0 |
| 5 | Recorded policy baseline | 0.5803 | 100.0% | 191 | 0 | 20 | 0 | 0 |
| 6 | Advisory inspect-first | -0.0107 | 0.0% | 0 | 0 | 20 | 336 | 145 |

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
