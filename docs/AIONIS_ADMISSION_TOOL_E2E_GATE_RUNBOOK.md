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
active gray review. The global active-mode, instrumented 40-record
cross-repository tool-E2E rerun also passed route, completion, and
initial-context budget gates on the validated guide path.

Human review outcome:

- `docs/AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md`
- approved product path: profile-scoped default-active rollout;
- global Runtime default remains `off`.

Current global-active passing report:

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

The profile-scoped validation is stricter than the global-active run because it
requires every guide to expose
`source_map.admission_candidate_policy.source = "profile_rule"` and the
selected profile id. The first profile-scoped 40-record report proved profile
source attribution on all guides, but it was blocked for default-active review
under the single-step Agent:

- local gate artifact:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-profile-rule-vs-fullhistory40-arkglm52-2026-06-29T11-06-14/tool_e2e_gate.md`
- profile source audit: `40 / 40` guides from `profile_rule`;
- profile id audit: `40 / 40` guides matched
  `external-agent-e2e-worker-full-power`;
- accepted-route rate: `39 / 40`;
- action-completion rate: `33 / 40`;
- initial context ratio versus Full History: `12.2%`;
- blocking reasons: `accepted_route_rate_below_threshold`,
  `action_completion_rate_below_threshold`.

Focused inspection showed the largest completion cluster was not a Runtime
policy-source failure. Four Playwright cases selected `rehydrate_first` for the
accepted route, but the single-step file-choice Agent treated rehydrate as a
terminal decision. Re-running the same four records with the multi-step Agent
and `AIONIS_E2E_REHYDRATE_CONTINUES=1` produced:

- local report:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/profile-rule-rehydrate-loop-playwright4-2026-06-29T13-46-05/summary.json`
- accepted-route rate: `4 / 4`;
- action-completion rate: `4 / 4`;
- terminal inspect exits: `0 / 4`;
- report-conflict exits: `0 / 4`;
- route write violations: `0 / 4`.

The full profile-scoped multi-step Aionis rerun then closed the route/action
gate:

- local gate artifact:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/profile-rule-multistep-aionis40-arkglm52-2026-06-29T14-09-42/tool_e2e_gate.md`
- profile source audit: `40 / 40` guides from `profile_rule`;
- profile id audit: `40 / 40` guides matched
  `external-agent-e2e-worker-full-power`;
- accepted-route rate: `40 / 40`;
- action-completion rate: `40 / 40`;
- route write violations: `0 / 40`;
- route action violations: `0 / 40`;
- direction-attention violations: `0 / 40`;
- terminal inspect exits: `0 / 40`;
- report-conflict exits: `0 / 40`;
- gate status:
  `passes_cross_repository_tool_e2e_gate_ready_for_default_active_review`.

This full profile-scoped rerun used only the Aionis arm, so its gate report
sets `context_budget_metric = "not_assessed"`. The same manifest already has a
Full History initial-context comparison from the earlier profile-scoped
two-arm run: Aionis `165,421` initial-context chars versus Full History
`1,352,256` initial-context chars (`12.2%`). Treat that as informational
budget context unless a future paired multi-step Full History rerun is needed
for a stricter budget-only claim.

The gate prefers `initial_context_chars` when reports include it. Only when
that field is absent does the gate fall back to legacy total prompt tokens, and
fallback results should not be used for broad context-budget claims when
completion rates differ sharply.

General Aionis product context-stability runs are useful evidence, but they do
not pass this admission-candidate gate unless the run explicitly used candidate
`active` mode and, for profile-default validation, `profile_rule` source
attribution.

## Next Work

1. Keep the Runtime global default unchanged.
2. Treat the 2026-06-29 global-active initial-context rerun as current budget
   evidence for the validated guide path. Do not use older fallback-only
   prompt-token reports for budget claims.
3. Keep active-mode projections visible in admission reports and Flight
   Recorder surfaces.
4. Use `AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON` for bounded
   profile rollout. The selected guide profile must expose
   `source_map.admission_candidate_policy.source = "profile_rule"` before it
   counts as profile-default evidence.
5. Use the full profile-scoped multi-step Aionis rerun as the current
   route/action/profile-source evidence for the selected product guide path.
6. If a release claim needs a same-run budget ratio, rerun with a Full History
   arm. Otherwise keep the existing same-manifest Full History initial-context
   comparison as informational budget evidence.
7. Re-run this gate before changing the default after material changes to
   guide rendering, lifecycle inference, execution memory rendering, or
   candidate-policy evaluation.

## Profile-Scoped Multi-Step Command

Use the same 40-record manifest and report gate, but run the Agent path that
can continue after `rehydrate_first` instead of treating rehydrate as a final
answer:

```bash
AIONIS_E2E_AGENT_MAX_STEPS=6 \
AIONIS_E2E_REHYDRATE_CONTINUES=1 \
AIONIS_E2E_EXECUTABLE_PATCH_GATE=1 \
AIONIS_E2E_REHYDRATE_PAYLOAD_MODE=patch_plan_first \
AIONIS_E2E_REHYDRATE_REPEAT_MODE=compact_after_first \
npm run -s external-agent-e2e:phase2-gradient -- \
  --manifest /path/to/phase2-gradient-traps.jsonl \
  --work-root /path/to/work-root \
  --report-dir /path/to/report-dir \
  --arms aionis,full_history \
  --base-url http://127.0.0.1:<runtime-port> \
  --episode2-source base \
  --command 'node /path/to/deepseek-multistep-agent.mjs' \
  --force \
  --continue-on-error
```

Then run the gate command from this document with
`--require-policy-source profile_rule` and
`--require-policy-profile-id external-agent-e2e-worker-full-power`.
