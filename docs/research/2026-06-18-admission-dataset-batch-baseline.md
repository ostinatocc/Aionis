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
```

Result:

| Metric | Value |
|---|---:|
| Rows | 375 |
| Runs | 179 |
| Tasks | 179 |
| Task signatures | 13 |
| Source backends | `aionis`, `mem0`, `zep`, `archive` |

One expanded-batch iteration hit an upstream embedding 429. The successful retry
appended another 27-row chunk. The final cumulative dataset and latest reports
are based on 375 rows.

Sample-quality gates:

| Gate | Result |
|---|---:|
| Minimum rows for policy claim | 100 |
| Current rows | 375 |
| Enough rows | yes |
| Minimum task signatures | 6 |
| Current task signatures | 13 |
| Enough task signatures | yes |

## Dataset Composition

| Label | Count |
|---|---:|
| `positive_use` | 81 |
| `negative_use` | 81 |
| `blocked_or_suppressed` | 179 |
| `rehydrate_requested` | 17 |
| `unused_exposed` | 17 |

Admission actions:

| Action | Count |
|---|---:|
| `use_now` | 179 |
| `do_not_use` | 179 |
| `rehydrate` | 17 |

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
| 1 | Aionis recorded policy | 0.5475 | 100.0% | 45.3% | 45.3% | 179 | 0 |
| 2 | Always use | 0.2613 | 100.0% | 73.9% | 21.6% | 375 | 0 |
| 3 | Raw retrieval prompt proxy | 0.2613 | 100.0% | 73.9% | 21.6% | 375 | 0 |
| 4 | Always block | 0.0000 | 0.0% | 0.0% | 0.0% | 0 | 81 |

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
  --holdout-ratio 0.5
```

Split result:

| Split | Rows | Task-signature groups |
|---|---:|---:|
| Train | 148 | 6 |
| Holdout | 227 | 7 |

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
| `use_now_positive_rate` | 41.9% |
| `use_now_negative_rate` | 41.9% |
| `unused_exposed_rate` | 7.5% |
| `blocked_or_suppressed_count` | 105 |
| `rehydrate_requested_count` | 17 |

The holdout split is useful as a promotion discipline: future tuned rules or
learned classifiers must be evaluated on rows they were not tuned against. This
specific holdout now clears the row/signature gates, so it is usable for
offline policy regression and candidate-policy comparison. It is still not a
counterfactual Agent rerun and should not be used by itself for broad market
claims.

## Next Step

The next stage is holdout-aware candidate policy evaluation:

1. evaluate a candidate tuned rule or lightweight classifier against the
   disjoint holdout split;
2. keep lifecycle, authority, source, suppression, and rehydrate gates as hard
   boundaries;
3. require holdout improvement before any candidate policy can affect
   Runtime behavior.
