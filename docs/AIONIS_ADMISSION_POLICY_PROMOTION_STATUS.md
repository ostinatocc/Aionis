# Aionis Admission Policy Promotion Status

Status: product evidence register
Last updated: 2026-06-29

This document records the current promotion state for the selected admission
candidate policy. It is intentionally conservative: evidence can make a policy
eligible for a narrower gate, but it does not silently promote the policy into
the default Runtime path.

## Candidate

| Field | Value |
|---|---|
| Candidate policy | `candidate_project_context_closed_loop_inspect` |
| Current status | `eligible_for_profile_scoped_default_active_review` |
| Default Runtime status | `not_default_active` |
| External backend status | `shadow_only` |
| Full tool-executing Agent E2E status | `profile_rule_multistep40_route_action_gate_passed` |
| Next gate | `operator_profile_default_activation_review` |

The selected candidate is a closed-loop admission policy. Its current evidence
supports default-active review design for route preservation and action
completion on the validated `/v1/guide` path. Shadow, isolated active gray,
real-Agent admission rerun, and the global active cross-repository
route/completion tool E2E gate have passed. The latest global active
cross-repository tool E2E covered 10 base trap families across four context
hygiene levels and preserved accepted-route recognition and action completion
on all 40 records. The instrumented same-manifest Full History comparison
recorded initial context size before the first tool step: Aionis used
`203,242` initial-context chars versus Full History `1,352,256`
initial-context chars (`15.0%` of Full History) while both arms completed
`40 / 40` records.

The stricter profile-rule validation has now passed for route/action behavior.
The first profile-rule 40-record report proved that every Aionis guide came
from the selected `profile_rule`, but the single-step Agent used in that run
treated `rehydrate_first` as a terminal answer. A focused four-record rerun
over the largest rehydrate failure cluster, using the multi-step Agent with
rehydrate continuation, recovered `4 / 4` accepted-route and `4 / 4` action
completion. The full Aionis-only profile-rule multi-step rerun then completed
`40 / 40` records with `40 / 40` accepted-route, `40 / 40`
action-completion, zero route write/action violations, zero terminal inspect
exits, zero report-conflict exits, and `40 / 40` matching profile-rule guide
source records.

That final profile-rule gate did not include a Full History arm, so
`context_budget_metric = "not_assessed"` in its gate report. The same manifest
already has an informational Full History initial-context comparison from the
earlier profile-rule two-arm run: Aionis `165,421` chars versus Full History
`1,352,256` chars (`12.2%`).

This does not authorize:

- default active mode;
- external-backend active rollout;
- broad product claims across all memory lanes;
- broad claims about full coding-Agent task completion.

The Runtime default remains explicit opt-in. The human default-active review is
recorded in
[AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md](AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md):
the candidate is approved for a profile-scoped default-active product path, not
for a global Runtime default.

## Evidence Chain

| Stage | Evidence | Result |
|---|---|---|
| Offline dataset and holdout | `docs/research/2026-06-18-admission-dataset-batch-baseline.md` | Candidate beat recorded policy on holdout calibration and became eligible for manual review. |
| Counterfactual rerun | Admission rerun reports under the local/private `admission-dataset/reports/latest/` workspace | Candidate preserved hard-boundary and positive-capture gates under deterministic replay. |
| Real LLM admission rerun | `docs/research/2026-06-18-admission-current-runid-real-agent.md` | Candidate preserved accepted action rate and hard-boundary gates on the accumulated dataset. |
| Online guide shadow | `docs/research/2026-06-18-admission-online-shadow-100gate.md` | Shadow projection reached 120 rows and 12 task signatures without prompt inclusion or Runtime mutation. |
| Second guide shadow | `docs/research/2026-06-18-admission-second-guide-shadow-100gate.md` | A neighboring `/v1/guide` profile reached 120 rows and 8 task signatures with the same bounded shadow behavior. |
| External targeted shadow | `docs/research/2026-06-18-admission-targeted-external-shadow-100gate.md` | External candidates stayed shadow-only; direct-use dropped, but this is not guide-path active evidence. |
| Default-guide shadow production gate | `/Volumes/ziel/aionis-admission-data/admission-dataset/reports/latest/production_gate.md` | Shadow expansion reached 2036 rows, 55 task signatures, 1020 guide shadow projections, and passed isolated active-gray review gates without prompt inclusion or Runtime mutation. |
| Isolated active gray | `docs/research/2026-06-18-admission-active-gray-closed-loop-100gate.md` | Active projection changed prompt-facing guide output in the bounded downgrade path only. |
| Active gray real-Agent rerun | `docs/research/2026-06-18-admission-active-gray-real-agent-rerun.md` | Real LLM rerun preserved accepted action rate and reduced negative direct risk for this profile. |
| Second guide active gray | `docs/research/2026-06-18-admission-second-guide-active-gray.md` | The neighboring `/v1/guide` profile passed isolated active gray with bounded downgrade-only behavior. |
| Second guide active gray real-Agent rerun | `docs/research/2026-06-18-admission-second-guide-active-gray-real-agent-rerun.md` | Real LLM rerun preserved accepted action rate and reduced negative direct risk for the second guide profile. |
| Tool-executing Agent E2E pilot | `docs/research/2026-06-18-admission-active-tool-executing-agent-e2e.md` | Active mode preserved 0% wrong writes, 0% wrong attention, 100% accepted direction, and 100% action completion on one base trap across four hygiene levels. |
| Second tool-executing Agent E2E pilot | `docs/research/2026-06-18-admission-active-tool-executing-agent-e2e-second-base.md` | Active mode preserved the same hard gates on a second base trap family, including a missing active target continuation case. |
| Cross-repository tool-executing Agent E2E paired27 | `docs/research/2026-06-18-admission-active-crossrepo-tool-e2e-paired27.md` | Active mode regressed on the paired cross-repository set: wrong writes increased from 2 / 27 to 7 / 27, accepted direction dropped from 25 / 27 to 17 / 27, and total tokens increased slightly. |
| Cross-repository tool-executing Agent E2E paired27 rerun | `docs/research/2026-06-18-admission-active-crossrepo-tool-e2e-paired27-rerun.md` | The execution-memory direct-use patch recovered most of the regression: wrong writes dropped from 7 / 27 to 1 / 27, accepted direction rose from 17 / 27 to 26 / 27, and action completion reached 27 / 27. |
| Cross-repository paired27 rerun after file-choice normalizer fix and attention split | `docs/research/2026-06-18-admission-active-crossrepo-tool-e2e-paired27-rerun.md` | Wrong writes dropped to 0 / 27 and the prior residual separated-context case was confirmed as a harness normalization artifact. Attention split shows 1 / 27 direction-attention hit, 12 / 27 reference-only attention hits, and 0 / 27 other attention hits. One buried route-adherence failure remains. |
| Cross-repository tool-executing Agent E2E 40-gate | `docs/research/2026-06-28-admission-active-crossrepo-tool-e2e-40gate.md` | Active mode completed 40 / 40 records across 10 base trap families and four hygiene levels, with 100% accepted-route rate, 100% action-completion rate, no terminal inspect, no report conflict, and no route violations. A same-manifest Full History run completed only 9 / 40 records; the paired gate is blocked only under the legacy total-prompt-token fallback. |
| Cross-repository tool-executing Agent E2E initial-context rerun | `docs/research/2026-06-29-admission-active-crossrepo-tool-e2e-initial-context-rerun.md` | Global active mode and Full History both completed 40 / 40 records. Aionis preserved 100% accepted-route and action-completion rates with 15.0% of the Full History initial context size. The tool-E2E gate passed with `context_budget_metric=initial_context_chars`. |
| Profile-rule cross-repository tool-executing Agent E2E 40-gate | Local report `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-profile-rule-vs-fullhistory40-arkglm52-2026-06-29T11-06-14/tool_e2e_gate.md` | Profile attribution passed on 40 / 40 guides, but the gate is blocked for default-active review: accepted-route rate 39 / 40 and action-completion rate 33 / 40. Initial context ratio versus Full History was 12.2%. |
| Profile-rule rehydrate continuation focused rerun | Local report `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/profile-rule-rehydrate-loop-playwright4-2026-06-29T13-46-05/summary.json` | The largest rehydrate-first failure cluster recovered with the multi-step Agent: accepted-route 4 / 4, action-completion 4 / 4, terminal inspect 0 / 4, report conflict 0 / 4, route write violations 0 / 4. |
| Profile-rule multi-step tool-executing Agent E2E 40-gate | Local report `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/profile-rule-multistep-aionis40-arkglm52-2026-06-29T14-09-42/tool_e2e_gate.md` | Aionis-only profile-rule multi-step run passed the route/action/profile-source gate: completed 40 / 40, accepted-route 40 / 40, action-completion 40 / 40, route write/action violations 0, terminal inspect 0, report conflict 0, matching profile-rule source 40 / 40. Budget was not assessed in this Aionis-only gate. |
| Human default-active review | `docs/AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md` | Candidate approved for profile-scoped default-active rollout. Global Runtime default remains `off`; external backend path remains `shadow_only`. |

Follow-up inspection found the paired27 regression root cause: the active
projection over-downgraded Aionis `execution_memory` accepted-continuation
entries because the candidate direct-use path only allowed `project_context`.
The code patch now preserves direct use for Aionis `execution_memory` unless
closed-loop counter-signal evidence exists. This is a correction to the active
projection, not a promotion. The paired27 rerun after the file-choice normalizer
fix showed the route-write regression was resolved, while one buried
route-adherence failure remained. The 2026-06-28 40-record cross-repository gate
retested the current Runtime and closed that blocker for the validated guide
path.

## Next Production Gate

The default-guide shadow expansion gate described in
[AIONIS_ADMISSION_PRODUCTION_GATE_RUNBOOK.md](AIONIS_ADMISSION_PRODUCTION_GATE_RUNBOOK.md)
has passed.
It requires at least `1000` admission rows, `30` task signatures, `5` scopes,
shadow projection coverage, zero prompt inclusion, zero Runtime mutation, zero
hard-boundary upgrades, and a passing candidate-policy holdout report.

Passing this gate can authorize another isolated active gray review for the
same guide profile. It does not authorize default active mode; that still
requires the cross-repository tool-executing Agent E2E gate.

The cross-repository tool-executing Agent gate described in
[AIONIS_ADMISSION_TOOL_E2E_GATE_RUNBOOK.md](AIONIS_ADMISSION_TOOL_E2E_GATE_RUNBOOK.md)
has passed for route adherence, action completion, and initial-context budget
in the global active 40-record rerun. The paired Full History arm also
completed all 40 records, so the budget comparison is no longer relying on the
legacy total-token fallback.

The profile-scoped multi-step tool-E2E route/action gate has passed. The
Runtime supports `AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON`, while
the global default remains `off`. The selected profile has now passed the
tool-executing Agent E2E gate with `--require-policy-source profile_rule`, the
selected `--require-policy-profile-id`, and an Agent command that continues
after `rehydrate_first`. This proves that the report came from a bounded
profile rule rather than the global environment switch and that executable
evidence rehydration is handled by the Agent loop.

The next decision is operator activation review for this specific profile.
That review may choose to activate only the selected profile path, keep the
global default `off`, keep the external backend path `shadow_only`, and require
another gate run before expanding to any additional profile.

## Gate Results

### Online `/v1/guide` Shadow

The 100-row shadow gate for `closed-loop-prior-fresh-2` produced:

- `120` admission rows;
- `12` task signatures;
- `120 / 120` guide calls with a shadow projection;
- `24` proposed downgrades from `use_now` to `inspect_before_use`;
- `0` Agent-prompt inclusions;
- `0` Runtime mutations;
- `0` hard-boundary upgrades;
- negative direct count reduced from `48` to `24`;
- missed positive delta stayed `0`.

This is sufficient to start isolated active gray testing for the same profile.
It is not evidence for default active mode.

### Second `/v1/guide` Shadow

The neighboring `closed-loop-prior-fresh` shadow gate produced:

- `120` admission rows;
- `8` task signatures;
- `120 / 120` guide calls with a shadow projection;
- `24` proposed downgrades from `use_now` to `inspect_before_use`;
- `0` Agent-prompt inclusions;
- `0` Runtime mutations;
- `0` hard-boundary upgrades;
- negative direct count reduced from `48` to `24`;
- missed positive delta stayed `0`.

This closed the second guide-profile shadow gate and authorized an isolated
active gray check for the same profile. The active gray result is recorded
below.

### Second `/v1/guide` Active Gray

The neighboring `closed-loop-prior-fresh` active gray gate produced:

- `120` admission rows;
- `8` task signatures;
- `120 / 120` guide calls with an active projection;
- `48` active source-map entries;
- `48` applied downgrades from `use_now` to `inspect_before_use`;
- `120` expected Agent-prompt inclusions;
- `0` Runtime mutations;
- `0` hard-boundary upgrades.

After active projection, the exported rows had:

- `72` direct-use rows;
- `48` inspect-before-use rows;
- `48` positive direct rows;
- `24` negative direct rows;
- `33.3%` direct-use negative rate.

The offline candidate had no additional changes to propose over the active
surface, which confirms that active projection reached the second guide output.

### External Targeted Shadow

The targeted external profile produced:

- `144` admission rows;
- external `governMemory` candidate coverage only;
- direct-use reduced from `48` to `0`;
- unused direct attention reduced from `48` to `0`;
- `0` hard-boundary upgrades;
- missed positive delta stayed `0`.

This remains `shadow_only`. It does not prove online `/v1/guide` active
behavior, and it may be over-conservative for external current memories until
task-level completion evidence exists.

### Default-Guide Shadow Production Gate

The default-guide shadow expansion gate produced:

- `2036` admission rows;
- `55` task signatures;
- `841` scopes;
- `1020` guide shadow projections;
- `0` Agent-prompt inclusions;
- `0` Runtime mutations;
- `0` hard-boundary upgrades;
- selected candidate policy: `candidate_project_context_closed_loop_inspect`;
- holdout calibration score improved from `0.6153` recorded to `0.8107`
  candidate;
- no hard-boundary, negative-use, or positive-capture regression.

This passes the production shadow gate for isolated active gray review. It does
not authorize default active mode; that still requires the cross-repository
tool-executing Agent E2E gate.

### Isolated Active Gray

The active gray run for `closed-loop-prior-fresh-2` produced:

- `120` admission rows;
- `12` task signatures;
- `120 / 120` guide calls with an active projection;
- `48` active source-map entries;
- `48` applied downgrades from `use_now` to `inspect_before_use`;
- `120` expected Agent-prompt inclusions;
- `0` Runtime mutations;
- `0` hard-boundary upgrades.

After active projection, the exported rows had:

- `72` direct-use rows;
- `48` inspect-before-use rows;
- `48` positive direct rows;
- `24` negative direct rows;
- `33.3%` direct-use negative rate.

The offline candidate had no additional changes to propose over the active
surface, which confirms that active projection reached the guide output.

### Active Gray Real-Agent Rerun

The real LLM rerun over the isolated active gray dataset produced:

| Metric | Recorded Runtime policy | Candidate policy |
|---|---:|---:|
| Accepted action rate | 50.0% | 50.0% |
| Hard-boundary direct-use rate | 0.0% | 0.0% |
| Negative direct-risk rate | 50.0% | 33.3% |
| Missed actionable rate | 0.0% | 0.0% |
| Boundary ignored | 0 | 0 |

This supports continued isolated active gray testing. It does not close the
full tool-executing Agent E2E gate.

### Second Guide Active Gray Real-Agent Rerun

The real LLM rerun over the second guide active gray dataset produced:

| Metric | Recorded Runtime policy | Candidate policy |
|---|---:|---:|
| Accepted action rate | 50.0% | 50.0% |
| Hard-boundary direct-use rate | 0.0% | 0.0% |
| Negative direct-risk rate | 50.0% | 37.5% |
| Missed actionable rate | 0.0% | 0.0% |
| Boundary ignored | 0 | 0 |

This closes the second guide-profile real-Agent admission rerun gate. It still
does not close the full tool-executing Agent E2E gate.

### Tool-Executing Agent E2E Pilots

The active-vs-off tool-executing pilots used the external Agent E2E Phase 2
gradient runner across two base trap families and four hygiene levels each.

| Base trap family | Policy off | Policy active | Result |
|---|---:|---:|---|
| `vitejs-vite-4551a4b-banner-legacy-script` | 4 / 4 completed | 4 / 4 completed | Active preserved 0% wrong writes, 0% wrong attention, 100% accepted direction, and 100% action completion. |
| `vitejs-vite-5edd1d5-bundled-dev-refactor` | 4 / 4 completed | 4 / 4 completed | Active preserved the same hard gates and created/restored the missing active target instead of falling back to the retired route. |

These close two narrow pilot gates for real tool execution. They do not
authorize default active rollout because they are still Aionis-only,
Vite-family, file-choice Agent pilots rather than a broad cross-repository or
five-arm comparison.

### Cross-Repository Tool-Executing Agent E2E

The first cross-repository active-vs-off tool-executing run attempted 10 base
trap families across 4 hygiene levels. The off-mode run stopped at one
Next.js buried record because of a harness/worktree checkout failure, so the
valid comparison uses the 27 trap IDs that completed in off mode and reruns the
same paired IDs in active mode.

| Metric | Policy off | Active before patch | Active after execution-memory patch | Active after normalizer fix |
|---|---:|---:|---:|---:|
| Paired records | 27 | 27 | 27 | 27 |
| Wrong-write records | 2 | 7 | 1 | 0 |
| Wrong-attention records | 2 | 7 | 1 | 13 |
| Direction-attention records | n/a | n/a | n/a | 1 |
| Reference-attention records | n/a | n/a | n/a | 12 |
| Other-attention records | n/a | n/a | n/a | 0 |
| Accepted-direction records | 25 | 17 | 26 | 26 |
| Action-completion records | 26 | 25 | 27 | 26 |
| Report-conflict records | 0 | 2 | 0 | 0 |
| Terminal-inspect records | 1 | 0 | 0 | 1 |
| Total tokens | 388,590 | 396,433 | 388,563 | 386,660 |

The original active run was a negative promotion gate. The execution-memory
patch fixed the prompt-facing route-contract regression. The file-choice
normalizer fix then cleared the apparent residual wrong-write by preserving safe
non-candidate create/restore paths. At that point, broad rollout remained
blocked because the paired27 rerun still had one buried route-adherence failure.
The attention-scope rescore separated this from reference-only evidence use:
direction attention was `1 / 27`, while reference-only attention was `12 / 27`.

### Historical Global-Active Cross-Repository Tool-Executing Agent E2E 40-Gate

The 40-record global active-mode run produced:

| Metric | Active mode |
|---|---:|
| Records | 40 |
| Base trap families | 10 |
| Context hygiene levels | 4 |
| Completed records | 40 / 40 |
| Accepted-route records | 40 / 40 |
| Action-completion records | 40 / 40 |
| Route write violations | 0 |
| Route action violations | 0 |
| Direction-attention violations | 0 |
| Terminal-inspect records | 0 |
| Report-conflict records | 0 |
| Prompt tokens | 602,291 |

The Aionis-only route/completion gate returned:

- `eligible_for_default_active_review=true`;
- `status=passes_cross_repository_tool_e2e_gate_ready_for_default_active_review`;
- no blocking reasons.

The run did not include a Full History arm, so prompt ratio versus Full History
was not assessed in this gate. This is acceptable for default-active review
eligibility, but it is not enough for a broad context-budget claim.

A follow-up same-manifest Full History run produced:

| Metric | Aionis active | Full History |
|---|---:|---:|
| Records | 40 | 40 |
| Accepted-route records | 40 / 40 | 9 / 40 |
| Action-completion records | 40 / 40 | 9 / 40 |
| Route write violations | 0 | 0 |
| Direction-attention violations | 0 | 0 |
| Prompt tokens | 602,291 | 375,207 |

The derived paired gate returned:

- `eligible_for_default_active_review=false`;
- `status=blocked_for_default_active_review`;
- blocking reason: `context_budget_not_better_than_full_history`.

This is a historical metric-definition blocker, not an execution-correctness
regression: Full History failed most records before producing parseable action
JSON, so raw total prompt tokens are not comparable. The gate now prefers
initial context size when reports include it; this report pair must be rerun
with instrumented initial context stats before it can support a context-budget
claim.

## Required Gates Before Default Active

Do not promote the candidate to default active mode until review records a
decision on these items:

1. A second `/v1/guide` online profile, or a mixed profile, passes the same
   shadow and active gray checks. As of 2026-06-18, the second guide-profile
   shadow, isolated active gray, and real-Agent admission rerun gates have
   passed.
2. A real tool-executing Agent E2E shows no completion regression and no
   hard-boundary regression across more than one base trap family. The global
   active 40-gate passed across 10 base trap families and four context hygiene
   levels. The stricter profile-rule 40-gate also passed after rerunning with
   the multi-step rehydrate-continuation Agent path.
3. External backend candidates have task-level completion evidence, not only
   admission-row shadow evidence.
4. Protocol compatibility is documented for the chosen real-Agent model. The
   profile-rule 40-gate used the multi-step tool Agent harness so
   `rehydrate_first` could continue into an executable edit instead of becoming
   a terminal answer.
5. The policy has a rollback plan and an operator-visible record in the Flight
   Recorder / admission reports.
6. If the release claim includes context-budget superiority, use a same-manifest
   report that includes `initial_context_chars` for both Aionis and Full
   History. Raw total prompt tokens are fallback-only when one arm completes far
   fewer actions.

## Product Boundary

The current product claim is:

> Aionis can run the selected closed-loop admission candidate in explicit active
> mode for the validated `/v1/guide` path, with shadow, active-gray,
> real-Agent admission rerun, and cross-repository tool-executing E2E evidence.
> The global active path passed route/completion and initial-context budget
> gates. The profile-scoped path proved bounded `profile_rule` source
> attribution and passed the 40-record multi-step route/action gate. Default
> activation remains an explicit operator decision for the selected profile,
> not a global Runtime default.

The current product claim is not:

> Aionis has replaced its default admission policy with a learned or tuned
> candidate policy across all memory backends.
