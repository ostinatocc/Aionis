# Aionis Correctness-Learning Baseline

This document freezes the product state immediately before implementation of
the Adaptive Execution Memory correctness-learning plan.

The machine-readable authority for this baseline is
[`2026-07-27-correctness-learning-baseline.json`](./2026-07-27-correctness-learning-baseline.json).

## Baseline decision

Aionis remains an Execution Memory Runtime.

The existing continuity, current-state, handoff, failure, acceptance,
rehydration, lifecycle, recall, and AgentContext capabilities remain in place.
The implementation adds a verifier-bound episode truth chain before it changes
selection or learning behavior.

The six pre-existing tracked working-tree changes are preserved under the
SHA-256 of `git diff --binary`
`3c33740a32a8a97bc28fb7eff6854d96d18633e80009f3456f651ee073c97c03`.
That digest excludes the untracked Plan and baseline files. They are not folded
into Phase 1 implementation.

## Preserved semantics

- Current workspace state is continuity fact, not proof that the current route
  is correct.
- Unknown execution outcome requires inspection; known negative execution
  evidence is blocked.
- History being present is not the same as actionable history being used.
- Only verified-success workflows are reusable as direct guidance.
- Current valid state is not removed by stale path conflicts.
- Required acceptance checks remain visible through context compaction.
- Inspect-before-use evidence is not silently resolved by the SDK.
- Artifacts already present in the repository are not rendered as pending.

## Mechanism boundary

The existing guide, lifecycle, continuity, AgentContext, and SDK paths are
preserved. Recall ranking, RRF, graph, ANN, and structured sources become
candidate generation rather than final utility authority.

Current measure/effect reports remain diagnostics. The online Product
tool-feedback kernel, learning ledger, unused-exposure control, and
association-worker candidate path remain connected compatibility mechanisms.
The general learning loop is not on the daemon/Product path. Fixed final-use
weights, trajectory recipes, and static tool preferences are not expanded;
they are replaced or removed only after the general
episode/compiler/selector path demonstrates parity and held-out effect.

## Real diagnostic baseline

The frozen Playwright task used the real `deepseek-v4-flash` model, real
repository tools, real Runtime context generation, DashScope
`qwen3.7-text-embedding`, and an independent executable verifier.

| Arm | Steps | Total tokens | Verified pass |
|---|---:|---:|---:|
| Aionis | 30 | 522,148 | no |
| No memory | 30 | 439,625 | no |
| Full history | 27 | 826,210 | no |

For the Aionis arm, `actionable_history_used=false`, `use_now` was empty, and
seven memories were inspection-only.

The correct baseline statement is therefore:

> Aionis supplied truthful continuity and completion boundaries on this task,
> but no arm passed and the learned-history path did not execute.

This is diagnostic evidence, not a positive product-effect result.

## Phase 0 verification

- Runtime typecheck: passed.
- Complexity report: passed.
- Runtime source: 339 files and 171,449 lines.
- Runtime-entry closure: 285 files and 140,459 lines.
- Product route matrix: 21 routes.
- Runtime import cycles: zero.
- Initial semantic review: 69 tests, 53 passed, 16 failed. That non-green
  snapshot remains recorded in the machine-readable baseline.
- Phase 0 semantic close: 70/70 passed after aligning stale fixtures and
  removing lexical self-verification. Unknown execution effect cannot become
  direct-use; only structured `passed_solution` evidence can authorize the
  recovered-handoff path.

No learning/selection behavior was enabled to create this baseline. Phase 0
made only the stated execution-evidence precedence correction.
