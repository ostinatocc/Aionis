# Sparse Feedback Learning-Control Gate

Status: product gate contract

This document closes Direction 1 sparse feedback attribution. It defines which sparse feedback signals may become candidate learning-control evidence, which signals remain observation-only, and which evidence blocks a candidate.

It does not add Runtime behavior by itself. The executable product schema lives in `src/memory/product-output-contract.ts`, and the assembler lives in `src/memory/product-output-assembler.ts`.

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
| repeated unused without positive attribution | memory is repeatedly exposed and has no positive attributed use | `candidate_inspect_before_use_memory_ids` | never from this summary |
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

Passing this gate proves that sparse feedback is correctly observed and converted into candidate-only learning-control evidence. It does not prove that Aionis should automatically mutate memory authority.

## Upgrade Boundary

After this gate passes, the only allowed next product step is a separate shadow gate that asks whether a candidate would move a future guide item to inspect-before-use.

That shadow gate must still keep authority unchanged until a distinct holdout proves:

1. candidate suggestions reduce blind trust in bad history
2. candidate suggestions do not suppress useful history
3. positive attributed use blocks false positive downgrades
4. scope, team, and agent identity isolation stay intact
5. context remains compact

Direction 2 time decay and Direction 3 active verification must not be mixed into this Direction 1 gate.
