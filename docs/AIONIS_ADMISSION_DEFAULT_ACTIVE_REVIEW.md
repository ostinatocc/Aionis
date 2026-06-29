# Aionis Admission Default-Active Review

Status: human review record
Last updated: 2026-06-29

This document records the human review decision for the closed-loop admission
candidate policy:

`candidate_project_context_closed_loop_inspect`

The review is based on the production shadow gate, active gray evidence,
real-Agent admission reruns, and the cross-repository tool-executing Agent E2E
gate recorded in
`docs/research/2026-06-29-admission-active-crossrepo-tool-e2e-initial-context-rerun.md`.

## Decision

| Field | Decision |
|---|---|
| Candidate policy | `candidate_project_context_closed_loop_inspect` |
| Default Runtime global mode | keep `off` |
| Approved product path | profile-scoped default-active design |
| Current operator mode | explicit `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active` |
| External backend path | remains `shadow_only` |
| Runtime mutation | not allowed |
| Stored memory mutation | not allowed |
| Hard-boundary upgrade | not allowed |

The candidate is approved for a profile-scoped default-active product path. It
is not approved as a global Runtime default.

Reason: the evidence supports the candidate on the validated `/v1/guide`
admission surface, but the current code switch is global. A profile-scoped
default requires a narrower configuration surface before it should become a
default behavior.

## Evidence Reviewed

| Evidence | Result |
|---|---|
| Default-guide shadow production gate | Passed with large-row shadow coverage and no prompt inclusion or Runtime mutation. |
| Isolated active gray | Passed for the validated guide profile with bounded prompt-facing downgrades. |
| Real-Agent admission reruns | Preserved accepted action rate while reducing prior-aware direct-use risk in the validated profile. |
| Cross-repository tool-executing Agent E2E | Passed 40 / 40 records across 10 base trap families and 4 context hygiene levels. |
| Initial-context budget rerun | Aionis used 203,242 initial-context chars versus Full History 1,352,256 chars while both arms completed 40 / 40 records. |

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

The next implementation step should be a profile-scoped switch, not a global
default flip.

Recommended shape:

```text
global default:
  AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off

named profile:
  validated guide profile -> candidate active projection

rollback:
  profile active -> shadow/off
```

Until that profile-scoped switch exists, the supported operator path remains
explicit active mode:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active
```

Rollback remains immediate:

```bash
unset AIONIS_ADMISSION_CANDIDATE_POLICY_MODE
# or
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
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

The candidate is ready for a profile-scoped default-active implementation plan.
The Runtime global default remains `off` until that narrower switch exists and
passes the same tool-E2E gate.
