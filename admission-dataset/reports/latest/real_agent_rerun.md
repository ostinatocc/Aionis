# Aionis Admission Real Agent Rerun

Real Agent rerun candidate_aionis_project_context_only: accepted_action_rate=0.3077, hard_boundary_direct_use_rate=0, negative_direct_risk_rate=0.3077, non_actionable_direct_attention=0 vs recorded 5.

## Scope

- LLM provider: `deepseek`
- LLM model: `deepseek-chat`
- Evaluated split: `holdout`
- Groups: 13
- Rows: 293 / 411
- Candidate: `candidate_aionis_project_context_only`

## Arms

| Arm | Accepted action | Hard-boundary direct-use | Negative direct risk | Non-actionable direct attention | Missed actionable | Boundary ignored | Request chars |
|---|---:|---:|---:|---:|---:|---:|---:|
| Recorded Runtime policy | 30.8% | 0.0% | 30.8% | 5 | 0.0% | 0 | 273520 |
| Candidate policy: candidate_aionis_project_context_only | 30.8% | 0.0% | 30.8% | 0 | 0.0% | 0 | 274089 |

## Checks

| Check | Result |
|---|---|
| no Runtime mutation | yes |
| label leakage guard | yes |
| no hard-boundary direct-use regression | yes |
| no negative direct-risk regression | yes |
| no missed actionable regression | yes |
| accepted action rate not worse | yes |
| reduces non-actionable direct attention | yes |

## Caveats

- This report uses a real external LLM call, but the task is still an admission dataset rerun rather than a full tool-executing coding Agent.
- Prompt packs exclude outcome labels, feedback outcomes, attribution strength, prompt text, and raw memory payloads.
- Scoring uses admission dataset labels after the LLM decision; negative_use remains weak run-level supervision.
