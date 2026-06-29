# Aionis Admission Tool-E2E Gate Runbook

Status: operator runbook
Last updated: 2026-06-29

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
| Initial context ratio versus Full History | `<= 0.75` when Full History is present |
| Legacy prompt-token ratio versus Full History | fallback only for older reports without initial-context stats |
| Candidate policy mode | explicitly declared `active` |
| Profile-scoped rollout source | `profile_rule` when validating profile default activation |
| Profile id | every readable Aionis guide must match the selected rollout profile |

Reference-only attention is informational. It is not a blocker by itself
because the Agent may read old implementation files as reference evidence while
still writing the accepted active route.

## Evaluation Command

```bash
npm run -s admission:tool-e2e-gate -- \
  --summary /path/to/external-agent-e2e/reports/<run>/summary.json \
  --results /path/to/external-agent-e2e/reports/<run>/phase2-gradient-results.jsonl \
  --policy-mode active \
  --require-policy-source profile_rule \
  --require-policy-profile-id external-agent-e2e-worker-full-power \
  --max-initial-context-ratio-vs-full-history 0.75
```

When `--results` is present, the gate reads each result's
`bundle_path/../contexts/aionis/guide.json` and audits
`source_map.admission_candidate_policy`. A profile-scoped default validation
must prove that the report did not come from the global environment switch.

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
active gray review. The current instrumented 40-record cross-repository
active-mode tool-E2E rerun passed route, completion, and initial-context budget
gates and is ready for human default-active review.

Human review outcome:

- `docs/AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md`
- approved product path: profile-scoped default-active rollout;
- global Runtime default remains `off`.

Current passing report:

- `docs/research/2026-06-29-admission-active-crossrepo-tool-e2e-initial-context-rerun.md`
- local gate artifact:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-initialctx-arkglm52-2026-06-29T00-49-09/tool_e2e_gate.md`

Same-manifest Full History comparison:

- paired report:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-initialctx-arkglm52-2026-06-29T00-49-09/summary.json`
- paired gate artifact:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-active-vs-fullhistory40-initialctx-arkglm52-2026-06-29T00-49-09/tool_e2e_gate.md`

Both arms completed `40 / 40` records. Aionis used `203,242` initial-context
chars versus Full History `1,352,256` initial-context chars (`15.0%` of Full
History) while preserving 100% accepted-route and action-completion rates.

The gate prefers `initial_context_chars` when reports include it. Only when
that field is absent does the gate fall back to legacy total prompt tokens, and
fallback results should not be used for broad context-budget claims when
completion rates differ sharply.

The previous paired27 run after the execution-memory and file-choice-normalizer
fixes removed route write violations, but one buried route-adherence case still
produced a terminal inspect and missed the accepted route. The 2026-06-28
40-record report retested the current Runtime and closed that blocker for the
validated guide path.

General Aionis product context-stability runs are useful evidence, but they do
not pass this admission-candidate gate unless the run explicitly used candidate
`active` mode.

## Next Work

1. Keep the Runtime global default unchanged.
2. Treat the 2026-06-29 initial-context rerun as the current budget evidence
   for this gate. Do not use older fallback-only prompt-token reports for
   budget claims.
3. Keep active-mode projections visible in admission reports and Flight
   Recorder surfaces.
4. Use `AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON` for bounded
   profile rollout. The selected guide profile must expose
   `source_map.admission_candidate_policy.source = "profile_rule"` before it
   counts as profile-default evidence.
5. Re-run this gate with `--require-policy-source profile_rule` and the selected
   `--require-policy-profile-id` before making the candidate default for any
   product guide path.
6. Re-run this gate before changing the default after material changes to
   guide rendering, lifecycle inference, execution memory rendering, or
   candidate-policy evaluation.
