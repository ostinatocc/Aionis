# Aionis Admission Candidate Policy Evaluation

Selected candidate_aionis_project_context_only on train; holdout calibration_score=0.8062, recorded=0.7875, eligible_for_manual_review=false.

| Split | Rows | Groups |
|---|---:|---:|
| Train | 148 | 6 |
| Holdout | 227 | 7 |

## Selected Policy

- Policy: `candidate_aionis_project_context_only`
- Eligible for manual review: no
- Holdout calibration score: 0.8062
- Recorded holdout calibration score: 0.7875

## Holdout Promotion Gate

| Gate | Result |
|---|---|
| no hard-boundary regression | yes |
| train candidate supported | no |
| train calibration score not worse | yes |
| no negative-use count regression | yes |
| no positive-capture regression | yes |
| calibration score improved | yes |
| changed actions on holdout | yes |

## Train Leaderboard

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Aionis project-context direct-use only | 0.7500 | 100.0% | 37 | 0 | 0 | 0 | 0 |
| 2 | External current inspect-first | 0.7500 | 100.0% | 37 | 0 | 0 | 0 | 0 |
| 3 | Recorded policy baseline | 0.7500 | 100.0% | 37 | 0 | 0 | 0 | 0 |
| 4 | Advisory inspect-first | 0.0000 | 0.0% | 0 | 0 | 0 | 74 | 37 |

## Holdout Scores

| Rank | Policy | Score | Positive capture | Negative direct | Hard-boundary direct | Unused direct | Changed | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Aionis project-context direct-use only | 0.8062 | 100.0% | 44 | 0 | 0 | 17 | 0 |
| 2 | External current inspect-first | 0.8062 | 100.0% | 44 | 0 | 0 | 17 | 0 |
| 3 | Recorded policy baseline | 0.7875 | 100.0% | 44 | 0 | 17 | 0 | 0 |
| 4 | Advisory inspect-first | -0.0187 | 0.0% | 0 | 0 | 17 | 88 | 44 |

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
- Selected candidate made no action changes on train; treat holdout improvement as a discovery, not a promotion signal.
- Selected candidate did not pass all holdout promotion gates.
- Selected candidate did not reduce negative_use direct count; negative_use remains weak run-level supervision.
