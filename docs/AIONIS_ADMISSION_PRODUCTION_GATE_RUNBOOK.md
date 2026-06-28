# Aionis Admission Production Gate Runbook

Status: operator runbook
Last updated: 2026-06-28

This runbook defines the next gate for the closed-loop admission candidate
policy:

`candidate_project_context_closed_loop_inspect`

The gate is intentionally read-only. It expands default `/v1/guide` shadow
coverage and evaluates whether the candidate is ready for isolated active gray
review. It does not make the candidate default active.

## Product Boundary

The candidate may pass this runbook and still remain blocked for default
active. Default active requires the separate cross-repository, tool-executing
Agent E2E gate.

This runbook only answers:

> Did the candidate remain safe and useful as a default-guide shadow projection
> over a larger, more diverse admission dataset?

It does not answer:

> Did the candidate improve full coding-Agent task completion across
> repositories?

## Required Shadow Gate

Minimum production-gate thresholds:

| Gate | Required |
|---|---:|
| Admission rows | `1000` |
| Task signatures | `30` |
| Scopes | `5` |
| Shadow projection present count | `1000` |
| Agent prompt inclusions in shadow | `0` |
| Runtime mutations in shadow | `0` |
| Hard-boundary upgrades | `0` |
| Candidate policy | `candidate_project_context_closed_loop_inspect` |
| Candidate manual-review gate | pass |

The selected candidate must also preserve:

- no hard-boundary regression;
- no negative-use regression;
- no positive-capture regression;
- improved holdout calibration;
- changed actions on holdout.

## Collection

Use a throwaway dataset directory unless the run is intentionally being added
to the long-lived private admission dataset.

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=shadow

npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-shadow-production-gate \
  --iterations 34 \
  --chunk-prefix shadow-production \
  --profile closed-loop-prior-fresh-2
```

Why `34` iterations: current guide-profile chunks have historically produced
about 30 admission rows each. The gate is row-count based, so use the final
`production_gate.json` result rather than the iteration count as the source of
truth.

## Candidate Policy Report

After collection, run the candidate-policy evaluator on the collected rows:

```bash
npm run -s admission:candidate-policy -- \
  --input /tmp/aionis-admission-shadow-production-gate/rows.jsonl \
  --out-dir /tmp/aionis-admission-shadow-production-gate/reports/latest \
  --split-by task_signature \
  --holdout-ratio 0.5
```

## Production Gate Evaluation

Run the production gate:

```bash
npm run -s admission:production-gate -- \
  --dataset-dir /tmp/aionis-admission-shadow-production-gate
```

The command writes:

- `reports/latest/production_gate.json`
- `reports/latest/production_gate.md`

## Interpretation

| Result | Meaning |
|---|---|
| `passes_shadow_production_gate_ready_for_isolated_active_gray_review` | The candidate can move to the next isolated active gray review for the same guide profile. |
| `blocked_for_isolated_active_gray_review` | Do not run active gray for this profile. Inspect `blocking_reasons`. |
| `eligible_for_default_active=false` | Expected. Default active is controlled by the separate tool-executing E2E gate. |

Passing this gate should update
`docs/AIONIS_ADMISSION_POLICY_PROMOTION_STATUS.md`, but it must not change
Runtime defaults by itself.

## Next Gate After Shadow

If the shadow production gate passes, run isolated active gray on the same
profile:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active

npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-active-gray-production-gate \
  --iterations 34 \
  --chunk-prefix active-production \
  --profile closed-loop-prior-fresh-2
```

Then run:

```bash
npm run -s admission:real-agent-rerun -- \
  --input /tmp/aionis-admission-active-gray-production-gate/rows.jsonl \
  --out-dir /tmp/aionis-admission-active-gray-production-gate/reports/real-agent \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all \
  --split-by task_signature
```

Do not proceed to default active until the separate cross-repository
tool-executing Agent E2E gate passes.
