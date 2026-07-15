# Sparse Feedback Learning-Control Gate

Status: product gate contract

This document closes Direction 1 sparse feedback attribution. It defines which sparse feedback signals may become learning-control evidence, which signals remain observation-only, and which evidence blocks a candidate.

The measure/debug/audit summaries remain read-only. Formal guide-attributed feedback may atomically enqueue one bounded behavior from this gate: after worker-side recomputation, repeated exposure without positive host attribution can set a memory-level `inspect_before_use` posture. The feedback transaction itself does not set that posture. The posture lowers direct reuse only; it does not suppress, archive, delete, or convert the memory into a task rule.

## Purpose

Sparse feedback exists to answer one product question:

When Aionis showed memory to a host, did later host outcome evidence make that memory safer to reuse, less safe to reuse, or only observable?

The output belongs to `AionisMemoryDecisionTrace` and `AionisMemoryDecisionAuditReport`. It is a measure/debug/audit surface, not an Agent prompt surface.

## Signal Classes

| Signal | Source | Candidate learning-control output | Runtime authority mutation |
|---|---|---|---|
| positive attributed use | host marks exposed memory as used and outcome is positive | no candidate; records positive support | never from this summary |
| single weak negative counter-signal | host marks exposed memory as used and outcome is negative without verifier/tool/runtime alignment | observation only | never |
| strong negative counter-signal | host marks exposed memory as used and verifier/tool/runtime failure aligns | `candidate_inspect_before_use_memory_ids` | never from this summary |
| repeated weak negative counter-signal | repeated weak negative attributed use crosses threshold | `candidate_inspect_before_use_memory_ids` | never from this summary |
| repeated exposed but unused | memory is repeatedly exposed but not host-marked used | observation only unless there is no positive attributed use | never |
| repeated unused without positive attribution | memory is repeatedly exposed and has no positive attributed use | `candidate_inspect_before_use_memory_ids`; formal `/v1/feedback` or advanced `/v1/forget activate` atomically enqueues durable learning-control work | no feedback-time posture mutation; the worker may change the memory surface to inspect-before-use after recomputation |
| repeated unused with positive attribution | memory is repeatedly exposed but has prior positive attributed use | `blocked_by_positive_attribution_memory_ids` | never |
| neighborhood drift | related newer memories indicate directional drift | observation only | never |

## Candidate-Only Contract

`candidate_learning_control_summary` must obey these rules:

1. `mode` is `candidate_only`.
2. `authority_mutation` is always `false`.
3. `candidate_from_threshold_met_memory_ids` may include only strong or repeated-weak threshold-met memory ids.
4. `candidate_from_repeated_unused_without_positive_memory_ids` may include only repeated-unused memories with zero positive attributed use.
5. `blocked_by_positive_attribution_memory_ids` records repeated-unused memories that are protected by prior positive attributed use.
6. Relation and contradiction decisions do not enter this summary; they already have their own lifecycle relation evidence path.
7. The summary must never suppress, archive, demote, promote, or directly alter the Agent-facing guide.

## Durable Inspect-Before-Use Contract

When formal `/v1/feedback`, or advanced `/v1/forget` with
`operation: "activate"`, has an exact episode-ledger source containing unused
exposure, the feedback facts and deterministic learning-control job are written
in one SQLite transaction. The response exposes only:

```text
feedback_learning_control.learning_control_status=queued|already_completed
```

This status acknowledges durable work; it does not claim a synchronous posture
change. A legacy feedback path without the formal episode-ledger source remains
compatible but does not enqueue and does not expose this status.

The worker leases the job and recomputes source facts at the feedback event
cutoff for the same consumer agent/team cohort. It may persist the posture only
when all of these conditions hold:

1. the feedback is tied to a valid `guide_trace_id`
2. the memory was exposed in the same tenant and scope
3. the same consumer agent/team exposure history crosses the exposure threshold
4. the source activation did not mark that memory as used
5. the memory has no positive attributed use at that evidence cutoff
6. the memory row is still visible to that consumer

The persisted slot is:

```text
feedback_learning_control_posture=inspect_before_use
feedback_learning_control_source=repeated_unused_without_positive_attribution
```

The worker writes the posture change, canonical audit commit, protected worker
receipt, and completed job transition atomically. Legal blockers produce an
audited no-op completion. Exhausted jobs are retained: successful safety
terminalization moves them to retained `dead_letter`, while a failed pause or
authority receipt leaves them leased/deferred and makes Runtime readiness fail
closed. An enrolled dead letter receives its independent learning-gate safety
pause in the same transaction. This is reversible: a later positive attributed use clears
the feedback-learning control posture. The posture is weaker than contested
lifecycle evidence: it maps the memory to `candidate`/`inspect_before_use`, not
to suppression, archive, or deletion.

## Holdout Gate

An external holdout may mark Direction 1 candidate learning-control as passed only when all of the following are true:

1. all scenarios complete without runner blockers
2. all per-case checks pass
3. `authority_mutation_count` is `0`
4. `neighborhood_drift_false_positive_count` is `0`
5. `candidate_from_threshold_met_count` equals `threshold_met_count`
6. `candidate_from_repeated_unused_without_positive_count` equals `repeated_unused_without_positive_count`
7. `candidate_learning_control_count` equals `candidate_from_threshold_met_count + candidate_from_repeated_unused_without_positive_count`
8. positive-attribution boundary cases produce `candidate_blocked_by_positive_attribution_count`
9. single weak negative, cross-consumer boundary, no-guide-trace activation, positive attributed use, and neighborhood drift negative-control cases produce no candidate inspect output

Passing this gate proves that sparse feedback is correctly observed, converted into durable learning-control work, and can be persisted by the worker as inspect-before-use posture without mutating authority or suppressing memory.

## Upgrade Boundary

After this gate passes, the next product step is to prove the persisted inspect-before-use posture on fresh holdout scenarios:

1. candidate suggestions reduce blind trust in bad history
2. candidate suggestions do not suppress useful history
3. positive attributed use blocks false positive downgrades
4. scope, team, and agent identity isolation stay intact
5. context remains compact

Direction 2 time decay and Direction 3 active verification must not be mixed into this Direction 1 gate.
