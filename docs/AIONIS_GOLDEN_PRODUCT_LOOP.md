# Aionis Golden Product Loop

Status: product-level Runtime e2e for the focused implementation

This document describes the primary product proof loop:

```text
observe -> guide -> agent action -> outcome feedback -> measure -> snapshot
```

The loop is not a benchmark runner and not a UI demo. It is a real Runtime HTTP
e2e that proves the core Aionis product behavior with one readable scenario.

## What It Proves

The golden loop must prove three product claims:

1. Aionis does not make the Agent start from zero when relevant execution
   history exists.
2. Aionis keeps failed branches visible as counter-evidence without leaking
   them into the active path.
3. Aionis gives the host/operator a read-only explanation of what memory was
   used, why it was safe, and whether trace evidence is ready for procedure
   reuse.

## Runnable Command

If a Runtime is already running:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="http://127.0.0.1:3001"
npm run -s runtime:e2e:golden-product-loop
```

If no Runtime URL is set, the script starts an isolated local Runtime and uses
the configured embedding provider:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
npm run -s runtime:e2e:golden-product-loop
```

OpenAI-compatible embeddings are also supported through `EMBEDDING_PROVIDER=openai`
with the matching OpenAI-compatible environment variables.

## Scenario

The e2e uses the existing multi-agent host template path:

1. Fresh reviewer guide asks Aionis for context before any writes.
2. Aionis returns `actionable_history_used: false`.
3. Planner observes a scoped plan.
4. Worker observes one failed branch.
5. Worker observes one passed branch.
6. Verifier writes a branch-aware execution tree handoff.
7. Reviewer asks for guidance.
8. Aionis returns the passed branch as usable context and the failed branch as
   `do_not_use` / counter-evidence.
9. The simulated reviewer continues the passed branch and avoids the failed one.
10. Host reports outcome feedback with `guide_trace_id` and the exposed
    `use_now` memory IDs.
11. `measure` reports positive history impact.
12. `operator_snapshot` reports branch isolation, feedback attribution, memory
    use receipt, effect, and trace-to-procedure readiness.

## Output Shape

The script prints:

```json
{
  "contract_version": "aionis_golden_product_loop_e2e_result_v1",
  "product_loop": "observe -> guide -> agent action -> outcome feedback -> measure -> snapshot",
  "product_story": {
    "did_not_start_from_zero": {},
    "failed_branch_isolated": {},
    "operator_explains_memory": {}
  },
  "golden_metrics": {},
  "checks": {}
}
```

See [examples/golden-product-loop-result.json](examples/golden-product-loop-result.json)
for a compact representative result shape.

## Required Boundaries

The golden loop must preserve these boundaries:

1. Only `agent_context` is Agent-facing.
2. `memory_decision_trace`, `memory_use_receipt`, and `operator_snapshot` are
   host/operator-facing.
3. Failed branches can appear in `do_not_use` and operator evidence, but must
   not become the active next-action path.
4. Trace-to-Procedure is a read-only readiness projection; it does not compile,
   promote, or run a playbook.
5. One e2e scenario can prove product wiring, not universal task success.

## Source

Implementation:

1. `scripts/e2e/golden-product-loop.ts`
2. `scripts/e2e/multi-agent-host-template-loop.ts`
3. `src/adapters/host-integration.ts`
4. `src/adapters/execution-memory.ts`
5. `src/memory/operator-snapshot.ts`

The underlying path is the same host integration product path documented in
[AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md).
