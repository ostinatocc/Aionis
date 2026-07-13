# v0.3.4 Product-Effect Regression Checkpoint

Environment: Apple M3, Node v24.12.0, MiniMax embedding provider using an
existing local credential. No credential value was recorded.

| Check | Result | Product evidence |
|---|---|---|
| Single-agent host template | Pass after applying the same temporary harness correction to both revisions | Fresh scope has no history; later ordinary memory becomes actionable; feedback, measure, and snapshot report positive attribution |
| Multi-agent adapter loop | Pass | Reviewer continues the passed branch, avoids the failed branch, feedback is attributed, measured impact is positive |
| Multi-agent host template | Pass | Planner/worker/verifier/reviewer state survives the host hooks; failed branch remains counter-evidence |
| Fresh multi-agent negative control | Pass | No execution markers before writes; passed branch appears after writes; failed branch remains `do_not_use` |
| Multi-agent negative transfer | Pass | Global/team/private visibility boundaries hold; cross-team feedback is rejected; failed branch is never `use_now` |
| Golden product loop | Pass | Observe -> guide -> action -> feedback -> measure -> snapshot is complete; branch isolation passes |
| Ordinary memory product loop | Pass | Active/current memory is direct-use, stale/candidate memory is inspect-first, suppressed memory is blocked, private ownership is isolated |
| Judgment calibration | Pass | Used memory is supported, unreported memory is unused rather than negative, audit remains read-only |

## Harness debt discovered

The checked-in single-agent E2E expected a fresh scope to report
`history_used=true`, while both the released and pre-refactor real Runtime
returned the more literal negative-control state:

```text
history_used=false
actionable_history_used=false
recommended_posture=ignore_history
authority=none
```

Both revisions failed the original assertion identically. A temporary,
identical benchmark-only correction required `history_used=false`; both
revisions then completed the entire loop with equivalent product outcomes.
The temporary source edits were removed after the comparison, so only benchmark
artifacts remain changed. This is classified as pre-existing harness semantic
debt, not a `v0.3.4` regression.

## Product-effect decision

**Pass with recorded harness debt.** All substantive effect and safety gates
completed on `v0.3.4`: continuity recovery, actionable memory after writes,
failed-branch isolation, tenant/team/private visibility, feedback attribution,
positive measured impact, and read-only operator evidence.
