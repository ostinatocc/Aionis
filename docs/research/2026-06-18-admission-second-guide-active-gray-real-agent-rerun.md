# Aionis Admission Second Guide Active Gray Real-Agent Rerun

Date: 2026-06-18

This run validates the second guide-profile active gray dataset with a real
external LLM Agent rerun. It uses the isolated active gray dataset from `/tmp`
and does not change the default Runtime configuration.

## Input

```text
/tmp/aionis-admission-active-gray-fresh-20260618-205203/rows.jsonl
```

Candidate policy:

```text
candidate_project_context_closed_loop_inspect
```

LLM:

```text
provider: deepseek
model: deepseek-chat
base_url_host: api.deepseek.com
```

## Result

| Metric | Recorded Runtime policy | Candidate policy |
|---|---:|---:|
| Accepted action rate | 50.0% | 50.0% |
| Hard-boundary direct-use rate | 0.0% | 0.0% |
| Negative direct-risk rate | 50.0% | 37.5% |
| Non-actionable direct attention | 0 | 0 |
| Missed actionable rate | 0.0% | 0.0% |
| Boundary ignored | 0 | 0 |
| Request chars | 147,996 | 148,332 |

Prior-state slices:

| Metric | Recorded Runtime policy | Candidate policy |
|---|---:|---:|
| Selected no-prior | 8 | 8 |
| Selected prior-aware | 0 | 0 |
| First-use negative direct risk | 4 / 8 (50.0%) | 3 / 8 (37.5%) |
| Prior-aware negative direct risk | 0 / 0 (0.0%) | 0 / 0 (0.0%) |

## Checks

| Check | Result |
|---|---|
| No Runtime mutation | pass |
| Label leakage guard | pass |
| No hard-boundary direct-use regression | pass |
| No negative direct-risk regression | pass |
| No missed actionable memory regression | pass |
| Accepted action rate not worse | pass |
| Reduces non-actionable direct attention | not applicable / no change |

## Interpretation

The real-Agent rerun supports the second guide-profile active gray result:

- the candidate policy did not reduce accepted action rate;
- it did not cause hard-boundary direct-use;
- it did not miss actionable memories;
- it reduced negative direct-risk under the same evaluated split;
- it did not introduce Runtime mutation.

The remaining caveat is unchanged: this is an admission dataset rerun with a
real LLM decision layer, not a full tool-executing coding Agent run. It supports
continued isolated active gray testing across the two validated guide profiles,
but it still does not authorize default active mode or active rollout for
external backend candidates.

