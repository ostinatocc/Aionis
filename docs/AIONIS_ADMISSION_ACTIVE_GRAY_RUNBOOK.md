# Aionis Admission Active Gray Runbook

Status: operator runbook
Last updated: 2026-06-18

Active gray mode is a local opt-in gate for an admission candidate policy. It is
used after shadow evidence passes the 100-row gate and before any default
Runtime promotion is considered.

## Scope

Active gray mode currently means:

- candidate policy is evaluated inside `/v1/guide`;
- selected `use_now` memories can be downgraded to `inspect_before_use`;
- prompt-facing guide output can change;
- stored memory rows are not mutated;
- lifecycle state, authority state, and feedback counters are not mutated;
- hard-boundary actions are never upgraded into `use_now`.

Active gray mode is not:

- default Runtime behavior;
- a learned-policy deployment;
- an external-backend active rollout;
- proof of full coding-Agent task success.

## Environment

Use this environment variable only for an isolated local run:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active
```

The default is `off`. Use `shadow` before `active`.

## Recommended Active Gray Collection

Use a temporary dataset directory unless you intentionally want to update the
durable admission dataset.

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active \
npm run -s admission:batch-collect -- \
  --dataset-dir /tmp/aionis-admission-active-gray-$(date +%Y%m%d-%H%M%S) \
  --iterations 4 \
  --chunk-prefix active-gray \
  --profile closed-loop-prior-fresh-2
```

Do not write to `admission-dataset/` during gray testing unless the run is meant
to become part of the long-lived calibration corpus.

## Expected Active Checks

The run should pass these checks before it is treated as promotion evidence:

- at least `100` rows;
- at least `6` task signatures;
- active projection present on guide calls;
- `agent_prompt_included_count > 0` is expected in active mode;
- `runtime_mutation_count = 0`;
- `hard_boundary_upgrade_count = 0`;
- missed positive delta stays `0`;
- accepted action rate is not worse in real-Agent rerun;
- negative direct risk is not worse, and ideally lower.

If any hard-boundary upgrade appears, stop and revert to `off`.

## Real-Agent Rerun

After collection, run a real LLM admission rerun against the active gray rows:

```bash
npm run -s admission:real-agent-rerun -- \
  --input /tmp/aionis-admission-active-gray-YYYYMMDD-HHMMSS/rows.jsonl \
  --out-dir /tmp/aionis-admission-active-gray-YYYYMMDD-HHMMSS/reports/real-agent-active-gray \
  --candidate-policy candidate_project_context_closed_loop_inspect \
  --evaluation-split all \
  --split-by task_signature
```

Current model note:

- `deepseek-chat` succeeded for the strict JSON rerun surface.
- `deepseek-v4-flash` returned only `reasoning_content` and hit the completion
  token limit in the attempted run. Do not use it for strict JSON real-Agent
  rerun until protocol handling is improved.

## Promotion Interpretation

Treat the result as follows:

| Result | Meaning |
|---|---|
| Shadow passes, active gray not run | Candidate can be tested locally in active gray mode. |
| Active gray passes, real-Agent rerun passes | Candidate can continue isolated active gray testing. |
| External targeted shadow passes | External path remains shadow-only until task-level completion evidence exists. |
| Full tool-executing Agent E2E passes | Candidate can be considered for a separately reviewed broader rollout. |

Do not use active gray evidence from one profile to promote another profile.

## Rollback

Rollback is immediate:

```bash
unset AIONIS_ADMISSION_CANDIDATE_POLICY_MODE
# or
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
```

Because active gray mode does not mutate stored memory state, rollback only
changes future guide outputs.

## Required Records

Every active gray run should leave a short report under `docs/research/` with:

- dataset path, kept outside the repository when possible;
- candidate policy;
- profile name;
- row and task-signature counts;
- prompt inclusion count;
- mutation count;
- hard-boundary upgrade count;
- positive-capture and negative-direct deltas;
- real-Agent rerun result or explicit reason why it was not run.

