# Sparse Feedback Confidence Decay Gate

This document defines Direction 2 for sparse feedback: a read-only confidence decay candidate gate.

Direction 2 starts only after Direction 1 evidence has been measured. It does not replace explicit lifecycle adjudication, controlled forgetting, or host-submitted feedback attribution.

## Product Boundary

The output belongs to `AionisMemoryDecisionTrace`, `AionisMemoryDecisionAuditReport`, and `AionisEffectReport`.

It is a measure/debug/audit surface. It is not an Agent prompt surface.

## Contract

`confidence_decay_candidate_summary` must obey these rules:

1. `mode` is `shadow_candidate`.
2. `authority_mutation` is always `false`.
3. `agent_prompt_included` remains `false`.
4. No memory can be demoted, suppressed, archived, deleted, or moved to `inspect_before_use` by this summary.
5. Positive attributed use or recent validation blocks decay candidacy.
6. Cross-scope and cross-consumer exposure does not accumulate.
7. Neighborhood drift can support decay candidacy but cannot trigger it alone.
8. A single weak negative signal cannot trigger decay candidacy.
9. Candidate evidence must remain explainable through memory ids and reason codes.

## Candidate Inputs

Direction 2 may consider these existing read-side signals:

- repeated weak negative counter-signal that already crossed the Direction 1 threshold
- strong negative counter-signal
- repeated exposed-but-unused memory with no positive attributed use
- neighborhood drift observation, only as supporting context
- positive attributed use, as a blocker

## Candidate Rule

A memory may enter `confidence_decay_candidate_memory_ids` only when:

1. it already appears in Direction 1 candidate learning-control evidence, and
2. it has no positive attributed use, and
3. it is not recently validated, and
4. it is either repeatedly unused without positive attribution or has threshold-met counter-signal evidence.

Neighborhood drift may add `supported_by_neighborhood_drift_memory_ids`, but drift alone must remain observation-only.

## Holdout Gate

The gate is considered stable only when a real Runtime holdout report shows:

1. all scenarios completed
2. all scenario checks passed
3. `authority_mutation_count` is `0`
4. `confidence_decay_candidate_count` equals expected shadow candidates
5. `confidence_decay_false_positive_count` is `0`
6. positive attribution blocks all decay candidates for recently validated memories
7. drift-only negative controls do not become decay candidates

## Non-Goals

- no time-based automatic demotion
- no automatic archive or suppression
- no active verification
- no Agent-facing instruction
- no external Agent patch-success claim

Direction 2 proves only this product claim:

Aionis can identify history that should be trusted less in the future as a shadow candidate, while preserving positive validated memory and avoiding authority mutation.
