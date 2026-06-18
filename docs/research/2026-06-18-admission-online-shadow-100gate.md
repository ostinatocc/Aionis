# Aionis Admission Online Shadow 100-Row Gate

Date: 2026-06-18

This run extends the online `/v1/guide` admission candidate shadow projection
from a smoke check to the minimum 100-row policy-claim gate. It remains a shadow
evaluation. It does not enable active Runtime admission changes.

## Run

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=shadow \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-shadow-100gate-20260618-191824 \
  --iterations 4 \
  --chunk-prefix shadow-100gate \
  --profile closed-loop-prior-fresh-2
```

Raw chunks and rows were kept outside the repository under `/tmp`. This document
records the aggregate report only.

## Dataset Gate

| Gate | Value | Pass |
|---|---:|---:|
| Iterations completed | 4 / 4 | yes |
| Final rows | 120 | yes |
| Minimum rows for policy claim | 100 | yes |
| Task signatures | 12 | yes |
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

The online shadow projection reached the minimum row and diversity gates for
this profile while preserving the safety boundary:

- it remained shadow-only in `/v1/guide`;
- it did not enter the Agent prompt;
- it did not mutate Runtime state;
- it did not emit active projection surfaces;
- it did not upgrade hard-boundary actions;
- it proposed downgrades only from direct-use toward inspect-first handling.

The result supports a local active gray run for this profile. It does not prove
general policy quality across all memory lanes or external backends. Before
broadening beyond this profile, run the same gates on at least one additional
profile such as `targeted-external-current`.

