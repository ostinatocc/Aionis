# Admission Dataset Batch Baseline

Date: 2026-06-18

Runtime workspace: `/Volumes/ziel/AionisRuntime-focused`

Runtime base before this baseline artifact series: `e83e317`

Dataset directory:

```text
admission-dataset/
```

## Scope

This baseline checks whether Aionis can turn real product admission decisions
into an append-only JSONL dataset for future admission-policy audit,
calibration, holdout validation, and candidate-policy comparison.

It measures the data flywheel path, not an external Agent rerun:

```text
remember / observe -> guide -> feedback -> measure
external candidates -> governMemory(mode=firewall)
admission records -> JSONL rows -> collector -> evaluator -> holdout -> candidate policy comparison
```

The export is read-only. It does not train a policy, mutate memory authority, or
enter the Agent prompt.

## Run

Commands:

```bash
# Initial batch
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 7

# Expanded signature batch
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 10 \
  --chunk-prefix runtime-batch-expanded

# Retry after one provider rate-limit failure
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 1 \
  --chunk-prefix runtime-batch-expanded-retry

# Targeted train-support batch after candidate-policy evaluation found a missing bucket
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 1 \
  --chunk-prefix targeted-external-current \
  --profile targeted-external-current
```

The expanded batch hit one upstream embedding 429. The retry succeeded. The
targeted batch appended real `governMemory(mode=firewall)` external-current
rows so candidate-policy evaluation had train-side support for the discovered
bucket.

## Dataset

Report:

```text
admission-dataset/reports/latest/leaderboard.md
```

Result:

| Metric | Value |
|---|---:|
| Rows | 411 |
| Runs | 191 |
| Tasks | 191 |
| Task signatures | 25 |
| Source backends | `aionis`, `mem0`, `zep`, `archive` |

Sample-quality gates:

| Gate | Result |
|---|---:|
| Minimum rows for policy claim | 100 |
| Current rows | 411 |
| Enough rows | yes |
| Minimum task signatures | 6 |
| Current task signatures | 25 |
| Enough task signatures | yes |

Dataset composition:

| Label | Count |
|---|---:|
| `positive_use` | 81 |
| `negative_use` | 81 |
| `blocked_or_suppressed` | 191 |
| `rehydrate_requested` | 29 |
| `unused_exposed` | 29 |

Admission actions:

| Action | Count |
|---|---:|
| `use_now` | 191 |
| `do_not_use` | 191 |
| `rehydrate` | 29 |

The loop intentionally includes positive use, negative attributed use, hard
suppression, pointer-only rehydrate rows, and external-current unused exposure.
This makes the dataset useful for admission-policy calibration, but it is still
a controlled product loop, not a broad external benchmark.

## Policy Comparison

Report:

```text
admission-dataset/reports/latest/policy_comparison.md
```

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5759 | 100.0% | 42.4% | 42.4% | 191 | 0 |
| 2 | Always use | 0.2676 | 100.0% | 73.2% | 19.7% | 411 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2676 | 100.0% | 73.2% | 19.7% | 411 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 81 |

Accepted interpretation:

> On this controlled real Runtime admission dataset, Aionis recorded admission
> keeps all positive-use rows while preventing `blocked_or_suppressed` and
> `rehydrate_requested` rows from becoming direct-use memory. The offline proxy
> baseline shows why admission routing matters, but it is not a substitute for a
> counterfactual Agent rerun.

## Holdout Split

Report:

```text
admission-dataset/reports/latest/holdout.md
```

Command:

```bash
npm run -s admission:holdout -- \
  --input admission-dataset/rows.jsonl \
  --out-dir admission-dataset/reports/latest \
  --split-by task_signature \
  --holdout-ratio 0.5
```

Split result:

| Split | Rows | Task-signature groups |
|---|---:|---:|
| Train | 118 | 12 |
| Holdout | 293 | 13 |

Holdout checks:

| Check | Result |
|---|---:|
| Disjoint groups | yes |
| Recorded Aionis policy is holdout leader | yes |
| Holdout enough rows for policy claim | yes |
| Holdout enough task signatures for diversity claim | yes |

Holdout metrics:

| Metric | Value |
|---|---:|
| `use_now_positive_rate` | 39.7% |
| `use_now_negative_rate` | 44.9% |
| `unused_exposed_rate` | 7.2% |
| `blocked_or_suppressed_count` | 136 |
| `rehydrate_requested_count` | 21 |

The holdout split is useful as a promotion discipline: future tuned rules or
learned classifiers must be evaluated on rows they were not tuned against. This
specific holdout clears the row/signature gates, so it is usable for offline
policy regression and candidate-policy comparison. It is still not a
counterfactual Agent rerun and should not be used by itself for broad market
claims.

## Candidate Policy Evaluation

Report:

```text
admission-dataset/reports/latest/candidate_policy.md
```

Command:

```bash
npm run -s admission:candidate-policy -- \
  --input admission-dataset/rows.jsonl \
  --out-dir admission-dataset/reports/latest \
  --split-by task_signature \
  --holdout-ratio 0.5
```

Selected candidate:

| Field | Value |
|---|---:|
| Policy | `candidate_aionis_project_context_only` |
| Train rows | 118 |
| Train groups | 12 |
| Holdout rows | 293 |
| Holdout groups | 13 |
| Train calibration score | 0.8305 |
| Recorded train calibration score | 0.8136 |
| Holdout calibration score | 0.7918 |
| Recorded holdout calibration score | 0.7739 |
| Eligible for manual review | yes |

Promotion gates:

| Gate | Result |
|---|---:|
| No hard-boundary regression | yes |
| Train candidate supported | yes |
| Train calibration score not worse | yes |
| No negative-use count regression | yes |
| No positive-capture regression | yes |
| Calibration score improved | yes |
| Changed actions on holdout | yes |

Interpretation:

The offline candidate found a stable bucket: external current context-like rows
can be downgraded from direct use to inspect-first without losing positive
capture in this controlled dataset. The targeted batch added train-side support,
so the candidate is now eligible for manual review.

This is not a Runtime policy change. Candidate evaluation remains read-only:

1. candidates use label-safe feature fields only;
2. candidates cannot upgrade `do_not_use` or `rehydrate` rows into direct use;
3. manual-review eligibility is an offline gate, not deployment authority;
4. any Runtime behavior change still requires counterfactual Agent reruns.

## Caveats

1. `raw_retrieval_prompt_proxy` is a weak offline baseline. It treats every
   prompt-included candidate as direct-use memory because candidate ranks are
   not preserved in the dataset.
2. `negative_use` is weak supervision from host feedback attribution. It is not
   yet per-memory counterfactual causality.
3. Candidate-policy comparison should not mutate Runtime gates by itself.
4. The dataset is generated from controlled product scenarios. It is valid for
   admission flywheel plumbing and calibration, not for broad market claims.

## Next Step

The next stage is counterfactual Agent validation for the manual-review
candidate:

1. run a small external Agent rerun with recorded policy vs candidate
   inspect-first policy;
2. measure downstream action quality, wrong direct-use, completion, and token
   cost;
3. keep lifecycle, authority, source, suppression, and rehydrate gates as hard
   boundaries;
4. only consider Runtime policy integration after the candidate improves real
   downstream behavior, not only offline calibration score.
