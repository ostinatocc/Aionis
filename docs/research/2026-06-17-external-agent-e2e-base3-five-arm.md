# External Agent E2E Base3 Five-Arm Evidence Note

Date: 2026-06-17

Primary report:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/real-five-arm-base3-2026-06-17
```

Replication report:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/real-five-arm-next-base3-2026-06-17
```

## Setup

This run used the existing external-agent Phase 2 gradient manifest:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/fixtures/phase2-gradient-traps.jsonl
```

Run shape:

- repository: `vitejs/vite`
- base traps: 3
- hygiene levels: `tidy`, `separated`, `implicit`, `buried`
- records: 12 completed / 12 requested
- model: `deepseek-v4-flash`
- arms: `no_memory`, `full_history`, `bm25_retrieval`, `mem0`, `aionis`
- Aionis Runtime: real local Runtime, MiniMax embeddings

The run passed the five-arm report check:

```text
npm run -s external-agent-e2e:check-breakthrough-report -- \
  --report-dir /Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/real-five-arm-base3-2026-06-17 \
  --require-five-arm
```

## Aggregate Result

| Arm | Wrong write | Wrong attention | Accepted direction | Action completion | Prompt tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 66.7% | 91.7% | 8.3% | 66.7% | 30,997 |
| `full_history` | 0% | 0% | 100% | 91.7% | 229,068 |
| `bm25_retrieval` | 0% | 0% | 100% | 91.7% | 120,867 |
| `mem0` | 0% | 0% | 100% | 83.3% | 157,780 |
| `aionis` | 0% | 0% | 100% | 91.7% | 114,143 |

## Calibrated Interpretation

Aionis clearly beats `no_memory`: the no-memory arm repeatedly falls back to
visible but rejected paths, while Aionis preserves the accepted direction.

Aionis does not yet prove a wrong-write advantage over every memory baseline in
this run. `full_history`, `bm25_retrieval`, `mem0`, and Aionis all reached 0%
wrong-write and 100% accepted-direction. The stronger result is different:
Aionis preserved the same safety and accepted-direction behavior with much lower
prompt cost than full history, and lower prompt cost than Mem0.

The current product claim should therefore be:

> Aionis compiles noisy execution history into compact, governed agent context
> that preserves executable state without dumping the entire history into the
> prompt.

"Stops agents from repeating failed paths" remains a useful user-facing hook,
but the evidence-backed product positioning is context-cost-controlled execution
continuity under noisy history.

## Buried-Level Detail

Buried-level prompt tokens:

| Arm | Prompt tokens | Wrong write | Accepted direction | Action completion |
| --- | ---: | ---: | ---: | ---: |
| `full_history` | 117,090 | 0% | 100% | 66.7% |
| `bm25_retrieval` | 31,172 | 0% | 100% | 100% |
| `mem0` | 41,194 | 0% | 100% | 100% |
| `aionis` | 28,567 | 0% | 100% | 100% |

The 117,090 token figure is the sum across the three buried cases, not a single
request. The single full-history completion miss occurred on
`vitejs-vite-5edd1d5-bundled-dev-refactor__buried`, where full history used
40,676 prompt tokens and chose `rehydrate` instead of directly completing the
accepted file action.

This supports a conservative claim: buried full-history context expanded
substantially and produced one completion miss, while Aionis completed all three
buried cases with roughly one quarter of the full-history prompt tokens.

## Known Misses

The run still exposed one Aionis completion miss:

```text
vitejs-vite-868f1411a6f4-source-trap-2__separated
```

Aionis chose `inspect` on the accepted target rather than directly editing it.
This was not a wrong-branch failure. It is better categorized as an
actionability/completion miss. Do not turn this single case into a Runtime rule.
If the same pattern repeats across unrelated repositories, it may justify a
general executable-evidence sufficiency mechanism.

BM25 and Mem0 misses in this run are also mostly terminal inspect or rehydrate
behaviors, not proven stale-memory leakage. The cautious interpretation is that
plain retrieval can find the accepted direction but does not always compile it
into an executable next action.

## Next Validation Step

The first validation step was to keep the exact five-arm setup and run a second
repository from the same manifest. That run used `vercel/next.js`.

## Second Repository Replication: next.js

Report:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/real-five-arm-next-base3-2026-06-17
```

Run shape:

- repository: `vercel/next.js`
- base traps: 3
- hygiene levels: `tidy`, `separated`, `implicit`, `buried`
- records: 12 completed / 12 requested
- model: `deepseek-v4-flash`
- arms: `no_memory`, `full_history`, `bm25_retrieval`, `mem0`, `aionis`
- Aionis Runtime: real local Runtime, MiniMax embeddings

Aggregate result:

| Arm | Wrong write | Wrong attention | Accepted direction | Action completion | Prompt tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `no_memory` | 25.0% | 100% | 0% | 25.0% | 19,895 |
| `full_history` | 0% | 0% | 100% | 83.3% | 350,204 |
| `bm25_retrieval` | 0% | 0% | 100% | 91.7% | 242,003 |
| `mem0` | 0% | 0% | 100% | 83.3% | 282,344 |
| `aionis` | 8.3% | 8.3% | 91.7% | 100% | 230,231 |

This replication changes the conclusion. Aionis still beats `no_memory`
substantially and has the best completion rate in this run, but it does not
preserve the Vite run's 0% wrong-write behavior on next.js. The single Aionis
wrong-write happened in:

```text
vercel-next.js-a0dd23235851-source-trap-3__buried
```

In that sample, Aionis selected the rejected route:

```text
turbopack/crates/turbo-tasks-backend/src/database/noop_kv.rs
```

The accepted route was the persistence/key-value path:

```text
turbopack/crates/turbo-tasks-backend/src/database/key_value_database.rs
turbopack/crates/turbo-persistence/src/db.rs
turbopack/crates/turbo-tasks-backend/src/database/cell_data.rs
```

The generated Aionis context exposed the root cause:

```text
use_now: Recovered state: prior memory changed the guide packet |
Workflow trusted: Background repository activity 57 |
Workflow trusted: Background repository activity 56 |
Workflow trusted: Background repository activity 137
```

The guide had no active `target_files` and admitted unrelated buried background
notes as trusted `use_now` workflow history. The agent then followed that
background route. This is a real Aionis guide/admission failure, not a scorer
mapping issue.

## Updated Interpretation

The evidence-backed positioning should not be:

> Aionis always prevents agents from repeating failed branches.

That hook remains understandable, but the current cross-repo evidence does not
support it as the main technical claim. The stronger and more honest claim is:

> Aionis compiles long, noisy execution history into governed context that can
> preserve executable continuity with much lower prompt cost than full history,
> while exposing enough trace to diagnose when admission fails.

The Vite run supports compact governed continuity: Aionis matched full-history
safety/completion with roughly half the total prompt tokens, and roughly one
quarter of full-history prompt tokens on buried cases.

The next.js run supports the same cost/control direction less cleanly: Aionis
used fewer prompt tokens than full history, BM25, and Mem0, and reached 100%
action completion, but it also produced one buried wrong-write because buried
noise was promoted to trusted `use_now`.

## Immediate Engineering Follow-Up

Do not tune against this single trap by adding repository-specific rules. The
general failure class is:

> background or noise memories with no active execution target must not be
> rendered as trusted `use_now` workflow commands.

The next Runtime work should add a generic admission/renderer guard:

- if a candidate has no executable target files and is classified as background
  or optional context, keep it out of direct `use_now`;
- render it as optional context or evidence-only, not as `Workflow trusted`;
- require at least one active target, accepted route, validation result, or
  explicit handoff signal before workflow/procedure memory can drive action;
- preserve the trace so Flight Recorder can explain whether the candidate was
  suppressed for missing execution authority.

After that guard, rerun only the same next.js 12-cell five-arm report first. If
the wrong-write returns to 0 without hurting completion, then expand to another
repository. If it hurts completion, the product boundary is that Aionis needs a
better Candidate Retrieval Engine before stronger claims.

## Guard Follow-Up

The first Runtime guard implementation was intentionally narrow: execution
memories that are active/trusted but lack current-state, procedure, accepted
route, handoff, or lifecycle-candidate evidence no longer enter direct
`use_now`. They remain visible only as optional context.

Verification:

```text
npm run -s typecheck
npx tsx --test scripts/ci/lite-product-output-assembler.test.ts
npm run -s lite:test
```

The full lite suite passed with 631/631 tests. The background-event regression
now asserts that background execution memories do not appear in
`use_now_memory_ids` and do not render `Workflow trusted` inside the `use_now`
prompt line.

The exact next.js failure cell was then regenerated against the guarded Runtime:

```text
vercel-next.js-a0dd23235851-source-trap-3__buried
```

Before the guard, Aionis rendered unrelated buried noise as direct-use workflow
history:

```text
use_now: ... Workflow trusted: Background repository activity ...
```

After the guard, the Aionis context no longer contained that direct-use line.
The same memories appeared only as:

```text
command_posture: optional_context=...
```

An Aionis-only rerun of that key cell selected an accepted direction and scored:

```text
wrong_branch_write_hit: false
accepted_direction_hit: true
```

This validates the immediate guard against the observed failure mode. It is not
yet a full five-arm replacement report: the full rerun was stopped because the
Mem0 context builder hung on the same buried cell. The next clean validation is
to rerun next.js 12 cells either after adding a Mem0 context-builder timeout or
with a documented four-arm run that excludes the unstable Mem0 arm.

Remaining product boundary: the guarded Aionis prompt in the fixed cell no
longer leaked background noise, but it also did not expose a strong active
target. The Agent still reached an accepted target by inference. That means the
guard fixed unsafe direct-use rendering, while active-route recall remains a
Candidate Retrieval Engine problem.
