# Aionis Long-Flow Product Demo

This demo is a longer, reproducible Runtime story for Aionis execution memory.
It is meant to show how Aionis keeps a coding Agent continuation usable across
sessions without dumping the entire trace back into the prompt.

## What It Exercises

The script runs a single long workflow through real Aionis product APIs:

1. fresh `guide` before any history exists
2. planner route observation
3. failed worker branch observation
4. accepted worker branch observation
5. reviewer follow-up requirement observation
6. verifier handoff observation
7. new-session `guide`
8. SDK `compileExecutionAgentContext`
9. feedback attribution
10. `measure`
11. operator snapshot
12. Agent Flight Recorder

The scenario is intentionally longer than the first-value demo. It contains an
active route, a failed route, a reference-only target, a pending follow-up file,
and a next-session worker that must continue from governed state.

## Run

```bash
npm run -s runtime:e2e:long-flow-demo
```

If `MINIMAX_API_KEY` or `OPENAI_API_KEY` is available, the spawned Runtime uses
the configured embedding provider. If no embedding key is present, the demo
starts an isolated no-embedding local Runtime and validates the structured
execution-memory path.

You can also point the demo at an existing Runtime:

```bash
AIONIS_LONG_FLOW_DEMO_BASE_URL=http://127.0.0.1:3001 \
npm run -s runtime:e2e:long-flow-demo
```

## Output

The run writes:

```text
docs/examples/long-flow-product-demo-result.json
```

The JSON report includes:

- raw transcript character count
- compiled Aionis prompt character count
- active targets
- missing active targets treated as pending work
- `use_now`, `inspect_before_use`, and `do_not_use` memory ids
- Memory Use Receipt and Memory Admission Record presence
- feedback attribution result
- `measure` history impact
- Flight Recorder replay metadata

## Success Criteria

The demo fails fast if any of these product contracts regress:

- fresh scope starts without actionable history
- later guide exposes actionable execution history
- active route target is preserved
- follow-up requirement is preserved
- missing follow-up target is treated as pending work
- failed route is not direct-used
- simulated next Agent continues the active route
- feedback is attributed only to recognized persisted guide items the simulated
  host trace reports as used
- `measure` reports changed future behavior
- Flight Recorder excludes prompt payload while remaining replayable

## Boundary

This is not an external benchmark and it does not claim task-success lift against
other memory systems. It is a Runtime product demo for Aionis-owned effects:
state-preserving context compression, memory admission, feedback attribution,
operator snapshotting, and Agent Flight Recorder auditability.
