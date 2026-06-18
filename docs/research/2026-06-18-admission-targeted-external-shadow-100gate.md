# Aionis Admission Targeted External Shadow 100-Row Gate

Date: 2026-06-18

This run validates the selected admission candidate policy on the
`targeted-external-current` profile. The profile exercises external memory
candidates through `governMemory(mode=firewall)`, not the `/v1/guide` online
projection surface.

The result is therefore evidence for external candidate / Memory Firewall
admission behavior. It is not evidence that the `/v1/guide` online shadow
projection fired, because this profile does not use that product path.

## Run

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=shadow \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-shadow-targeted-20260618-195036 \
  --iterations 4 \
  --chunk-prefix shadow-targeted \
  --profile targeted-external-current
```

Raw chunks and rows were kept outside the repository under `/tmp`. This document
records the aggregate report only.

## Dataset Gate

| Gate | Value | Pass |
|---|---:|---:|
| Iterations completed | 4 / 4 | yes |
| Final rows | 144 | yes |
| Minimum rows for policy claim | 100 | yes |
| Task signatures | 12 | yes |
| Minimum task signatures | 6 | yes |
| Failure count | 0 | yes |

## Product Surface Boundary

| Metric | Value |
|---|---:|
| Profile | targeted-external-current |
| Product path | governMemory(mode=firewall) |
| `/v1/guide` calls with online projection | 0 |
| Online projection present | 0 |
| Agent prompt included count | 0 |
| Runtime mutation count | 0 |
| Hard-boundary upgrade count | 0 |

This confirms the profile is not a `/v1/guide` online projection profile. The
relevant evidence is the offline shadow audit over exported external admission
rows.

## Offline Shadow Audit

| Metric | Recorded Runtime | Candidate shadow |
|---|---:|---:|
| Direct-use count | 48 | 0 |
| Inspect-before-use count | 0 | 48 |
| Do-not-use count | 48 | 48 |
| Rehydrate count | 48 | 48 |
| Positive direct count | 0 | 0 |
| Negative direct count | 0 | 0 |
| Unused direct count | 48 | 0 |
| Hard-boundary direct count | 0 | 0 |
| Missed positive count | 0 | 0 |

Delta:

- changed admission actions: `48`
- would downgrade `use_now`: `48`
- direct-use delta: `-48`
- negative direct delta: `0`
- unused direct delta: `-48`
- missed positive delta: `0`
- hard-boundary direct delta: `0`

## Interpretation

The candidate policy is conservative on external-current candidates in this
profile: it would move all direct-use external current memories to
inspect-before-use while preserving blocked and rehydrate hard boundaries.

That is useful evidence for Memory Firewall / external backend governance, but
it is also a warning for active rollout: this profile does not prove positive
capture for direct-use external current memories. Before enabling active mode
for external backend candidates, run a real-Agent or task-level replay that can
measure whether inspect-first external current memories still preserve task
completion.

