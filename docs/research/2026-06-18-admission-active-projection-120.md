# Admission Active Projection 120-Row Baseline

Date: 2026-06-18

Runtime repository: Aionis public Runtime

Runtime base: `c127f6a`

Local report directories:

```text
.tmp/admission-projection-off-120/
.tmp/admission-projection-active-120/
.tmp/admission-real-agent-off-120/
.tmp/admission-real-agent-active-120/
```

## Scope

This note checks whether the closed-loop prior-state projection that reached
the product guide surface changes actual exported admission rows.

It compares two controlled 120-row batches over the same profile:

| Arm | Meaning |
|---|---|
| `off` | Baseline admission export without the active Runtime projection |
| `active` | Runtime export with closed-loop projection active |

The batch profile is `closed-loop-prior-fresh-2`. It is a focused product-loop
fixture for admission-policy data quality, not a broad external benchmark.

## Commands

Secrets were supplied through environment variables and are intentionally not
recorded here.

```bash
# Off projection
npm run -s admission:batch-collect -- \
  --dataset-dir .tmp/admission-projection-off-120 \
  --iterations 4 \
  --chunk-prefix off \
  --profile closed-loop-prior-fresh-2

# Active projection
npm run -s admission:batch-collect -- \
  --dataset-dir .tmp/admission-projection-active-120 \
  --iterations 4 \
  --chunk-prefix active \
  --profile closed-loop-prior-fresh-2

# Real LLM rerun, task-signature grouped.
# deepseek-v4-flash returned reasoning-only / truncated JSON for this JSON-only
# validator task, so the stable rerun used deepseek-chat.
npm run -s admission:real-agent-rerun -- \
  --input .tmp/admission-projection-off-120/rows.jsonl \
  --out-dir .tmp/admission-real-agent-off-120 \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all

npm run -s admission:real-agent-rerun -- \
  --input .tmp/admission-projection-active-120/rows.jsonl \
  --out-dir .tmp/admission-real-agent-active-120 \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all
```

LLM rerun configuration:

| Field | Value |
|---|---|
| Provider | `deepseek` |
| Model | `deepseek-chat` |
| Base URL host | `api.deepseek.com` |
| Runtime mutation | no |
| Label leakage guard | yes |

## Row-Level Result

Both batches cleared the policy-claim gates:

| Gate | Off | Active |
|---|---:|---:|
| Rows | 120 | 120 |
| Task signatures | 12 | 12 |
| Minimum rows gate | pass | pass |
| Minimum task signatures gate | pass | pass |

Admission surface:

| Metric | Off | Active | Change |
|---|---:|---:|---:|
| `use_now` rows | 96 | 72 | -24 |
| `inspect_before_use` rows | 24 | 48 | +24 |
| `positive_use` rows | 48 | 48 | unchanged |
| `negative_use` rows in direct-use surface | 48 | 24 | -24 |
| `unused_exposed` rows | 24 | 48 | +24 |
| Negative direct-use row rate | 50.0% | 33.3% | -16.7 pp |

Row-level interpretation:

The active projection does what it was supposed to do at the exported admission
surface: it demotes 24 risky direct-use rows into inspect-first while preserving
all 48 positive-use rows. This is positive evidence for the prior-state feature
path and for the active Runtime projection wiring.

## Real Agent Rerun

The real LLM rerun used the current task-signature grouped prompt pack. That
means each task-signature group can contain multiple loop steps, including the
first step before feedback and later steps after feedback.

| Arm | Policy surface | Trials | Accepted actions | Negative direct risk | Hard boundary direct use |
|---|---|---:|---:|---:|---:|
| Off | recorded Runtime | 12 | 6 | 2 | 0 |
| Off | candidate policy | 12 | 6 | 0 | 0 |
| Active | recorded Runtime | 12 | 6 | 6 | 0 |
| Active | candidate policy | 12 | 6 | 4 | 0 |

Request character totals:

| Arm | Policy surface | Request chars |
|---|---|---:|
| Off | recorded Runtime | 161,466 |
| Off | candidate policy | 162,234 |
| Active | recorded Runtime | 157,962 |
| Active | candidate policy | 158,466 |

Real-Agent interpretation:

The task-signature grouped rerun is useful as a prompt-level stress test, but it
is not valid promotion evidence for the active projection. It mixes first-use
exploration rows with later closed-loop rows. In the active dataset, the LLM
selected several `negative_use` memories that still had:

```text
prior_contradicted_use_count = 0
closed_loop_effect_state = no_prior
```

Those rows are expected first-use exploration negatives. Aionis cannot know a
memory is harmful before any feedback exists. The later rows for the same
memory were correctly downgraded to `inspect_before_use` once contradiction
evidence existed.

## Time-Sliced Real Agent Rerun

After the task-signature grouped run, the rerun harness was extended to report
prior-state slices. The real LLM rerun was then repeated with:

```bash
npm run -s admission:real-agent-rerun -- \
  --input .tmp/admission-projection-active-120/rows.jsonl \
  --out-dir .tmp/admission-real-agent-active-120-runid \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all \
  --split-by run_id

npm run -s admission:real-agent-rerun -- \
  --input .tmp/admission-projection-off-120/rows.jsonl \
  --out-dir .tmp/admission-real-agent-off-120-runid \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all \
  --split-by run_id
```

This uses one time-slice per `run_id`, so the first-use exploration step is no
longer mixed with later prior-aware steps.

Recorded Runtime policy:

| Arm | Trials | Accepted | Overall negative direct risk | First-use negative direct risk | Prior-aware negative direct risk |
|---|---:|---:|---:|---:|---:|
| Off | 120 | 48 | 44 | 24 | 20 |
| Active | 120 | 48 | 24 | 24 | 0 |

Rates:

| Arm | Accepted rate | Overall negative direct risk rate | First-use negative direct risk rate | Prior-aware negative direct risk rate |
|---|---:|---:|---:|---:|
| Off | 40.0% | 36.7% | 50.0% | 29.0% |
| Active | 40.0% | 20.0% | 50.0% | 0.0% |

Request character totals:

| Arm | Recorded Runtime request chars |
|---|---:|
| Off | 433,596 |
| Active | 430,092 |

Time-sliced interpretation:

This is the promotion-relevant read. The active Runtime projection does not try
to prevent first-use exploration negatives; those rows have no contradiction
evidence yet. It does prevent prior-aware contradicted rows from being selected
for direct use in the real LLM rerun:

```text
off recorded prior-aware negative direct risk: 20
active recorded prior-aware negative direct risk: 0
```

The offline candidate policy also reaches 0 prior-aware negative direct risk on
the off dataset, but on the active dataset it slightly underperforms recorded
Runtime policy on accepted actions (`47` vs `48`). That means the active
Runtime surface is already the better promotion target here; the offline
candidate should remain an analysis arm, not an automatic replacement.

## Conclusion

The 120-row active/off baseline supports one claim:

> The active closed-loop projection reaches the real exported admission surface
> and reduces direct-use negative rows without losing positive-use rows.

The time-sliced rerun supports a stronger, narrower claim:

> Once feedback creates prior contradiction evidence, the active Runtime
> projection prevents prior-aware negative direct-use in the real LLM rerun
> without reducing accepted actions.

It does not claim that Aionis can prevent first-use exploration failures before
feedback exists. Those failures remain expected evidence-generation events.

## Next Step

Use this run as a promotion baseline for the active projection, then broaden it:

1. run the same `run_id` prior-slice report on the larger 411-row admission
   dataset;
2. keep first-use and prior-aware risk separated in every report;
3. only promote policy changes that improve prior-aware risk without reducing
   accepted actions;
4. keep the offline candidate policy as a comparison arm until it beats recorded
   Runtime policy on the time-sliced real Agent rerun.
