# Admission Dataset Batch Baseline

Date: 2026-06-18

Runtime workspace: `/Volumes/ziel/AionisRuntime-focused`

Runtime base before this baseline artifact commit: `e83e317`

Dataset directory:

```text
admission-dataset/
```

## Scope

This baseline checks whether Aionis can turn real product admission decisions
into an append-only JSONL dataset for future admission-policy audit,
calibration, and holdout work.

It measures the data flywheel path, not an external Agent rerun:

```text
remember / observe -> guide -> feedback -> measure
external candidates -> governMemory(mode=firewall)
admission records -> JSONL rows -> collector -> evaluator -> policy comparison
```

The export is read-only. It does not train a policy, mutate memory authority, or
enter the Agent prompt.

## Run

Command:

```bash
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 7
```

Result:

| Metric | Value |
|---|---:|
| Iterations requested | 7 |
| Iterations completed | 7 |
| Failures | 0 |
| Rows | 105 |
| Runs | 49 |
| Tasks | 49 |
| Task signatures | 7 |
| Source backends | `aionis`, `mem0`, `zep`, `archive` |

Sample-quality gates:

| Gate | Result |
|---|---:|
| Minimum rows for policy claim | 100 |
| Current rows | 105 |
| Enough rows | yes |
| Minimum task signatures | 6 |
| Current task signatures | 7 |
| Enough task signatures | yes |

## Dataset Composition

| Label | Count |
|---|---:|
| `positive_use` | 21 |
| `negative_use` | 21 |
| `blocked_or_suppressed` | 49 |
| `rehydrate_requested` | 7 |
| `unused_exposed` | 7 |

Admission actions:

| Action | Count |
|---|---:|
| `use_now` | 49 |
| `do_not_use` | 49 |
| `rehydrate` | 7 |

The current loop intentionally includes positive use, negative attributed use,
hard suppression, and pointer-only rehydrate rows. This makes the dataset useful
for admission-policy calibration, but it is still a controlled product loop, not
a broad external benchmark.

## Policy Comparison

Report:

```text
admission-dataset/reports/latest/policy_comparison.md
```

| Rank | Policy | Score | Positive capture | Direct-use risk | Direct-use precision proxy | Direct use | Missed positive |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Aionis recorded policy | 0.5714 | 100.0% | 42.9% | 42.9% | 49 | 0 |
| 2 | Always use | 0.2667 | 100.0% | 73.3% | 20.0% | 105 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2667 | 100.0% | 73.3% | 20.0% | 105 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 21 |

The accepted interpretation is narrow:

> On this controlled real Runtime admission dataset, Aionis recorded admission
> keeps all positive-use rows while preventing `blocked_or_suppressed` and
> `rehydrate_requested` rows from becoming direct-use memory. The offline proxy
> baseline shows why admission routing matters, but it is not a substitute for a
> counterfactual Agent rerun.

## Caveats

1. `raw_retrieval_prompt_proxy` is a weak offline baseline. It treats every
   prompt-included candidate as direct-use memory because candidate ranks are
   not preserved in the dataset.
2. `negative_use` is weak supervision from host feedback attribution. It is not
   yet per-memory counterfactual causality.
3. This baseline should not mutate Runtime gates by itself. Future admission
   policy changes need holdout validation.
4. The dataset is generated from controlled product scenarios. It is valid for
   admission flywheel plumbing and calibration, not for broad market claims.

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
  --holdout-ratio 0.3
```

Split result:

| Split | Rows | Task-signature groups |
|---|---:|---:|
| Train | 70 | 5 |
| Holdout | 35 | 2 |

Holdout checks:

| Check | Result |
|---|---:|
| Disjoint groups | yes |
| Recorded Aionis policy is holdout leader | yes |
| Holdout enough rows for policy claim | no |
| Holdout enough task signatures for diversity claim | no |

Holdout metrics:

| Metric | Value |
|---|---:|
| `use_now_positive_rate` | 50.0% |
| `use_now_negative_rate` | 0.0% |
| `unused_exposed_rate` | 20.0% |
| `blocked_or_suppressed_count` | 14 |
| `rehydrate_requested_count` | 7 |

The holdout split is useful as a promotion discipline: future tuned rules or
learned classifiers must be evaluated on rows they were not tuned against. This
specific holdout is still small, so it is pipeline validation and policy
regression protection, not a broad policy-quality claim.

## Next Step

The next stage is holdout-aware candidate policy evaluation:

1. keep collecting rows until the holdout itself reaches the row/signature gates;
2. keep lifecycle, authority, source, suppression, and rehydrate gates as hard
   boundaries;
3. evaluate any tuned rule or learned classifier on holdout before it can affect
   Runtime behavior.
