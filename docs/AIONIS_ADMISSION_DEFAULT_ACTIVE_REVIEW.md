# Aionis Admission Default-Active Review

Status: operator activation review record
Last updated: 2026-06-29

This document records the human review decision for the closed-loop admission
candidate policy:

`candidate_project_context_closed_loop_inspect`

The review is based on the production shadow gate, active gray evidence,
real-Agent admission reruns, the global-active cross-repository tool-executing
Agent E2E gate recorded in
`docs/research/2026-06-29-admission-active-crossrepo-tool-e2e-initial-context-rerun.md`,
and the profile-scoped multi-step tool-E2E gate recorded locally under
`/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/profile-rule-multistep-aionis40-arkglm52-2026-06-29T14-09-42/`.

## Decision

| Field | Decision |
|---|---|
| Candidate policy | `candidate_project_context_closed_loop_inspect` |
| Default Runtime global mode | keep `off` |
| Approved product path | selected profile-scoped default-active rollout |
| Selected profile id | `external-agent-e2e-worker-full-power` |
| Current operator mode | profile-scoped rules; explicit global active only for isolated tests |
| External backend path | remains `shadow_only` |
| Runtime mutation | not allowed |
| Stored memory mutation | not allowed |
| Hard-boundary upgrade | not allowed |

The candidate is approved for the selected profile-scoped default-active
product path. It is not approved as a global Runtime default.

Reason: the evidence supports the candidate on the validated `/v1/guide`
admission surface and on the selected profile-rule path. Runtime global mode
must stay `off`; profile-scoped rules provide the narrower configuration
surface for bounded product rollout.

## Evidence Reviewed

| Evidence | Result |
|---|---|
| Default-guide shadow production gate | Passed with large-row shadow coverage and no prompt inclusion or Runtime mutation. |
| Isolated active gray | Passed for the validated guide profile with bounded prompt-facing downgrades. |
| Real-Agent admission reruns | Preserved accepted action rate while reducing prior-aware direct-use risk in the validated profile. |
| Cross-repository tool-executing Agent E2E | Passed 40 / 40 records across 10 base trap families and 4 context hygiene levels. |
| Initial-context budget rerun | Aionis used 203,242 initial-context chars versus Full History 1,352,256 chars while both arms completed 40 / 40 records. |
| Profile-rule source gate | Passed 40 / 40 guide source checks for `profile_rule` and 40 / 40 guide profile checks for `external-agent-e2e-worker-full-power`. |
| Profile-rule multi-step tool E2E | Passed 40 / 40 accepted-route and 40 / 40 action-completion records with zero route write/action violations, zero terminal inspect exits, and zero report-conflict exits. |

The final profile-rule multi-step gate used the Aionis arm only, so it did not
produce a same-run Full History budget comparison. The earlier same-manifest
profile-rule two-arm run remains informational budget context: Aionis used
165,421 initial-context chars versus Full History 1,352,256 chars.

## Approved Behavior

The candidate may be used to downgrade prompt-facing direct-use candidates when
closed-loop evidence indicates the memory should be inspected before direct
use.

Approved behavior:

- downgrade selected `use_now` candidates to `inspect_before_use`;
- preserve existing `inspect_before_use`, `do_not_use`, and `rehydrate`
  boundaries;
- keep the projection visible through `admission_candidate_policy_projection`;
- record guide exposure and feedback attribution through the existing guide
  trace path;
- preserve route and action completion gates before any rollout expansion.

Not approved:

- upgrading hard-boundary memories into `use_now`;
- mutating stored memory rows from the candidate projection;
- changing lifecycle state, authority state, or feedback counters from the
  candidate projection;
- enabling the candidate globally for every guide path;
- enabling external backend candidates in active mode.

## Rollout Shape

Aionis supports a profile-scoped switch through
`AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON`. The global default
remains `off`; profile rules are only considered when global mode is `off`.
For a copyable template and guide request check, see
[AIONIS_ADMISSION_PROFILE_ACTIVATION_QUICKSTART.md](AIONIS_ADMISSION_PROFILE_ACTIVATION_QUICKSTART.md).

Recommended shape:

```text
global default:
  AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off

named profile:
  external-agent-e2e-worker-full-power -> candidate active projection

rollback:
  profile active -> shadow/off
```

Example profile rule shape:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
export AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON='[
  {
    "profile_id": "external-agent-e2e-worker-full-power",
    "mode": "active",
    "agent_roles": ["worker"],
    "context_modes": ["compact_agent"],
    "guide_modes": ["full_power"]
  }
]'
```

Use selectors that match the host's real `/v1/guide` request shape. A profile id
labels the rule and is emitted in `source_map`; it is not a selector by itself.

The global operator override remains available for isolated active gray runs:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active
```

Rollback remains immediate:

```bash
unset AIONIS_ADMISSION_CANDIDATE_POLICY_MODE
# or
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
export AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON='[]'
```

## Required Monitoring

Any profile-scoped rollout must record:

- guide count;
- candidate projection count;
- downgraded memory ids;
- hard-boundary upgrade count, expected `0`;
- Runtime mutation count, expected `0`;
- terminal inspect exits in tool E2E, expected `0`;
- report-conflict exits in tool E2E, expected `0`;
- accepted-route rate;
- action-completion rate;
- initial context ratio versus Full History when a paired baseline is present;
- feedback attribution coverage for exposed memory ids.

## Re-Review Triggers

Run this review again before widening the profile if any of these change:

- guide rendering;
- lifecycle inference;
- execution-memory rendering;
- admission candidate policy evaluator;
- feedback attribution schema;
- external backend candidate ingestion;
- context compiler budget behavior;
- product output contract for `use_now`, `inspect_before_use`, `do_not_use`, or
  `rehydrate`.

## Outcome

The candidate is approved for selected-profile activation through
`AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON`.

The Runtime global default remains `off`. The external backend path remains
`shadow_only`. Any additional profile must pass the same profile-source and
tool-E2E gate before it is treated as a default product guide path.
