# Aionis Admission Real Agent Rerun

Real Agent rerun candidate_project_context_closed_loop_inspect: accepted_action_rate=0.4286, hard_boundary_direct_use_rate=0, negative_direct_risk_rate=0.1071, non_actionable_direct_attention=0 vs recorded 4.

## Scope

- LLM provider: `deepseek`
- LLM model: `deepseek-chat`
- Evaluated split: `holdout`
- Groups: 28
- Rows: 332 / 626
- Candidate: `candidate_project_context_closed_loop_inspect`

## Arms

| Arm | Accepted action | Hard-boundary direct-use | Negative direct risk | Non-actionable direct attention | Missed actionable | Boundary ignored | Request chars |
|---|---:|---:|---:|---:|---:|---:|---:|
| Recorded Runtime policy | 42.9% | 0.0% | 25.0% | 4 | 0.0% | 0 | 432574 |
| Candidate policy: candidate_project_context_closed_loop_inspect | 42.9% | 0.0% | 10.7% | 0 | 0.0% | 0 | 434561 |

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
