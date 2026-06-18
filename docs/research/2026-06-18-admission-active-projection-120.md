# Admission Active Projection 120-Row Baseline

Date: 2026-06-18

Runtime workspace: `/Volumes/ziel/AionisRuntime-focused`

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

## Conclusion

The 120-row active/off baseline supports one claim:

> The active closed-loop projection reaches the real exported admission surface
> and reduces direct-use negative rows without losing positive-use rows.

It does not yet support a stronger claim that the active projection improves a
task-signature grouped real Agent rerun. The current rerun grouping is too broad
for that conclusion because it collapses different loop times into one prompt.

## Next Step

Run the real Agent rerun in a time-sliced mode before using it for promotion:

1. evaluate by `run_id` or `guide_trace_id`, not only `task_signature`;
2. report first-use exploration negatives separately from prior-aware
   contradicted negatives;
3. require the active recorded Runtime surface to preserve positive capture and
   reduce prior-aware negative direct risk;
4. only then compare against the offline candidate policy.

The existing CLI already supports `--split-by run_id`, but a full 120-row run
would require substantially more LLM calls than the task-signature grouped run.
That should be scheduled as the next validation step rather than folded into
this baseline.
