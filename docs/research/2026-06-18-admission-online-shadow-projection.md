# Aionis Admission Online Shadow Projection Smoke

Date: 2026-06-18

This smoke run validates the product `/v1/guide` online shadow projection path
for the closed-loop admission candidate policy. It is not an active Runtime
policy rollout.

## Run

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=shadow \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-shadow-20260618-191343 \
  --iterations 1 \
  --chunk-prefix shadow-current \
  --profile closed-loop-prior-fresh-2
```

## Result

| Metric | Value |
|---|---:|
| Rows collected | 30 |
| Task signatures | 12 |
| Guide calls with online projection report | 30 |
| Online projection present | 30 |
| Online shadow source-map count | 30 |
| Online active source-map count | 0 |
| Candidate downgrades proposed | 6 |
| Agent prompt included count | 0 |
| Runtime mutation count | 0 |
| Hard-boundary upgrade count | 0 |

## Offline Shadow Audit

| Metric | Recorded Runtime | Candidate shadow |
|---|---:|---:|
| Direct-use count | 24 | 18 |
| Inspect-before-use count | 6 | 12 |
| Positive direct count | 12 | 12 |
| Negative direct count | 12 | 6 |
| Direct-use negative rate | 50.0% | 33.3% |
| Positive precision proxy | 50.0% | 66.7% |

Delta:

- changed admission actions: `6`
- would downgrade `use_now`: `6`
- negative direct delta: `-6`
- missed positive delta: `0`
- hard-boundary direct delta: `0`

## Interpretation

The online shadow path is wired correctly:

- it produces an audit projection on every guide call in this profile;
- it records the shadow projection source in the guide source map;
- it does not mutate stored Runtime state;
- it does not alter the agent prompt;
- it does not upgrade any hard-boundary action.

The candidate policy remains a shadow/gray candidate. This run is a product
surface smoke, not an external policy-quality claim. The dataset has only 30
rows, below the 100-row policy-claim gate.

