# Aionis Admission Tool-E2E Gate Runbook

Status: operator runbook
Last updated: 2026-06-28

This runbook defines the cross-repository, tool-executing Agent gate for the
closed-loop admission candidate policy:

`candidate_project_context_closed_loop_inspect`

This gate is intentionally separate from the admission production shadow gate.
The production shadow gate only proves the candidate can be projected safely in
`/v1/guide` without entering prompts or mutating Runtime state. This gate asks
whether the candidate can be considered for default-active review in a real
tool-executing Agent environment.

## Product Boundary

This runbook is read-only. It evaluates external Agent reports and writes a
gate report. It does not run the Agent, does not activate the policy, and does
not mutate Runtime memory.

It answers:

> Did the candidate preserve completion, route adherence, and context budget in
> a cross-repository tool-executing Agent report?

It does not answer:

> Should Aionis be marketed as solving every coding-Agent failure mode?

## Required Gate

Default thresholds:

| Gate | Required |
|---|---:|
| Aionis arm runs | `40` |
| Context hygiene levels | `4` |
| Route write violations | `0` |
| Route action violations | `0` |
| Direction-attention violations | `0` |
| Terminal inspect exits | `0` |
| Report-conflict exits | `0` |
| Accepted-route rate | `1.0` |
| Action-completion rate | `1.0` |
| Prompt ratio versus Full History | `<= 0.75` when Full History is present |
| Candidate policy mode | explicitly declared `active` |

Reference-only attention is informational. It is not a blocker by itself
because the Agent may read old implementation files as reference evidence while
still writing the accepted active route.

## Evaluation Command

```bash
npm run -s admission:tool-e2e-gate -- \
  --summary /path/to/external-agent-e2e/reports/<run>/summary.json \
  --results /path/to/external-agent-e2e/reports/<run>/phase2-gradient-results.jsonl \
  --policy-mode active
```

The command writes next to `summary.json` unless `--out-dir` is set:

- `tool_e2e_gate.json`
- `tool_e2e_gate.md`

## Interpretation

| Result | Meaning |
|---|---|
| `passes_cross_repository_tool_e2e_gate_ready_for_default_active_review` | The report is strong enough for a human default-active review. It does not flip Runtime defaults automatically. |
| `blocked_for_default_active_review` | Keep the candidate out of default active. Inspect `blocking_reasons`. |

## Known Current Status

The latest closed-loop admission shadow gate passed and supports isolated
active gray review. The current 40-record cross-repository active-mode
tool-E2E report also passed this gate and is ready for human default-active
review.

Current passing report:

- `docs/research/2026-06-28-admission-active-crossrepo-tool-e2e-40gate.md`
- local gate artifact:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active40-current-2026-06-28/tool_e2e_gate.md`

The previous paired27 run after the execution-memory and file-choice-normalizer
fixes removed route write violations, but one buried route-adherence case still
produced a terminal inspect and missed the accepted route. The 2026-06-28
40-record report retested the current Runtime and closed that blocker for the
validated guide path.

General Aionis product context-stability runs are useful evidence, but they do
not pass this admission-candidate gate unless the run explicitly used candidate
`active` mode.

## Next Work

1. Keep the Runtime default unchanged unless human default-active review
   explicitly approves a named guide profile.
2. If the product claim includes context-budget superiority, run the same
   manifest with a Full History arm and require the prompt ratio gate.
3. Keep active-mode projections visible in admission reports and Flight
   Recorder surfaces.
4. Re-run this gate before changing the default after material changes to
   guide rendering, lifecycle inference, execution memory rendering, or
   candidate-policy evaluation.
