# Aionis Admission Policy Promotion Status

Status: product evidence register
Last updated: 2026-06-19

This document records the current promotion state for the selected admission
candidate policy. It is intentionally conservative: evidence can make a policy
eligible for a narrower gate, but it does not silently promote the policy into
the default Runtime path.

## Candidate

| Field | Value |
|---|---|
| Candidate policy | `candidate_project_context_closed_loop_inspect` |
| Current status | `eligible_for_isolated_active_gray_only_blocked_for_broad_rollout` |
| Default Runtime status | `not_default_active` |
| External backend status | `shadow_only` |
| Full tool-executing Agent E2E status | `crossrepo_paired27_wrong_write_resolved_route_adherence_open` |

The selected candidate is a closed-loop admission policy. Its current evidence
supports isolated active gray testing on the `closed-loop-prior-fresh-2` and
`closed-loop-prior-fresh` internal Runtime guide profiles. Two small
tool-executing external Agent pilots also passed on two Vite base trap families,
but the first paired cross-repository tool E2E regressed on Next.js/Turbopack
trap families. A follow-up code patch recovered the prompt-facing route
contract, and a file-choice normalizer fix resolved the apparent residual
wrong-write as a harness artifact. The attention metric has since been split:
12 of 13 latest attention hits are reference-only, while one buried
direction-attention / route-adherence failure remains. This does not
authorize:

- default active mode;
- external-backend active rollout;
- broad product claims across all memory lanes;
- broad claims about full coding-Agent task completion.

## Evidence Chain

| Stage | Evidence | Result |
|---|---|---|
| Offline dataset and holdout | `docs/research/2026-06-18-admission-dataset-batch-baseline.md` | Candidate beat recorded policy on holdout calibration and became eligible for manual review. |
| Counterfactual rerun | Admission rerun reports under `admission-dataset/reports/latest/` | Candidate preserved hard-boundary and positive-capture gates under deterministic replay. |
| Real LLM admission rerun | `docs/research/2026-06-18-admission-current-runid-real-agent.md` | Candidate preserved accepted action rate and hard-boundary gates on the accumulated dataset. |
| Online guide shadow | `docs/research/2026-06-18-admission-online-shadow-100gate.md` | Shadow projection reached 120 rows and 12 task signatures without prompt inclusion or Runtime mutation. |
| Second guide shadow | `docs/research/2026-06-18-admission-second-guide-shadow-100gate.md` | A neighboring `/v1/guide` profile reached 120 rows and 8 task signatures with the same bounded shadow behavior. |
| External targeted shadow | `docs/research/2026-06-18-admission-targeted-external-shadow-100gate.md` | External candidates stayed shadow-only; direct-use dropped, but this is not guide-path active evidence. |
| Isolated active gray | `docs/research/2026-06-18-admission-active-gray-closed-loop-100gate.md` | Active projection changed prompt-facing guide output in the bounded downgrade path only. |
| Active gray real-Agent rerun | `docs/research/2026-06-18-admission-active-gray-real-agent-rerun.md` | Real LLM rerun preserved accepted action rate and reduced negative direct risk for this profile. |
| Second guide active gray | `docs/research/2026-06-18-admission-second-guide-active-gray.md` | The neighboring `/v1/guide` profile passed isolated active gray with bounded downgrade-only behavior. |
| Second guide active gray real-Agent rerun | `docs/research/2026-06-18-admission-second-guide-active-gray-real-agent-rerun.md` | Real LLM rerun preserved accepted action rate and reduced negative direct risk for the second guide profile. |
| Tool-executing Agent E2E pilot | `docs/research/2026-06-18-admission-active-tool-executing-agent-e2e.md` | Active mode preserved 0% wrong writes, 0% wrong attention, 100% accepted direction, and 100% action completion on one base trap across four hygiene levels. |
| Second tool-executing Agent E2E pilot | `docs/research/2026-06-18-admission-active-tool-executing-agent-e2e-second-base.md` | Active mode preserved the same hard gates on a second base trap family, including a missing active target continuation case. |
| Cross-repository tool-executing Agent E2E paired27 | `docs/research/2026-06-18-admission-active-crossrepo-tool-e2e-paired27.md` | Active mode regressed on the paired cross-repository set: wrong writes increased from 2 / 27 to 7 / 27, accepted direction dropped from 25 / 27 to 17 / 27, and total tokens increased slightly. |
| Cross-repository tool-executing Agent E2E paired27 rerun | `docs/research/2026-06-18-admission-active-crossrepo-tool-e2e-paired27-rerun.md` | The execution-memory direct-use patch recovered most of the regression: wrong writes dropped from 7 / 27 to 1 / 27, accepted direction rose from 17 / 27 to 26 / 27, and action completion reached 27 / 27. |
| Cross-repository paired27 rerun after file-choice normalizer fix and attention split | `docs/research/2026-06-18-admission-active-crossrepo-tool-e2e-paired27-rerun.md` | Wrong writes dropped to 0 / 27 and the prior residual separated-context case was confirmed as a harness normalization artifact. Attention split shows 1 / 27 direction-attention hit, 12 / 27 reference-only attention hits, and 0 / 27 other attention hits. One buried route-adherence failure remains. |

Follow-up inspection found the paired27 regression root cause: the active
projection over-downgraded Aionis `execution_memory` accepted-continuation
entries because the candidate direct-use path only allowed `project_context`.
The code patch now preserves direct use for Aionis `execution_memory` unless
closed-loop counter-signal evidence exists. This is a correction to the active
projection, not a promotion. The paired27 rerun after the file-choice normalizer
fix shows the wrong-write regression is resolved. The attention split then
showed that latest attention hits are mostly reference-only; broad rollout stays
blocked by the remaining buried route-adherence / direction-attention failure.

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
non-candidate create/restore paths. Broad rollout is still blocked because the
latest run has one buried route-adherence failure. The attention-scope rescore
separates this from reference-only evidence use: latest direction attention is
`1 / 27`, while reference-only attention is `12 / 27`.

## Required Gates Before Default Active

Do not promote the candidate to default active mode until all of these gates are
closed:

1. A second `/v1/guide` online profile, or a mixed profile, passes the same
   shadow and active gray checks. As of 2026-06-18, the second guide-profile
   shadow, isolated active gray, and real-Agent admission rerun gates have
   passed.
2. A real tool-executing Agent E2E shows no completion regression and no
   hard-boundary regression across more than one base trap family. As of
   2026-06-18, two Vite-family base trap pilots passed, and the paired
   cross-repository rerun after the normalizer fix has `0 / 27` wrong writes.
   This gate remains blocked by one buried route-adherence / direction-attention
   failure.
3. External backend candidates have task-level completion evidence, not only
   admission-row shadow evidence.
4. Protocol compatibility is documented for the chosen real-Agent model. The
   current paired27 rerun used `deepseek-v4-flash` with strict JSON parsing plus
   `reasoning_content` fallback in the file-choice harness.
5. The policy has a rollback plan and an operator-visible record in the Flight
   Recorder / admission reports.

## Product Boundary

The current product claim is:

> Aionis can run the selected closed-loop admission candidate in isolated active
> gray mode for two internal `/v1/guide` profiles, with bounded downgrade-only
> behavior, real-Agent admission rerun evidence, and two small tool-executing
> Agent E2E pilots.

The current product claim is not:

> Aionis has replaced its default admission policy with a learned or tuned
> candidate policy across all memory backends.
