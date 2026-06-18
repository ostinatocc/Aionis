# Aionis Admission Policy Promotion Status

Status: product evidence register
Last updated: 2026-06-18

This document records the current promotion state for the selected admission
candidate policy. It is intentionally conservative: evidence can make a policy
eligible for a narrower gate, but it does not silently promote the policy into
the default Runtime path.

## Candidate

| Field | Value |
|---|---|
| Candidate policy | `candidate_project_context_closed_loop_inspect` |
| Current status | `eligible_for_multi_profile_isolated_active_gray` |
| Default Runtime status | `not_default_active` |
| External backend status | `shadow_only` |
| Full tool-executing Agent E2E status | `not_yet_validated` |

The selected candidate is a closed-loop admission policy. Its current evidence
supports isolated active gray testing on the `closed-loop-prior-fresh-2` and
`closed-loop-prior-fresh` internal Runtime guide profiles. It does not
authorize:

- default active mode;
- external-backend active rollout;
- broad product claims across all memory lanes;
- claims about full coding-Agent task completion.

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

## Required Gates Before Default Active

Do not promote the candidate to default active mode until all of these gates are
closed:

1. A second `/v1/guide` online profile, or a mixed profile, passes the same
   shadow and active gray checks. As of 2026-06-18, the second guide-profile
   shadow, isolated active gray, and real-Agent admission rerun gates have
   passed.
2. A real tool-executing Agent E2E shows no completion regression and no
   hard-boundary regression.
3. External backend candidates have task-level completion evidence, not only
   admission-row shadow evidence.
4. Protocol compatibility is documented for the chosen real-Agent model.
   `deepseek-chat` returned strict JSON in the current rerun. The attempted
   `deepseek-v4-flash` run returned only `reasoning_content` and hit the
   completion limit, so it is not currently suitable for this strict JSON rerun
   without protocol handling work.
5. The policy has a rollback plan and an operator-visible record in the Flight
   Recorder / admission reports.

## Product Boundary

The current product claim is:

> Aionis can run the selected closed-loop admission candidate in isolated active
> gray mode for two internal `/v1/guide` profiles, with bounded downgrade-only
> behavior and real-Agent admission rerun evidence.

The current product claim is not:

> Aionis has replaced its default admission policy with a learned or tuned
> candidate policy across all memory backends.
