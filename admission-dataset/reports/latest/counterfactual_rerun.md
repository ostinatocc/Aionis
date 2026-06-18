# Aionis Admission Counterfactual Rerun

Counterfactual candidate_project_context_closed_loop_inspect on holdout: accepted_action_rate=0.4286, hard_boundary_direct_use_rate=0, negative_direct_risk_rate=0.4286, non_actionable_direct_attention=0 vs recorded 4, eligible_for_real_agent_rerun=true.

## Scope

- Agent mode: `deterministic_action_proxy`
- Evaluation split: `holdout`
- Rows: 467 / 776
- Groups: 28
- Candidate: `candidate_project_context_closed_loop_inspect`

## Arms

| Arm | Accepted action | Hard-boundary direct-use | Negative direct risk | Non-actionable direct attention | Positive capture | Direct-use rows | Changed actions | Missed actionable |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Recorded Runtime policy | 42.9% | 0.0% | 42.9% | 4 | 100.0% | 356 | 0 | 0 |
| Candidate policy: candidate_project_context_closed_loop_inspect | 42.9% | 0.0% | 42.9% | 0 | 100.0% | 238 | 118 | 0 |

## Gate

| Check | Result |
|---|---|
| no Runtime mutation | yes |
| deterministic proxy only | yes |
| no hard-boundary direct-use regression | yes |
| no negative direct-risk regression | yes |
| no missed actionable regression | yes |
| accepted action rate not worse | yes |
| reduces non-actionable direct attention | yes |
| candidate changes actions | yes |
| eligible for real Agent rerun | yes |

## Caveats

- This is an offline deterministic action proxy over exported admission rows, not a real LLM Agent rerun.
- The candidate policy is evaluated only as a counterfactual adapter; Runtime admission gates are not mutated.
- The proxy treats use_now memories as action-driving context and inspect_before_use memories as non-direct guidance.
- Outcome labels are admission-dataset supervision, not per-memory counterfactual ground truth.
