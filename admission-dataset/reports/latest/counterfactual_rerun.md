# Aionis Admission Counterfactual Rerun

Counterfactual candidate_aionis_project_context_only on holdout: accepted_action_rate=0.3077, hard_boundary_direct_use_rate=0, negative_direct_risk_rate=0.3077, non_actionable_direct_attention=0 vs recorded 5, eligible_for_real_agent_rerun=true.

## Scope

- Agent mode: `deterministic_action_proxy`
- Evaluation split: `holdout`
- Rows: 293 / 411
- Groups: 13
- Candidate: `candidate_aionis_project_context_only`

## Arms

| Arm | Accepted action | Hard-boundary direct-use | Negative direct risk | Non-actionable direct attention | Positive capture | Direct-use rows | Changed actions | Missed actionable |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Recorded Runtime policy | 30.8% | 0.0% | 30.8% | 5 | 100.0% | 136 | 0 | 0 |
| Candidate policy: candidate_aionis_project_context_only | 30.8% | 0.0% | 30.8% | 0 | 100.0% | 115 | 21 | 0 |

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
