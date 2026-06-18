# Aionis Admission Second Guide Shadow 100-Row Gate

Date: 2026-06-18

This run validates the selected admission candidate policy on a second
`/v1/guide` profile. The previously promoted shadow gate used
`closed-loop-prior-fresh-2`; this run uses `closed-loop-prior-fresh`.

The purpose is to check whether the candidate remains bounded and useful on a
neighboring guide profile before any broader active rollout is considered. This
is still shadow-only evidence. It does not enable active Runtime admission
changes.

## Run

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=shadow \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-shadow-fresh2-20260618-203907 \
  --iterations 6 \
  --chunk-prefix shadow-fresh2 \
  --profile closed-loop-prior-fresh
```

Raw chunks and rows were kept outside the repository under `/tmp`. This
document records the aggregate report only.

## Dataset Gate

| Gate | Value | Pass |
|---|---:|---:|
| Iterations completed | 6 / 6 | yes |
| Final rows | 120 | yes |
| Minimum rows for policy claim | 100 | yes |
| Task signatures | 8 | yes |
| Minimum task signatures | 6 | yes |
| Failure count | 0 | yes |

## Online Guide Projection

| Metric | Value |
|---|---:|
| Projection mode | shadow |
| Guide calls | 120 |
| Projection present | 120 |
| Shadow source-map count | 120 |
| Active source-map count | 0 |
| Candidate downgrades proposed | 24 |
| Agent prompt included count | 0 |
| Runtime mutation count | 0 |
| Hard-boundary upgrade count | 0 |

## Offline Shadow Audit

The collector also evaluated the same candidate policy as an offline shadow
audit over the exported admission rows.

| Metric | Recorded Runtime | Candidate shadow |
|---|---:|---:|
| Direct-use count | 96 | 72 |
| Inspect-before-use count | 24 | 48 |
| Positive direct count | 48 | 48 |
| Negative direct count | 48 | 24 |
| Direct-use negative rate | 50.0% | 33.3% |
| Direct-use positive precision proxy | 50.0% | 66.7% |

Delta:

- changed admission actions: `24`
- would downgrade `use_now`: `24`
- direct-use delta: `-24`
- negative direct delta: `-24`
- unused direct delta: `0`
- missed positive delta: `0`
- hard-boundary direct delta: `0`

## Interpretation

The candidate passed the second guide-profile shadow gate:

- it reached the minimum row and diversity thresholds;
- the online shadow projection was present on every guide call;
- it stayed out of the Agent prompt in shadow mode;
- it did not mutate Runtime state;
- it did not emit active projection surfaces;
- it did not upgrade hard-boundary actions;
- it reduced negative direct-use exposure without reducing positive direct
  capture.

This strengthens the evidence that the candidate's downgrade-only behavior is
not limited to `closed-loop-prior-fresh-2`. It still does not authorize default
active mode. The next gate for this second guide profile is an isolated active
gray run followed by a real-Agent admission rerun.

