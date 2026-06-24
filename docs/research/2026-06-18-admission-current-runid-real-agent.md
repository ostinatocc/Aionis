# Admission Current Dataset Run-ID Real Agent Rerun

Date: 2026-06-18

Runtime repository: Aionis public Runtime

Runtime base: `7de04f2`

Local report directory:

```text
.tmp/admission-real-agent-current-runid/
```

## Scope

This report extends the admission-policy validation from the focused 120-row
active/off profile to the current accumulated admission dataset.

The current dataset is larger than the earlier baseline:

| Metric | Value |
|---|---:|
| Rows | 776 |
| `run_id` time-slice groups | 556 |
| Task signatures | 55 |

This is a mixed accumulated dataset. It includes older admission rows without
closed-loop prior-state fields and newer rows with `no_prior`, `supported`, and
`contradicted` prior-state features. Treat it as a current regression dataset,
not as a clean single-arm product experiment.

## Command

Secrets were supplied through environment variables and are intentionally not
recorded here.

```bash
npm run -s admission:real-agent-rerun -- \
  --input admission-dataset/rows.jsonl \
  --out-dir .tmp/admission-real-agent-current-runid \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all \
  --split-by run_id
```

LLM rerun configuration:

| Field | Value |
|---|---|
| Provider | `deepseek` |
| Model | `deepseek-chat` |
| Base URL host | `api.deepseek.com` |
| Runtime mutation | no |
| Label leakage guard | yes |

## Result

The rerun compared the recorded Runtime policy against:

```text
candidate_project_context_closed_loop_inspect
```

That candidate keeps hard boundaries, keeps direct-use limited to Aionis
project-context candidates, and downgrades prior-contradicted or
repeated-negative candidates to `inspect_before_use`.

Top-level results:

| Policy surface | Trials | Accepted | Negative direct risk | Non-actionable direct attention | Hard-boundary direct-use | Missed actionable |
|---|---:|---:|---:|---:|---:|---:|
| Recorded Runtime | 556 | 227 | 224 | 29 | 0 | 0 |
| Candidate policy | 556 | 227 | 154 | 0 | 0 | 0 |

Rates:

| Policy surface | Accepted rate | Negative direct risk rate | Non-actionable direct attention rate |
|---|---:|---:|---:|
| Recorded Runtime | 40.8% | 40.3% | 5.2% |
| Candidate policy | 40.8% | 27.7% | 0.0% |

Prior-state slices:

| Policy surface | Selected no-prior | Selected prior-aware | First-use negative direct risk | Prior-aware negative direct risk |
|---|---:|---:|---:|---:|
| Recorded Runtime | 337 | 193 | 154 | 70 |
| Candidate policy | 334 | 219 | 154 | 0 |

Prior-state rates:

| Policy surface | First-use negative direct risk rate | Prior-aware negative direct risk rate |
|---|---:|---:|
| Recorded Runtime | 45.7% | 36.3% |
| Candidate policy | 46.1% | 0.0% |

Request character totals:

| Policy surface | Request chars |
|---|---:|
| Recorded Runtime | 2,235,309 |
| Candidate policy | 2,260,586 |

Promotion checks:

| Check | Result |
|---|---|
| No Runtime mutation | pass |
| Label leakage guard | pass |
| No hard-boundary direct-use regression | pass |
| No negative direct-risk regression | pass |
| No missed actionable regression | pass |
| Accepted action rate not worse | pass |
| Reduces non-actionable direct attention | pass |

## Interpretation

The current-dataset rerun supports the same core direction as the 120-row
time-sliced run, but on a broader mixed dataset:

> Candidate closed-loop inspection keeps accepted actions unchanged while
> removing prior-aware negative direct-use in the real LLM rerun.

The important split is:

```text
first-use negative direct risk: unchanged at 154
prior-aware negative direct risk: 70 -> 0
```

This is the expected behavior. Aionis cannot know a memory is harmful before
feedback exists. The useful policy target is to prevent already-contradicted or
repeated-negative memory from continuing to drive direct action.

The candidate also removed non-actionable direct attention:

```text
recorded Runtime: 29
candidate policy: 0
```

That is a second positive signal: the policy reduces noise without losing the
same number of accepted actions.

## Caveats

1. This is a real external LLM rerun over admission prompt packs, not a full
   tool-executing coding Agent benchmark.
2. `negative_use` remains weak run-level supervision. It is useful for policy
   regression but not yet per-memory counterfactual causality.
3. The dataset is mixed across policy generations. Some older rows do not carry
   closed-loop prior-state fields.
4. Request character totals are slightly higher for the candidate arm because
   it changes the prompt surface rather than compressing the prompt.

## Next Step

The next promotion step should not be another broad rerun. It should be a
targeted Runtime integration check:

1. wire the candidate as a shadow/active projection under a named policy version;
2. collect a fresh single-policy dataset after that projection is active;
3. rerun `--split-by run_id` on the fresh dataset;
4. require:
   - accepted actions not worse;
   - prior-aware negative direct risk remains 0;
   - non-actionable direct attention remains lower;
   - first-use negative risk is reported separately, not treated as admission
     failure.
